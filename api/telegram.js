// Telegram Webhook — รับข้อความที่คนพิมพ์ในกลุ่ม แล้วตอบกลับตามคำสั่ง
// Telegram จะ POST ข้อมูลมาที่ endpoint นี้ทุกครั้งที่มีข้อความใหม่
import { handleTelegramCommand, sendTelegramReply, isAllowedChat } from './rpc.js';

export default async function handler(req, res) {
  // Telegram ส่งมาเป็น POST เสมอ
  if (req.method !== 'POST') {
    res.status(200).json({ ok: true });
    return;
  }
  try {
    const update = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const msg = update.message || update.channel_post;
    if (!msg || !msg.text) {
      res.status(200).json({ ok: true });
      return;
    }

    const chatId = msg.chat && msg.chat.id;
    const text = msg.text;

    // ตอบเฉพาะกลุ่มที่ตั้งไว้ใน TELEGRAM_CHAT_ID เท่านั้น (ปลอดภัย)
    if (!isAllowedChat(chatId)) {
      res.status(200).json({ ok: true });
      return;
    }

    // ตอบเฉพาะข้อความที่ขึ้นต้นด้วย / (เป็นคำสั่ง)
    if (!text.trim().startsWith('/')) {
      res.status(200).json({ ok: true });
      return;
    }

    const reply = await handleTelegramCommand(text);
    if (reply) {
      await sendTelegramReply(chatId, reply);
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    // ตอบ 200 เสมอ ไม่งั้น Telegram จะ retry ซ้ำๆ
    console.error('webhook error:', e.message);
    res.status(200).json({ ok: true });
  }
}
