// LINE Webhook — รับข้อความจากกลุ่มไลน์ แล้วสร้างงานใน TMS + คำสั่ง Odoo
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { handleTelegramCommand, __setDb, notifyMainChat } from './rpc.js';
import { odooConfigured, odooDelivery, parseCompany, odooCompare, odooCompareWithDelivery, companyById } from './odoo.js';

const LINE_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const LINE_TOKEN  = process.env.LINE_CHANNEL_TOKEN  || '';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const db = (SUPABASE_URL && SERVICE_KEY)
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  : null;

// ให้ rpc.js ใช้ db ตัวเดียวกัน (สำหรับคำสั่งที่ต้องเข้าฐานข้อมูล)
if (db) { try { __setDb(db); } catch (e) {} }

// ── ส่งข้อความกลับไลน์ ───────────────────────────────────────────────────────
async function replyLine(replyToken, text) {
  const r = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
  if (!r.ok) {
    const errText = await r.text();
    console.error('LINE reply failed:', r.status, errText, '| token length:', LINE_TOKEN.length);
  }
}

// ── push ข้อความเข้าไลน์ (ใช้ตอนสร้าง PDF เสร็จทีหลัง) ────────────────────────
async function pushLine(to, messages) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to, messages })
  });
}

// ── เทียบเอกสาร SO/PO/PR กับใบส่งของที่เลือกแล้ว → บันทึก delivery_views + ส่งลิงก์ ──
async function sendDeliveryCompare(pushTarget, refOther, picking, cmp) {
  try {
    const result = await odooCompareWithDelivery(refOther.type, refOther.num, picking, cmp?.id);
    const labelOther = refOther.type.toUpperCase() + refOther.num;
    const rows = result.rows || [];
    const cntOk   = rows.filter(r => r.status === 'ok').length;
    const cntDiff = rows.filter(r => r.status === 'diff').length;
    const cntMis  = rows.filter(r => r.status === 'missing_a' || r.status === 'missing_b').length;

    const viewId = 'C' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();
    const { error: insErr } = await db.from('delivery_views').insert({
      id: viewId,
      title: 'เปรียบเทียบ ' + labelOther + ' vs ใบส่งของ',
      company: cmp?.name || '',
      status_label: cmp?.name || '',
      data: {
        mode: 'delivery',
        otherType: refOther.type, otherNum: refOther.num,
        otherDoc: result.otherDoc,
        picking: {
          name: picking.name,
          origin: picking.origin || '',
          partner: Array.isArray(picking.partner_id) ? picking.partner_id[1] : '',
          scheduled_date: picking.scheduled_date || '',
          state: picking.state || ''
        },
        rows
      }
    });
    if (insErr) { await pushLine(pushTarget, [{ type:'text', text:'⚠️⚠️⚠️ บันทึกข้อมูลไม่สำเร็จ: ' + insErr.message }]); return; }

    const webLink = 'https://inventory-rho-hazel.vercel.app/compare.html?id=' + viewId;
    await pushLine(pushTarget, [{
      type: 'text',
      text: '📊 เปรียบเทียบ ' + labelOther + ' vs ใบส่งของ "' + (picking.name||'-') + '"' + (cmp?.name ? ' (' + cmp.name + ')' : '') + '\n\n' +
            '✅ ตรงกัน: ' + cntOk + ' รายการ\n' +
            (cntDiff ? '⚠️ ต่างกัน: ' + cntDiff + ' รายการ\n' : '') +
            (cntMis  ? '❌ ขาด: ' + cntMis  + ' รายการ\n' : '') +
            '\n📎 เปิดดูรายละเอียด:\n' + webLink
    }]);
  } catch (e) {
    await pushLine(pushTarget, [{ type:'text', text:'⚠️⚠️⚠️ เปรียบเทียบไม่สำเร็จ: ' + e.message }]);
  }
}

// ── ส่งรายงานใบส่งของ (จาก LINE) ไปยังกลุ่มไลน์/เทส/เทเลแกรม ─────────────────
// target = 'ไลน์' | 'เทส' | 'เทเลแกรม'
async function sendReportLine(fromTarget, picking, target, lineGroups) {
  try {
    const allPicks = await odooDelivery(picking.name || '', null);
    const p = allPicks.find(x => x.id === picking.id) || picking;

    const name = p.name || '-';
    const origin = p.origin || '';
    const lines = (p.lines || []).slice(0, 5);
    const totalLines = (p.lines || []).length;
    const date = String(p.scheduled_date || '').slice(0, 10);
    const images = p.images || [];

    let lineItems = lines.map((l, i) => {
      const pname = (Array.isArray(l.product_id) ? l.product_id[1] : l.name || '').replace(/-{2,}/g, ' ').trim();
      const qty = (l.quantity || l.product_uom_qty || 0) + ' ' + (Array.isArray(l.product_uom) ? l.product_uom[1] : '');
      return (i+1) + '. ' + pname.slice(0, 50) + ' — ' + qty;
    }).join('\n');
    if (totalLines > 5) lineItems += '\n... และอีก ' + (totalLines-5) + ' รายการ';

    const stMap = { done: 'ส่งแล้ว', cancel: 'ยกเลิก' };
    const picksData = [{
      name: p.name, origin: p.origin || '',
      partner: Array.isArray(p.partner_id) ? p.partner_id[1] : '',
      date,
      statusText: stMap[p.state] || 'รอส่ง',
      statusColor: p.state === 'done' ? 'red' : (p.state === 'cancel' ? 'gray' : 'green'),
      lines: (p.lines || []).map(l => ({
        name: Array.isArray(l.product_id) ? l.product_id[1] : '',
        qty: l.quantity || l.product_uom_qty || 0,
        uom: Array.isArray(l.product_uom) ? l.product_uom[1] : ''
      })),
      images
    }];
    const viewId = 'D' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();
    await db.from('delivery_views').insert({
      id: viewId, title: 'รายงาน — ' + name, company: '', status_label: 'รายงาน',
      data: { summary: { total: 1, done: p.state==='done'?1:0, pending: p.state!=='done'?1:0 }, picks: picksData }
    });
    const webLink = 'https://inventory-rho-hazel.vercel.app/delivery.html?id=' + viewId;

    const msg =
      '📊 รายงาน: ' + name + '\n' +
      (origin ? '📋 โครงการ: ' + origin + '\n' : '') +
      '📅 วันที่: ' + date + '\n' +
      '📷 รูปงาน: ' + images.length + ' รูป\n\n' +
      '📦 รายการสินค้า' + (totalLines > 5 ? ' (5 จาก ' + totalLines + ')' : '') + ':\n' +
      lineItems + '\n\n' +
      '📎 ดูรายละเอียดพร้อมรูป:\n' + webLink + '\n\nเรียบร้อยครับ ✅';

    await deliverReport(fromTarget, target, lineGroups, msg, 1);
  } catch(e) {
    await pushLine(fromTarget, [{ type:'text', text:'⚠️⚠️⚠️ ส่งรายงานไม่สำเร็จ: ' + e.message }]);
  }
}

// ── ส่งรายงานหลายใบรวมข้อความเดียว (จาก LINE) ───────────────────────────────
async function sendReportMultiLine(fromTarget, picks, target, lineGroups) {
  try {
    const stMap = { done: 'ส่งแล้ว', cancel: 'ยกเลิก' };
    const picksData = [];
    let totalImages = 0;
    for (const picking of picks) {
      const allPicks = await odooDelivery(picking.name || '', null);
      const p = allPicks.find(x => x.id === picking.id) || picking;
      const images = p.images || [];
      totalImages += images.length;
      picksData.push({
        name: p.name, origin: p.origin || '',
        partner: Array.isArray(p.partner_id) ? p.partner_id[1] : '',
        date: String(p.scheduled_date || '').slice(0, 10),
        statusText: stMap[p.state] || 'รอส่ง',
        statusColor: p.state === 'done' ? 'red' : (p.state === 'cancel' ? 'gray' : 'green'),
        lines: (p.lines || []).map(l => ({
          name: Array.isArray(l.product_id) ? l.product_id[1] : '',
          qty: l.quantity || l.product_uom_qty || 0,
          uom: Array.isArray(l.product_uom) ? l.product_uom[1] : ''
        })),
        images
      });
    }
    const names = picksData.map(p => p.name).join(', ');
    const doneCount = picksData.filter(p => p.statusColor === 'red').length;
    const viewId = 'M' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();
    await db.from('delivery_views').insert({
      id: viewId, title: 'รายงาน — ' + names, company: '', status_label: 'รายงาน',
      data: { summary: { total: picksData.length, done: doneCount, pending: picksData.length - doneCount }, picks: picksData }
    });
    const webLink = 'https://inventory-rho-hazel.vercel.app/delivery.html?id=' + viewId;

    const msg =
      '📊 รายงาน: ' + names + '\n' +
      '📷 รูปงานรวม: ' + totalImages + ' รูป\n\n' +
      picksData.map(p => '📋 ' + p.name + ' — ' + p.statusText + '\n   ' + p.lines.length + ' รายการสินค้า').join('\n') +
      '\n\n📎 ดูรายละเอียดพร้อมรูป:\n' + webLink + '\n\nเรียบร้อยครับ ✅';

    await deliverReport(fromTarget, target, lineGroups, msg, picksData.length);
  } catch(e) {
    await pushLine(fromTarget, [{ type:'text', text:'⚠️⚠️⚠️ ส่งรายงานไม่สำเร็จ: ' + e.message }]);
  }
}

