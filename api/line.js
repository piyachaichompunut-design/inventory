// LINE Webhook — รับข้อความจากกลุ่มไลน์ แล้วสร้างงานใน TMS + คำสั่ง Odoo
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { handleTelegramCommand, __setDb, notifyMainChat } from './rpc.js';
import { odooConfigured, odooDelivery, parseCompany, odooCompare } from './odoo.js';
import { buildDeliveryPDF, buildComparePDF } from './pdfgen.js';

const LINE_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const LINE_TOKEN  = process.env.LINE_CHANNEL_TOKEN  || '';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const db = (SUPABASE_URL && SERVICE_KEY)
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  : null;

// ให้ rpc.js ใช้ db ตัวเดียวกัน (สำหรับคำสั่งที่ต้องเข้าฐานข้อมูล)
if (db) { try { __setDb(db); } catch (e) {} }

// ── ส่งข้อความกลับไลน์ ───────────────────────────────────────────────────────
async function replyLine(replyToken, text) {
  const r = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
  if (!r.ok) {
    const errText = await r.text();
    console.error('LINE reply failed:', r.status, errText, '| token length:', LINE_TOKEN.length);
  }
}

// ── push ข้อความเข้าไลน์ (ใช้ตอนสร้าง PDF เสร็จทีหลัง) ────────────────────────
async function pushLine(to, messages) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to, messages })
  });
}

// ── สร้าง PDF ใบส่งของ → อัปขึ้น Supabase Storage → ส่งลิงก์เข้าไลน์ ──────────
// statusFilter: 'pending' (ค่าเริ่มต้น) | 'done' | 'all'
async function sendDeliveryPDFtoLine(to, keyword, statusFilter = 'pending') {
  if (!odooConfigured()) { await pushLine(to, [{ type:'text', text:'❌ ยังไม่ได้ตั้งค่า Odoo ครับ' }]); return; }
  if (!db) { await pushLine(to, [{ type:'text', text:'❌ ยังไม่ได้เชื่อมต่อ Storage ครับ' }]); return; }
  try {
    const { keyword: dkw, company: dCo } = parseCompany(keyword);
    const allPicks = await odooDelivery(dkw, dCo.id);
    if (!allPicks.length) {
      await pushLine(to, [{ type:'text', text:'🔍 ไม่พบใบส่งของ "' + dkw + '" (บริษัท ' + dCo.name + ') ใน Odoo' }]);
      return;
    }

    // กรองตาม statusFilter
    const picks = allPicks.filter(p => {
      if (statusFilter === 'done')    return p.state === 'done';
      if (statusFilter === 'all')     return true;
      return p.state !== 'done' && p.state !== 'cancel'; // pending = ค่าเริ่มต้น
    });

    if (!picks.length) {
      const label = statusFilter === 'done' ? 'ส่งแล้ว' : statusFilter === 'all' ? 'ทั้งหมด' : 'รอส่ง';
      await pushLine(to, [{ type:'text', text:'🔍 ไม่พบใบส่งของสถานะ "' + label + '" ของ "' + dkw + '" ครับ\n(มีทั้งหมด ' + allPicks.length + ' ใบ ลอง /ส่งของ ' + dkw + ' ทั้งหมด)' }]);
      return;
    }

    // นับสถานะ
    let cntDone = 0, cntPending = 0, cntCancel = 0;
    const picksData = picks.map(p => {
      let statusText, statusColor;
      if (p.state === 'done')        { statusText='ส่งแล้ว'; statusColor='red';   cntDone++; }
      else if (p.state === 'cancel') { statusText='ยกเลิก';  statusColor='gray';  cntCancel++; }
      else                           { statusText='รอส่ง';   statusColor='green'; cntPending++; }
      return {
        name: p.name || '-',
        origin: p.origin || '',
        partner: Array.isArray(p.partner_id) ? p.partner_id[1] : '',
        statusText, statusColor, shipped: p.state === 'done',
        date: String(p.date_done || p.scheduled_date || '').slice(0, 10),
        lines: (p.lines || []).map(l => ({
          name: Array.isArray(l.product_id) ? l.product_id[1] : '',
          qty: l.quantity || l.product_uom_qty || 0,
          uom: Array.isArray(l.product_uom) ? l.product_uom[1] : ''
        }))
      };
    });

    const statusLabel = statusFilter === 'done' ? 'ส่งแล้ว' : statusFilter === 'all' ? 'ทั้งหมด' : 'รอส่ง';
    const data = {
      title: 'ใบส่งของ — ' + dkw + ' (' + dCo.name + ') [' + statusLabel + ']',
      summary: { total: picks.length, done: cntDone, pending: cntPending, cancel: cntCancel },
      picks: picksData
    };
    const pdfBytes = await buildDeliveryPDF(data);

    const fname = 'delivery/' + Date.now() + '.pdf';
    const { error: upErr } = await db.storage.from('attachments')
      .upload(fname, Buffer.from(pdfBytes), { contentType: 'application/pdf', upsert: true });
    if (upErr) { await pushLine(to, [{ type:'text', text:'❌ อัปไฟล์ไม่สำเร็จ: ' + upErr.message }]); return; }

    const { data: pub } = db.storage.from('attachments').getPublicUrl(fname);
    const sumLine = 'รวม ' + picks.length + ' ใบ'
      + (cntDone    ? ' | ส่งแล้ว ' + cntDone    : '')
      + (cntPending ? ' | รอส่ง '   + cntPending : '')
      + (cntCancel  ? ' | ยกเลิก '  + cntCancel  : '');
    await pushLine(to, [{
      type: 'text',
      text: '📄 ใบส่งของ "' + dkw + '" — ' + dCo.name + ' [' + statusLabel + ']\n' + sumLine + '\n\n📎 เปิดไฟล์ PDF:\n' + pub.publicUrl
    }]);
  } catch (e) {
    await pushLine(to, [{ type:'text', text:'❌ สร้าง PDF ไม่สำเร็จ: ' + e.message }]);
  }
}

