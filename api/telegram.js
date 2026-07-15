// Telegram Webhook   
// - /คำสั่ง → คำสั่งสำเร็จรูป (ดูข้อมูลจาก Supabase)
// - @botname → ถาม Groq AI + ค้นเว็บด้วย Tavily ถ้าจำเป็น
// - กลุ่มใหม่: Reply ข้อความ แล้ว @บอท → บันทึกงานอัตโนมัติ
import { handleTelegramCommand, sendTelegramReply, isAllowedChat, getChatType, notifyMainChat, sendDeliveryPDF } from './rpc.js';
import { odooFindDoc, odooUploadAttachment, odooConfigured, odooDelivery, parseCompany, odooCompare, odooCompareWithDelivery, companyById } from './odoo.js';
import { createClient } from '@supabase/supabase-js';
import { tableGroupsFromBuffer, beDisplay, guessCategory } from './table.js';

const GROQ_KEY     = process.env.GROQ_API_KEY || '';
const TAVILY_KEY   = process.env.TAVILY_API_KEY || '';
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').toLowerCase();
const GROQ_MODEL   = 'llama-3.3-70b-versatile';
const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

// ป้ายบริษัทสั้นๆ (มี 4 บริษัท — ชื่องาน/เลขซ้ำข้ามบริษัทได้ ต้องโชว์ให้เลือกถูกใบ)
const CO_SHORT = { 1: 'อาคเนย์', 2: 'เมิร์ค', 4: 'ซิลิกัล', 5: 'ศรีอาคเนย์' };
function coLabel(cid) {
  const id = Array.isArray(cid) ? cid[0] : cid;
  if (CO_SHORT[id]) return CO_SHORT[id];
  return Array.isArray(cid) ? String(cid[1]).replace(/บริษัท|จำกัด|\(?สำนักงานใหญ่\)?|\s/g, '').slice(0, 12) : '';
}

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const db = (SUPABASE_URL && SERVICE_KEY)
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const rid = () => 'T' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2,5).toUpperCase();

// ── ระบบเบิกของ: กลุ่มเบิกของ (แผนกอื่น) → แจ้งเข้า chat 1 ──────────────────────
// บอทเงียบในกลุ่มนี้ ไม่ตอบใคร แค่ดึงข้อความ/รูปเบิกของส่งเข้า chat 1
const WITHDRAW_GROUP_ID = process.env.WITHDRAW_GROUP_ID || '-1001698212414'; // กลุ่ม SET เบิกของ Store
// Chat 4: กลุ่ม SET (สโตร์) — รับรูป/ไฟล์/ข้อความสินค้าเข้าคลัง → แจ้ง chat 1
const STORE_GROUP_ID = process.env.STORE_GROUP_ID || '-1001817927448';
// คำกรองข้อความสต็อก/คลัง — ใช้วลีเฉพาะ (กันข้อความทั่วไปหลุดมา)
// เอาเฉพาะข้อความที่เกี่ยวกับ "นำส่งคลัง/ส่งขึ้นคลัง" หรือใบรายการ FG จริงๆ
const STORE_MSG_KEYWORDS = /(นำส่ง|ส่งของ|นำส่ง.*คลัง|ส่ง.*ขึ้น.*คลัง|ส่งขึ้นคลัง|เข้าคลัง|เข้าสโตร์|ขึ้นสโตร์|แจ้งรายการนำส่ง|รายการนำส่ง|ใบรายการ|นำส่งแผนกคลัง|รับเข้าคลัง|FG\.|สถานะ\s*:|ในนาม\s*:)/i;
const STORE_GREETING_ONLY = /^(รับทราบ|ขอบคุณ|ขอบคุณครับ|ขอบคุณค่ะ|โอเค|okay|ok|ครับ|ค่ะ|คับ|จ้า|ได้ครับ|ได้ค่ะ|👍|🙏|❤️|สวัสดี|เรียบร้อย|👌|🆗|--|---+)[\s\S]{0,15}$/i;
// คำที่ถือว่าเป็น "ทักทาย/ตอบรับ" ล้วนๆ → ไม่ต้องส่งเข้า chat 1
const WITHDRAW_GREETING_ONLY = /^(รับทราบ|ขอบคุณ|ขอบคุณครับ|ขอบคุณค่ะ|โอเค|okay|ok|ครับ|ค่ะ|คับ|จ้า|ได้ครับ|ได้ค่ะ|👍|🙏|❤️|สวัสดี|เรียบร้อย|👌|🆗)[\s\S]{0,15}$/i;

// ── ระบบจับ "แจ้งส่ง/รับของ" อัตโนมัติ จากกลุ่มฝ่ายจัดซื้อ → บันทึกงาน + แจ้งกลุ่มใหม่ ──
//   (เป็นทางเลือกที่ 2 — reply @บอท แบบเดิมยังใช้ได้ปกติ)
const PURCHASE_GROUP_ID = process.env.PURCHASE_GROUP_ID || '-1001954468509'; // กลุ่มฝ่ายจัดซื้อ
// เฉพาะ 2 คนนี้เท่านั้นที่บอทจับข้อความแจ้งส่ง (ฝ้าย + เมย์)
const PURCHASE_SENDER_IDS = (process.env.PURCHASE_SENDER_IDS || '6165102439,7233671051')
  .split(',').map(s => s.trim()).filter(Boolean);
// ต้องเป็น "ประโยคแจ้งส่ง" จริงๆ (ไม่ใช่แค่มีเลข PO/PR — กันข้อความแก้ไข/คุยเล่น เช่น "PO xxx ไม่ได้สั่ง")
//   รองรับสำนวนจริงของ ฝ้าย/เมย์: "ขอเรียกเข้า PO...", "ซัพเข้าส่งพรุ่งนี้", "นำส่ง", "ฝากส่ง"
const PURCHASE_MSG_KEYWORDS = /(แจ้งส่ง|แจ้งรับ|แจ้งสินค้า|เข้าคลัง|นำส่ง|เรียกเข้า|เข้าส่ง|ขอส่ง|จัดส่ง|ฝาก.{0,25}ส่ง|ส่ง\s*(วันที่\s*)?\d{1,2}[\/\-]\d{1,2}|ส่ง.{0,6}(วันนี้|พรุ่งนี้|พรุ้งนี้|มะรืน)|(วันนี้|พรุ่งนี้|พรุ้งนี้|มะรืน).{0,6}ส่ง)/i;
// ต้องมีแท็ก/ชื่อผู้รับแจ้ง (กันคุยเล่น) — @Nutnut011993 / Anonthaphon / โอม
const PURCHASE_MENTION = /(@?Nutnut011993|Anonthaphon|โอม)/i;

const todayStr = () => new Date().toISOString().slice(0,10);

