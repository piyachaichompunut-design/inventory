// ============================================================================
//  api/pdfgen.js — สร้าง PDF ภาษาไทย (ใบส่งของ) ด้วย pdf-lib
//  โหลดฟอนต์ Sarabun จาก CDN ตอนรัน (ไม่ต้องเก็บไฟล์ฟอนต์ใน repo)
// ============================================================================
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

// แหล่งฟอนต์สำรองหลายที่ เผื่อบางอันโหลดไม่ได้
const FONT_REGULAR = [
  'https://raw.githubusercontent.com/google/fonts/main/ofl/sarabun/Sarabun-Regular.ttf',
  'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/sarabun/Sarabun-Regular.ttf',
];
const FONT_BOLD = [
  'https://raw.githubusercontent.com/google/fonts/main/ofl/sarabun/Sarabun-Bold.ttf',
  'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/sarabun/Sarabun-Bold.ttf',
];

// cache ฟอนต์ไว้ใน memory (ลดการโหลดซ้ำ)
let _fontCache = null;

async function fetchFirst(urls) {
  for (const u of urls) {
    try {
      const r = await fetch(u);
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
    } catch (e) { /* ลองตัวถัดไป */ }
  }
  throw new Error('โหลดฟอนต์ไทยไม่สำเร็จ');
}

async function loadFonts() {
  if (_fontCache) return _fontCache;
  const [reg, bold] = await Promise.all([fetchFirst(FONT_REGULAR), fetchFirst(FONT_BOLD)]);
  _fontCache = { reg, bold };
  return _fontCache;
}

// ── สร้าง PDF ใบส่งของ ───────────────────────────────────────────────────────
// data = { title, picks: [ { name, origin, partner, state, date, lines:[{name, qty, uom}] } ] }
export async function buildDeliveryPDF(data) {
  const fonts = await loadFonts();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fonts.reg);
  const fontB = await pdf.embedFont(fonts.bold);

  const A4 = [595.28, 841.89];
  const margin = 50;
  let page = pdf.addPage(A4);
  let y = A4[1] - margin;

  const black = rgb(0.1, 0.1, 0.1);
  const gray = rgb(0.45, 0.45, 0.45);
  const orange = rgb(0.92, 0.35, 0.05);

  const pageWidth = A4[0] - margin * 2; // ~495pt

  // ── ตัดบรรทัดอัตโนมัติ (word-wrap) ──────────────────────────────────────────
  const wrapText = (text, f, size, maxWidth) => {
    const clean = String(text || '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/gu, '').replace(/\s+$/, '');
    const lines = [];
    // ตัดตาม --- และช่องว่าง
    const words = clean.replace(/-{2,}/g, ' ').split(/(?<=[\u0E00-\u0E7Fa-zA-Z0-9])(?=[\u0E00-\u0E7F])|(?<=[\u0E00-\u0E7F])(?=[a-zA-Z0-9])|[-\s]+/g).filter(Boolean);
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (f.widthOfTextAtSize(test, size) > maxWidth && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [clean];
  };

  // ฟังก์ชันช่วยวาดข้อความ + ขึ้นหน้าใหม่อัตโนมัติ + word-wrap
  const newPageIfNeeded = (need = 20) => {
    if (y < margin + need) { page = pdf.addPage(A4); y = A4[1] - margin; }
  };
  const line = (text, { size = 12, bold = false, color = black, indent = 0, gap = 6 } = {}) => {
    const f = bold ? fontB : font;
    const maxW = pageWidth - indent;
    const wrapped = wrapText(text, f, size, maxW);
    for (let i = 0; i < wrapped.length; i++) {
      newPageIfNeeded(size + gap);
      page.drawText(wrapped[i], { x: margin + indent, y, size, font: f, color });
      y -= size + (i < wrapped.length - 1 ? 3 : gap);
    }
  };
  const hr = () => {
    newPageIfNeeded(10);
    page.drawLine({ start: { x: margin, y }, end: { x: A4[0] - margin, y }, thickness: 0.5, color: gray });
    y -= 10;
  };

  // หัวเอกสาร
  line(data.title || 'ใบส่งของ', { size: 20, bold: true, color: orange, gap: 4 });
  line('Task Management System — ดึงข้อมูลจาก Odoo', { size: 10, color: gray, gap: 6 });
  // สรุปจำนวน
  if (data.summary) {
    const s = data.summary;
    let sumText = 'รวม ' + s.total + ' ใบ';
    if (s.done)    sumText += '  |  ส่งแล้ว ' + s.done;
    if (s.pending) sumText += '  |  รอส่ง ' + s.pending;
    if (s.cancel)  sumText += '  |  ยกเลิก ' + s.cancel;
    line(sumText, { size: 11, bold: true, color: black, gap: 10 });
  } else {
    y -= 6;
  }
  hr();

  const red = rgb(0.86, 0.15, 0.15);
  const green = rgb(0.13, 0.6, 0.23);

  // วนแต่ละใบส่งของ
  (data.picks || []).forEach((p, idx) => {
    // เลขใบ + สถานะ (สี) อยู่บนสุด เด่นๆ
    line((idx + 1) + '. ' + (p.name || '-'), { size: 14, bold: true, gap: 4 });
    if (p.statusText) {
      const colorMap = { red: red, green: green, gray: gray };
      const stColor = colorMap[p.statusColor] || (p.shipped ? red : green);
      line('สถานะ: ' + p.statusText, { size: 13, bold: true, indent: 14, color: stColor, gap: 8 });
    }
    if (p.origin)  line('โครงการ: ' + p.origin, { size: 11, indent: 14, color: gray });
    if (p.partner) line('ปลายทาง: ' + p.partner, { size: 11, indent: 14, color: gray });
    if (p.date)    line('วันที่: ' + p.date, { size: 11, indent: 14, color: gray, gap: 8 });

    if (p.lines && p.lines.length) {
      line('รายการสินค้า:', { size: 11, bold: true, indent: 14, gap: 6 });
      p.lines.forEach((l, li) => {
        // แยกรหัส [xxx] ออกจากชื่อสินค้า
        const fullName = l.name || '';
        const codeMatch = fullName.match(/^\[([^\]]+)\]\s*/);
        const code = codeMatch ? codeMatch[1] : '';
        const nameOnly = codeMatch ? fullName.slice(codeMatch[0].length) : fullName;
        // ทำความสะอาดชื่อ: แทน --- ด้วยช่องว่าง
        const cleanName = nameOnly.replace(/-{2,}/g, ' ').trim();
        const qtyStr = String(l.qty || 0) + ' ' + (l.uom || '');

        // บรรทัดที่ 1: รหัส (ถ้ามี)
        if (code) {
          line((li + 1) + '. รหัส: ' + code, { size: 10, bold: true, indent: 24, gap: 2, color: gray });
        }
        // บรรทัดที่ 2: ชื่อสินค้า (wrap อัตโนมัติ)
        line((code ? '    ' : (li + 1) + '. ') + cleanName, { size: 10, indent: 24, gap: 2 });
        // บรรทัดที่ 3: จำนวน
        line('    จำนวน: ' + qtyStr, { size: 10, indent: 24, gap: 6, color: orange });
      });
    }
    y -= 8;
    hr();
  });

  // ท้ายเอกสาร
  newPageIfNeeded(20);
  const now = new Date();
  const ds = now.toISOString().slice(0, 10);
  line('พิมพ์เมื่อ: ' + ds, { size: 9, color: gray });

  return await pdf.save(); // คืน Uint8Array
}