// ── helper ───────────────────────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().slice(0, 10);
const rid = () => 'T' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 5).toUpperCase();

// แปลงวันที่ จาก 5/6/2026 หรือ 5/6/69 → 2026-06-05
function parseDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) return null;
  let [, d, mo, y] = m;
  y = +y; if (y < 100) y += 2000; if (y >= 2500) y -= 543;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  return y + '-' + String(+mo).padStart(2,'0') + '-' + String(+d).padStart(2,'0');
}

// ── parse ข้อความ → งานใหม่ ──────────────────────────────────────────────────
// รองรับหลายรูปแบบ:
// 1) /งานใหม่ รับ ชื่องาน วันที่ 5/6/2026 @สมชาย
// 2) รับ: ชื่องาน วันที่ 5/6/2026
// 3) ส่ง: ชื่องาน 5/6/2026 สมชาย
function parseTask(text) {
  const t = text.trim();

  // ตรวจรูปแบบ /งานใหม่
  if (!t.startsWith('/งานใหม่') && !t.startsWith('/new') &&
      !t.match(/^(รับ|ส่ง)[:\s]/)) return null;

  let task = '', duration = 'รับ', actionDate = todayStr(), salesName = '';

  // ดึงประเภท รับ/ส่ง — เช็คเฉพาะคำขึ้นต้น (กันชื่องานที่มีคำว่า ส่ง/รับ ปนอยู่)
  if (/^\/?(งานใหม่|new)?\s*ส่ง[:\s]/.test(t) || /^ส่ง[:\s]/.test(t)) duration = 'ส่ง';
  else duration = 'รับ';

  // ดึงวันที่ (รองรับ วันที่ XX/XX/XXXX หรือตัวเลขโดด)
  const dateMatch = t.match(/(?:วันที่\s*)?(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
  if (dateMatch) {
    const parsed = parseDate(dateMatch[1]);
    if (parsed) actionDate = parsed;
  }

  // ดึงชื่อผู้รับผิดชอบ (@ชื่อ)
  const atMatch = t.match(/@([^\s@]+)/);
  if (atMatch) salesName = atMatch[1];

  // ดึงชื่องาน (ลบ keyword ออก)
  let taskText = t
    .replace(/^\/งานใหม่/, '').replace(/^\/new/i, '')
    .replace(/(?:วันที่\s*)?\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/, '')
    .replace(/@\S+/g, '')
    .replace(/รับ[:\s]?|ส่ง[:\s]?/g, '')
    .replace(/\s+/g, ' ').trim();

  if (!taskText) return null;
  task = taskText;

  return { task, duration, actionDate, salesName };
}

// ── ตารางตัวย่อหมวด → ชื่อเต็ม (ตรงกับ categories ใน web) ──────────────────
const CAT_ALIAS = {
  'เสา': 'งานเสาไฟฟ้า',
  'เสาอุปกรณ์': 'งานเสาไฟฟ้าและอุปกรณ์',
  'ชุบ': 'บริการชุบกัลวาไนซ์',
  'ป้าย': 'งานป้าย',
  'ป้ายเฟรม': 'งานป้าย+เฟรม',
  'เฟรม': 'งานเฟรม',
  'มาส': 'งาน mast arm',
  'ไฟฟ้า': 'งานอุปกรณ์ไฟฟ้า',
  'ราก': 'งานรากฐาน',
  'พัสดุ': 'งานส่งพัสดุ',
  'การ์ดเรล': 'งานการ์ดเรล',
  'ซ่อม': 'ซ่อมบำรุง',
  'ไฟ': 'แผนกไฟฟ้า',
  'ซิลิกัล': 'ซิลิกัล',
  'so': 'ใบสั่งซื้อ( so )',
  'ผลิต': 'วัตถุดิบเพื่อการผลิต',
  'สิ้นเปลือง': 'วัตถุดิบสิ้นเปลือง',
  'อื่นๆ': 'อื่นๆ'
};

// ── จับวันที่ทุกรูปแบบ: วันนี้/พรุ่งนี้, 16/6/69, 16/6/2026, 16มิ.ย., 16มิถุนายน2569 ──
function smartParseDate(text) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const fmt = (y, m, d) => y + '-' + pad(m) + '-' + pad(d);
  const toCE = y => { y = +y; if (y < 100) y += 2500; if (y >= 2500) y -= 543; return y; };
  const thMonth = { 'มกราคม':1,'ม.ค':1,'กุมภาพันธ์':2,'ก.พ':2,'มีนาคม':3,'มี.ค':3,'เมษายน':4,'เม.ย':4,'พฤษภาคม':5,'พ.ค':5,'มิถุนายน':6,'มิ.ย':6,'กรกฎาคม':7,'ก.ค':7,'สิงหาคม':8,'ส.ค':8,'กันยายน':9,'ก.ย':9,'ตุลาคม':10,'ต.ค':10,'พฤศจิกายน':11,'พ.ย':11,'ธันวาคม':12,'ธ.ค':12 };
  const monthAlt = Object.keys(thMonth).sort((a,b)=>b.length-a.length).join('|');

  if (/วันนี้/.test(text)) { const d=now; return fmt(d.getFullYear(), d.getMonth()+1, d.getDate()); }
  if (/พรุ่งนี้/.test(text)) { const d=new Date(now.getTime()+86400000); return fmt(d.getFullYear(), d.getMonth()+1, d.getDate()); }
  if (/มะรืน/.test(text)) { const d=new Date(now.getTime()+2*86400000); return fmt(d.getFullYear(), d.getMonth()+1, d.getDate()); }

  let m = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) { const d=+m[1], mo=+m[2], y=toCE(m[3]); if(mo>=1&&mo<=12&&d>=1&&d<=31) return fmt(y, mo, d); }

  m = text.match(new RegExp('(\\d{1,2})\\s*(' + monthAlt + ')\\.?\\s*(\\d{2,4})'));
  if (m) { const d=+m[1], mo=thMonth[m[2]], y=toCE(m[3]); if(mo) return fmt(y, mo, d); }

  m = text.match(new RegExp('(\\d{1,2})\\s*(' + monthAlt + ')\\.?'));
  if (m) {
    const d=+m[1], mo=thMonth[m[2]];
    if (mo) {
      let y = now.getFullYear();
      const cand = new Date(y, mo-1, d);
      if (cand < new Date(now.getFullYear(), now.getMonth(), now.getDate())) y++;
      return fmt(y, mo, d);
    }
  }
  return null;
}

