// ============================================================================
//  api/cron-gr.js — แจ้งเตือนเมื่อมีคนอื่น (ไม่ใช่ Store1) ทำให้สต็อกเปลี่ยน
//  ครอบคลุม "ทุกการเคลื่อนไหว" ที่ทำให้สต็อกเพิ่ม/ลด:
//    - รับเข้า (Receipt/GR), ส่งออก (Delivery), Scrap, ปรับสต็อก (Inventory Adj)
//    - ทั้งที่มาจาก PO/SO และที่สร้างเอง
//  ดูจาก stock.move (state=done) แยกทิศทางจาก usage ของ location
//  เรียกทุก ~10 นาที ผ่าน GitHub Actions
//  - กันแจ้งซ้ำด้วย state ที่เก็บใน delivery_views (id='__gr_watch_state__')
// ============================================================================
import { odooRecentStockMoves, odooConfigured } from './odoo.js';
import { createClient } from '@supabase/supabase-js';

const STATE_ID = '__gr_watch_state__';
// login ของ Store1 (คนทำปกติ ไม่ต้องแจ้ง)
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

// ป้ายบอกประเภทการเคลื่อนไหว จาก usage ต้นทาง-ปลายทาง
function moveTypeLabel(m) {
  if (m.scrapped) return '🗑️ ตัดของเสีย (Scrap)';
  if (m.direction === 'in') {
    if (m.srcUsage === 'supplier') return '📥 รับเข้าจากผู้ขาย (Receipt)';
    if (m.srcUsage === 'inventory') return '➕ ปรับสต็อกเพิ่ม (Adjustment)';
    if (m.srcUsage === 'production') return '🏭 รับเข้าจากการผลิต';
    return '📥 รับเข้า (สต็อกเพิ่ม)';
  } else {
    if (m.destUsage === 'customer') return '📤 ส่งออกให้ลูกค้า (Delivery)';
    if (m.destUsage === 'inventory') return '➖ ปรับสต็อกลด (Adjustment)';
    if (m.destUsage === 'production') return '🏭 เบิกไปผลิต';
    return '📤 ตัดออก (สต็อกลด)';
  }
}

export default async function handler(req, res) {
  try {
    if (!odooConfigured()) { res.status(200).json({ ok: false, error: 'Odoo ยังไม่ตั้งค่า' }); return; }
    const db = getDb();
    if (!db) { res.status(200).json({ ok: false, error: 'DB ยังไม่ตั้งค่า' }); return; }

    // อ่าน state รอบก่อน
    let lastCheck = null, notified = [];
    try {
      const { data: st } = await db.from('delivery_views').select('data').eq('id', STATE_ID).maybeSingle();
      if (st && st.data) {
        lastCheck = st.data.lastCheck || null;
        notified = Array.isArray(st.data.notified) ? st.data.notified : [];
      }
    } catch (e) { /* ครั้งแรก */ }

    // ครั้งแรก: ตั้ง lastCheck = ตอนนี้ แล้วจบ (ไม่ย้อนอดีต)
    const nowIso = new Date().toISOString();
    if (!lastCheck) {
      await db.from('delivery_views').upsert({
        id: STATE_ID, title: 'GR watch state', status_label: 'system',
        data: { lastCheck: nowIso, notified: [] }
      });
      res.status(200).json({ ok: true, init: true, lastCheck: nowIso });
      return;
    }

    // ดึง stock.move ที่ done หลัง lastCheck
    const { moves, error } = await odooRecentStockMoves(lastCheck, WATCH_COMPANY_IDS);
    if (error) { res.status(200).json({ ok: false, error }); return; }

    // กรอง: คนทำ != Store1
    const otherMoves = (moves || []).filter(m => (m.write_login || '').toLowerCase() !== STORE1_LOGIN);

    // จัดกลุ่มตามเอกสาร (reference) — 1 ใบมีหลาย move ให้รวมเป็นแจ้งครั้งเดียว
    const groups = {};
    for (const m of otherMoves) {
      const key = (m.ref || ('move-' + m.id)) + '|' + m.direction + '|' + (m.scrapped ? 's' : '');
      if (!groups[key]) groups[key] = { ...m, lines: [], moveIds: [] };
      groups[key].lines.push({ product: m.product, qty: m.qty, uom: m.uom });
      groups[key].moveIds.push(m.id);
    }

    // กันแจ้งซ้ำ: ใช้ key เป็นตัวเช็ค
    let alertedCount = 0;
    const newNotifiedKeys = [];
    for (const key of Object.keys(groups)) {
      if (notified.includes(key)) continue; // แจ้งไปแล้ว
      const g = groups[key];

      let msg = '⚠️ <b>มีคนอื่นทำรายการสต็อก</b>\n';
      msg += moveTypeLabel(g) + '\n';
      if (g.ref) msg += '📋 เอกสาร: ' + g.ref + '\n';
      if (g.company) msg += '🏭 บริษัท: ' + g.company + '\n';
      msg += '👤 คนทำ: ' + (g.write_user || g.write_login || 'ไม่ทราบ');
      if (g.write_login) msg += ' (' + g.write_login + ')';
      msg += '\n';

      // รายการสินค้า (สูงสุด 8 บรรทัด)
      const showLines = g.lines.slice(0, 8);
      if (showLines.length) {
        msg += '📦 รายการ:\n';
        for (const l of showLines) {
          const pname = (l.product || '').replace(/^\[[^\]]+\]\s*/, '').slice(0, 40);
          msg += '  • ' + pname + ' × ' + l.qty + ' ' + (l.uom || '') + '\n';
        }
        if (g.lines.length > 8) msg += '  ...และอีก ' + (g.lines.length - 8) + ' รายการ\n';
      }
      // เวลา (แปลงเป็นเวลาไทย)
      if (g.date) {
        const d = new Date(g.date.replace(' ', 'T') + 'Z');
        const th = new Date(d.getTime() + 7 * 60 * 60 * 1000);
        msg += '🕐 เวลา: ' + th.toISOString().slice(0, 16).replace('T', ' ') + ' น.';
      }

      await notifyTelegram(msg);
      alertedCount++;
      newNotifiedKeys.push(key);
    }

    // อัปเดต state (เก็บ key ล่าสุด 300 ตัว)
    const newNotified = [...notified, ...newNotifiedKeys].slice(-300);
    await db.from('delivery_views').upsert({
      id: STATE_ID, title: 'GR watch state', status_label: 'system',
      data: { lastCheck: nowIso, notified: newNotified }
    });

    res.status(200).json({
      ok: true,
      movesChecked: (moves || []).length,
      groupsAlerted: alertedCount,
      lastCheck: nowIso
    });
  } catch (e) {
    console.error('cron-gr error:', e.message);
    res.status(200).json({ ok: false, error: e.message });
  }
}
