// ════════════════════════════════════════════════════════════════════════════
//  อ่าน "ตารางแจ้งสินค้าเข้า/ส่งของ" (Excel / รูป / PDF) — แยกเป็นกลุ่มตาม (PO, วันที่ส่ง)
//  ใช้ร่วมกัน: กลุ่มฝ่ายจัดซื้อ (Telegram) + กลุ่ม SET (LINE, reply ไฟล์)
//  โมดูลนี้ไม่ผูกกับ db/แพลตฟอร์ม — คืน [{ po, dateISO, dateRaw, supplier, lines:[{product,qty,unit}] }]
// ════════════════════════════════════════════════════════════════════════════

// ── เดาหมวดหมู่จากชื่อสินค้า (ใช้ร่วมกับ Telegram) ──
const CATEGORY_GUESS = [
  [/การ์ดเรล|การ์ดเลล|guard\s?rail|w[-\s]?beam|ราวกัน|แผ่นอ่อน|เสาการ์ด/i, 'งานการ์ดเรล'],
  [/ชุบ|กัลวาไนซ์|กัลวาไนช์|galvani|hot[-\s]?dip|\bhdg\b/i,               'บริการชุบกัลวาไนซ์'],
  [/mast\s?arm|มาสต์|แขนโคม|แขนเสา/i,                                      'งาน mast arm'],
  [/ซิลิกัล|ซิลิก้า|silical|silica/i,                                       'ซิลิกัล'],
  [/ป้าย.{0,6}เฟรม|เฟรม.{0,6}ป้าย/i,                                       'งานป้าย+เฟรม'],
  [/เฟรม|\bframe\b/i,                                                       'งานเฟรม'],
  [/ป้าย|ไวนิล|สติ๊กเกอร์|สติกเกอร์|sticker|\bsign\b|แผ่นสะท้อน/i,          'งานป้าย'],
  [/เสาไฟ|เสาสูง|เสากิ่ง|โคมไฟถนน|street\s?light|\bpole\b/i,               'งานเสาไฟฟ้า'],
  [/รากฐาน|ฐานราก|foundation|เข็ม|เสาเข็ม|base\s?plate|คอนกรีต|ปูน|เพลท/i, 'งานรากฐาน'],
  [/โคม|หลอด|led|สายไฟ|เบรกเกอร์|breaker|บัลลาส|ballast|luminaire|ไฟฟ้า|มิเตอร์|ตู้ควบคุม|magnetic|แมกเนติก/i, 'งานอุปกรณ์ไฟฟ้า'],
  [/ออกซิเจน|คาร์บอน|อาร์กอน|argon|แก๊ส|ก๊าซ|ลมเพ็ด|เพ็ด|ลวดเชื่อม|ใบตัด|ใบเจียร|หินเจียร|ทินเนอร์|\bสี\b|สเปรย์|น็อต|สกรู|สลัก|จารบี|เทป|กาว/i, 'วัถุดิบสิ้นเปลือง'],
  [/ซ่อม|อะไหล่|บำรุง|น้ำมันเครื่อง|น้ำมันเกียร์|maintenance|แบตเตอรี่|แบต|ยางรถ|ผ้าเบรก|ไส้กรอง/i, 'ซ่อมบำรุง'],
  [/พัสดุ|ไปรษณีย์|kerry|flash|พัสดุ/i,                                    'งานส่งพัสดุ'],
  [/เหล็ก|แผ่นเหล็ก|เหล็กแผ่น|ท่อเหล็ก|เสาเหล็ก|เหล็กเส้น|เหล็กฉาก|เหล็กกล่อง|เหล็กรูป|flat\s?bar|\bsheet\b|\bsteel\b|\bh[-\s]?beam\b|\bi[-\s]?beam\b|เพลา/i, 'วัถุดิบเพื่อการผลิต'],
];
export function guessCategory(text) {
  const s = String(text || '');
  for (const [re, cat] of CATEGORY_GUESS) { if (re.test(s)) return cat; }
  return '';
}

