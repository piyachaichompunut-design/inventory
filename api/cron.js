// Vercel Cron จะเรียก endpoint นี้ตามเวลาที่ตั้งใน vercel.json
// ทำหน้าที่: เช็คงานครบกำหนด/เลยกำหนด แล้วส่งสรุปเข้า Telegram
import { checkDueTasks } from './rpc.js';

export default async function handler(req, res) {
  try {
    const result = await checkDueTasks();
    res.status(200).json({ ok: true, result });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message || String(e) });
  }
}
