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

  // ฟังก์ชันช่วยวาดข้อความ + ขึ้นหน้าใหม่อัตโนมัติ
  const newPageIfNeeded = (need = 20) => {
    if (y < margin + need) { page = pdf.addPage(A4); y = A4[1] - margin; }
  };
  const line = (text, { size = 12, bold = false, color = black, indent = 0, gap = 6 } = {}) => {
    newPageIfNeeded(size + gap);
    // เอาอิโมจิ/สัญลักษณ์ที่ฟอนต์ไทยไม่มีออก กันขึ้นเป็นช่อง □
    const clean = String(text || '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/gu, '').replace(/\s+$/,'');
    page.drawText(clean, {
      x: margin + indent, y, size, font: bold ? fontB : font, color
    });
    y -= size + gap;
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
      p.lines.forEach(l => {
        const txt = '• ' + (l.name || '') + '   ' + (l.qty || 0) + ' ' + (l.uom || '');
        line(txt, { size: 11, indent: 24, gap: 5 });
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
