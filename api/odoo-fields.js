// ============================================================================
//  api/odoo-fields.js — ทดสอบ query ค้นใบส่งของ (ชั่วคราว)
//  เปิด: https://inventory-rho-hazel.vercel.app/api/odoo-fields?q=ภูเก็ต 4+570
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

function smartWords(keyword) {
  let s = String(keyword).trim();
  s = s.replace(/([\u0E00-\u0E7F])(\d)/g, '$1 $2');
  s = s.replace(/(\d)([\u0E00-\u0E7F])/g, '$1 $2');
  return s.split(/\s+/).filter(Boolean);
}

export default async function handler(req, res) {
  try {
    const q = (req.query && req.query.q) ? String(req.query.q) : 'ภูเก็ต 4+570';
    const uid = await auth();
    const words = smartWords(q);

    const oneWord = (w) => ['|', '|', '|',
      ['name','ilike',w], ['origin','ilike',w],
      ['partner_id.name','ilike',w], ['location_dest_id.complete_name','ilike',w]
    ];
    let domain = [];
    if (words.length <= 1) domain = oneWord(words[0]||'');
    else { for (let i=0;i<words.length-1;i++) domain.push('&'); words.forEach(w=>domain.push(...oneWord(w))); }

    const recs = await jsonRpc('object','execute_kw',[
      ODOO_DB, uid, ODOO_KEY, 'stock.picking', 'search_read',
      [domain], { fields:['name','origin','state','location_dest_id'], limit: 50 }
    ]);

    res.status(200).json({
      query: q, words, matched: recs.length,
      results: recs.map(r => ({
        name: r.name, state: r.state,
        dest: Array.isArray(r.location_dest_id) ? r.location_dest_id[1] : ''
      }))
    });
  } catch (e) {
    res.status(200).json({ error: e.message });
  }
}
