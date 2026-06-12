// ============================================================================
//  api/odoo-image.js — Proxy ดึงรูปจาก Odoo ir.attachment ตาม ID
//  ใช้โดยหน้า delivery.html: <img src="/api/odoo-image?id=123">
//  รูปถูก cache ที่ browser/CDN เพื่อความเร็ว
// ============================================================================
import { odooGetAttachmentImage } from './odoo.js';

export default async function handler(req, res) {
  try {
    const id = req.query?.id || (new URL(req.url, 'http://x').searchParams.get('id'));
    if (!id) { res.status(400).send('missing id'); return; }

    const img = await odooGetAttachmentImage(id);
    if (!img) { res.status(404).send('not found'); return; }

    // cache 1 วัน (รูปงานไม่เปลี่ยน) — ลดโหลดซ้ำ
    res.setHeader('Content-Type', img.mimetype);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    res.status(200).send(img.buffer);
  } catch (e) {
    res.status(500).send('error: ' + e.message);
  }
}