// ── ส่งข้อความรายงานไปยังปลายทาง + แจ้งกลับกลุ่มต้นทาง ───────────────────────
async function deliverReport(fromTarget, target, lineGroups, msg, count) {
  if (target === 'เทเลแกรม') {
    const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
    const TG_SUB = process.env.TELEGRAM_CHAT_ID_2 || '';
    if (!TG_SUB) { await pushLine(fromTarget, [{ type:'text', text:'⚠️⚠️⚠️ ไม่พบ TELEGRAM_CHAT_ID_2 ใน env' }]); return; }
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_SUB, text: msg })
    });
    await pushLine(fromTarget, [{ type:'text', text:'✅ ส่งรายงาน ' + count + ' ใบเข้า Telegram เรียบร้อยครับ' }]);
  } else {
    const groupId = lineGroups[target];
    if (!groupId) { await pushLine(fromTarget, [{ type:'text', text:'⚠️⚠️⚠️ ไม่พบกลุ่ม LINE "' + target + '"' }]); return; }
    await pushLine(groupId, [{ type:'text', text: msg }]);
    await pushLine(fromTarget, [{ type:'text', text:'✅ ส่งรายงาน ' + count + ' ใบเข้า LINE กลุ่ม "' + target + '" เรียบร้อยครับ' }]);
  }
}

// ── สร้าง PDF ใบส่งของ → อัปขึ้น Supabase Storage → ส่งลิงก์เข้าไลน์ ──────────
// statusFilter: 'pending' (ค่าเริ่มต้น) | 'done' | 'all'
async function sendDeliveryPDFtoLine(to, keyword, statusFilter = 'pending', dateFilter = null) {
  if (!odooConfigured()) { await pushLine(to, [{ type:'text', text:'⚠️⚠️⚠️ ยังไม่ได้ตั้งค่า Odoo ครับ' }]); return; }
  if (!db) { await pushLine(to, [{ type:'text', text:'⚠️⚠️⚠️ ยังไม่ได้เชื่อมต่อ Storage ครับ' }]); return; }
  try {
    const { keyword: dkw, company: dCo } = parseCompany(keyword);
    const allPicks = await odooDelivery(dkw, dCo.id);
    if (!allPicks.length) {
      await pushLine(to, [{ type:'text', text:'🔍 ไม่พบใบส่งของ "' + dkw + '" (บริษัท ' + dCo.name + ') ใน Odoo' }]);
      return;
    }

    // กรองตาม statusFilter
    let picks = allPicks.filter(p => {
      if (statusFilter === 'done')    return p.state === 'done';
      if (statusFilter === 'all')     return true;
      return p.state !== 'done' && p.state !== 'cancel'; // pending = ค่าเริ่มต้น
    });

    // กรองตามวันที่ Scheduled (ถ้าระบุ) — เทียบเฉพาะส่วนวันที่ (YYYY-MM-DD)
    if (dateFilter) {
      picks = picks.filter(p => {
        const sd = String(p.scheduled_date || '').slice(0, 10);
        return sd === dateFilter;
      });
    }

    if (!picks.length) {
      const label = statusFilter === 'done' ? 'ส่งแล้ว' : statusFilter === 'all' ? 'ทั้งหมด' : 'รอส่ง';
      const dnote = dateFilter ? ' วันที่ ' + dateFilter : '';
      await pushLine(to, [{ type:'text', text:'🔍 ไม่พบใบส่งของสถานะ "' + label + '"' + dnote + ' ของ "' + dkw + '" ครับ\n(มีทั้งหมด ' + allPicks.length + ' ใบ ลอง /ใบส่งของ ' + dkw + ' ทั้งหมด)' }]);
      return;
    }

    // นับสถานะ
    let cntDone = 0, cntPending = 0, cntCancel = 0;
    const picksData = picks.map(p => {
      let statusText, statusColor;
      if (p.state === 'done')        { statusText='ส่งแล้ว'; statusColor='red';   cntDone++; }
      else if (p.state === 'cancel') { statusText='ยกเลิก';  statusColor='gray';  cntCancel++; }
      else                           { statusText='รอส่ง';   statusColor='green'; cntPending++; }
      return {
        name: p.name || '-',
        origin: p.origin || '',
        partner: Array.isArray(p.partner_id) ? p.partner_id[1] : '',
        statusText, statusColor, shipped: p.state === 'done',
        date: String(p.date_done || p.scheduled_date || '').slice(0, 10),
        lines: (p.lines || []).map(l => ({
          name: Array.isArray(l.product_id) ? l.product_id[1] : '',
          qty: l.quantity || l.product_uom_qty || 0,
          uom: Array.isArray(l.product_uom) ? l.product_uom[1] : ''
        })),
        images: p.images || []
      };
    });

    const statusLabel = statusFilter === 'done' ? 'ส่งแล้ว' : statusFilter === 'all' ? 'ทั้งหมด' : 'รอส่ง';
    const data = {
      summary: { total: picks.length, done: cntDone, pending: cntPending, cancel: cntCancel },
      picks: picksData
    };

    // บันทึกลง delivery_views แล้วส่งลิงก์หน้าเว็บ (ภาษาไทยชัด เปิดบนมือถือ/พิมพ์ PDF ได้)
    const viewId = 'D' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();
    const { error: insErr } = await db.from('delivery_views').insert({
      id: viewId,
      title: 'ใบส่งของ — ' + dkw + ' (' + dCo.name + ')',
      company: dCo.name,
      status_label: statusLabel,
      data: data
    });
    if (insErr) { await pushLine(to, [{ type:'text', text:'⚠️⚠️⚠️ บันทึกใบส่งของไม่สำเร็จ: ' + insErr.message }]); return; }

    const viewUrl = 'https://inventory-rho-hazel.vercel.app/delivery.html?id=' + viewId;
    const sumLine = 'รวม ' + picks.length + ' ใบ'
      + (cntDone    ? ' | ส่งแล้ว ' + cntDone    : '')
      + (cntPending ? ' | รอส่ง '   + cntPending : '')
      + (cntCancel  ? ' | ยกเลิก '  + cntCancel  : '');
    await pushLine(to, [{
      type: 'text',
      text: '📄 ใบส่งของ "' + dkw + '" — ' + dCo.name + ' [' + statusLabel + ']\n' + sumLine + '\n\n📎 เปิดดูใบส่งของ:\n' + viewUrl
    }]);
  } catch (e) {
    await pushLine(to, [{ type:'text', text:'⚠️⚠️⚠️ สร้างใบส่งของไม่สำเร็จ: ' + e.message }]);
  }
}

// ── helper ───────────────────────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().slice(0, 10);
const rid = () => 'T' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 5).toUpperCase();

// แปลงวันที่ จาก 5/6/2026 หรือ 5/6/69 → 2026-06-05
function parseDate(s) {
  if (!s) return null;
  // รองรับทั้งมีปีและไม่มีปี: 12/6, 12/6/69, 12-6-2569
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (!m) return null;
  let [, d, mo, y] = m;
  if (y === undefined) {
    y = new Date().getFullYear(); // ไม่มีปี → ปีปัจจุบัน (ค.ศ.)
  } else {
    y = +y;
    if (y < 100) {
      // ปี 2 หลัก: >=50 = พ.ศ. (69→2569), <50 = ค.ศ. (26→2026)
      if (y >= 50) y += 2500;
      else y += 2000;
    }
    if (y >= 2400) y -= 543; // พ.ศ. → ค.ศ.
  }
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  return y + '-' + String(+mo).padStart(2,'0') + '-' + String(+d).padStart(2,'0');
}

