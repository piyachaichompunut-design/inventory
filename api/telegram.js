// Telegram Webhook
// - /คำสั่ง → คำสั่งสำเร็จรูป (ดูข้อมูลจาก Supabase)
// - @botname → ถาม AI + ค้นเว็บด้วย Tavily ถ้าจำเป็น
import { handleTelegramCommand, sendTelegramReply, isAllowedChat } from './rpc.js';

const OR_KEY      = process.env.OPENROUTER_API_KEY || '';
const TAVILY_KEY  = process.env.TAVILY_API_KEY || '';
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').toLowerCase();
const OR_URL      = 'https://openrouter.ai/api/v1/chat/completions';

const SYSTEM = `คุณคือ "Odoo Bot" ผู้ช่วย AI ประจำทีมงานในประเทศไทย
บุคลิก: กันเอง อบอุ่น ขี้เล่น เหมือนเพื่อนสนิทที่ฉลาด พูดภาษาไทยเป็นธรรมชาติ ใช้ "ครับ" ลงท้าย
สไตล์: ถามง่าย → ตอบสั้นกระชับสนุกสนาน | ถามซับซ้อน → ตอบละเอียดเป็นขั้นตอน
คุณตอบได้ทุกเรื่อง เช่น ดูดวง ราศี ความรัก สุขภาพ อาหาร ข่าวสาร ความรู้ทั่วไป
เรื่องงานในระบบ TMS → แนะนำใช้คำสั่ง /งานวันนี้ /สรุป /kpi`;

function needsWebSearch(text) {
  const t = text.toLowerCase();
  return ['วันนี้','ตอนนี้','ล่าสุด','ราคา','หุ้น','สภาพอากาศ','ฝน','ข่าว','today','news','price','weather'].some(k => t.includes(k));
}

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
    (data.results || []).slice(0, 3).forEach(r => {
      result += `📌 ${r.title}\n${(r.content || '').slice(0, 200)}\n🔗 ${r.url}\n\n`;
    });
    return result.trim() || null;
  } catch (e) { return null; }
}

async function askAI(userMessage, history = [], webContext = null) {
  if (!OR_KEY) return '❌ ยังไม่ได้ตั้งค่า OPENROUTER_API_KEY ครับ';
  try {
    const finalMessage = webContext ? `[ข้อมูลจากเว็บ]\n${webContext}\n\n[คำถาม]\n${userMessage}` : userMessage;
    const messages = [
      { role: 'system', content: SYSTEM },
      ...history,
      { role: 'user', content: finalMessage }
    ];
    const res = await fetch(OR_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OR_KEY}`,
        'HTTP-Referer': 'https://inventory-rho-hazel.vercel.app',
        'X-Title': 'Odoo Bot'
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-3.3-8b-instruct:free',
        messages,
        max_tokens: 800,
        temperature: 0.7
      })
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('OpenRouter error:', JSON.stringify(data));
      return '⚠️ ขอโทษครับ มีปัญหาเกิดขึ้น ลองใหม่อีกทีนะครับ';
    }
    return data?.choices?.[0]?.message?.content || '🤔 ไม่มีคำตอบครับ';
  } catch (e) {
    console.error('AI exception:', e.message);
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
    const text = msg.text;
    if (!isAllowedChat(chatId)) { res.status(200).json({ ok: true }); return; }

    const trimmed = text.trim();

    if (trimmed.startsWith('/')) {
      const reply = await handleTelegramCommand(trimmed);
      if (reply) await sendTelegramReply(chatId, reply);
      res.status(200).json({ ok: true });
      return;
    }

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
      const reply = await askAI(userMsg, history, webContext);
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
