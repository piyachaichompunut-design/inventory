// ============================================================================
//  /api/rpc.js  —  Vercel Serverless Function
//  จุดเดียวที่ frontend เรียกผ่าน google.script.run (ดู app-shim.js)
//  รับ { fn: 'getTasks', args: [...] }  แล้ว dispatch ไปยัง handler ที่ port มาจาก Code.gs
//  ใช้ Supabase (service_role key) เป็นฐานข้อมูลแทน Google Sheets
// ============================================================================
import { createClient } from '@supabase/supabase-js';

import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ── Auth: รหัสผ่านร่วมของออฟฟิศ (ตั้งใน Environment Variable: APP_PASSWORD) ──
const APP_PASSWORD = process.env.APP_PASSWORD || '';
// ใช้ service key เป็น "ความลับ" ในการเซ็น token (มีอยู่แล้ว ไม่ต้องตั้งเพิ่ม)
const TOKEN_SECRET = SERVICE_KEY || 'fallback-secret';

// สร้าง token แบบ HMAC: payload = วันหมดอายุ, sig = ลายเซ็นที่ปลอมไม่ได้
function makeToken() {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 7; // อายุ 7 วัน
  const payload = String(exp);
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  // เทียบแบบ timing-safe กันการเดา
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)); } catch { ok = false; }
  if (!ok) return false;
  if (Date.now() > Number(payload)) return false; // หมดอายุ
  return true;
}

let db = (SUPABASE_URL && SERVICE_KEY)
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

// test hook — ไม่กระทบการทำงานบน Vercel
export function __setDb(client) { db = client; }

// ── helpers ─────────────────────────────────────────────────────────────────
const pad = (n, w) => String(n).padStart(w, '0');
const rid = (prefix, randLen = 5) =>
  prefix + Date.now().toString(36).toUpperCase() +
  Math.random().toString(36).substr(2, randLen).toUpperCase();

const todayStr = () => new Date().toISOString().slice(0, 10);
const dstr = (v) => {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  try { return new Date(v).toISOString().slice(0, 10); } catch { return ''; }
};

// ของเดิม: _calcDays() → ข้อความ "อีก N วันข้างหน้า" / "เลย N วันแล้ว" / "วันนี้"
function calcDays(actionDate) {
  if (!actionDate) return '';
  const a = new Date(actionDate + 'T00:00:00');
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const diff = Math.ceil((a - now) / 86400000);
  if (diff > 0) return 'อีก ' + diff + ' วันข้างหน้า';
  if (diff < 0) return 'เลย ' + Math.abs(diff) + ' วันแล้ว';
  return 'วันนี้';
}

// ── Telegram แจ้งเตือน ──────────────────────────────────────────────────────
// ตั้งค่าใน Environment Variables: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID || '';

async function notifyTelegram(text) {
  // ถ้ายังไม่ตั้งค่า → ข้ามเงียบๆ ไม่ให้กระทบการทำงานหลัก
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
  } catch (e) {
    // ส่งไม่สำเร็จก็ไม่ทำให้ระบบหลักพัง
    console.error('Telegram notify failed:', e.message);
  }
}
// escape อักขระพิเศษของ HTML กันข้อความเพี้ยน
function tgEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================================
//  TASKS
// ============================================================================
function taskOut(r) {
  return {
    _row: r.seq,
    'ID': r.id,
    'Task': r.task || '',
    'Categories': r.categories || '',
    'Notification': r.notification || 'แจ้งล่วงหน้า',
    'Action Date': dstr(r.action_date),
    'Duration': r.duration || '',
    'Doing': !!r.doing,
    'Update to Today': calcDays(dstr(r.action_date)),
    'Done': !!r.done,
    'Task Status': r.task_status || 'To Do',
    'Note': r.note || '',
    'Sales Name': r.sales_name || '',
    'Created Date': dstr(r.created_date),
    'Attachments': Array.isArray(r.attachments) ? r.attachments : []
  };
}

async function getTasks(filters) {
  const { data, error } = await db.from('tasks').select('*').order('seq', { ascending: true });
  if (error) throw error;
  let rows = (data || []).map(taskOut);
  if (filters) {
    const f = filters;
    if (f.status && f.status !== 'All')             rows = rows.filter(r => r['Task Status'] === f.status);
    if (f.category && f.category !== 'All')          rows = rows.filter(r => r['Categories'] === f.category);
    if (f.notification && f.notification !== 'All')  rows = rows.filter(r => r['Notification'] === f.notification);
    if (f.salesName && f.salesName !== 'All')        rows = rows.filter(r => r['Sales Name'] === f.salesName);
    if (f.duration && f.duration !== 'All')          rows = rows.filter(r => r['Duration'] === f.duration);
    if (f.month) rows = rows.filter(r => { const d = new Date(r['Action Date']); return !isNaN(d) && (d.getMonth() + 1) === +f.month; });
    if (f.year)  rows = rows.filter(r => { const d = new Date(r['Action Date']); return !isNaN(d) && d.getFullYear() === +f.year; });
    if (f.search) { const s = f.search.toLowerCase(); rows = rows.filter(r => ((r['Task'] || '') + (r['Note'] || '') + (r['Sales Name'] || '')).toLowerCase().includes(s)); }
  }
  return rows;
}

async function addTask(td) {
  const doing = td['Doing'] === true;
  const done  = td['Done'] === true;
  const status = done ? 'Done' : doing ? 'Doing' : (td['Task Status'] || 'To Do');
  const id = rid('T');
  const { error } = await db.from('tasks').insert({
    id,
    task: td['Task'] || '',
    categories: td['Categories'] || '',
    notification: td['Notification'] || 'แจ้งล่วงหน้า',
    action_date: td['Action Date'] || todayStr(),
    duration: td['Duration'] || 'รับ',
    doing, done, task_status: status,
    note: td['Note'] || '',
    sales_name: td['Sales Name'] || '',
    attachments: []
  });
  if (error) return { success: false, error: error.message };
  // 🔔 แจ้งเตือน: มีงานใหม่
  await notifyTelegram(
    '🆕 <b>มีงานใหม่</b>\n' +
    '📋 งาน: ' + tgEsc(td['Task'] || '-') + '\n' +
    '🏷️ หมวด: ' + tgEsc(td['Categories'] || '-') + '\n' +
    '📅 วันดำเนินการ: ' + tgEsc(td['Action Date'] || todayStr()) + '\n' +
    '👤 ผู้รับผิดชอบ: ' + tgEsc(td['Sales Name'] || '-')
  );
  return { success: true, id };
}

async function updateTask(td) {
  const doing = td['Doing'] === true;
  const done  = td['Done'] === true;
  const status = done ? 'Done' : doing ? 'Doing' : (td['Task Status'] || 'To Do');
  const patch = { doing, done, task_status: status };
  if (td['Task'] !== undefined)         patch.task = td['Task'];
  if (td['Categories'] !== undefined)   patch.categories = td['Categories'];
  if (td['Notification'] !== undefined) patch.notification = td['Notification'];
  if (td['Action Date'])                patch.action_date = td['Action Date'];
  if (td['Duration'] !== undefined)     patch.duration = td['Duration'];
  if (td['Note'] !== undefined)         patch.note = td['Note'];
  if (td['Sales Name'] !== undefined)   patch.sales_name = td['Sales Name'];
  // ดึงสถานะเดิมก่อนอัปเดต เพื่อเช็คว่าเพิ่งเปลี่ยนเป็น Done หรือไม่
  let wasDone = false;
  try {
    const { data: prev } = await db.from('tasks').select('done, task').eq('id', td['ID']).single();
    if (prev) { wasDone = !!prev.done; if (!td['Task']) td['Task'] = prev.task; }
  } catch (e) {}
  const { data, error } = await db.from('tasks').update(patch).eq('id', td['ID']).select('id, task');
  if (error) return { success: false, error: error.message };
  if (!data || !data.length) return { success: false, error: 'Task not found' };
  // 🔔 แจ้งเตือน: งานเพิ่งเสร็จ (เปลี่ยนจากยังไม่เสร็จ → เสร็จ)
  if (done && !wasDone) {
    await notifyTelegram(
      '✅ <b>งานเสร็จแล้ว</b>\n' +
      '📋 งาน: ' + tgEsc(td['Task'] || (data[0] && data[0].task) || '-') + '\n' +
      '👤 ผู้รับผิดชอบ: ' + tgEsc(td['Sales Name'] || '-')
    );
  }
  return { success: true };
}

