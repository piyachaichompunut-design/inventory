// ============================================================================
//  api/odoo-fields.js — ตรวจว่าข้อมูลโครงการ (เช่น 4+570) เก็บใน field ไหน
//  เปิด: https://inventory-rho-hazel.vercel.app/api/odoo-fields?q=ภูเก็ต
//  ⚠️ ใช้เสร็จลบทิ้ง
// ============================================================================
const ODOO_URL  = (process.env.ODOO_URL || '').replace(/\/+$/, '');
const ODOO_DB   = process.env.ODOO_DB       || '';
const ODOO_USER = process.env.ODOO_USERNAME || '';
const ODOO_KEY  = process.env.ODOO_API_KEY  || '';

let _uid = null;
async function jsonRpc(service, method, args) {
  const res = await fetch(ODOO_URL + '/jsonrpc', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc:'2.0', method:'call', params:{ service, method, args }, id:Date.now() })
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error.data?.message || d.error.message);
  return d.result;
}
async function auth() {
  if (_uid) return _uid;
  _uid = await jsonRpc('common','authenticate',[ODOO_DB, ODOO_USER, ODOO_KEY, {}]);
  return _uid;
}

export default async function handler(req, res) {
  try {
    const q = (req.query && req.query.q) ? String(req.query.q) : 'ภูเก็ต';
    const uid = await auth();

    // หาใบส่งของที่ origin/name มีคำค้น เอามา 1 ใบ ดูทุก field
    const ids = await jsonRpc('object','execute_kw',[
      ODOO_DB, uid, ODOO_KEY,
      'stock.picking', 'search',
      [['|', ['name','ilike',q], ['origin','ilike',q]]],
      { limit: 3 }
    ]);

    if (!ids.length) {
      res.status(200).json({ found: false, msg: 'ไม่เจอใบที่ name/origin มี "' + q + '"' });
      return;
    }

    // อ่าน "ทุก field" ของใบแรก
    const full = await jsonRpc('object','execute_kw',[
      ODOO_DB, uid, ODOO_KEY,
      'stock.picking', 'read',
      [ids],
      {} // ไม่ระบุ fields = เอาทุก field
    ]);

    // คัดเฉพาะ field ที่เป็นข้อความ + มีค่า เพื่อดูง่าย
    const simplified = full.map(rec => {
      const out = {};
      for (const [k, v] of Object.entries(rec)) {
        if (typeof v === 'string' && v.trim()) out[k] = v;
        else if (Array.isArray(v) && v.length === 2 && typeof v[1] === 'string') out[k] = v[1];
      }
      return out;
    });

    res.status(200).json({ found: true, count: ids.length, records: simplified });
  } catch (e) {
    res.status(200).json({ error: e.message });
  }
}
