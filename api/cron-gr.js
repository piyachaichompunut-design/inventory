// ============================================================================
//  api/cron-gr.js — แจ้งเตือนเมื่อมีคนอื่น (ไม่ใช่ Store1) ทำให้สต็อกเปลี่ยน
//  ครอบคลุม "ทุกการเคลื่อนไหว" ที่ทำให้สต็อกเพิ่ม/ลด:
//    - รับเข้า (Receipt/GR), ส่งออก (Delivery), Scrap, ปรับสต็อก (Inventory Adj)
//    - ทั้งที่มาจาก PO/SO และที่สร้างเอง
//  ดูจาก stock.move (state=done) แยกทิศทางจาก usage ของ location
//  เรียกทุก ~10 นาที ผ่าน GitHub Actions
//  - กันแจ้งซ้ำด้วย state ที่เก็บใน delivery_views (id='__gr_watch_state__')
// ============================================================================
import { odooRecentStockMoves, odooBilledNotReceived, odooConfigured, odooReceiveDeliveryStatus } from './odoo.js';
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

async function notifyTelegram(text, onlyChat1) {
  const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
  // ปกติส่งทั้ง 2 กลุ่ม | onlyChat1=true → ส่งเฉพาะ chat 1 (โหมดทดสอบ)
  const chatIds = (onlyChat1
    ? [process.env.TELEGRAM_CHAT_ID || '']
    : [process.env.TELEGRAM_CHAT_ID || '', process.env.TELEGRAM_CHAT_ID_2 || '']
  ).filter(Boolean);
  if (!TG_TOKEN || !chatIds.length) return;
  for (const chatId of chatIds) {
    try {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
      });
    } catch (e) { /* เงียบ — ส่งกลุ่มอื่นต่อ */ }
  }
}

// ป้ายบอกประเภทการเคลื่อนไหว จาก usage ต้นทาง-ปลายทาง
// สร้างหน้าดูรายการทั้งหมดใน delivery_views → คืน URL (หรือ '' ถ้าไม่ต้อง/ไม่สำเร็จ)
// ใช้เมื่อรายการเกิน 5 — ผู้ใช้กดดูครบได้
async function buildMoveListView(db, g) {
  try {
    const viewId = 'MV' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();
    const lines = g.lines.map(l => ({
      name: l.product || '',
      qty: l.qty || '',
      uom: l.uom || ''
    }));
    const picks = [{
      name: g.ref || 'รายการสต็อก',
      origin: g.origin || '',
      partner: g.partner || '',
      date: g.date ? (() => { const d = new Date(g.date.replace(' ', 'T') + 'Z'); return new Date(d.getTime() + 7*60*60*1000).toISOString().slice(0,10); })() : '',
      statusText: m.direction === 'in' || m.direction === 'adjust_in' ? 'รับเข้า' :
                  m.direction === 'out' || m.direction === 'adjust_out' ? 'ตัดออก' :
                  m.direction === 'transfer' ? 'โอนย้าย' :
                  m.direction === 'scrap' ? 'Scrap' : 'เคลื่อนไหว',
      statusColor: m.direction === 'in' || m.direction === 'adjust_in' ? 'green' :
                   m.direction === 'transfer' ? 'gray' : 'red',
      lines
    }];
    const { error } = await db.from('delivery_views').insert({
      id: viewId,
      title: 'รายการสต็อก — ' + (g.ref || ''),
      status_label: (g.write_user || '') + (g.company ? ' • ' + g.company : ''),
      data: { summary: { total: 1 }, picks }
    });
    if (error) return '';
    return 'https://inventory-rho-hazel.vercel.app/delivery.html?id=' + viewId;
  } catch (e) { return ''; }
}

// ประกอบบล็อกรายการสินค้า (สูงสุด 5) + ลิงก์ดูทั้งหมดถ้าเกิน
async function buildLinesBlock(db, g) {
  const MAX = 5;
  let block = '';
  const showLines = g.lines.slice(0, MAX);
  if (showLines.length) {
    block += '📦 รายการ (' + g.lines.length + '):\n';
    for (const l of showLines) {
      const pname = (l.product || '').slice(0, 70);  // แสดงทั้งรหัส [xxx] + ชื่อ
      block += '  • ' + pname + ' × ' + l.qty + ' ' + (l.uom || '') + '\n';
    }
    if (g.lines.length > MAX) {
      block += '  ...และอีก ' + (g.lines.length - MAX) + ' รายการ\n';
      const url = await buildMoveListView(db, g);
      if (url) block += '🔗 ดูรายการทั้งหมด: ' + url + '\n';
    }
  }
  return block;
}