async function deleteTask(taskId) {
  const { error } = await db.from('tasks').delete().eq('id', taskId);
  return error ? { success: false, error: error.message } : { success: true };
}

// ============================================================================
//  CATEGORIES
// ============================================================================
async function getCategories() {
  const { data, error } = await db.from('categories').select('*').order('id', { ascending: true });
  if (error) throw error;
  return (data || []).filter(r => r.name).map(r => ({ id: r.id, name: String(r.name) }));
}
async function addCategory(name) {
  const { error } = await db.from('categories').insert({ name });
  return error ? { success: false, error: error.message } : { success: true };
}
async function deleteCategory(id) {
  const { error } = await db.from('categories').delete().eq('id', id);
  return error ? { success: false } : { success: true };
}

// ============================================================================
//  DASHBOARD (งานหลัก)
// ============================================================================
async function getDashboardData(filters) {
  const tasks = await getTasks(filters);
  const sc = { 'To Do': 0, 'Doing': 0, 'Done': 0, 'Cancel': 0 };
  const nc = { 'แจ้งล่วงหน้า': 0, 'ไม่แจ้งล่วงหน้า': 0, 'งานด่วน': 0 };
  const cc = {}, mc = {};
  tasks.forEach(t => {
    const st = t['Task Status'] || 'To Do'; sc[st] = (sc[st] || 0) + 1;
    const nf = t['Notification'] || 'แจ้งล่วงหน้า'; nc[nf] = (nc[nf] || 0) + 1;
    const cat = t['Categories'] || 'อื่นๆ'; cc[cat] = (cc[cat] || 0) + 1;
    const d = new Date(t['Action Date']);
    if (!isNaN(d)) { const k = (d.getMonth() + 1) + '/' + d.getFullYear(); mc[k] = (mc[k] || 0) + 1; }
  });
  const total = tasks.length;
  return { total, statusCounts: sc, notifCounts: nc, catCounts: cc, monthCounts: mc,
           donePercent: total > 0 ? Math.round((sc['Done'] / total) * 100) : 0 };
}

// ============================================================================
//  ATTACHMENTS (Supabase Storage แทน Google Drive)
// ============================================================================
const BUCKET = 'attachments';

async function getTaskAttachments(taskId) {
  const { data } = await db.from('tasks').select('attachments').eq('id', taskId).maybeSingle();
  const list = data && Array.isArray(data.attachments) ? data.attachments : [];
  return list;
}
async function setTaskAttachments(taskId, list) {
  await db.from('tasks').update({ attachments: list }).eq('id', taskId);
}

async function saveAttachment(taskId, fileName, mimeType, base64Data) {
  try {
    const bytes = Buffer.from(base64Data, 'base64');
    // ── สร้าง storage key ที่ปลอดภัย (Supabase รับเฉพาะ a-z 0-9 - _ . /) ──
    // ดึงเฉพาะนามสกุลไฟล์จากชื่อเดิม
    const dot = fileName.lastIndexOf('.');
    let ext = dot > -1 ? fileName.slice(dot + 1) : '';
    ext = ext.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8); // กันนามสกุลแปลกๆ
    const rand = Math.random().toString(36).slice(2, 10);
    const safeName = `${Date.now()}_${rand}${ext ? '.' + ext : ''}`;
    const path = `${taskId}/${safeName}`;
    const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: mimeType, upsert: true });
    if (up.error) return { success: false, error: up.error.message };
    const { data: pub } = db.storage.from(BUCKET).getPublicUrl(path);
    // เก็บ fileName เดิม (ภาษาไทยได้) ไว้ในฟิลด์ name สำหรับแสดงผล/ดาวน์โหลด
    const info = { fileId: path, name: fileName, mimeType, webViewLink: pub.publicUrl, size: bytes.length };
    const list = await getTaskAttachments(taskId);
    list.push(info);
    await setTaskAttachments(taskId, list);
    return { success: true, file: info };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
async function getAttachments(taskId) { return await getTaskAttachments(taskId); }

