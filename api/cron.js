// Vercel Hobby Plan — รันวันละครั้ง 07:45 น. ไทย (00:45 UTC)
import { checkDueTasks, dailyReceiveSend, monthlyKPIReport } from './rpc.js';
import { createClient } from '@supabase/supabase-js';

function getDb() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ลบ log ข้อความไลน์ที่เก่ากว่า 30 วัน (เก็บนานขึ้นเพื่อให้ reply งานเก่าได้)
async function cleanupLineMessages(db) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await db.from('line_messages').delete().lt('created_at', cutoff);
  return error ? { error: error.message } : { ok: true };
}

// ลบไฟล์แนบงานใน Supabase Storage ที่เก่ากว่า 90 วัน
async function cleanupAttachments(db) {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  // หา task ที่เก่ากว่า 90 วัน และมี attachments
  const { data: oldTasks, error: fetchErr } = await db
    .from('tasks')
    .select('id, attachments')
    .lt('created_at', cutoff)
    .not('attachments', 'eq', '[]');
  if (fetchErr) return { error: fetchErr.message };
  if (!oldTasks || !oldTasks.length) return { ok: true, deleted: 0 };

  let deleted = 0;
  for (const task of oldTasks) {
    const atts = Array.isArray(task.attachments) ? task.attachments : [];
    if (!atts.length) continue;
    // ลบแต่ละไฟล์จาก Storage
    const paths = atts.map(a => a.fileId).filter(Boolean);
    if (paths.length) {
      const { error: delErr } = await db.storage.from('attachments').remove(paths);
      if (!delErr) {
        // ล้าง attachments ใน task record
        await db.from('tasks').update({ attachments: [] }).eq('id', task.id);
        deleted += paths.length;
      }
    }
  }
  return { ok: true, deleted };
}

// ลบ delivery_views ที่เก่ากว่า 30 วัน (link ใบส่งของหมดอายุ)
async function cleanupDeliveryViews(db) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await db.from('delivery_views').delete().lt('created_at', cutoff);
  return error ? { error: error.message } : { ok: true };
}

// ลบ tg_processed_updates ที่เก่ากว่า 7 วัน (กัน table โต)
async function cleanupTgUpdates(db) {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await db.from('tg_processed_updates').delete().lt('created_at', cutoff);
  return error ? { error: error.message } : { ok: true };
}

// ลบ active_sessions ที่ไม่ ping เกิน 1 วัน (กัน table โตจาก session เก่าๆ)
async function cleanupActiveSessions(db) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { error } = await db.from('active_sessions').delete().lt('last_seen', cutoff);
  return error ? { error: error.message } : { ok: true };
}

export default async function handler(req, res) {
  try {
    const now = new Date();
    const thaiDate = new Date(now.getTime() + 7 * 60 * 60 * 1000).getUTCDate();
    const db = getDb();
    const results = {};

    // ── ปิดการแจ้งสรุปงานเข้ากลุ่มทุกเช้า (ตามที่ผู้ใช้ขอ) ──────────────────
    //   ต้องการเปิดกลับ: ลบคอมเมนต์ 2 บรรทัดล่างนี้
    // ทุกวัน — งานรับ/ส่งประจำวันพร้อมรายละเอียดครบ
    // results.morning = await dailyReceiveSend();

    // ทุกวัน — งานครบกำหนด/เลยกำหนด
    // results.due = await checkDueTasks();

    if (db) {
      // ลบ log ข้อความไลน์เก่ากว่า 30 วัน
      try { results.cleanupLine = await cleanupLineMessages(db); } catch (e) { results.cleanupLine = { error: e.message }; }

      // ลบไฟล์แนบงานเก่ากว่า 90 วัน (ประหยัด Storage)
      try { results.cleanupAtts = await cleanupAttachments(db); } catch (e) { results.cleanupAtts = { error: e.message }; }

      // ลบ delivery_views เก่ากว่า 30 วัน
      try { results.cleanupDelivery = await cleanupDeliveryViews(db); } catch (e) { results.cleanupDelivery = { error: e.message }; }

      // ลบ tg_processed_updates เก่ากว่า 7 วัน
      try { results.cleanupTg = await cleanupTgUpdates(db); } catch (e) { results.cleanupTg = { error: e.message }; }

      // ลบ active_sessions ที่ไม่ ping เกิน 1 วัน
      try { results.cleanupSessions = await cleanupActiveSessions(db); } catch (e) { results.cleanupSessions = { error: e.message }; }
    }

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
