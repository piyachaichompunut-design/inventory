// Telegram Webhook   
// - /คำสั่ง → คำสั่งสำเร็จรูป (ดูข้อมูลจาก Supabase)
// - @botname → ถาม Groq AI + ค้นเว็บด้วย Tavily ถ้าจำเป็น
// - กลุ่มใหม่: Reply ข้อความ แล้ว @บอท → บันทึกงานอัตโนมัติ
import { handleTelegramCommand, sendTelegramReply, isAllowedChat, getChatType, notifyMainChat, sendDeliveryPDF } from './rpc.js';
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
  const kw = (catKeyword || '').trim();

  // ── วันที่ — ดึงจาก catKeyword ก่อน (สิ่งที่พิมพ์ต่อจาก @บอท) แล้วค่อย fallback ไปหาในข้อความ ──
  const dateRe = /(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/;
  const dateFromKw = kw.match(dateRe);
  const dateFromText = t.match(/(?:วันที่\s*)?(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/);
  const rawDate = dateFromKw ? dateFromKw[1] : (dateFromText ? dateFromText[1] : null);
  const actionDate = rawDate ? (parseDate(rawDate) || todayStr()) : todayStr();

  // ── ส่ง/รับ — เช็คจาก catKeyword ก่อน แล้ว fallback ไปหาในข้อความ ──
  const kwLower = kw.toLowerCase();
  let duration = 'รับ';
  if (/^ส่ง/.test(kwLower) || /ส่งของ|นัดส่ง|จัดส่ง|ออกของ/.test(kwLower)) duration = 'ส่ง';
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

      // ── /ส่งของ → ส่งไฟล์ PDF แทนข้อความ ──────────────────────────────
      var lc = cmdText.toLowerCase();
      if (cmdText.startsWith('/ส่งของ') || cmdText.startsWith('/จัดส่ง') || lc.startsWith('/delivery')) {
        var kw = cmdText.replace(/^\/ส่งของ/, '').replace(/^\/จัดส่ง/, '').replace(/^\/delivery/i, '').trim();
        if (!kw) {
          await sendTelegramReply(chatId, 'พิมพ์ชื่อโครงการหรือเลขใบด้วยครับ เช่น /ส่งของ อุตรดิตถ์\nพิมพ์ต่อท้ายได้: รอ / ส่งแล้ว / ทั้งหมด');
        } else {
          // ดึง statusFilter จากคำท้าย (default = รอส่ง)
          var statusFilter = 'pending';
          kw = kw.replace(/\s+(ทั้งหมด|all|ส่งแล้ว|เสร็จแล้ว|done|รอ|รอส่ง|pending)\s*$/i, function(_, m) {
            var ml = m.toLowerCase();
            if (['ทั้งหมด','all'].includes(ml))                    statusFilter = 'all';
            else if (['ส่งแล้ว','เสร็จแล้ว','done'].includes(ml)) statusFilter = 'done';
            else                                                    statusFilter = 'pending';
            return '';
          }).trim();
          var label = statusFilter === 'done' ? 'ส่งแล้ว' : statusFilter === 'all' ? 'ทั้งหมด' : 'รอส่ง';
          await sendTelegramReply(chatId, '⏳ กำลังสร้างใบส่งของ [' + label + '] ของ "' + kw + '" ครับ...');
          await sendDeliveryPDF(chatId, kw, statusFilter);
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
            const buffer2 = Buffer.from(arrayBuffer2);
            const ext2 = fileName2 ? fileName2.split('.').pop() : 'jpg';
            const storagePath2 = last.task_id + '/' + Date.now() + '.' + ext2;

            const { error: upErr2 } = await db.storage.from('attachments')
              .upload(storagePath2, buffer2, { contentType: contentType2, upsert: true });
            if (upErr2) { await sendTelegramReply(chatId, '❌ อัปไฟล์ไม่สำเร็จ: ' + upErr2.message); res.status(200).json({ ok: true }); return; }

            const { data: pub2 } = db.storage.from('attachments').getPublicUrl(storagePath2);

            // อัปเดต attachments ของงาน
            const { data: taskRow2 } = await db.from('tasks').select('attachments').eq('id', last.task_id).maybeSingle();
            let atts2 = Array.isArray(taskRow2?.attachments) ? taskRow2.attachments : [];
            atts2.push({ name: fileName2 || ('file.' + ext2), size: buffer2.length, fileId: storagePath2, mimeType: contentType2, webViewLink: pub2.publicUrl, source: 'telegram' });

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
