// ============================================================================
//  api/odoo-test.js — ตรวจการเชื่อมต่อ Odoo (ชั่วคราว ใช้เสร็จลบ)
//  เปิด: https://inventory-rho-hazel.vercel.app/api/odoo-test
// ============================================================================
const ODOO_URL  = (process.env.ODOO_URL || '').replace(/\/+$/, '');
const ODOO_DB   = process.env.ODOO_DB       || '';
const ODOO_USER = process.env.ODOO_USERNAME || '';
const ODOO_KEY  = process.env.ODOO_API_KEY  || '';

async function jsonRpc(service, method, args) {
  const res = await fetch(ODOO_URL + '/jsonrpc', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc:'2.0', method:'call', params:{ service, method, args }, id:Date.now() })
  });
  const text = await res.text();
  try { return { json: JSON.parse(text) }; }
  catch { return { raw: text.slice(0, 200) }; }
}

export default async function handler(req, res) {
  // 1) โชว์ว่าแต่ละค่าตั้งไว้ไหม + ความยาว (ไม่โชว์ค่าจริงของ key เพื่อความปลอดภัย)
  const config = {
    ODOO_URL: ODOO_URL || '(ว่าง!)',
    ODOO_DB: ODOO_DB || '(ว่าง!)',
    ODOO_USERNAME: ODOO_USER || '(ว่าง!)',
    ODOO_API_KEY_length: ODOO_KEY.length,
    ODOO_API_KEY_preview: ODOO_KEY ? (ODOO_KEY.slice(0,4) + '...' + ODOO_KEY.slice(-4)) : '(ว่าง!)',
    ODOO_API_KEY_hasSpace: /\s/.test(ODOO_KEY)  // มีช่องว่าง/ขึ้นบรรทัดปนไหม
  };

  // 2) ลอง authenticate
  let authResult;
  try {
    const r = await jsonRpc('common', 'authenticate', [ODOO_DB, ODOO_USER, ODOO_KEY, {}]);
    if (r.json && r.json.result) authResult = '✅ login สำเร็จ! uid = ' + r.json.result;
    else if (r.json && r.json.result === false) authResult = '❌ login ไม่ผ่าน — DB/Username/Key ไม่ตรง หรือ key ถูกลบ/หมดอายุ';
    else if (r.json && r.json.error) authResult = '❌ Odoo error: ' + (r.json.error.data?.message || r.json.error.message);
    else if (r.raw) authResult = '❌ ตอบกลับไม่ใช่ JSON (URL อาจผิด): ' + r.raw;
    else authResult = '❌ ไม่ทราบสาเหตุ: ' + JSON.stringify(r.json);
  } catch (e) {
    authResult = '❌ error: ' + e.message;
  }

  res.status(200).json({ config, authResult });
}
