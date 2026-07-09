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

// ── รหัสสินค้าที่ไม่ต้องแจ้งเตือนใดๆ (ค่าบริการ ฯลฯ ไม่ใช่สต็อกจริง) ───────────
// ค่าบริการทุกตัวขึ้นต้นด้วย 01SV- (Insurance/Plating/Service/Transport)
// บางที่ Odoo แสดงเป็น [SV-xxx] → กรองทั้ง 2 รูปแบบ
const IGNORE_PRODUCT_PATTERNS = [
  /\b01SV-/i,                    // รหัสเต็ม เช่น [01SV-SVS-03-...] [01SV-PLT-04-...]
  /\bSV-\d/i,                    // รหัสย่อ เช่น [SV-001] [SV-002]
  /\b11RS-/i,                    // วัตถุดิบ (สินค้าพิเศษ) — ห้ามแจ้งเตือนจ่ายก่อน/รับไม่ครบเด็ดขาด
  /ค่าบริการ|ค่าขนส่ง|ค่าประกัน|ค่าบริการงานชุบ/,  // กันพลาดด้วยชื่อ
];
// เช็คว่าชื่อสินค้า (ที่มักมีรูปแบบ "[รหัส] ชื่อ") เป็นค่าบริการที่ต้องข้ามไหม
function isIgnoredProduct(productName) {
  const s = String(productName || '');
  return IGNORE_PRODUCT_PATTERNS.some(re => re.test(s));
}

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

// login ของ Store1 — ใช้เช็คว่าใบรับสินค้าถูก validate โดย store1 ไหม (ใส่ลายเซ็นให้)
const STORE1_LOGIN = (process.env.GR_STORE1_LOGIN || 'store.set9595@gmail.com').toLowerCase();

