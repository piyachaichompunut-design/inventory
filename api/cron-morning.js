// 7:00 น. — สรุปงานรับ/ส่งประจำวัน
import { dailyReceiveSend } from './rpc.js';
export default async function handler(req, res) {
  try { res.status(200).json({ ok: true, result: await dailyReceiveSend() }); }
  catch (e) { res.status(200).json({ ok: false, error: e.message }); }
}