async function deleteAttachment(taskId, fileId) {
  try { await db.storage.from(BUCKET).remove([fileId]); } catch (e) { /* ignore */ }
  const list = (await getTaskAttachments(taskId)).filter(a => a.fileId !== fileId);
  await setTaskAttachments(taskId, list);
  return { success: true };
}
async function getFileAsBase64(fileId) {
  try {
    const { data, error } = await db.storage.from(BUCKET).download(fileId);
    if (error) return { success: false, error: error.message };
    const buf = Buffer.from(await data.arrayBuffer());
    return { success: true, base64: buf.toString('base64'), mimeType: data.type || 'application/octet-stream', name: fileId.split('/').pop() };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============================================================================
//  WEIGHT JOBS
// ============================================================================
async function getWeightJobs(filters) {
  const { data, error } = await db.from('weight_jobs').select('*');
  if (error) throw error;
  let rows = (data || []).map(r => ({
    _row: r.id, ID: r.id, Date: dstr(r.date), Destination: String(r.destination || ''),
    Items: Array.isArray(r.items) ? r.items : [], TotalWeight: parseFloat(r.total_weight) || 0,
    Note: String(r.note || ''), CreatedDate: dstr(r.created_date)
  }));
  if (filters) {
    if (filters.destination && filters.destination.trim()) {
      const kw = filters.destination.toLowerCase();
      rows = rows.filter(r => r.Destination.toLowerCase().includes(kw));
    }
    if (filters.dateFrom) { const f = new Date(filters.dateFrom); rows = rows.filter(r => { const d = new Date(r.Date); return !isNaN(d) && d >= f; }); }
    if (filters.dateTo)   { const t = new Date(filters.dateTo + 'T23:59:59'); rows = rows.filter(r => { const d = new Date(r.Date); return !isNaN(d) && d <= t; }); }
  }
  rows.sort((a, b) => new Date(b.Date) - new Date(a.Date));
  return rows;
}
async function saveWeightJob(jobData) {
  const items = jobData.Items || [];
  const total = items.reduce((s, it) => s + (parseFloat(it.total) || 0), 0);
  if (jobData.ID) {
    const { data, error } = await db.from('weight_jobs').update({
      date: jobData.Date || todayStr(), destination: jobData.Destination || '', items, total_weight: total, note: jobData.Note || ''
    }).eq('id', jobData.ID).select('id');
    if (error) return { success: false, error: error.message };
    if (!data || !data.length) return { success: false, error: 'Job not found' };
    return { success: true, id: jobData.ID, totalWeight: total };
  }
  const id = rid('W', 4);
  const { error } = await db.from('weight_jobs').insert({ id, date: jobData.Date || todayStr(), destination: jobData.Destination || '', items, total_weight: total, note: jobData.Note || '' });
  if (error) return { success: false, error: error.message };
  return { success: true, id, totalWeight: total };
}
async function deleteWeightJob(jobId) {
  const { error } = await db.from('weight_jobs').delete().eq('id', jobId);
  return error ? { success: false, error: error.message } : { success: true };
}

// ============================================================================
//  PRODUCTS
// ============================================================================
async function getProducts() {
  const { data, error } = await db.from('products').select('*');
  if (error) throw error;
  return (data || []).filter(r => r.id && r.name).map(r => ({
    id: String(r.id), name: String(r.name), unit: String(r.unit || ''),
    weightPerUnit: parseFloat(r.weight_per_unit) || 0, note: String(r.note || '')
  })).sort((a, b) => a.name.localeCompare(b.name, 'th'));
}
async function saveProduct(data) {
  if (data.id) {
    const { data: d, error } = await db.from('products').update({
      name: data.name, unit: data.unit, weight_per_unit: parseFloat(data.weightPerUnit) || 0, note: data.note || ''
    }).eq('id', data.id).select('id');
    if (error) return { success: false, error: error.message };
    if (!d || !d.length) return { success: false, error: 'Product not found' };
    return { success: true };
  }
  const id = rid('P', 3);
  const { error } = await db.from('products').insert({ id, name: data.name, unit: data.unit, weight_per_unit: parseFloat(data.weightPerUnit) || 0, note: data.note || '' });
  if (error) return { success: false, error: error.message };
  return { success: true, id };
}
async function deleteProduct(id) {
  const { error } = await db.from('products').delete().eq('id', id);
  return error ? { success: false } : { success: true };
}

// ============================================================================
//  LOEDAROON PO
// ============================================================================
async function getLoedaroonItems(filters) {
  const { data, error } = await db.from('loedaroon_po').select('*');
  if (error) throw error;
  let rows = (data || []).map(r => {
    const calls = Array.isArray(r.calls) ? r.calls : [];
    const orderQty = parseFloat(r.order_qty) || 0;
    const totalCalled = calls.reduce((s, c) => s + (parseFloat(c.qty) || 0), 0);
    return {
      _row: r.id, ID: String(r.id), PO_Number: String(r.po_number), Product: String(r.product),
      Unit: String(r.unit), OrderQty: orderQty, Calls: calls, TotalCalled: totalCalled,
      Remaining: orderQty - totalCalled, Note: String(r.note || ''), CreatedDate: dstr(r.created_date)
    };
  });
  if (filters) {
    if (filters.poNumber) { const k = filters.poNumber.toLowerCase(); rows = rows.filter(r => r.PO_Number.toLowerCase().includes(k)); }
    if (filters.product)  { const k = filters.product.toLowerCase();  rows = rows.filter(r => r.Product.toLowerCase().includes(k)); }
    if (filters.status === 'pending') rows = rows.filter(r => r.Remaining > 0);
    else if (filters.status === 'done') rows = rows.filter(r => r.Remaining <= 0);
  }
  return rows;
}
async function saveLoedaroonItem(data) {
  const calls = data.Calls || [];
  if (data.ID) {
    const { data: d, error } = await db.from('loedaroon_po').update({
      po_number: data.PO_Number, product: data.Product, unit: data.Unit, order_qty: parseFloat(data.OrderQty) || 0, calls, note: data.Note || ''
    }).eq('id', data.ID).select('id');
    if (error) return { success: false, error: error.message };
    if (!d || !d.length) return { success: false, error: 'Item not found' };
    return { success: true };
  }
  const id = rid('LA', 3);
  const { error } = await db.from('loedaroon_po').insert({ id, po_number: data.PO_Number, product: data.Product, unit: data.Unit, order_qty: parseFloat(data.OrderQty) || 0, calls, note: data.Note || '' });
  if (error) return { success: false, error: error.message };
  return { success: true, id };
}
async function addLoedaroonCall(itemId, callData) {
  const { data, error } = await db.from('loedaroon_po').select('calls').eq('id', itemId).maybeSingle();
  if (error || !data) return { success: false, error: 'Item not found' };
  const calls = Array.isArray(data.calls) ? data.calls : [];
  calls.push({ no: calls.length + 1, date: callData.date, qty: parseFloat(callData.qty) || 0 });
  await db.from('loedaroon_po').update({ calls }).eq('id', itemId);
  return { success: true, callNo: calls.length };
}
async function deleteLoedaroonItem(id) {
  const { error } = await db.from('loedaroon_po').delete().eq('id', id);
  return error ? { success: false } : { success: true };
}
async function deleteLoedaroonPO(poNumber) {
  await db.from('loedaroon_po').delete().eq('po_number', poNumber);
  return { success: true };
}

// ============================================================================
//  OT
// ============================================================================
async function getOTEmployees() {
  const { data, error } = await db.from('ot_employees').select('*').neq('active', false).order('id');
  if (error) throw error;
  return (data || []).filter(r => r.id).map(r => ({
    id: String(r.id), name: String(r.name), surname: String(r.surname), nickname: String(r.nickname),
    position: String(r.position), defaultRate: parseFloat(r.default_rate) || 1
  }));
}
async function saveOTEmployee(data) {
  const rate = parseFloat(data.defaultRate) || 1;
  if (data.id) {
    const { data: d, error } = await db.from('ot_employees').update({ name: data.name, surname: data.surname, nickname: data.nickname, position: data.position, default_rate: rate }).eq('id', data.id).select('id');
    if (error) return { success: false, error: error.message };
    if (!d || !d.length) return { success: false, error: 'Not found' };
    return { success: true };
  }
  const { count } = await db.from('ot_employees').select('*', { count: 'exact', head: true });
  const id = 'EMP' + pad((count || 0) + 1, 3);
  const { error } = await db.from('ot_employees').insert({ id, name: data.name, surname: data.surname, nickname: data.nickname, position: data.position, default_rate: rate, active: true });
  if (error) return { success: false, error: error.message };
  return { success: true, id };
}
async function deleteOTEmployee(id) {
  const { error } = await db.from('ot_employees').update({ active: false }).eq('id', id);
  return error ? { success: false } : { success: true };
}
async function getOTData(params) {
  const employees = await getOTEmployees();
  let dateFrom, dateTo;
  if (params.dateFrom && params.dateTo) { dateFrom = new Date(params.dateFrom); dateTo = new Date(params.dateTo + 'T23:59:59'); }
  else {
    const y = parseInt(params.year) || new Date().getFullYear();
    const m = parseInt(params.month) || (new Date().getMonth() + 1);
    dateFrom = new Date(y, m - 1, 1); dateTo = new Date(y, m, 0, 23, 59, 59);
  }
  const { data } = await db.from('ot_records').select('*');
  const records = [];
  (data || []).forEach(r => {
    if (!r.id) return;
    const d = new Date(r.date);
    if (isNaN(d) || d < dateFrom || d > dateTo) return;
    records.push({ id: String(r.id), empId: String(r.emp_id), date: dstr(r.date), hours: parseFloat(r.hours) || 0, rate: parseFloat(r.rate) || 1, note: String(r.note || '') });
  });
  return { employees, records, dateFrom: dstr(dateFrom), dateTo: dstr(dateTo) };
}
async function saveOTRecord(data) {
  const hours = parseFloat(data.hours) || 0;
  const rate  = parseFloat(data.rate) || 1;
  const ds = dstr(data.date);
  const { data: ex } = await db.from('ot_records').select('id').eq('emp_id', data.empId).eq('date', ds).maybeSingle();
  if (ex) {
    await db.from('ot_records').update({ hours, rate, note: data.note || '' }).eq('id', ex.id);
    return { success: true, id: ex.id, updated: true };
  }
  const id = 'OTR' + Date.now().toString(36).toUpperCase();
  await db.from('ot_records').insert({ id, emp_id: data.empId, date: ds, hours, rate, note: data.note || '' });
  return { success: true, id, updated: false };
}
async function deleteOTRecord(id) {
  const { error } = await db.from('ot_records').delete().eq('id', id);
  return error ? { success: false } : { success: true };
}

// ============================================================================
//  EMP ATTENDANCE
// ============================================================================
async function getEMPStaff(includeInactive) {
  let q = db.from('emp_staff').select('*').order('id');
  if (!includeInactive) q = q.neq('active', false);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).filter(r => r.id).map(r => ({
    id: String(r.id), name: String(r.name), surname: String(r.surname), nickname: String(r.nickname),
    position: String(r.position), department: String(r.department),
    annualLeave: parseFloat(r.annual_leave) || 0, personalLeave: parseFloat(r.personal_leave) || 0,
    sickLeave: parseFloat(r.sick_leave) || 0, startDate: dstr(r.start_date)
  }));
}
async function saveEMPStaff(data) {
  const al = parseFloat(data.annualLeave) || 0, pl = parseFloat(data.personalLeave) || 0, sl = parseFloat(data.sickLeave) || 0;
  const sd = data.startDate || null;
  if (data.id) {
    const { data: d, error } = await db.from('emp_staff').update({
      name: data.name, surname: data.surname, nickname: data.nickname, position: data.position,
      department: data.department || '', annual_leave: al, personal_leave: pl, sick_leave: sl, start_date: sd
    }).eq('id', data.id).select('id');
    if (error) return { success: false, error: error.message };
    if (!d || !d.length) return { success: false, error: 'Not found' };
    return { success: true };
  }
  const { count } = await db.from('emp_staff').select('*', { count: 'exact', head: true });
  const id = 'E' + pad((count || 0) + 1, 3);
  const { error } = await db.from('emp_staff').insert({ id, name: data.name, surname: data.surname, nickname: data.nickname, position: data.position, department: data.department || '', annual_leave: al, personal_leave: pl, sick_leave: sl, active: true, start_date: sd });
  if (error) return { success: false, error: error.message };
  return { success: true, id };
}
async function deleteEMPStaff(id) {
  const { error } = await db.from('emp_staff').update({ active: false }).eq('id', id);
  return error ? { success: false } : { success: true };
}
async function getEMPAttendanceData(params) {
  const staff = await getEMPStaff();
  let dateFrom, dateTo;
  if (params.dateFrom && params.dateTo) { dateFrom = new Date(params.dateFrom); dateTo = new Date(params.dateTo + 'T23:59:59'); }
  else {
    const y = parseInt(params.year) || new Date().getFullYear();
    const m = parseInt(params.month) || (new Date().getMonth() + 1);
    dateFrom = new Date(y, m - 1, 1); dateTo = new Date(y, m, 0, 23, 59, 59);
  }
  const yrStart = new Date(dateFrom.getFullYear(), 0, 1);
  const yrEnd   = new Date(dateFrom.getFullYear(), 11, 31, 23, 59, 59);
  const { data } = await db.from('emp_attendance').select('*');
  const records = [], yearRecs = [];
  (data || []).forEach(row => {
    if (!row.id) return;
    const d = new Date(row.date); if (isNaN(d)) return;
    const rec = { id: String(row.id), empId: String(row.emp_id), date: dstr(row.date), status: String(row.status), hours: parseFloat(row.hours) || 0, note: String(row.note || '') };
    if (d >= dateFrom && d <= dateTo) records.push(rec);
    if (d >= yrStart && d <= yrEnd)   yearRecs.push(rec);
  });
  const yearlyUsed = {};
  staff.forEach(e => { yearlyUsed[e.id] = { AL: 0, PL: 0, SL: 0, L: 0, A: 0, P: 0, H: 0 }; });
  yearRecs.forEach(r => {
    if (!yearlyUsed[r.empId]) return;
    const u = yearlyUsed[r.empId], h = r.hours || 0;
    if (r.status === 'AL') u.AL += h; else if (r.status === 'PL') u.PL += h;
    else if (r.status === 'SL') u.SL += h; else if (r.status === 'L') u.L++;
    else if (r.status === 'A') u.A++; else if (r.status === 'P') u.P++;
    else if (r.status === 'H') u.H++;
  });
  return { staff, records, yearlyUsed, dateFrom: dstr(dateFrom), dateTo: dstr(dateTo), year: dateFrom.getFullYear() };
}
async function saveEMPAttendance(data) {
  const hours = parseFloat(data.hours) || (data.status === 'H' ? 0 : 8);
  const ds = dstr(data.date);
  const { data: ex } = await db.from('emp_attendance').select('id').eq('emp_id', data.empId).eq('date', ds).maybeSingle();
  if (ex) {
    await db.from('emp_attendance').update({ status: data.status, hours, note: data.note || '' }).eq('id', ex.id);
    return { success: true, id: ex.id, updated: true };
  }
  const id = 'ATT' + Date.now().toString(36).toUpperCase();
  await db.from('emp_attendance').insert({ id, emp_id: data.empId, date: ds, status: data.status, hours, note: data.note || '' });
  return { success: true, id, updated: false };
}
async function deleteEMPAttendance(id) {
  const { error } = await db.from('emp_attendance').delete().eq('id', id);
  return error ? { success: false } : { success: true };
}

// ============================================================================
//  KPI RECORDS (เดิม)
// ============================================================================
async function getKPIRecords(filters) {
  const { data, error } = await db.from('kpi_records').select('*');
  if (error) throw error;
  let rows = (data || []).filter(r => r.id).map(r => ({
    id: String(r.id), employeeName: String(r.employee_name), position: String(r.position), department: String(r.department),
    evalDate: dstr(r.eval_date), kpiItems: Array.isArray(r.kpi_data) ? r.kpi_data : [],
    passThreshold: parseFloat(r.pass_threshold) || 70, photoURL: String(r.photo_url || ''), createdDate: dstr(r.created_date)
  }));
  if (filters && filters.name) {
    const kw = filters.name.toLowerCase();
    rows = rows.filter(r => r.employeeName.toLowerCase().includes(kw) || r.department.toLowerCase().includes(kw));
  }
  rows.sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
  return rows;
}
async function saveKPIRecord(data) {
  const thr = parseFloat(data.passThreshold) || 70;
  if (data.id) {
    const { data: d, error } = await db.from('kpi_records').update({
      employee_name: data.employeeName, position: data.position, department: data.department,
      eval_date: data.evalDate || todayStr(), kpi_data: data.kpiItems || [], pass_threshold: thr, photo_url: data.photoURL || ''
    }).eq('id', data.id).select('id');
    if (error) return { success: false, error: error.message };
    if (!d || !d.length) return { success: false, error: 'Not found' };
    return { success: true };
  }
  const id = rid('KPI', 3);
  const { error } = await db.from('kpi_records').insert({ id, employee_name: data.employeeName, position: data.position, department: data.department, eval_date: data.evalDate || todayStr(), kpi_data: data.kpiItems || [], pass_threshold: thr, photo_url: data.photoURL || '' });
  if (error) return { success: false, error: error.message };
  return { success: true, id };
}
async function deleteKPIRecord(id) {
  const { error } = await db.from('kpi_records').delete().eq('id', id);
  return error ? { success: false } : { success: true };
}

// ============================================================================
//  WIRE NOTES
// ============================================================================
async function getWireNotes() {
  const { data, error } = await db.from('wire_notes').select('*').order('id');
  if (error) throw error;
  const aknee = [], mark = [];
  (data || []).filter(r => r.id).forEach(r => {
    const item = { id: String(r.id), type: String(r.type), size: String(r.size), brand: String(r.brand), length: String(r.length), note: String(r.note || '') };
    if (String(r.company) === 'อาคเนย์') aknee.push(item);
    else if (String(r.company) === 'เมิร์ค') mark.push(item);
  });
  return { aknee, mark };
}
async function saveWireNotesBatch(data) {
  const company = data.company;
  await db.from('wire_notes').delete().eq('company', company);
  const newRows = data.rows || [];
  if (newRows.length > 0) {
    const vals = newRows.map((r, i) => ({
      id: 'WN' + Date.now().toString(36).toUpperCase() + i,
      company, type: r.type || '', size: r.size || '', brand: r.brand || '', length: String(r.length || ''), note: r.note || ''
    }));
    const { error } = await db.from('wire_notes').insert(vals);
    if (error) return { success: false, error: error.message };
  }
  return { success: true };
}

// ============================================================================
//  KPI v2 (KPI_Staff / KPI_Monthly)
// ============================================================================
async function getKPIStaff() {
  const { data, error } = await db.from('kpi_staff').select('*').neq('active', false).order('id');
  if (error) throw error;
  return (data || []).filter(r => r.id).map(r => ({
    id: String(r.id), name: String(r.name), surname: String(r.surname), position: String(r.position),
    department: String(r.department), avatarColor: String(r.avatar_color || '#3b82f6'), startDate: dstr(r.start_date)
  }));
}
async function saveKPIStaff(data) {
  const cols = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1'];
  const sd = data.startDate || null;
  if (data.id) {
    const { data: d, error } = await db.from('kpi_staff').update({ name: data.name, surname: data.surname, position: data.position, department: data.department || 'คลังสินค้า', start_date: sd }).eq('id', data.id).select('id');
    if (error) return { success: false, error: error.message };
    if (!d || !d.length) return { success: false, error: 'Not found' };
    return { success: true };
  }
  const { count } = await db.from('kpi_staff').select('*', { count: 'exact', head: true });
  const cnt = count || 0;
  const id = 'E' + pad(cnt + 1, 3);
  const { error } = await db.from('kpi_staff').insert({ id, name: data.name, surname: data.surname, position: data.position, department: data.department || 'คลังสินค้า', avatar_color: cols[cnt % cols.length], active: true, start_date: sd });
  if (error) return { success: false, error: error.message };
  return { success: true, id };
}
async function deleteKPIStaff(id) {
  const { error } = await db.from('kpi_staff').update({ active: false }).eq('id', id);
  return error ? { success: false } : { success: true };
}
async function getKPIByEmpMonth(params) {
  const empId = String(params.empId), month = parseInt(params.month), year = parseInt(params.year);
  const { data } = await db.from('kpi_monthly').select('*').eq('emp_id', empId);
  const rows = (data || []).filter(r => r.id);
  const exact = rows.find(r => parseInt(r.month) === month && parseInt(r.year) === year);
  if (exact) return { found: true, id: String(exact.id), kpiItems: Array.isArray(exact.kpi_data) ? exact.kpi_data : [], passThreshold: parseFloat(exact.pass_threshold) || 70 };
  const empRows = rows.slice().sort((a, b) => (parseInt(b.year) * 100 + parseInt(b.month)) - (parseInt(a.year) * 100 + parseInt(a.month)));
  if (empRows.length > 0) {
    const latest = empRows[0];
    const items = Array.isArray(latest.kpi_data) ? latest.kpi_data : [];
    const tpl = items.map(k => ({ name: k.name, target: k.target, maxScore: k.maxScore, score: 0, note: '' }));
    return { found: false, template: true, kpiItems: tpl, passThreshold: parseFloat(latest.pass_threshold) || 70 };
  }
  return { found: false, template: false, kpiItems: [], passThreshold: 70 };
}
async function saveKPIByEmpMonth(data) {
  const empId = String(data.empId), month = parseInt(data.month), year = parseInt(data.year);
  const thr = parseFloat(data.passThreshold) || 70;
  const { data: ex } = await db.from('kpi_monthly').select('id').eq('emp_id', empId).eq('month', month).eq('year', year).maybeSingle();
  if (ex) {
    await db.from('kpi_monthly').update({ emp_name: data.empName, kpi_data: data.kpiItems || [], pass_threshold: thr }).eq('id', ex.id);
    return { success: true, id: ex.id };
  }
  const id = rid('KPR', 2);
  await db.from('kpi_monthly').insert({ id, emp_id: empId, emp_name: data.empName, month, year, kpi_data: data.kpiItems || [], pass_threshold: thr });
  return { success: true, id };
}
async function getKPIMonthHistory(empId) {
  const { data } = await db.from('kpi_monthly').select('*').eq('emp_id', String(empId));
  return (data || []).filter(r => r.id).map(r => {
    const items = Array.isArray(r.kpi_data) ? r.kpi_data : [];
    const tMax = items.reduce((s, k) => s + (parseFloat(k.maxScore) || 0), 0);
    const tScore = items.reduce((s, k) => s + (parseFloat(k.score) || 0), 0);
    return { month: parseInt(r.month), year: parseInt(r.year), totMax: tMax, totScore: tScore, pct: tMax > 0 ? Math.round(tScore / tMax * 100) : 0 };
  }).sort((a, b) => (a.year * 100 + a.month) - (b.year * 100 + b.month));
}

// ============================================================================
//  DASHBOARD SUMMARY (รวมทุกโมดูล)
// ============================================================================
async function getDashSummary() {
  const now = new Date(); const month = now.getMonth() + 1, year = now.getFullYear();

  // KPI
  const kpi = { totalStaff: 0, pass: 0, fail: 0, avgScore: 0, evaluated: 0, employees: [] };
  try {
    const { count } = await db.from('kpi_staff').select('*', { count: 'exact', head: true }).neq('active', false);
    kpi.totalStaff = count || 0;
    const { data: km } = await db.from('kpi_monthly').select('*').eq('month', month).eq('year', year);
    let tot = 0;
    (km || []).filter(r => r.id).forEach(r => {
      const items = Array.isArray(r.kpi_data) ? r.kpi_data : [];
      const mx = items.reduce((s, k) => s + (parseFloat(k.maxScore) || 0), 0);
      const sc = items.reduce((s, k) => s + (parseFloat(k.score) || 0), 0);
      const pct = mx > 0 ? Math.round(sc / mx * 100) : 0;
      if (pct >= (parseFloat(r.pass_threshold) || 70)) kpi.pass++; else kpi.fail++;
      tot += pct; kpi.evaluated++;
      kpi.employees.push({ name: String(r.emp_name), pct, pass: pct >= (parseFloat(r.pass_threshold) || 70) });
    });
    kpi.avgScore = kpi.evaluated > 0 ? Math.round(tot / kpi.evaluated) : 0;
  } catch (e) { /* */ }

  // Attendance
  const att = { totalStaff: 0, P: 0, L: 0, AL: 0, PL: 0, SL: 0, A: 0, H: 0, workDays: 0 };
  try {
    const { count } = await db.from('emp_staff').select('*', { count: 'exact', head: true });
    att.totalStaff = count || 0;
    const { data: ea } = await db.from('emp_attendance').select('*');
    (ea || []).filter(r => r.id).forEach(r => {
      const d = new Date(r.date); if (isNaN(d)) return;
      if (d.getMonth() + 1 === month && d.getFullYear() === year) {
        const st = String(r.status);
        if (att[st] !== undefined) att[st]++;
        if (st === 'P' || st === 'L') att.workDays++;
      }
    });
  } catch (e) { /* */ }

  // OT
  const ot = { totalHours: 0, records: 0, byEmp: {} };
  try {
    const { data: otr } = await db.from('ot_records').select('*');
    (otr || []).filter(r => r.id).forEach(r => {
      const d = new Date(r.date); if (isNaN(d)) return;
      if (d.getMonth() + 1 === month && d.getFullYear() === year) {
        const hrs = parseFloat(r.hours) || 0; ot.totalHours += hrs; ot.records++;
        const nm = String(r.emp_id || '?'); ot.byEmp[nm] = (ot.byEmp[nm] || 0) + hrs;
      }
    });
  } catch (e) { /* */ }

  // Wire
  const wire = { total: 0, aknee: 0, mark: 0 };
  try {
    const { data: ws } = await db.from('wire_notes').select('company');
    (ws || []).forEach(r => { wire.total++; if (r.company === 'อาคเนย์') wire.aknee++; else if (r.company === 'เมิร์ค') wire.mark++; });
  } catch (e) { /* */ }

  // Loedaroon PO
  const po = { total: 0, pending: 0, called: 0 };
  try {
    const { data: ls } = await db.from('loedaroon_po').select('calls');
    (ls || []).forEach(r => {
      po.total++;
      const calls = Array.isArray(r.calls) ? r.calls : [];
      if (calls.length > 0) po.called++; else po.pending++;
    });
  } catch (e) { /* */ }

  return { month, year, kpi, att, ot, wire, po };
}

// ============================================================================
//  WAREHOUSE DASHBOARD (เก็บ JSON ราย เดือน/ปี)
// ============================================================================
function whDefaults(month, year) {
  return { month, year, found: false,
    orders: 220 + (month * 3), ordersComplete: Math.round((220 + (month * 3)) * 0.94),
    onTimeDelivery: 92 + Math.round(month / 2), pickingAccuracy: 97 + Math.round(month / 6),
    inventoryAccuracy: 95 + Math.round(month / 4), fulfillmentRate: 93 + Math.round(month / 3),
    productivity: 78 + month, stockDamage: 1.2 - month * 0.05, spaceUtil: 72 + Math.round(month / 3),
    returnRate: 2.1 - month * 0.05, transportCost: 85 + Math.round(month / 2), stockAccuracy: 96 + Math.round(month / 4),
    pending: 18, picking: 32, packing: 45, shipping: 28, delivered: Math.round((220 + (month * 3)) * 0.94), returns: 8, delayed: 12,
    totalKPI: 89 + Math.round(month / 3) };
}
async function getWHDashData(params) {
  const month = parseInt(params.month) || new Date().getMonth() + 1;
  const year  = parseInt(params.year) || new Date().getFullYear();
  const { data } = await db.from('wh_dashboard').select('*').eq('month', month).eq('year', year).maybeSingle();
  if (!data) return whDefaults(month, year);
  const d = (data.data && typeof data.data === 'object') ? data.data : {};
  return Object.assign(whDefaults(month, year), d, { month, year, found: true });
}
async function saveWHDashData(data) {
  const month = parseInt(data.month), year = parseInt(data.year);
  const metrics = data.metrics || {};
  const { data: ex } = await db.from('wh_dashboard').select('id').eq('month', month).eq('year', year).maybeSingle();
  if (ex) { await db.from('wh_dashboard').update({ data: metrics, updated_at: new Date().toISOString() }).eq('id', ex.id); return { success: true }; }
  const { count } = await db.from('wh_dashboard').select('*', { count: 'exact', head: true });
  const id = 'WH' + pad(count || 0, 4);
  await db.from('wh_dashboard').insert({ id, month, year, data: metrics });
  return { success: true };
}
async function getWHYearData(year) {
  year = parseInt(year);
  const { data } = await db.from('wh_dashboard').select('*').eq('year', year);
  const map = {}; (data || []).forEach(r => { map[parseInt(r.month)] = r.data || {}; });
  const result = [];
  for (let m = 1; m <= 12; m++) result.push(Object.assign(whDefaults(m, year), map[m] || {}));
  return result;
}

// ============================================================================
//  KPI FORM (FM-MR-03)
// ============================================================================
async function getKPIForm(params) {
  const month = parseInt(params.month), year = parseInt(params.year);
  const { data } = await db.from('kpi_form').select('*').eq('month', month).eq('year', year).maybeSingle();
  if (!data) return { found: false };
  const d = (data.data && typeof data.data === 'object') ? data.data : {};
  return Object.assign({ found: true, month, year }, d);
}
async function saveKPIForm(data) {
  const month = parseInt(data.month), year = parseInt(data.year);
  const { data: ex } = await db.from('kpi_form').select('id').eq('month', month).eq('year', year).maybeSingle();
  if (ex) { await db.from('kpi_form').update({ data, updated_at: new Date().toISOString() }).eq('id', ex.id); return { success: true }; }
  const { count } = await db.from('kpi_form').select('*', { count: 'exact', head: true });
  const id = 'KF' + pad(count || 0, 4);
  await db.from('kpi_form').insert({ id, month, year, data });
  return { success: true };
}

// ============================================================================
//  TELEGRAM: ประมวลผลคำสั่งที่พิมพ์ในกลุ่ม แล้วตอบกลับ
// ============================================================================
async function handleTelegramCommand(text) {
  const raw = String(text || '').trim();
  // ตัด @botname ออก (กรณีพิมพ์ /help@mybot)
  const cleaned = raw.replace(/@\w+/g, '').trim();
  const lower = cleaned.toLowerCase();
  const today = todayStr();

  // /help
  if (lower === '/help' || cleaned === '/ช่วยเหลือ' || lower === '/start') {
    return (
      '🤖 <b>คำสั่งที่ใช้ได้</b>\n\n' +
      '📊 /สรุป — สรุปจำนวนงานทั้งหมด\n' +
      '📅 /งานวันนี้ — งานครบกำหนดวันนี้\n' +
      '📅 /งานพรุ่งนี้ — งานครบกำหนดพรุ่งนี้\n' +
      '📅 /งานสัปดาห์นี้ — งานใน 7 วันข้างหน้า\n' +
      '📋 /งานค้าง — งานที่ยังไม่เสร็จ\n' +
      '🔴 /เลยกำหนด — งานที่เลยกำหนดแล้ว\n' +
      '✅ /งานเสร็จวันนี้ — งานที่เสร็จวันนี้\n' +
      '📦 /งานรับ — งานประเภทรับ (เพิ่มวันที่ได้ เช่น /งานรับ วันที่ 4/6/2026)\n' +
      '🚚 /งานส่ง — งานประเภทส่ง (เพิ่มวันที่ได้)\n' +
      '👤 /งานของ [ชื่อ] — เช่น /งานของ สมชาย\n' +
      '🗓️ /งานวันที่ [วันที่] — เช่น /งานวันที่ 4/6/2026\n' +
      '📈 /kpi [ชื่อ] — KPI พนักงาน เช่น /kpi สมชาย\n' +
      '🔍 /ค้นหา [คำ] — ค้นหางาน เช่น /ค้นหา ชุบ'
    );
  }

  // helper: format รายการงาน (บรรทัดเดียว — สำหรับกรณีพิเศษ)
  const fmtList = (title, list, lineFn, limit = 20) => {
    if (!list.length) return null;
    let m = title.replace('{n}', list.length) + '\n\n';
    list.slice(0, limit).forEach((t, i) => { m += (i + 1) + '. ' + lineFn(t) + '\n'; });
    if (list.length > limit) m += '\n…และอีก ' + (list.length - limit) + ' งาน';
    return m;
  };

  // helper: แสดงงานแบบละเอียด (หลายบรรทัดต่อ 1 งาน)
  const statusEmoji = (t) => t.done ? '✅' : (t.task_status === 'Doing' ? '🟣' : '🔵');
  const taskDetail = (t) => {
    let s = '📋 <b>' + tgEsc(t.task || '-') + '</b>\n';
    s += '   ' + statusEmoji(t) + ' ' + tgEsc(t.done ? 'Done' : (t.task_status || 'To Do'));
    if (t.duration) s += ' · ' + (t.duration === 'รับ' ? '📦' : t.duration === 'ส่ง' ? '🚚' : '🔹') + ' ' + tgEsc(t.duration);
    s += '\n';
    if (t.categories) s += '   🏷️ ' + tgEsc(t.categories) + '\n';
    if (t.action_date) s += '   📅 ' + tgEsc(dstr(t.action_date)) + '\n';
    if (t.sales_name) s += '   👤 ' + tgEsc(t.sales_name) + '\n';
    if (t.note) s += '   📝 ' + tgEsc(t.note) + '\n';
    return s;
  };
  // รายการงานแบบละเอียด
  const fmtDetail = (title, list, limit = 15) => {
    if (!list.length) return null;
    let m = title.replace('{n}', list.length) + '\n\n';
    list.slice(0, limit).forEach((t, i) => { m += (i + 1) + '. ' + taskDetail(t) + '\n'; });
    if (list.length > limit) m += '…และอีก ' + (list.length - limit) + ' งาน';
    return m;
  };
  const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

  // แปลงวันที่จากหลายรูปแบบ → YYYY-MM-DD (คืน null ถ้าไม่ถูกต้อง)
  // รองรับ: 4/6/2026, 4-6-2026, 2026-06-04, 04/06/2569 (พ.ศ.)
  const parseDate = (s) => {
    if (!s) return null;
    s = s.trim();
    // รูปแบบ ISO อยู่แล้ว: YYYY-MM-DD
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      let [, y, mo, d] = m; y = +y;
      if (y >= 2500) y -= 543; // พ.ศ. → ค.ศ.
      return y + '-' + pad(+mo, 2) + '-' + pad(+d, 2);
    }
    // รูปแบบ วัน/เดือน/ปี หรือ วัน-เดือน-ปี
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (m) {
      let [, d, mo, y] = m; y = +y;
      if (y < 100) y += 2000;        // 26 → 2026
      if (y >= 2500) y -= 543;       // พ.ศ. → ค.ศ.
      if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
      return y + '-' + pad(+mo, 2) + '-' + pad(+d, 2);
    }
    return null;
  };
  // ดึงส่วนวันที่ออกจากคำสั่ง รองรับทั้ง "วันที่ 4/6/2026" และ "4/6/2026"
  const extractDate = (str) => {
    const cleaned2 = str.replace(/วันที่/g, ' ').trim();
    const tok = cleaned2.split(/\s+/).filter(Boolean);
    for (const t of tok) { const p = parseDate(t); if (p) return p; }
    return null;
  };

  // /สรุป
  if (cleaned === '/สรุป' || lower === '/summary') {
    const { data } = await db.from('tasks').select('task_status, done');
    const list = data || [];
    const todo = list.filter(t => !t.done && t.task_status === 'To Do').length;
    const doing = list.filter(t => !t.done && t.task_status === 'Doing').length;
    const done = list.filter(t => t.done).length;
    return (
      '📊 <b>สรุปงานทั้งหมด</b>\n\n' +
      '📋 ทั้งหมด: ' + list.length + ' งาน\n' +
      '🔵 To Do: ' + todo + '\n' +
      '🟣 Doing: ' + doing + '\n' +
      '✅ Done: ' + done
    );
  }

  // /งานวันนี้
  if (cleaned === '/งานวันนี้' || lower === '/today') {
    const { data } = await db.from('tasks').select('*')
      .eq('done', false).eq('action_date', today).order('seq', { ascending: true });
    return fmtDetail('🟡 <b>งานครบกำหนดวันนี้ ({n})</b>', data || [])
      || '🟢 วันนี้ไม่มีงานครบกำหนดครับ';
  }

  // /งานพรุ่งนี้
  if (cleaned === '/งานพรุ่งนี้' || lower === '/tomorrow') {
    const tmr = addDays(1);
    const { data } = await db.from('tasks').select('*')
      .eq('done', false).eq('action_date', tmr).order('seq', { ascending: true });
    return fmtDetail('🟠 <b>งานครบกำหนดพรุ่งนี้ (' + tmr + ') ({n})</b>', data || [])
      || '🟢 พรุ่งนี้ไม่มีงานครบกำหนดครับ';
  }

  // /งานสัปดาห์นี้ (7 วันข้างหน้า)
  if (cleaned === '/งานสัปดาห์นี้' || lower === '/week') {
    const end = addDays(7);
    const { data } = await db.from('tasks').select('*')
      .eq('done', false).gte('action_date', today).lte('action_date', end)
      .order('action_date', { ascending: true });
    return fmtDetail('📅 <b>งานใน 7 วันข้างหน้า ({n})</b>', data || [])
      || '🟢 สัปดาห์นี้ไม่มีงานครบกำหนดครับ';
  }

  // /งานเสร็จวันนี้
  if (cleaned === '/งานเสร็จวันนี้' || lower === '/donetoday') {
    const { data } = await db.from('tasks').select('*')
      .eq('done', true).eq('action_date', today).order('seq', { ascending: true });
    return fmtDetail('✅ <b>งานเสร็จวันนี้ ({n})</b>', data || [])
      || 'ยังไม่มีงานที่เสร็จในวันนี้ครับ';
  }

  // /งานค้าง
  if (cleaned === '/งานค้าง' || lower === '/pending') {
    const { data } = await db.from('tasks').select('*')
      .eq('done', false).order('action_date', { ascending: true });
    return fmtDetail('📋 <b>งานค้าง ({n})</b>', data || [])
      || '🎉 ไม่มีงานค้างครับ ทุกงานเสร็จหมดแล้ว';
  }

  // /เลยกำหนด
  if (cleaned === '/เลยกำหนด' || lower === '/overdue') {
    const { data } = await db.from('tasks').select('*')
      .eq('done', false).lt('action_date', today).order('action_date', { ascending: true });
    return fmtDetail('🔴 <b>งานเลยกำหนด ({n})</b>', data || [])
      || '🟢 ไม่มีงานเลยกำหนดครับ';
  }

  // /งานรับ , /งานส่ง  (รองรับระบุวันที่: /งานรับ วันที่ 4/6/2026)
  if (cleaned.startsWith('/งานรับ') || cleaned.startsWith('/งานส่ง')) {
    const isRap = cleaned.startsWith('/งานรับ');
    const dur = isRap ? 'รับ' : 'ส่ง';
    const rest = cleaned.replace(/^\/งาน(รับ|ส่ง)/, '').trim();
    const dArg = rest ? extractDate(rest) : null;
    if (rest && !dArg) return 'รูปแบบวันที่ไม่ถูกต้องครับ ลองใหม่ เช่น /งาน' + dur + ' วันที่ 4/6/2026';

    let q = db.from('tasks').select('*').eq('duration', dur);
    if (dArg) {
      q = q.eq('action_date', dArg);                 // ระบุวันที่ → เอาทุกสถานะของวันนั้น
    } else {
      q = q.eq('done', false);                        // ไม่ระบุวันที่ → เฉพาะที่ยังไม่เสร็จ
    }
    const { data } = await q.order('action_date', { ascending: true });
    const titleDate = dArg ? ' วันที่ ' + dArg : ' (ที่ยังไม่เสร็จ)';
    return fmtDetail('📦 <b>งาน' + dur + titleDate + ' ({n})</b>', data || [])
      || '🟢 ไม่มีงาน' + dur + (dArg ? ' วันที่ ' + dArg : 'ที่ค้าง') + 'ครับ';
  }

  // /งานของ [ชื่อ]
  if (cleaned.startsWith('/งานของ')) {
    const name = cleaned.replace(/^\/งานของ/, '').trim();
    if (!name) return 'พิมพ์ชื่อผู้รับผิดชอบด้วยครับ เช่น /งานของ สมชาย';
    const { data } = await db.from('tasks').select('*')
      .order('action_date', { ascending: true });
    const k = name.toLowerCase();
    const list = (data || []).filter(t => (t.sales_name || '').toLowerCase().includes(k));
    return fmtDetail('👤 <b>งานของ "' + tgEsc(name) + '" ({n})</b>', list)
      || '🔍 ไม่พบงานของ "' + tgEsc(name) + '"';
  }

  // /งานวันที่ [วันที่]  รองรับ 4/6/2026, 4-6-2569, 2026-06-04
  if (cleaned.startsWith('/งานวันที่') || lower.startsWith('/date')) {
    const dRaw = cleaned.replace(/^\/งานวันที่/, '').replace(/^\/date/i, '').trim();
    const dArg = extractDate(dRaw);
    if (!dArg) return 'พิมพ์วันที่ให้ถูกต้องครับ เช่น /งานวันที่ 4/6/2026 หรือ /งานวันที่ 2026-06-04';
    const { data } = await db.from('tasks').select('*')
      .eq('action_date', dArg).order('seq', { ascending: true });
    return fmtDetail('🗓️ <b>งานวันที่ ' + dArg + ' ({n})</b>', data || [])
      || '🟢 วันที่ ' + dArg + ' ไม่มีงานครับ';
  }

  // /kpi [ชื่อ]
  if (lower.startsWith('/kpi') || cleaned.startsWith('/เคพีไอ')) {
    const name = cleaned.replace(/^\/kpi/i, '').replace(/^\/เคพีไอ/, '').trim();
    if (!name) return 'พิมพ์ชื่อพนักงานด้วยครับ เช่น /kpi สมชาย';
    // หาพนักงานจากชื่อ
    const { data: staff } = await db.from('kpi_staff').select('*').neq('active', false);
    const k = name.toLowerCase();
    const found = (staff || []).filter(s =>
      ((s.name || '') + ' ' + (s.surname || '')).toLowerCase().includes(k));
    if (!found.length) return '🔍 ไม่พบพนักงานชื่อ "' + tgEsc(name) + '"';
    let out = '';
    for (const emp of found.slice(0, 3)) {
      const { data: km } = await db.from('kpi_monthly').select('*').eq('emp_id', emp.id);
      const rows = (km || []).filter(r => r.id)
        .sort((a, b) => (parseInt(b.year) * 100 + parseInt(b.month)) - (parseInt(a.year) * 100 + parseInt(a.month)));
      out += '📈 <b>' + tgEsc(emp.name + ' ' + (emp.surname || '')) + '</b>\n';
      out += '   ตำแหน่ง: ' + tgEsc(emp.position || '-') + '\n';
      if (!rows.length) { out += '   (ยังไม่มีข้อมูล KPI)\n\n'; continue; }
      const latest = rows[0];
      const items = Array.isArray(latest.kpi_data) ? latest.kpi_data : [];
      const tMax = items.reduce((s, x) => s + (parseFloat(x.maxScore) || 0), 0);
      const tScore = items.reduce((s, x) => s + (parseFloat(x.score) || 0), 0);
      const pct = tMax > 0 ? Math.round(tScore / tMax * 100) : 0;
      const thr = parseFloat(latest.pass_threshold) || 70;
      out += '   เดือนล่าสุด: ' + latest.month + '/' + latest.year + '\n';
      out += '   คะแนน: ' + tScore + '/' + tMax + ' (' + pct + '%) ' + (pct >= thr ? '✅ ผ่าน' : '❌ ไม่ผ่าน') + '\n\n';
    }
    return out.trim();
  }

  // /ค้นหา [คำ]
  if (cleaned.startsWith('/ค้นหา') || lower.startsWith('/search')) {
    const kw = cleaned.replace(/^\/ค้นหา/, '').replace(/^\/search/i, '').trim();
    if (!kw) return 'พิมพ์คำที่ต้องการค้นหาด้วยครับ เช่น /ค้นหา ชุบ';
    const { data } = await db.from('tasks').select('*').order('seq', { ascending: true });
    const k = kw.toLowerCase();
    const list = (data || []).filter(t =>
      ((t.task || '') + (t.sales_name || '') + (t.categories || '') + (t.note || '')).toLowerCase().includes(k));
    return fmtDetail('🔍 <b>ผลค้นหา "' + tgEsc(kw) + '" ({n})</b>', list)
      || '🔍 ไม่พบงานที่มีคำว่า "' + tgEsc(kw) + '"';
  }

  // ไม่ใช่คำสั่งที่รู้จัก — เงียบไว้ (return null = ไม่ตอบ)
  return null;
}

