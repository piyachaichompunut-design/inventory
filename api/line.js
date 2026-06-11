// LINE Webhook — รับข้อความจากกลุ่มไลน์ แล้วสร้างงานใน TMS + คำสั่ง Odoo
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { handleTelegramCommand, __setDb, notifyMainChat } from './rpc.js';
import { odooConfigured, odooDelivery, parseCompany } from './odoo.js';
import { buildDeliveryPDF } from './pdfgen.js';

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
async function sendDeliveryPDFtoLine(to, keyword) {
  if (!odooConfigured()) { await pushLine(to, [{ type:'text', text:'❌ ยังไม่ได้ตั้งค่า Odoo ครับ' }]); return; }
  if (!db) { await pushLine(to, [{ type:'text', text:'❌ ยังไม่ได้เชื่อมต่อ Storage ครับ' }]); return; }
  try {
    const { keyword: dkw, company: dCo } = parseCompany(keyword);
    const picks = await odooDelivery(dkw, dCo.id);
    if (!picks.length) {
      await pushLine(to, [{ type:'text', text:'🔍 ไม่พบใบส่งของ "' + dkw + '" (บริษัท ' + dCo.name + ') ใน Odoo' }]);
      return;
    }
    // นับสถานะ + เตรียมข้อมูล PDF
    let cntDone = 0, cntPending = 0, cntCancel = 0;
    const picksData = picks.map(p => {
      let statusText, statusColor;
      if (p.state === 'done')        { statusText='ส่งแล้ว'; statusColor='red';  cntDone++; }
      else if (p.state === 'cancel') { statusText='ยกเลิก';  statusColor='gray'; cntCancel++; }
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
    const data = {
      title: 'ใบส่งของ — ' + dkw + ' (' + dCo.name + ')',
      summary: { total: picks.length, done: cntDone, pending: cntPending, cancel: cntCancel },
      picks: picksData
    };
    const pdfBytes = await buildDeliveryPDF(data);

    // อัปขึ้น Supabase Storage (bucket: attachments) → ได้ public URL
    const fname = 'delivery/' + Date.now() + '.pdf';
    const { error: upErr } = await db.storage.from('attachments')
      .upload(fname, Buffer.from(pdfBytes), { contentType: 'application/pdf', upsert: true });
    if (upErr) {
      await pushLine(to, [{ type:'text', text:'❌ อัปไฟล์ไม่สำเร็จ: ' + upErr.message }]);
      return;
    }
    const { data: pub } = db.storage.from('attachments').getPublicUrl(fname);
    const url = pub.publicUrl;

    // ส่งสรุป + ลิงก์ PDF เข้าไลน์
    const sumLine = 'รวม ' + picks.length + ' ใบ'
      + (cntDone ? ' | ส่งแล้ว ' + cntDone : '')
      + (cntPending ? ' | รอส่ง ' + cntPending : '')
      + (cntCancel ? ' | ยกเลิก ' + cntCancel : '');
    await pushLine(to, [{
      type: 'text',
      text: '📄 ใบส่งของ "' + dkw + '" — ' + dCo.name + '\n' + sumLine + '\n\n📎 เปิดไฟล์ PDF:\n' + url
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

  // ดึงวันที่ (ตัวเลข 10/6/2026 หรือไทย "วันที่10มิถุนายน")
  let actionDate = todayStr();
  const dateMatch = t.match(/(?:วันที่\s*)?(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
  if (dateMatch) {
    const parsed = parseDate(dateMatch[1]);
    if (parsed) actionDate = parsed;
  } else {
    const thMonth = { 'มกราคม':1,'กุมภาพันธ์':2,'มีนาคม':3,'เมษายน':4,'พฤษภาคม':5,'มิถุนายน':6,'กรกฎาคม':7,'สิงหาคม':8,'กันยายน':9,'ตุลาคม':10,'พฤศจิกายน':11,'ธันวาคม':12 };
    const m = t.match(/วันที่?\s*(\d{1,2})\s*(มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)/);
    if (m) {
      const now = new Date();
      actionDate = now.getFullYear() + '-' + String(thMonth[m[2]]).padStart(2,'0') + '-' + String(+m[1]).padStart(2,'0');
    }
  }

  // ตัดวันที่ออกจากข้อความ (ข้อความงานต้นฉบับ)
  let body = t.replace(/วันที่?\s*\d{1,2}\s*(มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)/, '')
              .replace(/(?:วันที่\s*)?\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/, '')
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

  // แยกคำจากที่พิมพ์ (typedBody) — รูปแบบ: [หมวด] [ชื่อ]
  const typedWords = (typedBody || '').split(/\s+/).filter(Boolean);
  if (typedWords.length >= 2) {
    // 2 คำขึ้นไป: คำแรก=หมวด, ที่เหลือ=ชื่อ
    const catWord = typedWords[0];
    const matched = catList.find(c => c === catWord || c.includes(catWord) || catWord.includes(c));
    categories = matched || catWord;        // ถ้าตรง DB ใช้ชื่อเต็ม ไม่ตรงก็ใช้ที่พิมพ์
    salesName = typedWords.slice(1).join(' ');
  } else if (typedWords.length === 1) {
    // คำเดียว: เดาว่าเป็นหมวด หรือ ชื่อ — ถ้าตรง DB = หมวด, ไม่ตรง = ชื่อ
    const w = typedWords[0];
    const matched = catList.find(c => c === w || c.includes(w) || w.includes(c));
    if (matched) categories = matched;
    else salesName = w;
  }

  // ชื่องาน = ข้อความงานต้นฉบับ (body) — ถ้า body ว่าง (ไม่ reply) ใช้ typedBody แทน
  const words = (body || typedBody || '').split(' ');

  return { task, duration, actionDate, salesName, categories };
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
      if (event.type !== 'message' || event.message?.type !== 'text') continue;

      const text = event.message.text || '';
      const replyToken = event.replyToken;
      const senderName = event.source?.userId || '';
      // ปลายทางสำหรับ push (กลุ่ม/ห้อง/คนเดี่ยว)
      const pushTarget = event.source?.groupId || event.source?.roomId || event.source?.userId || '';

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
      const quotedId = event.message?.quotedMessageId || '';
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

      // ── /ส่งของ → สร้าง PDF อัป Storage แล้วส่งลิงก์ ─────────────────────
      if (tt.startsWith('/ส่งของ') || tt.startsWith('/จัดส่ง') || lc.startsWith('/delivery')) {
        const kw = tt.replace(/^\/ส่งของ/, '').replace(/^\/จัดส่ง/, '').replace(/^\/delivery/i, '').trim();
        if (!kw) {
          await replyLine(replyToken, 'พิมพ์ชื่อโครงการด้วยครับ เช่น /ส่งของ อุตรดิตถ์');
        } else {
          await replyLine(replyToken, '⏳ กำลังสร้างใบส่งของ PDF ของ "' + kw + '" ครับ...');
          // สร้าง PDF + อัป + ส่งลิงก์ (ใช้ push เพราะ replyToken ใช้ได้ครั้งเดียว)
          if (pushTarget) await sendDeliveryPDFtoLine(pushTarget, kw);
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

      // ── สร้างงานใหม่ ──────────────────────────────────────────────────────
      // กฎ: รับงาน = ต้อง Reply ข้อความงาน + แท็กบอท เท่านั้น
      const mentionees = event.message?.mention?.mentionees || [];
      const botMentioned = mentionees.some(m => m.isSelf === true);

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
