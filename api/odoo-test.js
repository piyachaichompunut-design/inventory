// ============================================================================
//  api/odoo-test.js — ตัวทดสอบการเชื่อมต่อ Odoo (ชั่วคราว ใช้หา database name)
//  เปิดในเบราว์เซอร์: https://inventory-rho-hazel.vercel.app/api/odoo-test
//  ⚠️ ใช้เสร็จแล้วลบไฟล์นี้ทิ้งได้เลย
// ============================================================================
const ODOO_URL  = (process.env.ODOO_URL || '').replace(/\/+$/, '');
const ODOO_DB   = process.env.ODOO_DB       || '';
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
  catch { return { _rawHtml: text.slice(0, 300) }; }
}

export default async function handler(req, res) {
  const out = {
    config: {
      ODOO_URL: ODOO_URL || '(ยังไม่ตั้ง)',
      ODOO_DB: ODOO_DB || '(ยังไม่ตั้ง)',
      ODOO_USERNAME: ODOO_USER || '(ยังไม่ตั้ง)',
      ODOO_API_KEY: ODOO_KEY ? '(ตั้งแล้ว ••••)' : '(ยังไม่ตั้ง)'
    },
    databases: null,
    authTest: null
  };

  // 1) ถามรายชื่อ database ทั้งหมด
  try {
    const dbList = await jsonRpc('db', 'list', []);
    out.databases = dbList.result || dbList.error || dbList;
  } catch (e) {
    out.databases = 'ดึงรายชื่อ db ไม่ได้: ' + e.message + ' (บาง server ปิดฟีเจอร์นี้ไว้)';
  }

  // 2) ลอง authenticate ด้วยค่าที่ตั้งไว้
  if (ODOO_DB && ODOO_USER && ODOO_KEY) {
    try {
      const auth = await jsonRpc('common', 'authenticate', [ODOO_DB, ODOO_USER, ODOO_KEY, {}]);
      if (auth.result) out.authTest = '✅ login สำเร็จ! uid = ' + auth.result;
      else if (auth.error) out.authTest = '❌ ' + (auth.error.data?.message || auth.error.message);
      else out.authTest = '❌ login ไม่ผ่าน (อาจผิด db/user/key)';
    } catch (e) {
      out.authTest = '❌ error: ' + e.message;
    }
  } else {
    out.authTest = '(ยังตั้งค่าไม่ครบ)';
  }

  res.status(200).json(out);
}
