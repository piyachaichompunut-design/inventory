// ============================================================================
//  api/odoo-test.js — ตัวทดสอบหา database name อัตโนมัติ (ชั่วคราว)
//  เปิดในเบราว์เซอร์: https://inventory-rho-hazel.vercel.app/api/odoo-test
//  ⚠️ ใช้เสร็จแล้วลบไฟล์นี้ทิ้ง
// ============================================================================
const ODOO_URL  = (process.env.ODOO_URL || '').replace(/\/+$/, '');
const ODOO_USER = process.env.ODOO_USERNAME || '';
const ODOO_KEY  = process.env.ODOO_API_KEY  || '';

async function jsonRpc(service, method, args) {
  const res = await fetch(ODOO_URL + '/jsonrpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call',
      params: { service, method, args }, id: Date.now()
    })
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return { _rawHtml: text.slice(0, 200) }; }
}

async function tryAuth(db) {
  try {
    const r = await jsonRpc('common', 'authenticate', [db, ODOO_USER, ODOO_KEY, {}]);
    if (r.result) return { db, ok: true, uid: r.result };
    const msg = r.error?.data?.message || r.error?.message || 'login ไม่ผ่าน';
    return { db, ok: false, reason: String(msg).split('\n')[0] };
  } catch (e) {
    return { db, ok: false, reason: e.message };
  }
}

export default async function handler(req, res) {
  // รายชื่อ database ที่จะลองเดา (รูปแบบมาตรฐานของ odoo.sh)
  const candidates = [
    'seterp',
    'seterp-main',
    'seterp-production',
    'seterp-prod',
    'seterp-master',
    'SETERP',
    'seterp-staging',
  ];

  // เพิ่มชื่อที่ผู้ใช้อยากลองเอง ผ่าน ?db=ชื่อ (ลองได้หลายตัว คั่นด้วย ,)
  if (req.query && req.query.db) {
    String(req.query.db).split(',').forEach(d => {
      const t = d.trim(); if (t && !candidates.includes(t)) candidates.unshift(t);
    });
  }

  const results = [];
  let found = null;
  for (const db of candidates) {
    const r = await tryAuth(db);
    results.push(r);
    if (r.ok) { found = r; break; } // เจอแล้วหยุด
  }

  res.status(200).json({
    config: { ODOO_URL, ODOO_USERNAME: ODOO_USER, hasKey: !!ODOO_KEY },
    found: found ? `✅ ชื่อ database ที่ถูกต้องคือ: "${found.db}" (uid=${found.uid})` : '❌ ยังไม่เจอ — ลองส่งชื่อเองผ่าน ?db=ชื่อที่อยากลอง',
    tried: results
  });
}