// ============================================================================
//  CRON: เช็คงานครบกำหนด/เลยกำหนด แล้วแจ้ง Telegram (เรียกวันละครั้ง)
// ============================================================================
async function checkDueTasks() {
  const today = todayStr();
  // งานที่ยังไม่เสร็จ และวันดำเนินการ <= วันนี้
  const { data, error } = await db.from('tasks')
    .select('task, categories, action_date, sales_name, done')
    .eq('done', false)
    .lte('action_date', today)
    .order('action_date', { ascending: true });
  if (error) return { success: false, error: error.message };
  const list = data || [];
  if (!list.length) {
    return { success: true, count: 0 };
  }
  // จัดกลุ่ม: เลยกำหนด กับ ครบกำหนดวันนี้
  const overdue = list.filter(t => dstr(t.action_date) < today);
  const dueToday = list.filter(t => dstr(t.action_date) === today);
  let msg = '⏰ <b>สรุปงานที่ต้องดำเนินการ</b>\n';
  msg += '📅 ' + today + '\n';
  if (dueToday.length) {
    msg += '\n🟡 <b>ครบกำหนดวันนี้ (' + dueToday.length + ')</b>\n';
    dueToday.forEach(t => {
      msg += '• ' + tgEsc(t.task || '-') + ' — ' + tgEsc(t.sales_name || 'ไม่ระบุ') + '\n';
    });
  }
  if (overdue.length) {
    msg += '\n🔴 <b>เลยกำหนดแล้ว (' + overdue.length + ')</b>\n';
    overdue.forEach(t => {
      const days = calcDays(dstr(t.action_date));
      msg += '• ' + tgEsc(t.task || '-') + ' (' + tgEsc(days) + ') — ' + tgEsc(t.sales_name || 'ไม่ระบุ') + '\n';
    });
  }
  await notifyTelegram(msg);
  return { success: true, count: list.length };
}

