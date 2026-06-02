// Telegram Webhook
// - / → คำสั่งสำเร็จรูป
// - @botname → ถาม Groq AI (Llama 3.3)
import { handleTelegramCommand, sendTelegramReply, isAllowedChat } from './rpc.js';

const GROQ_KEY     = process.env.GROQ_API_KEY || '';
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').toLowerCase();
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';

const SYSTEM = `คุณคือ "Odoo Bot" ผู้ช่วย AI ของทีมโรงงาน/คลังสินค้า
บุคลิก: กันเอง อบอุ่น เหมือนเพื่อนร่วมงานที่ฉลาด พูดภาษาไทยเป็นธรรมชาติ ใช้ "ครับ" ลงท้าย
สไตล์: ถามง่าย → ตอบสั้นกระชับ | ถามซับซ้อน → ตอบละเอียดเป็นขั้นตอน
บริบท: ทีมทำงานเกี่ยวกับโรงงานและคลังสินค้า มีระบบ TMS ติดตามงานรับ/ส่งสินค้า บริการชุบโลหะ งาน OT พนักงาน และ KPI
ถ้าถูกถามเรื่องข้อมูลงานจริงๆ ให้แนะนำว่าใช้คำสั่ง /งานวันนี้ หรือ /สรุป จะได้ข้อมูลสดจากระบบ
ห้ามแต่งข้อมูลงานขึ้นมาเอง คุยได้ทุกเรื่อง: ให้กำลังใจ ตลกเบาๆ แนะนำวิธีทำงาน`;

async function askGroq(userMessage, history = []) {
  if (!GROQ_KEY) return '❌ ยังไม่ได้ตั้งค่า GROQ_API_KEY ครับ';
  try {
    const messages = [
      { role: 'system', content: SYSTEM },
      ...history,
      { role: 'user', content: userMessage }
    ];
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages,
        max_tokens: 800,
        temperature: 0.9
      })
    });
    const data = await res.json();
    if (!res.ok) return '⚠️ ขอโทษครับ มีปัญหาเกิดขึ้น ลองใหม่อีกทีนะครับ';
    return data?.choices?.[0]?.message?.content || '🤔 ไม่มีคำตอบครับ';
  } catch (e) {
    return '⚠️ เชื่อมต่อไม่ได้ครับ ลองใหม่นะครับ';
  }
}

function extractMention(text, botUsername) {
  if (!text) return null;
  const pattern = new RegExp('@' + (botUsername || '[\\w]+') + '\\b', 'i');
  if (!pattern.test(text)) return null;
  return text.replace(new RegExp('@' + (botUsername || '[\\w]+') + '\\b', 'gi'), '').trim();
}

const chatHistory = new Map();
function getHistory(chatId) { return chatHistory.get(String(chatId)) || []; }
function addHistory(chatId, role, content) {
  const key = String(chatId);
  const h = chatHistory.get(key) || [];
  h.push({ role, content });
  if (h.length > 10) h.splice(0, h.length - 10);
  chatHistory.set(key, h);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(200).json({ ok: true }); return; }
  try {
    const update = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const msg = update.message || update.channel_post;
    if (!msg || !msg.text) { res.status(200).json({ ok: true }); return; }

    const chatId = msg.chat && msg.chat.id;
    const text   = msg.text;
    if (!isAllowedChat(chatId)) { res.status(200).json({ ok: true }); return; }

    const trimmed = text.trim();

    // เส้นทางที่ 1: คำสั่ง /
    if (trimmed.startsWith('/')) {
      const reply = await handleTelegramCommand(trimmed);
      if (reply) await sendTelegramReply(chatId, reply);
      res.status(200).json({ ok: true });
      return;
    }

    // เส้นทางที่ 2: tag @บอท → ถาม Groq
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
      const reply = await askGroq(userMsg, history);
      addHistory(chatId, 'user', userMsg);
      addHistory(chatId, 'assistant', reply);
      await sendTelegramReply(chatId, reply);
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('webhook error:', e.message);
    res.status(200).json({ ok: true });
  }
}