// ── parse ข้อความ → งานใหม่ ──────────────────────────────────────────────────
// รองรับหลายรูปแบบ:
// 1) /งานใหม่ รับ ชื่องาน วันที่ 5/6/2026 @สมชาย
// 2) รับ: ชื่องาน วันที่ 5/6/2026
// 3) ส่ง: ชื่องาน 5/6/2026 สมชาย
function parseTask(text) {
  const t = text.trim();

  // ตรวจรูปแบบ /งานใหม่
  if (!t.startsWith('/งานใหม่') && !t.startsWith('/new') &&
      !t.match(/^(รับ|ส่ง)[:\s]/)) return null;

  let task = '', duration = 'รับ', actionDate = todayStr(), salesName = '';

  // ดึงประเภท รับ/ส่ง — เช็คเฉพาะคำขึ้นต้น (กันชื่องานที่มีคำว่า ส่ง/รับ ปนอยู่)
  if (/^\/?(งานใหม่|new)?\s*ส่ง[:\s]/.test(t) || /^ส่ง[:\s]/.test(t)) duration = 'ส่ง';
  else duration = 'รับ';

  // ดึงวันที่ (รองรับ วันที่ XX/XX/XXXX หรือตัวเลขโดด)
  const dateMatch = t.match(/(?:วันที่\s*)?(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
  if (dateMatch) {
    const parsed = parseDate(dateMatch[1]);
    if (parsed) actionDate = parsed;
  }

  // ดึงชื่อผู้รับผิดชอบ (@ชื่อ)
  const atMatch = t.match(/@([^\s@]+)/);
  if (atMatch) salesName = atMatch[1];

  // ดึงชื่องาน (ลบ keyword ออก)
  let taskText = t
    .replace(/^\/งานใหม่/, '').replace(/^\/new/i, '')
    .replace(/(?:วันที่\s*)?\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/, '')
    .replace(/@\S+/g, '')
    .replace(/รับ[:\s]?|ส่ง[:\s]?/g, '')
    .replace(/\s+/g, ' ').trim();

  if (!taskText) return null;
  task = taskText;

  return { task, duration, actionDate, salesName };
}

// ── ตารางตัวย่อหมวด → ชื่อเต็ม (ตรงกับ categories ใน web) ──────────────────
const CAT_ALIAS = {
  'เสา': 'งานเสาไฟฟ้า',
  'เสาอุปกรณ์': 'งานเสาไฟฟ้าและอุปกรณ์',
  'ชุบ': 'บริการชุบกัลวาไนซ์',
  'ป้าย': 'งานป้าย',
  'ป้ายเฟรม': 'งานป้าย+เฟรม',
  'เฟรม': 'งานเฟรม',
  'มาส': 'งาน mast arm',
  'ไฟฟ้า': 'งานอุปกรณ์ไฟฟ้า',
  'ราก': 'งานรากฐาน',
  'พัสดุ': 'งานส่งพัสดุ',
  'การ์ดเรล': 'งานการ์ดเรล',
  'ซ่อม': 'ซ่อมบำรุง',
  'ไฟ': 'แผนกไฟฟ้า',
  'ซิลิกัล': 'ซิลิกัล',
  'so': 'ใบสั่งซื้อ( so )',
  'ผลิต': 'วัตถุดิบเพื่อการผลิต',
  'สิ้นเปลือง': 'วัตถุดิบสิ้นเปลือง',
  'อื่นๆ': 'อื่นๆ'
};

// ── จับวันที่ทุกรูปแบบ: วันนี้/พรุ่งนี้, 16/6/69, 16/6/2026, 16มิ.ย., 16มิถุนายน2569 ──
function smartParseDate(text) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const fmt = (y, m, d) => y + '-' + pad(m) + '-' + pad(d);
  const toCE = y => { y = +y; if (y < 100) y += 2500; if (y >= 2500) y -= 543; return y; };
  const thMonth = { 'มกราคม':1,'ม.ค':1,'กุมภาพันธ์':2,'ก.พ':2,'มีนาคม':3,'มี.ค':3,'เมษายน':4,'เม.ย':4,'พฤษภาคม':5,'พ.ค':5,'มิถุนายน':6,'มิ.ย':6,'กรกฎาคม':7,'ก.ค':7,'สิงหาคม':8,'ส.ค':8,'กันยายน':9,'ก.ย':9,'ตุลาคม':10,'ต.ค':10,'พฤศจิกายน':11,'พ.ย':11,'ธันวาคม':12,'ธ.ค':12 };
  const monthAlt = Object.keys(thMonth).sort((a,b)=>b.length-a.length).join('|');

  if (/วันนี้/.test(text)) { const d=now; return fmt(d.getFullYear(), d.getMonth()+1, d.getDate()); }
  if (/พรุ่งนี้/.test(text)) { const d=new Date(now.getTime()+86400000); return fmt(d.getFullYear(), d.getMonth()+1, d.getDate()); }
  if (/มะรืน/.test(text)) { const d=new Date(now.getTime()+2*86400000); return fmt(d.getFullYear(), d.getMonth()+1, d.getDate()); }

  let m = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) { const d=+m[1], mo=+m[2], y=toCE(m[3]); if(mo>=1&&mo<=12&&d>=1&&d<=31) return fmt(y, mo, d); }

  // วัน/เดือน ไม่มีปี เช่น 16/6 → ใช้ปีปัจจุบัน (ถ้าผ่านไปแล้วขยับเป็นปีหน้า)
  m = text.match(/(\d{1,2})[\/\-](\d{1,2})(?![\/\-\d])/);
  if (m) {
    const d=+m[1], mo=+m[2];
    if (mo>=1 && mo<=12 && d>=1 && d<=31) {
      let y = now.getFullYear();
      const cand = new Date(y, mo-1, d);
      if (cand < new Date(now.getFullYear(), now.getMonth(), now.getDate())) y++;
      return fmt(y, mo, d);
    }
  }

  m = text.match(new RegExp('(\\d{1,2})\\s*(' + monthAlt + ')\\.?\\s*(\\d{2,4})'));
  if (m) { const d=+m[1], mo=thMonth[m[2]], y=toCE(m[3]); if(mo) return fmt(y, mo, d); }

  m = text.match(new RegExp('(\\d{1,2})\\s*(' + monthAlt + ')\\.?'));
  if (m) {
    const d=+m[1], mo=thMonth[m[2]];
    if (mo) {
      let y = now.getFullYear();
      const cand = new Date(y, mo-1, d);
      if (cand < new Date(now.getFullYear(), now.getMonth(), now.getDate())) y++;
      return fmt(y, mo, d);
    }
  }
  return null;
}