// ============================================================================
//  DISPATCH TABLE
// ============================================================================
const HANDLERS = {
  getTasks, addTask, updateTask, deleteTask, checkDueTasks,
  getCategories, addCategory, deleteCategory, getDashboardData,
  saveAttachment, getAttachments, deleteAttachment, getFileAsBase64,
  getWeightJobs, saveWeightJob, deleteWeightJob,
  getProducts, saveProduct, deleteProduct,
  getLoedaroonItems, saveLoedaroonItem, addLoedaroonCall, deleteLoedaroonItem, deleteLoedaroonPO,
  getOTEmployees, saveOTEmployee, deleteOTEmployee, getOTData, saveOTRecord, deleteOTRecord,
  getEMPStaff, saveEMPStaff, deleteEMPStaff, getEMPAttendanceData, saveEMPAttendance, deleteEMPAttendance,
  getKPIRecords, saveKPIRecord, deleteKPIRecord,
  getWireNotes, saveWireNotesBatch,
  getKPIStaff, saveKPIStaff, deleteKPIStaff, getKPIByEmpMonth, saveKPIByEmpMonth, getKPIMonthHistory,
  getDashSummary,
  getWHDashData, saveWHDashData, getWHYearData,
  getKPIForm, saveKPIForm
};

export const __handlers = HANDLERS;
export { checkDueTasks, handleTelegramCommand };

