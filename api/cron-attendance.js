// รายงานแจ้งขาด-ลา ฝ่ายคลังสินค้า → กลุ่ม Telegram หลัก
//   ยิงให้ "ตรงเวลาแปะๆ" ด้วยตัวตั้งเวลาภายนอก (เช่น cron-job.org) เวลา 08:45 น. (Asia/Bangkok) จ.–ศ.
//   ป้องกันคนอื่นยิงมั่ว: ตั้ง env CRON_SECRET แล้วเรียกด้วย ?key=<CRON_SECRET> (หรือ header Authorization: Bearer <CRON_SECRET>)
//   ข้ามเสาร์–อาทิตย์อัตโนมัติ (เช็ควันตามเวลาไทย) เผื่อตั้งตัวตั้งเวลาให้ยิงทุกวัน
import { sendAttendanceLeaveReport, sendAttendanceExtraLeave } from './rpc.js';

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
    let chat = '', mode = '';
    try { const u2 = new URL(req.url, 'http://x'); chat = u2.searchParams.get('chat') || ''; mode = u2.searchParams.get('mode') || ''; } catch (e) {}

    // โหมดแจ้งลาเพิ่มเติมระหว่างวัน (ยิงทุก ~1 นาที) — เริ่มหลังรายงานเช้า 08:45 เท่านั้น
    if (mode === 'extra') {
      const mins = thai.getUTCHours() * 60 + thai.getUTCMinutes();
      if (mins < 8 * 60 + 46) { res.status(200).json({ ok: true, skipped: 'before-morning' }); return; }
      const r = await sendAttendanceExtraLeave(null, chat || undefined);
      res.status(200).json({ ok: true, mode: 'extra', result: { date: r.date, count: r.count, sent: r.sent } });
      return;
    }

    const result = await sendAttendanceLeaveReport(null, chat || undefined);
    res.status(200).json({ ok: true, result: { date: result.date, count: result.count, sent: result.sent } });
  } catch (e) {
    console.error('cron-attendance error:', e.message);
    res.status(200).json({ ok: false, error: e.message });
  }
}
