// รายงานแจ้งขาด-ลา ฝ่ายคลังสินค้า → กลุ่ม Telegram หลัก
//   ยิงให้ "ตรงเวลาแปะๆ" ด้วยตัวตั้งเวลาภายนอก (เช่น cron-job.org) เวลา 08:45 น. (Asia/Bangkok) จ.–ศ.
//   ป้องกันคนอื่นยิงมั่ว: ตั้ง env CRON_SECRET แล้วเรียกด้วย ?key=<CRON_SECRET> (หรือ header Authorization: Bearer <CRON_SECRET>)
//   ข้ามเสาร์–อาทิตย์อัตโนมัติ (เช็ควันตามเวลาไทย) เผื่อตั้งตัวตั้งเวลาให้ยิงทุกวัน
import { sendAttendanceLeaveReport } from './rpc.js';

export default async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET || '';
    if (secret) {
      let key = '';
      try {
        const u = new URL(req.url, 'http://x');
        key = u.searchParams.get('key') || '';
      } catch (e) {}
      if (!key) key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (key !== secret) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    }

    const thai = new Date(Date.now() + 7 * 3600 * 1000);
    const dow = thai.getUTCDay();            // 0=อาทิตย์ ... 6=เสาร์ (เวลาไทย)
    if (dow === 0 || dow === 6) {
      res.status(200).json({ ok: true, skipped: 'weekend' });
      return;
    }
    const result = await sendAttendanceLeaveReport();
    res.status(200).json({ ok: true, result: { date: result.date, count: result.count, sent: result.sent } });
  } catch (e) {
    console.error('cron-attendance error:', e.message);
    res.status(200).json({ ok: false, error: e.message });
  }
}