// ส่งข้อความตอบกลับไปยัง chat ที่ระบุ (ใช้โดย webhook)
export async function sendTelegramReply(chatId, text) {
  if (!TG_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
  } catch (e) { console.error('TG reply failed:', e.message); }
}
// ให้ webhook เช็คว่า chat ที่ส่งมา ตรงกับกลุ่มที่ตั้งไว้ไหม
export function isAllowedChat(chatId) {
  if (!TG_CHAT) return true; // ยังไม่ตั้ง → ไม่จำกัด
  return String(chatId) === String(TG_CHAT);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    res.status(500).json({ ok: false, error: 'ยังไม่ได้ตั้งค่า SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ใน Environment Variables ของ Vercel' });
    return;
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { fn, args } = body;

    // ── ด่าน Login ──────────────────────────────────────────────────────────
    // 1) ฟังก์ชัน login: เช็ครหัส แล้วออก token ให้
    if (fn === 'login') {
      const pw = Array.isArray(args) ? args[0] : '';
      if (!APP_PASSWORD) {
        // ยังไม่ได้ตั้งรหัส → อนุญาตผ่าน (กันล็อกตัวเองตอนยังไม่ตั้งค่า) แต่เตือน
        res.status(200).json({ ok: true, result: { token: makeToken(), warn: 'ยังไม่ได้ตั้ง APP_PASSWORD' } });
        return;
      }
      if (pw === APP_PASSWORD) {
        res.status(200).json({ ok: true, result: { token: makeToken() } });
      } else {
        res.status(200).json({ ok: false, error: 'รหัสผ่านไม่ถูกต้อง' });
      }
      return;
    }

    // 2) ทุกฟังก์ชันอื่น ต้องมี token ที่ถูกต้อง (ถ้าตั้ง APP_PASSWORD ไว้)
    if (APP_PASSWORD) {
      const token = req.headers['x-app-token'] || (body && body.token) || '';
      if (!verifyToken(token)) {
        res.status(401).json({ ok: false, error: 'unauthorized' });
        return;
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    const h = HANDLERS[fn];
    if (!h) { res.status(400).json({ ok: false, error: 'ไม่รู้จักฟังก์ชัน: ' + fn }); return; }
    const result = await h.apply(null, Array.isArray(args) ? args : []);
    res.status(200).json({ ok: true, result });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message || String(e) });
  }
}
