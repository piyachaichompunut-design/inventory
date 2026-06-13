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

// ── ค้นหาเอกสารจาก keyword สำหรับ /รายงาน ──────────────────────────────────────
// คืน { id, name, model } หรือ null ถ้าไม่เจอ
export async function odooFindDoc(docType, keyword, dateFilter) {
  const words = smartWords(keyword);

  if (docType === 'po') {
    const rows = await safeSearchRead('purchase.order',
      ['|', ['name', 'ilike', keyword], ['partner_ref', 'ilike', keyword]],
      ['id', 'name', 'partner_id'], 5);
    if (!rows.length) return null;
    return { id: rows[0].id, name: rows[0].name, model: 'purchase.order' };
  }

  if (docType === 'so') {
    const rows = await safeSearchRead('sale.order',
      ['|', ['name', 'ilike', keyword], ['client_order_ref', 'ilike', keyword]],
      ['id', 'name', 'partner_id'], 5);
    if (!rows.length) return null;
    return { id: rows[0].id, name: rows[0].name, model: 'sale.order' };
  }

  if (docType === 'pr') {
    const rows = await safeSearchRead('purchase.request',
      [['name', 'ilike', keyword]],
      ['id', 'name'], 5);
    if (!rows.length) return null;
    return { id: rows[0].id, name: rows[0].name, model: 'purchase.request' };
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
  try { rows = await searchRead('stock.picking', buildDomain('full'), ['id', 'name', 'scheduled_date'], 20); } catch (e) {
    try { rows = await searchRead('stock.picking', buildDomain('simple'), ['id', 'name', 'scheduled_date'], 20); } catch (e2) {}
  }

  // กรองวันที่ถ้าระบุ
  if (dateFilter && rows.length) {
    const filtered = rows.filter(p => String(p.scheduled_date || '').slice(0, 10) === dateFilter);
    if (filtered.length) rows = filtered;
  }

  if (!rows.length) return null;
  return { id: rows[0].id, name: rows[0].name, model: 'stock.picking' };
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
        20
      );
      p.images = (atts || []).map(a => ({ id: a.id, name: a.name || 'image' }));
    } catch (e) { p.images = []; }
  }
  return pickings;
}
