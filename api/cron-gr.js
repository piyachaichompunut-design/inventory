// ============================================================================
//  api/cron-gr.js — แจ้งเตือนเมื่อมีคนอื่น (ไม่ใช่ Store1) กด validate Receipt (GR)
//  เรียกทุก ~10 นาที ผ่าน GitHub Actions
//  - ดึง Receipt (incoming) ที่ state=done + write_date หลังรอบก่อน
//  - ถ้าคนกด login != STORE1_LOGIN → แจ้งเข้ากลุ่ม Telegram
//  - กันแจ้งซ้ำด้วย state ที่เก็บใน delivery_views (id='__gr_watch_state__')
// ============================================================================
import { odooRecentReceipts, odooConfigured } from './odoo.js';
import { createClient } from '@supabase/supabase-js';

const STATE_ID = '__gr_watch_state__';
// login ของ Store1 (คนกดปกติ ไม่ต้องแจ้ง) — ตั้งใน env ได้ ถ้าไม่ตั้งใช้ค่า default
const STORE1_LOGIN = (process.env.GR_STORE1_LOGIN || 'store.set9595@gmail.com').toLowerCase();
// บริษัทที่เฝ้าดู: อาคเนย์ (1) + เมิร์ค (2) — ตั้ง GR_COMPANY_IDS ทับได้ เช่น "1,2,4"
const WATCH_COMPANY_IDS = (process.env.GR_COMPANY_IDS || '1,2')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);

function getDb() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function notifyTelegram(text) {
  const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
  const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
  } catch (e) { /* เงียบ */ }
}

export default async function handler(req, res) {
  try {
    if (!odooConfigured()) { res.status(200).json({ ok: false, error: 'Odoo ยังไม่ตั้งค่า' }); return; }
    const db = getDb();
    if (!db) { res.status(200).json({ ok: false, error: 'DB ยังไม่ตั้งค่า' }); return; }

    // อ่าน state รอบก่อน (lastCheck = เวลาล่าสุดที่เช็ค, notified = id ที่แจ้งไปแล้ว)
    let lastCheck = null, notified = [];
    try {
      const { data: st } = await db.from('delivery_views').select('data').eq('id', STATE_ID).maybeSingle();
      if (st && st.data) {
        lastCheck = st.data.lastCheck || null;
        notified = Array.isArray(st.data.notified) ? st.data.notified : [];
      }
    } catch (e) { /* ครั้งแรก ยังไม่มี state */ }

    // ครั้งแรก: ตั้ง lastCheck = ตอนนี้ แล้วจบ (ไม่ย้อนดูอดีต กันสแปม)
    const nowIso = new Date().toISOString();
    if (!lastCheck) {
      await db.from('delivery_views').upsert({
        id: STATE_ID, title: 'GR watch state', status_label: 'system',
        data: { lastCheck: nowIso, notified: [] }
      });
      res.status(200).json({ ok: true, init: true, lastCheck: nowIso });
      return;
    }

    // ดึง Receipt ที่ validate หลัง lastCheck
    const { receipts, error } = await odooRecentReceipts(lastCheck, WATCH_COMPANY_IDS);
    if (error) { res.status(200).json({ ok: false, error }); return; }

    // หาเฉพาะที่คนกด != Store1 และยังไม่เคยแจ้ง
    const toAlert = (receipts || []).filter(r => {
      const login = (r.write_login || '').toLowerCase();
      const isStore1 = login === STORE1_LOGIN;
      const alreadyNotified = notified.includes(r.id);
      return !isStore1 && !alreadyNotified;
    });

    // แจ้งเตือนแต่ละใบ
    for (const r of toAlert) {
      let msg = '⚠️ <b>มีคนอื่นกดรับสินค้า (GR)</b>\n';
      msg += '📋 ใบรับ: ' + r.name + '\n';
      if (r.company) msg += '🏭 บริษัท: ' + r.company + '\n';
      msg += '👤 คนกด: ' + (r.write_user || r.write_login || 'ไม่ทราบ');
      if (r.write_login) msg += ' (' + r.write_login + ')';
      msg += '\n';
      if (r.partner) msg += '🏢 ผู้ขาย: ' + r.partner + '\n';
      if (r.origin) {
        msg += '📄 อ้างอิง: ' + r.origin + '\n';
      } else {
        msg += '📄 อ้างอิง: — (สร้างรับเอง ไม่ผูก PO)\n';
      }
      // เวลา (แปลงเป็นเวลาไทย)
      const wt = r.date_done || r.write_date;
      if (wt) {
        const d = new Date(wt.replace(' ', 'T') + 'Z');
        const th = new Date(d.getTime() + 7 * 60 * 60 * 1000);
        msg += '🕐 เวลา: ' + th.toISOString().slice(0, 16).replace('T', ' ') + ' น.';
      }
      await notifyTelegram(msg);
    }

    // อัปเดต state: lastCheck = now, notified = รวม id ใหม่ (เก็บแค่ 200 ตัวล่าสุด กัน list โต)
    const newNotified = [...notified, ...toAlert.map(r => r.id)].slice(-200);
    await db.from('delivery_views').upsert({
      id: STATE_ID, title: 'GR watch state', status_label: 'system',
      data: { lastCheck: nowIso, notified: newNotified }
    });

    res.status(200).json({
      ok: true,
      checked: (receipts || []).length,
      alerted: toAlert.length,
      lastCheck: nowIso
    });
  } catch (e) {
    console.error('cron-gr error:', e.message);
    res.status(200).json({ ok: false, error: e.message });
  }
}
