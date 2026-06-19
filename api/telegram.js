// Telegram Webhook   
// - /คำสั่ง → คำสั่งสำเร็จรูป (ดูข้อมูลจาก Supabase)
// - @botname → ถาม Groq AI + ค้นเว็บด้วย Tavily ถ้าจำเป็น
// - กลุ่มใหม่: Reply ข้อความ แล้ว @บอท → บันทึกงานอัตโนมัติ
import { handleTelegramCommand, sendTelegramReply, isAllowedChat, getChatType, notifyMainChat, sendDeliveryPDF } from './rpc.js';
import { odooFindDoc, odooUploadAttachment, odooConfigured, odooDelivery, parseCompany, odooCompare, odooCompareWithDelivery, companyById } from './odoo.js';
import { createClient } from '@supabase/supabase-js';

const GROQ_KEY     = process.env.GROQ_API_KEY || '';
const TAVILY_KEY   = process.env.TAVILY_API_KEY || '';
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').toLowerCase();
const GROQ_MODEL   = 'llama-3.3-70b-versatile';

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const db = (SUPABASE_URL && SERVICE_KEY)
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const rid = () => 'T' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2,5).toUpperCase();
const todayStr = () => new Date().toISOString().slice(0,10);

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

function parseTaskFromText(text, catKeyword, forceDuration) {
  const t = text.trim();
  const kw = (catKeyword || '').trim();

  // ── วันที่ — ดึงจาก catKeyword ก่อน (สิ่งที่พิมพ์ต่อจาก @บอท) แล้วค่อย fallback ไปหาในข้อความ ──
  const dateRe = /(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/;
  const dateFromKw = kw.match(dateRe);
  const dateFromText = t.match(/(?:วันที่\s*)?(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/);
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
  const categories = CAT_MAP[kwClean] || (kwClean ? 'งานอื่นๆ' : 'งานอื่นๆ');

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
async function saveTaskFromReply(text, fromUser, chatId, attachmentObj = null, catKeyword = '', messageId = null, forceDuration = null) {
  if (!db) return { ok: false, error: 'ยังไม่ได้เชื่อมต่อฐานข้อมูลครับ' };

  const taskData = parseTaskFromText(text, catKeyword, forceDuration);
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

    const msg =
      '📊 รายงาน: ' + name + '\n' +
      (origin ? '📋 โครงการ: ' + origin + '\n' : '') +
      '📅 วันที่: ' + date + '\n' +
      '📷 รูปงาน: ' + images.length + ' รูป\n\n' +
      '📦 รายการสินค้า' + (totalLines > 5 ? ' (5 จาก ' + totalLines + ')' : '') + ':\n' +
      lineItems + '\n\n' +
      '📎 ดูรายละเอียดพร้อมรูป:\n' + webLink + '\n\n' +
      'เรียบร้อยครับ ✅';

    const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

    if (target === '__self__' || target === 'เทเลแกรม') {
      // __self__ → ส่งกลับกลุ่มที่พิมพ์คำสั่ง | เทเลแกรม → ส่งเข้า TELEGRAM_CHAT_ID_2
      const destId = target === '__self__' ? String(fromChatId) : (process.env.TELEGRAM_CHAT_ID_2 || '');
      if (!destId) { await sendTelegramReply(fromChatId, '⚠️⚠️⚠️ ไม่พบ TELEGRAM_CHAT_ID_2 ใน env'); return; }
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: destId, text: msg })
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
        body: JSON.stringify({ to: groupId, messages: [{ type: 'text', text: msg }] })
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
      picksData.push({
        name: p.name,
        origin: p.origin || '',
        partner: Array.isArray(p.partner_id) ? p.partner_id[1] : '',
        date: String(p.scheduled_date || '').slice(0, 10),
        statusText: stMap[p.state] || 'รอส่ง',
        statusColor: p.state === 'done' ? 'red' : (p.state === 'cancel' ? 'gray' : 'green'),
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
        '   ' + p.lines.length + ' รายการสินค้า'
      ).join('\n') + '\n\n' +
      '📎 ดูรายละเอียดพร้อมรูป:\n' + webLink + '\n\nเรียบร้อยครับ ✅';

    const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
    if (target === '__self__' || target === 'เทเลแกรม') {
      const destId = target === '__self__' ? String(fromChatId) : (process.env.TELEGRAM_CHAT_ID_2 || '');
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: destId, text: msg })
      });
      if (target !== '__self__') {
        await sendTelegramReply(fromChatId, '✅ ส่งรายงาน ' + picksData.length + ' ใบเข้า Telegram เรียบร้อยครับ');
      }
    } else {
      const groupId = lineGroups[target];
      const LINE_TOKEN = process.env.LINE_CHANNEL_TOKEN || '';
      await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_TOKEN },
        body: JSON.stringify({ to: groupId, messages: [{ type: 'text', text: msg }] })
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
      return (i+1) + '. ' + pname.slice(0, 50) + ' — ' + (l.qty || 0) + ' ' + (l.uom || '');
    }).join('\n');
    if (totalLines > 5) lineItems += '\n... และอีก ' + (totalLines-5) + ' รายการ';

    // สร้าง delivery_views (ใช้โครงสร้างเดียวกับใบส่งของ)
    const SB_URL = process.env.SUPABASE_URL;
    const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const sbdb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

    const picksData = [{
      name: d.name,
      origin: '',
      partner: d.partner || '',
      date: d.date || '',
      statusText: '',
      statusColor: 'green',
      lines: (d.lines || []).map(l => ({ name: l.name, qty: l.qty, uom: l.uom })),
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

    const msg =
      '📊 รายงาน: ' + d.name + '\n' +
      (d.partner ? (d.partnerLabel || 'คู่ค้า') + ': ' + d.partner + '\n' : '') +
      '📅 วันที่: ' + (d.date || '-') + '\n' +
      (d.total ? '💰 ยอดรวม: ' + d.total.toLocaleString('th-TH') + ' บาท\n' : '') +
      '📷 รูปงาน: ' + images.length + ' รูป\n\n' +
      '📦 รายการสินค้า' + (totalLines > 5 ? ' (5 จาก ' + totalLines + ')' : '') + ':\n' +
      lineItems + '\n\n' +
      '📎 ดูรายละเอียดพร้อมรูป:\n' + webLink + '\n\n' +
      'เรียบร้อยครับ ✅';

    const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
    if (target === '__self__' || target === 'เทเลแกรม') {
      const destId = target === '__self__' ? String(fromChatId) : (process.env.TELEGRAM_CHAT_ID_2 || '');
      if (!destId) { await sendTelegramReply(fromChatId, '⚠️⚠️⚠️ ไม่พบ TELEGRAM_CHAT_ID_2'); return; }
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: destId, text: msg })
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
        body: JSON.stringify({ to: groupId, messages: [{ type: 'text', text: msg }] })
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
    const msg = update.message || update.channel_post;

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

    if (!msg || !msg.text) { res.status(200).json({ ok: true }); return; }

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
    const text     = msg.text;
    const trimmed  = text.trim();
    const chatType = getChatType(chatId); // 'main' | 'sub' | null

    if (!isAllowedChat(chatId)) { res.status(200).json({ ok: true }); return; }

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

      // ── /รายงาน → ค้นใบส่งของ แล้วส่งรายงานเข้า LINE หรือ Telegram กลุ่ม 2 ──
      if (cmdText.startsWith('/รายงาน')) {
        var rawRep = cmdText.replace(/^\/รายงาน/, '').trim();
        if (!rawRep) {
          await sendTelegramReply(chatId,
            'ระบุให้ครบครับ เช่น:\n' +
            '/รายงาน กท.1002 12/6 ไลน์\n' +
            '/รายงาน po2606025 เทส\n' +
            '/รายงาน so2606011 เทเลแกรม\n' +
            '/รายงาน pr00278 ไลน์'
          );
          res.status(200).json({ ok: true }); return;
        }

        // แยก target (ไลน์/เทส/เทเลแกรม) จากท้ายคำสั่ง
        var repTarget = null;
        var LINE_GROUPS = {
          'ไลน์': 'C9adc5d856cc04bdefa31523f8c98a520',
          'เทส':  'Cd888f9bcfe77f27d6ad9b488a6bb24bc'
        };
        var repKw = rawRep;
        if (/\sไลน์\s*$/i.test(repKw))      { repTarget = 'ไลน์';     repKw = repKw.replace(/\sไลน์\s*$/, '').trim(); }
        else if (/\sเทส\s*$/i.test(repKw))  { repTarget = 'เทส';      repKw = repKw.replace(/\sเทส\s*$/, '').trim(); }
        else if (/\sเทเลแกรม\s*$/i.test(repKw)) { repTarget = 'เทเลแกรม'; repKw = repKw.replace(/\sเทเลแกรม\s*$/, '').trim(); }

        if (!repTarget) {
          repTarget = '__self__'; // ไม่ระบุปลายทาง → ส่งกลับกลุ่มที่พิมพ์คำสั่ง
        }

        // ตรวจว่าเป็น po/so/pr หรือใบส่งของ
        var repDocType = 'picking';
        if (/^po\s*/i.test(repKw)) { repDocType = 'po'; repKw = repKw.replace(/^po\s*/i,'').trim(); }
        else if (/^so\s*/i.test(repKw)) { repDocType = 'so'; repKw = repKw.replace(/^so\s*/i,'').trim(); }
        else if (/^pr\s*/i.test(repKw)) { repDocType = 'pr'; repKw = repKw.replace(/^pr\s*/i,'').trim(); }

        await sendTelegramReply(chatId, '🔍 กำลังค้นหาใน Odoo...');

        // ── po/so/pr → ค้น + ส่งรายงานเลย (ไม่กรองวันที่) ──
        if (repDocType !== 'picking') {
          try {
            const { odooFindDoc } = await import('./odoo.js');
            // ตัดตัวย่อบริษัท (md/cg/sep/akn/set) ออกก่อนค้น เช่น "2606001 MD" → "2606001" + company=เมิร์ค
            const { keyword: repKwClean, company: repCompany } = parseCompany(repKw);
            const doc = await odooFindDoc(repDocType, repKwClean, null, repCompany.id);
            if (!doc) {
              await sendTelegramReply(chatId, '🔍 ไม่พบเอกสาร "' + repKwClean + '" ครับ');
              res.status(200).json({ ok: true }); return;
            }
            await sendReportDoc(chatId, doc, repTarget, LINE_GROUPS);
          } catch(e) {
            await sendTelegramReply(chatId, '⚠️⚠️⚠️ เกิดข้อผิดพลาด: ' + e.message);
          }
          res.status(200).json({ ok: true }); return;
        }

        // ดึงวันที่ออกจาก keyword (เฉพาะใบส่งของ)
        var repDate = null;
        var repDm = repKw.match(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\s*$/);
        if (repDm) { repDate = parseDate(repDm[1]); repKw = repKw.replace(repDm[0], '').trim(); }

        try {
          const { odooDelivery, parseCompany } = await import('./odoo.js');
          const { keyword: dkw, company: dCo } = parseCompany(repKw);
          const allPicks = await odooDelivery(dkw, dCo.id);

          // กรองวันที่
          let repPicks = repDate
            ? allPicks.filter(p => String(p.scheduled_date || '').slice(0,10) === repDate)
            : allPicks;

          if (!repPicks.length) {
            await sendTelegramReply(chatId, '🔍 ไม่พบใบส่งของ "' + repKw + '"' + (repDate ? ' วันที่ ' + repDm[1] : '') + ' ครับ');
            res.status(200).json({ ok: true }); return;
          }

          // เจอหลายใบ → ถามให้เลือก (ตอบเลข 1 หรือ 1 2)
          if (repPicks.length > 1) {
            const opts = repPicks.slice(0, 8).map((p, i) => (i+1) + '. ' + (p.name || '-')).join('\n');
            if (db) {
              await db.from('tg_report_select').upsert({
                chat_id: String(chatId),
                picks: repPicks.slice(0, 8),
                target: repTarget,
                keyword: repKw,
                created_at: new Date().toISOString()
              }, { onConflict: 'chat_id' });
            }
            await sendTelegramReply(chatId,
              '🔍 พบ ' + repPicks.length + ' ใบ กรุณาเลือก:\n' + opts +
              '\n\n📌 ตอบเลขที่ต้องการครับ\n' +
              '• ใบเดียว เช่น <b>1</b>\n' +
              '• หลายใบ เช่น <b>1 2</b> (เว้นวรรค)'
            );
            res.status(200).json({ ok: true }); return;
          }

          // เจอใบเดียว → ส่งรายงานเลย
          await sendReport(chatId, repPicks[0], repTarget, LINE_GROUPS, db);
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
              const opts = picks.slice(0,8).map((p,i) =>
                (i+1) + '. ' + (p.name || '-') + (p.scheduled_date ? ' (' + String(p.scheduled_date).slice(0,10) + ')' : '')
              ).join('\n');
              await db.from('tg_compare_select').upsert({
                chat_id: String(chatId),
                picks: picks.slice(0,8),
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

      // ── /ลงรูป → เปิด session รอรูป แล้วอัปเข้า Odoo ────────────────────
      if (cmdText.startsWith('/ลงรูป') || lc.startsWith('/uploadphoto')) {
        var rawArg = cmdText.replace(/^\/ลงรูป/, '').replace(/^\/uploadphoto/i, '').trim();
        if (!rawArg) {
          await sendTelegramReply(chatId,
            'ระบุเอกสารด้วยครับ เช่น:\n' +
            '/ลงรูป กท.1002 12/6\n' +
            '/ลงรูป po2606001\n' +
            '/ลงรูป so2606007\n' +
            '/ลงรูป pr00278'
          );
          res.status(200).json({ ok: true }); return;
        }

        // แยกตัวย่อบริษัท (md/cg/sep/akn/set) ออกก่อน เช่น "po2606001 md" → keyword="po2606001", company=เมิร์ค
        const { keyword: argNoCompany, company: docCompany } = parseCompany(rawArg);

        // แยก docType
        var docType = 'picking', docKeyword = argNoCompany;
        var docDateFilter = null;
        if (/^po\s*/i.test(argNoCompany)) { docType = 'po'; docKeyword = argNoCompany.replace(/^po\s*/i,'').trim(); }
        else if (/^so\s*/i.test(argNoCompany)) { docType = 'so'; docKeyword = argNoCompany.replace(/^so\s*/i,'').trim(); }
        else if (/^pr\s*/i.test(argNoCompany)) { docType = 'pr'; docKeyword = argNoCompany.replace(/^pr\s*/i,'').trim(); }
        else {
          // picking — ดึงวันที่ออก
          var dmR = docKeyword.match(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\s*$/);
          if (dmR) { docDateFilter = parseDate(dmR[1]); docKeyword = docKeyword.replace(dmR[0],'').trim(); }
        }

        await sendTelegramReply(chatId, '🔍 กำลังค้นหาเอกสารใน Odoo...');
        try {
          const doc = await odooFindDoc(docType, docKeyword, docDateFilter, docCompany.id);
          if (!doc) {
            await sendTelegramReply(chatId, '⚠️⚠️⚠️ ไม่พบเอกสาร "' + rawArg + '" ใน Odoo ครับ');
            res.status(200).json({ ok: true }); return;
          }
          // บันทึก session
          if (db) {
            await db.from('tg_report_session').upsert({
              chat_id: String(chatId),
              doc_type: docType,
              doc_id: doc.id,
              doc_name: doc.name,
              doc_model: doc.model,
              uploaded: 0,
              updated_at: new Date().toISOString()
            }, { onConflict: 'chat_id' });
          }
          await sendTelegramReply(chatId,
            '✅ พบเอกสารแล้วครับ!\n📋 ' + doc.name +
            '\n\nส่งรูปเข้ากลุ่มได้เลยครับ (รับภายใน 10 นาที)\nพิมพ์ /จบรายงาน เมื่อส่งครบ'
          );
        } catch(e) {
          await sendTelegramReply(chatId, '⚠️⚠️⚠️ เกิดข้อผิดพลาด: ' + e.message);
        }
        res.status(200).json({ ok: true }); return;
      }

      // ── /จบรายงาน → สรุปจำนวนรูปที่อัป ──────────────────────────────────
      if (cmdText.startsWith('/จบรายงาน') || lc.startsWith('/endreport')) {
        if (db) {
          const { data: sess } = await db.from('tg_report_session')
            .select('*').eq('chat_id', String(chatId)).maybeSingle();
          if (!sess) {
            await sendTelegramReply(chatId, '⚠️ ไม่มี session รายงานที่เปิดอยู่ครับ');
          } else {
            await sendTelegramReply(chatId,
              '✅ จบรายงานแล้วครับ!\n📋 ' + sess.doc_name +
              '\n📷 อัปรูปทั้งหมด ' + sess.uploaded + ' รูป'
            );
            await db.from('tg_report_session').delete().eq('chat_id', String(chatId));
          }
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
          'ไลน์': 'C9adc5d856cc04bdefa31523f8c98a520',
          'เทส':  'Cd888f9bcfe77f27d6ad9b488a6bb24bc'
        };
        // แปลงเลขที่เลือก → index (ตัดเลขซ้ำ + เลขเกินช่วงออก)
        const validNums = [...new Set(pickedNums)].filter(n => n >= 1 && n <= picks.length);
        if (!validNums.length) {
          await sendTelegramReply(chatId, '⚠️ กรุณาตอบเลข 1-' + picks.length + ' ครับ (เลือกหลายใบได้ เช่น 1 2)');
        } else {
          const selected = validNums.map(n => picks[n - 1]);
          await db.from('tg_report_select').delete().eq('chat_id', String(chatId));
          if (selected.length === 1) {
            await sendReport(chatId, selected[0], selSess2.target, LINE_GROUPS3, db);
          } else {
            await sendReportMulti(chatId, selected, selSess2.target, LINE_GROUPS3, db);
          }
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
