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

// ── แยกคำอัตโนมัติ: "ภูเก็ต4+570" → ["ภูเก็ต","4+570"] ──────────────────────
// ตัดตรงรอยต่อ ไทย↔ตัวเลข ทั้งสองทาง + รองรับเว้นวรรคปกติ
function smartWords(keyword) {
  let s = String(keyword).trim();
  // แทรกช่องว่างตรงรอยต่อ ตัวอักษรไทย→ตัวเลข และ ตัวเลข→ตัวอักษรไทย
  s = s.replace(/([\u0E00-\u0E7F])(\d)/g, '$1 $2');
  s = s.replace(/(\d)([\u0E00-\u0E7F])/g, '$1 $2');
  return s.split(/\s+/).filter(Boolean);
}

// ── ค้นหาสต็อกสินค้า ─────────────────────────────────────────────────────────
// รองรับหลายคำ: "15FG แผ่น 3.2 ชุบ" → หาสินค้าที่ทุกคำอยู่ในชื่อหรือรหัส
// (ไม่ต้องเรียงติดกัน — แต่ละคำหาได้ทั้งใน name และ default_code)
export async function odooStock(keyword) {
  const words = smartWords(keyword);

  let domain;
  if (words.length <= 1) {
    const kw = words[0] || '';
    domain = ['|', ['name', 'ilike', kw], ['default_code', 'ilike', kw]];
  } else {
    // หลายคำ: ทุกคำต้องเจอ (AND) โดยแต่ละคำหาได้ทั้งชื่อหรือรหัส (OR)
    // โครงสร้าง domain: '&' (n-1 ตัว) แล้วตามด้วยแต่ละคำที่เป็น ['|', name, code]
    domain = [];
    for (let i = 0; i < words.length - 1; i++) domain.push('&');
    words.forEach(w => {
      domain.push('|');
      domain.push(['name', 'ilike', w]);
      domain.push(['default_code', 'ilike', w]);
    });
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

// ── search_read แบบปลอดภัย: ถ้า field/model ไม่มี จะไม่พังทั้งหมด ──────────────
async function safeSearchRead(model, domain, fields, limit) {
  try {
    return await searchRead(model, domain, fields, limit);
  } catch (e) {
    // ถ้า field บางตัวไม่มีในระบบนี้ ลองใหม่ด้วย field พื้นฐานสุด
    try {
      return await searchRead(model, domain, ['name'], limit);
    } catch (e2) {
      throw e; // โยน error เดิมกลับไป
    }
  }
}

// ── ดูใบสั่งขาย (SO) พร้อมรายการสินค้า ───────────────────────────────────────
export async function odooSO(soNumber) {
  const orders = await safeSearchRead(
    'sale.order',
    ['|', ['name', 'ilike', soNumber], ['client_order_ref', 'ilike', soNumber]],
    ['name', 'partner_id', 'state', 'date_order', 'amount_total', 'client_order_ref'],
    5
  );
  for (const o of orders) {
    try {
      o.lines = await searchRead(
        'sale.order.line',
        [['order_id', '=', o.id]],
        ['product_id', 'product_uom_qty', 'qty_delivered', 'price_unit', 'price_subtotal'],
        50
      );
    } catch (e) { o.lines = []; }
  }
  return orders;
}

// ── ดูใบขอซื้อ (PR — Purchase Request, โมดูล OCA: purchase.request) ───────────
export async function odooPR(prNumber) {
  const reqs = await safeSearchRead(
    'purchase.request',
    [['name', 'ilike', prNumber]],
    ['name', 'state', 'requested_by', 'date_start', 'description'],
    5
  );
  for (const r of reqs) {
    try {
      r.lines = await searchRead(
        'purchase.request.line',
        [['request_id', '=', r.id]],
        ['product_id', 'name', 'product_qty', 'product_uom_id'],
        50
      );
    } catch (e) { r.lines = []; }
  }
  return reqs;
}

// ── ดูใบส่งของ/จัดส่ง (Delivery Order = stock.picking ประเภท outgoing) ────────
// ค้นหลายคำ: "ภูเก็ต 4+570" → หาใบที่ origin/name/ลูกค้า มีทุกคำ (ไม่ต้องเรียงติดกัน)
export async function odooDelivery(keyword) {
  const words = smartWords(keyword);

  // แต่ละคำ → ต้องเจอใน (name หรือ origin หรือชื่อลูกค้า) = OR 3 ช่อง
  // แล้วทุกคำต้องเจอ = AND
  const oneWord = (w) => ['|', '|',
    ['name', 'ilike', w],
    ['origin', 'ilike', w],
    ['partner_id.name', 'ilike', w]
  ];

  let domain;
  if (words.length <= 1) {
    domain = oneWord(words[0] || '');
  } else {
    domain = [];
    for (let i = 0; i < words.length - 1; i++) domain.push('&');
    words.forEach(w => { domain.push(...oneWord(w)); });
  }

  const pickings = await safeSearchRead(
    'stock.picking',
    domain,
    ['name', 'origin', 'partner_id', 'state', 'scheduled_date', 'date_done', 'picking_type_id'],
    40
  );
  for (const p of pickings) {
    try {
      p.lines = await searchRead(
        'stock.move',
        [['picking_id', '=', p.id]],
        ['product_id', 'product_uom_qty', 'quantity', 'product_uom'],
        50
      );
    } catch (e) { p.lines = []; }
  }
  return pickings;
}