// บล็อกรายการสินค้าที่ค้างรับ (แสดงรหัส [xxx] + ชื่อ, สูงสุด 5)
function buildMissingLinesBlock(bill) {
  const lines = bill.missingLines || [];
  if (!lines.length) return '';
  let block = '📦 รายการค้างรับ (' + lines.length + '):\n';
  for (const l of lines.slice(0, 5)) {
    const pname = (l.product || '').slice(0, 70);  // คงรหัส [xxx]
    block += '  • ' + pname + ' — ค้าง ' + l.missing + ' ' + (l.uom || '') + '\n';
  }
  if (lines.length > 5) block += '  ...และอีก ' + (lines.length - 5) + ' รายการ\n';
  return block;
}

// แสดงจำนวนสวยๆ (ตัด .0)
function fmtQtyGr(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

// บล็อกสถานะรับ/ส่ง (รับครบ / ค้างรับ + ยอดค้าง) — ใช้ HTML <b>
function buildReceiveStatusBlockGr(status) {
  if (!status || !status.found) return '';
  const isPO = status.type === 'po';
  const verb = isPO ? 'รับ' : 'ส่ง';
  const docLabel = isPO ? 'PO' : 'SO';

  if (status.complete) {
    return '\n✅ <b>' + verb + 'ครบ ' + docLabel +
           (status.docName ? ' (' + status.docName + ')' : '') + '</b> — ครบทุกรายการแล้ว\n';
  }

  let block = '\n🔴🔴 <b>⚠️ ' + verb + 'สินค้าไม่ครบ!</b> 🔴🔴\n';
  block += '<b>📌 ' + docLabel + (status.docName ? ' ' + status.docName : '') +
           ' ยังค้าง' + verb + 'อีก ' + fmtQtyGr(status.totalRemain) + ' หน่วย</b>\n';
  const rl = status.remainLines || [];
  if (rl.length) {
    block += '<b>รายการที่ค้าง' + verb + ':</b>\n';
    for (const l of rl.slice(0, 5)) {
      const pname = String(l.product || '').replace(/-{2,}/g, ' ').trim().slice(0, 55);
      block += '  🔻 ' + pname + '\n' +
               '       สั่ง ' + fmtQtyGr(l.ordered) + ' • ' + verb + 'แล้ว ' + fmtQtyGr(l.done) +
               ' • <b>ค้าง ' + fmtQtyGr(l.remain) + ' ' + (l.uom || '') + '</b>\n';
    }
    if (rl.length > 5) block += '  ...และอีก ' + (rl.length - 5) + ' รายการ\n';
  }
  block += '<b>‼️ โปรดตรวจสอบว่าคีย์จำนวนถูกต้องหรือไม่</b>\n';
  return block;
}

function moveTypeLabel(m) {
  if (m.scrapped || m.direction === 'scrap') return '🗑️ ตัดของเสีย (Scrap)';
  if (m.direction === 'in') {
    if (m.srcUsage === 'supplier') return '📥 รับเข้าจากผู้ขาย (Receipt)';
    if (m.srcUsage === 'inventory') return '➕ ปรับสต็อกเพิ่ม (Adjustment)';
    if (m.srcUsage === 'production') return '🏭 รับเข้าจากการผลิต';
    return '📥 รับเข้า (สต็อกเพิ่ม)';
  } else if (m.direction === 'out') {
    if (m.destUsage === 'customer') return '📤 ส่งออกให้ลูกค้า (Delivery)';
    if (m.destUsage === 'inventory') return '➖ ปรับสต็อกลด (Adjustment)';
    if (m.destUsage === 'production') return '🏭 เบิกไปผลิต';
    return '📤 ตัดออก (สต็อกลด)';
  } else if (m.direction === 'transfer') {
    return '🔄 โอนย้ายระหว่างคลัง (Transfer)';
  } else if (m.direction === 'adjust_in') {
    return '➕ ปรับสต็อกเพิ่ม (Adjustment)';
  } else if (m.direction === 'adjust_out') {
    return '➖ ปรับสต็อกลด (Adjustment)';
  } else {
    return '📦 เคลื่อนไหวสต็อก (' + (m.srcUsage || '?') + '→' + (m.destUsage || '?') + ')';
  }
}

export default async function handler(req, res) {
  try {
    // ── กันคนอื่นยิง URL มั่ว: ถ้าตั้ง env CRON_SECRET ไว้ ต้องส่ง key ให้ตรง ──
    //   เรียกได้ 2 วิธี: ?key=xxx ต่อท้าย URL  หรือ  header Authorization: Bearer xxx
    //   ถ้าไม่ได้ตั้ง CRON_SECRET → ไม่บังคับ (เปิดให้เรียกได้เลย)
    const CRON_SECRET = process.env.CRON_SECRET || '';
    if (CRON_SECRET) {
      let key = '';
      try {
        if (req.query && req.query.key) key = String(req.query.key);
        if (!key && req.url) {
          const u = new URL(req.url, 'http://x');
          key = u.searchParams.get('key') || '';
        }
        if (!key && req.headers) {
          const auth = req.headers.authorization || req.headers.Authorization || '';
          if (auth.startsWith('Bearer ')) key = auth.slice(7).trim();
        }
      } catch (e) { /* ใช้ key ว่าง */ }
      if (key !== CRON_SECRET) {
        res.status(401).json({ ok: false, error: 'unauthorized' });
        return;
      }
    }

    if (!odooConfigured()) { res.status(200).json({ ok: false, error: 'Odoo ยังไม่ตั้งค่า' }); return; }
    const db = getDb();
    if (!db) { res.status(200).json({ ok: false, error: 'DB ยังไม่ตั้งค่า' }); return; }

    // ── โหมดทดสอบ: /api/cron-gr?test=1&mins=120 ──────────────────────────────
    //   มองย้อนหลัง mins นาที (default 120) | ส่งเข้า chat 1 เท่านั้น | ไม่บันทึก state
    //   ใช้ดูว่าระบบจับการเคลื่อนไหวได้ไหม + ข้อความหน้าตาเป็นยังไง (ไม่ต้องแตะสต็อกจริง)
    // อ่าน query หลายวิธี (Vercel serverless อาจส่งมาต่างกัน)
    let qTest = '', qMins = '';
    try {
      if (req.query && typeof req.query === 'object') {
        qTest = String(req.query.test || '');
        qMins = String(req.query.mins || '');
      }
      // เผื่อ req.query ไม่มี → parse จาก req.url เอง
      if (!qTest && req.url) {
        const u = new URL(req.url, 'http://x');
        qTest = u.searchParams.get('test') || '';
        qMins = u.searchParams.get('mins') || '';
      }
    } catch (e) { /* ใช้ค่าว่าง */ }

    const isTest = qTest === '1' || (req.url || '').includes('test=1');
    if (isTest) {
      const mins = qMins ? parseInt(qMins, 10) : 120;
      const sinceTest = new Date(Date.now() - mins * 60 * 1000).toISOString();

      const { moves, error } = await odooRecentStockMoves(sinceTest, WATCH_COMPANY_IDS);
      if (error) { res.status(200).json({ ok: false, test: true, error }); return; }

      // ── debug=1: แสดง raw move ทุกตัวพร้อม direction/usage จริงๆ ──
      if (qTest === '1' && req.query?.debug === '1' || (req.url || '').includes('debug=1')) {
        const debugMoves = (moves || []).slice(0, 30).map(m => ({
          ref: m.ref,
          direction: m.direction,
          srcUsage: m.srcUsage,
          destUsage: m.destUsage,
          by: m.write_login || m.write_user,          // คนแก้ล่าสุด (write_uid)
          createdBy: m.create_login || m.create_user,  // คนสร้าง move (create_uid)
          product: (m.product || '').slice(0, 60),
          scrapped: m.scrapped,
          date: m.date
        }));
        const store1Count = (moves||[]).filter(m => (m.write_login||'').toLowerCase() === STORE1_LOGIN).length;
        const nullDirCount = (moves||[]).filter(m => !m.direction).length;
        res.status(200).json({
          ok: true, test: true, debug: true,
          rawMoves: (moves||[]).length,
          store1: store1Count,
          nullDirection: nullDirCount,
          other: (moves||[]).length - store1Count - nullDirCount,
          moves: debugMoves
        }); return;
      }

      const otherMoves = (moves || []).filter(m => (m.write_login || '').toLowerCase() !== STORE1_LOGIN);
      // จัดกลุ่ม
      const grps = {};
      for (const m of otherMoves) {
        const key = (m.ref || ('move-' + m.id)) + '|' + m.direction + '|' + (m.scrapped ? 's' : '');
        if (!grps[key]) grps[key] = { ...m, lines: [] };
        grps[key].lines.push({ product: m.product, qty: m.qty, uom: m.uom });
      }

      const keys = Object.keys(grps);
      // ส่งหัวข้อทดสอบ + ผลรวม เข้า chat 1
      // นับว่ามี move ของ Store1 กี่ตัว (เพื่อ debug ว่า query เจอของแต่กรองออกหมดไหม)
      const store1Moves = (moves || []).filter(m => (m.write_login || '').toLowerCase() === STORE1_LOGIN);
      let head = '🧪 <b>ทดสอบระบบแจ้งเตือนสต็อก</b>\n';
      head += 'มองย้อนหลัง ' + mins + ' นาที\n';
      head += 'พบ move ทั้งหมด: ' + (moves || []).length + '\n';
      head += '  • ของ Store1: ' + store1Moves.length + ' (ไม่แจ้ง)\n';
      head += '  • ของคนอื่น: ' + otherMoves.length + ' รายการ (' + keys.length + ' เอกสาร)\n';
      head += 'บริษัทที่เฝ้า: ' + WATCH_COMPANY_IDS.join(',') + ' | Store1 = ' + STORE1_LOGIN + '\n';
      head += (keys.length ? '\nตัวอย่างการแจ้งเตือน 👇' : '\n(ไม่พบการเคลื่อนไหวจากคนอื่นในช่วงนี้)');
      await notifyTelegram(head, true);

      // ส่งตัวอย่างแจ้งเตือน (สูงสุด 5 เอกสาร) เข้า chat 1 เท่านั้น
      for (const key of keys.slice(0, 5)) {
        const g = grps[key];
        let msg = '⚠️ <b>มีคนอื่นทำรายการสต็อก</b> (ทดสอบ)\n';
        msg += moveTypeLabel(g) + '\n';
        if (g.ref) msg += '📋 เอกสาร: ' + g.ref + '\n';
        if (g.origin) msg += '🔗 อ้างอิง PO/SO: ' + g.origin + '\n';
        if (g.partner) msg += '🏢 คู่ค้า: ' + g.partner + '\n';
        if (g.note) msg += '📝 หมายเหตุ: ' + g.note.slice(0, 200) + '\n';
        if (g.company) msg += '🏭 บริษัท: ' + g.company + '\n';
        msg += '👤 คนทำ: ' + (g.write_user || g.write_login || 'ไม่ทราบ');
        if (g.write_login) msg += ' (' + g.write_login + ')';
        msg += '\n';
        msg += await buildLinesBlock(db, g);
        // สถานะรับ/ส่ง จาก origin (PO/SO) — เช็คครบไหม กันคีย์จำนวนผิด
        if (g.origin) {
          try {
            const st = await odooReceiveDeliveryStatus(g.origin);
            msg += buildReceiveStatusBlockGr(st);
          } catch (e) { /* ข้าม */ }
        }
        if (g.date) {
          const d = new Date(g.date.replace(' ', 'T') + 'Z');
          const th = new Date(d.getTime() + 7 * 60 * 60 * 1000);
          msg += '🕐 เวลา: ' + th.toISOString().slice(0, 16).replace('T', ' ') + ' น.';
        }
        await notifyTelegram(msg, true);
      }

      // ── ทดสอบเช็ค Bill จ่าย/วางบิลแล้ว แต่ยังรับไม่ครบ ──
      let billTestCount = 0;
      try {
        const { bills } = await odooBilledNotReceived(sinceTest, WATCH_COMPANY_IDS);
        if (bills && bills.length) {
          await notifyTelegram('🧪 พบบิลที่ยังรับเข้าไม่ครบ: ' + bills.length + ' ใบ 👇', true);
          for (const bill of bills.slice(0, 5)) {
            let msg = '🚨 <b>จ่ายเงิน/วางบิลแล้ว แต่ยังรับเข้าไม่ครบ!</b> (ทดสอบ)\n';
            msg += bill.paidLabel + '\n';
            msg += '🧾 ใบบิล: ' + bill.name + '\n';
            if (bill.po) msg += '🔗 PO: ' + bill.po + '\n';
            if (bill.partner) msg += '🏢 ผู้ขาย: ' + bill.partner + '\n';
            if (bill.company) msg += '🏭 บริษัท: ' + bill.company + '\n';
            msg += '📦 สั่ง ' + bill.ordered + ' • รับแล้ว ' + bill.received +
                   ' • <b>ค้างรับ ' + bill.missing + '</b>\n';
            msg += buildMissingLinesBlock(bill);
          if (bill.amount) msg += '💰 มูลค่าบิล: ' + Number(bill.amount).toLocaleString('th-TH') + ' บาท\n';
            if (bill.date) msg += '🕐 วันที่บิล: ' + bill.date;
            await notifyTelegram(msg, true);
          }
          billTestCount = bills.length;
        }
      } catch (e) { /* ทดสอบบิลล้มเหลว ไม่กระทบ */ }

      res.status(200).json({
        ok: true, test: true, lookbackMins: mins,
        movesFound: (moves || []).length,
        otherMoves: otherMoves.length,
        documents: keys.length,
        sentToChat1: Math.min(keys.length, 5),
        billsNotReceived: billTestCount
      });
      return;
    }

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
      if (g.origin) msg += '🔗 อ้างอิง PO/SO: ' + g.origin + '\n';
      if (g.partner) msg += '🏢 คู่ค้า: ' + g.partner + '\n';
      if (g.note) msg += '📝 หมายเหตุ: ' + g.note.slice(0, 200) + '\n';
      if (g.company) msg += '🏭 บริษัท: ' + g.company + '\n';
      msg += '👤 คนทำ: ' + (g.write_user || g.write_login || 'ไม่ทราบ');
      if (g.write_login) msg += ' (' + g.write_login + ')';
      msg += '\n';

      // รายการสินค้า (สูงสุด 8 บรรทัด)
      msg += await buildLinesBlock(db, g);

      // สถานะรับ/ส่ง จาก origin (PO/SO) — เช็คว่าครบไหม กันคีย์จำนวนผิด
      if (g.origin) {
        try {
          const st = await odooReceiveDeliveryStatus(g.origin);
          msg += buildReceiveStatusBlockGr(st);
        } catch (e) { /* เช็คไม่ได้ ข้าม */ }
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

    // ── เช็ค Bill ที่จ่าย/วางบิลแล้ว แต่ยังรับเข้าไม่ครบ ──────────────────────
    try {
      const { bills, error: billErr } = await odooBilledNotReceived(lastCheck, WATCH_COMPANY_IDS);
      if (!billErr && bills && bills.length) {
        for (const bill of bills) {
          const billKey = 'bill|' + bill.id + '|' + bill.paymentState;
          if (notified.includes(billKey)) continue; // แจ้งไปแล้ว
          let msg = '🚨 <b>จ่ายเงิน/วางบิลแล้ว แต่ยังรับเข้าไม่ครบ!</b>\n';
          msg += bill.paidLabel + '\n';
          msg += '🧾 ใบบิล: ' + bill.name + '\n';
          if (bill.po) msg += '🔗 PO: ' + bill.po + '\n';
          if (bill.partner) msg += '🏢 ผู้ขาย: ' + bill.partner + '\n';
          if (bill.company) msg += '🏭 บริษัท: ' + bill.company + '\n';
          msg += '📦 สั่ง ' + bill.ordered + ' • รับแล้ว ' + bill.received +
                 ' • <b>ค้างรับ ' + bill.missing + '</b>\n';
          msg += buildMissingLinesBlock(bill);
          if (bill.amount) msg += '💰 มูลค่าบิล: ' + Number(bill.amount).toLocaleString('th-TH') + ' บาท\n';
          if (bill.date) msg += '🕐 วันที่บิล: ' + bill.date;
          await notifyTelegram(msg);
          alertedCount++;
          newNotifiedKeys.push(billKey);
        }
      }
    } catch (e) { /* เช็คบิลล้มเหลว ไม่กระทบการแจ้งสต็อก */ }

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
