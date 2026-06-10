// Vercel Hobby Plan — รันวันละครั้ง 07:45 น. ไทย (00:45 UTC)
// ส่งรายงานทุกอย่างในครั้งเดียว:
//   1) งานรับ/ส่งวันนี้ พร้อมรายละเอียดครบ (dailyReceiveSend)
//   2) งานครบกำหนด/เลยกำหนด (checkDueTasks)
//   3) วันที่ 1 ของเดือน → KPI รายเดือน (monthlyKPIReport)
//
// ⚠️  Hobby Plan ไม่รองรับรายงานเย็น 16:45 น.
//     ถ้าต้องการ ให้อัปเป็น Pro Plan แล้วเปลี่ยน schedule เป็น */15 * * * *

import { checkDueTasks, dailyReceiveSend, monthlyKPIReport } from './rpc.js';
import { createClient } from '@supabase/supabase-js';

// ลบ log ข้อความไลน์ที่เก่ากว่า 7 วัน (กันตารางโต)
async function cleanupLineMessages() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { skipped: true };
  const db = createClient(url, key, { auth: { persistSession: false } });
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await db.from('line_messages').delete().lt('created_at', cutoff);
  return error ? { error: error.message } : { ok: true };
}

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

    // ทุกวัน — ลบ log ข้อความไลน์เก่ากว่า 7 วัน
    try { results.cleanup = await cleanupLineMessages(); } catch (e) { results.cleanup = { error: e.message }; }

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