// ── parse วันที่: "15/7/2026", "7/7/69" → YYYY-MM-DD (แปลง พ.ศ.→ค.ศ., ปี 2 หลัก) ──
function parseDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (!m) return null;
  let [, d, mo, y] = m;
  if (y === undefined) y = new Date().getFullYear();
  else { y = parseInt(y); if (y < 100) { if (y >= 50) y += 2500; else y += 2000; } if (y >= 2400) y -= 543; }
  return `${y}-${String(+mo).padStart(2, '0')}-${String(+d).padStart(2, '0')}`;
}
// YYYY-MM-DD → วันที่ไทย (พ.ศ.)
export function beDisplay(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso || '';
  return `${+m[3]}/${+m[2]}/${+m[1] + 543}`;
}
// ดึงเลข PO → "PO<เลข>" (รองรับ "PO NO 2607017", "2607017")
export function normPO(s) {
  if (!s) return '';
  const m = String(s).match(/(\d{5,})/);   // เลข PO บริษัทนี้ 7 หลัก (YYMMxxx)
  return m ? ('PO' + m[1]) : '';
}

// ── อ่านแถวจาก Excel — หา header อัตโนมัติ แล้ว map คอลัมน์ ──
async function tableRowsFromExcel(buffer) {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  let hi = -1; const col = {};
  for (let i = 0; i < Math.min(grid.length, 20); i++) {
    const cells = (grid[i] || []).map(c => String(c).toLowerCase());
    const joined = cells.join('|');
    if (/po/.test(joined) && /(product|สินค้า|รายการ|delivery|จำนวน)/.test(joined)) {
      hi = i;
      cells.forEach((c, ci) => {
        if (/\bpo\b|po\s*no/.test(c) && !/pr/.test(c) && col.po == null) col.po = ci;
        else if (/product|สินค้า|รายการ/.test(c) && col.product == null) col.product = ci;
        else if (/จำนวน|qty|quantity/.test(c) && col.qty == null) col.qty = ci;
        else if (/unit|หน่วย/.test(c) && col.unit == null) col.unit = ci;
        else if (/delivery|วันที่|กำหนดส่ง|วันส่ง/.test(c) && col.date == null) col.date = ci;
        else if (/suplier|supplier|ผู้ขาย|ผู้จำหน่าย/.test(c) && col.supplier == null) col.supplier = ci;
      });
      break;
    }
  }
  if (hi < 0 || col.po == null || col.product == null) return [];
  const out = []; let lastPO = '', lastDate = '';
  for (let i = hi + 1; i < grid.length; i++) {
    const row = grid[i] || [];
    const g = (ci) => ci == null ? '' : String(row[ci] == null ? '' : row[ci]).trim();
    let po = g(col.po); if (po) lastPO = po; else po = lastPO;   // เซลล์ merge เว้นว่าง → สืบทอด
    let date = g(col.date); if (date) lastDate = date; else date = lastDate;
    const product = g(col.product);
    if (!product) continue;
    out.push({ po, product, qty: g(col.qty), unit: g(col.unit), date, supplier: g(col.supplier) });
  }
  return out;
}

