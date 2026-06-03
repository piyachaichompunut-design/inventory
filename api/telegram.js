// Telegram Webhook
// - / → คำสั่งสำเร็จรูป
// - @botname → ถาม Groq AI + ค้นเว็บด้วย Tavily ถ้าจำเป็น
import { handleTelegramCommand, sendTelegramReply, isAllowedChat } from './rpc.js';

const GROQ_KEY     = process.env.GROQ_API_KEY || '';
const TAVILY_KEY   = process.env.TAVILY_API_KEY || '';
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').toLowerCase();
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const TAVILY_URL   = 'https://api.tavily.com/search';

// ── System prompt ────────────────────────────────────────────────────────────
const SYSTEM = `คุณคือ "Odoo Bot" ผู้ช่วย AI ของทีมโรงงาน/คลังสินค้าในประเทศไทย
บุคลิก: กันเอง อบอุ่น เหมือนเพื่อนร่วมงานที่ฉลาด พูดภาษาไทยเป็นธรรมชาติ ใช้ "ครับ" ลงท้าย
สไตล์: ถามง่าย → ตอบสั้นกระชับ | ถามซับซ้อน → ตอบละเอียดเป็นขั้นตอน
บริบท: ทีมทำงานเกี่ยวกับโรงงานและคลังสินค้า มีระบบ TMS ติดตามงานรับ/ส่งสินค้า บริการชุบโลหะ งาน OT พนักงาน และ KPI
ถ้าถูกถามเรื่องข้อมูลงานในระบบ ให้แนะนำใช้คำสั่ง /งานวันนี้ /สรุป /kpi แทน เพราะจะได้ข้อมูลสดจากฐานข้อมูล
ห้ามแต่งข้อมูลงานขึ้นมาเอง

เมื่อได้รับผลการค้นหาเว็บ (ขึ้นต้นด้วย [ข้อมูลจากเว็บ]):
- สรุปให้กระชับ เข้าใจง่าย ภาษาไทย
- บอกแหล่งที่มาด้วยถ้าสำคัญ
- ถ้าข้อมูลไม่ชัดเจนหรือไม่ตรงคำถาม ให้บอกตรงๆ`;

// ── ตรวจว่าต้องค้นเว็บไหม ────────────────────────────────────────────────────
function needsWebSearch(text) {
  const t = text.toLowerCase();
  // คำที่บ่งบอกว่าต้องการข้อมูล real-time
  const triggers = [
    'วันนี้','ตอนนี้','ล่าสุด','ปัจจุบัน','เมื่อกี้','เพิ่งเกิด',
    'ราคา','หุ้น','ค่าเงิน','อัตราแลกเปลี่ยน',
    'สภาพอากาศ','ฝน','น้ำท่วม','พายุ','อุณหภูมิ',
    'รถติด','การจราจร','ถนน','ทางด่วน',
    'ข่าว','เหตุการณ์','ประกาศ','แถลง',
    'เปิด','ปิด','วันหยุด','วันทำงาน',
    'today','now','latest','current','news','price','weather','traffic'
  ];
  return triggers.some(kw => t.includes(kw));
}

// ── ค้นหาด้วย Tavily ──────────────────────────────────────────────────────────
async function searchWeb(query) {
  if (!TAVILY_KEY) return null;
  try {
    const res = await fetch(TAVILY_URL, {
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
    // รวมผลลัพธ์
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

// ── ถาม Groq ─────────────────────────────────────────────────────────────────
async function askGroq(userMessage, history = [], webContext = null) {
  if (!GROQ_KEY) return '❌ ยังไม่ได้ตั้งค่า GROQ_API_KEY ครับ';
  try {
    // ถ้ามีข้อมูลจากเว็บ ใส่เป็น context ให้ AI
    const finalMessage = webContext
      ? `[ข้อมูลจากเว็บ]\n${webContext}\n\n[คำถาม]\n${userMessage}`
      : userMessage;

    const messages = [
      { role: 'system', content: SYSTEM },
      ...history,
      { role: 'user', content: finalMessage }
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
        temperature: 0.7
      })
    });
    const data = await res.json();
    if (!res.ok) return '⚠️ ขอโทษครับ มีปัญหาเกิดขึ้น ลองใหม่อีกทีนะครับ';
    return data?.choices?.[0]?.message?.content || '🤔 ไม่มีคำตอบครับ';
  } catch (e) {
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

      // เช็คว่าต้องค้นเว็บไหม
      let webContext = null;
      if (needsWebSearch(userMsg) && TAVILY_KEY) {
        webContext = await searchWeb(userMsg);
      }

      const reply = await askGroq(userMsg, history, webContext);
      // เก็บ history แค่ข้อความจริง ไม่เก็บ web context
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
