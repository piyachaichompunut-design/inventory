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

// ── แผนที่ตัวย่อบริษัท → company_id ──────────────────────────────────────────
//   ไม่ใส่ตัวย่อ = อาคเนย์ทร้าฟฟิค (id 1) เป็นค่าเริ่มต้น
//   md = เมิร์ค (2) | cg = ซิลิกัล (4) | sep = ศรีอาคเนย์ (5)
const COMPANY_ALIAS = {
  md:  { id: 2, name: 'เมิร์ค' },
  cg:  { id: 4, name: 'ซิลิกัล' },
  sep: { id: 5, name: 'ศรีอาคเนย์' },
  akn: { id: 1, name: 'อาคเนย์' },  // เผื่ออยากระบุอาคเนย์ชัดๆ
  set: { id: 1, name: 'อาคเนย์' },
};
const DEFAULT_COMPANY = { id: 1, name: 'อาคเนย์' };

// แยกตัวย่อบริษัทออกจากคำค้น เช่น "ภูเก็ต 4+570 md" → { keyword:'ภูเก็ต 4+570', company:{id:2} }
export function parseCompany(text) {
  const parts = String(text).trim().split(/\s+/);
  const last = (parts[parts.length - 1] || '').toLowerCase();
  if (COMPANY_ALIAS[last]) {
    parts.pop(); // เอาตัวย่อออก
    return { keyword: parts.join(' ').trim(), company: COMPANY_ALIAS[last] };
  }
  return { keyword: String(text).trim(), company: DEFAULT_COMPANY };
}

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

// ── เติมเงื่อนไขบริษัทเข้า domain (AND) ──────────────────────────────────────
// ถ้ามี companyId → ['&', ['company_id','=',companyId], ...domainเดิม]
function withCompany(domain, companyId) {
  if (!companyId) return domain;
  return ['&', ['company_id', '=', companyId], ...domain];
}

// ── แยกคำอัตโนมัติ ───────────────────────────────────────────────────────────
function smartWords(keyword) {
  let s = String(keyword).trim();
  s = s.replace(/([\u0E00-\u0E7F])(\d)/g, '$1 $2');
  s = s.replace(/(\d)([\u0E00-\u0E7F])/g, '$1 $2');
  return s.split(/\s+/).filter(Boolean);
}

// ── parse keyword ก่อนค้น: รองรับ [รหัส], ---, ชื่อสินค้า ─────────────────────
// ตัวอย่าง:
//   "[07RP-016-00-00-02] แบตเตอรี่---12V 7.5Ah" → code="07RP-016-00-00-02", name="แบตเตอรี่ 12V 7.5Ah"
//   "[07RP-016-00-00-02]"                         → code="07RP-016-00-00-02", name=""
//   "แบตเตอรี่---12V 7.5Ah"                       → code="", name="แบตเตอรี่ 12V 7.5Ah"
function parseStockKeyword(raw) {
  let s = String(raw).trim();
  // ดึงรหัสจาก [...] ถ้ามี
  let code = '';
  const bracketMatch = s.match(/\[([^\]]+)\]/);
  if (bracketMatch) {
    code = bracketMatch[1].trim();
    s = s.replace(/\[[^\]]+\]/, '').trim();
  }
  // ทำความสะอาดชื่อสินค้า: แทน --- หรือ ----- ด้วยช่องว่าง
  s = s.replace(/-{2,}/g, ' ').trim();
  return { code, name: s };
}

// ── ค้นหาสต็อกสินค้า ─────────────────────────────────────────────────────────
export async function odooStock(keyword, companyId) {
  const { code, name } = parseStockKeyword(keyword);

  // ถ้ามีรหัส → ค้นรหัสตรงๆ ก่อน (แม่นที่สุด)
  if (code && !name) {
    const domain = ['|', ['default_code', 'ilike', code], ['name', 'ilike', code]];
    return await searchRead('product.product', domain,
      ['name', 'default_code', 'qty_available', 'virtual_available', 'uom_id'], 15);
  }

  // ถ้ามีทั้งรหัสและชื่อ → ค้นรหัสก่อน ถ้าไม่เจอค่อยค้นชื่อ
  if (code && name) {
    const byCode = await searchRead('product.product',
      ['|', ['default_code', 'ilike', code], ['name', 'ilike', code]],
      ['name', 'default_code', 'qty_available', 'virtual_available', 'uom_id'], 15);
    if (byCode.length) return byCode;
    // fallback ค้นชื่อ
    const words = smartWords(name);
    return await searchRead('product.product', buildWordsDomain(words),
      ['name', 'default_code', 'qty_available', 'virtual_available', 'uom_id'], 15);
  }

  // ค้นชื่อล้วน
  const words = smartWords(name || keyword);
  const domain = buildWordsDomain(words);
  return await searchRead('product.product', domain,
    ['name', 'default_code', 'qty_available', 'virtual_available', 'uom_id'], 15);
}

// helper: สร้าง domain จากหลายคำ (AND ของแต่ละคำ, OR ระหว่าง name กับ code)
function buildWordsDomain(words) {
  if (!words.length) return [['name', 'ilike', '']];
  if (words.length === 1) {
    return ['|', ['name', 'ilike', words[0]], ['default_code', 'ilike', words[0]]];
  }
  const domain = [];
  for (let i = 0; i < words.length - 1; i++) domain.push('&');
  words.forEach(w => {
    domain.push('|');
    domain.push(['name', 'ilike', w]);
    domain.push(['default_code', 'ilike', w]);
  });
  return domain;
}