// ── แปลง "วันส่ง" จากข้อความ → YYYY-MM-DD (รองรับวันที่ชัดเจน + คำบอกวันแบบสัมพัทธ์) ──
//   "7/7", "7/7/69" → parseDate | "พรุ่งนี้" → +1 วัน | "วันนี้" → วันนี้ | "มะรืน" → +2 วัน
//   คิดวันตามเวลาไทย (เซิร์ฟเวอร์เป็น UTC)
function resolveShipDate(text) {
  if (!text) return null;
  const t = String(text);
  // วันที่ชัดเจนก่อน (ตัดขนาดนิ้ว/เศษส่วนออกกัน 1-1/2" อ่านเป็นวันที่)
  const cleaned = t.replace(/\d{1,2}(?:-\d{1,2})?\/\d{1,2}\s*(?:["”″']|นิ้ว|inch)/gi, ' ');
  const m = cleaned.match(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/);
  if (m) { const d = parseDate(m[1]); if (d) return d; }
  // คำบอกวันแบบสัมพัทธ์
  const nowTh = new Date(Date.now() + 7 * 3600 * 1000);
  const addDays = (n) => {
    const x = new Date(nowTh.getTime() + n * 86400000);
    return x.getUTCFullYear() + '-' + String(x.getUTCMonth() + 1).padStart(2, '0') + '-' + String(x.getUTCDate()).padStart(2, '0');
  };
  if (/มะรืน/.test(t)) return addDays(2);
  if (/พรุ่งนี้|พรุ้งนี้|พรุ่งนี|วันพรุ่ง/.test(t)) return addDays(1);
  if (/วันนี้|เข้าวันนี้/.test(t)) return addDays(0);
  return null;
}

// escape อักขระ HTML สำหรับ Telegram parse_mode=HTML (กัน < > & ทำให้ส่งไม่ได้)
function tgEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// ── ย่อรูปก่อนเก็บ (ประหยัด Storage) — ไม่ใช่รูปหรือย่อไม่ได้ คืนของเดิม ──
async function compressIfImage(buffer, contentType) {
  if (!/^image\/(jpe?g|png|webp)/i.test(contentType || '')) {
    return { buffer, contentType };
  }
  try {
    const sharp = (await import('sharp')).default;
    const out = await sharp(buffer)
      .rotate()
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();
    if (out.length < buffer.length) return { buffer: out, contentType: 'image/jpeg' };
    return { buffer, contentType };
  } catch (e) {
    return { buffer, contentType };
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  ตารางแจ้งสินค้าเข้า/ส่งของ (แยกตาม PO+วันส่ง) → ใช้ตัวอ่านกลางจาก ./table.js
//  ที่นี่เหลือแค่ ดาวน์โหลดไฟล์ Telegram + สร้างงานลง web
// ════════════════════════════════════════════════════════════════════════════
// ดาวน์โหลดไฟล์จาก Telegram → { buffer, mime, fileName }
async function tgFetchFile(m, token) {
  try {
    let fileId = null, fileName = null, mime = 'application/octet-stream';
    if (m.photo && m.photo.length) { fileId = m.photo[m.photo.length - 1].file_id; mime = 'image/jpeg'; }
    else if (m.document) { fileId = m.document.file_id; fileName = m.document.file_name || null; mime = m.document.mime_type || mime; }
    if (!fileId || !token) return null;
    const i = await (await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`)).json();
    if (!i.ok) return null;
    const url = `https://api.telegram.org/file/bot${token}/${i.result.file_path}`;
    const buffer = Buffer.from(await (await fetch(url)).arrayBuffer());
    if (!fileName) fileName = i.result.file_path.split('/').pop();
    return { buffer, mime, fileName };
  } catch (e) { return null; }
}
// สร้างงานใน web จากกลุ่มที่แยกแล้ว (1 กลุ่ม = 1 บรรทัด) แนบไฟล์ต้นฉบับให้ทุกงาน
async function createPOTableTasks(groups, { responsible = '', attachment = null } = {}) {
  const created = [];
  for (const g of groups) {
    const dateDisplay = g.dateISO ? beDisplay(g.dateISO) : (g.dateRaw || 'รออัพเดท');
    const itemsStr = g.lines.map((l, i) => (i + 1) + '. ' + l.product + (l.qty ? ' — จำนวน ' + l.qty + (l.unit ? ' ' + l.unit : '') : '')).join('\n');
    const body =
      '📦 รับเข้า — PO ' + g.po + (g.supplier ? ' • ' + g.supplier : '') + '\n' +
      '📅 ส่ง: ' + dateDisplay + '\n' +
      '📦 รายการ:\n' + itemsStr;
    const cat = guessCategory(g.lines.map(l => l.product).join(' ')) || '';
    const id = rid();
    const { error } = await db.from('tasks').insert({
      id, task: body.slice(0, 2000), duration: 'รับ',
      action_date: g.dateISO || todayStr(),
      sales_name: responsible || '', task_status: 'To Do', notification: 'แจ้งล่วงหน้า',
      categories: cat, note: g.dateISO ? '' : 'รออัพเดทวันส่ง', doing: false, done: false,
      attachments: attachment ? [attachment] : []
    });
    if (!error) created.push({ po: g.po, date: dateDisplay, count: g.lines.length });
    else console.error('createPOTableTasks insert:', error.message);
  }
  return created;
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM = `คุณคือ "Odoo Bot" ผู้ช่วย AI ประจำทีมงานในประเทศไทย
บุคลิก: กันเอง อบอุ่น ขี้เล่น เหมือนเพื่อนสนิทที่ฉลาด พูดภาษาไทยเป็นธรรมชาติ ใช้ "ครับ" ลงท้าย
สไตล์: ถามง่าย → ตอบสั้นกระชับสนุกสนาน | ถามซับซ้อน → ตอบละเอียดเป็นขั้นตอน
คุณตอบได้ทุกเรื่องเลยครับ ไม่มีข้อจำกัด เช่น:
- 🔮 ดูดวง เช็คดวง ราศี โหราศาสตร์ไทย/จีน ไพ่ทาโร่ → ตอบแบบสนุก อบอุ่น ให้กำลังใจ
- 💬 คุยเรื่องทั่วไป ความรัก ครอบครัว เพื่อน ปัญหาชีวิต → ตอบด้วยความเข้าใจ
- 🍜 อาหาร สุขภาพ ออกกำลังกาย → ให้คำแนะนำที่ดี
- 📰 ข่าวสาร เหตุการณ์ปัจจุบัน → สรุปให้เข้าใจง่าย
- 💡 ความรู้ทั่วไป วิทยาศาสตร์ ประวัติศาสตร์ → อธิบายสนุก
- 🏭 เรื่องงานในระบบ TMS → แนะนำใช้คำสั่ง /งานวันนี้ /สรุป /kpi
เมื่อได้รับผลการค้นหาเว็บ (ขึ้นต้นด้วย [ข้อมูลจากเว็บ]):
- สรุปให้กระชับ เข้าใจง่าย ภาษาไทย
- บอกแหล่งที่มาด้วยถ้าสำคัญ`;

// ── parse วันที่ ──────────────────────────────────────────────────────────────
function parseDate(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (!m) return null;
  let [, d, mo, y] = m;
  if (y === undefined) {
    y = new Date().getFullYear();
  } else {
    y = parseInt(y);
    if (y < 100) { if (y >= 50) y += 2500; else y += 2000; }
    if (y >= 2400) y -= 543;
  }
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  return y + '-' + String(+mo).padStart(2,'0') + '-' + String(+d).padStart(2,'0');
}

// ── parse ข้อความ reply → งานใหม่ ──────────────────────────────────────────
// รองรับ: "ส่งของ บริษัท ABC วันที่ 10/6" / "รับสินค้า XYZ 10/6/2026 @สมชาย"
// keyword → ชื่อหมวดหมู่เต็ม
const CAT_MAP = {
  'so':         'ใบสั่งซื้อ( so )',
  'ป้าย':       'งานป้าย',
  'ป้ายเฟรม':   'งานป้าย+เฟรม',
  'เฟรม':       'งานเฟรม',
  'mast':       'งาน mast arm',
  'ผลิต':       'วัถุดิบเพื่อการผลิต',
  'สิ้นเปลือง': 'วัถุดิบสิ้นเปลือง',
  'ชุบ':        'บริการชุบกัลวาไนซ์',
  'เสา':        'งานเสาไฟฟ้า',
  'เสาอุปกรณ์': 'งานเสาไฟฟ้าและอุปกรณ์',
  'ไฟฟ้า':      'งานอุปกรณ์ไฟฟ้า',
  'ฐาน':        'งานรากฐาน',
  'พัสดุ':      'งานส่งพัสดุ',
  'ซ่อม':       'ซ่อมบำรุง',
  'แผง':        'แผนกไฟฟ้า',
  'ชิลิ':       'ซิลิกัล',
  'การ์ดเรล':   'งานการ์ดเรล',
  'อื่น':       'งานอื่นๆ',
};

// ── เดาหมวดหมู่จากชื่อสินค้า/ข้อความ (ถ้าไม่ได้พิมพ์หมวดมาเอง) ─────────────────
//   เรียงจาก "เจาะจง → กว้าง" อันแรกที่ตรงชนะ | ปรับ/เพิ่มคำได้ตามต้องการ
function parseTaskFromText(text, catKeyword, forceDuration) {
  const t = text.trim();
  const kw = (catKeyword || '').trim();

  // ── วันที่ — ดึงจาก catKeyword ก่อน (สิ่งที่พิมพ์ต่อจาก @บอท) แล้วค่อย fallback ไปหาในข้อความ ──
  // FIX: ตัดรูปแบบ "ขนาดนิ้ว/เศษส่วน" เช่น 1-1/2" หรือ 3/4" ออกก่อนหาวันที่
  //      กันบอทเข้าใจผิดว่าขนาดท่อ/สินค้าเป็นวันที่ (เคย bug: 1-1/2" → อ่านเป็น 1/1 = วันที่ 1 ม.ค.)
  const stripSizeNotation = (s) => s.replace(/\d{1,2}(?:-\d{1,2})?\/\d{1,2}\s*(?:["”″']|นิ้ว|inch)/gi, ' ');
  const dateRe = /(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/;
  const dateFromKw = stripSizeNotation(kw).match(dateRe);
  const dateFromText = stripSizeNotation(t).match(/(?:วันที่\s*)?(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/);
  const rawDate = dateFromKw ? dateFromKw[1] : (dateFromText ? dateFromText[1] : null);
  const actionDate = rawDate ? (parseDate(rawDate) || todayStr()) : todayStr();

  // ── ส่ง/รับ — เช็คจาก catKeyword ก่อน แล้ว fallback ไปหาในข้อความ ──
  // forceDuration: ถ้าระบุมา (เช่น chat 2 บังคับ 'รับ') → ใช้เลย ไม่ auto-detect
  const kwLower = kw.toLowerCase();
  let duration = 'รับ';
  if (forceDuration === 'รับ' || forceDuration === 'ส่ง') {
    duration = forceDuration;
  } else if (/^ส่ง/.test(kwLower) || /ส่งของ|นัดส่ง|จัดส่ง|ออกของ/.test(kwLower)) duration = 'ส่ง';
  else if (/ส่งของ|นัดส่ง|จัดส่ง|ออกของ|นำส่ง/.test(t)) duration = 'ส่ง';
  else if (/รับของ|รับเข้า|รับสินค้า/.test(t)) duration = 'รับ';

  // ── ชื่องาน = ข้อความต้นฉบับ (reply) ──
  const taskText = t.slice(0, 300);

  // ── หมวดหมู่ — ตัดวันที่และ ส่ง/รับ ออกจาก kw แล้วหาหมวด ──
  const kwClean = kw
    .replace(dateRe, '')
    .replace(/^(ส่ง|รับ)\s*/i, '')
    .trim()
    .toLowerCase();
  // หมวด: พิมพ์หมวดมาเอง (kw) ชนะก่อน → ไม่มีค่อยให้บอทเดาจากชื่อสินค้าในข้อความ → สุดท้าย "งานอื่นๆ"
  const categories = CAT_MAP[kwClean] || guessCategory(t) || 'งานอื่นๆ';

  // ── ชื่อคน — ถ้าพิมพ์มาหลังหมวด เช่น "ส่ง 16/6/69 ชุบ พี่เต้ย" ──
  // ตัดทุกอย่างออก เหลือแค่คำท้าย
  const kwWords = kw.replace(dateRe, '').replace(/^(ส่ง|รับ)\s*/i, '').trim().split(/\s+/).filter(Boolean);
  let salesName = '';
  if (kwWords.length >= 2 && CAT_MAP[kwWords[0].toLowerCase()]) {
    salesName = kwWords.slice(1).join(' ');
  }

  return { task: taskText, duration, actionDate, salesName, categories };
}

// ── บันทึกงานจาก reply ───────────────────────────────────────────────────────
async function saveTaskFromReply(text, fromUser, chatId, attachmentObj = null, catKeyword = '', messageId = null, forceDuration = null, forceDate = null) {
  if (!db) return { ok: false, error: 'ยังไม่ได้เชื่อมต่อฐานข้อมูลครับ' };

  const taskData = parseTaskFromText(text, catKeyword, forceDuration);
  // วันส่งที่คิดมาแล้ว (เช่น "พรุ่งนี้" → วันที่จริง) → ทับวันที่ที่ดึงจากข้อความ
  if (forceDate) taskData.actionDate = forceDate;
  const id = rid();
  const attachments = attachmentObj ? [attachmentObj] : [];

  const { error } = await db.from('tasks').insert({
    id,
    task: taskData.task,
    duration: taskData.duration,
    action_date: taskData.actionDate,
    sales_name: taskData.salesName || '',
    task_status: 'To Do',
    notification: 'แจ้งล่วงหน้า',
    categories: taskData.categories || '',
    note: '',
    doing: false,
    done: false,
    attachments,
    tg_message_id: messageId ? String(messageId) : null
  });

  if (error) return { ok: false, error: error.message };

  const dur = taskData.duration === 'รับ' ? '📦 รับ' : '🚚 ส่ง';
  const [y, m, d] = taskData.actionDate.split('-');
  const dateDisplay = `${+d}/${+m}/${+y+543}`;

  const confirmMsg =
    `✅ <b>บันทึกงานใหม่แล้วครับ!</b>\n\n` +
    `📋 ${taskData.task}\n` +
    `${dur}\n` +
    `📅 ${dateDisplay}\n` +
    (taskData.salesName ? `👤 ${taskData.salesName}\n` : '') +
    `\n🔗 ดูในระบบ: inventory-rho-hazel.vercel.app`;

  const mainMsg =
    `🔔 <b>งานใหม่จาก Telegram</b>\n\n` +
    `📋 ${taskData.task}\n` +
    `${dur} · 📅 ${dateDisplay}\n` +
    (taskData.salesName ? `👤 ${taskData.salesName}\n` : '') +
    (fromUser ? `✍️ บันทึกโดย: ${fromUser}\n` : '');

  return { ok: true, confirmMsg, mainMsg, taskId: id, taskName: taskData.task.slice(0, 100) };
}

// ── แก้วันที่ของงานที่ผูกกับ message_id ──────────────────────────────────────
async function updateTaskDateByMessage(messageId, newDate) {
  if (!db) return { ok: false, error: 'ยังไม่ได้เชื่อมต่อฐานข้อมูลครับ' };
  // หางานที่ผูกกับ message_id นี้
  const { data: rows } = await db.from('tasks').select('*').eq('tg_message_id', String(messageId)).limit(1);
  if (!rows || !rows.length) return { ok: false, notFound: true };
  const task = rows[0];
  const { error } = await db.from('tasks').update({ action_date: newDate }).eq('id', task.id);
  if (error) return { ok: false, error: error.message };
  const [y, m, d] = newDate.split('-');
  const dateDisplay = `${+d}/${+m}/${+y+543}`;
  return { ok: true, task, dateDisplay };
}

// ── เทียบเอกสาร SO/PO/PR กับใบส่งของที่เลือกแล้ว → บันทึก delivery_views + ส่งลิงก์ (Telegram) ──
async function sendDeliveryCompareTG(chatId, refOther, picking, cmp) {
  try {
    const result = await odooCompareWithDelivery(refOther.type, refOther.num, picking, cmp?.id);
    const labelOther = refOther.type.toUpperCase() + refOther.num;
    const rows = result.rows || [];
    const cntOk   = rows.filter(r => r.status === 'ok').length;
    const cntDiff = rows.filter(r => r.status === 'diff').length;
    const cntMis  = rows.filter(r => r.status === 'missing_a' || r.status === 'missing_b').length;

    const viewId = 'C' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();
    const { error: insErr } = await db.from('delivery_views').insert({
      id: viewId,
      title: 'เปรียบเทียบ ' + labelOther + ' vs ใบส่งของ',
      company: cmp?.name || '',
      status_label: cmp?.name || '',
      data: {
        mode: 'delivery',
        otherType: refOther.type, otherNum: refOther.num,
        otherDoc: result.otherDoc,
        picking: {
          name: picking.name,
          origin: picking.origin || '',
          partner: Array.isArray(picking.partner_id) ? picking.partner_id[1] : '',
          scheduled_date: picking.scheduled_date || '',
          state: picking.state || ''
        },
        rows
      }
    });
    if (insErr) { await sendTelegramReply(chatId, '⚠️⚠️⚠️ บันทึกข้อมูลไม่สำเร็จ: ' + insErr.message); return; }

    const webLink = 'https://inventory-rho-hazel.vercel.app/compare.html?id=' + viewId;
    await sendTelegramReply(chatId,
      '📊 เปรียบเทียบ ' + labelOther + ' vs ใบส่งของ "' + (picking.name||'-') + '"' + (cmp?.name ? ' (' + cmp.name + ')' : '') + '\n\n' +
      '✅ ตรงกัน: ' + cntOk + ' รายการ\n' +
      (cntDiff ? '⚠️ ต่างกัน: ' + cntDiff + ' รายการ\n' : '') +
      (cntMis  ? '❌ ขาด: ' + cntMis  + ' รายการ\n' : '') +
      '\n📎 เปิดดูรายละเอียด:\n' + webLink
    );
  } catch (e) {
    await sendTelegramReply(chatId, '⚠️⚠️⚠️ เปรียบเทียบไม่สำเร็จ: ' + e.message);
  }
}

// ── needsWebSearch ────────────────────────────────────────────────────────────
function needsWebSearch(text) {
  const t = text.toLowerCase();
  return ['วันนี้','ตอนนี้','ล่าสุด','ปัจจุบัน','ราคา','หุ้น','ค่าเงิน',
    'สภาพอากาศ','ฝน','น้ำท่วม','รถติด','ข่าว','เหตุการณ์',
    'today','now','latest','current','news','price','weather'].some(k => t.includes(k));
}

// ── searchWeb ─────────────────────────────────────────────────────────────────
async function searchWeb(query) {
  if (!TAVILY_KEY) return null;
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: TAVILY_KEY, query, search_depth: 'basic', max_results: 3, include_answer: true })
    });
    const data = await res.json();
    if (!res.ok) return null;
    let result = '';
    if (data.answer) result += data.answer + '\n\n';
    (data.results || []).slice(0,3).forEach(r => {
      result += `📌 ${r.title}\n${(r.content||'').slice(0,200)}\n🔗 ${r.url}\n\n`;
    });
    return result.trim() || null;
  } catch(e) { return null; }
}

// ── askGroq ───────────────────────────────────────────────────────────────────
async function askGroq(userMessage, history = [], webContext = null) {
  if (!GROQ_KEY) return '❌ ยังไม่ได้ตั้งค่า GROQ_API_KEY ครับ';
  try {
    const finalMessage = webContext
      ? `[ข้อมูลจากเว็บ]\n${webContext}\n\n[คำถาม]\n${userMessage}`
      : userMessage;
    const messages = [
      { role: 'system', content: SYSTEM },
      ...history.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
      { role: 'user', content: finalMessage }
    ];
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: 1024, temperature: 0.7 })
    });
    const data = await res.json();
    if (!res.ok) return '⚠️ ขอโทษครับ มีปัญหาเกิดขึ้น ลองใหม่อีกทีนะครับ';
    return data?.choices?.[0]?.message?.content || '🤔 ไม่มีคำตอบครับ';
  } catch(e) { return '⚠️ เชื่อมต่อไม่ได้ครับ ลองใหม่นะครับ'; }
}

// ── extractMention ────────────────────────────────────────────────────────────
function extractMention(text, botUsername) {
  if (!text) return null;
  const pattern = new RegExp('@' + (botUsername || '[\\w]+') + '\\b', 'i');
  if (!pattern.test(text)) return null;
  return text.replace(new RegExp('@' + (botUsername || '[\\w]+') + '\\b', 'gi'), '').trim();
}

// ── History ───────────────────────────────────────────────────────────────────
const chatHistory = new Map();
function getHistory(chatId) { return chatHistory.get(String(chatId)) || []; }
function addHistory(chatId, role, content) {
  const key = String(chatId);
  const h = chatHistory.get(key) || [];
  h.push({ role, content });
  if (h.length > 10) h.splice(0, h.length - 10);
  chatHistory.set(key, h);
}

// ── Main handler ──────────────────────────────────────────────────────────────
// ── ส่งรายงานใบส่งของเข้า LINE หรือ Telegram กลุ่ม 2 ──────────────────────────
// ── สร้างบล็อกสถานะการรับ/ส่ง (รับครบ / รับไม่ครบ + ยอดค้าง) สำหรับใส่ในรายงาน ──
//   ใช้ HTML parse_mode → <b> ตัวหนา, สีแดงแจ้งเตือนใช้ emoji 🔴 + ตัวหนา
//   status = ผลจาก odooReceiveDeliveryStatus(origin)
function buildReceiveStatusBlock(status) {
  if (!status || !status.found) return '';
  const isPO = status.type === 'po';
  const verb = isPO ? 'รับ' : 'ส่ง';        // PO=รับเข้า, SO=ส่งออก
  const docLabel = isPO ? 'PO' : 'SO';

  // วัตถุประสงค์/หมายเหตุ ที่เขียนไว้ท้าย PO/SO (แสดงทั้งกรณีครบ/ไม่ครบ)
  // ทำทั้งบรรทัดเป็นตัวหนา (Telegram) — LINE จะถูกตัด <b> ออกเป็นข้อความธรรมดา
  const noteLine = status.note
    ? '\n🎯 <b>วัตถุประสงค์: ' + tgEsc(String(status.note)) + '</b>\n'
    : '';

  // เลขที่ PR + ผู้ขอ PR (ให้รู้ว่า PO นี้อ้างอิงจาก PR ไหน ใครขอ) — ตัวหนาทั้งบรรทัด
  const prLine = (status.prName || status.prBy)
    ? '\n📄 <b>PR: ' + tgEsc(status.prName || '-') +
      (status.prBy ? '  •  👤 ผู้ขอ: ' + tgEsc(status.prBy) : '') + '</b>\n'
    : '';

  const headLines = noteLine + prLine;

  if (status.complete) {
    // ครบ → เขียวสบายใจ
    return headLines + '\n✅ <b>' + verb + 'ครบ ' + docLabel +
           (status.docName ? ' (' + status.docName + ')' : '') + '</b> — ครบทุกรายการแล้ว\n';
  }

  // ไม่ครบ → แดงแจ้งเตือนชัดๆ
  let block = headLines + '\n🔴🔴 <b>⚠️ ' + verb + 'สินค้าไม่ครบ!</b> 🔴🔴\n';
  block += '<b>📌 ' + docLabel + (status.docName ? ' ' + status.docName : '') +
           ' ยังค้าง' + verb + 'อีก ' + fmtQty(status.totalRemain) + ' หน่วย</b>\n';
  const rl = status.remainLines || [];
  if (rl.length) {
    block += '<b>รายการที่ค้าง' + verb + ':</b>\n';
    for (const l of rl.slice(0, 5)) {
      const pname = String(l.product || '').replace(/-{2,}/g, ' ').trim().slice(0, 55);
      block += '  🔻 ' + pname + '\n' +
               '       สั่ง ' + fmtQty(l.ordered) + ' • ' + verb + 'แล้ว ' + fmtQty(l.done) +
               ' • <b>ค้าง ' + fmtQty(l.remain) + ' ' + (l.uom || '') + '</b>\n';
    }
    if (rl.length > 5) block += '  ...และอีก ' + (rl.length - 5) + ' รายการ\n';
  }
  block += '<b>‼️ โปรดตรวจสอบว่าคีย์จำนวนถูกต้องหรือไม่</b>\n';
  return block;
}

// แสดงจำนวนสวยๆ (ตัด .0 ถ้าเป็นจำนวนเต็ม)
function fmtQty(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

async function sendReport(fromChatId, picking, target, lineGroups, db) {
  try {
    const { odooDelivery, parseCompany } = await import('./odoo.js');
    const { createClient } = await import('@supabase/supabase-js');

    // ดึงข้อมูลครบจาก picking (มี lines + images)
    const allPicks = await odooDelivery(picking.name || '', null);
    const p = allPicks.find(x => x.id === picking.id) || picking;

    const name = p.name || '-';
    const origin = p.origin || '';
    const lines = (p.lines || []).slice(0, 5);
    const totalLines = (p.lines || []).length;
    const date = String(p.scheduled_date || '').slice(0, 10);
    const images = p.images || [];
    const jobName = Array.isArray(p.group_id) ? p.group_id[1] : '';  // ชื่องาน (Reference/โครงการ)
    const contact = Array.isArray(p.partner_id) ? p.partner_id[1] : '';  // ผู้รับ/ผู้ติดต่อ (Contact)

    // สร้างข้อความรายการ
    let lineItems = lines.map((l, i) => {
      const pname = (Array.isArray(l.product_id) ? l.product_id[1] : l.name || '').replace(/-{2,}/g, ' ').trim();
      const qty = (l.quantity || l.product_uom_qty || 0) + ' ' + (Array.isArray(l.product_uom) ? l.product_uom[1] : '');
      return (i+1) + '. ' + pname.slice(0, 50) + ' — ' + qty;
    }).join('\n');
    if (totalLines > 5) lineItems += '\n... และอีก ' + (totalLines-5) + ' รายการ';

    // สร้าง delivery_views → ได้ลิงก์หน้าเว็บ (พร้อมรูป เหมือน /ส่งของ)
    const SB_URL = process.env.SUPABASE_URL;
    const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const sbdb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

    const stMap = { done: 'ส่งแล้ว', cancel: 'ยกเลิก' };
    const picksData = [{
      name: p.name,
      origin: p.origin || '',
      partner: Array.isArray(p.partner_id) ? p.partner_id[1] : '',
      date: date,
      statusText: stMap[p.state] || 'รอส่ง',
      statusColor: p.state === 'done' ? 'red' : (p.state === 'cancel' ? 'gray' : 'green'),
      lines: (p.lines || []).map(l => ({
        name: Array.isArray(l.product_id) ? l.product_id[1] : '',
        qty: l.quantity || l.product_uom_qty || 0,
        uom: Array.isArray(l.product_uom) ? l.product_uom[1] : ''
      })),
      images: images
    }];
    const viewId = 'D' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();
    await sbdb.from('delivery_views').insert({
      id: viewId,
      title: 'รายงาน — ' + name,
      company: '',
      status_label: 'รายงาน',
      data: { summary: { total: 1, done: p.state==='done'?1:0, pending: p.state!=='done'?1:0 }, picks: picksData }
    });
    const webLink = 'https://inventory-rho-hazel.vercel.app/delivery.html?id=' + viewId;

    // เช็คสถานะรับ/ส่ง จาก origin (กันคีย์จำนวนผิด)
    let statusBlock = '', stVendor = '', stIsPO = true;
    try {
      const { odooReceiveDeliveryStatus } = await import('./odoo.js');
      const st = await odooReceiveDeliveryStatus(origin, p.company_id);
      statusBlock = buildReceiveStatusBlock(st);
      if (st) { stVendor = st.vendor || ''; stIsPO = st.type !== 'so'; }
    } catch (e) { /* เช็คไม่ได้ ข้าม */ }

    const msg =
      '📊 รายงาน: ' + name + '\n' +
      (jobName ? '🏷️ <b>ชื่องาน: ' + tgEsc(jobName) + '</b>\n' : '') +
      (origin ? '📋 โครงการ: ' + origin + '\n' : '') +
      (stVendor ? '🏢 <b>' + (stIsPO ? 'ผู้ขาย' : 'ลูกค้า') + ': ' + tgEsc(stVendor) + '</b>\n' : '') +
      (!stVendor && contact ? '👤 <b>ผู้รับ: ' + tgEsc(contact) + '</b>\n' : '') +
      '📅 วันที่: ' + date + '\n' +
      '📷 รูปงาน: ' + images.length + ' รูป\n\n' +
      '📦 รายการสินค้า' + (totalLines > 5 ? ' (5 จาก ' + totalLines + ')' : '') + ':\n' +
      lineItems + '\n' +
      statusBlock + '\n' +
      '📎 ดูรายละเอียดพร้อมรูป:\n' + webLink + '\n\n' +
      'เรียบร้อยครับ ✅';

    const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

    // เวอร์ชัน plain (ตัด HTML tag) สำหรับ LINE ที่ไม่รองรับ HTML
    const msgPlain = msg.replace(/<\/?b>/g, '');

    if (target === '__self__' || target === 'สั่งของ') {
      // __self__ → ส่งกลับกลุ่มที่พิมพ์คำสั่ง | เทเลแกรม → ส่งเข้า TELEGRAM_CHAT_ID_2
      const destId = target === '__self__' ? String(fromChatId) : (process.env.TELEGRAM_CHAT_ID_2 || '');
      if (!destId) { await sendTelegramReply(fromChatId, '⚠️⚠️⚠️ ไม่พบ TELEGRAM_CHAT_ID_2 ใน env'); return; }
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: destId, text: msg, parse_mode: 'HTML' })
      });
      if (target !== '__self__') {
        await sendTelegramReply(fromChatId, '✅ ส่งรายงานเข้า Telegram เรียบร้อยครับ');
      }
    } else {
      // ส่งเข้า LINE
      const groupId = lineGroups[target];
      if (!groupId) { await sendTelegramReply(fromChatId, '⚠️⚠️⚠️ ไม่พบกลุ่ม LINE "' + target + '"'); return; }
      const LINE_TOKEN = process.env.LINE_CHANNEL_TOKEN || '';
      const lineRes = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_TOKEN },
        body: JSON.stringify({ to: groupId, messages: [{ type: 'text', text: msgPlain }] })
      });
      if (!lineRes.ok) {
        const lineResJson = await lineRes.json();
        await sendTelegramReply(fromChatId, '⚠️⚠️⚠️ ส่ง LINE ไม่สำเร็จ: ' + JSON.stringify(lineResJson));
        return;
      }
      await sendTelegramReply(fromChatId, '✅ ส่งรายงานเข้า LINE กลุ่ม "' + target + '" เรียบร้อยครับ');
    }
  } catch(e) {
    await sendTelegramReply(fromChatId, '⚠️⚠️⚠️ ส่งรายงานไม่สำเร็จ: ' + e.message);
  }
}

// ── ส่งรายงานหลายใบพร้อมกันในข้อความเดียว ────────────────────────────────────
async function sendReportMulti(fromChatId, picks, target, lineGroups, db) {
  try {
    const { odooDelivery } = await import('./odoo.js');
    const { createClient } = await import('@supabase/supabase-js');
    const SB_URL = process.env.SUPABASE_URL;
    const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const sbdb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

    // ดึงข้อมูลครบของแต่ละใบ
    const stMap = { done: 'ส่งแล้ว', cancel: 'ยกเลิก' };
    const picksData = [];
    let totalImages = 0;

    for (const picking of picks) {
      const allPicks = await odooDelivery(picking.name || '', null);
      const p = allPicks.find(x => x.id === picking.id) || picking;
      const images = p.images || [];
      totalImages += images.length;
      // เช็คสถานะรับ/ส่ง จาก origin (กันคีย์จำนวนผิด)
      let recvStatus = null;
      try {
        const { odooReceiveDeliveryStatus } = await import('./odoo.js');
        recvStatus = await odooReceiveDeliveryStatus(p.origin || '', p.company_id);
      } catch (e) { /* ข้าม */ }
      picksData.push({
        name: p.name,
        origin: p.origin || '',
        jobName: Array.isArray(p.group_id) ? p.group_id[1] : '',  // ชื่องาน (Reference/โครงการ)
        partner: Array.isArray(p.partner_id) ? p.partner_id[1] : '',
        date: String(p.scheduled_date || '').slice(0, 10),
        statusText: stMap[p.state] || 'รอส่ง',
        statusColor: p.state === 'done' ? 'red' : (p.state === 'cancel' ? 'gray' : 'green'),
        recvStatus,
        lines: (p.lines || []).map(l => ({
          name: Array.isArray(l.product_id) ? l.product_id[1] : '',
          qty: l.quantity || l.product_uom_qty || 0,
          uom: Array.isArray(l.product_uom) ? l.product_uom[1] : ''
        })),
        images
      });
    }

    // สร้าง delivery_views รวมทุกใบ
    const names = picksData.map(p => p.name).join(', ');
    const viewId = 'M' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();
    const doneCount = picksData.filter(p => p.statusColor === 'red').length;
    await sbdb.from('delivery_views').insert({
      id: viewId,
      title: 'รายงาน — ' + names,
      company: '',
      status_label: 'รายงาน',
      data: {
        summary: { total: picksData.length, done: doneCount, pending: picksData.length - doneCount },
        picks: picksData
      }
    });
    const webLink = 'https://inventory-rho-hazel.vercel.app/delivery.html?id=' + viewId;

    const msg =
      '📊 รายงาน: ' + names + '\n' +
      '📷 รูปงานรวม: ' + totalImages + ' รูป\n\n' +
      picksData.map(p =>
        '📋 ' + p.name + ' — ' + (p.statusText) + '\n' +
        (p.jobName ? '   🏷️ <b>ชื่องาน: ' + tgEsc(p.jobName) + '</b>\n' : '') +
        (p.recvStatus && p.recvStatus.vendor
          ? '   🏢 <b>' + (p.recvStatus.type !== 'so' ? 'ผู้ขาย' : 'ลูกค้า') + ': ' + tgEsc(p.recvStatus.vendor) + '</b>\n'
          : (p.partner ? '   👤 <b>ผู้รับ: ' + tgEsc(p.partner) + '</b>\n' : '')) +
        '   📦 <b>รายการสินค้า (' + p.lines.length + '):</b>\n' +
        (p.lines.length
          ? p.lines.slice(0, 8).map((l, i) => '     ' + (i+1) + '. ' + String(l.name || '').replace(/-{2,}/g, ' ').trim().slice(0, 60) + ' — ' + fmtQty(l.qty) + (l.uom ? ' ' + l.uom : '')).join('\n') +
            (p.lines.length > 8 ? '\n     ...และอีก ' + (p.lines.length - 8) + ' รายการ' : '')
          : '     (ไม่มีรายการ)') +
        buildReceiveStatusBlock(p.recvStatus)
      ).join('\n') + '\n\n' +
      '📎 ดูรายละเอียดพร้อมรูป:\n' + webLink + '\n\nเรียบร้อยครับ ✅';
    const msgPlain = msg.replace(/<\/?b>/g, '');

    const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
    if (target === '__self__' || target === 'สั่งของ') {
      const destId = target === '__self__' ? String(fromChatId) : (process.env.TELEGRAM_CHAT_ID_2 || '');
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: destId, text: msg, parse_mode: 'HTML' })
      });
      if (target !== '__self__') {
        await sendTelegramReply(fromChatId, '✅ ส่งรายงาน ' + picksData.length + ' ใบเข้า Telegram เรียบร้อยครับ');
      }
    } else {
      const groupId = lineGroups[target];
      const LINE_TOKEN = process.env.LINE_CHANNEL_TOKEN || '';
      await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_TOKEN },
        body: JSON.stringify({ to: groupId, messages: [{ type: 'text', text: msgPlain }] })
      });
      await sendTelegramReply(fromChatId, '✅ ส่งรายงาน ' + picksData.length + ' ใบเข้า LINE กลุ่ม "' + target + '" เรียบร้อยครับ');
    }
  } catch(e) {
    await sendTelegramReply(fromChatId, '⚠️⚠️⚠️ ส่งรายงานไม่สำเร็จ: ' + e.message);
  }
}

