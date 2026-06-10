// ============================================================================
//  api/odoo-fields.js — ดึงรายชื่อบริษัททั้งหมด (ชั่วคราว)
//  เปิด: https://inventory-rho-hazel.vercel.app/api/odoo-fields
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
async function auth() { if (_uid) return _uid; _uid = await jsonRpc('common','authenticate',[ODOO_DB, ODOO_USER, ODOO_KEY, {}]); return _uid; }

export default async function handler(req, res) {
  try {
    const uid = await auth();
    const companies = await jsonRpc('object','execute_kw',[
      ODOO_DB, uid, ODOO_KEY, 'res.company', 'search_read',
      [[]], { fields:['id','name'] }
    ]);
    res.status(200).json({ companies });
  } catch (e) {
    res.status(200).json({ error: e.message });
  }
}