// แยกตัวย่อบริษัทออกจากคำค้น เช่น "ภูเก็ต 4+570 md" → { keyword:'ภูเก็ต 4+570', company:{id:2} }
export function parseCompany(text) {
  const parts = String(text).trim().split(/\s+/);
  const last = (parts[parts.length - 1] || '').toLowerCase();
  if (COMPANY_ALIAS[last]) {
    parts.pop(); // เอาตัวย่อออก
    return { keyword: parts.join(' ').trim(), company: COMPANY_ALIAS[last], explicit: true };
  }
  // ไม่ได้ระบุบริษัท → คืน default (id 1) แต่ตั้ง explicit=false ให้ผู้เรียกเลือกได้ว่าจะค้นทุกบริษัท
  return { keyword: String(text).trim(), company: DEFAULT_COMPANY, explicit: false };
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
async function searchRead(model, domain, fields, limit = 20, context = null, order = null) {
  const uid = await odooAuth();
  const kwargs = { fields, limit };
  if (order) kwargs.order = order;
  if (context) kwargs.context = context;
  return await jsonRpc('object', 'execute_kw', [
    ODOO_DB, uid, ODOO_KEY,
    model, 'search_read',
    [domain],
    kwargs
  ]);
}

// ── หาชื่อทางเทคนิคของฟิลด์จาก "ป้ายชื่อ" (label) — cache ต่อโมเดล ─────────────
//   ใช้ตอนไม่รู้ชื่อฟิลด์จริง (เช่น custom field "PR No." บน purchase.order)
//   คืน technical name ตัวแรกที่ label ตรง (case-insensitive) หรือ null ถ้าไม่เจอ
const _fieldsGetCache = {};
async function odooFieldsGet(model) {
  if (!_fieldsGetCache[model]) {
    try {
      const uid = await odooAuth();
      _fieldsGetCache[model] = await jsonRpc('object', 'execute_kw', [
        ODOO_DB, uid, ODOO_KEY, model, 'fields_get', [], { attributes: ['string', 'type'] }
      ]) || {};
    } catch (e) { _fieldsGetCache[model] = {}; }
  }
  return _fieldsGetCache[model];
}

// ── หาเลข PR (เช่น "PR01979") ที่เก็บอยู่บน record ของ PO โดยไม่ต้องรู้ชื่อฟิลด์ ──
//   บาง setup ไม่ผูก m2m ของ OCA แต่เก็บเลข PR ไว้ในฟิลด์ custom ("PR No." ฯลฯ)
//   วิธี: หาฟิลด์ประเภทข้อความ/many2one ที่ชื่อหรือ label สื่อถึง PR → อ่านค่า → จับ /PR\d+/
async function odooFindPrRefOnPO(poId) {
  try {
    const fg = await odooFieldsGet('purchase.order');
    const cand = [];
    for (const tech of Object.keys(fg)) {
      const meta = fg[tech] || {};
      if (!['char', 'text', 'many2one', 'reference'].includes(meta.type)) continue;
      const lbl = String(meta.string || '');
      if (/pr[\s_]*no|purchase[._\s]?request|ใบขอซื้อ|เลขที่\s*pr/i.test(tech) ||
          /pr[\s_]*no|ใบขอซื้อ|เลขที่\s*pr|ใบขอ/i.test(lbl)) {
        cand.push(tech);
      }
    }
    if (!cand.length) return '';
    const rows = await searchRead('purchase.order', [['id', '=', poId]], cand, 1);
    if (!rows.length) return '';
    const row = rows[0];
    for (const f of cand) {
      let v = row[f];
      if (Array.isArray(v)) v = v[1] || '';       // many2one → เอาชื่อ
      const m = String(v || '').match(/PR\s*0*\d{3,}/i);
      if (m) return m[0].replace(/\s+/g, '');     // "PR 01979" → "PR01979"
    }
    return '';
  } catch (e) { return ''; }
}

// ── ดึง PR (เลขที่ + ผู้ขอ + วัตถุประสงค์) ที่ผูกกับ PO ─────────────────────────
//   ใช้ร่วมกันทั้ง odooReceiveDeliveryStatus และ odooDocDetail
//   ทางที่ 1: link มาตรฐาน OCA (purchase.request.line.purchase_lines ↔ PO.order_line)
//   ทางที่ 2 (สำรอง): อ่านเลข PR ที่เก็บบนตัว PO ("PR No.") แล้วค้น purchase.request
//                     (กรองบริษัทเดียวกับ PO เพราะเลข PR ซ้ำข้ามบริษัทได้ — มี 4 บริษัท)
//   วัตถุประสงค์ = ช่อง Description ของ PR (ตรงกับที่ผู้ใช้กรอกตอนขอซื้อ)
async function lookupPrForPO(orderLineIds, poId, coId) {
  let prName = '', prBy = '', prPurpose = '';
  try {
    let reqs = [];
    if (orderLineIds && orderLineIds.length) {
      const prLines = await searchRead('purchase.request.line',
        [['purchase_lines', 'in', orderLineIds]], ['request_id'], 100);
      const reqIds = [...new Set(prLines.map(l => Array.isArray(l.request_id) ? l.request_id[0] : null).filter(Boolean))];
      if (reqIds.length) {
        reqs = await searchRead('purchase.request',
          [['id', 'in', reqIds]], ['name', 'requested_by', 'description'], 20);
      }
    }
    if (!reqs.length && poId) {
      const prRef = await odooFindPrRefOnPO(poId);
      if (prRef) {
        reqs = await searchRead('purchase.request',
          withCompany(['|', ['name', '=', prRef], ['name', 'ilike', prRef]], coId),
          ['name', 'requested_by', 'description'], 3);
      }
    }
    if (reqs.length) {
      prName = [...new Set(reqs.map(r => r.name).filter(Boolean))].join(', ');
      prBy = [...new Set(reqs.map(r => Array.isArray(r.requested_by) ? r.requested_by[1] : '').filter(Boolean))].join(', ');
      prPurpose = [...new Set(reqs.map(r => String(r.description || '')
        .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean))].join(' | ');
    }
  } catch (e) { /* ไม่มีโมดูล PR หรือ field ต่าง → ข้าม */ }
  return { prName, prBy, prPurpose };
}

// ── ดึงรายละเอียด "ใบขอซื้อ (PR)" จากเลขที่ PR โดยตรง (เช่น PR01986) ───────────
//   คืน บริษัท / เลขที่ / วันที่ / ผู้ขอ / วัตถุประสงค์ / หมายเหตุ(ใช้ในงาน) / รายการทั้งหมด
//   ใช้กับ flow กลุ่มชุบ: AI อ่านเลข PR จากไฟล์ → เอาข้อมูลจริงจาก Odoo มาลง (แม่นสุด)
export async function odooPurchaseRequestByName(prName, companyHint = '') {
  const clean = String(prName || '').trim().replace(/\s+/g, '').toUpperCase();
  if (!clean) return null;
  const scrub = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  // ตัดคำทั่วไปออกจากชื่อบริษัท เหลือ "แก่น" ไว้เทียบ (มี 4 บริษัท เลข PR ซ้ำข้ามบริษัทได้)
  const core = s => String(s || '').replace(/บริษัท|จำกัด|มหาชน|ห้างหุ้นส่วน|\(?สำนักงานใหญ่\)?|\(|\)|\s/g, '').toLowerCase();
  try {
    let noteField = null;
    try {
      const fg = await odooFieldsGet('purchase.request');
      for (const tech of Object.keys(fg)) {
        const meta = fg[tech] || {};
        if (!['char', 'text'].includes(meta.type)) continue;
        if (/ใช้ในงาน|หมายเหตุ|remark|\bnote\b/i.test(String(meta.string || ''))) { noteField = tech; break; }
      }
    } catch (e) {}
    const hdr = ['name', 'company_id', 'requested_by', 'date_start', 'description'];
    if (noteField && !hdr.includes(noteField)) hdr.push(noteField);
    // ดึงทุกใบที่เลข PR ตรง (ข้ามบริษัท) มาก่อน แล้วค่อยเลือกบริษัทที่ตรงกับไฟล์
    const rows = await searchRead('purchase.request',
      ['|', ['name', '=', clean], ['name', 'ilike', clean]], hdr, 10);
    if (!rows.length) return null;

    // ── เลือกใบให้ตรงบริษัท (จากชื่อบริษัทที่อ่านได้จากไฟล์) ──
    let r = rows[0], ambiguous = false;
    if (rows.length > 1) {
      const hint = core(companyHint);
      let best = null, bestScore = 0;
      for (const row of rows) {
        const cName = Array.isArray(row.company_id) ? row.company_id[1] : '';
        const cCore = core(cName);
        let score = 0;
        if (cCore && hint) {
          if (hint.includes(cCore) || cCore.includes(hint)) score = 100;
          else { // นับคำเด่นของชื่อบริษัทที่โผล่ในข้อความไฟล์
            for (const w of String(cName).split(/\s+/)) { const wc = core(w); if (wc.length >= 3 && hint.includes(wc)) score++; }
          }
        }
        if (score > bestScore) { bestScore = score; best = row; }
      }
      if (best && bestScore > 0) r = best;
      else ambiguous = true; // ระบุบริษัทไม่ได้ → เตือนให้ตรวจสอบ
    }

    const lines = await searchRead('purchase.request.line',
      [['request_id', '=', r.id]], ['name', 'product_id', 'product_qty', 'product_uom_id'], 100);
    return {
      name: r.name,
      company: Array.isArray(r.company_id) ? r.company_id[1] : '',
      requestedBy: Array.isArray(r.requested_by) ? r.requested_by[1] : '',
      dateStart: String(r.date_start || '').slice(0, 10),
      purpose: scrub(r.description),
      note: noteField ? scrub(r[noteField]) : '',
      matchCount: rows.length,
      ambiguous,   // true = เลข PR ซ้ำหลายบริษัท และเลือกอัตโนมัติไม่ได้
      lines: lines.map(l => ({
        desc: scrub(l.name) || (Array.isArray(l.product_id) ? l.product_id[1] : ''),
        qty: l.product_qty || 0,
        uom: Array.isArray(l.product_uom_id) ? l.product_uom_id[1] : ''
      })).filter(l => l.desc)
    };
  } catch (e) { console.error('odooPurchaseRequestByName:', e.message); return null; }
}

// ── ดึงเอกสารจาก "ข้อความที่อ่านได้จากไฟล์" — รองรับ SO / PO / PR / งาน(picking) ──
//   ใช้กับ flow กลุ่มไลน์ที่อ่านไฟล์: หาเลขเอกสาร/ชื่องาน แล้วดึงข้อมูลจริงจาก Odoo
//   เลือกบริษัทให้ตรง (เลขเอกสารซ้ำข้ามบริษัทได้ — มี 4 บริษัท) โดยเทียบชื่อบริษัทในไฟล์
export async function odooDocForFile(fullText, companyHint = '', prefer = 'SO') {
  const txt = String(fullText || '');
  const scrub = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const arr = v => Array.isArray(v) ? v[1] : (v || '');
  const core = s => String(s || '').replace(/บริษัท|จำกัด|มหาชน|ห้างหุ้นส่วน|\(?สำนักงานใหญ่\)?|\(|\)|\s/g, '').toLowerCase();
  const pick = (rows) => {
    if (rows.length <= 1) return { row: rows[0], ambiguous: false };
    const hint = core(companyHint);
    let best = null, bestScore = 0;
    for (const row of rows) {
      const cName = arr(row.company_id); const cCore = core(cName); let score = 0;
      if (cCore && hint) {
        if (hint.includes(cCore) || cCore.includes(hint)) score = 100;
        else for (const w of String(cName).split(/\s+/)) { const wc = core(w); if (wc.length >= 3 && hint.includes(wc)) score++; }
      }
      if (score > bestScore) { bestScore = score; best = row; }
    }
    return best && bestScore > 0 ? { row: best, ambiguous: false } : { row: rows[0], ambiguous: true };
  };
  // ── SO (ใบเสนอราคา/ใบสั่งขาย) → ลูกค้า, รายการขาย ──
  const trySO = async () => {
    const m = txt.match(/\bSO\s*0*\d{4,}/i);
    if (!m) return null;
    const key = m[0].replace(/\s+/g, '').toUpperCase();
    const rows = await searchRead('sale.order', ['|', ['name', '=', key], ['name', 'ilike', key]],
      ['name', 'company_id', 'partner_id', 'date_order', 'note'], 10);
    if (!rows.length) return null;
    const { row: r, ambiguous } = pick(rows);
    const lines = await searchRead('sale.order.line', [['order_id', '=', r.id]],
      ['name', 'product_id', 'product_uom_qty', 'product_uom'], 100);
    return { kind: 'SO', ambiguous, matchCount: rows.length, company: arr(r.company_id),
      partner: arr(r.partner_id), partnerLabel: 'ลูกค้า', docName: r.name,
      date: String(r.date_order || '').slice(0, 10), note: scrub(r.note),
      lines: lines.map(l => ({ desc: scrub(l.name) || arr(l.product_id), qty: l.product_uom_qty || 0, uom: arr(l.product_uom) })).filter(l => l.desc) };
  };
  // ── PO (ใบสั่งซื้อ) → ผู้ขาย, รายการซื้อ ──
  const tryPO = async () => {
    const m = txt.match(/\bPO\s*0*\d{4,}/i);
    if (!m) return null;
    const key = m[0].replace(/\s+/g, '').toUpperCase();
    const rows = await searchRead('purchase.order', ['|', ['name', '=', key], ['name', 'ilike', key]],
      ['name', 'company_id', 'partner_id', 'date_order', 'notes'], 10);
    if (!rows.length) return null;
    const { row: r, ambiguous } = pick(rows);
    const lines = await searchRead('purchase.order.line', [['order_id', '=', r.id]],
      ['name', 'product_id', 'product_qty', 'product_uom'], 100);
    return { kind: 'PO', ambiguous, matchCount: rows.length, company: arr(r.company_id),
      partner: arr(r.partner_id), partnerLabel: 'ผู้ขาย', docName: r.name,
      date: String(r.date_order || '').slice(0, 10), note: scrub(r.notes),
      lines: lines.map(l => ({ desc: scrub(l.name) || arr(l.product_id), qty: l.product_qty || 0, uom: arr(l.product_uom) })).filter(l => l.desc) };
  };
  try {
    // "รับ" → เอา PO ก่อน (ซื้อเข้า) | "ส่ง" → เอา SO ก่อน (ขายออก)
    const order = prefer === 'PO' ? [tryPO, trySO] : [trySO, tryPO];
    for (const fn of order) { const r = await fn(); if (r) return r; }
    // ── PR (ใบขอซื้อ) ──
    let m;
    m = txt.match(/\bPR\s*0*\d{3,}/i);
    if (m) {
      const pr = await odooPurchaseRequestByName(m[0].replace(/\s+/g, ''), companyHint);
      if (pr && pr.lines.length) {
        return { kind: 'PR', ambiguous: pr.ambiguous, matchCount: pr.matchCount, company: pr.company,
          partner: pr.requestedBy, partnerLabel: 'ผู้ขอ', docName: pr.name, date: pr.dateStart,
          purpose: pr.purpose, note: pr.note, lines: pr.lines };
      }
    }
    // ── งานตั้งชื่อ (stock.picking) — จาก "DOCREF:" หรือ "ชื่องาน/เลขที่" ที่ AI อ่านได้ ──
    let ref = '';
    const dr = txt.match(/DOCREF\s*[:：]\s*(.+)/i);
    if (dr) ref = dr[1];
    if (!ref) { const jn = txt.match(/(?:ชื่องาน|โครงการ|เลขที่(?:เอกสาร)?)\s*[:：]\s*(.+)/); if (jn) ref = jn[1]; }
    ref = String(ref).replace(/\s{2,}.*$/, '').trim().slice(0, 60);
    if (ref && ref.length >= 4 && !/^(SO|PO|PR)\s*\d/i.test(ref)) {
      const rows = await searchRead('stock.picking',
        ['|', '|', ['name', 'ilike', ref], ['origin', 'ilike', ref], ['group_id', 'ilike', ref]],
        ['name', 'company_id', 'partner_id', 'scheduled_date', 'origin', 'group_id'], 10);
      if (rows.length) {
        const { row: r, ambiguous } = pick(rows);
        const moves = await searchRead('stock.move', [['picking_id', '=', r.id]],
          ['product_id', 'product_uom_qty', 'product_uom'], 100);
        return { kind: 'งาน', ambiguous, matchCount: rows.length, company: arr(r.company_id),
          partner: arr(r.partner_id), partnerLabel: 'ปลายทาง', docName: arr(r.group_id) || r.name,
          date: String(r.scheduled_date || '').slice(0, 10), note: scrub(r.origin),
          lines: moves.map(l => ({ desc: arr(l.product_id), qty: l.product_uom_qty || 0, uom: arr(l.product_uom) })).filter(l => l.desc) };
      }
    }
  } catch (e) { console.error('odooDocForFile:', e.message); }
  return null;
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

// ── สร้างคำค้นทางเลือกของ "คำเดียว" ──────────────────────────────────────────
// คืน array ของรูปแบบที่ควรลองค้นทั้งหมด เพื่อให้เจอไม่ว่า Odoo จะเก็บแบบไหน
// เช่น "so2605047" → ['so2605047', '2605047']  (origin อาจเก็บมี SO หรือไม่มีก็ได้)
//      "2605047"   → ['2605047']
//      "po2606025" → ['po2606025', '2606025']
function wordVariants(w) {
  const out = [w];
  const m = String(w).match(/^(so|po|pr)0*(\d+)$/i);
  if (m) {
    // ถอด prefix → เลขล้วน (เผื่อ origin เก็บแค่เลข)
    if (!out.includes(m[2])) out.push(m[2]);
  }
  return out;
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
  // ค้นด้วยทุก variant (po2606025 + 2606025) เผื่อ Odoo เก็บคนละรูปแบบ
  const vs = wordVariants(String(poNumber).trim());
  const nameOr = [];
  for (let i = 0; i < vs.length - 1; i++) nameOr.push('|');
  vs.forEach(v => nameOr.push(['name', 'ilike', v]));
  const dom = ['|', ...nameOr, ['partner_ref', 'ilike', poNumber]];
  const orders = await searchRead('purchase.order',
    withCompany(dom, companyId),
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
  // ค้นด้วยทุก variant (so2605047 + 2605047) เผื่อ Odoo เก็บคนละรูปแบบ
  const vs = wordVariants(String(soNumber).trim());
  const nameOr = [];
  for (let i = 0; i < vs.length - 1; i++) nameOr.push('|');
  vs.forEach(v => nameOr.push(['name', 'ilike', v]));
  const dom = ['|', ...nameOr, ['client_order_ref', 'ilike', soNumber]];
  const orders = await safeSearchRead('sale.order',
    withCompany(dom, companyId),
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
export async function odooFindDoc(docType, keyword, dateFilter, companyId) {
  const words = smartWords(keyword);
  // ถอด prefix po/so/pr ออก เผื่อ Odoo เก็บชื่อเอกสารเป็นเลขล้วน (เช่น "2606066" ไม่มี "PO" นำหน้า)
  const bareKw = String(keyword || '').replace(/^(po|so|pr)\s*0*/i, '').trim();
  const tryKeywords = bareKw && bareKw !== keyword ? [keyword, bareKw] : [keyword];

  if (docType === 'po') {
    for (const kw of tryKeywords) {
      const rows = await safeSearchRead('purchase.order',
        withCompany(['|', ['name', 'ilike', kw], ['partner_ref', 'ilike', kw]], companyId),
        ['id', 'name', 'partner_id'], 5);
      if (rows.length) {
        const best = sortExactFirst(rows, kw)[0];
        return { id: best.id, name: best.name, model: 'purchase.order' };
      }
    }
    return null;
  }

  if (docType === 'so') {
    for (const kw of tryKeywords) {
      const rows = await safeSearchRead('sale.order',
        withCompany(['|', ['name', 'ilike', kw], ['client_order_ref', 'ilike', kw]], companyId),
        ['id', 'name', 'partner_id'], 5);
      if (rows.length) {
        const best = sortExactFirst(rows, kw)[0];
        return { id: best.id, name: best.name, model: 'sale.order' };
      }
    }
    return null;
  }

  if (docType === 'pr') {
    for (const kw of tryKeywords) {
      const rows = await safeSearchRead('purchase.request',
        withCompany([['name', 'ilike', kw]], companyId),
        ['id', 'name'], 5);
      if (rows.length) {
        const best = sortExactFirst(rows, kw)[0];
        return { id: best.id, name: best.name, model: 'purchase.request' };
      }
    }
    return null;
  }

  // picking — ค้นแบบ odooDelivery + กรองวันที่
  const buildDomain = (level) => {
    const oneWord = (w) => {
      if (level === 'full') {
        return ['|', '|', '|',
          ['name', 'ilike', w], ['origin', 'ilike', w],
          ['partner_id.name', 'ilike', w],
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

  if (dateFilter && rows.length) {
    const filtered = rows.filter(p => String(p.scheduled_date || '').slice(0, 10) === dateFilter);
    if (filtered.length) rows = filtered;
  }

  if (!rows.length) return null;

  // เรียงให้ตรงที่สุดมาก่อน (กัน 82/2 โดน 82/1)
  const kwTrim = String(keyword).trim().toLowerCase();
  const tailMatch = kwTrim.match(/(\d+\s*\/\s*\d+)\s*$/);
  const kwTail = tailMatch ? tailMatch[1].replace(/\s+/g, '') : '';
  rows.sort((a, b) => {
    const an = String(a.name || '').trim().toLowerCase();
    const bn = String(b.name || '').trim().toLowerCase();
    const aExact = an === kwTrim ? 1 : 0;
    const bExact = bn === kwTrim ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    if (kwTail) {
      const aTail = an.replace(/\s+/g, '').endsWith(kwTail) ? 1 : 0;
      const bTail = bn.replace(/\s+/g, '').endsWith(kwTail) ? 1 : 0;
      if (aTail !== bTail) return bTail - aTail;
    }
    return 0;
  });

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
    // ค้น field เดียวด้วยทุก variant ของคำ (เช่น so2605047 + 2605047) เชื่อมด้วย OR
    const fieldVariants = (field, w) => {
      const vs = wordVariants(w);
      if (vs.length === 1) return [[field, 'ilike', vs[0]]];
      // หลาย variant → OR กัน: ['|', cond1, cond2, ...]
      const parts = [];
      for (let i = 0; i < vs.length - 1; i++) parts.push('|');
      vs.forEach(v => parts.push([field, 'ilike', v]));
      return parts;
    };
    const oneWord = (w) => {
      let conds = [];
      if (level === 'full') {
        // ค้น 4 field × ทุก variant — เชื่อมทั้งหมดด้วย OR
        conds = [
          ...fieldVariants('name', w),
          ...fieldVariants('origin', w),
          ...fieldVariants('partner_id.name', w),
          ...fieldVariants('group_id.name', w)
        ];
      } else if (level === 'dest') {
        conds = [
          ...fieldVariants('origin', w),
          ...fieldVariants('group_id.name', w)
        ];
      } else {
        // simple — ปลอดภัยสุด
        conds = [
          ...fieldVariants('name', w),
          ...fieldVariants('origin', w)
        ];
      }
      // นับจำนวน leaf condition (array ที่ไม่ใช่ '|') แล้วใส่ '|' นำหน้าให้ครบ
      const leafCount = conds.filter(c => Array.isArray(c)).length;
      const ors = [];
      for (let i = 0; i < leafCount - 1; i++) ors.push('|');
      return [...ors, ...conds.filter(c => Array.isArray(c))];
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

  const fields = ['name', 'origin', 'partner_id', 'state', 'scheduled_date', 'date_done', 'picking_type_id', 'group_id', 'company_id'];
  let pickings = [];
  let lastErr = null;
  // 1) ค้นแบบเต็ม (มี relational partner_id.name + group_id.name)
  try {
    pickings = await searchRead('stock.picking', buildDomain('full'), fields, 40);
  } catch (e) { lastErr = e; /* relational อาจพัง → fallback */ }
  // 2) ถ้าพัง/ไม่เจอ → dest/group
  if (!pickings.length) {
    try { pickings = await searchRead('stock.picking', buildDomain('dest'), fields, 40); } catch (e) { lastErr = e; }
  }
  // 3) ยังไม่เจอ → simple (name/origin)
  if (!pickings.length) {
    try { pickings = await searchRead('stock.picking', buildDomain('simple'), fields, 40); } catch (e) { lastErr = e; }
  }
  // 4) สุดท้าย → name+origin เท่านั้น (safe สุด)
  if (!pickings.length) {
    const safeOneWord = (w) => ['|', ['name', 'ilike', w], ['origin', 'ilike', w]];
    const safeDomain = (wds) => {
      let d;
      if (wds.length <= 1) { d = safeOneWord(wds[0] || ''); }
      else {
        d = [];
        for (let i = 0; i < wds.length - 1; i++) d.push('&');
        wds.forEach(w => d.push(...safeOneWord(w)));
      }
      return withCompany(d, companyId);
    };
    try { pickings = await searchRead('stock.picking', safeDomain(words), fields, 40); } catch (e) { lastErr = e; }
  }
  // ถ้าทุก level พัง (ไม่ใช่แค่ไม่เจอ) → แนบ error ไว้ที่ผลลัพธ์ (telegram อ่านได้)
  if (!pickings.length && lastErr) { pickings._error = lastErr.message; }

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

// ── ดึงข้อมูล "ใบรับสินค้า" 1 ใบ ตามเลขที่ (เช่น SET/IN/05983) สำหรับออกเอกสาร ──
//   คืน: ผู้จำหน่าย, ที่อยู่, วันที่รับจริง (date_done), คน validate, รายการสินค้า
//   validatedByStore1 = true ถ้า write_uid (คนแก้ล่าสุด/กด Done) คือ store1
export async function odooReceiptNote(docName) {
  const key = String(docName || '').trim();
  if (!key) return { error: 'ไม่ได้ระบุเลขที่เอกสาร' };
  const fields = ['name', 'origin', 'partner_id', 'state', 'scheduled_date', 'date_done', 'write_uid', 'company_id'];
  let rows = [];
  try {
    rows = await searchRead('stock.picking', [['name', '=', key]], fields, 1);
    if (!rows.length) rows = await searchRead('stock.picking', [['name', 'ilike', key]], fields, 1);
  } catch (e) { return { error: e.message }; }
  if (!rows.length) return { error: 'ไม่พบเอกสาร "' + key + '" ใน Odoo' };
  const p = rows[0];

  // รายการสินค้า
  let moveLines = [];
  try {
    moveLines = await searchRead('stock.move', [['picking_id', '=', p.id]],
      ['product_id', 'product_uom_qty', 'quantity', 'product_uom'], 100);
  } catch (e) { moveLines = []; }

  // login ของคน validate (write_uid)
  let validatorLogin = '', validatorName = '';
  const wuid = Array.isArray(p.write_uid) ? p.write_uid[0] : null;
  if (Array.isArray(p.write_uid)) validatorName = p.write_uid[1] || '';
  if (wuid) {
    try {
      const us = await searchRead('res.users', [['id', '=', wuid]], ['login'], 1);
      if (us.length) validatorLogin = String(us[0].login || '').toLowerCase();
    } catch (e) {}
  }

  // ที่อยู่ผู้จำหน่าย
  let address = '';
  const pid = Array.isArray(p.partner_id) ? p.partner_id[0] : null;
  if (pid) {
    try {
      const pr = await searchRead('res.partner', [['id', '=', pid]], ['contact_address', 'street', 'city'], 1);
      if (pr.length) {
        address = String(pr[0].contact_address || '').replace(/\s*\n+\s*/g, ' ').trim()
                  || [pr[0].street, pr[0].city].filter(Boolean).join(' ');
      }
    } catch (e) {}
  }

  const lines = (moveLines || []).map(l => {
    const full = Array.isArray(l.product_id) ? l.product_id[1] : '';
    const m = full.match(/^\[([^\]]+)\]\s*(.*)$/);
    return {
      code: m ? m[1] : '',
      name: m ? m[2] : full,
      qty: l.quantity || l.product_uom_qty || 0,
      uom: Array.isArray(l.product_uom) ? l.product_uom[1] : ''
    };
  }).filter(l => l.code || l.name);

  return {
    companyId: Array.isArray(p.company_id) ? p.company_id[0] : 1,
    docNo: p.name || '',
    ref: p.origin || '',
    supplier: Array.isArray(p.partner_id) ? p.partner_id[1] : '',
    address,
    date: String(p.date_done || p.scheduled_date || '').slice(0, 10), // วันที่รับจริง
    state: p.state || '',
    validator: validatorLogin,
    validatorName,
    validatedByStore1: validatorLogin === STORE1_LOGIN,
    lines
  };
}

// ── ค้นใบส่งของหลายใบพร้อมกัน ระบุเลขท้ายชัดเจน (เช่น keyword="พิษณุโลก", numbers=["20","23","25"]) ──
// ต่างจาก odooDelivery ตรงที่ใส่เงื่อนไข "name ลงท้ายด้วยเลขนี้" เข้าไปใน domain ตั้งแต่ต้น
// แก้ปัญหา: ถ้า keyword กว้าง (เช่นแค่ชื่อจังหวัด) มีใบตรงเป็นร้อย limit 40 ของการค้นกว้าง
// อาจตัดใบที่ต้องการทิ้งไปก่อนถึงตา — ฟังก์ชันนี้กรองที่ database query เลย ไม่พึ่ง limit แบบนั้น
export async function odooDeliveryMulti(keyword, numbers, companyId) {
  const words = smartWords(keyword);
  const nums = (numbers || []).map(n => String(parseInt(n, 10))).filter(n => n && n !== 'NaN');
  if (!nums.length) return [];

  // เงื่อนไข "ลงท้ายด้วยเลขนี้" (flat list ของ tuples ตาม Odoo Polish notation)
  // เช่น 3 เลข → ['|','|',['name','ilike','%/20'],['name','ilike','%/23'],['name','ilike','%/25']]
  const endsDomain = [];
  for (let i = 0; i < nums.length - 1; i++) endsDomain.push('|');
  nums.forEach(n => endsDomain.push(['name', 'ilike', '%/' + n]));

  // เงื่อนไข keyword (ต้องตรงคำค้นด้วย ไม่ใช่แค่เลขท้ายลอยๆ) — ก็ต้อง flat เช่นกัน
  const kwDomain = [];
  for (const w of words) {
    kwDomain.push('|', '|', ['name', 'ilike', w], ['origin', 'ilike', w], ['group_id.name', 'ilike', w]);
  }
  // รวม endsDomain กับ kwDomain (ทุกคำ) ด้วย '&' แบบ flat ทั้งหมด
  // จำนวนเงื่อนไขทั้งหมด = 1 (ends) + words.length (kw groups) → ต้องใส่ '&' (count-1) ตัว
  const totalGroups = 1 + words.length;
  let domain = [];
  for (let i = 0; i < totalGroups - 1; i++) domain.push('&');
  domain.push(...endsDomain, ...kwDomain);
  domain = withCompany(domain, companyId);

  const fields = ['name', 'origin', 'partner_id', 'state', 'scheduled_date', 'date_done', 'picking_type_id', 'group_id', 'company_id'];
  let pickings = [];
  try {
    pickings = await searchRead('stock.picking', domain, fields, nums.length + 10);
  } catch (e) {
    // fallback: ถ้า group_id.name พัง ลองตัดออก (เหลือแค่ name/origin)
    try {
      const safeKwDomain = [];
      for (const w of words) safeKwDomain.push('|', ['name', 'ilike', w], ['origin', 'ilike', w]);
      let safeDomain = [];
      for (let i = 0; i < totalGroups - 1; i++) safeDomain.push('&');
      safeDomain.push(...endsDomain, ...safeKwDomain);
      pickings = await searchRead('stock.picking', withCompany(safeDomain, companyId), fields, nums.length + 10);
    } catch (e2) {
      // สุดท้าย: ค้นแค่เลขท้ายอย่างเดียว ไม่กรอง keyword เลย (ปลอดภัยสุด กันพังเพราะ field ผิด)
      try {
        pickings = await searchRead('stock.picking', withCompany(endsDomain, companyId), fields, nums.length + 10);
      } catch (e3) { return []; }
    }
  }

  for (const p of pickings) {
    try {
      p.lines = await searchRead('stock.move', [['picking_id', '=', p.id]],
        ['product_id', 'product_uom_qty', 'quantity', 'product_uom'], 50);
    } catch (e) { p.lines = []; }
    try {
      const atts = await searchRead('ir.attachment',
        ['&', '&', ['res_model', '=', 'stock.picking'], ['res_id', '=', p.id], ['mimetype', 'ilike', 'image']],
        ['id', 'name', 'mimetype'], 50);
      p.images = (atts || []).map(a => ({ id: a.id, name: a.name || 'image' }));
    } catch (e) { p.images = []; }
  }
  return pickings;
}

// ── helper: เรียงผลลัพธ์ให้ตัวที่ตรงเป๊ะขึ้นก่อน ──────────────────────────────
function sortExactFirst(rows, keyword) {
  const kw = String(keyword).trim().toLowerCase();
  const idx = rows.findIndex(r => String(r.name || '').trim().toLowerCase() === kw);
  if (idx > 0) {
    const [exact] = rows.splice(idx, 1);
    rows.unshift(exact);
  }
  return rows;
}

// ── companyById (เผื่อไฟล์เก่าไม่มี) ──────────────────────────────────────────
const _COMPANY_ALL = [
  { id: 1, name: 'อาคเนย์' }, { id: 2, name: 'เมิร์ค' },
  { id: 4, name: 'ซิลิกัล' }, { id: 5, name: 'ศรีอาคเนย์' },
];
export function companyById(id) {
  return _COMPANY_ALL.find(c => c.id === id) || { id: 1, name: 'อาคเนย์' };
}

// ── normalize รายการสินค้าของเอกสาร SO/PO/PR ─────────────────────────────────
export function normalizeDocLines(doc, type) {
  const lines = doc.lines || [];
  return lines.map(l => {
    const prod = Array.isArray(l.product_id) ? l.product_id : [0, ''];
    const code = prod[0] ? String(prod[0]) : '';
    const name = prod[1] || l.name || '';
    let qty = 0, uomField = null;
    if (type === 'so') { qty = l.product_uom_qty || 0; uomField = l.product_uom; }
    else if (type === 'po') { qty = l.product_qty || 0; uomField = l.product_uom; }
    else if (type === 'pr') { qty = l.product_qty || 0; uomField = l.product_uom_id; }
    const unit = Array.isArray(uomField) ? (uomField[1] || '') : '';
    return { code, name, unit, qty: +qty };
  });
}

export function normalizePickingLines(picking) {
  const lines = picking.lines || [];
  return lines.map(l => {
    const prod = Array.isArray(l.product_id) ? l.product_id : [0, ''];
    const code = prod[0] ? String(prod[0]) : '';
    const name = prod[1] || l.name || '';
    const unit = Array.isArray(l.product_uom) ? (l.product_uom[1] || '') : '';
    return { code, name, unit, qtyPlanned: +(l.product_uom_qty || 0), qtyDone: +(l.quantity || 0) };
  });
}

// ── เทียบเอกสารกับใบส่งของ ────────────────────────────────────────────────────
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
  const mapOther = new Map(); otherLines.forEach(l => mapOther.set(l.code || l.name, l));
  const mapPick = new Map(); pickLines.forEach(l => mapPick.set(l.code || l.name, l));
  const allKeys = new Set([...mapOther.keys(), ...mapPick.keys()]);
  const rows = [];
  for (const k of allKeys) {
    const o = mapOther.get(k), p = mapPick.get(k);
    const qtyOther = o ? o.qty : 0, qtyPlanned = p ? p.qtyPlanned : 0, qtyDone = p ? p.qtyDone : 0;
    const diff = qtyOther - qtyDone;
    let status = 'ok';
    if (!o) status = 'missing_a'; else if (!p) status = 'missing_b'; else if (diff !== 0) status = 'diff';
    rows.push({ code: (o||p).code, name: (o||p).name, unit: (o||p).unit || '', qtyOther, qtyPlanned, qtyDone, diff, status });
  }
  rows.sort((a, b) => {
    const order = { missing_a: 0, missing_b: 1, diff: 2, ok: 3 };
    return (order[a.status] || 3) - (order[b.status] || 3);
  });
  return { otherDoc, otherType, otherNum, picking, rows };
}

// ── ดึง PDF ใบส่งสินค้าจาก Odoo ──────────────────────────────────────────────
export async function odooDeliveryPDF(pickIds) {
  if (!Array.isArray(pickIds) || !pickIds.length) throw new Error('ไม่ได้ระบุใบส่งของ');
  const webPassword = process.env.ODOO_PASSWORD || ODOO_KEY;
  const loginRes = await fetch(ODOO_URL + '/web/session/authenticate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', params: { db: ODOO_DB, login: ODOO_USER, password: webPassword } })
  });
  const setCookie = loginRes.headers.get('set-cookie') || '';
  const sessionId = (setCookie.match(/session_id=([^;]+)/) || [])[1];
  if (!sessionId) {
    const j = await loginRes.json().catch(() => ({}));
    const msg = j.error?.data?.message || j.error?.message || 'Access Denied';
    throw new Error('Odoo web session ล้มเหลว: ' + msg + ' (ต้องตั้ง ODOO_PASSWORD = รหัสผ่านจริงใน Vercel)');
  }
  const cookie = 'session_id=' + sessionId;
  const ids = pickIds.join(',');
  const reportUrl = ODOO_URL + '/report/pdf/stock.report_deliveryslip/' + ids;
  const pdfRes = await fetch(reportUrl, { headers: { Cookie: cookie } });
  if (!pdfRes.ok) throw new Error('ดึง PDF จาก Odoo ไม่สำเร็จ (HTTP ' + pdfRes.status + ')');
  const buf = Buffer.from(await pdfRes.arrayBuffer());
  if (buf.length < 100 || buf.slice(0, 4).toString() !== '%PDF') {
    throw new Error('ไฟล์ที่ได้ไม่ใช่ PDF (อาจไม่มีสิทธิ์ หรือ report name ไม่ตรง)');
  }
  return buf.toString('base64');
}

export async function odooAllProductIds() {
  const uid = await odooAuth();
  const rows = await jsonRpc('object', 'execute_kw', [
    ODOO_DB, uid, ODOO_KEY, 'product.product', 'search_read',
    [[['default_code', '!=', false]]],
    { fields: ['id', 'default_code', 'name'], limit: 10000 }
  ]);
  return rows.map(r => ({ id: r.id, code: r.default_code, name: r.name }));
}

export async function odooFindOperationType(keyword, companyId) {
  const domain = withCompany([['name', 'ilike', keyword]], companyId);
  const rows = await searchRead('stock.picking.type', domain,
    ['id', 'name', 'warehouse_id', 'default_location_src_id', 'default_location_dest_id', 'code'], 20);
  const outgoing = rows.filter(r => r.code === 'outgoing');
  return outgoing.length ? outgoing : rows;
}

export async function odooCreatePickingFromLines(pickingTypeId, lines, scheduledDate, sourceDoc, companyId) {
  const uid = await odooAuth();
  const ptRows = await searchRead('stock.picking.type', [['id', '=', pickingTypeId]],
    ['default_location_src_id', 'default_location_dest_id', 'name'], 1);
  if (!ptRows.length) throw new Error('ไม่พบ Operation Type id=' + pickingTypeId);
  const pt = ptRows[0];
  const srcLocId  = Array.isArray(pt.default_location_src_id)  ? pt.default_location_src_id[0]  : pt.default_location_src_id;
  const destLocId = Array.isArray(pt.default_location_dest_id) ? pt.default_location_dest_id[0] : pt.default_location_dest_id;
  const codes = lines.map(l => l.productCode).filter(Boolean);
  let codeMap = new Map();
  if (codes.length) {
    const prodByCode = await searchRead('product.product', [['default_code', 'in', codes]],
      ['id', 'default_code', 'name', 'uom_id'], codes.length + 5);
    codeMap = new Map(prodByCode.map(r => [String(r.default_code), r]));
  }
  const cleanName = (s) => String(s || '').replace(/-{2,}/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const results = lines.map(line => {
    if (line.productCode && codeMap.has(String(line.productCode))) {
      return { line, status: 'code', product: codeMap.get(String(line.productCode)) };
    }
    return { line, status: 'notfound', product: null };
  });
  const needNameSearch = results.filter(r => r.status === 'notfound' && r.line.productName);
  if (needNameSearch.length) {
    const nameDomain = needNameSearch.map(r => ['name', 'ilike', String(r.line.productName).replace(/-{2,}/g, ' ').trim()]);
    let domain;
    if (nameDomain.length === 1) { domain = [nameDomain[0]]; }
    else { domain = []; for (let i = 0; i < nameDomain.length - 1; i++) domain.push('|'); domain = domain.concat(nameDomain); }
    const nameRows = await searchRead('product.product', domain, ['id', 'default_code', 'name', 'uom_id'], needNameSearch.length * 3 + 5);
    for (const r of needNameSearch) {
      const nm = cleanName(r.line.productName);
      const searchNm = nm.split(' ')[0];
      const candidates = nameRows.filter(p => cleanName(p.name).includes(searchNm) || searchNm.includes(cleanName(p.name).split(' ')[0]));
      if (candidates.length) {
        const exact = candidates.find(p => cleanName(p.name) === nm);
        r.product = exact || candidates[0]; r.status = 'name';
      }
    }
  }
  const pickingVals = {
    picking_type_id: pickingTypeId, location_id: srcLocId, location_dest_id: destLocId,
    origin: sourceDoc || '',
    ...(scheduledDate ? { scheduled_date: scheduledDate } : {}),
    ...(companyId ? { company_id: companyId } : {}),
  };
  const pickingId = await jsonRpc('object', 'execute_kw', [ODOO_DB, uid, ODOO_KEY, 'stock.picking', 'create', [pickingVals]]);
  const moveVals = results.filter(r => r.product).map(r => {
    const prod = r.product;
    const uomId = Array.isArray(prod.uom_id) ? prod.uom_id[0] : prod.uom_id;
    return {
      name: prod.name || r.line.productCode || r.line.productName || '-',
      picking_id: pickingId, product_id: prod.id,
      product_uom_qty: parseFloat(r.line.qty) || 1, product_uom: uomId,
      location_id: srcLocId, location_dest_id: destLocId,
    };
  });
  if (moveVals.length) {
    await jsonRpc('object', 'execute_kw', [ODOO_DB, uid, ODOO_KEY, 'stock.move', 'create', [moveVals]]);
  }
  const matchedCode = results.filter(r => r.status === 'code');
  const matchedName = results.filter(r => r.status === 'name');
  const notFound = results.filter(r => r.status === 'notfound');
  return { pickingId, results, matchedCode, matchedName, notFound };
}

// ── รายการการ์ดเรล (สำหรับ /อัพเดทสต็อกการ์ดเรล) ─────────────────────────────
export const GUARDRAIL_PRODUCTS = [
  { code: '15FG-FG2-02-01-01-00-00-00-00', label: 'แผ่นการ์ดเรล หนา 3.2mm ยาว 4.32m', group: 'plate' },
  { code: '15FG-FG2-02-01-02-00-00-00-00', label: 'แผ่นการ์ดเรล หนา 2.5mm ยาว 4.32m', group: 'plate' },
  { code: '15FG-FG2-03-01-00-00-00-00-00', label: 'แผ่นประกับเฉียงการ์ดเรล', group: 'plate' },
  { code: '15FG-FG2-04-01-02-00-00-00-00', label: 'แผ่นปลายการ์ดเรล หนา 3.2mm', group: 'plate' },
  { code: '15FG-FG2-01-01-01-00-00-00-00', label: 'BLOCK OUT กลม 101.6x4x250mm', group: 'plate' },
  { code: '15FG-FG2-04-01-02-01-00-00-00', label: 'แผ่นปลายการ์ดเรล หนา 3.2mm (Bull Nose)', group: 'plate' },
  { code: '15FG-FG2-05-01-00-00-00-00-00', label: 'แผ่นเสริมกำลังการ์ดเรล', group: 'plate' },
  { code: '15FG-FG2-06-02-01-00-00-00-00', label: 'แผ่นโค้งการ์ดเรล หนา 3.2mm', group: 'plate' },
  { code: '15FG-FG2-06-02-02-00-00-00-00', label: 'แผ่นโค้งการ์ดเรล หนา 2.5mm', group: 'plate' },
  { code: '07RP-055-04-01-01-00-00-00-00', label: 'แผ่นปลายการ์ดเรล ติดสะพาน กว้าง370mm ยาว700mm หนา3.2mm', group: 'plate' },
  { code: '15FG-FG2-06-01-06-00-00-00-00', label: 'เสาการ์ดเรล 101.6mm หนา4.0mm ยาว2600mm เจาะ4รู (ทล.)', group: 'post' },
  { code: '15FG-FG2-06-01-07-01-00-00-00', label: 'เสาการ์ดเรล 101.6mm หนา4.0mm ยาว2m เจาะ1รู (กทม.)', group: 'post' },
  { code: '15FG-FG2-07-01-01-00-00-00-00', label: 'เสาองศาการ์ดเรล 60° ยาว2000mm', group: 'post' },
  { code: '15FG-FG2-07-01-02-00-00-00-00', label: 'เสาองศาการ์ดเรล 60° ยาว2500mm', group: 'post' },
  { code: '15FG-FG2-08-01-01-00-00-00-00', label: 'เสาองศาการ์ดเรล 30° ยาว2000mm', group: 'post' },
  { code: '15FG-FG2-08-01-02-00-00-00-00', label: 'เสาองศาการ์ดเรล 30° ยาว2500mm', group: 'post' },
  { code: '15FG-GP1-00-01-01-01-00-00-00', label: 'เสาการ์ดเรล 101.6mm หนา4.0mm ยาว2000mm เจาะ2รู แบบเชื่อมฝา+Steel plate (ทล.)', group: 'post' },
  { code: '15FG-GP1-01-02-01-01-00-00-00', label: 'เสาการ์ดเรล เจาะ2รู ยาว2000mm (กทม.)', group: 'post' },
  { code: '15FG-GP1-02-02-01-01-00-00-00', label: 'เสาการ์ดเรล เจาะ2รู+เพลทฐาน ยาว920mm (กทม.)', group: 'post' },
  { code: '07RP-057-03-01-04-00-00-00-00', label: 'เสาการ์ดเรล 101.6mm ยาว2500mm เจาะ2รู (ทล.)', group: 'post' },
  { code: '15FG-GP1-00-01-02-01-00-00-00', label: 'เสาการ์ดเรล 101.6mm หนา4.0mm ยาว2000mm เจาะ1รู แบบเชื่อมฝา (ทช.)', group: 'post' },
  { code: '07RP-037-17-01-01-00-00-00-00', label: 'นอตการ์ดเรล สั้น 5/8"x1-1/4"', group: 'accessory' },
  { code: '07RP-037-15-01-01-00-00-00-00', label: 'นอตการ์ดเรล กลาง 5/8"x2-1/2"', group: 'accessory' },
  { code: '07RP-037-16-01-02-00-00-00-00', label: 'นอตการ์ดเรล ยาว 5/8"x7-1/4"', group: 'accessory' },
  { code: '07RP-040-01-01-01-00-00-00-00', label: 'BLOCK OUT ตัวซีการ์ดเรล 150x75x330mm', group: 'accessory' },
  { code: '07RP-017-00-02-01-00-00-00-00', label: 'ประกับนอตยาวการ์ดเรล 60x60x15mm', group: 'accessory' },
  { code: '07RP-017-02-02-01-00-00-00-00', label: 'ประกับนอตยาวการ์ดเรล 50x60x15mm', group: 'accessory' },
  { code: '07RP-010-00-01-03-00-00-00-00', label: 'ฐานเสาการ์ดเรล ตอม่อ 0.70x0.70x0.80m (1 โบลท์)', group: 'accessory' },
  { code: '07RP-010-00-01-03-01-00-00-00', label: 'ฐานเสาการ์ดเรล ตอม่อ 0.70x0.70x0.80m (I-Bolt 2ตัว)', group: 'accessory' },
  { code: '07RP-018-02-01-01-00-00-00-00', label: 'เป้าคางหมู 100x150mm', group: 'accessory' },
  { code: '07RP-018-01-01-01-00-00-00-00', label: 'เป้ากลม 100mm', group: 'accessory' },
  { code: '10RB-004-01-01-01-01-00-00-00', label: 'เป้าสะท้อนแสงการ์ดเรล ทรงโค้ง 350x90mm เจาะ2รู (กทม.)', group: 'accessory' },
];

// ── รายการอุปกรณ์ไฟฟ้า (1392 รหัส) สำหรับ /อัพเดทสต็อกอุปกรณ์ไฟฟ้า ──
export const ELECTRICAL_PRODUCTS = [
  { code: '07RP-0106-04-00-02-01-01-04-04', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0114-00-00-00-01-01-00-00', label: 'ปลอกหุ้มหางปลา----V-5-สี-ดำ--', group: 'lug' },
  { code: '07RP-0114-00-00-00-01-02-00-00', label: 'ปลอกหุ้มหางปลา----V-5-สี-เทา--', group: 'lug' },
  { code: '07RP-0114-00-00-00-01-03-00-00', label: 'ปลอกหุ้มหางปลา----V-5-สี-น้ำเงิน--', group: 'lug' },
  { code: '07RP-0114-00-00-00-01-04-00-00', label: 'ปลอกหุ้มหางปลา----V-5-สี-น้ำตาล--', group: 'lug' },
  { code: '07RP-031-05-01-00-02-00-00-01', label: 'หางปลา-ชนิดกลม รุ่นหนา ทรงยุโรป-ทองแดง--เบอร์ CL16-6----ยี่ห้อ T-LUG', group: 'lug' },
  { code: '07RP-031-05-01-00-03-00-00-01', label: 'หางปลา-ชนิดกลม รุ่นหนา ทรงยุโรป-ทองแดง--เบอร์ CL35-8----ยี่ห้อ T-LUG', group: 'lug' },
  { code: '07RP-031-05-01-00-04-00-00-01', label: 'หางปลา-ชนิดกลม รุ่นหนา ทรงยุโรป-ทองแดง--เบอร์ CL10-8----ยี่ห้อ T-LUG', group: 'lug' },
  { code: '07RP-031-05-01-00-05-00-00-01', label: 'หางปลา-ชนิดกลม รุ่นหนา ทรงยุโรป-ทองแดง--เบอร์ CL25-8----ยี่ห้อ T-LUG', group: 'lug' },
  { code: '07RP-031-05-01-00-06-00-01-00', label: 'หางปลา-ชนิดกลม รุ่นหนา ทรงยุโรป-ทองแดง--เบอร์ ST6-8---ขั้นต่ำ100ชิ้น-', group: 'lug' },
  { code: '07RP-031-06-01-00-01-00-00-01', label: 'หางปลา-ชนิดกลม หุ้มปลอก สีน้ำเงิน-ทองแดง--เบอร์ RF2.5-6----ยี่ห้อ T-LUG', group: 'lug' },
  { code: '07RP-031-07-01-00-01-00-00-01', label: 'หางปลา-ชนิดแฉก หุ้มปลอก สีน้ำเงิน-ทองแดง--เบอร์ YF2.5-5s----ยี่ห้อ T-LUG', group: 'lug' },
  { code: '07RP-043-01-01-01-00-00-00-00', label: 'แคล้ม-หัวใจ-เหล็กชุบทองแดง-ขนาด 5/8"-----', group: 'clamp' },
  { code: '07RP-043-02-01-01-00-00-00-00', label: 'แคล้ม-ประกับรัดท่อ IMC-ชุบขาว SC-ขนาด 2"-----', group: 'clamp' },
  { code: '07RP-043-02-01-02-00-00-00-00', label: 'แคล้ม-ประกับรัดท่อ IMC-ชุบขาว SC-ขนาด 1/2"-----', group: 'clamp' },
  { code: '07RP-049-01-00-01-01-BK-00-01', label: 'เทป-พันสายไฟ--ขนาด 3/4” ยาว 10 เมตร-No.Temflex 150-สี-ดำ--ยี่ห้อ 3M', group: 'tape' },
  { code: '07RP-049-02-00-01-00-RD-00-00', label: 'เทป-ฝังใต้ดิน/เทปเตือนอันตราย--ขนาด 6" ยาว 305 เมตร--สี-แดง--', group: 'tape' },
  { code: '07RP-049-03-00-01-01-BK-00-01', label: 'เทป-พันละลาย--ขนาด 3/4” ยาว 30 ฟุต-Scotch No.23-สี-ดำ--ยี่ห้อ 3M', group: 'tape' },
  { code: '06RM-BR12-02-00-00-01-00-00-00', label: 'หางปลา-ชนิดแฉก หุ้มปลอก---เบอร์ SV 5.5-5----', group: 'lug' },
  { code: '06RM-BR12-02-01-00-01-00-00-01', label: 'หางปลา-ชนิดแฉก หุ้มปลอก-ทองแดง--เบอร์ YF4-4----ยี่ห้อ T-LUG', group: 'lug' },
  { code: '07RP-010-00-01-05-00-00-00-00', label: 'ฐานเสาไฟฟ้า 9 เมตร ตอม่อ--ฐานปูน-ขนาด 0.80x0.40 สูง 1.20 เมตร-----', group: 'base' },
  { code: '07RP-0106-00-00-00-00-00-00-00', label: 'สายไฟ-ขนาด ------ ใช้รหัสนี้สั่งซื้อ ในกรณีที่ยังไม่ทราบยี่ห้อ', group: 'wire_other' },
  { code: '07RP-0106-01-00-01-01-01-01-01', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-01-02', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-01-03', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-01-04', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-01-05', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-01-06', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-01-07', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-02-01', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-02-02', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-02-03', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-02-04', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-02-05', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-02-06', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-02-07', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-03-01', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-03-02', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-03-03', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-03-04', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-03-05', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-03-06', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-03-07', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-04-01', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-04-02', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-04-03', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-04-04', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-04-05', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-04-06', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-01-01-01-04-07', label: 'สายไฟ-CV--2x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-01-01', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-01-02', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-01-03', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-01-04', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-01-05', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-01-06', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-01-07', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-02-01', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-02-02', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-02-03', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-02-04', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-02-05', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-02-06', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-02-07', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-03-01', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-03-02', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-03-03', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-03-04', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-03-05', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-03-06', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-03-07', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-04-01', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-04-02', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-04-03', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-04-04', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-04-05', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-04-06', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-02-01-01-04-07', label: 'สายไฟ-CV--2x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-01-01', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-01-02', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-01-03', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-01-04', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-01-05', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-01-06', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-01-07', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-02-01', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-02-02', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-02-03', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-02-04', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-02-05', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-02-06', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-02-07', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-03-01', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-03-02', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-03-03', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-03-04', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-03-05', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-03-06', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-03-07', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-04-01', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ/ยาวตลอด-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-04-02', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-04-03', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-04-04', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ/ยาวตลอด-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-04-05', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-04-06', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-03-01-01-04-07', label: 'สายไฟ-CV--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-01-01', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-01-02', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-01-03', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-01-04', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-01-05', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-01-06', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-01-07', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-02-01', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-02-02', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-02-03', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-02-04', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-02-05', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-02-06', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-02-07', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-03-01', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-03-02', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-03-03', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-03-04', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-03-05', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-03-06', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-03-07', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-04-01', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ/ยาวตลอด-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-04-02', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-04-03', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-04-04', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ/ยาวตลอด-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-04-05', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-04-06', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-04-01-01-04-07', label: 'สายไฟ-CV--2x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-01-01', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-01-02', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-01-03', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-01-04', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-01-05', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-01-06', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-01-07', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-02-01', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-02-02', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-02-03', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-02-04', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-02-05', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-02-06', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-02-07', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-03-01', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-03-02', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-03-03', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-03-04', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-03-05', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-03-06', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-03-07', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-04-01', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-04-02', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-04-03', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-04-04', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-04-05', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-04-06', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-05-01-01-04-07', label: 'สายไฟ-CV--2x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-01-01', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-01-02', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-01-03', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-01-04', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-01-05', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-01-06', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-01-07', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-02-01', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-02-02', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-02-03', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-02-04', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-02-05', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-02-06', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-02-07', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-03-01', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-03-02', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-03-03', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-03-04', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-03-05', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-03-06', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-03-07', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-04-01', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-04-02', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-04-03', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-04-04', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-04-05', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-04-06', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-06-01-01-04-07', label: 'สายไฟ-CV--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-01-01', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-01-02', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-01-03', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-01-04', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-01-05', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-01-06', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-01-07', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-02-01', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-02-02', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-02-03', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-02-04', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-02-05', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-02-06', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-02-07', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-03-01', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-03-02', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-03-03', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-03-04', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-03-05', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-03-06', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-03-07', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-04-01', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-04-02', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-04-03', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-04-04', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-04-05', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-04-06', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-07-01-01-04-07', label: 'สายไฟ-CV--3x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-01-01', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-01-02', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-01-03', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-01-04', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-01-05', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-01-06', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-01-07', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-02-01', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-02-02', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-02-03', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-02-04', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-02-05', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-02-06', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-02-07', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-03-01', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-03-02', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-03-03', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-03-04', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-03-05', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-03-06', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-03-07', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-04-01', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-04-02', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-04-03', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-04-04', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-04-05', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-04-06', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-08-01-01-04-07', label: 'สายไฟ-CV--3x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-01-01', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-01-02', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-01-03', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-01-04', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-01-05', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-01-06', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-01-07', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-02-01', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-02-02', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-02-03', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-02-04', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-02-05', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-02-06', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-02-07', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-03-01', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-03-02', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-03-03', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-03-04', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-03-05', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-03-06', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-03-07', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-04-01', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-04-02', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-04-03', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-04-04', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-04-05', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-04-06', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-09-01-01-04-07', label: 'สายไฟ-CV--3x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-01-01', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-01-02', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-01-03', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-01-04', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-01-05', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-01-06', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-01-07', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-02-01', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-02-02', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-02-03', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-02-04', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-02-05', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-02-06', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-02-07', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-03-01', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-03-02', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-03-03', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-03-04', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-03-05', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-03-06', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-03-07', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-04-01', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-04-02', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-04-03', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-04-04', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-04-05', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-04-06', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-10-01-01-04-07', label: 'สายไฟ-CV--3x6mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-01-01', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-01-02', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-01-03', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-01-04', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-01-05', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-01-06', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-01-07', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-02-01', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-02-02', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-02-03', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-02-04', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-02-05', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-02-06', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-02-07', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-03-01', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-03-02', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-03-03', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-03-04', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-03-05', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-03-06', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-03-07', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-04-01', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-04-02', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-04-03', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-04-04', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-04-05', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-04-06', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-11-01-01-04-07', label: 'สายไฟ-CV--4x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-01-01', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-01-02', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-01-03', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-01-04', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-01-05', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-01-06', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-01-07', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-02-01', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-02-02', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-02-03', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-02-04', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-02-05', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-02-06', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-02-07', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-03-01', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-03-02', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-03-03', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-03-04', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-03-05', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-03-06', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-03-07', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-04-01', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-04-02', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-04-03', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-04-04', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-04-05', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-04-06', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-12-01-01-04-07', label: 'สายไฟ-CV--4x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-01-01', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-01-02', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-01-03', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-01-04', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-01-05', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-01-06', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-01-07', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-02-01', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-02-02', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-02-03', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-02-04', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-02-05', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-02-06', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-02-07', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-03-01', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-03-02', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-03-03', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-03-04', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-03-05', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-03-06', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-03-07', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-04-01', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-04-02', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-04-03', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-04-04', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-04-05', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-04-06', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_CV' },
  { code: '07RP-0106-01-00-13-01-01-04-07', label: 'สายไฟ-CV--4x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-14-01-01-01-01', label: 'สายไฟ-CV--4x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-14-01-01-02-01', label: 'สายไฟ-CV--4x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-14-01-01-03-01', label: 'สายไฟ-CV--4x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-14-01-01-04-01', label: 'สายไฟ-CV--4x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-15-01-01-01-01', label: 'สายไฟ-CV--4x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-15-01-01-02-01', label: 'สายไฟ-CV--4x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-15-01-01-03-01', label: 'สายไฟ-CV--4x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-01-00-15-01-01-04-01', label: 'สายไฟ-CV--4x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ ยาวตลอด-ยี่ห้อ UNITED CABLE', group: 'wire_CV' },
  { code: '07RP-0106-02-00-01-01-01-01-01', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-01-02', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-01-03', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-01-04', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-01-05', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-01-06', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-01-07', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-02-01', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-02-02', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-02-03', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-02-04', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-02-05', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-02-06', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-02-07', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-03-01', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-03-02', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-03-03', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-03-04', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-03-05', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-03-06', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-03-07', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-04-01', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-04-02', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-04-03', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-04-04', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-04-05', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-04-06', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-01-01-01-04-07', label: 'สายไฟ-NYY--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-01-01', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-01-02', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-01-03', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-01-04', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-01-05', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-01-06', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-01-07', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-02-01', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-02-02', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-02-03', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-02-04', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-02-05', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-02-06', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-02-07', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-03-01', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-03-02', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-03-03', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-03-04', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-03-05', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-03-06', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-03-07', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-04-01', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-04-02', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-04-03', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-04-04', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-04-05', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-04-06', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-02-01-01-04-07', label: 'สายไฟ-NYY--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-01-01', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-01-02', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-01-03', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-01-04', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-01-05', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-01-06', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-01-07', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-02-01', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-02-02', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-02-03', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-02-04', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-02-05', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-02-06', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-02-07', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-03-01', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-03-02', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-03-03', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-03-04', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-03-05', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-03-06', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-03-07', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-04-01', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-04-02', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-04-03', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-04-04', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-04-05', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-04-06', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-03-01-01-04-07', label: 'สายไฟ-NYY--2x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-01-01', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-01-02', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-01-03', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-01-04', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-01-05', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-01-06', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-01-07', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-02-01', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-02-02', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-02-03', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-02-04', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-02-05', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-02-06', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-02-07', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-03-01', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-03-02', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-03-03', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-03-04', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-03-05', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-03-06', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-03-07', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-04-01', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-04-02', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-04-03', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-04-04', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-04-05', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-04-06', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-04-01-01-04-07', label: 'สายไฟ-NYY--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-01-01', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-01-02', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-01-03', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-01-04', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-01-05', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-01-06', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-01-07', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-02-01', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-02-02', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-02-03', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-02-04', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-02-05', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-02-06', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-02-07', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-03-01', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-03-02', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-03-03', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-03-04', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-03-05', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-03-06', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-03-07', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-04-01', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-04-02', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-04-03', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-04-04', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-04-05', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-04-06', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-05-01-01-04-07', label: 'สายไฟ-NYY--3x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-01-01', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-01-02', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-01-03', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-01-04', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-01-05', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-01-06', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-01-07', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-02-01', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-02-02', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-02-03', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-02-04', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-02-05', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-02-06', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-02-07', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-03-01', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-03-02', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-03-03', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-03-04', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-03-05', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-03-06', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-03-07', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-04-01', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-04-02', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-04-03', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-04-04', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-04-05', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-04-06', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-06-01-01-04-07', label: 'สายไฟ-NYY--4x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-01-01', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-01-02', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-01-03', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-01-04', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-01-05', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-01-06', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-01-07', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-02-01', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-02-02', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-02-03', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-02-04', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-02-05', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-02-06', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-02-07', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-03-01', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-03-02', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-03-03', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-03-04', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-03-05', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-03-06', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-03-07', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-04-01', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-04-02', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-04-03', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-04-04', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-04-05', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-04-06', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-07-01-01-04-07', label: 'สายไฟ-NYY--4x25mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-08-01-01-01-01', label: 'สายไฟ-NYY--2x6mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-08-01-01-01-02', label: 'สายไฟ-NYY--2x6mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ BANGKOK CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-08-01-01-02-01', label: 'สายไฟ-NYY--2x6mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-08-01-01-02-02', label: 'สายไฟ-NYY--2x6mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ BANGKOK CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-08-01-01-03-01', label: 'สายไฟ-NYY--2x6mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-08-01-01-03-02', label: 'สายไฟ-NYY--2x6mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ BANGKOK CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-08-01-01-04-01', label: 'สายไฟ-NYY--2x6mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-08-01-01-04-02', label: 'สายไฟ-NYY--2x6mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ BANGKOK CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-09-01-01-02-01', label: 'สายไฟ-NYY--4x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-09-01-01-03-01', label: 'สายไฟ-NYY--4x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-09-01-01-04-01', label: 'สายไฟ-NYY--4x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-10-01-01-01-01', label: 'สายไฟ-NYY--4x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-10-01-01-01-02', label: 'สายไฟ-NYY--4x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-10-01-01-02-01', label: 'สายไฟ-NYY--4x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-10-01-01-02-02', label: 'สายไฟ-NYY--4x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-10-01-01-03-01', label: 'สายไฟ-NYY--4x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-10-01-01-03-02', label: 'สายไฟ-NYY--4x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-10-01-01-04-01', label: 'สายไฟ-NYY--4x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ ยาวตลอด-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-10-01-01-04-02', label: 'สายไฟ-NYY--4x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ ยาวตลอด-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-10-01-01-04-03', label: 'สายไฟ-NYY--4x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ ยาวตลอด-ยี่ห้อ YASAKI', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-11-01-01-01-01', label: 'สายไฟ-NYY--4x1.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-11-01-01-02-01', label: 'สายไฟ-NYY--4x1.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-11-01-01-03-01', label: 'สายไฟ-NYY--4x1.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-11-01-01-04-01', label: 'สายไฟ-NYY--4x1.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ ยาวตลอด-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-02-00-12-01-01-01-01', label: 'สายไฟ-NYY--2x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ ยาวตลอด-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-01-01', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-01-02', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-01-03', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-01-04', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-01-05', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-01-06', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-01-07', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-02-01', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-02-02', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-02-03', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-02-04', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-02-05', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-02-06', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-02-07', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-03-01', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-03-02', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-03-03', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-03-04', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-03-05', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-03-06', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-03-07', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-04-01', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-04-02', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-04-03', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-04-04', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-04-05', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-04-06', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-01-01-01-04-07', label: 'สายไฟ-NYY-G--3C 2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-01-01', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-01-02', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-01-03', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-01-04', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-01-05', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-01-06', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-01-07', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-02-01', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-02-02', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-02-03', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-02-04', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-02-05', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-02-06', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-02-07', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-03-01', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-03-02', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-03-03', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-03-04', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-03-05', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-03-06', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-03-07', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-04-01', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-04-02', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-04-03', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-04-04', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-04-05', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-04-06', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_NYY' },
  { code: '07RP-0106-03-00-02-01-01-04-07', label: 'สายไฟ-NYY-G--3x16/16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_NYY' },
  { code: '07RP-0106-04-00-01-01-01-01-01', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-01-02', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-01-03', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-01-04', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-01-05', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-01-06', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-01-07', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-02-01', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-02-02', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-02-03', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-02-04', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-02-05', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-02-06', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-02-07', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-03-01', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-03-02', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-03-03', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-03-04', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-03-05', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-03-06', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-03-07', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-04-01', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-04-02', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-04-03', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-04-04', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-04-05', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-04-06', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-01-01-01-04-07', label: 'สายไฟ-THW--1x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-01-01', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-01-02', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-01-03', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-01-04', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-01-05', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-01-06', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-01-07', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-02-01', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-02-02', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-02-03', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-02-04', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-02-05', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-02-06', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-02-07', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-03-01', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-03-02', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-03-03', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-03-04', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-03-05', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-03-06', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-03-07', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-04-01', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-04-02', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-04-03', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-04-05', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-04-06', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-01-04-07', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-01-01', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-01-02', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-01-03', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-01-04', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-01-05', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-01-06', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-01-07', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-02-01', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-02-02', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-02-03', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-02-04', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-02-05', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-02-06', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-02-07', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-03-01', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-03-02', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-03-03', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-03-04', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-03-05', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-03-06', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-03-07', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-04-01', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-04-02', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-04-03', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-04-04', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-04-05', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-04-06', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-02-04-07', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีเขียว-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-01-01', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-01-02', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-01-03', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-01-04', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-01-05', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-01-06', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-01-07', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-02-01', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-02-02', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-02-03', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-02-04', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-02-05', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-02-06', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-02-07', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-03-01', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-03-02', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-03-03', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-03-04', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-03-05', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-03-06', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-03-07', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-04-01', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-04-02', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-04-03', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-04-04', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-04-05', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-04-06', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-02-01-03-04-07', label: 'สายไฟ-THW--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-01-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-01-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-01-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-01-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-01-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-01-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-01-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-02-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-02-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-02-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-02-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-02-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-02-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-02-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-03-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-03-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-03-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-03-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-03-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-03-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-03-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-04-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-04-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-04-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-04-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-04-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-04-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-01-04-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีขาว-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-01-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-01-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-01-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-01-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-01-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-01-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-01-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-02-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-02-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-02-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-02-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-02-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-02-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-02-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-03-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-03-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-03-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-03-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-03-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-03-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-03-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-04-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-04-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-04-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-04-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-04-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-04-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-02-04-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-01-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-01-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-01-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-01-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-01-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-01-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-01-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-02-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-02-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-02-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-02-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-02-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-02-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-02-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-03-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-03-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-03-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-03-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-03-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-03-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-03-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-04-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-04-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-04-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-04-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-04-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-04-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-03-04-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-01-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-01-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-01-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-01-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-01-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-01-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-01-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-02-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-02-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-02-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-02-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-02-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-02-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-02-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-03-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-03-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-03-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-03-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-03-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-03-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-03-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-04-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-04-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-04-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-04-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-04-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-04-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-04-04-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-01-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-01-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-01-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-01-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-01-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-01-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-01-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-02-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-02-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-02-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-02-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-02-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-02-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-02-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-03-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-03-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-03-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-03-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-03-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-03-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-03-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-04-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-04-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-04-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-04-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-04-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-04-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-05-04-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีแดง-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-01-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-01-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-01-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-01-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-01-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-01-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-01-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-02-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-02-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-02-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-02-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-02-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-02-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-02-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-03-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-03-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-03-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-03-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-03-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-03-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-03-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-04-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-04-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-04-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-04-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-04-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-04-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-06-04-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีน้ำตาล-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-01-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-01-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-01-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-01-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-01-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-01-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-01-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-02-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-02-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-02-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-02-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-02-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-02-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-02-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-03-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-03-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-03-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-03-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-03-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-03-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-03-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-04-01', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-04-02', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-04-03', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-04-04', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-04-05', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-04-06', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-03-01-07-04-07', label: 'สายไฟ-THW--1x2.5mm-มาตรฐาน มอก.--สีฟ้า-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-01-01', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-01-02', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-01-03', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-01-04', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-01-05', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-01-06', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-01-07', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-02-01', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-02-02', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-02-03', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-02-04', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-02-05', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-02-06', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-02-07', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-03-01', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-03-02', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-03-03', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-03-04', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-03-05', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-03-06', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-03-07', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-04-01', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-04-02', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-04-03', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-04-04', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-04-05', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-04-06', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-04-00-04-01-01-04-07', label: 'สายไฟ-THW--1x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-04-00-05-01-01-01-01', label: 'สายไฟ-THW--2x1mm-มาตรฐาน มอก.--สีดำ-แดง-100เมตร/ม้วน-ยี่ห้อ SUN', group: 'wire_THW' },
  { code: '07RP-0106-04-00-05-01-01-02-01', label: 'สายไฟ-THW--2x1mm-มาตรฐาน มอก.--สีดำ-แดง-500เมตร/ม้วน-ยี่ห้อ SUN', group: 'wire_THW' },
  { code: '07RP-0106-04-00-05-01-01-03-01', label: 'สายไฟ-THW--2x1mm-มาตรฐาน มอก.--สีดำ-แดง-1000เมตร/ม้วน-ยี่ห้อ SUN', group: 'wire_THW' },
  { code: '07RP-0106-04-00-05-01-01-04-01', label: 'สายไฟ-THW--2x1mm-มาตรฐาน มอก.--สีดำ-แดง-ตัดเศษ-ยี่ห้อ SUN', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-01-01', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-01-02', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-01-03', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-01-04', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-01-05', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-01-06', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-01-07', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-02-01', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-02-02', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-02-03', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-02-04', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-02-05', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-02-06', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-02-07', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-03-01', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-03-02', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-03-03', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-03-04', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-03-05', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-03-06', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-03-07', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-04-01', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-04-02', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-04-03', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-04-04', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-04-05', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-04-06', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-05-00-01-01-01-04-07', label: 'สายไฟ-THW-A--1x16mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-01-01', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-01-02', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-01-03', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-01-04', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-01-05', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-01-06', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-01-07', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-02-01', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-02-02', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-02-03', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-02-04', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-02-05', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-02-06', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-02-07', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-03-01', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-03-02', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-03-03', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-03-04', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-03-05', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-03-06', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-03-07', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-04-01', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-04-02', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-04-03', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-04-04', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-04-05', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-04-06', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-05-00-02-01-01-04-07', label: 'สายไฟ-THW-A--1x2.5mm-มาตรฐาน มอก.--สีเขียว-เหลือง-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-01-01', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-01-02', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-01-03', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-01-04', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-01-05', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-01-06', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-01-07', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-02-01', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-02-02', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-02-03', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-02-04', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-02-05', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-02-06', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-02-07', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-03-01', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-03-02', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-03-03', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-03-04', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-03-05', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-03-06', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-03-07', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-04-01', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-04-02', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-04-03', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-04-04', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-04-05', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-04-06', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_THW' },
  { code: '07RP-0106-05-00-03-01-01-04-07', label: 'สายไฟ-THW-A--1x50mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_THW' },
  { code: '07RP-0106-06-00-01-01-01-01-01', label: 'สายไฟ-VAF--1x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ BANGKOK CABLE', group: 'wire_VAF' },
  { code: '07RP-0106-06-00-01-01-01-02-01', label: 'สายไฟ-VAF--1x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ BANGKOK CABLE', group: 'wire_VAF' },
  { code: '07RP-0106-06-00-01-01-01-03-01', label: 'สายไฟ-VAF--1x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ BANGKOK CABLE', group: 'wire_VAF' },
  { code: '07RP-0106-06-00-01-01-01-04-01', label: 'สายไฟ-VAF--1x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ BANGKOK CABLE', group: 'wire_VAF' },
  { code: '07RP-0106-07-00-01-01-01-01-01', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-01-02', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-01-03', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-01-04', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-01-05', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-01-06', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-01-07', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-02-01', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-02-02', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-02-03', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-02-04', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-02-05', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-02-06', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-02-07', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-03-01', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-03-02', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-03-03', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-03-04', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-03-05', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-03-06', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-03-07', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-04-01', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-04-02', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-04-03', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-04-04', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-04-05', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-04-06', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-01-01-01-04-07', label: 'สายไฟ-VCT--2x15mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-01-01', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-01-02', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-01-03', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-01-04', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-01-05', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-01-06', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-01-07', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-02-01', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-02-02', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-02-03', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-02-04', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-02-05', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-02-06', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-02-07', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-03-01', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-03-02', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-03-03', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-03-04', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-03-05', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-03-06', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-03-07', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-04-01', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-04-02', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-04-03', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-04-04', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-04-05', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-04-06', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-02-01-01-04-07', label: 'สายไฟ-VCT--2x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-01-01', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-01-02', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-01-03', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-01-04', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-01-05', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-01-06', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-01-07', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-02-01', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-02-02', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-02-03', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-02-04', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-02-05', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-02-06', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-02-07', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-03-01', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-03-02', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-03-03', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-03-04', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-03-05', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-03-06', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-03-07', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-04-01', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-04-02', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-04-03', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-04-04', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-04-05', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-04-06', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-03-01-01-04-07', label: 'สายไฟ-VCT--3x10mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-01-01', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-01-02', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-01-03', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-01-04', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-01-05', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-01-06', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-01-07', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-02-01', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-02-02', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-02-03', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-02-04', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-02-05', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-02-06', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-02-07', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-03-01', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-03-02', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-03-03', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-03-04', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-03-05', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-03-06', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-03-07', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-04-01', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-04-02', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-04-03', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-04-04', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-04-05', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-04-06', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-04-01-01-04-07', label: 'สายไฟ-VCT--3x1mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-01-01', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-01-02', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-01-03', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-01-04', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-01-05', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-01-06', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-01-07', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-02-01', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-02-02', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-02-03', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-02-04', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-02-05', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-02-06', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-02-07', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-03-01', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-03-02', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-03-03', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-03-04', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-03-05', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-03-06', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-03-07', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-04-01', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-04-02', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-04-03', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-04-04', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-04-05', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-04-06', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-05-01-01-04-07', label: 'สายไฟ-VCT--3x2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-01-01', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-01-02', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-01-03', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-01-04', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-01-05', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-01-06', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-01-07', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-02-01', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-02-02', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-02-03', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-02-04', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-02-05', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-02-06', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-02-07', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-03-01', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-03-02', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-03-03', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-03-04', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-03-05', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-03-06', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-03-07', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-04-01', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-04-02', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-04-03', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-04-04', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-04-05', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-04-06', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-06-01-01-04-07', label: 'สายไฟ-VCT--3x35mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-01-01', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-01-02', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-01-03', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-01-04', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-01-05', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-01-06', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-01-07', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-02-01', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-02-02', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-02-03', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-02-04', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-02-05', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-02-06', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-02-07', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-03-01', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-03-02', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-03-03', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-03-04', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-03-05', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-03-06', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-03-07', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-04-01', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-04-02', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-04-03', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-04-04', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-04-05', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-04-06', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-07-01-01-04-07', label: 'สายไฟ-VCT--4x1mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-01-01', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-01-02', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-01-03', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-01-04', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-01-05', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-01-06', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-01-07', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-02-01', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-02-02', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-02-03', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-02-04', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-02-05', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-02-06', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-02-07', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-03-01', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-03-02', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-03-03', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-03-04', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-03-05', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-03-06', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-03-07', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-04-01', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-04-02', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-04-03', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-04-04', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-04-05', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-04-06', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-07-00-08-01-01-04-07', label: 'สายไฟ-VCT--4x6mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-01-01', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-01-02', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-01-03', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-01-04', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-01-05', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-01-06', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-01-07', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-02-01', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-02-02', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-02-03', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-02-04', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-02-05', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-02-06', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-02-07', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-03-01', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-03-02', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-03-03', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-03-04', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-03-05', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-03-06', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-03-07', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-04-01', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ ENTERNAL CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-04-02', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ THAI UNION', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-04-03', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ S.SUPER CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-04-04', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-04-05', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ VENINE CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-04-06', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ TRIPLE N', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-01-01-01-04-07', label: 'สายไฟ-VCT-G--4x4/4mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ NATION CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-02-02-01-01-01', label: 'สายไฟ-VCT-G--2x2.5/2.5mm-มาตรฐาน มอก.--สีดำ-100เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-02-02-01-02-01', label: 'สายไฟ-VCT-G--2x2.5/2.5mm-มาตรฐาน มอก.--สีดำ-500เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-02-02-01-03-01', label: 'สายไฟ-VCT-G--2x2.5/2.5mm-มาตรฐาน มอก.--สีดำ-1000เมตร/ม้วน-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-0106-08-00-02-02-01-04-01', label: 'สายไฟ-VCT-G--2x2.5/2.5mm-มาตรฐาน มอก.--สีดำ-ตัดเศษ-ยี่ห้อ UNITED CABLE', group: 'wire_VCT' },
  { code: '07RP-014-00-00-01-00-00-00-00', label: 'แท่งกราวด์ทองแดง---ขนาด (5/8")16mmx2.4 เมตร-----', group: 'ground' },
  { code: '07RP-014-00-00-02-00-00-00-00', label: 'แท่งกราวด์ทองแดง---ขนาด (5/8")16mmx2.4 เมตร เชื่อมสาย + บาร์L ชุบกัลวาไนซ์-----', group: 'ground' },
  { code: '07RP-014-00-00-03-00-00-00-00', label: 'แท่งกราวด์ทองแดง---ขนาด (5/8")16mmx2.4 เมตร เชื่อมสาย+แหวน-----', group: 'ground' },
  { code: '07RP-014-00-00-04-00-00-00-00', label: 'แท่งกราวด์ทองแดง---ขนาด (5/8")16mmx2.4 เมตร เชื่อมสาย+หัวใจ-----', group: 'ground' },
  { code: '07RP-014-00-00-05-00-00-00-00', label: 'แท่งกราวด์ทองแดง---ขนาด (5/8")16mmx2.4 เมตร เชื่อมสายยาว 2 เมตร+เข้าหางปลาเบอร์ 16-----', group: 'ground' },
  { code: '07RP-014-00-00-06-00-00-00-00', label: 'แท่งกราวด์ทองแดง---ขนาด (5/8")16mmx2.4 เมตร เชื่อมสาย + บาร์Z ชุบกัลวาไนซ์-----', group: 'ground' },
  { code: '07RP-014-01-00-00-00-00-00-00', label: 'แท่งกราวด์ทองแดง-ชนิด Exothermic Welding-------', group: 'ground' },
  { code: '07RP-031-03-01-00-01-00-00-00', label: 'หางปลา-แบบแฉก เปลือย-ทองแดง--เบอร์ Y2.5-6----', group: 'lug' },
  { code: '07RP-031-03-01-00-02-00-00-00', label: 'หางปลา-แบบแฉก เปลือย-ทองแดง--เบอร์ Y2.5-5S----', group: 'lug' },
  { code: '07RP-031-05-01-00-01-00-00-01', label: 'หางปลา-ชนิดกลม รุ่นหนา ทรงยุโรป-ทองแดง--เบอร์ CL10-6----ยี่ห้อ T-LUG', group: 'lug' },
  { code: '07RP-031-08-01-00-01-00-00-01', label: 'หางปลา-แรงสูง 2รู-ทองแดง--เบอร์ HTL35-8----ยี่ห้อ T-LUG', group: 'lug' },
  { code: '07RP-037-13-01-01-00-00-00-00', label: 'นอต-สำหรับจับยึดเสาไฟ-เหล็กชุบกัลวาไนซ์-ขนาด 5/8" สกรูหัวสี่เหลี่ยม ยาว 14"(เกลียวขนาด6") ', group: 'bolt' },
  { code: '07RP-043-02-01-03-00-00-00-00', label: 'แคล้ม-ประกับรัดท่อ IMC-ชุบขาว SC-ขนาด 1-1/2"-----', group: 'clamp' },
  { code: '07RP-043-02-01-04-00-00-00-00', label: 'แคล้ม-ประกับรัดท่อ IMC-ชุบขาว SC-ขนาด 1-1/4"-----', group: 'clamp' },
  { code: '07RP-043-02-01-05-00-00-00-00', label: 'แคล้ม-ประกับรัดท่อ IMC-ชุบขาว SC-ขนาด 2"1/2', group: 'clamp' },
  { code: '07RP-043-03-01-01-00-00-00-00', label: 'แคล้ม-กราวด์ (U-Clamp)-ทองเหลือง-2สกรู 240-300-----', group: 'clamp' },
  { code: '07RP-044-01-01-00-01-00-00-01', label: 'สลิป-ข้อต่อสาย แบบย้ำเปลือย-ทองแดง--เบอร์ CSL 10x25mm----ยี่ห้อ T-LUG', group: 'sleeve' },
  { code: '07RP-044-01-01-00-02-00-00-01', label: 'สลิป-ข้อต่อสาย แบบย้ำเปลือย-ทองแดง--เบอร์ CSL 16x33mm----ยี่ห้อ T-LUG', group: 'sleeve' },
  { code: '07RP-044-01-01-00-03-00-00-01', label: 'สลิป-ข้อต่อสาย แบบย้ำเปลือย-ทองแดง--เบอร์ CSL 25x33mm----ยี่ห้อ T-LUG', group: 'sleeve' },
  { code: '07RP-044-01-01-00-04-00-00-01', label: 'สลิป-ข้อต่อสาย แบบย้ำเปลือย-ทองแดง--เบอร์ CSL 35x38mm----ยี่ห้อ T-LUG', group: 'sleeve' },
  { code: '07RP-045-01-01-01-00-00-00-00', label: 'คอนเนคเตอร์-ท่ออ่อน-เหล็กกันน้ำ สีเทา ขอบเหลือง-ขนาด 2"-----', group: 'connector' },
  { code: '07RP-045-01-01-02-00-00-00-00', label: 'คอนเนคเตอร์-ท่ออ่อน-เหล็กกันน้ำ สีเทา ขอบเหลือง-ขนาด 1/2"-----', group: 'connector' },
  { code: '07RP-045-01-01-03-00-00-00-00', label: 'คอนเนคเตอร์-ท่ออ่อน-เหล็กกันน้ำ สีเทา ขอบเหลือง-ขนาด 1-1/2"-----', group: 'connector' },
  { code: '07RP-045-01-01-04-00-00-00-00', label: 'คอนเนคเตอร์-ท่ออ่อน-เหล็กกันน้ำ สีเทา ขอบเหลือง-ขนาด 2-1/2"-----', group: 'connector' },
  { code: '07RP-046-01-02-02-00-00-00-00', label: 'รางซี C-Channel-แบบตื้น-ธรรมดา-ขนาด 25x40cm หนา 1.5mm ยาว 1.2m-----', group: 'channel' },
  { code: '07RP-057-02-01-01-00-01-00-00', label: 'ท่อ-ร้อยสายไฟ-HDPE-ขนาด 50mm--สี-ดำคาดแดง---', group: 'pipe' },
  { code: '07RP-057-02-02-01-00-00-00-00', label: 'ท่อ-ร้อยสายไฟ-ท่อเหล็กประปาคาดเหลือง-ขนาด 2" ยาว 6 เมตร-----', group: 'pipe' },
  { code: '07RP-057-02-03-01-00-00-00-00', label: 'ท่อ-ร้อยสายไฟ-IMC-ขนาด 1.1/4"-----', group: 'pipe' },
  { code: '07RP-057-02-03-02-00-00-00-00', label: 'ท่อ-ร้อยสายไฟ-IMC-ขนาด 1.1/2"-----', group: 'pipe' },
  { code: '07RP-057-02-03-03-00-00-00-00', label: 'ท่อ-ร้อยสายไฟ-IMC-ขนาด 2"', group: 'pipe' },
  { code: '07RP-057-04-01-01-00-00-00-01', label: 'ท่อ-RSC-เหล็กชุบกัลวาไนซ์-ขนาด 2" ยาว 3m-----ยี่ห้อ DAIWA', group: 'pipe' },
  { code: '07RP-057-04-01-02-00-00-00-01', label: 'ท่อ-RSC-เหล็กชุบกัลวาไนซ์-ขนาด 1/2" ยาว 3m-----ยี่ห้อ DAIWA', group: 'pipe' },
  { code: '07RP-057-04-01-03-00-00-00-01', label: 'ท่อ-RSC-เหล็กชุบกัลวาไนซ์-ขนาด 1-1/2" ยาว 3m-----ยี่ห้อ DAIWA', group: 'pipe' },
  { code: '07RP-057-04-01-04-00-00-00-01', label: 'ท่อ-RSC-เหล็กชุบกัลวาไนซ์-ขนาด 2-1/2" ยาว 3m-----ยี่ห้อ DAIWA', group: 'pipe' },
  { code: '07RP-057-04-01-05-00-00-00-00', label: 'ท่อ-RSC-เหล็กชุบกัลวาไนซ์-ขนาด 1" ยาว 3m-----', group: 'pipe' },
  { code: '07RP-064-01-00-01-00-00-00-00', label: 'ข้อ-งอ RSC--ขนาด 2 1/2"-----', group: 'pipe' },
  { code: '07RP-064-02-00-01-00-00-00-00', label: 'ข้อ-ต่อตรง RSC--ขนาด 2 1/2"-----', group: 'pipe' },
  { code: '07RP-042-011-01-01-01-00-01-01', label: 'ตู้-ควบคุมระบบไฟฟ้า ชนิด 1เฟส 2สาย เมน 100A-สแตนเลสกันน้ำ-ขนาด W400xH600XD250mm หนา 2mm-พร้อมชุดอุปกรณ์ สเปก ทช.---รับประกันสินค้า 2ปี-CCW', group: 'box' },
  { code: '07RP-042-05-01-02-01-00-01-01', label: 'ตู้-ควบคุมระบบไฟฟ้า ชนิด 1เฟส 2สาย 2 Circuit Main 2MAG 63A-ตู้เหล็กกันน้ำสีเหลือง-ขนาด W450xH600XD250mm หนา 2mm-พร้อมชุดอุปกรณ์ สเปก ทล.---รับประกันสินค้า 2ปี-CCW', group: 'box' },
];

// ── เช็คสต็อกการ์ดเรลทุกรหัส ──────────────────────────────────────────────────
export async function odooGuardrailStock(companyId) {
  const codes = GUARDRAIL_PRODUCTS.map(p => p.code);
  const ctx = companyId ? { allowed_company_ids: [companyId], company_id: companyId, force_company: companyId } : null;
  const rows = await searchRead('product.product', [['default_code', 'in', codes]],
    ['default_code', 'name', 'qty_available', 'uom_id'], codes.length + 5, ctx);
  const byCode = new Map();
  for (const r of rows) byCode.set(r.default_code, r);
  return GUARDRAIL_PRODUCTS.map(p => {
    const r = byCode.get(p.code);
    return { code: p.code, label: p.label, group: p.group, found: !!r,
      qty: r ? r.qty_available : null, uom: (r && Array.isArray(r.uom_id)) ? r.uom_id[1] : '' };
  });
}

// ── เช็คสต็อกอุปกรณ์ไฟฟ้า (batch 300 กัน timeout) ─────────────────────────────
export async function odooElectricalStock(companyId) {
  const ctx = companyId ? { allowed_company_ids: [companyId], company_id: companyId, force_company: companyId } : null;
  const byCode = new Map();
  const BATCH = 300;
  const allCodes = ELECTRICAL_PRODUCTS.map(p => p.code);
  for (let i = 0; i < allCodes.length; i += BATCH) {
    const chunk = allCodes.slice(i, i + BATCH);
    const rows = await searchRead('product.product', [['default_code', 'in', chunk]],
      ['default_code', 'name', 'qty_available', 'uom_id'], chunk.length + 5, ctx);
    for (const r of rows) byCode.set(r.default_code, r);
  }
  return ELECTRICAL_PRODUCTS.map(p => {
    const r = byCode.get(p.code);
    return { code: p.code, label: p.label, group: p.group, found: !!r,
      qty: r ? r.qty_available : null, uom: (r && Array.isArray(r.uom_id)) ? r.uom_id[1] : '' };
  });
}

// ── ดึงรายละเอียดเอกสาร + รูป สำหรับ /รายงาน ─────────────────────────────────
export async function odooDocDetail(model, id) {
  let doc = {};
  if (model === 'purchase.order') {
    const rows = await searchRead('purchase.order', [['id','=',id]],
      ['name','partner_id','date_order','amount_total','notes','order_line','company_id'], 1);
    if (!rows.length) return null;
    const r = rows[0];
    // ดึงยอดสั่ง + รับแล้ว ต่อ line เพื่อคำนวณค้างรับ
    const lines = await searchRead('purchase.order.line', [['order_id','=',id]],
      ['product_id','name','product_qty','qty_received','product_uom'], 50);
    // แปลง notes HTML → plain text
    const rawNote = (r.notes && typeof r.notes === 'string') ? r.notes : '';
    const noteClean = rawNote.replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
    // สรุปยอดค้างรับรวม — กรองสินค้าที่ตั้งใจไม่นับ (ค่าบริการ ฯลฯ) ออกก่อน
    // ให้สูตรเดียวกับ odooReceiveDeliveryStatus เป๊ะๆ กันตัวเลขขัดกัน (เคยมีบั๊ก: บอก
    // "ค้าง 9" แต่สถานะข้างบนบอก "รับครบ" เพราะคนละสูตรกัน — ตอนนี้ใช้สูตรเดียวกันแล้ว)
    let totalOrdered = 0, totalReceived = 0;
    const linesMapped = [];
    for (const l of lines) {
      const prodName = Array.isArray(l.product_id) ? l.product_id[1] : (l.name || '');
      if (isIgnoredProduct(prodName)) continue;  // ข้ามค่าบริการเหมือน odooReceiveDeliveryStatus
      const ordered  = l.product_qty  || 0;
      const received = l.qty_received || 0;
      if (ordered <= 0) continue;
      const remain   = Math.max(0, ordered - received);
      totalOrdered  += ordered;
      totalReceived += received;
      linesMapped.push({
        name: prodName, qty: ordered, received, remain,
        uom: Array.isArray(l.product_uom) ? l.product_uom[1] : ''
      });
    }
    const totalRemain = Math.max(0, totalOrdered - totalReceived);
    // ชื่องาน + วันรับจริง จาก picking ที่ผูกกับ PO นี้ (ผ่าน purchase_id — แม่นตาม PO id)
    //   วันรับจริง = scheduled_date ของใบรับ (ผู้ใช้ตั้งเป็นวันจริง) ไม่ใช่วันเปิด PO
    let jobName = '', deliverDate = '';
    try {
      const picks = await searchRead('stock.picking', [['purchase_id', '=', id]],
        ['group_id', 'scheduled_date'], 5);
      const g = (picks || []).find(pk => Array.isArray(pk.group_id));
      if (g) jobName = g.group_id[1];
      const pk = (picks || []).find(pk => pk.scheduled_date);
      if (pk) deliverDate = String(pk.scheduled_date || '').slice(0, 10);
    } catch (e) { /* ไม่มี field/โมดูล → ข้าม */ }
    // เลขที่ PR + ผู้ขอ + วัตถุประสงค์ (ต้นทางก่อนเป็น PO) — กรองบริษัทเดียวกับ PO
    const poCoId = Array.isArray(r.company_id) ? r.company_id[0] : r.company_id;
    const { prName, prBy, prPurpose } = await lookupPrForPO(r.order_line, id, poCoId);
    doc = {
      name: 'PO ' + r.name,
      partner: Array.isArray(r.partner_id) ? r.partner_id[1] : '', partnerLabel: 'ผู้ขาย',
      date: deliverDate || String(r.date_order || '').slice(0,10), total: r.amount_total || 0,
      poNote: noteClean, jobName,
      prName, prBy, prPurpose,
      totalOrdered, totalReceived, totalRemain,
      lines: linesMapped
    };
  } else if (model === 'sale.order') {
    const rows = await searchRead('sale.order', [['id','=',id]], ['name','partner_id','date_order','amount_total'], 1);
    if (!rows.length) return null;
    const r = rows[0];
    const lines = await searchRead('sale.order.line', [['order_id','=',id]], ['product_id','name','product_uom_qty','product_uom'], 50);
    // ชื่องาน + วันส่งจริง จาก picking ที่ผูกกับ SO นี้ (ผ่าน sale_id) — ไม่ใช่วันเปิด SO
    let jobName = '', deliverDate = '';
    try {
      const picks = await searchRead('stock.picking', [['sale_id','=',id]],
        ['group_id','scheduled_date'], 5);
      const g = (picks || []).find(pk => Array.isArray(pk.group_id));
      if (g) jobName = g.group_id[1];
      const pk = (picks || []).find(pk => pk.scheduled_date);
      if (pk) deliverDate = String(pk.scheduled_date || '').slice(0,10);
    } catch (e) { /* ไม่มี field sale_id → ข้าม */ }
    doc = { name: 'SO ' + r.name, partner: Array.isArray(r.partner_id) ? r.partner_id[1] : '', partnerLabel: 'ลูกค้า',
      date: deliverDate || String(r.date_order || '').slice(0,10), total: r.amount_total || 0, jobName,
      lines: lines.map(l => ({ name: Array.isArray(l.product_id) ? l.product_id[1] : (l.name || ''), qty: l.product_uom_qty || 0, uom: Array.isArray(l.product_uom) ? l.product_uom[1] : '' })) };
  } else if (model === 'purchase.request') {
    const rows = await searchRead('purchase.request', [['id','=',id]], ['name','requested_by','date_start'], 1);
    if (!rows.length) return null;
    const r = rows[0];
    const lines = await searchRead('purchase.request.line', [['request_id','=',id]], ['product_id','name','product_qty','product_uom_id'], 50);
    doc = { name: 'PR ' + r.name, partner: Array.isArray(r.requested_by) ? r.requested_by[1] : '', partnerLabel: 'ผู้ขอ',
      date: String(r.date_start || '').slice(0,10), total: 0,
      lines: lines.map(l => ({ name: Array.isArray(l.product_id) ? l.product_id[1] : (l.name || ''), qty: l.product_qty || 0, uom: Array.isArray(l.product_uom_id) ? l.product_uom_id[1] : '' })) };
  } else if (model === 'mrp.production') {
    const rows = await searchRead('mrp.production', [['id','=',id]], ['name','product_id','product_qty','product_uom_id','date_start','origin','state'], 1);
    if (!rows.length) return null;
    const r = rows[0];
    const prodName = Array.isArray(r.product_id) ? r.product_id[1] : '';
    const prodUom = Array.isArray(r.product_uom_id) ? r.product_uom_id[1] : '';
    // ดึงวัตถุดิบ (components) ของ MO — กันชื่อ field เปลี่ยนตามเวอร์ชันด้วย try/catch
    let comps = [];
    try {
      comps = await searchRead('stock.move', [['raw_material_production_id','=',id]], ['product_id','product_uom_qty','quantity','product_uom'], 50);
    } catch(e) { comps = []; }
    doc = {
      name: 'MO ' + r.name, partner: prodName, partnerLabel: 'สินค้าที่ผลิต',
      origin: r.origin || '',
      date: String(r.date_start || '').slice(0,10), total: 0,
      lines: [{ name: '🏭 ' + prodName + ' (ผลิต)', qty: r.product_qty || 0, uom: prodUom }].concat(
        comps.map(l => ({ name: Array.isArray(l.product_id) ? l.product_id[1] : '', qty: l.product_uom_qty || l.quantity || 0, uom: Array.isArray(l.product_uom) ? l.product_uom[1] : '' }))
      )
    };
  } else { return null; }
  // ── ดึง Source/origin แบบปลอดภัย (po/so/mo มี field นี้, บาง model อาจไม่มี → ข้าม) ──
  // mrp ตั้งค่า doc.origin ไว้แล้ว จึงข้ามการ fetch ซ้ำ
  if (doc.origin === undefined) {
    try {
      const oRows = await searchRead(model, [['id', '=', id]], ['origin'], 1);
      if (oRows && oRows[0] && oRows[0].origin) doc.origin = oRows[0].origin;
    } catch (e) { /* model นี้ไม่มี field origin → ข้าม */ }
  }
  try {
    const atts = await searchRead('ir.attachment',
      ['&','&',['res_model','=',model],['res_id','=',id],['mimetype','ilike','image']], ['id','name'], 50);
    doc.images = (atts || []).map(a => ({ id: a.id, name: a.name || 'image' }));
  } catch(e) { doc.images = []; }
  return doc;
}

// ── ดึง stock.move ที่เพิ่งทำเสร็จ (done) หลัง sinceIso — ทุกการเคลื่อนไหวสต็อก ──
export async function odooRecentStockMoves(sinceIso, companyIds) {
  // ใช้ OR ระหว่าง write_date กับ date (effective date / date_done) เพราะ
  // picking ที่ backdate จะมี write_date เป็นวันเก่า แต่ date จะเป็นเวลา Done จริง
  // ทำให้ไม่ตกหล่นเมื่อกรองด้วย write_date > lastCheck เพียงอย่างเดียว
  // domain ต้องเป็น Polish notation แบบ "แบน" — ห้ามครอบ ['|', ...] เป็นวงเล็บซ้อน
  // ไม่งั้น Odoo อ่าน '|' เป็นชื่อฟิลด์ → error "Invalid field stock.move.|"
  // '&' ( state=done , '|' ( write_date>since , date>since ) )
  let domain = ['&',
    ['state', '=', 'done'],
    '|', ['write_date', '>', sinceIso], ['date', '>', sinceIso]
  ];
  if (Array.isArray(companyIds) && companyIds.length) {
    domain = ['&', ['company_id', 'in', companyIds], ...domain];
  }
  const fields = ['id', 'reference', 'origin', 'partner_id', 'product_id', 'product_uom_qty', 'product_uom',
    'location_id', 'location_dest_id', 'write_uid', 'create_uid', 'company_id', 'picking_id', 'date', 'scrapped'];
  let rows = [];
  try {
    // เรียงใหม่สุดก่อน (date desc) + limit สูง — กันรายการล่าสุด (เช่น ปรับยอด/ตัดออก)
    // โดนตัดทิ้งเมื่อมี move เยอะในช่วงที่ query (โดยเฉพาะตอน cron ดีเลย์นานๆ)
    rows = await searchRead('stock.move', domain, fields, 300, null, 'date desc, id desc');
  } catch (e) {
    return { error: e.message, moves: [] };
  }
  if (!rows.length) return { moves: [] };

  const locIds = new Set();
  rows.forEach(r => {
    if (Array.isArray(r.location_id)) locIds.add(r.location_id[0]);
    if (Array.isArray(r.location_dest_id)) locIds.add(r.location_dest_id[0]);
  });
  const locUsage = {};
  if (locIds.size) {
    try {
      const locs = await searchRead('stock.location', [['id', 'in', [...locIds]]], ['id', 'usage'], 200);
      for (const l of locs) locUsage[l.id] = l.usage;
    } catch (e) { /* ใช้ usage ว่าง */ }
  }

  const uidSet = [...new Set(rows.flatMap(r => [
    Array.isArray(r.write_uid)  ? r.write_uid[0]  : null,
    Array.isArray(r.create_uid) ? r.create_uid[0] : null
  ]).filter(Boolean))];
  const userMap = {};
  if (uidSet.length) {
    try {
      const users = await searchRead('res.users', [['id', 'in', uidSet]], ['id', 'name', 'login'], 50);
      for (const u of users) userMap[u.id] = { name: u.name, login: u.login };
    } catch (e) { /* ใช้ name จาก write_uid */ }
  }

  const pickIds = [...new Set(rows.map(r => Array.isArray(r.picking_id) ? r.picking_id[0] : null).filter(Boolean))];
  const pickPartner = {}, pickOrigin = {};
  if (pickIds.length) {
    try {
      const picks = await searchRead('stock.picking', [['id', 'in', pickIds]], ['id', 'partner_id', 'origin'], 200);
      for (const p of picks) {
        pickPartner[p.id] = Array.isArray(p.partner_id) ? p.partner_id[1] : '';
        pickOrigin[p.id] = p.origin || '';
      }
    } catch (e) { /* ใช้ partner จาก move แทน */ }
  }

  const allOrigins = [...new Set(Object.values(pickOrigin).filter(Boolean))];
  const originPartner = {}, originNote = {};
  if (allOrigins.length) {
    try {
      const pos = await searchRead('purchase.order', [['name', 'in', allOrigins]], ['name', 'partner_id', 'notes'], 200);
      for (const po of pos) {
        originPartner[po.name] = Array.isArray(po.partner_id) ? po.partner_id[1] : '';
        const rawNote = (po.notes && typeof po.notes === 'string') ? po.notes : '';
        originNote[po.name] = rawNote.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      }
      const stillEmpty = allOrigins.filter(o => !originPartner[o] && !originNote[o]);
      if (stillEmpty.length) {
        const sos = await searchRead('sale.order', [['name', 'in', stillEmpty]], ['name', 'partner_id', 'note'], 200);
        for (const so of sos) {
          originPartner[so.name] = Array.isArray(so.partner_id) ? so.partner_id[1] : '';
          const rawNote = (so.note && typeof so.note === 'string') ? so.note : '';
          originNote[so.name] = rawNote.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        }
      }
    } catch (e) { /* ปล่อยว่าง */ }
  }

  const moves = [];
  for (const r of rows) {
    const srcId = Array.isArray(r.location_id) ? r.location_id[0] : null;
    const destId = Array.isArray(r.location_dest_id) ? r.location_dest_id[0] : null;
    const srcUsage = locUsage[srcId] || '';
    const destUsage = locUsage[destId] || '';

    // คำนวณ direction ให้ครอบคลุมทุกกรณี — ไม่ข้ามเลยแม้แต่ internal→internal
    // เพราะเจ้าของต้องการทราบทุกการเคลื่อนไหวที่ไม่ใช่ Store1 ทำ
    let direction;
    if (r.scrapped) {
      direction = 'scrap';                                          // scrap ออก
    } else if (destUsage === 'internal' && srcUsage !== 'internal') {
      direction = 'in';                                             // รับเข้าคลัง
    } else if (srcUsage === 'internal' && destUsage !== 'internal') {
      direction = 'out';                                            // ตัดออก/ส่งลูกค้า
    } else if (srcUsage === 'internal' && destUsage === 'internal') {
      direction = 'transfer';                                       // โอนระหว่างคลัง / ปรับยอด
    } else if (srcUsage === 'inventory' || destUsage === 'inventory') {
      direction = destUsage === 'inventory' ? 'adjust_out' : 'adjust_in'; // ปรับยอด inventory
    } else {
      direction = 'other';                                          // อื่นๆ (เช่น supplier→customer)
    }

    // ข้ามสินค้าที่ไม่ต้องแจ้งเตือน (ค่าบริการ 11RS ฯลฯ)
    const prodName = Array.isArray(r.product_id) ? r.product_id[1] : '';
    if (isIgnoredProduct(prodName)) continue;
    const wuid = Array.isArray(r.write_uid) ? r.write_uid[0] : null;
    const wname = Array.isArray(r.write_uid) ? r.write_uid[1] : '';
    const u = wuid && userMap[wuid] ? userMap[wuid] : {};
    // create_uid = คนสร้าง move (ค่านี้ไม่ถูก process อื่นเขียนทับเหมือน write_uid)
    const cuid = Array.isArray(r.create_uid) ? r.create_uid[0] : null;
    const cname = Array.isArray(r.create_uid) ? r.create_uid[1] : '';
    const cu = cuid && userMap[cuid] ? userMap[cuid] : {};
    const pkId = Array.isArray(r.picking_id) ? r.picking_id[0] : null;
    const pkOrigin = pkId ? pickOrigin[pkId] : '';
    const partnerName =
      (Array.isArray(r.partner_id) ? r.partner_id[1] : '') ||
      (pkId ? pickPartner[pkId] : '') ||
      (pkOrigin ? originPartner[pkOrigin] : '') || '';
    const noteText = pkOrigin ? (originNote[pkOrigin] || '') : '';
    moves.push({
      id: r.id, ref: r.reference || '', origin: r.origin || '',
      partner: partnerName, note: noteText,
      product: Array.isArray(r.product_id) ? r.product_id[1] : '',
      qty: r.product_uom_qty || 0,
      uom: Array.isArray(r.product_uom) ? r.product_uom[1] : '',
      write_user: u.name || wname || '', write_login: u.login || '',
      create_user: cu.name || cname || '', create_login: cu.login || '',
      company: Array.isArray(r.company_id) ? r.company_id[1] : '',
      companyId: Array.isArray(r.company_id) ? r.company_id[0] : null,
      direction, srcUsage, destUsage,
      picking: Array.isArray(r.picking_id) ? r.picking_id[1] : '',
      scrapped: r.scrapped === true, date: r.date || ''
    });
  }
  return { moves };
}

// ── ตรวจ Vendor Bill ที่จ่าย/วางบิลแล้ว แต่ของยังรับเข้าไม่ครบ ─────────────────
// แจ้งเตือนปัญหา "จ่ายเงินแล้วแต่ยังไม่ได้ทำ GR รับเข้า"
export async function odooBilledNotReceived(sinceIso, companyIds) {
  let domain = ['&', '&', '&',
    ['move_type', '=', 'in_invoice'],
    ['state', '=', 'posted'],
    ['write_date', '>', sinceIso],
    ['invoice_origin', '!=', false]
  ];
  if (Array.isArray(companyIds) && companyIds.length) {
    domain = ['&', ['company_id', 'in', companyIds], ...domain];
  }
  const fields = ['id', 'name', 'invoice_origin', 'partner_id', 'amount_total',
    'payment_state', 'company_id', 'invoice_date', 'write_date'];
  let bills = [];
  try {
    bills = await searchRead('account.move', domain, fields, 30);
  } catch (e) {
    try {
      bills = await searchRead('account.move', domain,
        ['id', 'name', 'invoice_origin', 'partner_id', 'amount_total', 'payment_state', 'company_id'], 30);
    } catch (e2) {
      return { error: e2.message, bills: [] };
    }
  }
  if (!bills || !bills.length) return { bills: [] };

  const allPoNames = new Set();
  const billPoNames = {};
  for (const b of bills) {
    const origin = String(b.invoice_origin || '');
    const names = origin.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    billPoNames[b.id] = names;
    names.forEach(n => allPoNames.add(n));
  }

  // key = "companyId|poName" — กันเลข PO ซ้ำข้ามบริษัท (แต่ละบริษัทมี running number ของตัวเอง)
  //   บิลจะจับคู่เฉพาะ PO บริษัทเดียวกันเท่านั้น (ไม่งั้นจับผิดใบ แจ้งมั่ว)
  const poByKey = {};
  if (allPoNames.size) {
    try {
      const pos = await searchRead('purchase.order',
        [['name', 'in', [...allPoNames]]], ['id', 'name', 'order_line', 'company_id'], 200);
      const allLineIds = [];
      for (const po of pos) (po.order_line || []).forEach(id => allLineIds.push(id));
      let lineMap = {};
      if (allLineIds.length) {
        const lines = await searchRead('purchase.order.line',
          [['id', 'in', allLineIds]],
          ['id', 'product_qty', 'qty_received', 'product_id', 'product_uom'], 500);
        for (const l of lines) lineMap[l.id] = l;
      }
      for (const po of pos) {
        let ordered = 0, received = 0;
        const missingLines = [];
        for (const lid of (po.order_line || [])) {
          const l = lineMap[lid];
          if (l) {
            const prodName = Array.isArray(l.product_id) ? l.product_id[1] : '';
            // ข้ามค่าบริการ — ไม่นับ ไม่แจ้งเตือน
            if (isIgnoredProduct(prodName)) continue;
            const lo = l.product_qty || 0, lr = l.qty_received || 0;
            ordered += lo; received += lr;
            if (lo - lr > 0.0001) {
              missingLines.push({
                product: prodName,
                ordered: lo, received: lr, missing: lo - lr,
                uom: Array.isArray(l.product_uom) ? l.product_uom[1] : ''
              });
            }
          }
        }
        const poCoId = Array.isArray(po.company_id) ? po.company_id[0] : (po.company_id || 0);
        poByKey[poCoId + '|' + po.name] = { ordered, received, missingLines };
      }
    } catch (e) { /* ดึงไม่ได้ ปล่อยว่าง */ }
  }

  const paidLabelMap = {
    'paid': '💸 จ่ายเงินแล้ว (PAID)',
    'in_payment': '💸 อยู่ระหว่างจ่าย (In Payment)',
    'partial': '💸 จ่ายบางส่วน (Partial)',
    'not_paid': '📋 วางบิลแล้ว (ยังไม่จ่าย)',
    'reversed': '↩️ กลับรายการ'
  };
  const result = [];
  for (const b of bills) {
    const names = billPoNames[b.id] || [];
    const billCoId = Array.isArray(b.company_id) ? b.company_id[0] : (b.company_id || 0);
    let ordered = 0, received = 0, foundPo = false;
    let missingLines = [];
    for (const n of names) {
      // จับเฉพาะ PO ที่บริษัทตรงกับบิล (กันเลข PO ซ้ำข้ามบริษัท)
      const rec = poByKey[billCoId + '|' + n];
      if (rec) {
        ordered += rec.ordered;
        received += rec.received;
        if (Array.isArray(rec.missingLines)) missingLines = missingLines.concat(rec.missingLines);
        foundPo = true;
      }
    }
    if (!foundPo) continue;
    const missing = ordered - received;
    if (missing <= 0.0001) continue;
    // ถ้าหลังกรองค่าบริการแล้วไม่เหลือรายการค้างจริง → ไม่แจ้ง
    if (!missingLines.length) continue;

    result.push({
      id: b.id,
      name: b.name || '-',
      po: names.join(', '),
      partner: Array.isArray(b.partner_id) ? b.partner_id[1] : '',
      amount: b.amount_total || 0,
      paymentState: b.payment_state || '',
      paidLabel: paidLabelMap[b.payment_state] || ('สถานะ: ' + b.payment_state),
      ordered, received, missing,
      missingLines,
      company: Array.isArray(b.company_id) ? b.company_id[1] : '',
      date: b.invoice_date || String(b.write_date || '').slice(0, 10)
    });
  }
  return { bills: result };
}

// ── เช็คสถานะการรับ/ส่งจาก origin ของใบส่งของ (กันคีย์จำนวนผิด) ───────────────
//   origin เป็น PO → เทียบ product_qty vs qty_received (รับเข้าครบไหม)
//   origin เป็น SO → เทียบ product_uom_qty vs qty_delivered (ส่งออกครบไหม)
//   คืน: { type:'po'|'so'|null, complete:bool, lines:[{product, ordered, done, remain, uom}], totalRemain }
export async function odooReceiveDeliveryStatus(origin, companyId) {
  const raw = String(origin || '').trim();
  if (!raw) return { type: null, found: false };
  // มี 4 บริษัท เลข PO/SO ซ้ำข้ามบริษัทได้ → กรองตามบริษัทของใบงาน (ถ้าส่งมา)
  const coId = Array.isArray(companyId) ? companyId[0] : companyId;

  // origin อาจมีหลายเลข (เช่น "P2606044, P2606050") → แยกเอาเลขแรกที่เจอ
  // ข้าม token ที่ไม่มีตัวเลขเลย (เช่น "PO", "SO", "MO" ที่หลุดมาจาก caller ที่ลืมตัด
  // คำนำหน้าออก) — ป้องกัน ilike จับ PO/SO ใบอื่นที่ชื่อดันมีคำเหล่านี้ปนอยู่แบบผิดใบ
  const rawTokens = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  const tokens = [];
  for (const t of rawTokens) {
    if (/\d/.test(t) && !tokens.includes(t)) tokens.push(t);
    // เลข PO/SO มักอยู่ส่วนหน้าก่อน "/" เช่น "2605018/0454030" → PO คือ "2605018"
    // เพิ่มส่วนหน้าเป็นตัวเลือกค้นเพิ่ม (ลองของเต็มก่อน แล้วค่อย fallback เป็นเลขหน้า)
    if (t.includes('/')) {
      const head = t.split('/')[0].trim();
      if (head && /\d/.test(head) && !tokens.includes(head)) tokens.push(head);
    }
  }

  // ลองหา PO ก่อน (รับเข้า)
  for (const tok of tokens) {
    try {
      const pos = await searchRead('purchase.order',
        withCompany(['|', ['name', '=', tok], ['name', 'ilike', tok]], coId),
        ['id', 'name', 'order_line', 'notes', 'partner_id'], 3);
      if (pos.length) {
        const po = pos[0];
        const vendor = Array.isArray(po.partner_id) ? po.partner_id[1] : '';
        const poNote = String(po.notes && typeof po.notes === 'string' ? po.notes : '')
          .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        const lines = await searchRead('purchase.order.line',
          [['order_id', '=', po.id]],
          ['product_id', 'product_qty', 'qty_received', 'product_uom'], 200);
        const detail = [];
        let totalRemain = 0;
        for (const l of lines) {
          const prodName = Array.isArray(l.product_id) ? l.product_id[1] : '';
          if (isIgnoredProduct(prodName)) continue;  // ข้ามค่าบริการ
          const ordered = l.product_qty || 0;
          const done = l.qty_received || 0;
          const remain = ordered - done;
          if (ordered > 0) {
            detail.push({
              product: prodName,
              ordered, done, remain,
              uom: Array.isArray(l.product_uom) ? l.product_uom[1] : ''
            });
            if (remain > 0.0001) totalRemain += remain;
          }
        }
        // ── ดึง PR ที่ผูกกับ PO นี้ (เลขที่ PR + ผู้ขอ + วัตถุประสงค์) — OCA purchase_request ──
        const { prName, prBy, prPurpose } = await lookupPrForPO(po.order_line, po.id, coId);

        return {
          type: 'po', found: true, docName: po.name,
          complete: totalRemain <= 0.0001,
          lines: detail, totalRemain,
          remainLines: detail.filter(d => d.remain > 0.0001),
          // วัตถุประสงค์: ใช้จาก PR ก่อน (ตรงกับที่ผู้ใช้กรอกตอนขอซื้อ) ไม่มีค่อย fallback หมายเหตุ PO
          note: prPurpose || poNote, prName, prBy, vendor
        };
      }
    } catch (e) { /* ลอง token ถัดไป */ }
  }

  // ไม่เจอ PO → ลองหา SO (ส่งออก)
  for (const tok of tokens) {
    try {
      const sos = await searchRead('sale.order',
        withCompany(['|', ['name', '=', tok], ['name', 'ilike', tok]], coId),
        ['id', 'name', 'order_line', 'note', 'partner_id'], 3);
      if (sos.length) {
        const so = sos[0];
        const vendor = Array.isArray(so.partner_id) ? so.partner_id[1] : '';  // SO = ลูกค้า
        const soNote = String(so.note && typeof so.note === 'string' ? so.note : '')
          .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        const lines = await searchRead('sale.order.line',
          [['order_id', '=', so.id]],
          ['product_id', 'product_uom_qty', 'qty_delivered', 'product_uom'], 200);
        const detail = [];
        let totalRemain = 0;
        for (const l of lines) {
          const prodName = Array.isArray(l.product_id) ? l.product_id[1] : '';
          if (isIgnoredProduct(prodName)) continue;  // ข้ามค่าบริการ
          const ordered = l.product_uom_qty || 0;
          const done = l.qty_delivered || 0;
          const remain = ordered - done;
          if (ordered > 0) {
            detail.push({
              product: prodName,
              ordered, done, remain,
              uom: Array.isArray(l.product_uom) ? l.product_uom[1] : ''
            });
            if (remain > 0.0001) totalRemain += remain;
          }
        }
        return {
          type: 'so', found: true, docName: so.name,
          complete: totalRemain <= 0.0001,
          lines: detail, totalRemain,
          remainLines: detail.filter(d => d.remain > 0.0001),
          note: soNote, vendor
        };
      }
    } catch (e) { /* ลอง token ถัดไป */ }
  }

  return { type: null, found: false };
}

// ── ค้น Manufacturing Order (MO) จาก mrp.production ─────────────────────────
// keyword: เลข MO (SET/MO/00002), ชื่อสินค้า, หรือ origin (SO/PO ต้นทาง)
export async function odooMO(keyword, companyId) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  // เพิ่มคำค้นแบบเลขล้วน (เผื่อพิมพ์ "244" แต่เลขจริงเก็บเป็น "00244")
  const numMatch = kw.match(/(\d+)$/);
  const altKw = (numMatch && numMatch[1] !== kw) ? numMatch[1].padStart(5, '0') : null;
  const domain = withCompany(
    altKw
    ? ['|', '|', '|', '|',
        ['name', 'ilike', kw], ['name', 'ilike', altKw],
        ['product_id.name', 'ilike', kw],
        ['product_id.default_code', 'ilike', kw],
        ['origin', 'ilike', kw]
      ]
    : ['|', '|', '|',
        ['name', 'ilike', kw],
        ['product_id.name', 'ilike', kw],
        ['product_id.default_code', 'ilike', kw],
        ['origin', 'ilike', kw]
      ], companyId
  );
  const fields = ['name', 'product_id', 'product_qty', 'product_uom_id', 'state', 'date_start', 'date_finished', 'origin', 'company_id'];
  let rows = [];
  try { rows = await searchRead('mrp.production', domain, fields, 20); } catch (e) {
    // fallback ค้นแค่ name กับ origin (กันกรณี relational field พัง)
    try {
      rows = await searchRead('mrp.production',
        withCompany(['|', ['name', 'ilike', kw], ['origin', 'ilike', kw]], companyId),
        fields, 20);
    } catch (e2) {}
  }
  if (!rows.length) return [];

  // เรียง: ตรงสุดมาก่อน (name match), ล่าสุดมาก่อน
  const kwL = kw.toLowerCase();
  rows.sort((a, b) => {
    const aName = String(a.name || '').toLowerCase();
    const bName = String(b.name || '').toLowerCase();
    const aEx = aName === kwL || aName.includes(kwL) ? 1 : 0;
    const bEx = bName === kwL || bName.includes(kwL) ? 1 : 0;
    if (aEx !== bEx) return bEx - aEx;
    return (b.id || 0) - (a.id || 0);
  });

  const stateMap = { draft: 'แบบร่าง', confirmed: 'ยืนยันแล้ว', progress: 'กำลังผลิต', to_close: 'รอปิด', done: 'Done ✅', cancel: 'ยกเลิก ❌' };
  return rows.map(r => ({
    id: r.id,
    name: r.name || '',
    product: Array.isArray(r.product_id) ? r.product_id[1] : (r.product_id || ''),
    qty: r.product_qty || 0,
    uom: Array.isArray(r.product_uom_id) ? r.product_uom_id[1] : (r.product_uom_id || ''),
    state: r.state || '',
    stateLabel: stateMap[r.state] || r.state || '-',
    dateStart: r.date_start ? String(r.date_start).slice(0, 10) : '',
    dateEnd: r.date_finished ? String(r.date_finished).slice(0, 10) : '',
    origin: r.origin || '',
    company: Array.isArray(r.company_id) ? r.company_id[1] : (r.company_id || '')
  }));
}