// ── ส่งรายงาน PO/SO/PR เข้า LINE หรือ Telegram กลุ่ม 2 ──────────────────────
async function sendReportDoc(fromChatId, doc, target, lineGroups) {
  try {
    const { odooDocDetail } = await import('./odoo.js');
    const { createClient } = await import('@supabase/supabase-js');

    const d = await odooDocDetail(doc.model, doc.id);
    if (!d) { await sendTelegramReply(fromChatId, '⚠️⚠️⚠️ ดึงข้อมูลเอกสารไม่สำเร็จ'); return; }

    const lines = (d.lines || []).slice(0, 5);
    const totalLines = (d.lines || []).length;
    const images = d.images || [];

    let lineItems = lines.map((l, i) => {
      const pname = (l.name || '').replace(/-{2,}/g, ' ').trim();
      let s = (i+1) + '. ' + pname.slice(0, 50) + ' — ' + (l.qty || 0) + ' ' + (l.uom || '');
      // แสดงยอดค้างรับถ้ามี (PO)
      if (l.received !== undefined && l.remain > 0) {
        s += ' (รับแล้ว ' + l.received + ' ค้าง ' + l.remain + ')';
      }
      return s;
    }).join('\n');
    if (totalLines > 5) lineItems += '\n... และอีก ' + (totalLines-5) + ' รายการ';

    // สร้าง delivery_views (ใช้โครงสร้างเดียวกับใบส่งของ)
    const SB_URL = process.env.SUPABASE_URL;
    const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const sbdb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

    const picksData = [{
      name: d.name,
      origin: '',
      source: d.origin || '',
      partner: d.partner || '',
      date: d.date || '',
      statusText: d.totalRemain > 0 ? '⚠️ ค้างรับ ' + d.totalRemain : (d.totalOrdered !== undefined ? '✅ รับครบ' : ''),
      statusColor: d.totalRemain > 0 ? 'red' : 'green',
      note: [d.poNote, d.description, d.prPurpose ? 'วัตถุประสงค์: ' + d.prPurpose : ''].filter(Boolean).join('\n') || '',
      lines: (d.lines || []).map(l => ({
        name: l.name, qty: l.qty, uom: l.uom,
        received: l.received, remain: l.remain
      })),
      images: images
    }];
    const viewId = 'D' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();
    await sbdb.from('delivery_views').insert({
      id: viewId,
      title: 'รายงาน — ' + d.name,
      company: '',
      status_label: 'รายงาน',
      data: { summary: { total: 1 }, picks: picksData }
    });
    const webLink = 'https://inventory-rho-hazel.vercel.app/delivery.html?id=' + viewId;

    // เช็คสถานะรับ/ส่ง — กันคีย์จำนวนผิด
    // สำหรับ PO ที่มี totalOrdered/totalRemain คำนวณไว้แล้ว (มาจาก purchase.order.line
    // ของ PO นี้โดยตรง) ให้ใช้ค่านี้ตัดสิน "ครบ/ไม่ครบ" เลย ไม่ต้องเรียก
    // odooReceiveDeliveryStatus ซ้ำอีกรอบ — กันปัญหาไปจับคู่ PO ใบอื่นผิดโดยเด็ดขาด
    // เพราะตัวเลขนี้มาจากแหล่งเดียวกับที่แสดงด้านบนเป๊ะๆ ไม่มีทางขัดแย้งกันได้อีก
    let statusBlock = '';
    if (d.totalOrdered !== undefined) {
      const isPO = true;
      if (d.totalRemain <= 0.0001) {
        statusBlock = '\n✅ <b>รับครบ PO (' + d.name.replace(/^PO\s+/i,'') + ')</b> — ครบทุกรายการแล้ว\n';
      } else {
        statusBlock = '\n🔴🔴 <b>⚠️ รับสินค้าไม่ครบ!</b> 🔴🔴\n' +
          '<b>📌 PO ' + d.name.replace(/^PO\s+/i,'') + ' ยังค้างรับอีก ' + d.totalRemain + ' หน่วย</b>\n';
        const rl = (d.lines || []).filter(l => l.remain > 0.0001).slice(0, 5);
        if (rl.length) {
          statusBlock += '<b>รายการที่ค้างรับ:</b>\n';
          for (const l of rl) {
            const pname = String(l.name || '').replace(/-{2,}/g,' ').trim().slice(0, 55);
            statusBlock += '  🔻 ' + pname + '\n' +
              '       สั่ง ' + l.qty + ' • รับแล้ว ' + l.received + ' • <b>ค้าง ' + l.remain + '</b> ' + (l.uom||'') + '\n';
          }
        }
      }
    } else {
      // ไม่ใช่ PO (เช่น SO/MO) → ใช้วิธีเดิม (ค้นจาก origin)
      try {
        const { odooReceiveDeliveryStatus } = await import('./odoo.js');
        const bareDocName = String(d.name || '').replace(/^(PO|SO|MO)\s+/i, '').trim();
        const st = await odooReceiveDeliveryStatus(bareDocName);
        statusBlock = buildReceiveStatusBlock(st);
      } catch (e) { /* ข้าม */ }
    }

    // วัตถุประสงค์ / เลข PR / ผู้ขอ (ต้นทางก่อนเป็น PO) — ตัวหนาให้ชัด
    const purposeLine = d.prPurpose ? '🎯 <b>วัตถุประสงค์: ' + tgEsc(d.prPurpose) + '</b>\n' : '';
    // รายละเอียด PR (ช่อง Description = "ใช้ในงาน : ...")
    const descLine = d.description ? '📝 <b>' + tgEsc(d.description.slice(0, 350)) + (d.description.length > 350 ? '…' : '') + '</b>\n' : '';
    const prInfoLine = (d.prName || d.prBy)
      ? '📄 <b>PR: ' + tgEsc(d.prName || '-') +
        (d.prBy ? '  •  👤 ผู้ขอ: ' + tgEsc(d.prBy) : '') + '</b>\n'
      : '';
    const msg =
      '📊 รายงาน: ' + d.name + '\n' +
      (d.jobName ? '🏷️ <b>ชื่องาน: ' + tgEsc(d.jobName) + '</b>\n' : '') +
      (d.partner ? (d.partnerLabel || 'คู่ค้า') + ': ' + d.partner + '\n' : '') +
      (d.origin ? '📄 Source: ' + d.origin + '\n' : '') +
      descLine +
      purposeLine +
      prInfoLine +
      '📅 วันที่: ' + (d.date || '-') + '\n' +
      (d.total ? '💰 ยอดรวม: ' + d.total.toLocaleString('th-TH') + ' บาท\n' : '') +
      // ── หมายเหตุ PO ──
      (d.poNote ? '📝 หมายเหตุ: ' + d.poNote.slice(0, 200) + (d.poNote.length > 200 ? '...' : '') + '\n' : '') +
      '📷 รูปงาน: ' + images.length + ' รูป\n\n' +
      '📦 รายการสินค้า' + (totalLines > 5 ? ' (5 จาก ' + totalLines + ')' : '') + ':\n' +
      lineItems + '\n' +
      statusBlock + '\n' +
      '📎 ดูรายละเอียดพร้อมรูป:\n' + webLink + '\n\n' +
      'เรียบร้อยครับ ✅';
    const msgPlain = msg.replace(/<\/?b>/g, '');

    const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
    if (target === '__self__' || target === 'สั่งของ') {
      const destId = target === '__self__' ? String(fromChatId) : (process.env.TELEGRAM_CHAT_ID_2 || '');
      if (!destId) { await sendTelegramReply(fromChatId, '⚠️⚠️⚠️ ไม่พบ TELEGRAM_CHAT_ID_2'); return; }
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: destId, text: msg, parse_mode: 'HTML' })
      });
      if (target !== '__self__') {
        await sendTelegramReply(fromChatId, '✅ ส่งรายงานเข้า Telegram เรียบร้อยครับ');
      }
    } else {
      const groupId = lineGroups[target];
      if (!groupId) { await sendTelegramReply(fromChatId, '⚠️⚠️⚠️ ไม่พบกลุ่ม LINE "' + target + '"'); return; }
      const LINE_TOKEN = process.env.LINE_CHANNEL_TOKEN || '';
      const lineRes = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_TOKEN },
        body: JSON.stringify({ to: groupId, messages: [{ type: 'text', text: msgPlain }] })
      });
      if (!lineRes.ok) {
        const j = await lineRes.json();
        await sendTelegramReply(fromChatId, '⚠️⚠️⚠️ ส่ง LINE ไม่สำเร็จ: ' + JSON.stringify(j));
        return;
      }
      await sendTelegramReply(fromChatId, '✅ ส่งรายงานเข้า LINE กลุ่ม "' + target + '" เรียบร้อยครับ');
    }
  } catch(e) {
    await sendTelegramReply(fromChatId, '⚠️⚠️⚠️ ส่งรายงานไม่สำเร็จ: ' + e.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(200).json({ ok: true }); return; }
  try {
    const update = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    // รับข้อความที่ "แก้ไข" (edited) ด้วย — ฝ่ายจัดซื้อมักพิมพ์แล้วแก้ทีหลัง (เช่น เลื่อนวันส่ง)
    const editedMsg = update.edited_message || update.edited_channel_post || null;
    const msg = update.message || update.channel_post || editedMsg;
    const isEdited = !!editedMsg && !update.message && !update.channel_post;

    // ════════════════════════════════════════════════════════════════════════
    //  กลุ่มฝ่ายจัดซื้อ: จับ "แจ้งส่ง/รับของ" ของ ฝ้าย+เมย์ อัตโนมัติ → บันทึกงาน + แจ้งกลุ่มใหม่
    //  (ทางเลือกที่ 2 — reply @บอท แบบเดิมยังใช้ได้ปกติ)
    // ════════════════════════════════════════════════════════════════════════
    if (msg && String(msg.chat?.id) === String(PURCHASE_GROUP_ID)) {
      try {
        const senderId = msg.from ? String(msg.from.id) : '';
        // เฉพาะ ฝ้าย + เมย์ เท่านั้น — คนอื่นเงียบ
        if (!PURCHASE_SENDER_IDS.includes(senderId)) { res.status(200).json({ ok: true }); return; }
        const pText = msg.text || msg.caption || '';
        const pFrom = msg.from ? ((msg.from.first_name || '') + (msg.from.last_name ? ' ' + msg.from.last_name : '')).trim() : '';
        // ข้อความต้นทางที่ถูก reply (เช่น ฝ้ายรีพายใบสั่ง "ขอเรียกเข้า PO..." แล้วบอกว่าส่งวันไหน)
        //   → บอทต้องไปอ่านต้นทางเอารายละเอียด (PO/สินค้า) มาลงงาน
        const origMsg = msg.reply_to_message || null;
        const origText = origMsg ? (origMsg.text || origMsg.caption || '') : '';
        const combined = origText ? (origText + '\n' + pText) : pText;
        // วันส่ง: ดูข้อความที่พิมพ์ก่อน ("พรุ่งนี้"/"8/7") ไม่มีค่อยดูจากต้นทาง — รองรับคำบอกวันสัมพัทธ์
        const shipDate = resolveShipDate(pText) || (origText ? resolveShipDate(origText) : null);
        const hasMention = PURCHASE_MENTION.test(pText) || PURCHASE_MENTION.test(origText);
        const isShip = PURCHASE_MSG_KEYWORDS.test(combined);
        // ผูกงานไว้กับ "ข้อความต้นทาง" ถ้าเป็นการ reply (reply ครั้งถัดไปจะแก้วันงานเดิมได้)
        const anchorId = origMsg ? origMsg.message_id : msg.message_id;

        // (A) reply ไป "งานเดิม" ที่บอทเคยบันทึกไว้ + มีวันส่ง → แก้วันงานเดิม (ไม่สร้างซ้ำ)
        if (origMsg && shipDate) {
          const upd = await updateTaskDateByMessage(origMsg.message_id, shipDate);
          if (upd.ok) {
            // บอทเงียบในกลุ่มสั่งของเสมอ — แจ้งเฉพาะกลุ่มใหม่
            await notifyMainChat('✏️ <b>แก้ไขวันที่งาน (ฝ่ายจัดซื้อ)</b>\n📋 ' + upd.task.task + '\n📅 เปลี่ยนเป็น ' + upd.dateDisplay + (pFrom ? '\n✍️ โดย: ' + pFrom : ''));
            res.status(200).json({ ok: true }); return;
          }
          // งานเดิมยังไม่มีในระบบ → ไปสร้างใหม่จากข้อความต้นทางข้างล่าง (ถ้าเข้าเงื่อนไขแจ้งส่ง)
        }

        // ข้อความที่ "แก้ไข" (edited) → ใช้เฉพาะจับการเลื่อนวันงานเดิมข้างบน ไม่สร้างงานใหม่ซ้ำ
        if (isEdited) { res.status(200).json({ ok: true }); return; }

        // ดึงไฟล์แนบ (รูป/เอกสาร) — คืน object รูปแบบเดียวกับที่หน้าเว็บอ่าน (webViewLink/fileId)
        const tgToken = process.env.TELEGRAM_BOT_TOKEN || '';
        const msgHasFile = !!(msg.photo || msg.document);
        const fetchAttach = async (m) => {
          if (!m || !tgToken || !db) return null;
          try {
            let fileUrl = null, fileName = null;
            if (m.photo && m.photo.length) {
              const photo = m.photo[m.photo.length - 1];
              const i = await (await fetch(`https://api.telegram.org/bot${tgToken}/getFile?file_id=${photo.file_id}`)).json();
              if (i.ok) { fileUrl = `https://api.telegram.org/file/bot${tgToken}/${i.result.file_path}`; fileName = i.result.file_path.split('/').pop(); }
            } else if (m.document) {
              const i = await (await fetch(`https://api.telegram.org/bot${tgToken}/getFile?file_id=${m.document.file_id}`)).json();
              if (i.ok) { fileUrl = `https://api.telegram.org/file/bot${tgToken}/${i.result.file_path}`; fileName = m.document.file_name || i.result.file_path.split('/').pop(); }
            }
            if (!fileUrl) return null;
            const buffer = Buffer.from(await (await fetch(fileUrl)).arrayBuffer());
            const mime = (m.document && m.document.mime_type) || (m.photo ? 'image/jpeg' : 'application/octet-stream');
            const ext = fileName && fileName.includes('.') ? fileName.split('.').pop() : (m.photo ? 'jpg' : 'bin');
            const storageName = 'tg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.' + ext;
            const { error: upErr } = await db.storage.from('attachments').upload(storageName, buffer, { contentType: mime, upsert: false });
            if (upErr) return null;
            const { data: u } = db.storage.from('attachments').getPublicUrl(storageName);
            const url = u?.publicUrl || '';
            // ต้องมี webViewLink/fileId/mimeType/size ให้หน้าเว็บแสดงไฟล์ได้ (wl ไว้ให้ notifyMainChat)
            return { name: fileName || storageName, size: buffer.length, fileId: storageName, mimeType: mime, webViewLink: url, wl: url, source: 'telegram' };
          } catch (e) { return null; }
        };

        // ── ตัวช่วย: อ่านไฟล์ในข้อความเป็น "ตารางหลาย PO" (คืน [] ถ้าไม่ใช่ตาราง) ──
        const chatKey = String(msg.chat.id);
        const parseTableFromTgMsg = async (m) => {
          if (!m || !(m.photo || m.document) || !tgToken) return [];
          const f = await tgFetchFile(m, tgToken);
          if (!f) return [];
          return await tableGroupsFromBuffer(f.buffer, f.mime, f.fileName, { groqKey: GROQ_KEY, visionModel: GROQ_VISION_MODEL, textModel: GROQ_MODEL });
        };
        const mimeFromPath = (p) => {
          const ext = (String(p).split('.').pop() || '').toLowerCase();
          if (ext === 'pdf') return 'application/pdf';
          if (ext === 'xlsx' || ext === 'xls') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
          if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
          return 'application/octet-stream';
        };
        const parseTableFromStorage = async (storagePath) => {
          try {
            const { data: u } = db.storage.from('attachments').getPublicUrl(storagePath);
            if (!u?.publicUrl) return [];
            const buffer = Buffer.from(await (await fetch(u.publicUrl)).arrayBuffer());
            return await tableGroupsFromBuffer(buffer, mimeFromPath(storagePath), storagePath, { groqKey: GROQ_KEY, visionModel: GROQ_VISION_MODEL, textModel: GROQ_MODEL });
          } catch (e) { return []; }
        };
        const notifyTableCreated = async (created) => {
          if (!created.length) return;
          await notifyMainChat('🔔 <b>รับเข้าหลายรายการ (ฝ่ายจัดซื้อ)</b>\n' +
            created.map(c => '• PO ' + c.po + ' — ส่ง ' + c.date + ' — ' + c.count + ' รายการ').join('\n') +
            (pFrom ? '\n✍️ แจ้งโดย: ' + tgEsc(pFrom) : ''));
        };

        // (B) แจ้งส่งใหม่ — ต้องเป็นประโยคแจ้งส่ง + มีแท็กผู้รับแจ้ง (กันคุยเล่น)
        if (!(isShip && hasMention)) {
          // ฝ่ายจัดซื้อมักพิมพ์ "แจ้งส่ง" ก่อน แล้วส่ง "ไฟล์" เป็นข้อความถัดมา (คนละ message)
          //   → ไฟล์ที่ตามมาเดี่ยวๆ ให้แนบเข้า "งานล่าสุด" ของกลุ่มนี้ (ภายใน 1 นาที) เงียบๆ
          //   ปกติส่งพร้อมกัน แค่มาก่อน/หลังเท่านั้น → ใช้หน้าต่างสั้นๆ กันแนบผิดงาน
          if (msgHasFile && db) {
            try {
              // ★ ไฟล์ "ตารางหลาย PO/หลายวันส่ง" → แยกลง web หลายบรรทัด (1 กลุ่ม = 1 งาน)
              const groups = await parseTableFromTgMsg(msg);
              if (groups.length) {
                const att = await fetchAttach(msg);
                const attach = att ? { name: att.name, size: att.size, fileId: att.fileId, mimeType: att.mimeType, webViewLink: att.webViewLink, source: 'telegram' } : null;
                // ตารางมัก "ตามหลัง" ข้อความแจ้งส่งที่เพิ่งสร้างงานรวมไว้ → ลบงานรวมนั้น แล้วแทนด้วยรายการแยก
                const { data: last } = await db.from('tg_last_task')
                  .select('task_id, created_at').eq('chat_id', chatKey).maybeSingle();
                const ageMin = last?.created_at ? (Date.now() - new Date(last.created_at).getTime()) / 60000 : 999;
                if (last?.task_id && ageMin <= 2) {
                  await db.from('tasks').delete().eq('id', last.task_id);
                  await db.from('tg_last_task').delete().eq('chat_id', chatKey);
                }
                const created = await createPOTableTasks(groups, { attachment: attach });
                await notifyTableCreated(created);
                // ปักธง :tbl → ถ้าข้อความแจ้งส่งตามมาทีหลัง (ไฟล์มาก่อน) จะได้ไม่สร้างงานรวมซ้ำ
                await db.from('tg_last_task').upsert({ chat_id: chatKey + ':tbl', task_id: 'x', task_name: 'table', created_at: new Date().toISOString() }, { onConflict: 'chat_id' });
                res.status(200).json({ ok: true }); return;
              }
              // ไม่ใช่ตาราง → ไฟล์แนบเดี่ยว: แนบเข้างานล่าสุด / พักไว้ (เหมือนเดิม)
              const { data: last } = await db.from('tg_last_task')
                .select('task_id, task_name, created_at').eq('chat_id', chatKey).maybeSingle();
              const ageMin = last?.created_at ? (Date.now() - new Date(last.created_at).getTime()) / 60000 : 999;
              const att = await fetchAttach(msg);
              if (last && last.task_id && ageMin <= 1 && att) {
                // ไฟล์ "มาหลัง" ข้อความแจ้งส่ง (งานเพิ่งสร้าง ≤1 นาที) → แนบเข้างานนั้นเลย
                const { data: taskRow } = await db.from('tasks').select('attachments').eq('id', last.task_id).maybeSingle();
                const atts = Array.isArray(taskRow?.attachments) ? taskRow.attachments : [];
                atts.push({ name: att.name, size: att.size, fileId: att.fileId, mimeType: att.mimeType, webViewLink: att.webViewLink, source: 'telegram' });
                await db.from('tasks').update({ attachments: atts }).eq('id', last.task_id);
              } else if (att) {
                // ไฟล์ "มาก่อน" ข้อความแจ้งส่ง → พักไว้ (key :pf) ให้ข้อความที่ตามมาใน 1 นาทีหยิบไปแนบ
                await db.from('tg_last_task').upsert({
                  chat_id: chatKey + ':pf', task_id: att.fileId,
                  task_name: (att.name || '').slice(0, 100), created_at: new Date().toISOString()
                }, { onConflict: 'chat_id' });
              }
            } catch (e) { console.error('purchase follow-file:', e.message); }
          }
          res.status(200).json({ ok: true }); return; // เงียบเสมอในกลุ่มสั่งของ
        }

        // ── (C) แจ้งส่ง+แท็ก → ถ้ามี "ไฟล์ตารางหลาย PO" ให้แยกลง web หลายบรรทัด (แทนงานรวม) ──
        try {
          // ไฟล์มาก่อนข้อความ + ลงตารางแยกไว้แล้ว (ปักธง :tbl) → ไม่ต้องสร้างงานรวมซ้ำ
          const tblKey = chatKey + ':tbl';
          const { data: tbl } = await db.from('tg_last_task').select('created_at').eq('chat_id', tblKey).maybeSingle();
          const tblAge = tbl?.created_at ? (Date.now() - new Date(tbl.created_at).getTime()) / 60000 : 999;
          if (tblAge <= 2) { await db.from('tg_last_task').delete().eq('chat_id', tblKey); res.status(200).json({ ok: true }); return; }

          let groups = [], gAttach = null;
          if (msgHasFile) {                                  // ไฟล์อยู่ในข้อความแจ้งส่งเดียวกัน
            groups = await parseTableFromTgMsg(msg);
            if (groups.length) { const a = await fetchAttach(msg); gAttach = a ? { name: a.name, size: a.size, fileId: a.fileId, mimeType: a.mimeType, webViewLink: a.webViewLink, source: 'telegram' } : null; }
          }
          if (!groups.length) {                              // ไฟล์ "มาก่อน" ข้อความ (พักไว้ :pf) → ลองอ่านเป็นตาราง
            const pfKey = chatKey + ':pf';
            const { data: pf } = await db.from('tg_last_task').select('task_id, created_at').eq('chat_id', pfKey).maybeSingle();
            const pAge = pf?.created_at ? (Date.now() - new Date(pf.created_at).getTime()) / 60000 : 999;
            if (pf?.task_id && pAge <= 1) {
              groups = await parseTableFromStorage(pf.task_id);
              if (groups.length) {
                const { data: u } = db.storage.from('attachments').getPublicUrl(pf.task_id);
                gAttach = { name: pf.task_id, fileId: pf.task_id, mimeType: mimeFromPath(pf.task_id), webViewLink: u?.publicUrl || '', source: 'telegram' };
                await db.from('tg_last_task').delete().eq('chat_id', pfKey);
              }
            }
          }
          if (groups.length) {
            const created = await createPOTableTasks(groups, { attachment: gAttach });
            await notifyTableCreated(created);
            res.status(200).json({ ok: true }); return;
          }
        } catch (e) { console.error('purchase table:', e.message); }

        // เนื้อหางาน = ข้อความต้นทาง (มีเลข PO/รายการสินค้า) ถ้ามีรายละเอียด ไม่งั้นใช้ข้อความที่พิมพ์
        const origHasDetail = origText && /(P[OR]\s?\d|จำนวน|รายการ|ท่อ|แพค|ขวด|กล่อง|ชุด|ออกซิเจน|คาร์บอน|EA|เมตร|เหล็ก)/i.test(origText);
        const taskContent = origHasDetail ? combined : pText;

        // ไฟล์แนบ — จากข้อความนี้ก่อน ไม่มีค่อยดูข้อความต้นทาง
        const attachmentObj = (await fetchAttach(msg)) || (await fetchAttach(origMsg));

        // บันทึกงาน (ผูกกับข้อความต้นทาง → reply แก้วันทีหลังได้) — งาน "รับ", วันส่งที่คิดแล้ว
        const result = await saveTaskFromReply(taskContent, pFrom, msg.chat.id, attachmentObj, '', anchorId, 'รับ', shipDate);
        if (result.ok) {
          // จำงานล่าสุดของกลุ่มนี้ → ไฟล์ที่ฝ่ายจัดซื้อส่งตามมาจะแนบเข้างานนี้ได้
          try {
            await db.from('tg_last_task').upsert({
              chat_id: String(msg.chat.id), task_id: result.taskId,
              task_name: result.taskName, created_at: new Date().toISOString()
            }, { onConflict: 'chat_id' });
          } catch (e) {}
          // ไฟล์ที่ "มาก่อน" ข้อความ (พักไว้ key :pf ≤1 นาที) → แนบเข้างานที่เพิ่งสร้าง
          if (!attachmentObj) {
            try {
              const pfKey = String(msg.chat.id) + ':pf';
              const { data: pf } = await db.from('tg_last_task')
                .select('task_id, task_name, created_at').eq('chat_id', pfKey).maybeSingle();
              const pAge = pf?.created_at ? (Date.now() - new Date(pf.created_at).getTime()) / 60000 : 999;
              if (pf?.task_id && pAge <= 1) {
                const storagePath = pf.task_id;
                const { data: u } = db.storage.from('attachments').getPublicUrl(storagePath);
                const ext = (storagePath.split('.').pop() || '').toLowerCase();
                const mime = ext === 'pdf' ? 'application/pdf'
                  : (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) ? 'image/' + (ext === 'jpg' ? 'jpeg' : ext) : 'application/octet-stream');
                const { data: tr } = await db.from('tasks').select('attachments').eq('id', result.taskId).maybeSingle();
                const atts = Array.isArray(tr?.attachments) ? tr.attachments : [];
                atts.push({ name: pf.task_name || storagePath, fileId: storagePath, mimeType: mime, webViewLink: u?.publicUrl || '', source: 'telegram' });
                await db.from('tasks').update({ attachments: atts }).eq('id', result.taskId);
                await db.from('tg_last_task').delete().eq('chat_id', pfKey);
              }
            } catch (e) {}
          }
          const fileLink = attachmentObj ? '\n📎 <a href="' + attachmentObj.wl + '">' + attachmentObj.name + '</a>' : '';
          await notifyMainChat(result.mainMsg + fileLink);   // → กลุ่มใหม่ (TELEGRAM_CHAT_ID_3) เท่านั้น
          // ไม่ตอบในกลุ่มสั่งของ — เงียบสนิท
        } else {
          console.error('purchase saveTask failed:', result.error);
        }
      } catch (e) { console.error('purchase capture error:', e.message); }
      res.status(200).json({ ok: true }); return;
    }

    // ข้อความที่ถูกแก้ไข (edited) นอกกลุ่มสั่งของ → ไม่ประมวลผลต่อ (กันคำสั่ง/งานเด้งซ้ำ)
    if (isEdited) { res.status(200).json({ ok: true }); return; }

    // ════════════════════════════════════════════════════════════════════════
    //  ระบบเบิกของ: ข้อความ/รูปจากกลุ่มเบิกของ → แจ้งเข้า chat 1 (บอทเงียบ)
    // ════════════════════════════════════════════════════════════════════════
    if (msg && String(msg.chat?.id) === String(WITHDRAW_GROUP_ID)) {
      const TG_TOK = process.env.TELEGRAM_BOT_TOKEN || '';
      const CHAT1 = process.env.TELEGRAM_CHAT_ID || '';
      const wText = (msg.text || msg.caption || '').trim();
      const wHasPhoto = !!(msg.photo || (msg.document && /^image\//.test(msg.document?.mime_type || '')));
      const wHasMention = /@/.test(wText);
      const wHasBerk = /เบิก/.test(wText);

      // เงื่อนไข "เบิกของจริง" → มีรูป / มีคำว่าเบิก / มี @แท็ก
      // และต้องไม่ใช่คำทักทายล้วนๆ
      const isGreetingOnly = wText && WITHDRAW_GREETING_ONLY.test(wText) && !wHasBerk && !wHasMention;
      const isWithdraw = (wHasPhoto || wHasBerk || wHasMention) && !isGreetingOnly;

      if (isWithdraw && TG_TOK && CHAT1) {
        try {
          // หัวข้อแจ้งเตือน
          const sender = msg.from
            ? ((msg.from.first_name || '') + (msg.from.last_name ? ' ' + msg.from.last_name : '')).trim()
            : '';
          const header = '📦 <b>มีแผนกอื่นเบิกของครับ</b>' + (sender ? '\n👤 จาก: ' + tgEsc(sender) : '');

          // ส่งหัวข้อก่อน (เพื่อให้ลูกน้อง reply อันนี้ตอนเสร็จ)
          // แล้ว copyMessage ตัวจริง (รูป/ข้อความ) ตามไป — ผูก source ไว้ใน DB
          const headRes = await fetch(`https://api.telegram.org/bot${TG_TOK}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: CHAT1, text: header, parse_mode: 'HTML' })
          });
          const headJson = await headRes.json();
          const headMsgId = headJson.ok ? headJson.result.message_id : null;

          // copyMessage: ส่งสำเนารูป/ข้อความเดิมเข้า chat 1 (ไม่โชว์ว่า forwarded)
          const copyRes = await fetch(`https://api.telegram.org/bot${TG_TOK}/copyMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: CHAT1,
              from_chat_id: msg.chat.id,
              message_id: msg.message_id
            })
          });
          const copyJson = await copyRes.json();
          const copyMsgId = copyJson.ok ? copyJson.result.message_id : null;

          // ผูกข้อมูลไว้ใน DB: เมื่อ reply ที่ header หรือ copy ใน chat1 → รู้ว่าต้องตอบกลับกลุ่มเบิกของ + ตัวไหน
          if (db && (headMsgId || copyMsgId)) {
            const recId = 'wd_' + Date.now() + '_' + Math.random().toString(36).substr(2,5);
            await db.from('delivery_views').upsert({
              id: recId,
              title: 'withdraw',
              status_label: 'system',
              data: {
                type: 'withdraw_request',
                srcChatId: String(msg.chat.id),       // กลุ่มเบิกของ
                srcMessageId: msg.message_id,          // ข้อความ/รูปต้นฉบับในกลุ่มเบิกของ
                chat1HeaderId: headMsgId,              // id หัวข้อใน chat1 (ให้ reply)
                chat1CopyId: copyMsgId,                // id สำเนาใน chat1 (ให้ reply ได้เหมือนกัน)
                sender,
                createdAt: new Date().toISOString()
              }
            });
          }
        } catch (e) { /* เงียบ ไม่ตอบกลุ่มเบิกของ */ }
      }
      // บอทเงียบในกลุ่มเบิกของเสมอ — จบเลย ไม่ทำ logic อื่น
      res.status(200).json({ ok: true }); return;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Chat 4: กลุ่ม SET (สโตร์) — รูป/PDF/ข้อความสินค้าเข้าคลัง → แจ้ง chat 1
    //  บอทเงียบสนิท ไม่ตอบใคร ดึงเฉพาะที่เกี่ยวกับสินค้า/คลัง
    // ════════════════════════════════════════════════════════════════════════
    if (msg && String(msg.chat?.id) === String(STORE_GROUP_ID)) {
      const TG_TOK = process.env.TELEGRAM_BOT_TOKEN || '';
      const CHAT1  = process.env.TELEGRAM_CHAT_ID || '';
      const sText  = (msg.text || msg.caption || '').trim();
      const sHasPhoto = !!(msg.photo);
      const sHasFile  = !!(msg.document);
      const sHasMedia = sHasPhoto || sHasFile;
      const sHasCaption = !!(msg.caption && msg.caption.trim());
      const senderId = msg.from ? String(msg.from.id) : '';
      const sender = msg.from
        ? ((msg.from.first_name || '') + (msg.from.last_name ? ' ' + msg.from.last_name : '')).trim()
        : '';

      const isGreeting = sText && STORE_GREETING_ONLY.test(sText);
      const isStoreText = sText && !isGreeting && STORE_MSG_KEYWORDS.test(sText);

      // ส่งเข้า chat 1 (หัวข้อ + สำเนา)
      const sendToChat1 = async (fromChatId, messageId, who) => {
        await fetch(`https://api.telegram.org/bot${TG_TOK}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: CHAT1,
            text: '\u{1F3ED} <b>แจ้งสินค้าส่งขึ้นคลัง</b>' + (who ? '\n\u{1F464} จาก: ' + tgEsc(who) : ''),
            parse_mode: 'HTML'
          })
        });
        await fetch(`https://api.telegram.org/bot${TG_TOK}/copyMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: CHAT1, from_chat_id: fromChatId, message_id: messageId })
        });
      };

      if (TG_TOK && CHAT1) {
        const mgid = msg.media_group_id ? String(msg.media_group_id) : '';
        // ส่งสำเนา 1 รูป/ไฟล์ เข้า chat 1 (ไม่มีหัวข้อ)
        const copyOne = (fromChatId, messageId) => fetch(`https://api.telegram.org/bot${TG_TOK}/copyMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: CHAT1, from_chat_id: fromChatId, message_id: messageId })
        });
        try {
          // ════ อัลบั้ม: หลายรูปส่งพร้อมกัน (แชร์ media_group_id) — ส่งให้ครบทุกรูป ════
          if (mgid && sHasMedia && db) {
            const albActiveId = 'alba_' + mgid;
            if (sHasCaption && isStoreText) {
              // รูปหัวอัลบั้ม (มี caption เกี่ยวคลัง) → ส่งหัวข้อ + รูปนี้ แล้วทำเครื่องหมายว่าอัลบั้มนี้ "ส่งแล้ว"
              await sendToChat1(msg.chat.id, msg.message_id, sender);
              await db.from('delivery_views').upsert({
                id: albActiveId, title: 'store_album_active', status_label: 'system',
                data: { mgid, sender, createdAt: Date.now() }
              });
              // ส่งรูปพี่น้องในอัลบั้มเดียวกันที่มาถึงก่อนหน้า (ค้างรออยู่) ให้ครบ
              const { data: pend } = await db.from('delivery_views')
                .select('*').eq('title', 'store_album_pending').order('id', { ascending: true }).limit(30);
              for (const r of (pend || [])) {
                if ((r.data || {}).mgid === mgid) {
                  await copyOne(r.data.srcChatId, r.data.srcMessageId);
                  await db.from('delivery_views').delete().eq('id', r.id);
                }
              }
            } else if (!sHasCaption) {
              // รูปในอัลบั้มที่ไม่มี caption → ถ้าอัลบั้มถูกส่งแล้วก็ส่งตามทันที, ถ้ายังไม่ส่ง เก็บรอหัวอัลบั้ม
              let active = null;
              try { const { data } = await db.from('delivery_views').select('id').eq('id', albActiveId).maybeSingle(); active = data; } catch (e) {}
              if (active) {
                await copyOne(msg.chat.id, msg.message_id);
              } else {
                const recId = 'stalb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
                await db.from('delivery_views').upsert({
                  id: recId, title: 'store_album_pending', status_label: 'system',
                  data: { mgid, srcChatId: String(msg.chat.id), srcMessageId: msg.message_id, senderId, sender, createdAt: Date.now() }
                });
              }
            }
            // (อัลบั้มที่ caption ไม่ใช่ข้อความคลัง → ไม่ส่ง)
          }
          // ════ ข้อความเดี่ยว (ไม่ใช่อัลบั้ม) — ตรรกะเดิม ════
          else {
            // กรณี 1: รูป/ไฟล์ + caption เกี่ยวคลัง → ส่งทันที
            if (sHasMedia && sHasCaption && isStoreText) {
              await sendToChat1(msg.chat.id, msg.message_id, sender);
            }
            // กรณี 2: รูป/ไฟล์ลอยๆ (ไม่มี caption) → เก็บรอข้อความคลังตามมา
            else if (sHasMedia && !sHasCaption && db) {
              const recId = 'st_' + Date.now() + '_' + Math.random().toString(36).substr(2,5);
              await db.from('delivery_views').upsert({
                id: recId, title: 'store_pending', status_label: 'system',
                data: { srcChatId: String(msg.chat.id), srcMessageId: msg.message_id,
                        senderId, sender, createdAt: Date.now() }
              });
            }
            // กรณี 3: ข้อความเกี่ยวคลัง → เช็ครูปค้างจากคนเดียวกัน
            else if (isStoreText && db) {
              const { data: rows } = await db.from('delivery_views')
                .select('*').eq('title', 'store_pending').order('id', { ascending: false }).limit(30);
              const now = Date.now();
              const pending = (rows || []).find(r => {
                const d = r.data || {};
                return d.senderId === senderId && (now - (d.createdAt || 0)) < 5 * 60 * 1000;
              });
              if (pending) {
                await sendToChat1(pending.data.srcChatId, pending.data.srcMessageId, sender);
                await copyOne(msg.chat.id, msg.message_id);
                await db.from('delivery_views').delete().eq('id', pending.id);
              } else {
                await sendToChat1(msg.chat.id, msg.message_id, sender);
              }
            }
          }
          // กรณีอื่น (รูปไม่มีข้อความคลัง, ข้อความทั่วไป) → ไม่ส่ง
        } catch (e) { /* เงียบ */ }
      }
      // บอทเงียบในกลุ่มสโตร์เสมอ — จบเลย
      res.status(200).json({ ok: true }); return;
    }

    // ── session "รับคืนหน้างาน": รับทั้งรูปและข้อความ สะสมใน delivery_views ──
    if (msg && db) {
      const rkChatId = msg.chat && msg.chat.id;
      const isPhoto = msg.photo || (msg.document && /^image\//.test(msg.document?.mime_type || ''));
      const textOnly = (msg.text || '').trim();
      const captionTxt = (msg.caption || '').trim();
      const looksLikeCmd = textOnly.startsWith('/');
      if (rkChatId && (isPhoto || (textOnly && !looksLikeCmd))) {
        const { data: rkSess } = await db.from('tg_report_session')
          .select('*').eq('chat_id', String(rkChatId)).maybeSingle();
        const rkAge = rkSess ? (Date.now() - new Date(rkSess.updated_at).getTime()) / 60000 : 999;
        // session รับคืน: mode='rabkuen', doc_name = id ของ draft ใน delivery_views
        if (rkSess && rkSess.mode === 'rabkuen' && rkAge < 30) {
          const draftId = rkSess.doc_name;
          const tgTok = process.env.TELEGRAM_BOT_TOKEN || '';
          try {
            // อ่าน draft ปัจจุบัน
            const { data: draft } = await db.from('delivery_views').select('*').eq('id', draftId).maybeSingle();
            if (draft) {
              const d = draft.data || {};
              const images = Array.isArray(d.images) ? d.images : [];
              let notes = Array.isArray(d.notes) ? d.notes : [];

              const addText = captionTxt || (isPhoto ? '' : textOnly);
              if (addText) notes.push(addText);

              if (isPhoto && tgTok) {
                let fileIdR, mimeR;
                if (msg.photo && msg.photo.length > 0) {
                  const ph = msg.photo[msg.photo.length - 1];
                  fileIdR = ph.file_id; mimeR = 'image/jpeg';
                } else if (msg.document) {
                  fileIdR = msg.document.file_id; mimeR = msg.document.mime_type || 'image/jpeg';
                }
                if (fileIdR) {
                  const infoR = await fetch(`https://api.telegram.org/bot${tgTok}/getFile?file_id=${fileIdR}`);
                  const info = await infoR.json();
                  if (info.ok) {
                    const fileUrl = `https://api.telegram.org/file/bot${tgTok}/${info.result.file_path}`;
                    const fileR = await fetch(fileUrl);
                    const rawBuf = Buffer.from(await fileR.arrayBuffer());
                    const { buffer: compBuf, contentType: compMime } = await compressIfImage(rawBuf, mimeR);
                    const ext = compMime === 'image/jpeg' ? 'jpg' : (info.result.file_path.split('.').pop() || 'jpg');
                    const safeId = String(rkChatId).replace(/[^0-9-]/g, '');
                    const storagePath = 'rabkuen/' + safeId + '/' + Date.now() + '_' + Math.random().toString(36).substr(2,4) + '.' + ext;
                    const { error: upErr } = await db.storage.from('attachments')
                      .upload(storagePath, compBuf, { contentType: compMime, upsert: true });
                    if (!upErr) {
                      const { data: pub } = db.storage.from('attachments').getPublicUrl(storagePath);
                      images.push({ url: pub.publicUrl, path: storagePath });
                    }
                  }
                }
              }

              // อัปเดต draft ใน delivery_views
              d.images = images;
              d.notes = notes;
              await db.from('delivery_views').update({ data: d }).eq('id', draftId);
              // touch session กัน timeout
              await db.from('tg_report_session').update({ updated_at: new Date().toISOString() }).eq('chat_id', String(rkChatId));
            }
          } catch(e) { /* เงียบ ไม่ตอบทุกครั้ง */ }
          res.status(200).json({ ok: true }); return;
        }
      }
    }

    // ── ถ้าเป็นรูป → เช็ค session รายงาน → อัปเข้า Odoo อัตโนมัติ ────────────
    if (msg && (msg.photo || (msg.document && /^image\//.test(msg.document?.mime_type || '')))) {
      const photoChatId = msg.chat && msg.chat.id;
      if (photoChatId && db) {
        const { data: sess } = await db.from('tg_report_session')
          .select('*').eq('chat_id', String(photoChatId)).maybeSingle();
        // session ต้องไม่เกิน 10 นาที + ต้องไม่ใช่ session รับคืน (จัดการไปแล้วข้างบน)
        const sessionAge = sess ? (Date.now() - new Date(sess.updated_at).getTime()) / 60000 : 999;
        const isRabkuen = sess && sess.mode === 'rabkuen';
        if (sess && !isRabkuen && sessionAge < 10) {
          const tgTok = process.env.TELEGRAM_BOT_TOKEN || '';
          try {
            let fileId2, mime2;
            if (msg.photo && msg.photo.length > 0) {
              const ph = msg.photo[msg.photo.length - 1];
              fileId2 = ph.file_id; mime2 = 'image/jpeg';
            } else if (msg.document) {
              fileId2 = msg.document.file_id; mime2 = msg.document.mime_type || 'image/jpeg';
            }
            if (fileId2 && tgTok) {
              const infoR = await fetch(`https://api.telegram.org/bot${tgTok}/getFile?file_id=${fileId2}`);
              const info = await infoR.json();
              if (info.ok) {
                const fileUrl = `https://api.telegram.org/file/bot${tgTok}/${info.result.file_path}`;
                const fileR = await fetch(fileUrl);
                const rawBuf = Buffer.from(await fileR.arrayBuffer());
                const { buffer: compBuf, contentType: compMime } = await compressIfImage(rawBuf, mime2);
                const fname = info.result.file_path.split('/').pop();
                await odooUploadAttachment(sess.doc_model, sess.doc_id, compBuf, compMime, fname);
                // อัปเดต counter
                await db.from('tg_report_session').update({
                  uploaded: (sess.uploaded || 0) + 1,
                  updated_at: new Date().toISOString()
                }).eq('chat_id', String(photoChatId));
              }
            }
          } catch(e) { /* เงียบ ไม่ตอบกลับทุกรูป */ }
          res.status(200).json({ ok: true }); return;
        }
      }
    }

    // ── รับไฟล์ Excel สำหรับ /นำเข้าใบส่งของ ─────────────────────────────────
    if (msg && msg.document && db) {
      const mime = msg.document.mime_type || '';
      const fname = msg.document.file_name || '';
      const isExcel = /xlsx|spreadsheet/i.test(mime) || /\.xlsx$/i.test(fname);
      if (isExcel && isAllowedChat(msg.chat && msg.chat.id)) {
        const xlsChatId = msg.chat.id;
        // ดู session ว่ามี pending import ไว้ไหม
        const { data: xlsSess } = await db.from('tg_report_session')
          .select('*').eq('chat_id', String(xlsChatId)).maybeSingle();
        const xlsAge = xlsSess ? (Date.now() - new Date(xlsSess.updated_at).getTime()) / 60000 : 999;
        if (xlsSess && xlsSess.mode === 'import_delivery' && xlsAge < 15) {
          // ส่งข้อความยืนยันทันทีก่อน — กัน Telegram retry (timeout 5 วินาที)
          await sendTelegramReply(xlsChatId, '⏳ รับไฟล์แล้ว กำลังประมวลผล...');
          try {
            const tgTok = process.env.TELEGRAM_BOT_TOKEN || '';
            const infoR = await fetch(`https://api.telegram.org/bot${tgTok}/getFile?file_id=${msg.document.file_id}`);
            const info = await infoR.json();
            if (!info.ok) throw new Error('ดาวน์โหลดไฟล์ไม่ได้');
            const fileUrl = `https://api.telegram.org/file/bot${tgTok}/${info.result.file_path}`;
            const fileR = await fetch(fileUrl);
            const xlsBuf = Buffer.from(await fileR.arrayBuffer());

            // อ่าน Excel ด้วย dynamic import (xlsx bundled ใน node_modules)
            const XLSX = await import('xlsx');
            const wb = XLSX.read(xlsBuf, { type: 'buffer' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

            // โครงสร้าง Excel: col A=ลำดับ, B=รหัสสินค้า, C=ชื่อสินค้า, F=จำนวน
            const lines = [];
            for (let ri = 0; ri < rows.length; ri++) {
              const row = rows[ri];
              let code = row[1] ? String(row[1]).trim() : '';
              const name = row[2] ? String(row[2]).trim() : '';
              const qty  = row[5];
              // รหัสต้องเป็นรูปแบบรหัสจริง (XX-XXX-...) ไม่งั้นถือว่าไม่มีรหัส
              if (code && !/^[A-Z0-9]{2,}-[A-Z0-9\-]{5,}/.test(code)) code = '';
              // รับแถวที่มี "รหัส หรือ ชื่อ" อย่างน้อยอย่างใดอย่างหนึ่ง + มีจำนวน
              if (!code && !name) continue;
              const qtyNum = parseFloat(String(qty || '0').replace(/[^0-9.]/g, '')) || 0;
              if (qtyNum <= 0) continue;
              lines.push({ productCode: code, productName: name.slice(0, 120), qty: qtyNum });
            }

            if (!lines.length) {
              await sendTelegramReply(xlsChatId, '⚠️ ไม่พบรายการสินค้าในไฟล์ Excel ครับ\nต้องมีรหัสสินค้า (เช่น 08RO-127-...) หรือชื่อสินค้า พร้อมจำนวน');
              res.status(200).json({ ok: true }); return;
            }

            await sendTelegramReply(xlsChatId, '⏳ พบ ' + lines.length + ' รายการ กำลังสร้าง picking ใน Odoo...');

            const { odooCreatePickingFromLines: createPicking } = await import('./odoo.js');
            const sourceDoc = xlsSess.doc_name || '';
            const { pickingId, matchedCode, matchedName, notFound } = await createPicking(
              xlsSess.doc_id,        // picking_type_id
              lines,
              null,                  // scheduled_date (ใช้ค่า default)
              sourceDoc,
              xlsSess.company_id
            );

            // ลบ session
            await db.from('tg_report_session').delete().eq('chat_id', String(xlsChatId));

            const addedCount = matchedCode.length + matchedName.length;
            let reply = '✅ สร้าง picking สำเร็จแล้วครับ!\n\n';
            reply += '📋 Picking ID: <b>' + pickingId + '</b>\n';
            reply += '📦 เพิ่มสินค้า: ' + addedCount + '/' + lines.length + ' รายการ\n';
            reply += '🏭 โครงการ: ' + tgEsc(sourceDoc) + '\n';

            // ⚠️ รายการที่จับคู่จากชื่อ (ไม่ใช่รหัส) → ต้องเช็ค
            if (matchedName.length) {
              reply += '\n⚠️ <b>ต้องตรวจสอบ ' + matchedName.length + ' รายการ</b> (จับคู่จากชื่อ ไม่ใช่รหัส):\n';
              matchedName.forEach(r => {
                const fromName = (r.line.productName || r.line.productCode || '-').slice(0, 35);
                const toName = (r.product.name || '-').slice(0, 35);
                reply += '• "' + tgEsc(fromName) + '"\n   → จับเป็น: ' + tgEsc(toName) + '\n';
              });
              reply += 'กรุณาเปิด picking ใน Odoo เช็คว่าตรงไหมครับ';
            }

            // ❌ ไม่เจอเลย → ต้องเพิ่มเอง
            if (notFound.length) {
              reply += '\n\n❌ <b>ไม่พบใน Odoo ' + notFound.length + ' รายการ</b> (ไม่ได้เพิ่ม):\n';
              notFound.forEach(r => {
                const label = r.line.productCode || r.line.productName || '-';
                reply += '• ' + tgEsc(String(label).slice(0, 45)) + '\n';
              });
              reply += 'กรุณาเพิ่มเองใน Odoo ครับ';
            }

            if (!matchedName.length && !notFound.length) {
              reply += '\n✅ ทุกรายการจับคู่จากรหัสสินค้าตรงเป๊ะ';
            }

            await sendTelegramReply(xlsChatId, reply);
          } catch (e) {
            await sendTelegramReply(msg.chat.id, '❌ สร้าง picking ไม่สำเร็จ: ' + tgEsc(e.message));
          }
          res.status(200).json({ ok: true }); return;
        }
      }
    }

    // ปล่อยให้ "รูป+caption" ผ่าน (ใช้กับคำสั่ง /บอก ที่แนบรูป) — ข้อความไม่มีทั้ง text/caption ค่อยตัด
    if (!msg || (!msg.text && !msg.caption)) { res.status(200).json({ ok: true }); return; }

    // ── กัน Telegram retry ส่ง update เดิมซ้ำ (สาเหตุบอทค้าง/ตอบซ้ำ) ──
    // ถ้าเคยเห็น update_id นี้แล้ว → ตอบ 200 ทันที ไม่ประมวลผลซ้ำ
    if (update.update_id && db) {
      try {
        const { error: dupErr } = await db.from('tg_processed_updates')
          .insert({ update_id: update.update_id });
        if (dupErr) {
          // insert ซ้ำ (duplicate key) = เคยทำแล้ว → ข้าม
          res.status(200).json({ ok: true, dup: true });
          return;
        }
      } catch (e) { /* ถ้าตารางมีปัญหา ปล่อยผ่านไปทำงานปกติ */ }
    }

    const chatId   = msg.chat && msg.chat.id;

    // /chatid หรือ /id → ตอบเลข chat id ของกลุ่มนี้ (ใช้ได้ทุกกลุ่ม แม้ยังไม่อยู่ allowlist)
    //   ใช้ตอนตั้งค่ากลุ่มใหม่: พิมพ์ /chatid ในกลุ่ม → เอาเลขที่ได้ไปใส่ TELEGRAM_CHAT_ID_3
    {
      const _cmd = String(msg.text || '').trim().toLowerCase();
      if (_cmd === '/chatid' || _cmd === '/id') {
        await sendTelegramReply(chatId, '🆔 Chat ID ของกลุ่มนี้:\n<code>' + chatId + '</code>');
        res.status(200).json({ ok: true }); return;
      }
    }

    if (!isAllowedChat(chatId)) { res.status(200).json({ ok: true }); return; }

    // ══════════════════════════════════════════════════════════════════════════
    //  /ประกาศ <ปลายทาง> <ข้อความ> — "บอทพูดแทน" (relay) จากกลุ่มใหม่(chat 3) → กลุ่มปลายทาง
    //    คนปลายทางเห็นแค่บอทเป็นคนพิมพ์ ไม่รู้ว่าใครสั่ง | แนบรูปได้ (reply รูป หรือ ส่งรูป+caption)
    //    ใช้ได้เฉพาะกลุ่มใหม่(chat 3) เพื่อกันคนอื่นแอบใช้
    // ══════════════════════════════════════════════════════════════════════════
    {
      const relayRaw = (msg.text || msg.caption || '').replace(new RegExp('@' + (BOT_USERNAME || '\\w+'), 'gi'), '').trim();
      const relayMatch = relayRaw.match(/^\/(?:ประกาศ|บอก|พูด)\s+(\S+)\s*([\s\S]*)$/i);
      if (relayMatch && getChatType(chatId) === 'new') {
        const RELAY_TARGETS = {
          'ฟ้า':     { type: 'line', id: 'C9adc5d856cc04bdefa31523f8c98a520' },
          'เทส':     { type: 'line', id: 'Cd888f9bcfe77f27d6ad9b488a6bb24bc' },
          'ชุบ':     { type: 'line', id: 'C0479aa47a7c02d6c7c0dd6346142391b' },
          'สั่งของ': { type: 'tg',   id: process.env.TELEGRAM_CHAT_ID_2 || '' },
          'ใหม่':    { type: 'tg',   id: process.env.TELEGRAM_CHAT_ID_3 || '' },
          'ครูภูมิใจ': { type: 'tg', id: process.env.TELEGRAM_CHAT_ID || '' },
          'สโตร์':   { type: 'tg',   id: '-1001817927448' },
          'เบิกของ': { type: 'tg',   id: '-1001698212414' },
        };
        const destKey = relayMatch[1];
        const message = (relayMatch[2] || '').trim();
        const dest = RELAY_TARGETS[destKey];
        if (!dest) {
          await sendTelegramReply(chatId, '⚠️ ไม่รู้จักปลายทาง "' + destKey + '"\nปลายทางที่ใช้ได้: ' + Object.keys(RELAY_TARGETS).join(' / '));
          res.status(200).json({ ok: true }); return;
        }
        if (!dest.id) {
          await sendTelegramReply(chatId, '⚠️ ปลายทาง "' + destKey + '" ยังไม่ได้ตั้งค่า id ครับ');
          res.status(200).json({ ok: true }); return;
        }
        // หา "รูป" จากข้อความนี้ (ส่งรูป+caption) หรือจากข้อความที่ reply (reply รูป)
        const srcPhotoMsg = (msg.photo && msg.photo.length) ? msg
          : (msg.reply_to_message && msg.reply_to_message.photo && msg.reply_to_message.photo.length ? msg.reply_to_message : null);
        if (!message && !srcPhotoMsg) {
          await sendTelegramReply(chatId, '⚠️ ใส่ข้อความด้วยครับ เช่น\n/บอก ' + destKey + ' ข้อความที่ต้องการ');
          res.status(200).json({ ok: true }); return;
        }
        const TG_TOK = process.env.TELEGRAM_BOT_TOKEN || '';
        try {
          // เตรียมรูป: TG ใช้ file_id ได้เลย | LINE ต้องมี public URL → อัปขึ้น storage
          let photoFileId = null, photoUrl = null;
          if (srcPhotoMsg) {
            const ph = srcPhotoMsg.photo[srcPhotoMsg.photo.length - 1];
            photoFileId = ph.file_id;
            if (dest.type === 'line' && db) {
              const gi = await (await fetch(`https://api.telegram.org/bot${TG_TOK}/getFile?file_id=${photoFileId}`)).json();
              if (gi.ok) {
                const furl = `https://api.telegram.org/file/bot${TG_TOK}/${gi.result.file_path}`;
                const buf = Buffer.from(await (await fetch(furl)).arrayBuffer());
                const sname = 'relay_' + Date.now() + '.jpg';
                const { error: upErr } = await db.storage.from('attachments').upload(sname, buf, { contentType: 'image/jpeg', upsert: false });
                if (!upErr) { const { data: u } = db.storage.from('attachments').getPublicUrl(sname); photoUrl = u?.publicUrl || null; }
              }
              if (!photoUrl) { await sendTelegramReply(chatId, '⚠️ เตรียมรูปสำหรับ LINE ไม่สำเร็จ (ส่งเฉพาะข้อความแทน)'); }
            }
          }

          // ── ห่อข้อความเป็น "ประกาศ" โทนฟ้า + ใส่วันที่อัตโนมัติ (เวลาไทย) + ลงท้ายฝ่ายคลัง ──
          const _now = new Date(Date.now() + 7 * 3600 * 1000); // เวลาไทย (UTC+7)
          const _thM = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
          const annDate = _now.getUTCDate() + ' ' + _thM[_now.getUTCMonth()] + ' ' + (_now.getUTCFullYear() + 543) +
            '  •  ' + String(_now.getUTCHours()).padStart(2, '0') + ':' + String(_now.getUTCMinutes()).padStart(2, '0') + ' น.';
          const annBar = '💠═══════════════💠';
          const buildAnn = (forHtml) => {
            const b = (t) => forHtml ? '<b>' + t + '</b>' : t;
            const body = forHtml ? tgEsc(message) : message;
            return annBar + '\n' +
              '📢 ' + b('ป ร ะ ก า ศ') + '\n' +
              '🗓️ ' + annDate + '\n' +
              annBar + '\n' +
              (message ? '💬 ' + body + '\n' : '') +
              '〰️〰️〰️〰️〰️〰️〰️〰️\n' +
              '🏢 ' + b('From Warehouse Department') + '\n' +
              '💙 ฝ่ายคลังสินค้า';
          };
          const annHtml = buildAnn(true);
          const annPlain = buildAnn(false);

          if (dest.type === 'tg') {
            if (photoFileId) {
              await fetch(`https://api.telegram.org/bot${TG_TOK}/sendPhoto`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: dest.id, photo: photoFileId, caption: annHtml, parse_mode: 'HTML' })
              });
            } else {
              await fetch(`https://api.telegram.org/bot${TG_TOK}/sendMessage`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: dest.id, text: annHtml, parse_mode: 'HTML' })
              });
            }
          } else {
            const LINE_TOK = process.env.LINE_CHANNEL_TOKEN || '';
            const messages = [];
            messages.push({ type: 'text', text: annPlain });
            if (photoUrl) messages.push({ type: 'image', originalContentUrl: photoUrl, previewImageUrl: photoUrl });
            const lr = await fetch('https://api.line.me/v2/bot/message/push', {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_TOK },
              body: JSON.stringify({ to: dest.id, messages })
            });
            if (!lr.ok) {
              const et = await lr.text();
              await sendTelegramReply(chatId, '⚠️ ส่งเข้า LINE ไม่สำเร็จ: ' + et);
              res.status(200).json({ ok: true }); return;
            }
          }
          await sendTelegramReply(chatId, '✅ ส่งไปกลุ่ม "' + destKey + '" แล้วครับ (ในนามบอท)' + (photoFileId ? ' 📷' : ''));
        } catch (e) {
          await sendTelegramReply(chatId, '⚠️ ส่งไม่สำเร็จ: ' + e.message);
        }
        res.status(200).json({ ok: true }); return;
      }
    }

    // ── @บอท เรียบร้อย (reply ใบเบิกใน chat 1/chat 2) → ตอบกลับกลุ่มเบิกของ ──
    //    ทำงานทุกกลุ่มที่อนุญาต | รองรับแนบรูป (photo+caption) → ส่งรูปกลับกลุ่มเบิกด้วย
    if (msg && msg.reply_to_message) {
      const wMsgText = msg.text || msg.caption || '';
      const wMentioned = BOT_USERNAME
        ? new RegExp('@' + BOT_USERNAME + '\\b', 'i').test(wMsgText)
        : (msg.entities || msg.caption_entities || []).some(e => e.type === 'mention');
      const wBody = wMsgText.replace(new RegExp('@' + (BOT_USERNAME || '[\\w]+') + '\\b', 'gi'), '').trim();
      // ไม่ต้องแท็กบอทก็ได้ — แค่ reply ที่ใบเบิก + พิมพ์ "เรียบร้อย" ก็พอ (แท็กบอทมักเลือกไม่ได้ในแคปชั่นรูป)
      if (/เรียบร้อย|เสร็จ|จัดเสร็จ|จัดให้แล้ว/.test(wBody) && db) {
        try {
          const replyId = msg.reply_to_message.message_id;
          const { data: rows } = await db.from('delivery_views')
            .select('*').eq('title', 'withdraw').order('id', { ascending: false }).limit(50);
          const rec = (rows || []).find(r => {
            const d = r.data || {};
            return d.chat1HeaderId === replyId || d.chat1CopyId === replyId;
          });
          if (rec) {
            const d = rec.data;
            const TG_TOK = process.env.TELEGRAM_BOT_TOKEN || '';
            await fetch(`https://api.telegram.org/bot${TG_TOK}/copyMessage`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: d.srcChatId,
                from_chat_id: d.srcChatId,
                message_id: d.srcMessageId,
                reply_to_message_id: d.srcMessageId
              })
            });
            await fetch(`https://api.telegram.org/bot${TG_TOK}/sendMessage`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: d.srcChatId,
                text: '✅ เรียบร้อยครับ จัดของให้แล้ว',
                reply_to_message_id: d.srcMessageId
              })
            });
            // ผู้ตอบแนบรูปมาด้วย → ส่งรูปกลับกลุ่มเบิก (ให้คนเบิกเห็นของ/ตำแหน่ง)
            let sentPhoto = false;
            if (msg.photo && msg.photo.length) {
              const ph = msg.photo[msg.photo.length - 1];
              await fetch(`https://api.telegram.org/bot${TG_TOK}/sendPhoto`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: d.srcChatId, photo: ph.file_id, reply_to_message_id: d.srcMessageId })
              });
              sentPhoto = true;
            }
            await sendTelegramReply(chatId, '✅ ส่งแจ้ง "เรียบร้อยครับ" กลับกลุ่มเบิกของแล้วครับ' + (sentPhoto ? ' 📷 (แนบรูปให้แล้ว)' : ''));
            await db.from('delivery_views').delete().eq('id', rec.id);
            res.status(200).json({ ok: true }); return;
          } else if (wMentioned) {
            // แท็กบอทแต่หา reply ไม่เจอ → เตือน | ไม่ได้แท็ก = reply "เรียบร้อย" ทั่วไป → ปล่อยผ่านเงียบ
            await sendTelegramReply(chatId, '⚠️ ไม่พบใบเบิกที่ผูกกับข้อความนี้ครับ (อาจตอบไปแล้ว หรือ reply ผิดข้อความ)');
            res.status(200).json({ ok: true }); return;
          }
        } catch (e) {
          console.error('withdraw reply error:', e.message);
          if (wMentioned) { await sendTelegramReply(chatId, '⚠️ ตอบกลับกลุ่มเบิกของไม่สำเร็จ: ' + e.message); res.status(200).json({ ok: true }); return; }
        }
      }
    }

    // ข้อความที่ไม่ใช่ text (รูป/ไฟล์) และไม่ใช่คำสั่ง → ไม่ประมวลผลต่อ (คงพฤติกรรมเดิม)
    if (!msg.text) { res.status(200).json({ ok: true }); return; }

    // ── chat 1 (กลุ่มหลัก): ปิดคำสั่ง/ฟีเจอร์ทั้งหมด ────────────────────────────
    //   เหลือไว้แค่ reply "เรียบร้อย" (จัดการไปข้างบนแล้ว) — คำสั่งอื่นๆ ให้ไปใช้กลุ่มใหม่
    if (getChatType(chatId) === 'main') { res.status(200).json({ ok: true }); return; }

    const text     = msg.text;
    const trimmed  = text.trim();
    const chatType = getChatType(chatId); // 'main' | 'sub' | 'new' | null

    // ── เส้นทางที่ 1: คำสั่ง / (ใช้ได้ทุกกลุ่ม) ─────────────────────────────
    if (trimmed.startsWith('/')) {
      // ตัด @botname ที่ Telegram เติมท้ายคำสั่งในกลุ่ม เช่น /สรุป@OdooBot → /สรุป
      var cmdText = trimmed;
      if (BOT_USERNAME) {
        cmdText = cmdText.replace(new RegExp('@' + BOT_USERNAME, 'gi'), '');
      } else {
        cmdText = cmdText.replace(/@\w+/g, '');
      }
      cmdText = cmdText.trim();

      var lc = cmdText.toLowerCase();

      // ── /chatid → ตอบ Chat ID ของกลุ่มนี้ (ใช้ตอนตั้งค่า) ──
      if (cmdText === '/chatid' || lc === '/chatid') {
        await sendTelegramReply(chatId, '🆔 Chat ID ของกลุ่มนี้:\n' + chatId);
        res.status(200).json({ ok: true }); return;
      }

      // ── /รายงาน → ค้นใบส่งของ แล้วส่งรายงานเข้า LINE หรือ Telegram กลุ่ม 2 ──
      if (cmdText.startsWith('/รายงาน')) {
        var rawRep = cmdText.replace(/^\/รายงาน/, '').trim();
        if (!rawRep) {
          await sendTelegramReply(chatId,
            'พิมพ์ชื่องาน/เลขเอกสารต่อท้ายครับ เช่น:\n' +
            '/รายงาน กท.1002 12/6\n' +
            '/รายงาน po2606025 เทส\n' +
            '/รายงาน so2606011 สั่งของ\n' +
            '/รายงาน mo SET/MO/00002\n' +
            '/รายงาน mo เสาไฟกิ่ง\n\n' +
            '➡️ บอทจะให้ส่งรูป แล้วพิมพ์ /จบรายงาน\n' +
            '   (อัปรูปเข้า Odoo + แสดงรายงานในครั้งเดียว)\n' +
            'ปลายทาง: ฟ้า / เทส / ชุบ / สั่งของ (ไม่ใส่ = แสดงในกลุ่มนี้)'
          );
          res.status(200).json({ ok: true }); return;
        }

        // แยก target (ไลน์/เทส/เทเลแกรม) จากท้ายคำสั่ง
        var repTarget = null;
        var LINE_GROUPS = {
          'ฟ้า': 'C9adc5d856cc04bdefa31523f8c98a520',
          'เทส':  'Cd888f9bcfe77f27d6ad9b488a6bb24bc',
          'ชุบ':  'C0479aa47a7c02d6c7c0dd6346142391b'
        };
        var repKw = rawRep;
        if (/\sฟ้า\s*$/i.test(repKw))       { repTarget = 'ฟ้า';      repKw = repKw.replace(/\sฟ้า\s*$/, '').trim(); }
        else if (/\sเทส\s*$/i.test(repKw))  { repTarget = 'เทส';      repKw = repKw.replace(/\sเทส\s*$/, '').trim(); }
        else if (/\sชุบ\s*$/i.test(repKw))  { repTarget = 'ชุบ';      repKw = repKw.replace(/\sชุบ\s*$/, '').trim(); }
        else if (/\sสั่งของ\s*$/i.test(repKw)) { repTarget = 'สั่งของ'; repKw = repKw.replace(/\sสั่งของ\s*$/, '').trim(); }

        if (!repTarget) {
          repTarget = '__self__'; // ไม่ระบุปลายทาง → ส่งกลับกลุ่มที่พิมพ์คำสั่ง
        }

        // ── ตรวจหลายเลขใบท้ายคำสั่ง เช่น "สาย12.../20/23/25" หรือ "สาย12... 20 23 25" ──
        // รองรับ 2 รูปแบบ: คั่นด้วย "/" ติดกัน หรือคั่นด้วยช่องว่าง — เก็บ keyword ส่วนชื่อ
        // ไว้ค้นแยกจากเลขใบ แล้วกรองเอาเฉพาะใบที่ลงท้ายด้วยเลขที่ระบุ
        var repMultiNums = null;
        var _mSlash = repKw.match(/^(.+?)\/(\d+(?:\/\d+){1,9})\s*$/); // ".../20/23/25"
        var _mSpace = repKw.match(/^(.+?)\s+(\d+(?:\s+\d+){1,9})\s*$/); // "... 20 23 25"
        if (_mSlash) {
          repMultiNums = _mSlash[2].split('/').map(s => s.trim()).filter(Boolean);
          repKw = _mSlash[1].trim();
        } else if (_mSpace) {
          // กันชนกับวันที่ (เช่น "12/6") — ต้องเป็นเลข ≥2 ตัว คั่นด้วยช่องว่างล้วน ไม่ใช่ / หรือ -
          repMultiNums = _mSpace[2].split(/\s+/).map(s => s.trim()).filter(Boolean);
          repKw = _mSpace[1].trim();
        }

        // /รายงาน เน้นค้น "ใบส่งของ" เป็นหลักเสมอ (ผู้ใช้ลงรูปใบส่งของ)
        // ไม่ตัด prefix so/po/pr ออก — เก็บเลขเต็มไว้ค้นทั้งเลขใบส่ง + origin (SO/PO)
        // เช่น "so2605047" หรือ "2605047" หรือ "02070" (เลขใบส่งจริง) ค้นเจอหมด
        var repDocType = 'picking';

        // ── ตรวจ prefix pr/so/po → route ไป odooFindDoc แทน picking (ข้ามถ้าเป็น multi-number) ──
        var _docPfx = repMultiNums ? null : repKw.match(/^(pr|so|po)\s*0*(\d+)/i);
        if (_docPfx) repDocType = _docPfx[1].toLowerCase();

        // ── ตรวจ prefix mo → ค้น Manufacturing Order ──
        var repKwTrim = repKw.trim();
        var isMoCmd = /^mo(\s|\/|\d|$)/i.test(repKwTrim) || /^set\/mo\//i.test(repKwTrim);
        if (isMoCmd) {
          // ดึง keyword: "set/mo/xxx" เก็บทั้งก้อน, อย่างอื่นตัด prefix "mo" + ตัวคั่นนำหน้าออก
          var moKw = /^set\/mo\//i.test(repKwTrim) ? repKwTrim : repKwTrim.replace(/^mo[\s\/]*/i, '').trim();
          if (!moKw) {
            await sendTelegramReply(chatId,
              'พิมพ์เลข MO หรือชื่อสินค้าต่อท้ายครับ เช่น:\n' +
              '/รายงาน mo SET/MO/00002\n' +
              '/รายงาน mo เสาไฟกิ่ง');
            res.status(200).json({ ok: true }); return;
          }
          try {
            const { odooMO } = await import('./odoo.js');
            const { keyword: moKwClean, company: moCo } = parseCompany(moKw);
            await sendTelegramReply(chatId, '🔍 กำลังค้น MO ใน Odoo...');
            const mos = await odooMO(moKwClean, moCo.id);
            if (!mos || !mos.length) {
              await sendTelegramReply(chatId, '🔍 ไม่พบ MO "' + moKwClean + '" ครับ\n\nลองพิมพ์เลข MO เช่น:\n/รายงาน mo SET/MO/00002\n/รายงาน mo เสาไฟกิ่ง');
              res.status(200).json({ ok: true }); return;
            }
            if (mos.length > 1) {
              // เจอหลายใบ → ให้ระบุเลข MO ให้ชัด (กันแนบรูปผิดใบ)
              const list = mos.slice(0, 10).map(function(m, i){
                const icon = m.state === 'done' ? '✅' : m.state === 'cancel' ? '❌' : m.state === 'progress' ? '⚙️' : '📋';
                return (i+1) + '. ' + icon + ' ' + m.name + ' — ' + m.product + ' (' + m.stateLabel + ')';
              }).join('\n');
              await sendTelegramReply(chatId,
                '🏭 เจอ MO ' + mos.length + ' ใบ' + (mos.length > 10 ? ' (แสดง 10 แรก)' : '') + '\nกรุณาระบุเลข MO ให้ชัดเพื่อแนบรูปครับ:\n\n' + list +
                '\n\nเช่น: /รายงาน mo ' + mos[0].name);
              res.status(200).json({ ok: true }); return;
            }
            // เจอใบเดียว → เปิด session รอรูป (เหมือน po/so/pr)
            const mo = mos[0];
            if (db) {
              await db.from('tg_report_session').upsert({
                chat_id: String(chatId),
                doc_type: 'mo', doc_id: mo.id, doc_name: mo.name, doc_model: 'mrp.production',
                uploaded: 0, options: repTarget, updated_at: new Date().toISOString()
              }, { onConflict: 'chat_id' });
            }
            await sendTelegramReply(chatId,
              '✅ พบ MO แล้วครับ!\n🏭 ' + mo.name + '\n📦 ' + mo.product +
              '\n🔢 จำนวน: ' + mo.qty + ' ' + mo.uom + '\nสถานะ: ' + mo.stateLabel +
              '\n\n📷 ส่งรูปเข้ากลุ่มได้เลย (รับภายใน 10 นาที)\nพิมพ์ /จบรายงาน เมื่อส่งรูปครบ');
          } catch(e) {
            await sendTelegramReply(chatId, '⚠️⚠️⚠️ ค้น MO ไม่สำเร็จ: ' + e.message);
          }
          res.status(200).json({ ok: true }); return;
        }

        await sendTelegramReply(chatId, '🔍 กำลังค้นหาใน Odoo...');

        // ── po/so/pr → ค้นเอกสาร แล้วเปิด session รอรูป ──
        if (repDocType !== 'picking') {
          try {
            const { odooFindDoc } = await import('./odoo.js');
            const { keyword: repKwClean, company: repCompany, explicit: repCoExplicit } = parseCompany(repKw);
            // ไม่ได้ระบุบริษัท (md/cg/sep/akn) → ค้นทุกบริษัท (เลขเอกสารอยู่บริษัทไหนก็เจอ — มี 4 บริษัท)
            const doc = await odooFindDoc(repDocType, repKwClean, null, repCoExplicit ? repCompany.id : null);
            if (!doc) {
              await sendTelegramReply(chatId, '🔍 ไม่พบเอกสาร "' + repKwClean + '" ครับ');
              res.status(200).json({ ok: true }); return;
            }
            // เปิด session รอรูป (เก็บ target ไว้ใช้ตอน /จบรายงาน)
            if (db) {
              await db.from('tg_report_session').upsert({
                chat_id: String(chatId),
                doc_type: repDocType, doc_id: doc.id, doc_name: doc.name, doc_model: doc.model,
                uploaded: 0, options: repTarget, updated_at: new Date().toISOString()
              }, { onConflict: 'chat_id' });
            }
            await sendTelegramReply(chatId,
              '✅ พบเอกสารแล้วครับ!\n📋 ' + doc.name +
              '\n\n📷 ส่งรูปเข้ากลุ่มได้เลย (รับภายใน 10 นาที)\nพิมพ์ /จบรายงาน เมื่อส่งรูปครบ'
            );
          } catch(e) {
            await sendTelegramReply(chatId, '⚠️⚠️⚠️ เกิดข้อผิดพลาด: ' + e.message);
          }
          res.status(200).json({ ok: true }); return;
        }

        // ดึงวันที่จริงออกจาก keyword (เฉพาะใบส่งของ) — ระวัง 82/2 = เลขใบ ไม่ใช่วันที่
        var repDate = null;
        var repDm = repKw.match(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\s*$/);
        if (repDm) {
          var rdParts = repDm[1].split(/[\/\-]/);
          var rdDay = parseInt(rdParts[0], 10), rdMon = parseInt(rdParts[1], 10);
          if (rdDay >= 1 && rdDay <= 31 && rdMon >= 1 && rdMon <= 12) {
            repDate = parseDate(repDm[1]); repKw = repKw.replace(repDm[0], '').trim();
          }
        }

        try {
          const { odooDelivery, parseCompany, odooSO, odooPO } = await import('./odoo.js');
          const { keyword: dkw, company: dCo } = parseCompany(repKw);

          // ค้นใบส่งของ — ลองหลายแบบให้ครอบคลุม (เลขใบส่ง 02070 / SO2605047 / 2605047)
          // 1) ค้นตามที่พิมพ์ (กรอง company ถ้าระบุตัวย่อบริษัทมา)
          let allPicks = await odooDelivery(dkw, dCo.id);
          // 2) ถ้าไม่เจอ → ค้นข้ามทุกบริษัท (ใบส่งของอาจอยู่บริษัทไหนก็ได้)
          if (!allPicks.length) {
            allPicks = await odooDelivery(dkw, null);
          }
          // 3) ยังไม่เจอ + คำค้นขึ้นต้น so/po/pr → ลองถอด prefix แล้วค้นเลขล้วน (เผื่อ origin เก็บคนละรูปแบบ)
          if (!allPicks.length) {
            const stripped = dkw.replace(/^(so|po|pr)\s*/i, '').trim();
            if (stripped && stripped !== dkw) {
              allPicks = await odooDelivery(stripped, null);
            }
          }
          // 4) ยังไม่เจอ + เป็น so/po → ค้นตัว SO/PO ใน Odoo ก่อน เอา "ชื่อจริง" (เช่น S2506016) มาหา delivery
          //    (แก้กรณีเลขที่พิมพ์ ≠ เลขใน origin ของ delivery)
          if (!allPicks.length) {
            const mDoc = dkw.match(/^(so|po)\s*0*(\d+)$/i);
            if (mDoc) {
              try {
                const isSO = mDoc[1].toLowerCase() === 'so';
                const docs = isSO ? await odooSO(dkw, null) : await odooPO(dkw, null);
                // ลองทุกชื่อ SO/PO ที่เจอ ไปค้น delivery ที่ origin = ชื่อนั้น
                for (const doc of (docs || [])) {
                  if (doc && doc.name) {
                    const byOrigin = await odooDelivery(doc.name, null);
                    if (byOrigin.length) { allPicks = byOrigin; break; }
                  }
                }
              } catch (e) { /* ค้น SO/PO ไม่ได้ ข้าม */ }
            }
          }

          // ── โหมดหลายใบ: ค้นตรงๆ ด้วย odooDeliveryMulti (ระบุเลขท้ายใน domain เลย) ──
          // ไม่ใช้ allPicks/repPicks ที่ติด limit การค้นกว้าง (40 ใบ) ซึ่งถ้า keyword กว้าง
          // (เช่นแค่ชื่อจังหวัด) อาจมีใบตรงเป็นร้อย ใบที่ต้องการอาจหลุด limit ไปก่อนถึงตา
          if (repMultiNums && repMultiNums.length) {
            const { odooDeliveryMulti } = await import('./odoo.js');
            const matchedPicks = await odooDeliveryMulti(dkw, repMultiNums, dCo.id) ||
                                  await odooDeliveryMulti(dkw, repMultiNums, null);
            if (!matchedPicks.length) {
              await sendTelegramReply(chatId,
                '🔍 ไม่พบใบที่ลงท้าย /' + repMultiNums.join(', /') + ' จาก "' + repKw + '" ครับ\n' +
                'ลองเช็คเลขใบอีกครั้ง หรือพิมพ์ /รายงาน ' + repKw + ' เฉยๆ เพื่อดูรายการทั้งหมด'
              );
              res.status(200).json({ ok: true }); return;
            }
            // เรียงตามลำดับเลขที่ผู้ใช้พิมพ์ (ไม่ใช่ลำดับที่ค้นเจอ)
            matchedPicks.sort((a, b) => {
              const na = parseInt((String(a.name||'').match(/\/(\d+)\s*$/)||[])[1] || 0, 10);
              const nb = parseInt((String(b.name||'').match(/\/(\d+)\s*$/)||[])[1] || 0, 10);
              return repMultiNums.indexOf(String(na)) - repMultiNums.indexOf(String(nb));
            });
            const missing = repMultiNums.filter(n => {
              const nn = String(parseInt(n, 10));
              return !matchedPicks.some(p => String(parseInt((String(p.name||'').match(/\/(\d+)\s*$/)||[])[1]||-1,10)) === nn);
            });
            const primary = matchedPicks[0];
            const extras = matchedPicks.slice(1);
            if (db) {
              await db.from('tg_report_session').upsert({
                chat_id: String(chatId),
                doc_type: 'picking', doc_id: primary.id, doc_name: primary.name, doc_model: 'stock.picking',
                uploaded: 0, options: repTarget,
                extra_ids: extras.map(p => p.id),       // เก็บไว้เผื่อใช้ตรวจสอบ/แสดงผล
                extra_names: extras.map(p => p.name),   // ใช้ค้นหาตอน /จบรายงาน (แม่นยำกว่า id)
                updated_at: new Date().toISOString()
              }, { onConflict: 'chat_id' });
            }
            const listTxt = matchedPicks.map((p,i) => (i+1) + '. ' + p.name + (p.company_id ? '  [' + coLabel(p.company_id) + ']' : '')).join('\n');
            await sendTelegramReply(chatId,
              '✅ พบ ' + matchedPicks.length + ' ใบครับ!\n' + listTxt +
              (missing.length ? '\n⚠️ ไม่พบเลข /' + missing.join(', /') : '') +
              '\n\n📷 ส่งรูปเข้ากลุ่มได้เลย (รูปจะลงที่ใบแรก: ' + primary.name + ')\n' +
              'รายการสินค้าจากทุกใบจะแสดงในรายงานเดียวกัน\nพิมพ์ /จบรายงาน เมื่อส่งรูปครบ'
            );
            res.status(200).json({ ok: true }); return;
          }

          let repPicks = repDate
            ? allPicks.filter(p => String(p.scheduled_date || '').slice(0,10) === repDate)
            : allPicks;

          // เรียงใหม่→เก่า (ใบล่าสุดขึ้นก่อน) — ใช้วันที่รับ/กำหนด ถ้าไม่มีใช้เลข id
          repPicks = [...repPicks].sort((a, b) => {
            const da = String(a.date_done || a.scheduled_date || '');
            const db2 = String(b.date_done || b.scheduled_date || '');
            if (da !== db2) return da < db2 ? 1 : -1;   // วันที่มากกว่า (ใหม่กว่า) ขึ้นก่อน
            return (b.id || 0) - (a.id || 0);            // วันเท่ากัน → id มากกว่าขึ้นก่อน
          });

          if (!repPicks.length) {
            const errHint = (allPicks && allPicks._error) ? ('\n\n⚠️ Odoo error: ' + allPicks._error) : '';
            await sendTelegramReply(chatId, '🔍 ไม่พบใบส่งของ "' + repKw + '"' + (repDate ? ' วันที่ ' + repDm[1] : '') + ' ครับ\n\n💡 ลองค้นด้วย: เลขใบส่งของ, เลข SO (เช่น SO2605047), หรือชื่อโครงการ/ลูกค้า' + errHint);
            res.status(200).json({ ok: true }); return;
          }

          // เจอหลายใบ → ถามให้เลือก (ตอบเลข) — เก็บ target ไว้
          if (repPicks.length > 1) {
            const opts = repPicks.slice(0, 15).map((p, i) => (i+1) + '. ' + (p.name || '-') + (p.company_id ? '  [' + coLabel(p.company_id) + ']' : '')).join('\n');
            if (db) {
              await db.from('tg_report_select').upsert({
                chat_id: String(chatId),
                picks: repPicks.slice(0, 15),
                target: repTarget,
                keyword: repKw,
                created_at: new Date().toISOString()
              }, { onConflict: 'chat_id' });
            }
            await sendTelegramReply(chatId,
              '🔍 พบ ' + repPicks.length + ' ใบ กรุณาเลือก:\n' + opts +
              '\n\n📌 ตอบเลขที่ต้องการครับ เลือกได้หลายใบ เช่น <b>1</b> หรือ <b>1 3 5</b>\n' +
              '(รูปจะลงที่ใบแรกที่เลือก รายการสินค้าจากทุกใบจะรวมในรายงานเดียวกัน)'
            );
            res.status(200).json({ ok: true }); return;
          }

          // เจอใบเดียว → เปิด session รอรูป
          const onePick = repPicks[0];
          if (db) {
            await db.from('tg_report_session').upsert({
              chat_id: String(chatId),
              doc_type: 'picking', doc_id: onePick.id, doc_name: onePick.name, doc_model: 'stock.picking',
              uploaded: 0, options: repTarget, updated_at: new Date().toISOString()
            }, { onConflict: 'chat_id' });
          }
          await sendTelegramReply(chatId,
            '✅ พบใบส่งของแล้วครับ!\n📋 ' + onePick.name +
            '\n\n📷 ส่งรูปเข้ากลุ่มได้เลย (รับภายใน 10 นาที)\nพิมพ์ /จบรายงาน เมื่อส่งรูปครบ'
          );
        } catch(e) {
          await sendTelegramReply(chatId, '⚠️⚠️⚠️ เกิดข้อผิดพลาด: ' + e.message);
        }
        res.status(200).json({ ok: true }); return;
      }

      // ── /ยกเลิก — ยกเลิก session นำเข้าใบส่งของ ──────────────────────────────
      if (cmdText === '/ยกเลิก' || cmdText === '/cancel') {
        if (db) {
          const { data: canSess } = await db.from('tg_report_session')
            .select('mode').eq('chat_id', String(chatId)).maybeSingle();
          if (canSess && (canSess.mode === 'import_delivery' || canSess.mode === 'import_optype_select')) {
            await db.from('tg_report_session').delete().eq('chat_id', String(chatId));
            await sendTelegramReply(chatId, '✅ ยกเลิกการนำเข้าใบส่งของแล้วครับ');
            res.status(200).json({ ok: true }); return;
          }
        }
      }

      // ── /นำเข้าใบส่งของ → ค้น Operation Type ──────────────────────────────────
      if (cmdText.startsWith('/นำเข้าใบส่งของ') || lc.startsWith('/importdelivery')) {
        if (!db) { await sendTelegramReply(chatId, '⚠️⚠️⚠️ ยังไม่ได้เชื่อมต่อฐานข้อมูลครับ'); res.status(200).json({ ok: true }); return; }
        const rawReply = await handleTelegramCommand(cmdText);

        // รับ __OPTYPE_LIST__ marker → บันทึก session ตัวเลือก
        if (rawReply.includes('__OPTYPE_LIST__:')) {
          const markerIdx = rawReply.indexOf('__OPTYPE_LIST__:');
          const displayMsg = rawReply.slice(0, markerIdx).trim();
          const markerStr = rawReply.slice(markerIdx + '__OPTYPE_LIST__:'.length);
          const [listPart, coPart] = markerStr.split('::CO:');
          const coId = parseInt(coPart) || 1;
          const opts = listPart.split(';;').map(s => {
            const [id, ...nameParts] = s.split('|');
            return { id: parseInt(id), name: nameParts.join('|') };
          });
          await db.from('tg_report_session').upsert({
            chat_id: String(chatId),
            mode: 'import_optype_select',
            options: opts,
            company_id: coId,
            updated_at: new Date().toISOString()
          });
          await sendTelegramReply(chatId, displayMsg);
        } else if (rawReply.includes('__PENDING_DELIVERY_IMPORT__:')) {
          // เจอตัวเดียว → บันทึก session รอ Excel
          const markerIdx = rawReply.indexOf('__PENDING_DELIVERY_IMPORT__:');
          const displayMsg = rawReply.slice(0, markerIdx).trim();
          const markerStr = rawReply.slice(markerIdx + '__PENDING_DELIVERY_IMPORT__:'.length);
          const [opId, opName, coId] = markerStr.split(':');
          await db.from('tg_report_session').upsert({
            chat_id: String(chatId),
            mode: 'import_delivery',
            doc_id: parseInt(opId),
            doc_name: opName,
            company_id: parseInt(coId) || 1,
            updated_at: new Date().toISOString()
          });
          await sendTelegramReply(chatId, displayMsg);
        } else {
          await sendTelegramReply(chatId, rawReply);
        }
        res.status(200).json({ ok: true }); return;
      }

      // ── รับตัวเลขตอบ session เลือกใบส่งของสำหรับ /เทียบ ───────────────────
      if (/^\d+$/.test(cmdText.trim()) && db) {
        const { data: cmpSess } = await db.from('tg_compare_select')
          .select('*').eq('chat_id', String(chatId)).maybeSingle();
        const cmpAge = cmpSess ? (Date.now() - new Date(cmpSess.created_at).getTime()) / 60000 : 999;
        if (cmpSess && cmpAge < 5) {
          const idx = parseInt(cmdText.trim()) - 1;
          const picks = cmpSess.picks || [];
          if (idx < 0 || idx >= picks.length) {
            await sendTelegramReply(chatId, '⚠️ กรุณาตอบเลข 1-' + picks.length + ' ครับ');
          } else {
            await db.from('tg_compare_select').delete().eq('chat_id', String(chatId));
            await sendTelegramReply(chatId, '⏳ กำลังดึงข้อมูลเปรียบเทียบ...');
            const cmpCompany = companyById(cmpSess.company_id);
            await sendDeliveryCompareTG(chatId, cmpSess.doc_ref, picks[idx], cmpCompany);
          }
          res.status(200).json({ ok: true }); return;
        }
      }

      // ── /เทียบ so1234 po5678 [ตัวย่อบริษัท] → เปรียบเทียบ (เว็บ) ────────────
      // รองรับ 2 รูปแบบ:
      //   1) /เทียบ so1234 po5678 [md]                          → เทียบ SO/PO/PR กันเอง
      //   2) /เทียบ po2606025 ใบส่งของ กท.1002 12/6 [md]        → เทียบกับใบส่งของ
      //      /เทียบ ใบส่งของ กท.1002 12/6 po2606025 [md]        → (สลับลำดับได้)
      if (cmdText.startsWith('/เทียบ') || lc.startsWith('/compare')) {
        if (!db) { await sendTelegramReply(chatId, '⚠️⚠️⚠️ ยังไม่ได้เชื่อมต่อฐานข้อมูลครับ'); res.status(200).json({ ok: true }); return; }

        const arg = cmdText.replace(/^\/เทียบ/,'').replace(/^\/compare/i,'').trim();
        const { keyword: argClean, company: cmp } = parseCompany(arg);

        const parseDocRef = (s) => {
          const m = s.match(/^(so|po|pr)(\w+)$/i);
          if (!m) return null;
          return { type: m[1].toLowerCase(), num: m[2] };
        };

        const words = argClean.trim().split(/\s+/).filter(Boolean);
        const sIdx = words.findIndex(w => w === 'ส่งของ' || w === 'ใบส่งของ');

        // ── mode 2: เทียบกับใบส่งของ ─────────────────────────────────────────
        if (sIdx !== -1) {
          let refOther = null, refIdx = -1;
          for (let i = 0; i < words.length; i++) {
            if (i === sIdx) continue;
            const r = parseDocRef(words[i]);
            if (r) { refOther = r; refIdx = i; break; }
          }
          if (!refOther) {
            await sendTelegramReply(chatId,
              'รูปแบบไม่ถูกต้องครับ ตัวอย่าง:\n/เทียบ po2606025 ใบส่งของ กท.1002 12/6\nหรือ /เทียบ ใบส่งของ กท.1002 12/6 po2606025'
            );
            res.status(200).json({ ok: true }); return;
          }
          let deliveryKw = words.filter((w,i) => i !== sIdx && i !== refIdx).join(' ').trim();
          if (!deliveryKw) {
            await sendTelegramReply(chatId, 'พิมพ์ชื่อโครงการของใบส่งของด้วยครับ เช่น /เทียบ po2606025 ใบส่งของ กท.1002');
            res.status(200).json({ ok: true }); return;
          }
          // ดึงวันที่จากท้าย deliveryKw (ถ้ามี)
          let cmpDateFilter = null;
          const cmpDm = deliveryKw.match(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\s*$/);
          if (cmpDm) { cmpDateFilter = parseDate(cmpDm[1]); deliveryKw = deliveryKw.replace(cmpDm[0],'').trim(); }

          if (!odooConfigured()) { await sendTelegramReply(chatId, '⚠️⚠️⚠️ ยังไม่ได้ตั้งค่า Odoo ครับ'); res.status(200).json({ ok: true }); return; }
          await sendTelegramReply(chatId, '🔍 กำลังค้นหาใบส่งของ "' + deliveryKw + '"...');

          try {
            const allPicks = await odooDelivery(deliveryKw, cmp.id);
            let picks = allPicks;
            if (cmpDateFilter) {
              const f = picks.filter(p => String(p.scheduled_date || '').slice(0,10) === cmpDateFilter);
              if (f.length) picks = f;
            }
            if (!picks.length) {
              await sendTelegramReply(chatId, '🔍 ไม่พบใบส่งของ "' + deliveryKw + '"' + (cmpDateFilter ? ' วันที่ ' + cmpDm[1] : '') + ' ครับ');
              res.status(200).json({ ok: true }); return;
            }
            if (picks.length > 1) {
              const opts = picks.slice(0,15).map((p,i) =>
                (i+1) + '. ' + (p.name || '-') + (p.scheduled_date ? ' (' + String(p.scheduled_date).slice(0,10) + ')' : '') + (p.company_id ? '  [' + coLabel(p.company_id) + ']' : '')
              ).join('\n');
              await db.from('tg_compare_select').upsert({
                chat_id: String(chatId),
                picks: picks.slice(0,15),
                doc_ref: refOther,
                company_id: cmp.id,
                created_at: new Date().toISOString()
              }, { onConflict: 'chat_id' });
              await sendTelegramReply(chatId, '🔍 พบ ' + picks.length + ' ใบส่งของที่ตรงกับ "' + deliveryKw + '":\n' + opts + '\n\nตอบเลขที่ต้องการครับ');
              res.status(200).json({ ok: true }); return;
            }
            await sendDeliveryCompareTG(chatId, refOther, picks[0], cmp);
          } catch (e) {
            await sendTelegramReply(chatId, '⚠️⚠️⚠️ เปรียบเทียบไม่สำเร็จ: ' + e.message);
          }
          res.status(200).json({ ok: true }); return;
        }

        // ── mode 1: เทียบ SO/PO/PR กันเอง (แบบเดิม) ──────────────────────────
        const parts = words;
        if (parts.length < 2) {
          await sendTelegramReply(chatId, 'พิมพ์ให้ครบครับ เช่น /เทียบ so1234 po5678\nหรือ /เทียบ so1234 po5678 md\nหรือ /เทียบ po2606025 ใบส่งของ กท.1002 12/6');
          res.status(200).json({ ok: true }); return;
        }
        const refA = parseDocRef(parts[0]);
        const refB = parseDocRef(parts[1]);
        if (!refA || !refB) {
          await sendTelegramReply(chatId, 'รูปแบบไม่ถูกต้องครับ ตัวอย่าง: /เทียบ so1234 po5678');
          res.status(200).json({ ok: true }); return;
        }
        if (!odooConfigured()) { await sendTelegramReply(chatId, '⚠️⚠️⚠️ ยังไม่ได้ตั้งค่า Odoo ครับ'); res.status(200).json({ ok: true }); return; }
        await sendTelegramReply(chatId, '⏳ กำลังดึงข้อมูลเปรียบเทียบ...');
        try {
          const compareData = await odooCompare(refA.type, refA.num, refB.type, refB.num, cmp.id);
          const labelA = refA.type.toUpperCase() + refA.num;
          const labelB = refB.type.toUpperCase() + refB.num;

          const rows = compareData.rows || [];
          const cntOk   = rows.filter(r=>r.status==='ok').length;
          const cntDiff = rows.filter(r=>r.status==='diff').length;
          const cntMis  = rows.filter(r=>r.status==='missing_a' || r.status==='missing_b').length;

          const viewId = 'C' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();
          const { error: insErr } = await db.from('delivery_views').insert({
            id: viewId,
            title: 'เปรียบเทียบ ' + labelA + ' vs ' + labelB,
            company: cmp.name || '',
            status_label: cmp.name || '',
            data: {
              typeA: refA.type, numA: refA.num, typeB: refB.type, numB: refB.num,
              docA: compareData.docA, docB: compareData.docB,
              rows
            }
          });
          if (insErr) { await sendTelegramReply(chatId, '⚠️⚠️⚠️ บันทึกข้อมูลไม่สำเร็จ: ' + insErr.message); res.status(200).json({ ok: true }); return; }

          const webLink = 'https://inventory-rho-hazel.vercel.app/compare.html?id=' + viewId;
          await sendTelegramReply(chatId,
            '📊 เปรียบเทียบ ' + labelA + ' vs ' + labelB + ' (' + cmp.name + ')\n\n' +
            '✅ ตรงกัน: ' + cntOk + ' รายการ\n' +
            (cntDiff ? '⚠️ ต่างกัน: ' + cntDiff + ' รายการ\n' : '') +
            (cntMis  ? '❌ ขาด: ' + cntMis  + ' รายการ\n' : '') +
            '\n📎 เปิดดูรายละเอียด:\n' + webLink
          );
        } catch (e) {
          await sendTelegramReply(chatId, '⚠️⚠️⚠️ เปรียบเทียบไม่สำเร็จ: ' + e.message);
        }
        res.status(200).json({ ok: true }); return;
      }

      // ── /ลงรูป (ยกเลิกแล้ว) → แนะนำให้ใช้ /รายงาน แทน ──────────────────────
      if (cmdText.startsWith('/ลงรูป') || lc.startsWith('/uploadphoto')) {
        await sendTelegramReply(chatId,
          'คำสั่ง /ลงรูป ถูกรวมเข้ากับ /รายงาน แล้วครับ\n\n' +
          'ใช้ /รายงาน แทนได้เลย เช่น:\n' +
          '/รายงาน กท.1002 12/6\n' +
          '/รายงาน po2606001\n\n' +
          'บอทจะให้ส่งรูป → พิมพ์ /จบรายงาน → ได้ทั้งอัปรูปเข้า Odoo และรายงานในครั้งเดียว'
        );
        res.status(200).json({ ok: true }); return;
      }

      // ── /จบรายงาน → อัปรูปเข้า Odoo เสร็จแล้ว ดึงรายงานเต็ม (ชื่องาน+รูป) ส่งไปปลายทาง ──
      if (cmdText.startsWith('/จบรายงาน') || lc.startsWith('/endreport')) {
        if (db) {
          const { data: sess } = await db.from('tg_report_session')
            .select('*').eq('chat_id', String(chatId)).maybeSingle();
          if (!sess || !sess.doc_model) {
            await sendTelegramReply(chatId, '⚠️ ไม่มี session รายงานที่เปิดอยู่ครับ');
            res.status(200).json({ ok: true }); return;
          }

          const repTarget = sess.options || '__self__';
          const LINE_GROUPS = {
            'ฟ้า': 'C9adc5d856cc04bdefa31523f8c98a520',
            'เทส':  'Cd888f9bcfe77f27d6ad9b488a6bb24bc',
            'ชุบ':  'C0479aa47a7c02d6c7c0dd6346142391b'
          };

          await sendTelegramReply(chatId, '✅ อัปรูป ' + (sess.uploaded || 0) + ' รูปเข้า Odoo แล้ว กำลังสร้างรายงาน...');

          try {
            const { odooFindDoc, odooDelivery } = await import('./odoo.js');
            if (sess.doc_model === 'stock.picking' && sess.extra_names && sess.extra_names.length) {
              // ── โหมดหลายใบ: รวมรายการจากทุกใบ (รูปอยู่ที่ใบแรกเท่านั้น) ──
              const picks = await odooDelivery(sess.doc_name, null);
              const primary = (picks || []).find(p => Number(p.id) === Number(sess.doc_id)) || (picks && picks[0]);
              const extraPicks = [];
              for (const exName of sess.extra_names) {
                try {
                  const found = (picks || []).find(p => p.name === exName);
                  if (found) { extraPicks.push(found); continue; }
                  // ชื่อนี้ไม่อยู่ใน batch เดิม (คนละ keyword ที่ค้นได้) → ค้นแยกด้วยชื่อใบตรงๆ
                  const exPicks = await odooDelivery(exName, null);
                  const exMatch = (exPicks || []).find(p => p.name === exName) || (exPicks && exPicks[0]);
                  if (exMatch) extraPicks.push(exMatch);
                } catch (e) { /* ใบนี้ดึงไม่ได้ ข้าม ไม่ทำให้รายงานทั้งหมดพัง */ }
              }
              if (primary) {
                await sendReportMulti(chatId, [primary, ...extraPicks], repTarget, LINE_GROUPS);
              } else {
                await sendTelegramReply(chatId, '⚠️ อัปรูปเรียบร้อย แต่ดึงรายงานไม่สำเร็จ (ไม่พบใบส่งของหลัก)');
              }
            } else if (sess.doc_model === 'stock.picking') {
              // ดึง picking ล่าสุด (พร้อมรูปที่เพิ่งอัป) ตามชื่อ แล้วส่งรายงาน
              const picks = await odooDelivery(sess.doc_name, null);
              const matched = (picks || []).find(p => Number(p.id) === Number(sess.doc_id)) || (picks && picks[0]);
              if (matched) {
                await sendReport(chatId, matched, repTarget, LINE_GROUPS, db);
              } else {
                await sendTelegramReply(chatId, '⚠️ อัปรูปเรียบร้อย แต่ดึงรายงานไม่สำเร็จ (ไม่พบใบส่งของ)');
              }
            } else {
              // po/so/pr/mo → ใช้ model+id ที่เก็บไว้ใน session ตรงๆ (ไม่ต้องค้นซ้ำ)
              const doc = { model: sess.doc_model, id: sess.doc_id, name: sess.doc_name };
              await sendReportDoc(chatId, doc, repTarget, LINE_GROUPS);
            }
          } catch(e) {
            await sendTelegramReply(chatId, '⚠️ อัปรูปเรียบร้อย แต่สร้างรายงานไม่สำเร็จ: ' + e.message);
          }

          await db.from('tg_report_session').delete().eq('chat_id', String(chatId));
        }
        res.status(200).json({ ok: true }); return;
      }

      // ── /รับคืนหน้างาน [ชื่องาน] → เปิด session รอรูป+ข้อความ ────────────────
      if (cmdText.startsWith('/รับคืนหน้างาน') || lc.startsWith('/returnsite')) {
        const jobName = cmdText.replace(/^\/รับคืนหน้างาน/, '').replace(/^\/returnsite/i, '').trim();
        if (!jobName) {
          await sendTelegramReply(chatId,
            'พิมพ์ชื่องานต่อท้ายด้วยครับ เช่น:\n' +
            '/รับคืนหน้างาน ติดตั้งเสาไฟ กท.1002 ช่วงสะพาน'
          );
          res.status(200).json({ ok: true }); return;
        }
        if (!db) { await sendTelegramReply(chatId, '⚠️ ยังไม่ได้เชื่อมต่อฐานข้อมูลครับ'); res.status(200).json({ ok: true }); return; }

        // วันที่รับ = วันที่เรียกคำสั่ง (เวลาไทย)
        const nowTh = new Date(Date.now() + 7 * 60 * 60 * 1000);
        const recvDate = nowTh.toISOString().slice(0, 10); // YYYY-MM-DD

        // สร้าง draft ใน delivery_views (เก็บข้อมูลระหว่างทาง) — ไม่ต้องแก้ schema
        const draftId = 'RK' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();
        const { error: draftErr } = await db.from('delivery_views').insert({
          id: draftId,
          title: 'รับคืนหน้างาน — ' + jobName,
          status_label: 'draft',
          data: { rabkuen: true, jobName: jobName, recvDate: recvDate, images: [], notes: [] }
        });
        if (draftErr) { await sendTelegramReply(chatId, '⚠️ เริ่มรับคืนไม่สำเร็จ: ' + draftErr.message); res.status(200).json({ ok: true }); return; }

        // เปิด session — ใช้ field ที่มีจริงในตาราง (mode + doc_name เก็บ draftId)
        await db.from('tg_report_session').upsert({
          chat_id: String(chatId),
          mode: 'rabkuen',
          doc_id: 0,
          doc_name: draftId,
          updated_at: new Date().toISOString()
        }, { onConflict: 'chat_id' });

        await sendTelegramReply(chatId,
          '📋 เปิดรับคืนหน้างานแล้วครับ\n' +
          'งาน: ' + jobName + '\n' +
          'วันที่รับ: ' + recvDate.split('-').reverse().join('/') + '\n\n' +
          '📷 ขอรูปถ่ายประกอบด้วยครับ — ส่งรูปเข้ากลุ่มได้เลย (ส่งกี่รูปก็ได้)\n' +
          '✍️ พิมพ์ข้อความประกอบได้ (จะเป็น caption ติดรูป หรือพิมพ์แยกก็ได้)\n\n' +
          'เมื่อครบแล้วพิมพ์ /จบรับคืน'
        );
        res.status(200).json({ ok: true }); return;
      }

      // ── /จบรับคืน → ปิด session สร้างหน้าดูรูป + ตอบสรุป ────────────────────
      if (cmdText.startsWith('/จบรับคืน') || lc.startsWith('/endreturn')) {
        if (!db) { await sendTelegramReply(chatId, '⚠️ ยังไม่ได้เชื่อมต่อฐานข้อมูลครับ'); res.status(200).json({ ok: true }); return; }
        const { data: sess } = await db.from('tg_report_session')
          .select('*').eq('chat_id', String(chatId)).maybeSingle();
        if (!sess || sess.mode !== 'rabkuen') {
          await sendTelegramReply(chatId, '⚠️ ไม่มีรายการรับคืนที่เปิดอยู่ครับ\nเริ่มด้วย /รับคืนหน้างาน [ชื่องาน]');
          res.status(200).json({ ok: true }); return;
        }

        const draftId = sess.doc_name;
        const { data: draft } = await db.from('delivery_views').select('*').eq('id', draftId).maybeSingle();
        const ex = draft && draft.data ? draft.data : null;
        if (!ex) {
          await sendTelegramReply(chatId, '⚠️ ไม่พบข้อมูลรับคืน (อาจหมดอายุ) — เริ่มใหม่ด้วย /รับคืนหน้างาน [ชื่องาน]');
          await db.from('tg_report_session').delete().eq('chat_id', String(chatId));
          res.status(200).json({ ok: true }); return;
        }

        const images = Array.isArray(ex.images) ? ex.images : [];
        const notes = Array.isArray(ex.notes) ? ex.notes : [];
        const noteText = notes.join(' • ');
        const dateThai = (ex.recvDate || '').split('-').reverse().join('/');

        // แปลง draft → view สมบูรณ์ (เขียนทับ record เดิม — ใช้ id เดิม)
        const picks = [{
          name: ex.jobName,
          origin: '',
          partner: '',
          date: dateThai,
          statusText: 'รับคืนหน้างาน',
          statusColor: 'green',
          lines: noteText ? [{ name: noteText, qty: '', uom: '' }] : [],
          images: images.map((im, i) => ({ id: im.url, name: 'รูปที่ ' + (i + 1), directUrl: im.url }))
        }];

        const { error: updErr } = await db.from('delivery_views').update({
          status_label: 'รับเมื่อ ' + dateThai,
          data: { summary: { total: 1 }, picks, rabkuen: true, jobName: ex.jobName, recvDate: ex.recvDate, note: noteText, images, notes }
        }).eq('id', draftId);
        if (updErr) {
          await sendTelegramReply(chatId, '⚠️ บันทึกไม่สำเร็จ: ' + updErr.message);
          res.status(200).json({ ok: true }); return;
        }

        const viewUrl = 'https://inventory-rho-hazel.vercel.app/delivery.html?id=' + draftId;
        let reply = '✅ รับคืนหน้างานเรียบร้อยครับ\n\n' +
          '📋 ชื่องาน: ' + ex.jobName + '\n' +
          '📅 วันที่รับ: ' + dateThai + '\n';
        if (noteText) reply += '📝 หมายเหตุ: ' + noteText + '\n';
        reply += '📷 รูปถ่าย: ' + images.length + ' รูป\n\n' +
          '🔗 กดดูรูปภาพ:\n' + viewUrl;
        await sendTelegramReply(chatId, reply);

        await db.from('tg_report_session').delete().eq('chat_id', String(chatId));
        res.status(200).json({ ok: true }); return;
      }

      if (cmdText.startsWith('/ใบส่งของ') || cmdText.startsWith('/ส่งของ') || cmdText.startsWith('/จัดส่ง') || lc.startsWith('/delivery')) {
        var kw = cmdText.replace(/^\/ใบส่งของ/, '').replace(/^\/ส่งของ/, '').replace(/^\/จัดส่ง/, '').replace(/^\/delivery/i, '').trim();
        if (!kw) {
          await sendTelegramReply(chatId, 'พิมพ์ชื่อโครงการหรือเลขใบด้วยครับ เช่น /ใบส่งของ อุตรดิตถ์\nพิมพ์ต่อท้ายได้: รอ / ส่งแล้ว / ทั้งหมด');
        } else {
          // ดึง statusFilter จากคำท้าย (default = รอส่ง) รองรับ status ก่อน company
          var statusFilter = 'pending';
          var statusGiven = false;
          var statusRe = /\s+(ทั้งหมด|all|ส่งแล้ว|เสร็จแล้ว|done|รอส่ง|รอ|pending)(\s+(?:md|cg|sep|akn|set))?\s*$/i;
          kw = kw.replace(statusRe, function(match, st, comp) {
            statusGiven = true;
            var ml = st.toLowerCase();
            if (['ทั้งหมด','all'].includes(ml))                    statusFilter = 'all';
            else if (['ส่งแล้ว','เสร็จแล้ว','done'].includes(ml)) statusFilter = 'done';
            else                                                    statusFilter = 'pending';
            return comp ? comp : '';
          }).trim();

          // ดึงวันที่ Scheduled (ถ้ามี) เช่น "กท.1002 12/6"
          var dateFilter = null;
          var dmTg = kw.match(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\s*$/);
          if (dmTg) {
            dateFilter = parseDate(dmTg[1]);
            kw = kw.replace(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\s*$/, '').trim();
            if (!statusGiven) statusFilter = 'all';
          }

          var label = statusFilter === 'done' ? 'ส่งแล้ว' : statusFilter === 'all' ? 'ทั้งหมด' : 'รอส่ง';
          var dateNote = dmTg ? ' วันที่ ' + dmTg[1] : '';
          await sendTelegramReply(chatId, '⏳ กำลังสร้างใบส่งของ [' + label + ']' + dateNote + ' ของ "' + kw + '" ครับ...');
          await sendDeliveryPDF(chatId, kw, statusFilter, dateFilter);
          res.status(200).json({ ok: true });
          return;
        }
        res.status(200).json({ ok: true });
        return;
      }

      const reply = await handleTelegramCommand(cmdText);
      if (reply) await sendTelegramReply(chatId, reply);
      res.status(200).json({ ok: true });
      return;
    }

    // ── ตอบเลือกใบ (1 หรือ 1 2 หรือ 1,2) → เช็ค session ต่างๆ ──────────────────
    // แยกเลขทั้งหมดจากข้อความ เช่น "1 2" → [1,2] | "1,2" → [1,2] | "1 และ 2" → [1,2]
    const pickedNums = trimmed.match(/\d+/g) ? trimmed.match(/\d+/g).map(n => parseInt(n)) : [];
    // รับเฉพาะข้อความที่เป็นตัวเลข + ตัวคั่น (เว้นวรรค , และ "และ") เท่านั้น กันชนกับข้อความอื่น
    const isNumberReply = /^[\d\s,และ]+$/.test(trimmed) && pickedNums.length > 0;
    if (isNumberReply && db) {
      const isSingleNum = pickedNums.length === 1;

      // session เลือก Operation Type สำหรับ /นำเข้าใบส่งของ
      const { data: impSess2 } = await db.from('tg_report_session')
        .select('*').eq('chat_id', String(chatId)).maybeSingle();
      const impAge2 = impSess2 ? (Date.now() - new Date(impSess2.updated_at).getTime()) / 60000 : 999;
      if (impSess2 && impSess2.mode === 'import_optype_select' && impAge2 < 5 && isSingleNum) {
        const idx = pickedNums[0] - 1;
        const opts = impSess2.options || [];
        if (idx < 0 || idx >= opts.length) {
          await sendTelegramReply(chatId, '⚠️ กรุณาตอบเลข 1-' + opts.length + ' ครับ');
        } else {
          const chosen = opts[idx];
          await db.from('tg_report_session').update({
            mode: 'import_delivery',
            doc_id: chosen.id,
            doc_name: chosen.name,
            updated_at: new Date().toISOString()
          }).eq('chat_id', String(chatId));
          await sendTelegramReply(chatId, '✅ เลือกโครงการ:\n<b>' + tgEsc(chosen.name) + '</b>\n\n📎 กรุณาแนบไฟล์ Excel ใบส่งของในข้อความถัดไปได้เลยครับ\n<i>(พิมพ์ /ยกเลิก เพื่อยกเลิก)</i>');
        }
        res.status(200).json({ ok: true }); return;
      }

      // session เลือกใบส่งของสำหรับ /รายงาน — รองรับหลายเลข
      const { data: selSess2 } = await db.from('tg_report_select')
        .select('*').eq('chat_id', String(chatId)).maybeSingle();
      const selAge2 = selSess2 ? (Date.now() - new Date(selSess2.created_at).getTime()) / 60000 : 999;
      if (selSess2 && selAge2 < 5) {
        const picks = selSess2.picks || [];
        const LINE_GROUPS3 = {
          'ฟ้า': 'C9adc5d856cc04bdefa31523f8c98a520',
          'เทส':  'Cd888f9bcfe77f27d6ad9b488a6bb24bc',
          'ชุบ':  'C0479aa47a7c02d6c7c0dd6346142391b'
        };
        // เลือกได้หลายใบ — ใบแรกที่เลือก (ตามลำดับเลขที่พิมพ์) รับรูป ที่เหลือรวมรายการอย่างเดียว
        const validNums = [...new Set(pickedNums)].filter(n => n >= 1 && n <= picks.length);
        if (!validNums.length) {
          await sendTelegramReply(chatId, '⚠️ กรุณาตอบเลข 1-' + picks.length + ' ครับ (เลือกหลายใบได้ เช่น 1 3 5)');
        } else {
          const chosenPicks = validNums.map(n => picks[n - 1]);
          const onePick = chosenPicks[0];
          const extraPicks = chosenPicks.slice(1);
          await db.from('tg_report_select').delete().eq('chat_id', String(chatId));
          // เปิด session รอรูป (เก็บ target ไว้ใช้ตอน /จบรายงาน)
          await db.from('tg_report_session').upsert({
            chat_id: String(chatId),
            doc_type: 'picking', doc_id: onePick.id, doc_name: onePick.name, doc_model: 'stock.picking',
            uploaded: 0, options: selSess2.target || '__self__',
            extra_ids: extraPicks.map(p => p.id),
            extra_names: extraPicks.map(p => p.name),
            updated_at: new Date().toISOString()
          }, { onConflict: 'chat_id' });
          const chosenList = chosenPicks.map((p,i) => (i+1) + '. ' + p.name + (p.company_id ? '  [' + coLabel(p.company_id) + ']' : '')).join('\n');
          await sendTelegramReply(chatId,
            '✅ เลือก ' + chosenPicks.length + ' ใบแล้วครับ!\n' + chosenList +
            '\n\n📷 ส่งรูปเข้ากลุ่มได้เลย (รูปจะลงที่ใบแรก: ' + onePick.name + ')\n' +
            (extraPicks.length ? 'รายการสินค้าจากทุกใบจะแสดงในรายงานเดียวกัน\n' : '') +
            'พิมพ์ /จบรายงาน เมื่อส่งรูปครบ'
          );
        }
        res.status(200).json({ ok: true }); return;
      }

      // session เลือกใบส่งของสำหรับ /เทียบ
      const { data: cmpSess2 } = await db.from('tg_compare_select')
        .select('*').eq('chat_id', String(chatId)).maybeSingle();
      const cmpAge2 = cmpSess2 ? (Date.now() - new Date(cmpSess2.created_at).getTime()) / 60000 : 999;
      if (cmpSess2 && cmpAge2 < 5 && isSingleNum) {
        const idx = pickedNums[0] - 1;
        const picks = cmpSess2.picks || [];
        if (idx < 0 || idx >= picks.length) {
          await sendTelegramReply(chatId, '⚠️ กรุณาตอบเลข 1-' + picks.length + ' ครับ');
        } else {
          await db.from('tg_compare_select').delete().eq('chat_id', String(chatId));
          await sendTelegramReply(chatId, '⏳ กำลังดึงข้อมูลเปรียบเทียบ...');
          const cmpCompany2 = companyById(cmpSess2.company_id);
          await sendDeliveryCompareTG(chatId, cmpSess2.doc_ref, picks[idx], cmpCompany2);
        }
        res.status(200).json({ ok: true }); return;
      }
    }

    // ── เส้นทางที่ 2: กลุ่มย่อย + @บอท + Reply → บันทึกงาน ──────────────────
    if (chatType === 'sub') {
      // ตรวจว่ามีการ @บอท ในข้อความหรือ caption ไหม
      const msgText    = msg.text || msg.caption || '';
      const mentioned  = BOT_USERNAME
        ? new RegExp('@' + BOT_USERNAME + '\\b', 'i').test(msgText)
        : (msg.entities || msg.caption_entities || []).some(e => e.type === 'mention');

      if (mentioned && msg.reply_to_message) {
        const replyMsg = msg.reply_to_message;
        // ดึงข้อความจาก reply (รองรับทั้ง text และ caption ของรูป/ไฟล์)
        const originalText = replyMsg.text || replyMsg.caption || '';
        if (!originalText) {
          await sendTelegramReply(chatId, '❌ ไม่พบข้อความในข้อความที่ Reply ครับ');
          res.status(200).json({ ok: true }); return;
        }
        const fromUser = msg.from
          ? (msg.from.first_name || '') + (msg.from.last_name ? ' ' + msg.from.last_name : '')
          : '';
        // ดึง keyword หมวดหมู่จากข้อความที่พิมพ์ต่อจาก @บอท เช่น "@บอท so" → catKeyword = "so"
        const botMentionText = msgText.replace(new RegExp('@' + (BOT_USERNAME || '[\\w]+') + '\\b', 'gi'), '').trim();
        const catKeyword = botMentionText.toLowerCase();

        // ── ตรวจว่าเป็นการ "แก้วันที่" หรือไม่ ──
        var hasEditWord = botMentionText.indexOf('แก้')>=0 || botMentionText.indexOf('เปลี่ยน')>=0 || botMentionText.indexOf('เลื่อน')>=0;
        var dmEdit = botMentionText.match(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/);
        if (hasEditWord && dmEdit) {
          const newDate = parseDate(dmEdit[1]);
          if (!newDate) {
            await sendTelegramReply(chatId, '❌ ไม่เข้าใจวันที่ครับ ลองพิมพ์ เช่น "แก้เป็น 15/6"');
            res.status(200).json({ ok: true }); return;
          }
          const upd = await updateTaskDateByMessage(replyMsg.message_id, newDate);
          if (upd.ok) {
            await sendTelegramReply(chatId, '✅ แก้ไขเรียบร้อยครับ\n📅 เปลี่ยนเป็น ' + upd.dateDisplay);
            await notifyMainChat('✏️ <b>แก้ไขวันที่งาน</b>\n\n📋 ' + upd.task.task + '\n📅 เปลี่ยนเป็น ' + upd.dateDisplay + (fromUser ? '\n✍️ โดย: ' + fromUser : ''));
          } else if (upd.notFound) {
            await sendTelegramReply(chatId, '❌ ไม่พบงานเดิมที่ผูกกับข้อความนี้ครับ\n(งานอาจถูกบันทึกก่อนเปิดระบบแก้ไข)');
          } else {
            await sendTelegramReply(chatId, '❌ แก้ไขไม่สำเร็จ: ' + (upd.error || ''));
          }
          res.status(200).json({ ok: true }); return;
        }

        // ── ดึง file_id จากรูป/ไฟล์ — ดูทั้งจาก msg ปัจจุบัน และ replyMsg ──
        let fileUrl = null;
        let fileName = null;
        const tgToken = process.env.TELEGRAM_BOT_TOKEN || '';

        // หาไฟล์จาก msg ปัจจุบัน หรือ replyMsg (อันไหนมีก่อนใช้อันนั้น)
        const fileSource = (msg.photo || msg.document) ? msg : replyMsg;

        // รูปภาพ
        if (fileSource.photo && fileSource.photo.length > 0 && tgToken) {
          const photo = fileSource.photo[fileSource.photo.length - 1];
          try {
            const infoRes = await fetch(`https://api.telegram.org/bot${tgToken}/getFile?file_id=${photo.file_id}`);
            const info = await infoRes.json();
            if (info.ok) {
              fileUrl = `https://api.telegram.org/file/bot${tgToken}/${info.result.file_path}`;
              fileName = info.result.file_path.split('/').pop();
            }
          } catch(e) { console.error('photo fetch error:', e.message); }
        }
        // ไฟล์เอกสาร
        else if (fileSource.document && tgToken) {
          try {
            const infoRes = await fetch(`https://api.telegram.org/bot${tgToken}/getFile?file_id=${fileSource.document.file_id}`);
            const info = await infoRes.json();
            if (info.ok) {
              fileUrl = `https://api.telegram.org/file/bot${tgToken}/${info.result.file_path}`;
              fileName = fileSource.document.file_name || info.result.file_path.split('/').pop();
            }
          } catch(e) { console.error('document fetch error:', e.message); }
        }

        // ── อัปโหลดไฟล์ไปยัง Supabase Storage ───────────────────────────
        let attachmentObj = null;
        if (fileUrl && db) {
          try {
            const fileRes = await fetch(fileUrl);
            const arrayBuffer = await fileRes.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const ext = fileName ? fileName.split('.').pop() : 'jpg';
            const storageName = 'tg_' + Date.now() + '.' + ext;
            const { data: upData, error: upErr } = await db.storage
              .from('attachments')
              .upload(storageName, buffer, { contentType: fileRes.headers.get('content-type') || 'application/octet-stream', upsert: false });
            if (!upErr) {
              const { data: urlData } = db.storage.from('attachments').getPublicUrl(storageName);
              attachmentObj = { name: fileName || storageName, wl: urlData?.publicUrl || '', source: 'telegram' };
            }
          } catch(e) { console.error('upload error:', e.message); }
        }

        // ── บันทึกงานพร้อมไฟล์แนบ ────────────────────────────────────────
        // chat 2 (sub) = กลุ่มงานรับเท่านั้น → บังคับประเภทเป็น 'รับ' เสมอ
        // (ไม่สนใจคำว่า ส่งของ/จัดส่ง ที่อาจมีในข้อความงานต้นฉบับ)
        const result = await saveTaskFromReply(originalText, fromUser, chatId, attachmentObj, catKeyword, replyMsg.message_id, 'รับ');

        if (result.ok) {
          // จำงานล่าสุดของกลุ่มนี้ (สำหรับ +1 +2 แนบไฟล์)
          try {
            await db.from('tg_last_task').upsert({
              chat_id: String(chatId),
              task_id: result.taskId,
              task_name: result.taskName,
              created_at: new Date().toISOString()
            }, { onConflict: 'chat_id' });
          } catch(e) {}

          const fileNote = attachmentObj ? '\n📎 แนบไฟล์: ' + attachmentObj.name : '';
          await sendTelegramReply(chatId, '✅ บันทึกเรียบร้อยครับ' + fileNote);
          const fileLink = attachmentObj ? '\n📎 <a href="' + attachmentObj.wl + '">' + attachmentObj.name + '</a>' : '';
          await notifyMainChat(result.mainMsg + fileLink);
        } else {
          await sendTelegramReply(chatId, `❌ บันทึกไม่สำเร็จครับ: ${result.error}`);
        }
        res.status(200).json({ ok: true });
        return;
      }

      // ── @บอท +1/+2/... + reply รูป/ไฟล์ → แนบเข้างานล่าสุด ──────────────
      if (mentioned && msg.reply_to_message) {
        const msgText2 = msg.text || msg.caption || '';
        const botMentionText2 = msgText2.replace(new RegExp('@' + (BOT_USERNAME || '[\\w]+') + '\\b', 'gi'), '').trim();
        if (/^\+\d+$/.test(botMentionText2)) {
          const replyMsg2 = msg.reply_to_message;
          const tgToken2 = process.env.TELEGRAM_BOT_TOKEN || '';

          // หางานล่าสุดของกลุ่ม
          const { data: last } = await db.from('tg_last_task')
            .select('task_id, task_name').eq('chat_id', String(chatId)).maybeSingle();
          if (!last || !last.task_id) {
            await sendTelegramReply(chatId, '⚠️ ยังไม่มีงานในกลุ่มนี้ครับ กรุณาบันทึกงานก่อนแนบไฟล์');
            res.status(200).json({ ok: true }); return;
          }

          // ดึงไฟล์จาก reply
          let fileUrl2 = null, fileName2 = null, contentType2 = 'application/octet-stream';
          const fileSource2 = (msg.photo || msg.document) ? msg : replyMsg2;

          if (fileSource2.photo && fileSource2.photo.length > 0 && tgToken2) {
            const photo = fileSource2.photo[fileSource2.photo.length - 1];
            try {
              const infoRes = await fetch(`https://api.telegram.org/bot${tgToken2}/getFile?file_id=${photo.file_id}`);
              const info = await infoRes.json();
              if (info.ok) {
                fileUrl2 = `https://api.telegram.org/file/bot${tgToken2}/${info.result.file_path}`;
                fileName2 = info.result.file_path.split('/').pop();
                contentType2 = 'image/jpeg';
              }
            } catch(e) {}
          } else if (fileSource2.document && tgToken2) {
            try {
              const infoRes = await fetch(`https://api.telegram.org/bot${tgToken2}/getFile?file_id=${fileSource2.document.file_id}`);
              const info = await infoRes.json();
              if (info.ok) {
                fileUrl2 = `https://api.telegram.org/file/bot${tgToken2}/${info.result.file_path}`;
                fileName2 = fileSource2.document.file_name || info.result.file_path.split('/').pop();
                contentType2 = fileSource2.document.mime_type || 'application/octet-stream';
              }
            } catch(e) {}
          }

          if (!fileUrl2) {
            await sendTelegramReply(chatId, '⚠️ ไม่พบรูป/ไฟล์ใน reply นั้นครับ');
            res.status(200).json({ ok: true }); return;
          }

          // อัปโหลดไปยัง Supabase Storage
          try {
            const fileRes2 = await fetch(fileUrl2);
            const arrayBuffer2 = await fileRes2.arrayBuffer();
            const compressed2 = await compressIfImage(Buffer.from(arrayBuffer2), contentType2);
            const buffer2 = compressed2.buffer;
            const ctUp2 = compressed2.contentType;
            const ext2 = (compressed2.contentType === 'image/jpeg' && contentType2 !== 'image/jpeg')
              ? 'jpg' : (fileName2 ? fileName2.split('.').pop() : 'jpg');
            const storagePath2 = last.task_id + '/' + Date.now() + '.' + ext2;

            const { error: upErr2 } = await db.storage.from('attachments')
              .upload(storagePath2, buffer2, { contentType: ctUp2, upsert: true });
            if (upErr2) { await sendTelegramReply(chatId, '❌ อัปไฟล์ไม่สำเร็จ: ' + upErr2.message); res.status(200).json({ ok: true }); return; }

            const { data: pub2 } = db.storage.from('attachments').getPublicUrl(storagePath2);

            // อัปเดต attachments ของงาน
            const { data: taskRow2 } = await db.from('tasks').select('attachments').eq('id', last.task_id).maybeSingle();
            let atts2 = Array.isArray(taskRow2?.attachments) ? taskRow2.attachments : [];
            atts2.push({ name: fileName2 || ('file.' + ext2), size: buffer2.length, fileId: storagePath2, mimeType: ctUp2, webViewLink: pub2.publicUrl, source: 'telegram' });

            const { error: updErr2 } = await db.from('tasks').update({ attachments: atts2 }).eq('id', last.task_id);
            if (updErr2) { await sendTelegramReply(chatId, '❌ บันทึกไฟล์ไม่สำเร็จ: ' + updErr2.message); res.status(200).json({ ok: true }); return; }

            await sendTelegramReply(chatId, '📎 แนบไฟล์เข้างานแล้วครับ!\n📋 ' + last.task_name + '\n📁 ไฟล์ทั้งหมด: ' + atts2.length + ' ไฟล์');
          } catch(e) {
            await sendTelegramReply(chatId, '❌ แนบไฟล์ไม่สำเร็จ: ' + e.message);
          }
          res.status(200).json({ ok: true }); return;
        }
      }

      // ── @บอท โดยไม่ได้ Reply → ค้นหางาน / ถาม AI ──────
      if (mentioned) {
        const userMsg = msgText.replace(new RegExp('@' + (BOT_USERNAME || '[\\w]+') + '\\b', 'gi'), '').trim();
        if (userMsg) {
          // ค้นหางานในระบบ ถ้าขึ้นต้นด้วย "ค้นหา"
          const lc = userMsg.toLowerCase();
          if (userMsg.startsWith('ค้นหา') || userMsg.startsWith('/ค้นหา') || lc.startsWith('search')) {
            const kw = userMsg.replace(/^\/?(ค้นหา|search)\s*/i, '').trim();
            const reply = await handleTelegramCommand('/ค้นหา ' + kw);
            if (reply) await sendTelegramReply(chatId, reply);
            res.status(200).json({ ok: true });
            return;
          }
          // ไม่งั้นถาม AI
          const history = getHistory(chatId);
          let webContext = null;
          if (needsWebSearch(userMsg) && TAVILY_KEY) webContext = await searchWeb(userMsg);
          const reply = await askGroq(userMsg, history, webContext);
          addHistory(chatId, 'user', userMsg);
          addHistory(chatId, 'assistant', reply);
          await sendTelegramReply(chatId, reply);
        }
        res.status(200).json({ ok: true });
        return;
      }

      res.status(200).json({ ok: true });
      return;
    }

    // ── เส้นทางที่ 3: กลุ่มหลัก @บอท → ถาม Groq ────────────────────────────
    let userMsg = null;
    if (BOT_USERNAME) {
      userMsg = extractMention(trimmed, BOT_USERNAME);
    } else {
      const entities = msg.entities || [];
      if (entities.some(e => e.type === 'mention'))
        userMsg = trimmed.replace(/@\w+/g, '').trim();
    }

    if (userMsg !== null && userMsg !== '') {
      const history = getHistory(chatId);
      let webContext = null;
      if (needsWebSearch(userMsg) && TAVILY_KEY) webContext = await searchWeb(userMsg);
      const reply = await askGroq(userMsg, history, webContext);
      addHistory(chatId, 'user', userMsg);
      addHistory(chatId, 'assistant', reply);
      await sendTelegramReply(chatId, reply);
    }

    res.status(200).json({ ok: true });
  } catch(e) {
    console.error('webhook error:', e.message);
    res.status(200).json({ ok: true });
  }
}
