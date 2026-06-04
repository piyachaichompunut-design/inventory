// Vercel Hobby Plan รองรับ cron เดียว — รันทุก 15 นาที
// โค้ดเช็คเวลาเองว่าถึงเวลาส่งรายงานไหน
import { checkDueTasks, dailyReceiveSend, eveningReport, monthlyKPIReport } from './rpc.js';

export default async function handler(req, res) {
  try {
    // เวลาไทย = UTC+7
    const now = new Date();
    const thaiHour = (now.getUTCHours() + 7) % 24;
    const thaiMin  = now.getUTCMinutes();
    const thaiDay  = new Date(now.getTime() + 7 * 60 * 60 * 1000).getUTCDate();

    const results = {};

    // 07:00 น. ± 14 นาที → งานรับ/ส่งประจำวัน
    if (thaiHour === 7 && thaiMin < 15) {
      results.morning = await dailyReceiveSend();
    }

    // 08:00 น. ± 14 นาที → งานครบ/เลยกำหนด
    if (thaiHour === 8 && thaiMin < 15) {
      results.due = await checkDueTasks();
    }

    // 16:45 น. ± 14 นาที → สรุปเย็น + พรุ่งนี้
    if (thaiHour === 16 && thaiMin >= 45) {
      results.evening = await eveningReport();
    }

    // วันที่ 1 ของเดือน 08:00 น. → KPI รายเดือน
    if (thaiDay === 1 && thaiHour === 8 && thaiMin < 15) {
      results.kpi = await monthlyKPIReport();
    }

    res.status(200).json({ ok: true, time: `${thaiHour}:${String(thaiMin).padStart(2,'0')} TH`, results });
  } catch (e) {
    console.error('cron error:', e.message);
    res.status(200).json({ ok: false, error: e.message });
  }
}