// ── สร้าง PDF เปรียบเทียบ SO vs PO (หรือคู่ใดก็ได้) ──────────────────────────
// compareData = { docA, docB, typeA, typeB, numA, numB, rows:[{code,name,qtyA,qtyB,diff,status}] }
export async function buildComparePDF(compareData) {
  const fonts = await loadFonts();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font  = await pdf.embedFont(fonts.reg);
  const fontB = await pdf.embedFont(fonts.bold);

  const A4 = [595.28, 841.89];
  const margin = 40;
  let page = pdf.addPage(A4);
  let y = A4[1] - margin;

  const black  = rgb(0.1,  0.1,  0.1);
  const gray   = rgb(0.5,  0.5,  0.5);
  const orange = rgb(0.92, 0.35, 0.05);
  const red    = rgb(0.86, 0.15, 0.15);
  const green  = rgb(0.13, 0.6,  0.23);
  const yellow = rgb(0.8,  0.55, 0.0);
  const bgRed  = rgb(1.0,  0.93, 0.93);
  const bgYel  = rgb(1.0,  0.97, 0.88);
  const bgGray = rgb(0.97, 0.97, 0.97);

  const newPageIfNeeded = (need = 20) => {
    if (y < margin + need) { page = pdf.addPage(A4); y = A4[1] - margin; }
  };

  const txt = (text, x, yy, { size=11, bold=false, color=black }={}) => {
    const clean = String(text||'').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu,'').replace(/\s+$/,'');
    page.drawText(clean, { x, y: yy, size, font: bold ? fontB : font, color });
  };

  const hr = (thick=0.5, color=gray) => {
    newPageIfNeeded(10);
    page.drawLine({ start:{x:margin,y}, end:{x:A4[0]-margin,y}, thickness:thick, color });
    y -= 8;
  };

  // ── หัว ──
  const labelA = (compareData.typeA||'').toUpperCase() + (compareData.numA||'');
  const labelB = (compareData.typeB||'').toUpperCase() + (compareData.numB||'');
  txt('เปรียบเทียบ ' + labelA + ' vs ' + labelB, margin, y, { size:18, bold:true, color:orange });
  y -= 26;
  const nameA = Array.isArray(compareData.docA?.partner_id) ? compareData.docA.partner_id[1] : '';
  const nameB = Array.isArray(compareData.docB?.partner_id) ? compareData.docB.partner_id[1] : '';
  if (nameA) { txt(labelA + ': ' + nameA, margin, y, { size:10, color:gray }); y -= 14; }
  if (nameB) { txt(labelB + ': ' + nameB, margin, y, { size:10, color:gray }); y -= 14; }
  y -= 4;
  hr(1, orange);

  // สรุปจำนวน
  const rows = compareData.rows || [];
  const cntOk   = rows.filter(r=>r.status==='ok').length;
  const cntDiff = rows.filter(r=>r.status==='diff').length;
  const cntMisA = rows.filter(r=>r.status==='missing_a').length;
  const cntMisB = rows.filter(r=>r.status==='missing_b').length;
  txt('รายการทั้งหมด: ' + rows.length + '  |  ตรง: ' + cntOk + '  |  ต่าง: ' + cntDiff + '  |  ไม่มีใน ' + labelA + ': ' + cntMisA + '  |  ไม่มีใน ' + labelB + ': ' + cntMisB,
    margin, y, { size:10, bold:true, color:black });
  y -= 20;
  hr();

  // ── header ตาราง ──
  const W = A4[0] - margin*2; // ~515
  const cols = { code:0, name:90, qtyA:330, qtyB:390, diff:450, status:490 };
  const rowH = 18;

  // วาด header bar
  page.drawRectangle({ x:margin, y:y-2, width:W, height:rowH+4, color:rgb(0.2,0.2,0.2) });
  txt('รหัส',       margin+cols.code,   y, { size:10, bold:true, color:rgb(1,1,1) });
  txt('ชื่อสินค้า', margin+cols.name,   y, { size:10, bold:true, color:rgb(1,1,1) });
  txt(labelA,       margin+cols.qtyA,   y, { size:10, bold:true, color:rgb(1,1,1) });
  txt(labelB,       margin+cols.qtyB,   y, { size:10, bold:true, color:rgb(1,1,1) });
  txt('ต่าง',       margin+cols.diff,   y, { size:10, bold:true, color:rgb(1,1,1) });
  txt('สถานะ',      margin+cols.status, y, { size:10, bold:true, color:rgb(1,1,1) });
  y -= rowH + 6;

  // ── แถวข้อมูล ──
  rows.forEach((r, i) => {
    newPageIfNeeded(rowH + 4);

    // สีพื้นหลังตามสถานะ
    let bg = i%2===0 ? rgb(1,1,1) : bgGray;
    let textColor = black;
    let statusTxt = 'ตรง';
    let statusColor = green;

    if (r.status === 'diff') {
      bg = bgYel; statusTxt = 'ไม่ตรง'; statusColor = yellow;
    } else if (r.status === 'missing_a') {
      bg = bgRed; statusTxt = 'ไม่มีใน '+labelA; statusColor = red; textColor = red;
    } else if (r.status === 'missing_b') {
      bg = bgRed; statusTxt = 'ไม่มีใน '+labelB; statusColor = red; textColor = red;
    }

    page.drawRectangle({ x:margin, y:y-4, width:W, height:rowH, color:bg });

    // ตัดชื่อสินค้าไม่ให้ยาวเกิน
    const nameShort = (r.name||'').slice(0, 28);
    txt(r.code||'-',              margin+cols.code,   y, { size:9,  color:textColor });
    txt(nameShort,                margin+cols.name,   y, { size:9,  color:textColor });
    txt(r.qtyA||0,                margin+cols.qtyA,   y, { size:10, bold:true, color:r.status==='missing_a'?red:black });
    txt(r.qtyB||0,                margin+cols.qtyB,   y, { size:10, bold:true, color:r.status==='missing_b'?red:black });
    txt(r.diff===0?'-':String(r.diff), margin+cols.diff, y, { size:10, bold:true, color:r.diff!==0?red:green });
    txt(statusTxt,                margin+cols.status, y, { size:9,  bold:true, color:statusColor });

    y -= rowH + 2;
  });

  hr();
  const now2 = new Date();
  txt('พิมพ์เมื่อ: ' + now2.toISOString().slice(0,10), margin, y, { size:9, color:gray });

  return await pdf.save();
}
