// วันที่ 1 ของเดือน 8:00 น. — สรุป KPI รายเดือน
import { monthlyKPIReport } from './rpc.js';
export default async function handler(req, res) {
  try { res.status(200).json({ ok: true, result: await monthlyKPIReport() }); }
  catch (e) { res.status(200).json({ ok: false, error: e.message }); }
}
