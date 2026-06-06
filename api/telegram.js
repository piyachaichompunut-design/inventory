// Telegram Webhook   
// - /คำสั่ง → คำสั่งสำเร็จรูป (ดูข้อมูลจาก Supabase)
// - @botname → ถาม Groq AI + ค้นเว็บด้วย Tavily ถ้าจำเป็น
import { handleTelegramCommand, sendTelegramReply, isAllowedChat } from './rpc.js';

const GROQ_KEY     = process.env.GROQ_API_KEY || '';
const TAVILY_KEY   = process.env.TAVILY_API_KEY || '';
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').toLowerCase();
const GROQ_MODEL   = 'llama-3.3-70b-versatile'; // เร็ว ฟรี ภาษาไทยดี

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
- บอกแหล่งที่มาด้วยถ้าสำคัญ
- ถ้าข้อมูลไม่ชัดเจน บอกตรงๆ แล้วตอบจากความรู้ตัวเองแทน`;

// ── ตรวจว่าต้องค้นเว็บไหม ─────────────────────────────────────────────────────
function needsWebSearch(text) {
  const t = text.toLowerCase();
  const triggers = [
    'วันนี้','ตอนนี้','ล่าสุด','ปัจจุบัน','เพิ่งเกิด',
    'ราคา','หุ้น','ค่าเงิน','อัตราแลกเปลี่ยน',
    'สภาพอากาศ','ฝน','น้ำท่วม','พายุ','อุณหภูมิ',
    'รถติด','การจราจร','ถนน','ทางด่วน',
    'ข่าว','เหตุการณ์','ประกาศ','แถลง',
    'เปิด','ปิด','วันหยุด',
    'today','now','latest','current','news','price','weather','traffic'
  ];
  return triggers.some(kw => t.includes(kw));
}

// ── ค้นหาด้วย Tavily ──────────────────────────────────────────────────────────
async function searchWeb(query) {
  if (!TAVILY_KEY) return null;
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_KEY,
        query,
        search_depth: 'basic',
        max_results: 3,
        include_answer: true,
        include_raw_content: false
      })
    });
    const data = await res.json();
    if (!res.ok) return null;
    let result = '';
    if (data.answer) result += data.answer + '\n\n';
    if (data.results && data.results.length) {
      data.results.slice(0, 3).forEach(r => {
        result += `📌 ${r.title}\n${r.content?.slice(0, 200) || ''}\n🔗 ${r.url}\n\n`;
      });
    }
    return result.trim() || null;
  } catch (e) {
    console.error('Tavily error:', e.message);
    return null;
  }
}

// ── ถาม Groq ──────────────────────────────────────────────────────────────────
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
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        max_tokens: 1024,
        temperature: 0.7
      })
    });

    const data = await res.json();
    if (!res.ok) {
      console.error('Groq error:', JSON.stringify(data));
      return '⚠️ ขอโทษครับ มีปัญหาเกิดขึ้น ลองใหม่อีกทีนะครับ';
    }
    return data?.choices?.[0]?.message?.content || '🤔 ไม่มีคำตอบครับ';
  } catch (e) {
    console.error('Groq exception:', e.message);
    return '⚠️ เชื่อมต่อไม่ได้ครับ ลองใหม่นะครับ';
  }
}

// ── ตรวจ mention ──────────────────────────────────────────────────────────────
function extractMention(text, botUsername) {
  if (!text) return null;
  const pattern = new RegExp('@' + (botUsername || '[\\w]+') + '\\b', 'i');
  if (!pattern.test(text)) return null;
  return text.replace(new RegExp('@' + (botUsername || '[\\w]+') + '\\b', 'gi'), '').trim();
}

// ── History (เก็บใน memory ต่อ chat) ─────────────────────────────────────────
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

    // เส้นทางที่ 2: tag @บอท → ถาม Groq (+ ค้นเว็บถ้าจำเป็น)
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
      if (needsWebSearch(userMsg) && TAVILY_KEY) {
        webContext = await searchWeb(userMsg);
      }
      const reply = await askGroq(userMsg, history, webContext);
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
