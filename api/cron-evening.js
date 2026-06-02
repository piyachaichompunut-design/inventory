// 16:45 น. — สรุปงานตอนเย็น + แจ้งเตือนงานพรุ่งนี้
import { eveningReport } from './rpc.js';
export default async function handler(req, res) {
  try { res.status(200).json({ ok: true, result: await eveningReport() }); }
  catch (e) { res.status(200).json({ ok: false, error: e.message }); }
}
