// Telegram Webhook   
// - /คำสั่ง → คำสั่งสำเร็จรูป (ดูข้อมูลจาก Supabase)
// - @botname → ถาม Groq AI + ค้นเว็บด้วย Tavily ถ้าจำเป็น
// - กลุ่มใหม่: Reply ข้อความ แล้ว @บอท → บันทึกงานอัตโนมัติ
import { handleTelegramCommand, sendTelegramReply, isAllowedChat, getChatType, notifyMainChat, sendDeliveryPDF } from './rpc.js';
import { odooConfigured, odooFindDoc, odooDocDetail, parseCompany } from './odoo.js';
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

// ── /รายงาน (ไม่มีปลายทาง) → สร้างข้อความรายงานตอบในกลุ่ม Telegram เดิม ──────────
// ปลายทางที่ "มี" จะถูกปล่อยผ่านไปให้ handleTelegramCommand (logic เดิม push เข้า LINE/TG)
const REPORT_TARGETS = ['ไลน์', 'เทส', 'เทเลแกรม', 'line', 'telegram', 'test'];

function tgEscape(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// เดาประเภทเอกสารจากคำขึ้นต้น เช่น PO2606027 → 'po'
function guessDocType(kw) {
  const u = String(kw).trim().toUpperCase();
  if (u.startsWith('PO')) return 'po';
  if (u.startsWith('SO')) return 'so';
  if (u.startsWith('PR')) return 'pr';
  return null; // ไม่รู้ → ลองทุกประเภทตามลำดับ
}

// จัดข้อความรายงานให้เหมือนหน้าตาเดิม (📊 รายงาน / ผู้ขาย / วันที่ / ยอดรวม / รายการ)
function formatReportMsg(doc) {
  const items = (doc.lines || []).map((l, i) => {
    const name = tgEscape(String(l.name || '').replace(/-{2,}/g, ' ').trim());
    const uom = tgEscape(l.uom || '');
    return (i + 1) + '. ' + name + ' — ' + (l.qty || 0) + (uom ? ' ' + uom : '');
  }).join('\n') || '(ไม่มีรายการสินค้า)';

  let m = '📊 รายงาน: ' + tgEscape(doc.name) + '\n';
  if (doc.partner) m += '👤 ' + tgEscape(doc.partnerLabel || 'คู่ค้า') + ': ' + tgEscape(doc.partner) + '\n';
  m += '📅 วันที่: ' + (doc.date || '-') + '\n';
  if (doc.total) m += '💰 ยอดรวม: ' + Number(doc.total).toLocaleString('th-TH') + ' บาท\n';
  m += '📷 รูปงาน: ' + ((doc.images && doc.images.length) || 0) + ' รูป\n\n';
  m += '📦 รายการสินค้า:\n' + items + '\n\n';
  m += 'เรียบร้อยครับ ✅';
  return m;
}

// ค้นหาเอกสาร + ดึงรายละเอียด แล้วคืนข้อความรายงาน
async function buildReportMsg(raw) {
  if (!odooConfigured()) return '⚠️⚠️⚠️ ยังไม่ได้ตั้งค่า Odoo ครับ';
  const { keyword, company } = parseCompany(raw);
  const coId = company && company.id;
  if (!keyword) return 'พิมพ์เลขเอกสารด้วยครับ เช่น /รายงาน PO2606027';

  const dt = guessDocType(keyword);
  const order = dt ? [dt] : ['po', 'so', 'pr'];

  // ใน Odoo ชื่อ PO/SO มักเก็บเป็นเลขล้วน (เช่น "2606027") ไม่มี prefix
  // ส่วน PR มักมี prefix (เช่น "PR01881") — เลยลองค้นทั้ง 2 แบบ
  const kwStripped = keyword.replace(/^(PO|SO|PR)\s*/i, '').trim();
  const candidates = (kwStripped && kwStripped !== keyword) ? [keyword, kwStripped] : [keyword];

  let found = null;
  for (const t of order) {
    for (const kw of candidates) {
      try {
        found = await odooFindDoc(t, kw, null, coId);
        if (found) break;
      } catch (e) {}
    }
    if (found) break;
  }
  if (!found) return '🔍 ไม่พบเอกสาร "' + tgEscape(keyword) + '"' + (coId ? ' (บริษัท ' + tgEscape(company.name) + ')' : '') + ' ใน Odoo ครับ\nรองรับ PO / SO / PR — ลองพิมพ์เลขให้ครบ เช่น /รายงาน PO2606027';

  const doc = await odooDocDetail(found.model, found.id);
  if (!doc) return '🔍 เจอ "' + tgEscape(found.name) + '" แต่ดึงรายละเอียดไม่ได้ครับ';
  return formatReportMsg(doc);
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
  y = y ? parseInt(y) : new Date().getFullYear();
  if (y < 100) y += 2000;
  if (y >= 2500) y -= 543;
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

function parseTaskFromText(text, catKeyword) {
  const t = text.trim();

  // วันที่ — ดึงจากข้อความ เช่น 9/6, 9/6/2569, 09-06-2026
  const dateMatch = t.match(/(?:วันที่\s*)?(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/);
  const actionDate = dateMatch ? (parseDate(dateMatch[1]) || todayStr()) : todayStr();

  // ชื่องาน = ข้อความทั้งหมด
  const taskText = t.slice(0, 300);

  // หาหมวดหมู่จาก keyword ที่พิมพ์ต่อจาก @บอท
  const kw = (catKeyword || '').trim().toLowerCase();
  const categories = CAT_MAP[kw] || (kw ? 'งานอื่นๆ' : 'งานอื่นๆ');

  return {
    task: taskText,
    duration: 'รับ',
    actionDate,
    salesName: '',
    categories
  };
}

// ── บันทึกงานจาก reply ───────────────────────────────────────────────────────
async function saveTaskFromReply(text, fromUser, chatId, attachmentObj = null, catKeyword = '', messageId = null) {
  if (!db) return { ok: false, error: 'ยังไม่ได้เชื่อมต่อฐานข้อมูลครับ' };

  const taskData = parseTaskFromText(text, catKeyword);
  const id = rid();
  const attachments = attachmentObj ? [attachmentObj] : [];

  const { error } = await db.from('tasks').insert({
    id,
    task: taskData.task,
    duration: taskData.duration,
    action_date: taskData.actionDate,
    sales_name: '',
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

  return { ok: true, confirmMsg, mainMsg };
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
export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(200).json({ ok: true }); return; }
  try {
    const update = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const msg = update.message || update.channel_post;
    if (!msg || !msg.text) { res.status(200).json({ ok: true }); return; }

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

      // ── /รายงาน [เลขเอกสาร] โดย "ไม่มีปลายทาง" → ตอบรายงานในกลุ่ม Telegram เดิม ──
      //    ถ้ามีปลายทาง (ไลน์/เทเลแกรม/เทส) ปล่อยผ่านไปใช้คำสั่งเดิมที่ push ออกไป
      if (cmdText.startsWith('/รายงาน') || cmdText.toLowerCase().startsWith('/report')) {
        const rRest = cmdText.replace(/^\/รายงาน/, '').replace(/^\/report/i, '').trim();
        const rParts = rRest.split(/\s+/);
        const rLast = (rParts[rParts.length - 1] || '').toLowerCase();
        const hasTarget = REPORT_TARGETS.includes(rLast);
        if (rRest && !hasTarget) {
          await sendTelegramReply(chatId, '🔍 กำลังค้นหาใน Odoo...');
          try {
            const rMsg = await buildReportMsg(rRest);
            await sendTelegramReply(chatId, rMsg);
          } catch (e) {
            await sendTelegramReply(chatId, '⚠️⚠️⚠️ สร้างรายงานไม่สำเร็จ: ' + e.message);
          }
          res.status(200).json({ ok: true });
          return;
        }
        // มีปลายทาง → ตกไปที่ handleTelegramCommand ด้านล่าง (logic เดิม)
      }

      // ── /ส่งของ → ส่งไฟล์ PDF แทนข้อความ ──────────────────────────────
      var lc = cmdText.toLowerCase();
      if (cmdText.startsWith('/ส่งของ') || cmdText.startsWith('/จัดส่ง') || lc.startsWith('/delivery')) {
        var kw = cmdText.replace(/^\/ส่งของ/, '').replace(/^\/จัดส่ง/, '').replace(/^\/delivery/i, '').trim();
        if (!kw) {
          await sendTelegramReply(chatId, 'พิมพ์ชื่อโครงการหรือเลขใบด้วยครับ เช่น /ส่งของ อุตรดิตถ์');
        } else {
          await sendTelegramReply(chatId, '⏳ กำลังสร้างใบส่งของ PDF ของ "' + kw + '" ครับ...');
          await sendDeliveryPDF(chatId, kw);
        }
        res.status(200).json({ ok: true });
        return;
      }

      const reply = await handleTelegramCommand(cmdText);
      if (reply) await sendTelegramReply(chatId, reply);
      res.status(200).json({ ok: true });
      return;
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
        const result = await saveTaskFromReply(originalText, fromUser, chatId, attachmentObj, catKeyword, replyMsg.message_id);

        if (result.ok) {
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