// ── ดูใบสั่งซื้อ (PO) พร้อมรายการสินค้า ──────────────────────────────────────
export async function odooPO(poNumber, companyId) {
  const orders = await searchRead(
    'purchase.order',
    withCompany(['|', ['name', 'ilike', poNumber], ['partner_ref', 'ilike', poNumber]], companyId),
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
export async function odooSO(soNumber, companyId) {
  const orders = await safeSearchRead(
    'sale.order',
    withCompany(['|', ['name', 'ilike', soNumber], ['client_order_ref', 'ilike', soNumber]], companyId),
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
export async function odooPR(prNumber, companyId) {
  const reqs = await safeSearchRead(
    'purchase.request',
    withCompany([['name', 'ilike', prNumber]], companyId),
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

// ── เทียบสินค้าระหว่าง 2 เอกสาร (SO/PO/SO vs SO ฯลฯ) ──────────────────────────
// คืน { docA, docB, rows: [{code,name,qtyA,qtyB,diff,status}] }
export async function odooCompare(typeA, numA, typeB, numB, companyId) {
  const fetchDoc = async (type, num) => {
    if (type === 'so') return await odooSO(num, companyId);
    if (type === 'po') return await odooPO(num, companyId);
    if (type === 'pr') return await odooPR(num, companyId);
    throw new Error('ไม่รู้จักประเภทเอกสาร: ' + type);
  };

  const [docsA, docsB] = await Promise.all([fetchDoc(typeA, numA), fetchDoc(typeB, numB)]);
  if (!docsA.length) throw new Error('ไม่พบ ' + typeA.toUpperCase() + numA);
  if (!docsB.length) throw new Error('ไม่พบ ' + typeB.toUpperCase() + numB);

  const docA = docsA[0];
  const docB = docsB[0];

  // normalize lines → { code, name, qty }
  const normalizeLines = (doc, type) => {
    const lines = doc.lines || [];
    return lines.map(l => {
      const prod = Array.isArray(l.product_id) ? l.product_id : [0, ''];
      const code = prod[0] ? String(prod[0]) : '';
      const name = prod[1] || l.name || '';
      let qty = 0;
      if (type === 'so') qty = l.product_uom_qty || 0;
      else if (type === 'po') qty = l.product_qty || 0;
      else if (type === 'pr') qty = l.product_qty || 0;
      return { code, name, qty: +qty };
    });
  };

  const linesA = normalizeLines(docA, typeA);
  const linesB = normalizeLines(docB, typeB);

  // merge ตาม product_id (code) — ถ้าไม่มี code ใช้ชื่อแทน
  const mapA = new Map();
  linesA.forEach(l => mapA.set(l.code || l.name, l));
  const mapB = new Map();
  linesB.forEach(l => mapB.set(l.code || l.name, l));

  const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);
  const rows = [];
  for (const k of allKeys) {
    const a = mapA.get(k);
    const b = mapB.get(k);
    const qtyA = a ? a.qty : 0;
    const qtyB = b ? b.qty : 0;
    const diff = qtyA - qtyB;
    let status = 'ok';
    if (!a) status = 'missing_a';
    else if (!b) status = 'missing_b';
    else if (diff !== 0) status = 'diff';
    rows.push({
      code: (a || b).code,
      name: (a || b).name,
      qtyA, qtyB, diff, status
    });
  }
  // เรียง: ผิดก่อน ถูกทีหลัง
  rows.sort((a, b) => {
    const order = { missing_a: 0, missing_b: 1, diff: 2, ok: 3 };
    return (order[a.status] || 3) - (order[b.status] || 3);
  });

  return { docA, docB, typeA, typeB, numA, numB, rows };
}

// ── ดูใบส่งของ/จัดส่ง (Delivery Order = stock.picking ประเภท outgoing) ────────
// ค้นหลายคำ: "ภูเก็ต 4+570" → หาใบที่ origin/name/ลูกค้า มีทุกคำ (ไม่ต้องเรียงติดกัน)
export async function odooDelivery(keyword, companyId) {
  const words = smartWords(keyword);

  // แต่ละคำ → ต้องเจอใน (name/origin/ลูกค้า/ปลายทาง) = OR 4 ช่อง
  // หมายเหตุ: ชื่อโครงการเต็ม (เช่น กม.4+570) อยู่ใน location_dest_id (ปลายทาง)
  // แล้วทุกคำต้องเจอ = AND
  const oneWord = (w) => ['|', '|', '|',
    ['name', 'ilike', w],
    ['origin', 'ilike', w],
    ['partner_id.name', 'ilike', w],
    ['location_dest_id.complete_name', 'ilike', w]
  ];

  let domain;
  if (words.length <= 1) {
    domain = oneWord(words[0] || '');
  } else {
    domain = [];
    for (let i = 0; i < words.length - 1; i++) domain.push('&');
    words.forEach(w => { domain.push(...oneWord(w)); });
  }
  domain = withCompany(domain, companyId);

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