// ── เดางานจากข้อความธรรมชาติ (ใช้เมื่อแท็กบอท) ───────────────────────────────
// รูปแบบ: @TMS Bot [ข้อความงาน] [ตัวย่อหมวด] [ชื่อผู้รับผิดชอบ]
// เช่น: @TMS Bot ส่งของปราจีนบุรี วันที่10มิถุนายน ชุบ พี่เต้ย
async function parseTaskSmart(text, dbClient, typedText) {
  let t = text.replace(/@[^\s@]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // เดาประเภท ส่ง/รับ จากคำในข้อความ
  let duration = 'รับ';
  const sendWords = /(ส่งของ|นัดส่ง|ส่งที่|จัดส่ง|ขอส่ง|จะส่ง|ส่งงาน|ออกของ|นำส่ง|แจ้งส่ง|รายการจัดส่ง|ส่งตาม|ส่งให้|ส่งสินค้า|delivery|งานส่ง)/;
  const recvWords = /(รับของ|รับเข้า|มารับ|ขอรับ|จะรับ|รับงาน|เข้ารับ|รับสินค้า|แจ้งรับ|รับตาม)/;
  if (sendWords.test(t)) duration = 'ส่ง';
  else if (recvWords.test(t)) duration = 'รับ';

  // ระบุเองได้: ถ้าที่พิมพ์ขึ้นต้นด้วย "ส่ง" หรือ "รับ" → ใช้อันนั้นเลย (override)
  // เช่น reply แล้วพิมพ์ "ส่ง เสา พี่เต้ย" → บังคับเป็นงานส่ง
  let typedBody = typedText || '';
  const mExplicit = typedBody.match(/^\s*(ส่ง|รับ)\s+/);
  if (mExplicit) {
    duration = mExplicit[1];
    typedBody = typedBody.replace(/^\s*(ส่ง|รับ)\s+/, '').trim(); // ตัดคำ ส่ง/รับ ออก
  }

  // ดึงวันที่ — typedText มี priority สูงกว่า (พิมพ์เองตอน reply ชนะวันในข้อความเดิมเสมอ)
  let actionDate = todayStr();
  const dateFromTyped = typedText ? smartParseDate(typedText) : null;
  if (dateFromTyped) {
    actionDate = dateFromTyped; // ใช้วันที่ที่พิมพ์มาเอง
  } else {
    const parsedDate = smartParseDate(t); // fallback → วันแรกในข้อความเดิม
    if (parsedDate) actionDate = parsedDate;
  }

  // ตัดวันที่ออกจากข้อความ (ข้อความงานต้นฉบับ) — ครอบคลุมทุกรูปแบบ
  const thMonthAlt = 'มกราคม|ม.ค|กุมภาพันธ์|ก.พ|มีนาคม|มี.ค|เมษายน|เม.ย|พฤษภาคม|พ.ค|มิถุนายน|มิ.ย|กรกฎาคม|ก.ค|สิงหาคม|ส.ค|กันยายน|ก.ย|ตุลาคม|ต.ค|พฤศจิกายน|พ.ย|ธันวาคม|ธ.ค';
  let body = t.replace(/วันนี้|พรุ่งนี้|มะรืน/g, '')
              .replace(new RegExp('(?:วันที่\\s*)?\\d{1,2}\\s*(?:' + thMonthAlt + ')\\.?\\s*\\d{0,4}', 'g'), '')
              .replace(/(?:วันที่\s*)?\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/g, '')
              .replace(/\s+/g, ' ').trim();

  // ── จับหมวดหมู่ + ผู้รับผิดชอบ ───────────────────────────────────────────
  // หมวด+ชื่อ มาจาก "ที่พิมพ์" (typedBody เช่น "เสา พี่เต้ย") ไม่ใช่จากข้อความงาน
  let categories = '', salesName = '';
  let catList = [];
  if (dbClient) {
    try {
      const { data } = await dbClient.from('categories').select('name');
      catList = (data || []).map(c => String(c.name || ''));
    } catch (e) {}
  }

  // แยกคำจากที่พิมพ์ (typedBody) — รูปแบบ: [ตัวย่อหมวด] [ชื่อ]
  // ตัดวันที่ออกจาก typedBody ก่อน (กันวันที่กลายเป็นหมวด/ชื่อ)
  let typedClean = (typedBody || '')
    .replace(/วันนี้|พรุ่งนี้|มะรืน/g, '')
    .replace(new RegExp('(?:วันที่\\s*)?\\d{1,2}\\s*(?:' + thMonthAlt + ')\\.?\\s*\\d{0,4}', 'g'), '')
    .replace(/(?:วันที่\s*)?\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?/g, '')
    .replace(/\s+/g, ' ').trim();

  const typedWords = typedClean.split(/\s+/).filter(Boolean);
  if (typedWords.length >= 2) {
    // 2 คำขึ้นไป: คำแรก=ตัวย่อหมวด, ที่เหลือ=ชื่อ
    const catWord = typedWords[0];
    const fullCat = CAT_ALIAS[catWord];                          // ลองตัวย่อก่อน
    if (fullCat) {
      categories = fullCat;
    } else {
      // ไม่ตรงตัวย่อ → ลองเทียบกับชื่อเต็มใน DB
      const matched = catList.find(c => c === catWord || c.includes(catWord) || catWord.includes(c));
      categories = matched || catWord;
    }
    salesName = typedWords.slice(1).join(' ');
  } else if (typedWords.length === 1) {
    // คำเดียว: ลองตัวย่อก่อน ถ้าตรง = หมวด, ไม่ตรง = ชื่อคน
    const w = typedWords[0];
    const fullCat = CAT_ALIAS[w];
    if (fullCat) {
      categories = fullCat;
    } else {
      const matched = catList.find(c => c === w || c.includes(w) || w.includes(c));
      if (matched) categories = matched;
      else salesName = w;
    }
  }

  // ชื่องาน = ข้อความงานต้นฉบับเท่านั้น (ตัดส่วนที่พิมพ์ตอน reply ออก)
  // ลองตัด typedText ดิบก่อน (เช่น "ส่ง เสา พี่นิค") แล้วค่อย typedBody ("เสา พี่นิค")
  let taskBody = body;
  const rawTyped = (typedText || '').trim();
  if (rawTyped && taskBody.endsWith(rawTyped)) {
    taskBody = taskBody.slice(0, taskBody.length - rawTyped.length).trim();
  } else if (typedBody && taskBody.endsWith(typedBody)) {
    taskBody = taskBody.slice(0, taskBody.length - typedBody.length).trim();
  }
  // ถ้าตัดจนว่าง (ไม่ได้ reply, พิมพ์อย่างเดียว) ใช้ typedBody เป็นชื่องาน
  const words = (taskBody || typedBody || '').split(' ');
  let task = words.join(' ').trim();
  if (task.length > 200) task = task.slice(0, 200);
  if (!task) return null;

  return { task, duration, actionDate, salesName, categories };
}

// ── โหลดไฟล์/รูปจาก LINE (Get Content API) ───────────────────────────────────
async function getLineContent(messageId) {
  const r = await fetch('https://api-data.line.me/v2/bot/message/' + messageId + '/content', {
    headers: { 'Authorization': 'Bearer ' + LINE_TOKEN }
  });
  if (!r.ok) throw new Error('โหลดไฟล์จาก LINE ไม่ได้: ' + r.status);
  const arrayBuf = await r.arrayBuffer();
  const contentType = r.headers.get('content-type') || 'application/octet-stream';
  return { buffer: Buffer.from(arrayBuf), contentType };
}

// ── ย่อรูปก่อนเก็บ (ประหยัด Storage) — ถ้าไม่ใช่รูปหรือย่อไม่ได้ คืนของเดิม ──
async function compressIfImage(buffer, contentType) {
  // ย่อเฉพาะรูปภาพ (jpeg/png/webp) ไฟล์อื่น เช่น PDF ไม่แตะ
  if (!/^image\/(jpe?g|png|webp)/i.test(contentType || '')) {
    return { buffer, contentType };
  }
  try {
    const sharp = (await import('sharp')).default;
    const out = await sharp(buffer)
      .rotate() // หมุนตาม EXIF orientation
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();
    // ถ้าย่อแล้วเล็กลงจริง ค่อยใช้ ไม่งั้นใช้ของเดิม
    if (out.length < buffer.length) return { buffer: out, contentType: 'image/jpeg' };
    return { buffer, contentType };
  } catch (e) {
    // sharp ใช้ไม่ได้ → เก็บรูปเต็มแทน (ไม่พัง)
    return { buffer, contentType };
  }
}

// ── แนบไฟล์เข้างานล่าสุด (ภายใน 5 นาที) ──────────────────────────────────────
async function attachFileToLastTask(dbClient, groupId, messageId, msgType, fileName) {
  // หางานล่าสุดของกลุ่มนี้ (ภายใน 5 นาที)
  const { data: last } = await dbClient.from('line_last_task')
    .select('task_id, task_name, created_at').eq('group_id', groupId).maybeSingle();
  if (!last || !last.task_id) return { error: 'ไม่พบงานล่าสุดในกลุ่มนี้ (ต้องสร้างงานก่อนแนบไฟล์)' };

  // โหลดไฟล์จาก LINE + ย่อรูป
  const raw = await getLineContent(messageId);
  const { buffer, contentType } = await compressIfImage(raw.buffer, raw.contentType);

  // ตั้งชื่อไฟล์ + นามสกุล
  const ext = msgType === 'image' ? '.jpg' : (fileName && fileName.includes('.') ? '' : '.bin');
  const safeName = fileName || (msgType === 'image' ? 'image.jpg' : 'file' + ext);
  const ts = Date.now();
  const storagePath = last.task_id + '/' + ts + '_' + safeName.replace(/[^\w.\-ก-๙]/g, '_');

  // อัปขึ้น Storage
  const { error: upErr } = await dbClient.storage.from('attachments')
    .upload(storagePath, buffer, { contentType, upsert: true });
  if (upErr) return { error: 'อัปไฟล์ไม่สำเร็จ: ' + upErr.message };

  const { data: pub } = dbClient.storage.from('attachments').getPublicUrl(storagePath);

  // อ่าน attachments เดิม แล้วเพิ่มไฟล์ใหม่
  const { data: taskRow } = await dbClient.from('tasks')
    .select('attachments').eq('id', last.task_id).maybeSingle();
  let atts = [];
  if (taskRow && taskRow.attachments) {
    atts = Array.isArray(taskRow.attachments) ? taskRow.attachments : [];
  }
  atts.push({
    name: safeName,
    size: buffer.length,
    fileId: storagePath,
    mimeType: contentType,
    webViewLink: pub.publicUrl
  });

  const { error: updErr } = await dbClient.from('tasks')
    .update({ attachments: atts }).eq('id', last.task_id);
  if (updErr) return { error: 'บันทึกไฟล์เข้างานไม่สำเร็จ: ' + updErr.message };

  return { ok: true, taskName: last.task_name, count: atts.length };
}

// ── verify LINE signature ─────────────────────────────────────────────────────
function verifySignature(body, signature) {
  if (!LINE_SECRET) return true; // ถ้ายังไม่ตั้ง secret ให้ผ่านไปก่อน
  const hash = crypto.createHmac('SHA256', LINE_SECRET).update(body).digest('base64');
  return hash === signature;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(200).json({ ok: true }); return; }

  try {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const sig = req.headers['x-line-signature'] || '';

    if (!verifySignature(rawBody, sig)) {
      res.status(401).json({ ok: false, error: 'Invalid signature' });
      return;
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const events = body.events || [];

    for (const event of events) {
      if (event.type !== 'message') continue;

      const msgType = event.message?.type || '';
      const replyToken = event.replyToken;
      const senderName = event.source?.userId || '';
      const pushTarget = event.source?.groupId || event.source?.roomId || event.source?.userId || '';
      const mentionees = event.message?.mention?.mentionees || [];
      const botMentioned = mentionees.some(m => m.isSelf === true);
      const quotedId = event.message?.quotedMessageId || '';

      // ══ กรณีไฟล์/รูป → เก็บ messageId + เช็ค session นำเข้าใบส่งของ ══
      if (msgType === 'image' || msgType === 'file') {
        if (db) {
          try {
            await db.from('line_messages').upsert({
              message_id: event.message.id,
              group_id: pushTarget,
              user_id: senderName,
              text: null,
              msg_type: msgType,
              file_name: event.message?.fileName || null
            }, { onConflict: 'message_id' });
          } catch (e) {}
        }

        // ── เช็ค session นำเข้าใบส่งของ (รับ Excel) ──────────────────────────
        const fname = event.message?.fileName || '';
        // LINE ส่ง msgType='file' เสมอสำหรับไฟล์ทุกประเภท ดูจากนามสกุลไฟล์แทน
        const isExcel = /\.xlsx?$/i.test(fname) || msgType === 'file';
        if (isExcel && db && pushTarget) {
          const { data: xlsSess } = await db.from('tg_report_session')
            .select('*').eq('chat_id', String(pushTarget)).maybeSingle();
          const xlsAge = xlsSess ? (Date.now() - new Date(xlsSess.updated_at).getTime()) / 60000 : 999;
          if (xlsSess && xlsSess.mode === 'import_delivery' && xlsAge < 15) {
            try {
              // ดาวน์โหลดไฟล์จาก LINE (ใช้ LINE_TOKEN ตัวเดียวกับทั้งไฟล์)
              const fileR = await fetch(`https://api-data.line.me/v2/bot/message/${event.message.id}/content`, {
                headers: { Authorization: 'Bearer ' + LINE_TOKEN }
              });
              if (!fileR.ok) {
                await pushLine(pushTarget, [{ type:'text', text:'❌ ดาวน์โหลดไฟล์จาก LINE ไม่สำเร็จ (' + fileR.status + ') ครับ' }]);
                continue;
              }
              const xlsBuf = Buffer.from(await fileR.arrayBuffer());
              // เช็คว่าเป็นไฟล์ xlsx จริง (ขึ้นต้นด้วย PK = zip signature)
              if (xlsBuf.length < 100 || xlsBuf[0] !== 0x50 || xlsBuf[1] !== 0x4B) {
                await pushLine(pushTarget, [{ type:'text', text:'❌ ไฟล์ที่ได้รับไม่ใช่ Excel ที่ถูกต้องครับ (ขนาด ' + xlsBuf.length + ' bytes)' }]);
                continue;
              }

              const XLSX = await import('xlsx');
              const wb = XLSX.read(xlsBuf, { type: 'buffer' });
              const ws = wb.Sheets[wb.SheetNames[0]];
              const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

              // อ่านรายการสินค้า:
              // โครงสร้าง Excel: col A=ลำดับ, B=รหัสสินค้า, C=ชื่อสินค้า, F=จำนวน
              const lines = [];
              for (let ri = 0; ri < rows.length; ri++) {
                const row = rows[ri];
                let code = row[1] ? String(row[1]).trim() : '';
                const name = row[2] ? String(row[2]).trim() : '';
                const qty  = row[5];
                if (code && !/^[A-Z0-9]{2,}-[A-Z0-9\-]{5,}/.test(code)) code = '';
                if (!code && !name) continue;
                const qtyNum = parseFloat(String(qty || '0').replace(/[^0-9.]/g, '')) || 0;
                if (qtyNum <= 0) continue;
                lines.push({ productCode: code, productName: name.slice(0, 120), qty: qtyNum });
              }

              if (!lines.length) {
                await pushLine(pushTarget, [{ type:'text', text:'⚠️ ไม่พบรายการสินค้าในไฟล์ Excel ครับ\nต้องมีรหัสสินค้า (เช่น 08RO-127-...) หรือชื่อสินค้า พร้อมจำนวน' }]);
                continue;
              }

              await pushLine(pushTarget, [{ type:'text', text:'⏳ พบ ' + lines.length + ' รายการ กำลังสร้าง picking ใน Odoo...' }]);

              const { odooCreatePickingFromLines: createPicking } = await import('./odoo.js');
              const { pickingId, matchedCode, matchedName, notFound } = await createPicking(
                xlsSess.doc_id,
                lines,
                null,
                xlsSess.doc_name || '',
                xlsSess.company_id
              );

              await db.from('tg_report_session').delete().eq('chat_id', String(pushTarget));

              const addedCount = matchedCode.length + matchedName.length;
              let reply = '✅ สร้าง picking สำเร็จแล้วครับ!\n\n';
              reply += '📋 Picking ID: ' + pickingId + '\n';
              reply += '📦 เพิ่มสินค้า: ' + addedCount + '/' + lines.length + ' รายการ\n';
              reply += '🏭 โครงการ: ' + (xlsSess.doc_name || '');

              if (matchedName.length) {
                reply += '\n\n⚠️ ต้องตรวจสอบ ' + matchedName.length + ' รายการ (จับคู่จากชื่อ ไม่ใช่รหัส):\n';
                matchedName.forEach(r => {
                  const fromName = (r.line.productName || r.line.productCode || '-').slice(0, 35);
                  const toName = (r.product.name || '-').slice(0, 35);
                  reply += '• "' + fromName + '"\n   → จับเป็น: ' + toName + '\n';
                });
                reply += 'กรุณาเปิด picking ใน Odoo เช็คว่าตรงไหมครับ';
              }

              if (notFound.length) {
                reply += '\n\n❌ ไม่พบใน Odoo ' + notFound.length + ' รายการ (ไม่ได้เพิ่ม):\n';
                notFound.forEach(r => {
                  const label = r.line.productCode || r.line.productName || '-';
                  reply += '• ' + String(label).slice(0, 45) + '\n';
                });
                reply += 'กรุณาเพิ่มเองใน Odoo ครับ';
              }

              if (!matchedName.length && !notFound.length) {
                reply += '\n✅ ทุกรายการจับคู่จากรหัสสินค้าตรงเป๊ะ';
              }

              await pushLine(pushTarget, [{ type:'text', text: reply }]);
            } catch (e) {
              await pushLine(pushTarget, [{ type:'text', text:'❌ สร้าง picking ไม่สำเร็จ: ' + e.message }]);
            }
            continue;
          }
        }
        continue;
      }

      // ข้ามไฟล์/รูป/สติกเกอร์/พิกัด ที่ไม่ได้แท็กบอท (ไม่ยุ่ง)
      if (msgType !== 'text') continue;

      const text = event.message.text || '';

      // ── เก็บทุกข้อความ (text) ลง DB เพื่อให้ reply ย้อนหลังได้ (เก็บ 7 วัน) ──
      const msgId = event.message?.id || '';
      if (db && msgId) {
        try {
          await db.from('line_messages').upsert({
            message_id: msgId,
            group_id: pushTarget,
            user_id: senderName,
            text: text
          }, { onConflict: 'message_id' });
        } catch (e) {}
      }

      // ── ถ้าเป็นการ reply ข้อความเก่า → ดึงข้อความต้นฉบับจาก DB ──────────────
      let quotedText = '';
      if (db && quotedId) {
        try {
          const { data } = await db.from('line_messages')
            .select('text').eq('message_id', quotedId).maybeSingle();
          if (data && data.text) quotedText = data.text;
        } catch (e) {}
      }

      const tt = text.trim();
      const lc = tt.toLowerCase();

      // ── +1 → reply รูป/ไฟล์ แล้วพิมพ์ +1 → แนบเข้างานล่าสุด (เงียบใน LINE) ──
      if (/^\+\d+$/.test(tt)) {
        if (!db) continue;
        try {
          if (!quotedId) continue;
          const { data: quotedMsg } = await db.from('line_messages')
            .select('msg_type, file_name').eq('message_id', quotedId).maybeSingle();
          const fileMsgType = quotedMsg?.msg_type || 'image';
          const fname = quotedMsg?.file_name || '';

          const { data: last } = await db.from('line_last_task')
            .select('task_id, task_name').eq('group_id', pushTarget).maybeSingle();
          if (!last || !last.task_id) {
            continue; // ไม่มีงานให้แนบ — เงียบ ไม่ใช่ error การบันทึก
          }

          const raw = await getLineContent(quotedId);
          const { buffer, contentType } = await compressIfImage(raw.buffer, raw.contentType);
          const safeName = fname || (fileMsgType === 'image' ? 'image.jpg' : 'file.bin');
          const ts = Date.now();
          const ext2 = safeName.includes('.') ? safeName.slice(safeName.lastIndexOf('.')) : '';
          const storagePath = last.task_id + '/' + ts + ext2;

          const { error: upErr } = await db.storage.from('attachments')
            .upload(storagePath, buffer, { contentType, upsert: true });
          if (upErr) {
            try { await notifyMainChat('⚠️ <b>แนบไฟล์จากไลน์ไม่สำเร็จ</b> (อัปโหลด)\n📋 ' + (last.task_name || '') + '\n' + upErr.message); } catch (e) {}
            continue;
          }

          const { data: pub } = db.storage.from('attachments').getPublicUrl(storagePath);
          const { data: taskRow } = await db.from('tasks')
            .select('attachments').eq('id', last.task_id).maybeSingle();
          let atts = Array.isArray(taskRow?.attachments) ? taskRow.attachments : [];
          atts.push({ name: safeName, size: buffer.length, fileId: storagePath, mimeType: contentType, webViewLink: pub.publicUrl });

          const { error: updErr } = await db.from('tasks').update({ attachments: atts }).eq('id', last.task_id);
          if (updErr) {
            try { await notifyMainChat('⚠️ <b>แนบไฟล์จากไลน์ไม่สำเร็จ</b> (บันทึก)\n📋 ' + (last.task_name || '') + '\n' + updErr.message); } catch (e) {}
            continue;
          }
          // สำเร็จ → เงียบ ไม่ตอบ LINE ไม่แจ้ง Telegram
        } catch (e) {
          try { await notifyMainChat('⚠️ <b>แนบไฟล์จากไลน์ไม่สำเร็จ</b>\n' + e.message); } catch (e2) {}
        }
        continue;
      }

      // ── ตอบเลข 1-8 → เลือกใบส่งของสำหรับ /เทียบ (เมื่อเจอหลายใบ) ──────────────
      if (/^\d+$/.test(tt) && db) {
        const { data: sel } = await db.from('line_compare_select')
          .select('*').eq('group_id', pushTarget).maybeSingle();
        const age = sel ? (Date.now() - new Date(sel.created_at).getTime()) / 60000 : 999;
        if (sel && age < 5) {
          const idx = parseInt(tt, 10) - 1;
          const picks = sel.picks || [];
          if (idx < 0 || idx >= picks.length) {
            await replyLine(replyToken, '⚠️ กรุณาตอบเลข 1-' + picks.length + ' ครับ');
          } else {
            await db.from('line_compare_select').delete().eq('group_id', pushTarget);
            await replyLine(replyToken, '⏳ กำลังดึงข้อมูลเปรียบเทียบ...');
            if (pushTarget) {
              const cmpSel = companyById(sel.company_id);
              await sendDeliveryCompare(pushTarget, sel.doc_ref, picks[idx], cmpSel);
            }
          }
          continue;
        }
      }

      // ── /เทียบ so1234 po5678 [ตัวย่อบริษัท] → เปรียบเทียบ (เว็บ) ────────────
      // รองรับ 2 รูปแบบ:
      //   1) /เทียบ so1234 po5678 [md]                          → เทียบ SO/PO/PR กันเอง
      //   2) /เทียบ po2606025 ใบส่งของ กท.1002 12/6 [md]        → เทียบกับใบส่งของ
      //      /เทียบ ใบส่งของ กท.1002 12/6 po2606025 [md]        → (สลับลำดับได้)
      if (tt.startsWith('/เทียบ') || tt.toLowerCase().startsWith('/compare')) {
        const arg = tt.replace(/^\/เทียบ/,'').replace(/^\/compare/i,'').trim();
        const { keyword: argClean, company: cmp } = parseCompany(arg);

        const parseDocRef = (s) => {
          const m = s.match(/^(so|po|pr)(\w+)$/i);
          if (!m) return null;
          return { type: m[1].toLowerCase(), num: m[2] };
        };

        const words = argClean.trim().split(/\s+/).filter(Boolean);
        const sIdx = words.findIndex(w => w === 'ส่งของ' || w === 'ใบส่งของ');

        // ── mode 2: เทียบกับใบส่งของ ─────────────────────────────────────────
        if (sIdx !== -1) {
          let refOther = null, refIdx = -1;
          for (let i = 0; i < words.length; i++) {
            if (i === sIdx) continue;
            const r = parseDocRef(words[i]);
            if (r) { refOther = r; refIdx = i; break; }
          }
          if (!refOther) {
            await replyLine(replyToken,
              'รูปแบบไม่ถูกต้องครับ ตัวอย่าง:\n/เทียบ po2606025 ใบส่งของ กท.1002 12/6\nหรือ /เทียบ ใบส่งของ กท.1002 12/6 po2606025'
            );
            continue;
          }
          let deliveryKw = words.filter((w,i) => i !== sIdx && i !== refIdx).join(' ').trim();
          if (!deliveryKw) {
            await replyLine(replyToken, 'พิมพ์ชื่อโครงการของใบส่งของด้วยครับ เช่น /เทียบ po2606025 ใบส่งของ กท.1002');
            continue;
          }
          // ดึงวันที่จากท้าย deliveryKw (ถ้ามี)
          let dateFilter = null;
          const dm = deliveryKw.match(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\s*$/);
          if (dm) { dateFilter = parseDate(dm[1]); deliveryKw = deliveryKw.replace(dm[0],'').trim(); }

          if (!odooConfigured()) { await replyLine(replyToken, '⚠️⚠️⚠️ ยังไม่ได้ตั้งค่า Odoo ครับ'); continue; }
          await replyLine(replyToken, '🔍 กำลังค้นหาใบส่งของ "' + deliveryKw + '"...');

          if (pushTarget) {
            await (async () => {
              try {
                const allPicks = await odooDelivery(deliveryKw, cmp.id);
                let picks = allPicks;
                if (dateFilter) {
                  const f = picks.filter(p => String(p.scheduled_date || '').slice(0,10) === dateFilter);
                  if (f.length) picks = f;
                }
                if (!picks.length) {
                  await pushLine(pushTarget, [{ type:'text', text:'🔍 ไม่พบใบส่งของ "' + deliveryKw + '"' + (dateFilter ? ' วันที่ ' + dm[1] : '') + ' ครับ' }]);
                  return;
                }
                if (picks.length > 1) {
                  const opts = picks.slice(0,8).map((p,i) =>
                    (i+1) + '. ' + (p.name || '-') + (p.scheduled_date ? ' (' + String(p.scheduled_date).slice(0,10) + ')' : '')
                  ).join('\n');
                  if (db) {
                    await db.from('line_compare_select').upsert({
                      group_id: pushTarget,
                      picks: picks.slice(0,8),
                      doc_ref: refOther,
                      company_id: cmp.id,
                      created_at: new Date().toISOString()
                    }, { onConflict: 'group_id' });
                  }
                  await pushLine(pushTarget, [{ type:'text', text:'🔍 พบ ' + picks.length + ' ใบส่งของที่ตรงกับ "' + deliveryKw + '":\n' + opts + '\n\nตอบเลขที่ต้องการครับ' }]);
                  return;
                }
                await sendDeliveryCompare(pushTarget, refOther, picks[0], cmp);
              } catch (e) {
                await pushLine(pushTarget, [{ type:'text', text:'⚠️⚠️⚠️ เปรียบเทียบไม่สำเร็จ: ' + e.message }]);
              }
            })();
          }
          continue;
        }

        // ── mode 1: เทียบ SO/PO/PR กันเอง (แบบเดิม) ──────────────────────────
        const parts = words;
        if (parts.length < 2) {
          await replyLine(replyToken, 'พิมพ์ให้ครบครับ เช่น /เทียบ so1234 po5678\nหรือ /เทียบ so1234 po5678 md\nหรือ /เทียบ po2606025 ใบส่งของ กท.1002 12/6');
          continue;
        }
        const refA = parseDocRef(parts[0]);
        const refB = parseDocRef(parts[1]);
        if (!refA || !refB) {
          await replyLine(replyToken, 'รูปแบบไม่ถูกต้องครับ ตัวอย่าง: /เทียบ so1234 po5678');
          continue;
        }
        if (!odooConfigured()) { await replyLine(replyToken, '⚠️⚠️⚠️ ยังไม่ได้ตั้งค่า Odoo ครับ'); continue; }
        await replyLine(replyToken, '⏳ กำลังดึงข้อมูลเปรียบเทียบ...');
        if (pushTarget) {
          await (async () => {
            try {
              const compareData = await odooCompare(refA.type, refA.num, refB.type, refB.num, cmp.id);
              const labelA = refA.type.toUpperCase() + refA.num;
              const labelB = refB.type.toUpperCase() + refB.num;

              // สรุปตัวเลข
              const rows = compareData.rows || [];
              const cntOk   = rows.filter(r=>r.status==='ok').length;
              const cntDiff = rows.filter(r=>r.status==='diff').length;
              const cntMis  = rows.filter(r=>r.status==='missing_a' || r.status==='missing_b').length;

              // บันทึกลง delivery_views → ได้ลิงก์หน้าเว็บเปรียบเทียบ
              const viewId = 'C' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();
              const { error: insErr } = await db.from('delivery_views').insert({
                id: viewId,
                title: 'เปรียบเทียบ ' + labelA + ' vs ' + labelB,
                company: cmp.name || '',
                status_label: cmp.name || '',
                data: {
                  typeA: refA.type, numA: refA.num, typeB: refB.type, numB: refB.num,
                  docA: compareData.docA, docB: compareData.docB,
                  rows
                }
              });
              if (insErr) { await pushLine(pushTarget, [{ type:'text', text:'⚠️⚠️⚠️ บันทึกข้อมูลไม่สำเร็จ: ' + insErr.message }]); return; }

              const webLink = 'https://inventory-rho-hazel.vercel.app/compare.html?id=' + viewId;
              await pushLine(pushTarget, [{
                type: 'text',
                text: '📊 เปรียบเทียบ ' + labelA + ' vs ' + labelB + ' (' + cmp.name + ')\n\n' +
                      '✅ ตรงกัน: ' + cntOk + ' รายการ\n' +
                      (cntDiff ? '⚠️ ต่างกัน: ' + cntDiff + ' รายการ\n' : '') +
                      (cntMis  ? '❌ ขาด: ' + cntMis  + ' รายการ\n' : '') +
                      '\n📎 เปิดดูรายละเอียด:\n' + webLink
              }]);
            } catch (e) {
              await pushLine(pushTarget, [{ type:'text', text:'⚠️⚠️⚠️ เปรียบเทียบไม่สำเร็จ: ' + e.message }]);
            }
          })();
        }
        continue;
      }

      // ── /ใบส่งของ → สร้าง PDF อัป Storage แล้วส่งลิงก์ (เดิม /ส่งของ — เก็บไว้เป็น alias) ──
      if (tt.startsWith('/ใบส่งของ') || tt.startsWith('/ส่งของ') || tt.startsWith('/จัดส่ง') || lc.startsWith('/delivery')) {
        let kw = tt.replace(/^\/ใบส่งของ/, '').replace(/^\/ส่งของ/, '').replace(/^\/จัดส่ง/, '').replace(/^\/delivery/i, '').trim();
        if (!kw) {
          await replyLine(replyToken, 'พิมพ์ชื่อโครงการด้วยครับ เช่น /ใบส่งของ อุตรดิตถ์\nพิมพ์ต่อท้ายได้: รอ / ส่งแล้ว / ทั้งหมด');
        } else {
          // ดึง statusFilter จากคำท้าย (default = รอส่ง)
          let statusFilter = 'pending';
          let statusGiven = false;
          const statusRe = /\s+(ทั้งหมด|all|ส่งแล้ว|เสร็จแล้ว|done|รอส่ง|รอ|pending)(\s+(?:md|cg|sep|akn|set))?\s*$/i;
          kw = kw.replace(statusRe, (match, st, comp) => {
            statusGiven = true;
            const ml = st.toLowerCase();
            if (['ทั้งหมด','all'].includes(ml))                    statusFilter = 'all';
            else if (['ส่งแล้ว','เสร็จแล้ว','done'].includes(ml)) statusFilter = 'done';
            else                                                    statusFilter = 'pending';
            return comp ? comp : '';
          }).trim();

          // ดึงวันที่ Scheduled (ถ้ามี) เช่น "กท.1002 12/6"
          let dateFilter = null;
          const dm = kw.match(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\s*$/);
          if (dm) {
            dateFilter = parseDate(dm[1]);
            kw = kw.replace(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\s*$/, '').trim();
            if (!statusGiven) statusFilter = 'all'; // มีวันที่แต่ไม่ระบุสถานะ → ทุกสถานะของวันนั้น
          }

          const label = statusFilter === 'done' ? 'ส่งแล้ว' : statusFilter === 'all' ? 'ทั้งหมด' : 'รอส่ง';
          const dateNote = dm ? ' วันที่ ' + dm[1] : '';
          await replyLine(replyToken, '⏳ กำลังสร้างใบส่งของ [' + label + ']' + dateNote + ' ของ "' + kw + '" ครับ...');
          if (pushTarget) {
            await sendDeliveryPDFtoLine(pushTarget, kw, statusFilter, dateFilter).catch(async (e) => {
              await pushLine(pushTarget, [{ type:'text', text:'⚠️⚠️⚠️ สร้างใบส่งของไม่สำเร็จ: ' + e.message }]);
            });
          }
        }
        continue;
      }

      // ── คำสั่ง Odoo อื่นๆ (/สต็อก /po /so /pr /help) → เรียก rpc.js ──────
      if (tt.startsWith('/สต็อก') || tt.startsWith('/stock') ||
          tt.startsWith('/อัพเดทสต็อกการ์ดเรล') || tt.startsWith('/อัปเดทสต็อกการ์ดเรล') || lc.startsWith('/guardrailstock') ||
          lc.startsWith('/po') || tt.startsWith('/พีโอ') ||
          lc.startsWith('/so') || tt.startsWith('/ขาย') ||
          lc.startsWith('/pr') || tt.startsWith('/ขอซื้อ')) {
        try {
          const reply = await handleTelegramCommand(tt);
          await replyLine(replyToken, reply || '🔍 ไม่พบข้อมูลครับ');
        } catch (e) {
          await replyLine(replyToken, '⚠️⚠️⚠️ ดึงข้อมูลไม่สำเร็จ: ' + e.message);
        }
        continue;
      }

      // ── /นำเข้าใบส่งของ → ค้น Operation Type + จัดการ session ─────────────
      if (tt.startsWith('/นำเข้าใบส่งของ') || lc.startsWith('/importdelivery')) {
        if (!db) { await replyLine(replyToken, '⚠️⚠️⚠️ ยังไม่ได้เชื่อมต่อฐานข้อมูลครับ'); continue; }
        try {
          const rawReply = await handleTelegramCommand(tt);
          if (rawReply.includes('__OPTYPE_LIST__:')) {
            const markerIdx = rawReply.indexOf('__OPTYPE_LIST__:');
            const displayMsg = rawReply.slice(0, markerIdx).trim();
            const markerStr = rawReply.slice(markerIdx + '__OPTYPE_LIST__:'.length);
            const [listPart, coPart] = markerStr.split('::CO:');
            const coId = parseInt(coPart) || 1;
            const opts = listPart.split(';;').map(s => {
              const [id, ...nameParts] = s.split('|');
              return { id: parseInt(id), name: nameParts.join('|') };
            });
            await db.from('tg_report_session').upsert({
              chat_id: String(pushTarget),
              mode: 'import_optype_select',
              options: opts,
              company_id: coId,
              updated_at: new Date().toISOString()
            });
            await replyLine(replyToken, displayMsg.replace(/<[^>]+>/g, ''));
          } else if (rawReply.includes('__PENDING_DELIVERY_IMPORT__:')) {
            const markerIdx = rawReply.indexOf('__PENDING_DELIVERY_IMPORT__:');
            const displayMsg = rawReply.slice(0, markerIdx).trim();
            const markerStr = rawReply.slice(markerIdx + '__PENDING_DELIVERY_IMPORT__:'.length);
            const [opId, opName, coId] = markerStr.split(':');
            await db.from('tg_report_session').upsert({
              chat_id: String(pushTarget),
              mode: 'import_delivery',
              doc_id: parseInt(opId),
              doc_name: opName,
              company_id: parseInt(coId) || 1,
              updated_at: new Date().toISOString()
            });
            await replyLine(replyToken, displayMsg.replace(/<[^>]+>/g, ''));
          } else {
            await replyLine(replyToken, rawReply.replace(/<[^>]+>/g, ''));
          }
        } catch (e) {
          await replyLine(replyToken, '⚠️⚠️⚠️ ดึงข้อมูลไม่สำเร็จ: ' + e.message);
        }
        continue;
      }

      // ── /ยกเลิก — ยกเลิก session นำเข้าใบส่งของ ──────────────────────────
      if (tt === '/ยกเลิก' || tt === '/cancel') {
        if (db && pushTarget) {
          const { data: canSess } = await db.from('tg_report_session')
            .select('mode').eq('chat_id', String(pushTarget)).maybeSingle();
          if (canSess && (canSess.mode === 'import_delivery' || canSess.mode === 'import_optype_select')) {
            await db.from('tg_report_session').delete().eq('chat_id', String(pushTarget));
            await replyLine(replyToken, '✅ ยกเลิกการนำเข้าใบส่งของแล้วครับ');
            continue;
          }
        }
      }

      // ── ตอบตัวเลข session เลือก Operation Type ──────────────────────────────
      if (/^\d+$/.test(tt) && db && pushTarget) {
        const { data: impSess } = await db.from('tg_report_session')
          .select('*').eq('chat_id', String(pushTarget)).maybeSingle();
        const impAge = impSess ? (Date.now() - new Date(impSess.updated_at).getTime()) / 60000 : 999;
        if (impSess && impSess.mode === 'import_optype_select' && impAge < 5) {
          const idx = parseInt(tt) - 1;
          const opts = impSess.options || [];
          if (idx < 0 || idx >= opts.length) {
            await replyLine(replyToken, '⚠️ กรุณาตอบเลข 1-' + opts.length + ' ครับ');
          } else {
            const chosen = opts[idx];
            await db.from('tg_report_session').update({
              mode: 'import_delivery',
              doc_id: chosen.id,
              doc_name: chosen.name,
              updated_at: new Date().toISOString()
            }).eq('chat_id', String(pushTarget));
            await replyLine(replyToken, '✅ เลือกโครงการ:\n' + chosen.name + '\n\n📎 กรุณาแนบไฟล์ Excel ใบส่งของในข้อความถัดไปได้เลยครับ\n(พิมพ์ /ยกเลิก เพื่อยกเลิก)');
          }
          continue;
        }
      }

      // ── คำสั่ง /help ─────────────────────────────────────────────────────
      if (text.trim() === '/help' || text.trim() === '/ช่วยเหลือ') {
        await replyLine(replyToken,
          '🤖 TMS Bot — คำสั่งที่ใช้ได้\n\n' +
          '📦 /สต็อก [ชื่อสินค้า] — เช็คสต็อก\n' +
          '🛣️ /อัพเดทสต็อกการ์ดเรล [md/cg/sep] — เช็คสต็อกการ์ดเรลทั้งหมด\n' +
          '📥 /นำเข้าใบส่งของ [คำค้นโครงการ] + แนบ Excel — สร้าง picking ใน Odoo\n' +
          '🧾 /po [เลขที่] — ใบสั่งซื้อ\n' +
          '🧾 /so [เลขที่] — ใบสั่งขาย\n' +
          '📄 /pr [เลขที่] — ใบขอซื้อ\n' +
          '🚚 /ใบส่งของ [ชื่อโครงการ] — ใบส่งของ (PDF)\n\n' +
          '🏢 เลือกบริษัท: เติม md/cg/sep ท้ายคำ\n' +
          'เช่น /สต็อก เหล็ก cg\n\n' +
          '━━━━━━━━━━\n' +
          '📋 สร้างงาน: รับ: ชื่องาน 5/6/2026 @ผู้รับผิดชอบ\n' +
          '📊 /สรุป — ดูสรุปงาน'
        );
        continue;
      }

      // ── คำสั่ง /สรุป ─────────────────────────────────────────────────────
      if (text.trim() === '/สรุป') {
        if (!db) { await replyLine(replyToken, '⚠️⚠️⚠️ ยังไม่ได้เชื่อมต่อฐานข้อมูลครับ'); continue; }
        const { data } = await db.from('tasks').select('task_status, done');
        const list = data || [];
        const todo  = list.filter(t => !t.done && t.task_status === 'To Do').length;
        const doing = list.filter(t => !t.done && t.task_status === 'Doing').length;
        const done  = list.filter(t => t.done).length;
        await replyLine(replyToken,
          `📊 สรุปงานทั้งหมด\n\n` +
          `📋 ทั้งหมด: ${list.length} งาน\n` +
          `🔵 To Do: ${todo}\n` +
          `🟣 Doing: ${doing}\n` +
          `✅ Done: ${done}`
        );
        continue;
      }

      // ── แก้ไฟล์ → reply ข้อความเดิม + แท็กบอท + "แก้ไฟล์" → ล้างไฟล์เก่า (เงียบใน LINE) ──
      if (botMentioned) {
        let cleanForCmd = tt;
        const sortedM2 = [...mentionees].filter(m => m.isSelf === true && typeof m.index === 'number').sort((a,b) => b.index - a.index);
        for (const m of sortedM2) { cleanForCmd = cleanForCmd.slice(0, m.index) + cleanForCmd.slice(m.index + m.length); }
        cleanForCmd = cleanForCmd.replace(/\s+/g, ' ').trim();
        if (/^แก้ไฟล์$/i.test(cleanForCmd)) {
          if (!db) continue;

          // หางานที่ reply มา — จาก task_id ที่ผูกกับ quotedId ก่อน (แม่นตรงงาน)
          let fTaskId = null, fTaskName = '';
          if (quotedId) {
            const { data: qmsg } = await db.from('line_messages')
              .select('task_id').eq('message_id', quotedId).maybeSingle();
            if (qmsg && qmsg.task_id) fTaskId = qmsg.task_id;
          }
          // fallback → งานล่าสุดของกลุ่ม
          if (!fTaskId) {
            const { data: last } = await db.from('line_last_task')
              .select('task_id, task_name').eq('group_id', pushTarget).maybeSingle();
            if (last && last.task_id) { fTaskId = last.task_id; fTaskName = last.task_name; }
          }
          if (!fTaskId) continue; // ไม่พบงาน — เงียบ ไม่ใช่ error การบันทึก

          if (!fTaskName) {
            const { data: trow } = await db.from('tasks').select('task').eq('id', fTaskId).maybeSingle();
            fTaskName = trow?.task ? trow.task.slice(0, 100) : '';
          }

          // อัปเดต line_last_task ให้ชี้งานนี้ → +1 ที่ตามมาจะแนบเข้างานเดียวกัน
          try {
            await db.from('line_last_task').upsert({
              group_id: pushTarget, task_id: fTaskId, task_name: fTaskName,
              created_at: new Date().toISOString()
            }, { onConflict: 'group_id' });
          } catch (e) {}

          const { error: clrErr } = await db.from('tasks')
            .update({ attachments: [] }).eq('id', fTaskId);
          if (clrErr) {
            try { await notifyMainChat('⚠️ <b>ล้างไฟล์ (จากไลน์) ไม่สำเร็จ</b>\n📋 ' + fTaskName + '\n' + clrErr.message); } catch (e) {}
            continue;
          }
          // สำเร็จ → เงียบ ไม่ตอบ LINE ไม่แจ้ง Telegram
          continue;
        }
      }

      // ── เปลี่ยนวัน → reply ข้อความเดิม + แท็กบอท + "เปลี่ยนวัน 20/6/69" (เงียบใน LINE) ──
      if (botMentioned) {
        // ตัด @mention ออกโดยใช้ตำแหน่งจริงจาก mentionees
        let cleanTT = tt;
        const sortedM = [...mentionees].filter(m => m.isSelf === true && typeof m.index === 'number').sort((a,b) => b.index - a.index);
        for (const m of sortedM) {
          cleanTT = cleanTT.slice(0, m.index) + cleanTT.slice(m.index + m.length);
        }
        cleanTT = cleanTT.replace(/\s+/g, ' ').trim();
        const isChangDate = /^เปลี่ยนวัน/.test(cleanTT);
        if (isChangDate) {
          if (!db) continue;
          // ดึงวันที่จาก cleanTT ก่อน — ถ้า LINE แปลง 12/6 เป็น URL ให้ดึงจาก entities แทน
          let dateStr = null;
          const dmatch = cleanTT.match(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/);
          if (dmatch) {
            dateStr = dmatch[1];
          } else {
            const ents = event.message?.entities || [];
            for (const ent of ents) {
              if (ent.type === 'url') {
                const utext = tt.slice(ent.offset, ent.offset + ent.length);
                const um = utext.match(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/);
                if (um) { dateStr = um[1]; break; }
              }
            }
          }
          if (!dateStr) continue; // ไม่ได้ระบุวันที่ — เงียบ ไม่ใช่ error การบันทึก
          const newDate = parseDate(dateStr);
          if (!newDate) continue; // วันที่อ่านไม่ได้ — เงียบ ไม่ใช่ error การบันทึก

          // หางานที่ reply มา — จาก task_id ที่ผูกกับ quotedId ก่อน (แม่นยำตรงงาน)
          let targetTaskId = null, targetTaskName = '';
          if (quotedId) {
            const { data: qmsg } = await db.from('line_messages')
              .select('task_id').eq('message_id', quotedId).maybeSingle();
            if (qmsg && qmsg.task_id) targetTaskId = qmsg.task_id;
          }
          // fallback → งานล่าสุดของกลุ่ม (กรณีไม่เจอ)
          if (!targetTaskId) {
            const { data: last } = await db.from('line_last_task')
              .select('task_id, task_name').eq('group_id', pushTarget).maybeSingle();
            if (last && last.task_id) { targetTaskId = last.task_id; targetTaskName = last.task_name; }
          }
          if (!targetTaskId) continue; // ไม่พบงาน — เงียบ ไม่ใช่ error การบันทึก

          // ดึงชื่องานถ้ายังไม่มี
          if (!targetTaskName) {
            const { data: trow } = await db.from('tasks').select('task').eq('id', targetTaskId).maybeSingle();
            targetTaskName = trow?.task ? trow.task.slice(0, 100) : '';
          }

          const { error: updErr } = await db.from('tasks')
            .update({ action_date: newDate }).eq('id', targetTaskId);
          if (updErr) {
            try { await notifyMainChat('⚠️ <b>แก้ไขวันที่ (จากไลน์) ไม่สำเร็จ</b>\n📋 ' + targetTaskName + '\n' + updErr.message); } catch (e) {}
            continue;
          }
          const [y2, m2, d2] = newDate.split('-');
          const dateDisplay = `${+d2}/${+m2}/${+y2+543}`;
          // แจ้งเข้ากลุ่ม Telegram หลัก (แทนการตอบ LINE)
          try {
            await notifyMainChat(
              '✏️ <b>แก้ไขวันที่งาน (จากไลน์)</b>\n' +
              '📋 ' + targetTaskName + '\n' +
              '📅 เปลี่ยนเป็น ' + dateDisplay
            );
          } catch (e) {}
          continue;
        }
      }

      // ── สร้างงานใหม่ ──────────────────────────────────────────────────────
      // กฎ: รับงาน = ต้อง Reply ข้อความงาน + แท็กบอท เท่านั้น
      // (mentionees, botMentioned, quotedId ประกาศไว้ข้างบนแล้ว)

      // แบบเดิม (รับ:/ส่ง:/งานใหม่) — พิมพ์ตรงๆ ยังใช้ได้
      let taskData = parseTask(text);

      // แบบ Reply: ต้องเป็นการ reply (มี quotedId) + แท็กบอท
      if (!taskData && botMentioned && quotedId) {
        // ตัด mention บอทออกตรงตำแหน่งจริง (index+length) กันคำว่า Bot ค้าง
        let typedClean = text;
        const botMentions = mentionees
          .filter(m => m.isSelf === true && typeof m.index === 'number' && typeof m.length === 'number')
          .sort((a, b) => b.index - a.index);
        for (const m of botMentions) {
          typedClean = typedClean.slice(0, m.index) + typedClean.slice(m.index + m.length);
        }
        typedClean = typedClean.replace(/@[^\s@]+/g, ' ').replace(/\s+/g, ' ').trim();

        // กัน false-positive: ถ้าที่พิมพ์สั้นเกินไปและไม่มีเนื้อหางาน
        // เช่น "รับ so", "ok", "ขอบคุณ", "so" → ไม่สร้างงาน
        const REPLY_NOISE = /^(รับ|ส่ง|ok|okay|โอเค|ขอบคุณ|ขอบคุณครับ|ขอบคุณค่ะ|ได้เลย|เรียบร้อย|รับทราบ|noted|รับ so|ส่ง so|รับso|ส่งso)$/i;
        const typedWords = typedClean.split(/\s+/).filter(Boolean);
        // ถ้าพิมพ์สั้น (≤2 คำ) และไม่มีวันที่ และไม่มีคำบอกสถานที่/งาน → ข้ามเลย ไม่รวม quotedText
        const hasDate = /\d{1,2}[\/\-]\d{1,2}|วันที่|พรุ่งนี้|วันนี้|มะรืน/.test(typedClean);
        const hasTaskHint = /(ส่งของ|นัดส่ง|จัดส่ง|รับของ|รับเข้า|เข้ารับ|ไปรับ|ไปส่ง|นำส่ง|งาน)/.test(typedClean);
        const isNoise = REPLY_NOISE.test(typedClean) || (typedWords.length <= 2 && !hasDate && !hasTaskHint);

        // ถ้าเจอข้อความเดิมที่ reply และไม่ใช่ noise → รวม | ถ้า noise → ใช้แค่ที่พิมพ์
        const combined = (quotedText && !isNoise)
          ? (quotedText + ' ' + typedClean).trim()
          : typedClean;
        taskData = await parseTaskSmart(combined, db, typedClean);
      }

      if (taskData) {
        if (!db) continue;

        const id = rid();
        const { error } = await db.from('tasks').insert({
          id,
          task: taskData.task,
          duration: taskData.duration,
          action_date: taskData.actionDate,
          sales_name: taskData.salesName,
          task_status: 'To Do',
          notification: 'แจ้งล่วงหน้า',
          categories: taskData.categories || '',
          note: '',
          doing: false,
          done: false,
          attachments: []
        });

        if (error) {
          try { await notifyMainChat('⚠️ <b>บันทึกงานใหม่ (จากไลน์) ไม่สำเร็จ</b>\n📋 ' + taskData.task + '\n' + error.message); } catch (e) {}
        } else {
          // จำงานล่าสุดของกลุ่มนี้ (สำหรับแนบไฟล์ +1)
          try {
            await db.from('line_last_task').upsert({
              group_id: pushTarget,
              task_id: id,
              task_name: taskData.task.slice(0, 100),
              created_at: new Date().toISOString()
            }, { onConflict: 'group_id' });
          } catch (e) {}

          // ผูก task_id กับข้อความที่ reply (สำหรับ "เปลี่ยนวัน"/"แก้ไฟล์" ย้อนหลัง)
          if (quotedId) {
            try {
              await db.from('line_messages')
                .update({ task_id: id }).eq('message_id', quotedId);
            } catch (e) {}
          }

          const dur = taskData.duration === 'รับ' ? '📦 รับ' : '🚚 ส่ง';
          const [y, m, d] = taskData.actionDate.split('-');
          const dateDisplay = `${+d}/${+m}/${+y+543}`;
          // แจ้งเข้ากลุ่ม Telegram หลักทันที (แทนการตอบ LINE)
          try {
            await notifyMainChat(
              `🆕 <b>งานใหม่จากไลน์</b>\n` +
              `📋 ${taskData.task}\n` +
              `${dur}  📅 ${dateDisplay}\n` +
              (taskData.salesName ? `👤 ${taskData.salesName}\n` : '') +
              (taskData.categories ? `🏷️ ${taskData.categories}` : '')
            );
          } catch (e) {}
        }
        continue;
      }
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('LINE webhook error:', e.message);
    res.status(200).json({ ok: true });
  }
}