// ── อ่านแถวจากรูป/PDF ด้วย AI — คืน JSON ทีละรายการ ──
async function tableRowsFromAI(buffer, mime, fileName, opts = {}) {
  const { groqKey = '', visionModel = 'meta-llama/llama-4-scout-17b-16e-instruct', textModel = 'llama-3.3-70b-versatile' } = opts;
  if (!groqKey) return [];
  const isPdf = /pdf/i.test(mime || '') || /\.pdf$/i.test(fileName || '');
  const prompt =
    'นี่คือตาราง "แจ้งสินค้าเข้า/ส่งของ" ของบริษัท มีหลายรายการ อาจมีหลายเลข PO และหลายวันส่ง\n' +
    'ช่วยอ่านทุกแถวในตาราง แล้วตอบกลับ "1 บรรทัด = 1 รายการสินค้า" เป็น JSON เท่านั้น รูปแบบ:\n' +
    '{"po":"เลข PO","product":"ชื่อสินค้าเต็มตามที่เห็น","qty":"จำนวน","unit":"หน่วย","date":"วันที่ส่ง เช่น 15/7/2026 หรือ รออัพเดท","supplier":"ผู้ขาย"}\n' +
    'กติกา: คัดลอกตามที่เห็นเป๊ะๆ ห้ามเดา/ห้ามแปล ช่องไหนไม่มีใส่ "" | ตอบเฉพาะ JSON ทีละบรรทัด ไม่ต้องมีคำอธิบายหรือ ```';
  let content;
  try {
    if (isPdf) {
      const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
      const data = await pdfParse(buffer);
      const text = String(data.text || '').replace(/[ \t]+/g, ' ').trim();
      if (!text) return [];
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + groqKey },
        body: JSON.stringify({ model: textModel, temperature: 0, max_tokens: 2500,
          messages: [{ role: 'system', content: prompt }, { role: 'user', content: 'ข้อความจากไฟล์:\n' + text.slice(0, 8000) }] })
      });
      const j = await res.json(); if (j.error) return [];
      content = j.choices?.[0]?.message?.content || '';
    } else {
      // ตารางแน่นๆ ต้องการความละเอียดสูง → ย่อที่ 2200px ให้ตัวหนังสือคมพออ่าน
      let imgBuf = buffer;
      try {
        const sharp = (await import('sharp')).default;
        imgBuf = await sharp(buffer).rotate().resize(2200, 2200, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      } catch (e) {}
      const dataUrl = 'data:image/jpeg;base64,' + imgBuf.toString('base64');
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + groqKey },
        body: JSON.stringify({ model: visionModel, temperature: 0, max_tokens: 2500,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }] })
      });
      const j = await res.json(); if (j.error) { console.error('vision table:', j.error.message); return []; }
      content = j.choices?.[0]?.message?.content || '';
    }
  } catch (e) { console.error('tableRowsFromAI:', e.message); return []; }
  const out = [];
  for (const ln of String(content).split('\n')) {
    const s = ln.trim(); if (!s.startsWith('{')) continue;
    try { const o = JSON.parse(s); if (o && (o.product || o.po)) out.push(o); } catch (e) {}
  }
  return out;
}

// ── อ่านไฟล์ตาราง → จัดกลุ่มตาม (PO, วันส่ง) ──
export async function tableGroupsFromBuffer(buffer, mime, fileName, opts = {}) {
  const isExcel = /xlsx|spreadsheet|excel/i.test(mime || '') || /\.xls[xm]?$/i.test(fileName || '');
  let rows = [];
  try {
    rows = isExcel ? await tableRowsFromExcel(buffer) : await tableRowsFromAI(buffer, mime, fileName, opts);
  } catch (e) { console.error('tableGroups:', e.message); }
  const groups = new Map();
  for (const r of rows) {
    const po = normPO(r.po);
    if (!po) continue;                                   // ต้องมี PO เท่านั้น
    const dISO = parseDate(r.date);
    const dateKey = dISO || ('รออัพเดท:' + String(r.date || '').trim());
    const key = po + '|' + dateKey;
    if (!groups.has(key)) groups.set(key, { po, dateISO: dISO, dateRaw: String(r.date || '').trim(), supplier: String(r.supplier || '').trim(), lines: [] });
    const grp = groups.get(key);
    if (r.supplier && !grp.supplier) grp.supplier = String(r.supplier).trim();
    const product = String(r.product || '').trim();
    if (product) grp.lines.push({ product, qty: String(r.qty || '').trim(), unit: String(r.unit || '').trim() });
  }
  return [...groups.values()].filter(g => g.lines.length);
}