// ── เดางานจากข้อความธรรมชาติ (ใช้เมื่อแท็กบอท) ───────────────────────────────
// รูปแบบ: @TMS Bot [ข้อความงาน] [ตัวย่อหมวด] [ชื่อผู้รับผิดชอบ]
// เช่น: @TMS Bot ส่งของปราจีนบุรี วันที่10มิถุนายน ชุบ พี่เต้ย
async function parseTaskSmart(text, dbClient, typedText) {
  let t = text.replace(/@[^\s@]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // เดาประเภท ส่ง/รับ จากคำในข้อความ
  let duration = 'รับ';
  const sendWords = /(ส่งของ|นัดส่ง|ส่งที่|จัดส่ง|ขอส่ง|จะส่ง|ส่งงาน|ออกของ|นำส่ง|แจ้งส่ง)/;
  const recvWords = /(รับของ|รับเข้า|มารับ|ขอรับ|จะรับ|รับงาน|เข้ารับ|รับสินค้า|แจ้งรับ)/;
  if (sendWords.test(t)) duration = 'ส่ง';
  else if (recvWords.test(t)) duration = 'รับ';

  // ระบุเองได้: ถ้าที่พิมพ์ขึ้นต้นด้วย "ส่ง" หรือ "รับ" → ใช้อันนั้นเลย (override)
  // เช่น reply แล้วพิมพ์ "ส่ง เสา พี่เต้ย" → บังคับเป็นงานส่ง
  let typedBody = typedText || '';
  const mExplicit = typedBody.match(/^\s*(ส่ง|รับ)\s+/);
  if (mExplicit) {
    duration = mExplicit[1];
    typedBody = typedBody.replace(/^\s*(ส่ง|รับ)\s+/, '').trim(); // ตัดคำ ส่ง/รับ ออก
  }

  // ดึงวันที่ (ทุกรูปแบบ)
  let actionDate = todayStr();
  const parsedDate = smartParseDate(t);
  if (parsedDate) actionDate = parsedDate;

  // ตัดวันที่ออกจากข้อความ (ข้อความงานต้นฉบับ) — ครอบคลุมทุกรูปแบบ
  const thMonthAlt = 'มกราคม|ม.ค|กุมภาพันธ์|ก.พ|มีนาคม|มี.ค|เมษายน|เม.ย|พฤษภาคม|พ.ค|มิถุนายน|มิ.ย|กรกฎาคม|ก.ค|สิงหาคม|ส.ค|กันยายน|ก.ย|ตุลาคม|ต.ค|พฤศจิกายน|พ.ย|ธันวาคม|ธ.ค';
  let body = t.replace(/วันนี้|พรุ่งนี้|มะรืน/g, '')
              .replace(new RegExp('(?:วันที่\\s*)?\\d{1,2}\\s*(?:' + thMonthAlt + ')\\.?\\s*\\d{0,4}', 'g'), '')
              .replace(/(?:วันที่\s*)?\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/g, '')
              .replace(/\s+/g, ' ').trim();

  // ── จับหมวดหมู่ + ผู้รับผิดชอบ ───────────────────────────────────────────
  // หมวด+ชื่อ มาจาก "ที่พิมพ์" (typedBody เช่น "เสา พี่เต้ย") ไม่ใช่จากข้อความงาน
  let categories = '', salesName = '';
  let catList = [];
  if (dbClient) {
    try {
      const { data } = await dbClient.from('categories').select('name');
      catList = (data || []).map(c => String(c.name || ''));
    } catch (e) {}
  }

  // แยกคำจากที่พิมพ์ (typedBody) — รูปแบบ: [ตัวย่อหมวด] [ชื่อ]
  const typedWords = (typedBody || '').split(/\s+/).filter(Boolean);
  if (typedWords.length >= 2) {
    // 2 คำขึ้นไป: คำแรก=ตัวย่อหมวด, ที่เหลือ=ชื่อ
    const catWord = typedWords[0];
    const fullCat = CAT_ALIAS[catWord];                          // ลองตัวย่อก่อน
    if (fullCat) {
      categories = fullCat;
    } else {
      // ไม่ตรงตัวย่อ → ลองเทียบกับชื่อเต็มใน DB
      const matched = catList.find(c => c === catWord || c.includes(catWord) || catWord.includes(c));
      categories = matched || catWord;
    }
    salesName = typedWords.slice(1).join(' ');
  } else if (typedWords.length === 1) {
    // คำเดียว: ลองตัวย่อก่อน ถ้าตรง = หมวด, ไม่ตรง = ชื่อคน
    const w = typedWords[0];
    const fullCat = CAT_ALIAS[w];
    if (fullCat) {
      categories = fullCat;
    } else {
      const matched = catList.find(c => c === w || c.includes(w) || w.includes(c));
      if (matched) categories = matched;
      else salesName = w;
    }
  }

  // ชื่องาน = ข้อความงานต้นฉบับเท่านั้น (ตัดส่วนที่พิมพ์ตอน reply ออก)
  // ลองตัด typedText ดิบก่อน (เช่น "ส่ง เสา พี่นิค") แล้วค่อย typedBody ("เสา พี่นิค")
  let taskBody = body;
  const rawTyped = (typedText || '').trim();
  if (rawTyped && taskBody.endsWith(rawTyped)) {
    taskBody = taskBody.slice(0, taskBody.length - rawTyped.length).trim();
  } else if (typedBody && taskBody.endsWith(typedBody)) {
    taskBody = taskBody.slice(0, taskBody.length - typedBody.length).trim();
  }
  // ถ้าตัดจนว่าง (ไม่ได้ reply, พิมพ์อย่างเดียว) ใช้ typedBody เป็นชื่องาน
  const words = (taskBody || typedBody || '').split(' ');
  let task = words.join(' ').trim();
  if (task.length > 200) task = task.slice(0, 200);
  if (!task) return null;

  return { task, duration, actionDate, salesName, categories };
}

// ── โหลดไฟล์/รูปจาก LINE (Get Content API) ───────────────────────────────────
async function getLineContent(messageId) {
  const r = await fetch('https://api-data.line.me/v2/bot/message/' + messageId + '/content', {
    headers: { 'Authorization': 'Bearer ' + LINE_TOKEN }
  });
  if (!r.ok) throw new Error('โหลดไฟล์จาก LINE ไม่ได้: ' + r.status);
  const arrayBuf = await r.arrayBuffer();
  const contentType = r.headers.get('content-type') || 'application/octet-stream';
  return { buffer: Buffer.from(arrayBuf), contentType };
}

// ── แนบไฟล์เข้างานล่าสุด (ภายใน 5 นาที) ──────────────────────────────────────
async function attachFileToLastTask(dbClient, groupId, messageId, msgType, fileName) {
  // หางานล่าสุดของกลุ่มนี้ (ภายใน 5 นาที)
  const { data: last } = await dbClient.from('line_last_task')
    .select('task_id, task_name, created_at').eq('group_id', groupId).maybeSingle();
  if (!last || !last.task_id) return { error: 'ไม่พบงานล่าสุดในกลุ่มนี้ (ต้องสร้างงานก่อนแนบไฟล์)' };

  // โหลดไฟล์จาก LINE
  const { buffer, contentType } = await getLineContent(messageId);

  // ตั้งชื่อไฟล์ + นามสกุล
  const ext = msgType === 'image' ? '.jpg' : (fileName && fileName.includes('.') ? '' : '.bin');
  const safeName = fileName || (msgType === 'image' ? 'image.jpg' : 'file' + ext);
  const ts = Date.now();
  const storagePath = last.task_id + '/' + ts + '_' + safeName.replace(/[^\w.\-ก-๙]/g, '_');

  // อัปขึ้น Storage
  const { error: upErr } = await dbClient.storage.from('attachments')
    .upload(storagePath, buffer, { contentType, upsert: true });
  if (upErr) return { error: 'อัปไฟล์ไม่สำเร็จ: ' + upErr.message };

  const { data: pub } = dbClient.storage.from('attachments').getPublicUrl(storagePath);

  // อ่าน attachments เดิม แล้วเพิ่มไฟล์ใหม่
  const { data: taskRow } = await dbClient.from('tasks')
    .select('attachments').eq('id', last.task_id).maybeSingle();
  let atts = [];
  if (taskRow && taskRow.attachments) {
    atts = Array.isArray(taskRow.attachments) ? taskRow.attachments : [];
  }
  atts.push({
    name: safeName,
    size: buffer.length,
    fileId: storagePath,
    mimeType: contentType,
    webViewLink: pub.publicUrl
  });

  const { error: updErr } = await dbClient.from('tasks')
    .update({ attachments: atts }).eq('id', last.task_id);
  if (updErr) return { error: 'บันทึกไฟล์เข้างานไม่สำเร็จ: ' + updErr.message };

  return { ok: true, taskName: last.task_name, count: atts.length };
}

// ── verify LINE signature ─────────────────────────────────────────────────────
function verifySignature(body, signature) {
  if (!LINE_SECRET) return true; // ถ้ายังไม่ตั้ง secret ให้ผ่านไปก่อน
  const hash = crypto.createHmac('SHA256', LINE_SECRET).update(body).digest('base64');
  return hash === signature;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(200).json({ ok: true }); return; }

  try {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const sig = req.headers['x-line-signature'] || '';

    if (!verifySignature(rawBody, sig)) {
      res.status(401).json({ ok: false, error: 'Invalid signature' });
      return;
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const events = body.events || [];

    for (const event of events) {
      if (event.type !== 'message') continue;

      const msgType = event.message?.type || '';
      const replyToken = event.replyToken;
      const senderName = event.source?.userId || '';
      const pushTarget = event.source?.groupId || event.source?.roomId || event.source?.userId || '';
      const mentionees = event.message?.mention?.mentionees || [];
      const botMentioned = mentionees.some(m => m.isSelf === true);
      const quotedId = event.message?.quotedMessageId || '';

      // ══ กรณีไฟล์/รูป → เก็บ messageId ไว้ใน line_messages เพื่อให้ +1 ดึงได้ ══
      if (msgType === 'image' || msgType === 'file') {
        if (db) {
          try {
            await db.from('line_messages').upsert({
              message_id: event.message.id,
              group_id: pushTarget,
              user_id: senderName,
              text: null,
              msg_type: msgType,
              file_name: event.message?.fileName || null
            }, { onConflict: 'message_id' });
          } catch (e) {}
        }
        continue;
      }

      // ข้ามไฟล์/รูป/สติกเกอร์/พิกัด ที่ไม่ได้แท็กบอท (ไม่ยุ่ง)
      if (msgType !== 'text') continue;

      const text = event.message.text || '';

      // ── เก็บทุกข้อความ (text) ลง DB เพื่อให้ reply ย้อนหลังได้ (เก็บ 7 วัน) ──
      const msgId = event.message?.id || '';
      if (db && msgId) {
        try {
          await db.from('line_messages').upsert({
            message_id: msgId,
            group_id: pushTarget,
            user_id: senderName,
            text: text
          }, { onConflict: 'message_id' });
        } catch (e) {}
      }

      // ── ถ้าเป็นการ reply ข้อความเก่า → ดึงข้อความต้นฉบับจาก DB ──────────────
      let quotedText = '';
      if (db && quotedId) {
        try {
          const { data } = await db.from('line_messages')
            .select('text').eq('message_id', quotedId).maybeSingle();
          if (data && data.text) quotedText = data.text;
        } catch (e) {}
      }

      const tt = text.trim();
      const lc = tt.toLowerCase();

      // ── +1 → reply รูป/ไฟล์ แล้วพิมพ์ +1 → แนบเข้างานล่าสุด ─────────────
      if (/^\+\d+$/.test(tt)) {
        if (!db) { await replyLine(replyToken, '❌ ยังไม่ได้เชื่อมต่อฐานข้อมูลครับ'); continue; }
        try {
          if (!quotedId) continue;
          // ดึง message type จาก line_messages
          const { data: quotedMsg } = await db.from('line_messages')
            .select('msg_type, file_name').eq('message_id', quotedId).maybeSingle();
          const fileMsgType = quotedMsg?.msg_type || 'image';
          const fname = quotedMsg?.file_name || '';

          // หางานล่าสุดของกลุ่มนี้
          const { data: last } = await db.from('line_last_task')
            .select('task_id, task_name').eq('group_id', pushTarget).maybeSingle();
          if (!last || !last.task_id) {
            await replyLine(replyToken, '⚠️ ยังไม่มีงานในกลุ่มนี้ครับ กรุณาสร้างงานก่อนแนบไฟล์');
            continue;
          }

          // โหลดไฟล์จาก LINE ตาม quotedId
          const { buffer, contentType } = await getLineContent(quotedId);
          const ext = fileMsgType === 'image' ? '.jpg' : (fname && fname.includes('.') ? '' : '.bin');
          const safeName = fname || (fileMsgType === 'image' ? 'image.jpg' : 'file' + ext);
          const ts = Date.now();
          const ext2 = safeName.includes('.') ? safeName.slice(safeName.lastIndexOf('.')) : '';
          const storagePath = last.task_id + '/' + ts + ext2;

          const { error: upErr } = await db.storage.from('attachments')
            .upload(storagePath, buffer, { contentType, upsert: true });
          if (upErr) { await replyLine(replyToken, '❌ อัปไฟล์ไม่สำเร็จ: ' + upErr.message); continue; }

          const { data: pub } = db.storage.from('attachments').getPublicUrl(storagePath);

          const { data: taskRow } = await db.from('tasks')
            .select('attachments').eq('id', last.task_id).maybeSingle();
          let atts = Array.isArray(taskRow?.attachments) ? taskRow.attachments : [];
          atts.push({ name: safeName, size: buffer.length, fileId: storagePath, mimeType: contentType, webViewLink: pub.publicUrl });

          const { error: updErr } = await db.from('tasks').update({ attachments: atts }).eq('id', last.task_id);
          if (updErr) { await replyLine(replyToken, '❌ บันทึกไฟล์ไม่สำเร็จ: ' + updErr.message); continue; }

          await replyLine(replyToken, '📎 แนบไฟล์เข้างานแล้วครับ!\n📋 ' + last.task_name + '\n📁 ไฟล์ทั้งหมด: ' + atts.length + ' ไฟล์');
        } catch (e) {
          await replyLine(replyToken, '❌ แนบไฟล์ไม่สำเร็จ: ' + e.message);
        }
        continue;
      }

      // ── /เทียบ so1234 po5678 [ตัวย่อบริษัท] → PDF เปรียบเทียบ ───────────────
      if (tt.startsWith('/เทียบ') || tt.toLowerCase().startsWith('/compare')) {
        const arg = tt.replace(/^\/เทียบ/,'').replace(/^\/compare/i,'').trim();
        // parse: "so1234 po5678" หรือ "so1234 po5678 md"
        const { keyword: argClean, company: cmp } = parseCompany(arg);
        const parts = argClean.trim().split(/\s+/);
        if (parts.length < 2) {
          await replyLine(replyToken, 'พิมพ์ให้ครบครับ เช่น /เทียบ so1234 po5678\nหรือ /เทียบ so1234 po5678 md');
          continue;
        }
        // แยก type + เลขที่ เช่น "so1234" → type=so, num=1234
        const parseDocRef = (s) => {
          const m = s.match(/^(so|po|pr)(.+)$/i);
          if (!m) return null;
          return { type: m[1].toLowerCase(), num: m[2] };
        };
        const refA = parseDocRef(parts[0]);
        const refB = parseDocRef(parts[1]);
        if (!refA || !refB) {
          await replyLine(replyToken, 'รูปแบบไม่ถูกต้องครับ ตัวอย่าง: /เทียบ so1234 po5678');
          continue;
        }
        if (!odooConfigured()) { await replyLine(replyToken, '❌ ยังไม่ได้ตั้งค่า Odoo ครับ'); continue; }
        await replyLine(replyToken, '⏳ กำลังดึงข้อมูลและสร้าง PDF เปรียบเทียบ...');
        if (pushTarget) {
          (async () => {
            try {
              const compareData = await odooCompare(refA.type, refA.num, refB.type, refB.num, cmp.id);
              const pdfBytes = await buildComparePDF(compareData);
              const labelA = refA.type.toUpperCase() + refA.num;
              const labelB = refB.type.toUpperCase() + refB.num;
              const fname = 'compare/' + Date.now() + '.pdf';
              const { error: upErr } = await db.storage.from('attachments')
                .upload(fname, Buffer.from(pdfBytes), { contentType: 'application/pdf', upsert: true });
              if (upErr) { await pushLine(pushTarget, [{ type:'text', text:'❌ อัปไฟล์ไม่สำเร็จ: ' + upErr.message }]); return; }
              const { data: pub } = db.storage.from('attachments').getPublicUrl(fname);
              // สรุปตัวเลข
              const rows = compareData.rows || [];
              const cntOk   = rows.filter(r=>r.status==='ok').length;
              const cntDiff = rows.filter(r=>r.status==='diff').length;
              const cntMis  = rows.filter(r=>r.status.startsWith('missing')).length;
              await pushLine(pushTarget, [{
                type: 'text',
                text: '📊 เปรียบเทียบ ' + labelA + ' vs ' + labelB + ' (' + cmp.name + ')\n\n' +
                      '✅ ตรง: ' + cntOk + ' รายการ\n' +
                      (cntDiff ? '⚠️ ต่าง: ' + cntDiff + ' รายการ\n' : '') +
                      (cntMis  ? '❌ ขาด: ' + cntMis  + ' รายการ\n' : '') +
                      '\n📎 เปิด PDF:\n' + pub.publicUrl
              }]);
            } catch (e) {
              await pushLine(pushTarget, [{ type:'text', text:'❌ เปรียบเทียบไม่สำเร็จ: ' + e.message }]);
            }
          })();
        }
        continue;
      }

      // ── /ส่งของ → สร้าง PDF อัป Storage แล้วส่งลิงก์ ─────────────────────
      if (tt.startsWith('/ส่งของ') || tt.startsWith('/จัดส่ง') || lc.startsWith('/delivery')) {
        let kw = tt.replace(/^\/ส่งของ/, '').replace(/^\/จัดส่ง/, '').replace(/^\/delivery/i, '').trim();
        if (!kw) {
          await replyLine(replyToken, 'พิมพ์ชื่อโครงการด้วยครับ เช่น /ส่งของ อุตรดิตถ์\nพิมพ์ต่อท้ายได้: รอ / ส่งแล้ว / ทั้งหมด');
        } else {
          // ดึง statusFilter จากคำท้าย (default = รอส่ง)
          let statusFilter = 'pending';
          kw = kw.replace(/\s+(ทั้งหมด|all|ส่งแล้ว|เสร็จแล้ว|done|รอ|รอส่ง|pending)\s*$/i, (_, m) => {
            const ml = m.toLowerCase();
            if (['ทั้งหมด','all'].includes(ml))                    statusFilter = 'all';
            else if (['ส่งแล้ว','เสร็จแล้ว','done'].includes(ml)) statusFilter = 'done';
            else                                                    statusFilter = 'pending';
            return '';
          }).trim();
          const label = statusFilter === 'done' ? 'ส่งแล้ว' : statusFilter === 'all' ? 'ทั้งหมด' : 'รอส่ง';
          await replyLine(replyToken, '⏳ กำลังสร้างใบส่งของ [' + label + '] ของ "' + kw + '" ครับ...');
          if (pushTarget) sendDeliveryPDFtoLine(pushTarget, kw, statusFilter);
        }
        continue;
      }

      // ── คำสั่ง Odoo อื่นๆ (/สต็อก /po /so /pr /help) → เรียก rpc.js ──────
      if (tt.startsWith('/สต็อก') || tt.startsWith('/stock') ||
          lc.startsWith('/po') || tt.startsWith('/พีโอ') ||
          lc.startsWith('/so') || tt.startsWith('/ขาย') ||
          lc.startsWith('/pr') || tt.startsWith('/ขอซื้อ')) {
        try {
          const reply = await handleTelegramCommand(tt);
          await replyLine(replyToken, reply || '🔍 ไม่พบข้อมูลครับ');
        } catch (e) {
          await replyLine(replyToken, '❌ ดึงข้อมูลไม่สำเร็จ: ' + e.message);
        }
        continue;
      }

      // ── คำสั่ง /help ─────────────────────────────────────────────────────
      if (text.trim() === '/help' || text.trim() === '/ช่วยเหลือ') {
        await replyLine(replyToken,
          '🤖 TMS Bot — คำสั่งที่ใช้ได้\n\n' +
          '📦 /สต็อก [ชื่อสินค้า] — เช็คสต็อก\n' +
          '🧾 /po [เลขที่] — ใบสั่งซื้อ\n' +
          '🧾 /so [เลขที่] — ใบสั่งขาย\n' +
          '📄 /pr [เลขที่] — ใบขอซื้อ\n' +
          '🚚 /ส่งของ [ชื่อโครงการ] — ใบส่งของ (PDF)\n\n' +
          '🏢 เลือกบริษัท: เติม md/cg/sep ท้ายคำ\n' +
          'เช่น /สต็อก เหล็ก cg\n\n' +
          '━━━━━━━━━━\n' +
          '📋 สร้างงาน: รับ: ชื่องาน 5/6/2026 @ผู้รับผิดชอบ\n' +
          '📊 /สรุป — ดูสรุปงาน'
        );
        continue;
      }

      // ── คำสั่ง /สรุป ─────────────────────────────────────────────────────
      if (text.trim() === '/สรุป') {
        if (!db) { await replyLine(replyToken, '❌ ยังไม่ได้เชื่อมต่อฐานข้อมูลครับ'); continue; }
        const { data } = await db.from('tasks').select('task_status, done');
        const list = data || [];
        const todo  = list.filter(t => !t.done && t.task_status === 'To Do').length;
        const doing = list.filter(t => !t.done && t.task_status === 'Doing').length;
        const done  = list.filter(t => t.done).length;
        await replyLine(replyToken,
          `📊 สรุปงานทั้งหมด\n\n` +
          `📋 ทั้งหมด: ${list.length} งาน\n` +
          `🔵 To Do: ${todo}\n` +
          `🟣 Doing: ${doing}\n` +
          `✅ Done: ${done}`
        );
        continue;
      }

      // ── แก้ไฟล์ → reply ข้อความเดิม + แท็กบอท + "แก้ไฟล์" → ล้างไฟล์เก่า ──
      if (botMentioned && /^แก้ไฟล์$/i.test(tt.replace(/@\S+/g, '').trim())) {
        if (!db) { await replyLine(replyToken, '❌ ยังไม่ได้เชื่อมต่อฐานข้อมูลครับ'); continue; }
        const { data: last } = await db.from('line_last_task')
          .select('task_id, task_name').eq('group_id', pushTarget).maybeSingle();
        if (!last || !last.task_id) {
          await replyLine(replyToken, '⚠️ ยังไม่มีงานในกลุ่มนี้ครับ'); continue;
        }
        const { error: clrErr } = await db.from('tasks')
          .update({ attachments: [] }).eq('id', last.task_id);
        if (clrErr) { await replyLine(replyToken, '❌ ล้างไฟล์ไม่สำเร็จ: ' + clrErr.message); continue; }
        await replyLine(replyToken, '🗑️ ล้างไฟล์เก่าแล้วครับ!\n📋 ' + last.task_name + '\n\nตอนนี้ reply ไฟล์ใหม่ แล้วพิมพ์ +1 ได้เลยครับ');
        continue;
      }

      // ── เปลี่ยนวัน → reply ข้อความเดิม + แท็กบอท + "เปลี่ยนวัน 20/6/69" ──
      if (botMentioned) {
        const cleanTT = tt.replace(/@\S+/g, '').trim();
        const dateChangeMatch = cleanTT.match(/^เปลี่ยนวัน\s+(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/);
        if (dateChangeMatch) {
          if (!db) { await replyLine(replyToken, '❌ ยังไม่ได้เชื่อมต่อฐานข้อมูลครับ'); continue; }
          const newDate = parseDate(dateChangeMatch[1]);
          if (!newDate) { await replyLine(replyToken, '❌ ไม่เข้าใจวันที่ครับ เช่น เปลี่ยนวัน 20/6/69'); continue; }
          const { data: last } = await db.from('line_last_task')
            .select('task_id, task_name').eq('group_id', pushTarget).maybeSingle();
          if (!last || !last.task_id) { await replyLine(replyToken, '⚠️ ยังไม่มีงานในกลุ่มนี้ครับ'); continue; }
          const { error: updErr } = await db.from('tasks')
            .update({ action_date: newDate }).eq('id', last.task_id);
          if (updErr) { await replyLine(replyToken, '❌ แก้ไขไม่สำเร็จ: ' + updErr.message); continue; }
          const [y2, m2, d2] = newDate.split('-');
          const dateDisplay = `${+d2}/${+m2}/${+y2+543}`;
          await replyLine(replyToken, '✅ เปลี่ยนวันที่แล้วครับ!\n📋 ' + last.task_name + '\n📅 ' + dateDisplay);
          continue;
        }
      }

      // ── สร้างงานใหม่ ──────────────────────────────────────────────────────
      // กฎ: รับงาน = ต้อง Reply ข้อความงาน + แท็กบอท เท่านั้น
      // (mentionees, botMentioned, quotedId ประกาศไว้ข้างบนแล้ว)

      // แบบเดิม (รับ:/ส่ง:/งานใหม่) — พิมพ์ตรงๆ ยังใช้ได้
      let taskData = parseTask(text);

      // แบบ Reply: ต้องเป็นการ reply (มี quotedId) + แท็กบอท
      if (!taskData && botMentioned && quotedId) {
        // ตัด mention บอทออกตรงตำแหน่งจริง (index+length) กันคำว่า Bot ค้าง
        let typedClean = text;
        const botMentions = mentionees
          .filter(m => m.isSelf === true && typeof m.index === 'number' && typeof m.length === 'number')
          .sort((a, b) => b.index - a.index);
        for (const m of botMentions) {
          typedClean = typedClean.slice(0, m.index) + typedClean.slice(m.index + m.length);
        }
        typedClean = typedClean.replace(/@[^\s@]+/g, ' ').replace(/\s+/g, ' ').trim();

        // ถ้าเจอข้อความเดิมที่ reply → รวม | ถ้าไม่เจอ → ใช้ที่พิมพ์ (ไม่หยุด)
        const combined = quotedText
          ? (quotedText + ' ' + typedClean).trim()
          : typedClean;
        taskData = await parseTaskSmart(combined, db, typedClean);
      }

      if (taskData) {
        if (!db) { await replyLine(replyToken, '❌ ยังไม่ได้เชื่อมต่อฐานข้อมูลครับ'); continue; }

        const id = rid();
        const { error } = await db.from('tasks').insert({
          id,
          task: taskData.task,
          duration: taskData.duration,
          action_date: taskData.actionDate,
          sales_name: taskData.salesName,
          task_status: 'To Do',
          notification: 'แจ้งล่วงหน้า',
          categories: taskData.categories || '',
          note: '',
          doing: false,
          done: false,
          attachments: []
        });

        if (error) {
          await replyLine(replyToken, `❌ บันทึกไม่สำเร็จครับ: ${error.message}`);
        } else {
          // จำงานล่าสุดของกลุ่มนี้ (สำหรับแนบไฟล์ +1 ภายใน 5 นาที)
          try {
            await db.from('line_last_task').upsert({
              group_id: pushTarget,
              task_id: id,
              task_name: taskData.task.slice(0, 100),
              created_at: new Date().toISOString()
            }, { onConflict: 'group_id' });
          } catch (e) {}

          const dur = taskData.duration === 'รับ' ? '📦 รับ' : '🚚 ส่ง';
          const [y, m, d] = taskData.actionDate.split('-');
          const dateDisplay = `${+d}/${+m}/${+y+543}`;
          await replyLine(replyToken,
            `✅ บันทึกงานใหม่แล้วครับ!\n\n` +
            `📋 ${taskData.task}\n` +
            `${dur}\n` +
            `📅 ${dateDisplay}\n` +
            (taskData.salesName ? `👤 ${taskData.salesName}\n` : '') +
            (taskData.categories ? `🏷️ ${taskData.categories}\n` : '') +
            `\n🔗 ดูในระบบ: inventory-rho-hazel.vercel.app`
          );
          // แจ้งเข้ากลุ่ม Telegram หลักด้วย (chat id 1)
          try {
            await notifyMainChat(
              `🆕 <b>งานใหม่จากไลน์</b>\n` +
              `📋 ${taskData.task}\n` +
              `${dur}  📅 ${dateDisplay}\n` +
              (taskData.salesName ? `👤 ${taskData.salesName}\n` : '') +
              (taskData.categories ? `🏷️ ${taskData.categories}` : '')
            );
          } catch (e) {}
        }
        continue;
      }
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('LINE webhook error:', e.message);
    res.status(200).json({ ok: true });
  }
}
