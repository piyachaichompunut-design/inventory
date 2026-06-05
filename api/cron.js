// Vercel Hobby Plan — รันวันละครั้ง 07:45 น. ไทย (00:45 UTC)
// ส่งรายงานทุกอย่างในครั้งเดียว:
//   1) งานรับ/ส่งวันนี้ พร้อมรายละเอียดครบ (dailyReceiveSend)
//   2) งานครบกำหนด/เลยกำหนด (checkDueTasks)
//   3) วันที่ 1 ของเดือน → KPI รายเดือน (monthlyKPIReport)
//
// ⚠️  Hobby Plan ไม่รองรับรายงานเย็น 16:45 น.
//     ถ้าต้องการ ให้อัปเป็น Pro Plan แล้วเปลี่ยน schedule เป็น */15 * * * *

import { checkDueTasks, dailyReceiveSend, monthlyKPIReport } from './rpc.js';

export default async function handler(req, res) {
  try {
    const now = new Date();
    // วันที่ไทย (UTC+7) — ใช้เฉพาะเช็ควันที่ 1 ของเดือน
    const thaiDate = new Date(now.getTime() + 7 * 60 * 60 * 1000).getUTCDate();

    const results = {};

    // ทุกวัน — งานรับ/ส่งประจำวันพร้อมรายละเอียดครบ
    results.morning = await dailyReceiveSend();

    // ทุกวัน — งานครบกำหนด/เลยกำหนด
    results.due = await checkDueTasks();

    // วันที่ 1 ของเดือน — KPI รายเดือน
    if (thaiDate === 1) {
      results.kpi = await monthlyKPIReport();
    }

    res.status(200).json({ ok: true, results });
  } catch (e) {
    console.error('cron error:', e.message);
    res.status(200).json({ ok: false, error: e.message });
  }
}