// ════════════════════════════════════════════════════════════════════════════
//  จับคู่รายการในไฟล์กับรายการจริงใน Odoo (ตามเลข PO) แล้วแทนที่ชื่อ+จำนวน
//  - คงการแยกวัน: จับคู่ทีละบรรทัด รายการไหนอยู่กลุ่ม(วัน)ไหนก็อยู่ที่เดิม
//  - PO แยกหลายวัน → คงจำนวนจากไฟล์ (จำนวนต่อรอบส่ง) | PO วันเดียว → ใช้จำนวนจาก Odoo
//  - จับคู่ไม่ได้ / ไม่เจอ PO ใน Odoo → คงข้อความเดิมจากไฟล์ (ปลอดภัย)
// ════════════════════════════════════════════════════════════════════════════
function _norm(s) { return String(s || '').toLowerCase().replace(/[\s\-_.,()/\[\]{}#]+/g, ''); }
function _bigrams(s) { const b = new Set(); for (let i = 0; i < s.length - 1; i++) b.add(s.slice(i, i + 2)); return b; }
function _similarity(a, b) {
  const A = _norm(a), B = _norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.length >= 4 && (A.includes(B) || B.includes(A))) return 0.9;
  const ba = _bigrams(A), bb = _bigrams(B);
  if (!ba.size || !bb.size) return 0;
  let inter = 0; for (const g of ba) if (bb.has(g)) inter++;
  return (2 * inter) / (ba.size + bb.size);
}
function _qtyNum(s) { const m = String(s == null ? '' : s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; }
function _fmtNum(n) { if (n == null || isNaN(n)) return ''; return Number.isInteger(n) ? String(n) : String(+(+n).toFixed(2)); }
function _cleanName(s) { return String(s || '').replace(/\s+/g, ' ').replace(/-{3,}/g, '--').trim(); }

// odooPO: (poNumber, companyId?) => [{ lines:[{ product_id:[id,name], product_qty }] }]
export async function enrichGroupsWithOdoo(groups, odooPO, companyId) {
  if (typeof odooPO !== 'function' || !Array.isArray(groups)) return groups;
  const cache = new Map();
  for (const g of groups) {
    let orders = cache.get(g.po);
    if (orders === undefined) {
      try { orders = await odooPO(g.po, companyId); } catch (e) { orders = []; }
      cache.set(g.po, orders);
    }
    const order = (orders && orders[0]) || null;
    const oLines = ((order && Array.isArray(order.lines)) ? order.lines : []).map(l => ({
      name: Array.isArray(l.product_id) ? String(l.product_id[1] || '') : String(l.product_id || ''),
      qty: (l.product_qty != null ? _qtyNum(l.product_qty) : null),
      used: false
    })).filter(l => l.name);
    if (!oLines.length) { g.odooMatched = false; continue; }   // ไม่เจอ PO → คงข้อความเดิม

    // PO นี้ถูกแยกเป็นหลายวันไหม (ถ้าแยก → คงจำนวนจากไฟล์)
    const splitAcrossDates = groups.filter(x => x.po === g.po).length > 1;

    let any = false;
    for (const line of g.lines) {
      const lq = _qtyNum(line.qty);
      let best = null, bestScore = 0;
      for (const ol of oLines) {
        if (ol.used) continue;
        let sc = _similarity(line.product, ol.name);
        if (lq != null && ol.qty != null && lq === ol.qty) sc += 0.15;   // จำนวนตรง = โบนัส
        if (sc > bestScore) { bestScore = sc; best = ol; }
      }
      if (best && bestScore >= 0.4) {
        best.used = true;
        line.product = _cleanName(best.name);
        if (!splitAcrossDates && best.qty != null) line.qty = _fmtNum(best.qty);
        any = true;
      }
    }
    g.odooMatched = any;
  }
  return groups;
}
