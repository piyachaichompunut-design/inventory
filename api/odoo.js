// ============================================================================
//  api/odoo.js — ตัวเชื่อม Odoo ผ่าน JSON-RPC
//  ใช้ fetch ล้วน ไม่ต้องลง npm package เพิ่ม
//  ตั้งค่าใน Environment Variables ของ Vercel:
//    ODOO_URL       = https://seterp.odoo.com
//    ODOO_DB        = seterp
//    ODOO_USERNAME  = อีเมลที่ล็อกอิน Odoo
//    ODOO_API_KEY   = API Key ที่สร้างไว้
// ============================================================================
const ODOO_URL  = (process.env.ODOO_URL || '').replace(/\/+$/, ''); // ตัด / ท้าย
const ODOO_DB   = process.env.ODOO_DB       || '';
const ODOO_USER = process.env.ODOO_USERNAME || '';
const ODOO_KEY  = process.env.ODOO_API_KEY  || '';

let _uid = null; // cache uid ไว้ใช้ซ้ำใน request เดียว

// ── ตรวจว่าตั้งค่าครบหรือยัง ─────────────────────────────────────────────────
export function odooConfigured() {
  return !!(ODOO_URL && ODOO_DB && ODOO_USER && ODOO_KEY);
}

// ── เรียก JSON-RPC พื้นฐาน ───────────────────────────────────────────────────
async function jsonRpc(service, method, args) {
  const res = await fetch(ODOO_URL + '/jsonrpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { service, method, args },
      id: Date.now()
    })
  });
  const data = await res.json();
  if (data.error) {
    const m = data.error.data?.message || data.error.message || 'Odoo error';
    throw new Error(m);
  }
  return data.result;
}

// ── ล็อกอินเอา uid ──────────────────────────────────────────────────────────
async function odooAuth() {
  if (_uid) return _uid;
  _uid = await jsonRpc('common', 'authenticate', [ODOO_DB, ODOO_USER, ODOO_KEY, {}]);
  if (!_uid) throw new Error('authenticate ล้มเหลว — เช็ค DB / Username / API Key');
  return _uid;
}

// ── search_read แบบทั่วไป ────────────────────────────────────────────────────
async function searchRead(model, domain, fields, limit = 20) {
  const uid = await odooAuth();
  return await jsonRpc('object', 'execute_kw', [
    ODOO_DB, uid, ODOO_KEY,
    model, 'search_read',
    [domain],
    { fields, limit }
  ]);
}

// ── ค้นหาสต็อกสินค้า ─────────────────────────────────────────────────────────
// รองรับหลายคำ: "แผ่น 3.2 ชุบ" → หาสินค้าที่ชื่อมีทุกคำ (ไม่ต้องเรียงติดกัน)
export async function odooStock(keyword) {
  const words = String(keyword).trim().split(/\s+/).filter(Boolean);

  let domain;
  if (words.length <= 1) {
    // คำเดียว: ค้นทั้งชื่อ และรหัสสินค้า
    const kw = words[0] || '';
    domain = ['|', ['name', 'ilike', kw], ['default_code', 'ilike', kw]];
  } else {
    // หลายคำ: ชื่อต้องมีทุกคำ (AND) — Odoo domain ใช้ '&' นำหน้าเชื่อม 2 เงื่อนไข
    // เช่น 3 คำ → ['&','&', cond1, cond2, cond3]
    domain = [];
    for (let i = 0; i < words.length - 1; i++) domain.push('&');
    words.forEach(w => domain.push(['name', 'ilike', w]));
  }

  return await searchRead(
    'product.product',
    domain,
    ['name', 'default_code', 'qty_available', 'virtual_available', 'uom_id'],
    15
  );
}

// ── ดูใบสั่งซื้อ (PO) พร้อมรายการสินค้า ──────────────────────────────────────
export async function odooPO(poNumber) {
  const orders = await searchRead(
    'purchase.order',
    ['|', ['name', 'ilike', poNumber], ['partner_ref', 'ilike', poNumber]],
    ['name', 'partner_id', 'state', 'date_order', 'amount_total', 'partner_ref'],
    5
  );
  // ดึงรายการสินค้าของแต่ละ PO
  for (const o of orders) {
    o.lines = await searchRead(
      'purchase.order.line',
      [['order_id', '=', o.id]],
      ['product_id', 'product_qty', 'qty_received', 'price_unit', 'price_subtotal'],
      50
    );
  }
  return orders;
}
