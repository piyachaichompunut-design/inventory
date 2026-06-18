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

// แปลง company_id (เลข) กลับเป็น { id, name } — ใช้ตอน resume session ที่เก็บแค่ id
export function companyById(id) {
  const all = [DEFAULT_COMPANY, ...Object.values(COMPANY_ALIAS)];
  return all.find(c => c.id === id) || DEFAULT_COMPANY;
}

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
async function searchRead(model, domain, fields, limit = 20, context = null) {
  const uid = await odooAuth();
  const kwargs = { fields, limit };
  if (context) kwargs.context = context;
  return await jsonRpc('object', 'execute_kw', [
    ODOO_DB, uid, ODOO_KEY,
    model, 'search_read',
    [domain],
    kwargs
  ]);
}

// ── เติมเงื่อนไขบริษัทเข้า domain (AND) ──────────────────────────────────────
// ถ้ามี companyId → ['&', ['company_id','=',companyId], ...domainเดิม]
function withCompany(domain, companyId) {
  if (!companyId) return domain;
  return ['&', ['company_id', '=', companyId], ...domain];
}

// ── แยกคำอัตโนมัติ ───────────────────────────────────────────────────────────
// แยกตรงรอยต่อ ไทย↔ตัวเลข + ตัด . , - / ออก เพื่อค้นกว้างขึ้น
// เช่น "สป.1001" → ["สป","1001"] | "กท 1002" → ["กท","1002"] | "ภูเก็ต4+570" → ["ภูเก็ต","4+570"]
function smartWords(keyword) {
  let s = String(keyword).trim();
  // แทรกช่องว่างตรงรอยต่อไทย↔ตัวเลข
  s = s.replace(/([\u0E00-\u0E7F])(\d)/g, '$1 $2');
  s = s.replace(/(\d)([\u0E00-\u0E7F])/g, '$1 $2');
  // แทนจุด/คอมม่า/ขีด ด้วยช่องว่าง (แต่เก็บ + ไว้ เพราะ 4+570 เป็นชื่อจริง)
  s = s.replace(/[.,\-]/g, ' ');
  return s.split(/\s+/).filter(w => w.length > 0);
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

  // context: ให้ qty_available คำนวณเฉพาะบริษัทที่เลือก (ไม่รวมทุกบริษัท)
  const ctx = companyId ? { allowed_company_ids: [companyId], company_id: companyId, force_company: companyId } : null;
  const fields = ['name', 'default_code', 'qty_available', 'virtual_available', 'uom_id'];

  // ถ้ามีรหัส → ค้นรหัสตรงๆ ก่อน (แม่นที่สุด)
  if (code && !name) {
    const domain = ['|', ['default_code', 'ilike', code], ['name', 'ilike', code]];
    return await searchRead('product.product', domain, fields, 15, ctx);
  }

  // ถ้ามีทั้งรหัสและชื่อ → ค้นรหัสก่อน ถ้าไม่เจอค่อยค้นชื่อ (หลายชั้น)
  if (code && name) {
    const byCode = await searchRead('product.product',
      ['|', ['default_code', 'ilike', code], ['name', 'ilike', code]],
      fields, 15, ctx);
    if (byCode.length) return byCode;
    return await stockSearchByName(name, fields, ctx);
  }

  // ค้นชื่อล้วน (หลายชั้น)
  return await stockSearchByName(name || keyword, fields, ctx);
}

// ── ค้นชื่อสินค้าแบบหลายชั้น (ยืดหยุ่นสูง) ────────────────────────────────────
// คำประสมที่คนพิมพ์ติดกันบ่อย → แตกเป็นคำย่อย (เพราะ Odoo เก็บแบบมีขีด/เว้นวรรค)
const COMPOUND_SPLIT = {
  'แผ่นการ์ดเรล': ['แผ่น','การ์ดเรล'],
  'เหล็กชุบ': ['เหล็ก','ชุบ'],
  'ท่อชุบ': ['ท่อ','ชุบ'],
  'เสาไฟ': ['เสา','ไฟ'],
  'น็อตตัวผู้': ['น็อต','ตัวผู้'],
  'น็อตตัวเมีย': ['น็อต','ตัวเมีย'],
};

function expandWords(words) {
  const out = [];
  for (const w of words) {
    if (COMPOUND_SPLIT[w]) out.push(...COMPOUND_SPLIT[w]);
    else out.push(w);
  }
  return out;
}

