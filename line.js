// LINE Webhook — รับข้อความจากกลุ่มไลน์ แล้วสร้างงานใน TMS
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const LINE_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const LINE_TOKEN  = process.env.LINE_CHANNEL_TOKEN  || '';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const db = (SUPABASE_URL && SERVICE_KEY)
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  : null;

// ── ส่งข้อความกลับไลน์ ───────────────────────────────────────────────────────
async function replyLine(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
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

  // ดึงประเภท รับ/ส่ง
  if (t.includes('ส่ง')) duration = 'ส่ง';
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

      // ── คำสั่ง /help ─────────────────────────────────────────────────────
      if (text.trim() === '/help' || text.trim() === '/ช่วยเหลือ') {
        await replyLine(replyToken,
          '🤖 TMS Bot — คำสั่งที่ใช้ได้\n\n' +
          '📦 สร้างงานรับ:\n' +
          'รับ: ชื่องาน วันที่ 5/6/2026 @ผู้รับผิดชอบ\n\n' +
          '🚚 สร้างงานส่ง:\n' +
          'ส่ง: ชื่องาน วันที่ 5/6/2026 @ผู้รับผิดชอบ\n\n' +
          '📋 หรือใช้รูปแบบ:\n' +
          '/งานใหม่ รับ ชื่องาน 5/6/2026\n\n' +
          '📊 /สรุป — ดูสรุปงานทั้งหมด'
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
      const taskData = parseTask(text);
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
          categories: '',
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
            `\n🔗 ดูในระบบ: inventory-rho-hazel.vercel.app`
          );
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