async function stockSearchByName(name, fields, ctx) {
  let words = smartWords(name);
  words = expandWords(words); // แตกคำประสมที่รู้จัก

  // ชั้น 1: ทุกคำต้องเจอ (AND)
  let result = await searchRead('product.product', buildWordsDomain(words), fields, 15, ctx);
  if (result.length) return result;

  // ชั้น 2: แทรก % ระหว่างคำ จับกรณีมีขีด/อักขระแทรก เช่น "แผ่น-การ์ดเรล"
  if (words.length >= 2) {
    const pattern = '%' + words.join('%') + '%';
    result = await searchRead('product.product',
      ['|', ['name', 'ilike', pattern], ['default_code', 'ilike', pattern]], fields, 15, ctx);
    if (result.length) return result;
  }

  // ชั้น 3: ค้นด้วยคำที่ยาวที่สุดคำเดียว
  const longest = words.slice().sort((a,b) => b.length - a.length)[0];
  if (longest && longest.length >= 3) {
    result = await searchRead('product.product',
      ['|', ['name', 'ilike', longest], ['default_code', 'ilike', longest]], fields, 15, ctx);
    if (result.length) return result;
  }

  return [];
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
  sortExactFirst(orders, poNumber);
  // ดึงรายการสินค้าของแต่ละ PO
  for (const o of orders) {
    o.lines = await searchRead(
      'purchase.order.line',
      [['order_id', '=', o.id]],
      ['product_id', 'product_qty', 'qty_received', 'price_unit', 'price_subtotal', 'product_uom'],
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
  sortExactFirst(orders, soNumber);
  for (const o of orders) {
    try {
      o.lines = await searchRead(
        'sale.order.line',
        [['order_id', '=', o.id]],
        ['product_id', 'product_uom_qty', 'qty_delivered', 'price_unit', 'price_subtotal', 'product_uom'],
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
  sortExactFirst(reqs, prNumber);
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

// ── รายการสินค้าการ์ดเรล สำหรับคำสั่ง /อัพเดทสต็อกการ์ดเรล ────────────────────
// group: 'plate' = แผ่น/บล็อก, 'post' = เสา, 'accessory' = นอต/ประกับ/ฐาน/เป้า
export const GUARDRAIL_PRODUCTS = [
  { code: '15FG-FG2-02-01-01-00-00-00-00', label: 'แผ่นการ์ดเรล หนา 3.2mm ยาว 4.32m',                    group: 'plate' },
  { code: '15FG-FG2-02-01-02-00-00-00-00', label: 'แผ่นการ์ดเรล หนา 2.5mm ยาว 4.32m',                    group: 'plate' },
  { code: '15FG-FG2-03-01-00-00-00-00-00', label: 'แผ่นประกับเฉียงการ์ดเรล',                              group: 'plate' },
  { code: '15FG-FG2-04-01-02-00-00-00-00', label: 'แผ่นปลายการ์ดเรล หนา 3.2mm',                          group: 'plate' },
  { code: '15FG-FG2-01-01-01-00-00-00-00', label: 'BLOCK OUT กลม 101.6x4x250mm',                          group: 'plate' },
  { code: '15FG-FG2-04-01-02-01-00-00-00', label: 'แผ่นปลายการ์ดเรล หนา 3.2mm (Bull Nose)',               group: 'plate' },
  { code: '15FG-FG2-05-01-00-00-00-00-00', label: 'แผ่นเสริมกำลังการ์ดเรล',                               group: 'plate' },
  { code: '15FG-FG2-06-02-01-00-00-00-00', label: 'แผ่นโค้งการ์ดเรล หนา 3.2mm',                           group: 'plate' },
  { code: '15FG-FG2-06-02-02-00-00-00-00', label: 'แผ่นโค้งการ์ดเรล หนา 2.5mm',                           group: 'plate' },
  { code: '07RP-055-04-01-01-00-00-00-00', label: 'แผ่นปลายการ์ดเรล ติดสะพาน กว้าง370mm ยาว700mm หนา3.2mm', group: 'plate' },

  { code: '15FG-FG2-06-01-06-00-00-00-00', label: 'เสาการ์ดเรล 101.6mm หนา4.0mm ยาว2600mm เจาะ4รู (ทล.)', group: 'post' },
  { code: '15FG-FG2-06-01-07-01-00-00-00', label: 'เสาการ์ดเรล 101.6mm หนา4.0mm ยาว2m เจาะ1รู (กทม.)',    group: 'post' },
  { code: '15FG-FG2-07-01-01-00-00-00-00', label: 'เสาองศาการ์ดเรล 60° ยาว2000mm',                        group: 'post' },
  { code: '15FG-FG2-07-01-02-00-00-00-00', label: 'เสาองศาการ์ดเรล 60° ยาว2500mm',                        group: 'post' },
  { code: '15FG-FG2-08-01-01-00-00-00-00', label: 'เสาองศาการ์ดเรล 30° ยาว2000mm',                        group: 'post' },
  { code: '15FG-FG2-08-01-02-00-00-00-00', label: 'เสาองศาการ์ดเรล 30° ยาว2500mm',                        group: 'post' },
  { code: '15FG-GP1-00-01-01-01-00-00-00', label: 'เสาการ์ดเรล 101.6mm หนา4.0mm ยาว2000mm เจาะ2รู แบบเชื่อมฝา+Steel plate (ทล.)', group: 'post' },
  { code: '15FG-GP1-01-02-01-01-00-00-00', label: 'เสาการ์ดเรล เจาะ2รู ยาว2000mm (กทม.)',                 group: 'post' },
  { code: '15FG-GP1-02-02-01-01-00-00-00', label: 'เสาการ์ดเรล เจาะ2รู+เพลทฐาน ยาว920mm (กทม.)',          group: 'post' },
  { code: '07RP-057-03-01-04-00-00-00-00', label: 'เสาการ์ดเรล 101.6mm ยาว2500mm เจาะ2รู (ทล.)',          group: 'post' },
  { code: '15FG-GP1-00-01-02-01-00-00-00', label: 'เสาการ์ดเรล 101.6mm หนา4.0mm ยาว2000mm เจาะ1รู แบบเชื่อมฝา (ทช.)', group: 'post' },

  { code: '07RP-037-17-01-01-00-00-00-00', label: 'นอตการ์ดเรล สั้น 5/8"x1-1/4"',                         group: 'accessory' },
  { code: '07RP-037-15-01-01-00-00-00-00', label: 'นอตการ์ดเรล กลาง 5/8"x2-1/2"',                         group: 'accessory' },
  { code: '07RP-037-16-01-02-00-00-00-00', label: 'นอตการ์ดเรล ยาว 5/8"x7-1/4"',                          group: 'accessory' },
  { code: '07RP-040-01-01-01-00-00-00-00', label: 'BLOCK OUT ตัวซีการ์ดเรล 150x75x330mm',                 group: 'accessory' },
  { code: '07RP-017-00-02-01-00-00-00-00', label: 'ประกับนอตยาวการ์ดเรล 60x60x15mm',                      group: 'accessory' },
  { code: '07RP-017-02-02-01-00-00-00-00', label: 'ประกับนอตยาวการ์ดเรล 50x60x15mm',                      group: 'accessory' },
  { code: '07RP-010-00-01-03-00-00-00-00', label: 'ฐานเสาการ์ดเรล ตอม่อ 0.70x0.70x0.80m (1 โบลท์)',       group: 'accessory' },
  { code: '07RP-010-00-01-03-01-00-00-00', label: 'ฐานเสาการ์ดเรล ตอม่อ 0.70x0.70x0.80m (I-Bolt 2ตัว)',   group: 'accessory' },
  { code: '07RP-018-02-01-01-00-00-00-00', label: 'เป้าคางหมู 100x150mm',                                 group: 'accessory' },
  { code: '07RP-018-01-01-01-00-00-00-00', label: 'เป้ากลม 100mm',                                        group: 'accessory' },
  { code: '10RB-004-01-01-01-01-00-00-00', label: 'เป้าสะท้อนแสงการ์ดเรล ทรงโค้ง 350x90mm เจาะ2รู (กทม.)', group: 'accessory' },
];

// ── เช็คสต็อกสินค้าการ์ดเรลทุกรหัสในรายการด้านบน ทีเดียวในคำสั่งเดียว ─────────
// ── ดึง PDF ใบส่งสินค้าตัวจริงจาก Odoo (report ทางการ มีโลโก้ ช่องเซ็น) ──────────
// pickIds = array ของ stock.picking id
// คืน base64 ของ PDF (รวมหลายใบใน PDF เดียว)
export async function odooDeliveryPDF(pickIds) {
  if (!Array.isArray(pickIds) || !pickIds.length) throw new Error('ไม่ได้ระบุใบส่งของ');

  // 1) login แบบ web session เพื่อเอา cookie (report endpoint ต้องใช้ session ไม่ใช่ API key)
  // web session ต้องใช้รหัสผ่านจริง (ODOO_PASSWORD) — ถ้าไม่มีลองใช้ API key
  const webPassword = process.env.ODOO_PASSWORD || ODOO_KEY;
  const loginRes = await fetch(ODOO_URL + '/web/session/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      params: { db: ODOO_DB, login: ODOO_USER, password: webPassword }
    })
  });
  const setCookie = loginRes.headers.get('set-cookie') || '';
  const sessionId = (setCookie.match(/session_id=([^;]+)/) || [])[1];
  if (!sessionId) {
    const j = await loginRes.json().catch(() => ({}));
    const msg = j.error?.data?.message || j.error?.message || 'Access Denied';
    throw new Error('Odoo web session ล้มเหลว: ' + msg + ' (ต้องตั้ง ODOO_PASSWORD = รหัสผ่านจริงใน Vercel)');
  }
  const cookie = 'session_id=' + sessionId;

  // 2) เรียก report endpoint — report ใบส่งของมาตรฐานคือ stock.report_deliveryslip
  const ids = pickIds.join(',');
  const reportUrl = ODOO_URL + '/report/pdf/stock.report_deliveryslip/' + ids;
  const pdfRes = await fetch(reportUrl, { headers: { Cookie: cookie } });

  if (!pdfRes.ok) {
    throw new Error('ดึง PDF จาก Odoo ไม่สำเร็จ (HTTP ' + pdfRes.status + ')');
  }
  const buf = Buffer.from(await pdfRes.arrayBuffer());
  // เช็คว่าเป็น PDF จริง (ขึ้นต้น %PDF)
  if (buf.length < 100 || buf.slice(0, 4).toString() !== '%PDF') {
    throw new Error('ไฟล์ที่ได้ไม่ใช่ PDF (อาจไม่มีสิทธิ์ หรือ report name ไม่ตรง)');
  }
  return buf.toString('base64');
}

// คืน [{ id, code, name }] — id = Database ID ของ product.product (ที่ stock.move ใช้)
export async function odooAllProductIds() {
  const uid = await odooAuth();
  const rows = await jsonRpc('object', 'execute_kw', [
    ODOO_DB, uid, ODOO_KEY,
    'product.product', 'search_read',
    [[['default_code', '!=', false]]],
    { fields: ['id', 'default_code', 'name'], limit: 10000 }
  ]);
  return rows.map(r => ({ id: r.id, code: r.default_code, name: r.name }));
}

export async function odooGuardrailStock(companyId) {
  const codes = GUARDRAIL_PRODUCTS.map(p => p.code);
  // context: ให้ qty_available คำนวณเฉพาะบริษัทที่เลือก (เหมือน odooStock)
  const ctx = companyId ? { allowed_company_ids: [companyId], company_id: companyId, force_company: companyId } : null;
  const rows = await searchRead('product.product',
    [['default_code', 'in', codes]],
    ['default_code', 'name', 'qty_available', 'uom_id'],
    codes.length + 5, ctx);

  const byCode = new Map();
  for (const r of rows) byCode.set(r.default_code, r);

  return GUARDRAIL_PRODUCTS.map(p => {
    const r = byCode.get(p.code);
    return {
      code: p.code,
      label: p.label,
      group: p.group,
      found: !!r,
      qty: r ? r.qty_available : null,
      uom: (r && Array.isArray(r.uom_id)) ? r.uom_id[1] : '',
    };
  });
}


// คืน { docA, docB, rows: [{code,name,qtyA,qtyB,diff,status}] }
// ── normalize รายการสินค้าของเอกสาร SO/PO/PR → { code, name, unit, qty } ──────
export function normalizeDocLines(doc, type) {
  const lines = doc.lines || [];
  return lines.map(l => {
    const prod = Array.isArray(l.product_id) ? l.product_id : [0, ''];
    const code = prod[0] ? String(prod[0]) : '';
    const name = prod[1] || l.name || '';
    let qty = 0;
    let uomField = null;
    if (type === 'so') { qty = l.product_uom_qty || 0; uomField = l.product_uom; }
    else if (type === 'po') { qty = l.product_qty || 0; uomField = l.product_uom; }
    else if (type === 'pr') { qty = l.product_qty || 0; uomField = l.product_uom_id; }
    const unit = Array.isArray(uomField) ? (uomField[1] || '') : '';
    return { code, name, unit, qty: +qty };
  });
}

// ── normalize รายการสินค้าของใบส่งของ (stock.picking) → { code, name, unit, qtyPlanned, qtyDone } ──
export function normalizePickingLines(picking) {
  const lines = picking.lines || [];
  return lines.map(l => {
    const prod = Array.isArray(l.product_id) ? l.product_id : [0, ''];
    const code = prod[0] ? String(prod[0]) : '';
    const name = prod[1] || l.name || '';
    const unit = Array.isArray(l.product_uom) ? (l.product_uom[1] || '') : '';
    return {
      code, name, unit,
      qtyPlanned: +(l.product_uom_qty || 0),
      qtyDone: +(l.quantity || 0)
    };
  });
}

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

  const linesA = normalizeDocLines(docA, typeA);
  const linesB = normalizeDocLines(docB, typeB);

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
      unit: (a || b).unit || '',
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

// ── เทียบเอกสาร SO/PO/PR กับใบส่งของ (stock.picking) ──────────────────────────
// คืน { otherDoc, otherType, otherNum, picking, rows }
// rows: { code, name, unit, qtyOther, qtyPlanned, qtyDone, diff, status }
//   diff/status คำนวณจาก qtyOther เทียบ qtyDone (จำนวนที่ส่งจริง)
export async function odooCompareWithDelivery(otherType, otherNum, picking, companyId) {
  const fetchDoc = async (type, num) => {
    if (type === 'so') return await odooSO(num, companyId);
    if (type === 'po') return await odooPO(num, companyId);
    if (type === 'pr') return await odooPR(num, companyId);
    throw new Error('ไม่รู้จักประเภทเอกสาร: ' + type);
  };

  const docs = await fetchDoc(otherType, otherNum);
  if (!docs.length) throw new Error('ไม่พบ ' + otherType.toUpperCase() + otherNum);
  const otherDoc = docs[0];

  const otherLines = normalizeDocLines(otherDoc, otherType);
  const pickLines = normalizePickingLines(picking);

  const mapOther = new Map();
  otherLines.forEach(l => mapOther.set(l.code || l.name, l));
  const mapPick = new Map();
  pickLines.forEach(l => mapPick.set(l.code || l.name, l));

  const allKeys = new Set([...mapOther.keys(), ...mapPick.keys()]);
  const rows = [];
  for (const k of allKeys) {
    const o = mapOther.get(k);
    const p = mapPick.get(k);
    const qtyOther = o ? o.qty : 0;
    const qtyPlanned = p ? p.qtyPlanned : 0;
    const qtyDone = p ? p.qtyDone : 0;
    const diff = qtyOther - qtyDone;
    let status = 'ok';
    if (!o) status = 'missing_a';      // ไม่มีใน SO/PO/PR
    else if (!p) status = 'missing_b'; // ไม่มีในใบส่งของ
    else if (diff !== 0) status = 'diff';
    rows.push({
      code: (o || p).code,
      name: (o || p).name,
      unit: (o || p).unit || '',
      qtyOther, qtyPlanned, qtyDone, diff, status
    });
  }
  rows.sort((a, b) => {
    const order = { missing_a: 0, missing_b: 1, diff: 2, ok: 3 };
    return (order[a.status] || 3) - (order[b.status] || 3);
  });

  return { otherDoc, otherType, otherNum, picking, rows };
}

// ── ดึงรูป attachment เดียวตาม ID → คืน { buffer, mimetype } ──────────────────
export async function odooGetAttachmentImage(attId) {
  const rows = await searchRead(
    'ir.attachment',
    [['id', '=', +attId], ['mimetype', 'ilike', 'image']],
    ['datas', 'mimetype'],
    1
  );
  if (!rows || !rows.length || !rows[0].datas) return null;
  return {
    buffer: Buffer.from(rows[0].datas, 'base64'),
    mimetype: rows[0].mimetype || 'image/jpeg'
  };
}

// ── อัปรูปเข้า Odoo ir.attachment ─────────────────────────────────────────────
// resModel = 'stock.picking' | 'purchase.order' | 'sale.order'
// resId = id ของเอกสาร
// buffer = Buffer ของรูป, mimetype = 'image/jpeg' เป็นต้น, name = ชื่อไฟล์
export async function odooUploadAttachment(resModel, resId, buffer, mimetype, name) {
  const uid = await odooAuth();
  const base64 = buffer.toString('base64');
  const attId = await jsonRpc('object', 'execute_kw', [
    ODOO_DB, uid, ODOO_KEY,
    'ir.attachment', 'create',
    [{
      name: name || 'image.jpg',
      datas: base64,
      res_model: resModel,
      res_id: resId,
      mimetype: mimetype || 'image/jpeg',
      type: 'binary'
    }]
  ]);
  return attId;
}

// ── ค้นหา Operation Type (stock.picking.type) ตาม keyword ─────────────────────
// คืน array ของ { id, name, warehouse_id, default_location_src_id, default_location_dest_id }
export async function odooFindOperationType(keyword, companyId) {
  const uid = await odooAuth();
  const domain = withCompany([['name', 'ilike', keyword]], companyId);
  const rows = await searchRead('stock.picking.type', domain,
    ['id', 'name', 'warehouse_id', 'default_location_src_id', 'default_location_dest_id', 'code'],
    20);
  // กรองเฉพาะ outgoing (ส่งออก) → code = 'outgoing'
  const outgoing = rows.filter(r => r.code === 'outgoing');
  return outgoing.length ? outgoing : rows; // ถ้ากรองแล้วไม่เหลือ คืนทั้งหมด
}

// ── สร้าง picking ใน Odoo พร้อม stock move lines ─────────────────────────────
// pickingTypeId = id ของ stock.picking.type
// lines = [{ productCode, productName, qty }]
// คืน { pickingId, results: [{ line, status, product }] }
//   status: 'code' = เจอจากรหัสเป๊ะ | 'name' = เจอจากชื่อ (ต้องเช็ค) | 'notfound' = ไม่เจอ
export async function odooCreatePickingFromLines(pickingTypeId, lines, scheduledDate, sourceDoc, companyId) {
  const uid = await odooAuth();

  // หา picking type เพื่อดึง location src/dest
  const ptRows = await searchRead('stock.picking.type',
    [['id', '=', pickingTypeId]],
    ['default_location_src_id', 'default_location_dest_id', 'name'], 1);
  if (!ptRows.length) throw new Error('ไม่พบ Operation Type id=' + pickingTypeId);
  const pt = ptRows[0];
  const srcLocId  = Array.isArray(pt.default_location_src_id)  ? pt.default_location_src_id[0]  : pt.default_location_src_id;
  const destLocId = Array.isArray(pt.default_location_dest_id) ? pt.default_location_dest_id[0] : pt.default_location_dest_id;

  // ── ชั้นที่ 1: ค้นด้วยรหัส (default_code) แบบ batch ──────────────────────────
  const codes = lines.map(l => l.productCode).filter(Boolean);
  let codeMap = new Map();
  if (codes.length) {
    const prodByCode = await searchRead('product.product',
      [['default_code', 'in', codes]],
      ['id', 'default_code', 'name', 'uom_id'], codes.length + 5);
    codeMap = new Map(prodByCode.map(r => [String(r.default_code), r]));
  }

  // ── จับคู่สินค้าแต่ละบรรทัด ─────────────────────────────────────────────────
  const cleanName = (s) => String(s || '').replace(/-{2,}/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

  // ชั้น 1: map จากรหัสก่อน
  const results = lines.map(line => {
    if (line.productCode && codeMap.has(String(line.productCode))) {
      return { line, status: 'code', product: codeMap.get(String(line.productCode)) };
    }
    return { line, status: 'notfound', product: null };
  });

  // ชั้น 2: รายการที่ยังไม่เจอ → batch ค้นชื่อทีเดียว
  const needNameSearch = results.filter(r => r.status === 'notfound' && r.line.productName);
  if (needNameSearch.length) {
    const nameDomain = needNameSearch.map(r =>
      ['name', 'ilike', String(r.line.productName).replace(/-{2,}/g, ' ').trim()]
    );
    // OR domain: ['|','|', cond1, cond2, cond3, ...]
    let domain;
    if (nameDomain.length === 1) {
      domain = [nameDomain[0]];
    } else {
      domain = [];
      for (let i = 0; i < nameDomain.length - 1; i++) domain.push('|');
      domain = domain.concat(nameDomain);
    }
    const nameRows = await searchRead('product.product', domain,
      ['id', 'default_code', 'name', 'uom_id'], needNameSearch.length * 3 + 5);

    // จับคู่แต่ละบรรทัดกับผลลัพธ์
    for (const r of needNameSearch) {
      const nm = cleanName(r.line.productName);
      const searchNm = nm.split(' ')[0]; // คำแรกเป็นตัวกรอง
      const candidates = nameRows.filter(p =>
        cleanName(p.name).includes(searchNm) || searchNm.includes(cleanName(p.name).split(' ')[0])
      );
      if (candidates.length) {
        const exact = candidates.find(p => cleanName(p.name) === nm);
        r.product = exact || candidates[0];
        r.status = 'name';
      }
    }
  }

  // สร้าง picking header
  const pickingVals = {
    picking_type_id: pickingTypeId,
    location_id: srcLocId,
    location_dest_id: destLocId,
    origin: sourceDoc || '',
    ...(scheduledDate ? { scheduled_date: scheduledDate } : {}),
    ...(companyId ? { company_id: companyId } : {}),
  };
  const pickingId = await jsonRpc('object', 'execute_kw', [
    ODOO_DB, uid, ODOO_KEY,
    'stock.picking', 'create', [pickingVals]
  ]);

  // สร้าง stock.move ทีเดียวทั้งหมด (batch create) — เร็วกว่า loop มาก
  const moveVals = results
    .filter(r => r.product)
    .map(r => {
      const prod = r.product;
      const uomId = Array.isArray(prod.uom_id) ? prod.uom_id[0] : prod.uom_id;
      return {
        name: prod.name || r.line.productCode || r.line.productName || '-',
        picking_id: pickingId,
        product_id: prod.id,
        product_uom_qty: parseFloat(r.line.qty) || 1,
        product_uom: uomId,
        location_id: srcLocId,
        location_dest_id: destLocId,
      };
    });

  if (moveVals.length) {
    await jsonRpc('object', 'execute_kw', [
      ODOO_DB, uid, ODOO_KEY,
      'stock.move', 'create', [moveVals]
    ]);
  }

  // สรุปผลแยกกลุ่ม
  const matchedCode = results.filter(r => r.status === 'code');
  const matchedName = results.filter(r => r.status === 'name');
  const notFound    = results.filter(r => r.status === 'notfound');

  return { pickingId, results, matchedCode, matchedName, notFound };
}



// คืน { id, name, model } หรือ null ถ้าไม่เจอ
// จัดเรียงผลลัพธ์: ถ้ามีรายการที่ name ตรงกับ keyword แบบเป๊ะๆ (ไม่สนตัวพิมพ์เล็ก/ใหญ่) ให้ขึ้นเป็นอันดับแรก
// กันปัญหา ilike '2606001' ไปแมตช์ "M2606001" ก่อน "2606001" (ทำให้ docs[0] หรือ odooFindDoc หยิบใบผิด)
function sortExactFirst(rows, keyword) {
  const kw = String(keyword).trim().toLowerCase();
  const idx = rows.findIndex(r => String(r.name || '').trim().toLowerCase() === kw);
  if (idx > 0) {
    const [exact] = rows.splice(idx, 1);
    rows.unshift(exact);
  }
  return rows;
}

export async function odooFindDoc(docType, keyword, dateFilter, companyId) {
  const words = smartWords(keyword);

  if (docType === 'po') {
    const rows = await safeSearchRead('purchase.order',
      withCompany(['|', ['name', 'ilike', keyword], ['partner_ref', 'ilike', keyword]], companyId),
      ['id', 'name', 'partner_id'], 5);
    if (!rows.length) return null;
    const best = sortExactFirst(rows, keyword)[0];
    return { id: best.id, name: best.name, model: 'purchase.order' };
  }

  if (docType === 'so') {
    const rows = await safeSearchRead('sale.order',
      withCompany(['|', ['name', 'ilike', keyword], ['client_order_ref', 'ilike', keyword]], companyId),
      ['id', 'name', 'partner_id'], 5);
    if (!rows.length) return null;
    const best = sortExactFirst(rows, keyword)[0];
    return { id: best.id, name: best.name, model: 'sale.order' };
  }

  if (docType === 'pr') {
    const rows = await safeSearchRead('purchase.request',
      withCompany([['name', 'ilike', keyword]], companyId),
      ['id', 'name'], 5);
    if (!rows.length) return null;
    const best = sortExactFirst(rows, keyword)[0];
    return { id: best.id, name: best.name, model: 'purchase.request' };
  }

  // picking — ค้นแบบ odooDelivery + กรองวันที่
  const buildDomain = (level) => {
    const oneWord = (w) => {
      if (level === 'full') {
        return ['|', '|', '|', '|',
          ['name', 'ilike', w], ['origin', 'ilike', w],
          ['partner_id.name', 'ilike', w],
          ['location_dest_id.complete_name', 'ilike', w],
          ['group_id.name', 'ilike', w]
        ];
      }
      return ['|', '|', ['name', 'ilike', w], ['origin', 'ilike', w], ['group_id.name', 'ilike', w]];
    };
    let domain = words.length <= 1 ? oneWord(words[0] || '') : [];
    if (words.length > 1) {
      for (let i = 0; i < words.length - 1; i++) domain.push('&');
      words.forEach(w => domain.push(...oneWord(w)));
    }
    return domain;
  };

  let rows = [];
  try { rows = await searchRead('stock.picking', withCompany(buildDomain('full'), companyId), ['id', 'name', 'scheduled_date'], 20); } catch (e) {
    try { rows = await searchRead('stock.picking', withCompany(buildDomain('simple'), companyId), ['id', 'name', 'scheduled_date'], 20); } catch (e2) {}
  }

  // กรองวันที่ถ้าระบุ
  if (dateFilter && rows.length) {
    const filtered = rows.filter(p => String(p.scheduled_date || '').slice(0, 10) === dateFilter);
    if (filtered.length) rows = filtered;
  }

  if (!rows.length) return null;
  return { id: rows[0].id, name: rows[0].name, model: 'stock.picking' };
}

// ── ดึงรายละเอียดเอกสาร + รูป สำหรับ /รายงาน ─────────────────────────────────
// คืน { name, partner, date, total, lines:[{name,qty,uom}], images:[{id,name}] }
export async function odooDocDetail(model, id) {
  let doc = {};
  if (model === 'purchase.order') {
    const rows = await searchRead('purchase.order', [['id','=',id]],
      ['name','partner_id','date_order','amount_total'], 1);
    if (!rows.length) return null;
    const r = rows[0];
    const lines = await searchRead('purchase.order.line', [['order_id','=',id]],
      ['product_id','name','product_qty','product_uom'], 50);
    doc = {
      name: 'PO ' + r.name,
      partner: Array.isArray(r.partner_id) ? r.partner_id[1] : '',
      partnerLabel: 'ผู้ขาย',
      date: String(r.date_order || '').slice(0,10),
      total: r.amount_total || 0,
      lines: lines.map(l => ({
        name: Array.isArray(l.product_id) ? l.product_id[1] : (l.name || ''),
        qty: l.product_qty || 0,
        uom: Array.isArray(l.product_uom) ? l.product_uom[1] : ''
      }))
    };
  } else if (model === 'sale.order') {
    const rows = await searchRead('sale.order', [['id','=',id]],
      ['name','partner_id','date_order','amount_total'], 1);
    if (!rows.length) return null;
    const r = rows[0];
    const lines = await searchRead('sale.order.line', [['order_id','=',id]],
      ['product_id','name','product_uom_qty','product_uom'], 50);
    doc = {
      name: 'SO ' + r.name,
      partner: Array.isArray(r.partner_id) ? r.partner_id[1] : '',
      partnerLabel: 'ลูกค้า',
      date: String(r.date_order || '').slice(0,10),
      total: r.amount_total || 0,
      lines: lines.map(l => ({
        name: Array.isArray(l.product_id) ? l.product_id[1] : (l.name || ''),
        qty: l.product_uom_qty || 0,
        uom: Array.isArray(l.product_uom) ? l.product_uom[1] : ''
      }))
    };
  } else if (model === 'purchase.request') {
    const rows = await searchRead('purchase.request', [['id','=',id]],
      ['name','requested_by','date_start'], 1);
    if (!rows.length) return null;
    const r = rows[0];
    const lines = await searchRead('purchase.request.line', [['request_id','=',id]],
      ['product_id','name','product_qty','product_uom_id'], 50);
    doc = {
      name: 'PR ' + r.name,
      partner: Array.isArray(r.requested_by) ? r.requested_by[1] : '',
      partnerLabel: 'ผู้ขอ',
      date: String(r.date_start || '').slice(0,10),
      total: 0,
      lines: lines.map(l => ({
        name: Array.isArray(l.product_id) ? l.product_id[1] : (l.name || ''),
        qty: l.product_qty || 0,
        uom: Array.isArray(l.product_uom_id) ? l.product_uom_id[1] : ''
      }))
    };
  } else {
    return null;
  }

  // ดึงรูปที่แนบ (ir.attachment)
  try {
    const atts = await searchRead('ir.attachment',
      ['&','&',['res_model','=',model],['res_id','=',id],['mimetype','ilike','image']],
      ['id','name'], 50);
    doc.images = (atts || []).map(a => ({ id: a.id, name: a.name || 'image' }));
  } catch(e) { doc.images = []; }

  return doc;
}

// ── ดูใบส่งของ/จัดส่ง (Delivery Order = stock.picking ประเภท outgoing) ────────
// ค้นหลายคำ: "ภูเก็ต 4+570" → หาใบที่ origin/name/ลูกค้า มีทุกคำ (ไม่ต้องเรียงติดกัน)
export async function odooDelivery(keyword, companyId) {
  const words = smartWords(keyword);

  // ค้นทุก field ที่ชื่อโครงการอาจอยู่:
  //   name = เลขเอกสาร | origin = เอกสารต้นทาง | partner = ลูกค้า
  //   location_dest_id.complete_name = ปลายทาง (มีชื่อโครงการเต็ม)
  //   group_id.name = Reference ที่จัดกลุ่ม (เช่น "ถนนสาย กท.1001 ถนนกัลปพฤกษ์")
  const buildDomain = (level) => {
    const oneWord = (w) => {
      if (level === 'full') {
        return ['|', '|', '|', '|',
          ['name', 'ilike', w],
          ['origin', 'ilike', w],
          ['partner_id.name', 'ilike', w],
          ['location_dest_id.complete_name', 'ilike', w],
          ['group_id.name', 'ilike', w]
        ];
      }
      if (level === 'dest') {
        return ['|', '|',
          ['origin', 'ilike', w],
          ['location_dest_id.complete_name', 'ilike', w],
          ['group_id.name', 'ilike', w]
        ];
      }
      // simple
      return ['|', '|',
        ['name', 'ilike', w],
        ['origin', 'ilike', w],
        ['partner_id.name', 'ilike', w]
      ];
    };
    let domain;
    if (words.length <= 1) {
      domain = oneWord(words[0] || '');
    } else {
      domain = [];
      for (let i = 0; i < words.length - 1; i++) domain.push('&');
      words.forEach(w => { domain.push(...oneWord(w)); });
    }
    return withCompany(domain, companyId);
  };

  const fields = ['name', 'origin', 'partner_id', 'state', 'scheduled_date', 'date_done', 'picking_type_id', 'group_id'];
  let pickings = [];
  // 1) ค้นแบบเต็ม (ทุก field)
  try {
    pickings = await searchRead('stock.picking', buildDomain('full'), fields, 40);
  } catch (e) {
    // 2) บาง field อาจไม่มี → ลองเฉพาะ dest/group
    try {
      pickings = await searchRead('stock.picking', buildDomain('dest'), fields, 40);
    } catch (e2) {
      pickings = [];
    }
  }
  // 3) ถ้ายังไม่เจอ → ลอง dest/group อย่างเดียว (เผื่อชื่ออยู่แค่ปลายทาง)
  if (!pickings.length) {
    try { pickings = await searchRead('stock.picking', buildDomain('dest'), fields, 40); } catch (e) {}
  }
  // 4) สุดท้าย fallback simple
  if (!pickings.length) {
    try { pickings = await searchRead('stock.picking', buildDomain('simple'), fields, 40); } catch (e) {}
  }

  for (const p of pickings) {
    try {
      p.lines = await searchRead(
        'stock.move',
        [['picking_id', '=', p.id]],
        ['product_id', 'product_uom_qty', 'quantity', 'product_uom'],
        50
      );
    } catch (e) { p.lines = []; }

    // ดึงรายการรูปที่แนบ (เก็บแค่ ID + ชื่อ — รูปจริงโหลดผ่าน proxy ทีหลัง)
    try {
      const atts = await searchRead(
        'ir.attachment',
        ['&', '&', ['res_model', '=', 'stock.picking'], ['res_id', '=', p.id], ['mimetype', 'ilike', 'image']],
        ['id', 'name', 'mimetype'],
        50
      );
      p.images = (atts || []).map(a => ({ id: a.id, name: a.name || 'image' }));
    } catch (e) { p.images = []; }
  }
  return pickings;
}
