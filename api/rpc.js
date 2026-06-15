// ============================================================================
//  /api/rpc.js  —  Vercel Serverless Function
//  จุดเดียวที่ frontend เรียกผ่าน google.script.run (ดู app-shim.js)
//  รับ { fn: 'getTasks', args: [...] }  แล้ว dispatch ไปยัง handler ที่ port มาจาก Code.gs
//  ใช้ Supabase (service_role key) เป็นฐานข้อมูลแทน Google Sheets
// ============================================================================
import { createClient } from '@supabase/supabase-js';

import crypto from 'crypto';
import { odooConfigured, odooStock, odooPO, odooSO, odooPR, odooDelivery, parseCompany, odooGuardrailStock } from './odoo.js';
import { buildDeliveryPDF } from './pdfgen.js';

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

// แปลงวันที่สำหรับแสดงใน Telegram เป็น D/M/YYYY เช่น 4/6/2026
const tgDate = (v) => {
  const s = dstr(v);
  if (!s) return '';
  const [y, m, d] = s.split('-');
  return parseInt(d) + '/' + parseInt(m) + '/' + y;
};

// ── Telegram แจ้งเตือน ───────────────────────────────────────────────────────
// ตั้งค่าใน Environment Variables: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
const TG_TOKEN  = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT   = process.env.TELEGRAM_CHAT_ID || '';    // กลุ่มหลัก
const TG_CHAT2  = process.env.TELEGRAM_CHAT_ID_2 || '';  // กลุ่มใหม่ (สำหรับ reply บันทึกงาน)

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
    if (f.dateFrom) { const from = new Date(f.dateFrom + 'T00:00:00'); rows = rows.filter(r => { const d = new Date(r['Action Date']); return !isNaN(d) && d >= from; }); }
    if (f.dateTo)   { const to   = new Date(f.dateTo   + 'T23:59:59'); rows = rows.filter(r => { const d = new Date(r['Action Date']); return !isNaN(d) && d <= to;   }); }
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

  // ถ้า frontend จะแนบไฟล์ทีหลัง → ข้ามการแจ้งตอนนี้ (จะเรียก notifyNewTask แทน)
  if (td['__skipNotify'] === true) {
    return { success: true, id };
  }

  // 🔔 แจ้งเตือน: มีงานใหม่ (พร้อมรายละเอียดครบ)
  const dur = td['Duration'] || '';
  const durIcon = dur === 'รับ' ? '📦 รับ' : dur === 'ส่ง' ? '🚚 ส่ง' : '';
  let newMsg = '🆕 <b>มีงานใหม่</b>';
  if (durIcon) newMsg += ' — ' + durIcon;
  newMsg += '\n\n';
  newMsg += '📋 <b>' + tgEsc(td['Task'] || '-') + '</b>\n';
  if (td['Categories']) newMsg += '🏷️ ' + tgEsc(td['Categories']) + '\n';
  newMsg += '📅 ' + tgEsc(tgDate(td['Action Date'] || todayStr())) + '\n';
  if (td['Sales Name']) newMsg += '👤 ' + tgEsc(td['Sales Name']) + '\n';
  if (td['Note'])       newMsg += '📝 ' + tgEsc(td['Note']) + '\n';
  // ไฟล์แนบ
  try {
    const files = Array.isArray(td['Attachments']) ? td['Attachments']
      : (typeof td['Attachments'] === 'string' ? JSON.parse(td['Attachments'] || '[]') : []);
    files.forEach(f => {
      const fname = tgEsc(f.name || 'ไฟล์');
      const url = f.webViewLink || f.wl || '';
      if (url) newMsg += '📎 <a href="' + url + '">' + fname + '</a>\n';
      else if (fname) newMsg += '📎 ' + fname + '\n';
    });
  } catch (e) {}
  await notifyTelegram(newMsg);
  return { success: true, id };
}

// แจ้งเตือนงานใหม่พร้อมไฟล์แนบ (เรียกหลังอัปโหลดไฟล์เสร็จ)
async function notifyNewTask(taskId) {
  const { data: t } = await db.from('tasks').select('*').eq('id', taskId).maybeSingle();
  if (!t) return { success: false };
  const dur = t.duration || '';
  const durIcon = dur === 'รับ' ? '📦 รับ' : dur === 'ส่ง' ? '🚚 ส่ง' : '';
  let newMsg = '🆕 <b>มีงานใหม่</b>';
  if (durIcon) newMsg += ' — ' + durIcon;
  newMsg += '\n\n';
  newMsg += '📋 <b>' + tgEsc(t.task || '-') + '</b>\n';
  if (t.categories) newMsg += '🏷️ ' + tgEsc(t.categories) + '\n';
  newMsg += '📅 ' + tgEsc(tgDate(t.action_date || todayStr())) + '\n';
  if (t.sales_name) newMsg += '👤 ' + tgEsc(t.sales_name) + '\n';
  if (t.note)       newMsg += '📝 ' + tgEsc(t.note) + '\n';
  try {
    const files = Array.isArray(t.attachments) ? t.attachments
      : (typeof t.attachments === 'string' ? JSON.parse(t.attachments || '[]') : []);
    files.forEach(f => {
      const fname = tgEsc(f.name || 'ไฟล์');
      const url = f.webViewLink || f.wl || '';
      if (url) newMsg += '📎 <a href="' + url + '">' + fname + '</a>\n';
      else if (fname) newMsg += '📎 ' + fname + '\n';
    });
  } catch (e) {}
  await notifyTelegram(newMsg);
  return { success: true };
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
  // ดึงข้อมูลเดิมก่อนอัปเดต
  let wasDone = false; let prevData = null;
  try {
    const { data: prev } = await db.from('tasks').select('*').eq('id', td['ID']).single();
    if (prev) {
      wasDone = !!prev.done;
      if (!td['Task'])       td['Task']       = prev.task;
      if (!td['Sales Name']) td['Sales Name'] = prev.sales_name;
      if (!td['Categories']) td['Categories'] = prev.categories;
      if (!td['Duration'])   td['Duration']   = prev.duration;
      if (!td['Action Date'])td['Action Date']= prev.action_date;
      if (!td['Note'])       td['Note']       = prev.note;
      prevData = prev;
    }
  } catch (e) {}
  const { data, error } = await db.from('tasks').update(patch).eq('id', td['ID']).select('id, task');
  if (error) return { success: false, error: error.message };
  if (!data || !data.length) return { success: false, error: 'Task not found' };

  // 🔔 แจ้งเตือน: งานเพิ่งเสร็จ (พร้อมรายละเอียดครบ)
  if (done && !wasDone) {
    const durD = td['Duration'] || '';
    const durIconD = durD === 'รับ' ? '📦 รับ' : durD === 'ส่ง' ? '🚚 ส่ง' : '';
    let doneMsg = '✅ <b>งานเสร็จแล้ว</b>';
    if (durIconD) doneMsg += ' — ' + durIconD;
    doneMsg += '\n\n';
    doneMsg += '📋 <b>' + tgEsc(td['Task'] || '-') + '</b>\n';
    if (td['Categories']) doneMsg += '🏷️ ' + tgEsc(td['Categories']) + '\n';
    if (td['Action Date'])doneMsg += '📅 ' + tgEsc(tgDate(td['Action Date'])) + '\n';
    if (td['Sales Name']) doneMsg += '👤 ' + tgEsc(td['Sales Name']) + '\n';
    if (td['Note'])       doneMsg += '📝 ' + tgEsc(td['Note']) + '\n';
    // ไฟล์แนบจากข้อมูลเดิม
    try {
      const att = prevData && prevData.attachments;
      const files = Array.isArray(att) ? att : (typeof att === 'string' ? JSON.parse(att || '[]') : []);
      files.forEach(f => {
        const fname = tgEsc(f.name || 'ไฟล์');
        const url = f.webViewLink || f.wl || '';
        if (url) doneMsg += '📎 <a href="' + url + '">' + fname + '</a>\n';
        else if (fname) doneMsg += '📎 ' + fname + '\n';
      });
    } catch (e) {}
    await notifyTelegram(doneMsg);
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
      '📅 /งานวันนี้ [สถานะ] — เช่น /งานวันนี้ to do\n' +
      '📅 /งานพรุ่งนี้ — งานครบกำหนดพรุ่งนี้\n' +
      '📅 /งานสัปดาห์นี้ — งานใน 7 วันข้างหน้า\n' +
      '📋 /งานค้าง — งานที่ยังไม่เสร็จ\n' +
      '🔴 /เลยกำหนด — งานที่เลยกำหนดแล้ว\n' +
      '✅ /งานเสร็จวันนี้ — งานที่เสร็จวันนี้\n' +
      '📦 /งานรับ [สถานะ] [วันที่] — เช่น /งานรับ to do  /งานรับ 5/6/2026\n' +
      '🚚 /งานส่ง [สถานะ] [วันที่] — เช่น /งานส่ง doing  /งานส่ง to do 5/6/2026\n' +
      '👤 /งานของ [ชื่อ] — เช่น /งานของ สมชาย\n' +
      '🗓️ /งานวันที่ [วันที่] [สถานะ] — เช่น /งานวันที่ 5/6/2026 to do\n' + '🗓️ /งาน [วันที่] — รูปแบบสั้น เช่น /งาน 5/6/2026\n' +
      '📈 /kpi [ชื่อ] — KPI พนักงาน เช่น /kpi สมชาย หรือ /kpi สมชาย เดือน5/2026\n' +
      '🔍 /ค้นหา [คำ] — ค้นหางาน เช่น /ค้นหา ชุบ หรือ /ค้นหา ชุบ to do\n' +
      '📦 /สต็อก [ชื่อสินค้า] — เช็คสต็อกจาก Odoo เช่น /สต็อก แผ่น 3.2 ชุบ\n' +
      '🛣️ /อัพเดทสต็อกการ์ดเรล [md/cg/sep] — เช็คสต็อกชิ้นส่วนการ์ดเรลทั้งหมดทีเดียว\n' +
      '🧾 /po [เลข PO] — ดูใบสั่งซื้อจาก Odoo เช่น /po PO2603068\n' +
      '🧾 /so [เลข SO] — ดูใบสั่งขายจาก Odoo เช่น /so 2606007\n' +
      '📄 /pr [เลข PR] — ดูใบขอซื้อจาก Odoo เช่น /pr PR01881\n' +
      '🚚 /ใบส่งของ [ชื่อโครงการ] — ดูใบส่งของจาก Odoo เช่น /ใบส่งของ อุตรดิตถ์\n' +
      '👤 /ข้อมูล [ชื่อ] — วันลาคงเหลือ + รายการลาของพนักงาน เช่น /ข้อมูล สมชาย'
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
    if (t.action_date) s += '   📅 ' + tgEsc(tgDate(t.action_date)) + '\n';
    if (t.sales_name) s += '   👤 ' + tgEsc(t.sales_name) + '\n';
    if (t.note) s += '   📝 ' + tgEsc(t.note) + '\n';
    // ไฟล์แนบ — แสดงลิงก์กดเปิดได้เลย
    try {
      const files = typeof t.attachments === 'string'
        ? JSON.parse(t.attachments || '[]')
        : (Array.isArray(t.attachments) ? t.attachments : []);
      if (files.length) {
        s += '   📎 ไฟล์แนบ:\n';
        files.forEach(f => {
          const fname = tgEsc(f.name || 'ไฟล์');
          const url = f.webViewLink || f.wl || '';
          if (url) {
            s += '      • <a href="' + url + '">' + fname + '</a>\n';
          } else {
            s += '      • ' + fname + '\n';
          }
        });
      }
    } catch (e) { /* ถ้า parse ไม่ได้ก็ข้าม */ }
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
    const cleaned2 = str.split('วันที่').join(' ').trim();
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

  // ── helper: parse สถานะจาก text เช่น "to do", "doing", "done" ─────────────
  // return { status: 'To Do'|'Doing'|'Done'|null, rest: string ที่เหลือ }
  function parseStatus(s) {
    const lower = s.toLowerCase().trim();
    const map = [
      { keys: ['to do', 'todo', 'รอ'], val: 'To Do' },
      { keys: ['doing', 'กำลังทำ', 'ดำเนินการ'], val: 'Doing' },
      { keys: ['done', 'เสร็จ', 'เสร็จแล้ว'], val: 'Done' },
      { keys: ['cancel', 'ยกเลิก'], val: 'Cancel' },
    ];
    for (const { keys, val } of map) {
      for (const k of keys) {
        if (lower.includes(k)) {
          const rest = s.split(k).join('').trim();
          return { status: val, rest };
        }
      }
    }
    return { status: null, rest: s };
  }

  // /งานวันนี้ [สถานะ]  เช่น /งานวันนี้ to do  /งานวันนี้ doing
  if (cleaned.startsWith('/งานวันนี้') || lower === '/today') {
    const argRaw = cleaned.replace(/^\/งานวันนี้/, '').replace(/^\/today/i, '').trim();
    const { status } = parseStatus(argRaw);
    let q = db.from('tasks').select('*').eq('action_date', today);
    if (status === 'Done') { q = q.eq('done', true); }
    else if (status) { q = q.eq('done', false).eq('task_status', status); }
    else { q = q.eq('done', false); }
    const { data } = await q.order('seq', { ascending: true });
    const list = data || [];
    const stLabel = status ? ' [' + status + ']' : '';
    if (!list.length) return '🟢 วันนี้ไม่มีงาน' + stLabel + 'ครับ';
    const rap   = list.filter(t => t.duration === 'รับ');
    const send  = list.filter(t => t.duration === 'ส่ง');
    const other = list.filter(t => t.duration !== 'รับ' && t.duration !== 'ส่ง');
    let msg = '🟡 <b>งานวันนี้ ' + tgDate(today) + stLabel + ' (' + list.length + ' งาน)</b>\n';
    if (rap.length)   msg += '📦 รับ ' + rap.length + ' | ';
    if (send.length)  msg += '🚚 ส่ง ' + send.length + ' | ';
    if (other.length) msg += '📋 อื่นๆ ' + other.length;
    msg += '\n\n';
    if (rap.length) {
      msg += '━━━━━━━━━━━━━━\n📦 <b>งานรับ (' + rap.length + ')</b>\n━━━━━━━━━━━━━━\n';
      rap.slice(0, 10).forEach((t, i) => { msg += (i+1) + '. ' + taskDetail(t) + '\n'; });
    }
    if (send.length) {
      msg += '━━━━━━━━━━━━━━\n🚚 <b>งานส่ง (' + send.length + ')</b>\n━━━━━━━━━━━━━━\n';
      send.slice(0, 10).forEach((t, i) => { msg += (i+1) + '. ' + taskDetail(t) + '\n'; });
    }
    if (other.length) {
      msg += '━━━━━━━━━━━━━━\n📋 <b>งานอื่นๆ (' + other.length + ')</b>\n━━━━━━━━━━━━━━\n';
      other.slice(0, 10).forEach((t, i) => { msg += (i+1) + '. ' + taskDetail(t) + '\n'; });
    }
    return msg.trim();
  }

  // /งานพรุ่งนี้
  if (cleaned === '/งานพรุ่งนี้' || lower === '/tomorrow') {
    const tmr = addDays(1);
    const { data } = await db.from('tasks').select('*')
      .eq('done', false).eq('action_date', tmr).order('seq', { ascending: true });
    const list = data || [];
    if (!list.length) return '🟢 พรุ่งนี้ไม่มีงานครบกำหนดครับ';
    const rap   = list.filter(t => t.duration === 'รับ');
    const send  = list.filter(t => t.duration === 'ส่ง');
    const other = list.filter(t => t.duration !== 'รับ' && t.duration !== 'ส่ง');
    let msg = '🟠 <b>งานพรุ่งนี้ ' + tgDate(tmr) + ' (' + list.length + ' งาน)</b>\n';
    if (rap.length)   msg += '📦 รับ ' + rap.length + ' | ';
    if (send.length)  msg += '🚚 ส่ง ' + send.length + ' | ';
    if (other.length) msg += '📋 อื่นๆ ' + other.length;
    msg += '\n\n';
    if (rap.length) {
      msg += '━━━━━━━━━━━━━━\n📦 <b>งานรับ (' + rap.length + ')</b>\n━━━━━━━━━━━━━━\n';
      rap.slice(0, 10).forEach((t, i) => { msg += (i+1) + '. ' + taskDetail(t) + '\n'; });
    }
    if (send.length) {
      msg += '━━━━━━━━━━━━━━\n🚚 <b>งานส่ง (' + send.length + ')</b>\n━━━━━━━━━━━━━━\n';
      send.slice(0, 10).forEach((t, i) => { msg += (i+1) + '. ' + taskDetail(t) + '\n'; });
    }
    if (other.length) {
      msg += '━━━━━━━━━━━━━━\n📋 <b>งานอื่นๆ (' + other.length + ')</b>\n━━━━━━━━━━━━━━\n';
      other.slice(0, 10).forEach((t, i) => { msg += (i+1) + '. ' + taskDetail(t) + '\n'; });
    }
    return msg.trim();
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

  // /งานรับ [สถานะ] [วันที่]  /งานส่ง [สถานะ] [วันที่]
  // เช่น /งานรับ to do  /งานส่ง doing  /งานรับ 5/6/2026  /งานส่ง to do 5/6/2026
  if (cleaned.startsWith('/งานรับ') || cleaned.startsWith('/งานส่ง')) {
    const isRap = cleaned.startsWith('/งานรับ');
    const dur = isRap ? 'รับ' : 'ส่ง';
    let rest = cleaned.replace(/^\/งาน(รับ|ส่ง)/, '').trim();
    const { status, rest: rest2 } = parseStatus(rest);
    const dArg = rest2 ? extractDate(rest2) : null;
    if (rest2 && !dArg && rest2.length > 0 && !status) {
      return 'รูปแบบไม่ถูกต้องครับ ตัวอย่าง:\n/งาน' + dur + ' to do\n/งาน' + dur + ' 5/6/2026\n/งาน' + dur + ' to do 5/6/2026';
    }
    let q = db.from('tasks').select('*').eq('duration', dur);
    if (dArg)           { q = q.eq('action_date', dArg); }
    if (status === 'Done') { q = q.eq('done', true); }
    else if (status)    { q = q.eq('done', false).eq('task_status', status); }
    else if (!dArg)     { q = q.eq('done', false); }
    const { data } = await q.order('action_date', { ascending: true });
    const stLabel = status ? ' [' + status + ']' : (dArg ? '' : ' (ยังไม่เสร็จ)');
    const titleDate = dArg ? ' วันที่ ' + tgDate(dArg) : '';
    const icon = isRap ? '📦' : '🚚';
    return fmtDetail(icon + ' <b>งาน' + dur + titleDate + stLabel + ' ({n})</b>', data || [])
      || '🟢 ไม่มีงาน' + dur + titleDate + stLabel + 'ครับ';
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

  // /งานวันที่ [วันที่] [สถานะ]  และ /งาน [วันที่] [สถานะ]  (รูปแบบสั้น)
  // เช่น /งานวันที่ 5/6/2026  /งานวันที่ 5/6/2026 to do  /งาน 5/6/2026
  const isDateCmd = cleaned.startsWith('/งานวันที่') || lower.startsWith('/date');
  const isShortDate = !isDateCmd && cleaned.startsWith('/งาน ') &&
    extractDate(cleaned.replace(/^\/งาน/, '').trim());
  if (isDateCmd || isShortDate) {
    let dRaw = cleaned
      .replace(/^\/งานวันที่/, '').replace(/^\/date/i, '').replace(/^\/งาน/, '').trim();
    const { status, rest: dRaw2 } = parseStatus(dRaw);
    const dArg = extractDate(dRaw2 || dRaw);
    if (!dArg) return 'พิมพ์วันที่ให้ถูกต้องครับ เช่น\n/งานวันที่ 5/6/2026\n/งาน 5/6/2026 to do\n/งาน 5/6/2026 doing';
    let q = db.from('tasks').select('*').eq('action_date', dArg);
    if (status === 'Done')  { q = q.eq('done', true); }
    else if (status)        { q = q.eq('done', false).eq('task_status', status); }
    const { data } = await q.order('seq', { ascending: true });
    const stLabel = status ? ' [' + status + ']' : '';
    return fmtDetail('🗓️ <b>งานวันที่ ' + tgDate(dArg) + stLabel + ' ({n})</b>', data || [])
      || '🟢 วันที่ ' + tgDate(dArg) + stLabel + ' ไม่มีงานครับ';
  }

  // /kpi [ชื่อ] หรือ /kpi [ชื่อ] เดือน5/2026
  if (lower.startsWith('/kpi') || cleaned.startsWith('/เคพีไอ')) {
    let rest = cleaned.replace(/^\/kpi/i, '').replace('/เคพีไอ', '').trim();
    // ดึงเดือน/ปี ออกจากข้อความ รองรับ "เดือน5/2026", "5/2026", "เดือน 5/2569"
    let wantMonth = null, wantYear = null;
    const mMatch = rest.match(/(?:เดือน)?\s*(\d{1,2})\s*[\/\-]\s*(\d{2,4})/);
    if (mMatch) {
      wantMonth = parseInt(mMatch[1]);
      wantYear = parseInt(mMatch[2]);
      if (wantYear < 100) wantYear += 2000;
      if (wantYear >= 2500) wantYear -= 543; // พ.ศ. → ค.ศ.
      rest = rest.replace(mMatch[0], '').split('เดือน').join('').trim();
    }
    const name = rest.trim();
    if (!name) return 'พิมพ์ชื่อพนักงานด้วยครับ เช่น /kpi สมชาย หรือ /kpi สมชาย เดือน5/2026';
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
      // เลือกเดือนที่ต้องการ ถ้าระบุ
      let target;
      if (wantMonth && wantYear) {
        target = rows.find(r => parseInt(r.month) === wantMonth && parseInt(r.year) === wantYear);
        if (!target) { out += '   ❌ ไม่มีข้อมูล KPI เดือน ' + wantMonth + '/' + wantYear + '\n\n'; continue; }
      } else {
        target = rows[0]; // ล่าสุด
      }
      const items = Array.isArray(target.kpi_data) ? target.kpi_data : [];
      const tMax = items.reduce((s, x) => s + (parseFloat(x.maxScore) || 0), 0);
      const tScore = items.reduce((s, x) => s + (parseFloat(x.score) || 0), 0);
      const pct = tMax > 0 ? Math.round(tScore / tMax * 100) : 0;
      const thr = parseFloat(target.pass_threshold) || 70;
      const label = (wantMonth && wantYear) ? 'เดือน' : 'เดือนล่าสุด';
      out += '   ' + label + ': ' + target.month + '/' + target.year + '\n';
      out += '   คะแนน: ' + tScore + '/' + tMax + ' (' + pct + '%) ' + (pct >= thr ? '✅ ผ่าน' : '❌ ไม่ผ่าน') + '\n\n';
    }
    return out.trim();
  }

  // /ค้นหา [คำ] หรือ /ค้นหา [คำ] [สถานะ]
  // รองรับ: to do, todo, doing, done, cancel (ไทย/อังกฤษ)
  if (cleaned.startsWith('/ค้นหา') || lower.startsWith('/search')) {
    let kw = cleaned.replace(/^\/ค้นหา/, '').replace(/^\/search/i, '').trim();
    if (!kw) return 'พิมพ์คำที่ต้องการค้นหาด้วยครับ เช่น /ค้นหา ชุบ หรือ /ค้นหา ชุบ to do';

    // ดึง keyword สถานะออกจากท้าย (ถ้ามี)
    const statusMap = {
      'to do': 'To Do', 'todo': 'To Do', 'ยังไม่ทำ': 'To Do', 'รอดำเนินการ': 'To Do',
      'doing': 'Doing', 'กำลังทำ': 'Doing',
      'done': 'Done', 'เสร็จ': 'Done', 'เสร็จแล้ว': 'Done',
      'cancel': 'Cancel', 'ยกเลิก': 'Cancel',
    };
    let wantStatus = null;
    // ลองหา keyword สถานะจาก token ท้ายสุด (1-2 คำ)
    const tokens = kw.split(/\s+/);
    // ลอง 2 คำท้าย ("to do")
    if (tokens.length >= 2) {
      const last2 = tokens.slice(-2).join(' ').toLowerCase();
      if (statusMap[last2]) { wantStatus = statusMap[last2]; kw = tokens.slice(0, -2).join(' ').trim(); }
    }
    // ลอง 1 คำท้าย ("done", "doing", "cancel", "เสร็จ" ฯลฯ)
    if (!wantStatus && tokens.length >= 1) {
      const last1 = tokens[tokens.length - 1].toLowerCase();
      if (statusMap[last1]) { wantStatus = statusMap[last1]; kw = tokens.slice(0, -1).join(' ').trim(); }
    }
    if (!kw) return 'พิมพ์คำค้นหาด้วยครับ เช่น /ค้นหา บริการ to do';

    const { data } = await db.from('tasks').select('*').order('seq', { ascending: true });
    const k = kw.toLowerCase();
    let list = (data || []).filter(t =>
      ((t.task || '') + (t.sales_name || '') + (t.categories || '') + (t.note || '')).toLowerCase().includes(k));
    // กรองสถานะถ้าระบุ
    if (wantStatus) {
      list = list.filter(t =>
        wantStatus === 'Done' ? t.done : (t.task_status === wantStatus && !t.done));
    }
    const statusLabel = wantStatus ? ' [' + wantStatus + ']' : '';
    return fmtDetail('🔍 <b>ผลค้นหา "' + tgEsc(kw) + '"' + tgEsc(statusLabel) + ' ({n})</b>', list)
      || '🔍 ไม่พบงานที่มีคำว่า "' + tgEsc(kw) + '"' + (wantStatus ? ' สถานะ ' + wantStatus : '');
  }

  // ── /ข้อมูล [ชื่อ] — ดูข้อมูลพนักงาน: วันลาคงเหลือ + รายการวันที่ลา ───────
  if (cleaned.startsWith('/ข้อมูล') || cleaned.startsWith('/พนักงาน') || lower.startsWith('/emp')) {
    const nameQ = cleaned.replace("/\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25", "").replace("/\u0e1e\u0e19\u0e31\u0e01\u0e07\u0e32\u0e19", "").replace("/emp", "").trim();
    if (!nameQ) return '👤 พิมพ์ชื่อพนักงานด้วยครับ เช่น\n/ข้อมูล สมชาย\n/ข้อมูล วรรณี';

    // ดึง staff ทั้งหมดแล้วค้นหาชื่อ
    const { data: staffData } = await db.from('emp_staff').select('*').eq('active', true);
    const staff = (staffData || []).filter(s => {
      const full = ((s.name || '') + ' ' + (s.surname || '') + ' ' + (s.nickname || '')).toLowerCase();
      return full.includes(nameQ.toLowerCase());
    });

    if (!staff.length) return '❌ ไม่พบพนักงานชื่อ "' + tgEsc(nameQ) + '" ครับ\nลองพิมพ์ชื่อจริง ชื่อเล่น หรือนามสกุล';
    if (staff.length > 3) return '🔍 พบพนักงาน ' + staff.length + ' คน กรุณาระบุชื่อให้ชัดเจนกว่านี้ครับ';

    // ดึง attendance ปีนี้
    const yr = new Date().getFullYear();
    const yrStart = yr + '-01-01';
    const yrEnd   = yr + '-12-31';
    const { data: attData } = await db.from('emp_attendance').select('*')
      .gte('date', yrStart).lte('date', yrEnd);

    let msg = '';
    for (const emp of staff) {
      const fullName = tgEsc((emp.name || '') + ' ' + (emp.surname || ''));
      const nick     = emp.nickname ? ' (' + tgEsc(emp.nickname) + ')' : '';
      const pos      = emp.position ? tgEsc(emp.position) : '–';

      // กรอง attendance ของพนักงานคนนี้
      const myAtt = (attData || []).filter(a => String(a.emp_id) === String(emp.id));

      // นับวันลาที่ใช้ไปแล้ว (ปีนี้)
      let usedAL = 0, usedPL = 0, usedSL = 0;
      const leaveList = [];
      myAtt.forEach(a => {
        const h = parseFloat(a.hours) || 8;
        const days = h / 8;
        const dateDisp = tgDate(a.date);
        const note = a.note ? ' — ' + tgEsc(a.note) : '';
        if (a.status === 'AL') { usedAL += days; leaveList.push('🌴 ' + dateDisp + ' ลาพักร้อน' + (days < 1 ? ' (' + h + 'ชม.)' : '') + note); }
        if (a.status === 'PL') { usedPL += days; leaveList.push('📋 ' + dateDisp + ' ลากิจ'    + (days < 1 ? ' (' + h + 'ชม.)' : '') + note); }
        if (a.status === 'SL') { usedSL += days; leaveList.push('🤒 ' + dateDisp + ' ลาป่วย'   + (days < 1 ? ' (' + h + 'ชม.)' : '') + note); }
      });

      // วันคงเหลือ
      const totalAL = parseFloat(emp.annual_leave)   || 0;
      const totalPL = parseFloat(emp.personal_leave) || 0;
      const totalSL = parseFloat(emp.sick_leave)     || 0;
      const remAL = Math.max(0, totalAL - usedAL);
      const remPL = Math.max(0, totalPL - usedPL);
      const remSL = Math.max(0, totalSL - usedSL);

      msg += '👤 <b>' + fullName + nick + '</b>\n';
      msg += '💼 ' + pos + '\n\n';
      msg += '📊 <b>วันลาคงเหลือ (' + yr + ')</b>\n';
      msg += '🌴 พักร้อน: <b>' + remAL.toFixed(1) + '</b> / ' + totalAL + ' วัน (ใช้ไป ' + usedAL.toFixed(1) + ')\n';
      msg += '📋 ลากิจ:   <b>' + remPL.toFixed(1) + '</b> / ' + totalPL + ' วัน (ใช้ไป ' + usedPL.toFixed(1) + ')\n';
      msg += '🤒 ลาป่วย:  <b>' + remSL.toFixed(1) + '</b> / ' + totalSL + ' วัน (ใช้ไป ' + usedSL.toFixed(1) + ')\n';

      if (leaveList.length) {
        msg += '\n📅 <b>รายการวันที่ลา (' + leaveList.length + ' ครั้ง)</b>\n';
        leaveList.sort().forEach(l => { msg += l + '\n'; });
      } else {
        msg += '\n✅ ยังไม่มีการลาปีนี้ครับ\n';
      }
      msg += '\n';
    }
    return msg.trim();
  }

  // ── /อัพเดทสต็อกการ์ดเรล [md/cg/sep/akn] — เช็คสต็อกสินค้าการ์ดเรลทั้งหมด (สร้างหน้าเว็บ) ──
  if (cleaned.startsWith('/อัพเดทสต็อกการ์ดเรล') || cleaned.startsWith('/อัปเดทสต็อกการ์ดเรล') ||
      cleaned.startsWith('/สต็อกการ์ดเรล') || lower.startsWith('/guardrailstock')) {
    if (!odooConfigured()) return '❌ ยังไม่ได้ตั้งค่า Odoo ใน Environment Variables ครับ';
    if (!db) return '⚠️⚠️⚠️ ยังไม่ได้เชื่อมต่อ Storage ครับ';
    const grArg = cleaned
      .replace(/^\/อัพเดทสต็อกการ์ดเรล/, '')
      .replace(/^\/อัปเดทสต็อกการ์ดเรล/, '')
      .replace(/^\/สต็อกการ์ดเรล/, '')
      .replace(/^\/guardrailstock/i, '')
      .trim();
    // ไม่ใส่ตัวย่อ = อาคเนย์ (ค่าเริ่มต้นเหมือนคำสั่งอื่นๆ เช่น /สต็อก /po /so /pr)
    const { company: grCo } = parseCompany(grArg);

    try {
      const items = await odooGuardrailStock(grCo.id);
      const groupNames = { plate: '🟦 แผ่น/บล็อก', post: '🟩 เสา', accessory: '🟧 นอต/ประกับ/ฐาน/เป้า' };
      const groupOrder = ['plate', 'post', 'accessory'];

      const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
      const ts = now.toISOString().slice(0, 10) + ' ' + now.toISOString().slice(11, 16);

      let foundCount = 0, notFoundCount = 0;
      const picks = groupOrder.map(g => {
        const list = items.filter(it => it.group === g);
        const lines = list.map(it => {
          if (it.found) {
            foundCount++;
            return { name: '[' + it.code + '] ' + it.label, qty: it.qty, uom: it.uom || '' };
          }
          notFoundCount++;
          return { name: '[' + it.code + '] ' + it.label, qty: '-', uom: 'ไม่พบในระบบ' };
        });
        return {
          name: groupNames[g] + ' (' + list.length + ' รายการ)',
          origin: '', partner: '', date: ts,
          lines
        };
      }).filter(p => p.lines.length);

      const data = { summary: { total: picks.length }, picks };

      // บันทึกลง delivery_views แล้วส่งลิงก์ (รูปแบบหน้าเว็บเดียวกับ /ใบส่งของ)
      const viewId = 'S' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();
      const { error: insErr } = await db.from('delivery_views').insert({
        id: viewId,
        title: 'สต็อกการ์ดเรล — ' + grCo.name,
        company: grCo.name,
        status_label: 'อัปเดต ' + ts + ' น.',
        data
      });
      if (insErr) return '⚠️⚠️⚠️ บันทึกข้อมูลไม่สำเร็จ: ' + tgEsc(insErr.message);

      const viewUrl = 'https://inventory-rho-hazel.vercel.app/delivery.html?id=' + viewId;
      let msg = '📦 สต็อกการ์ดเรล — ' + grCo.name + '\n';
      msg += 'พบ ' + foundCount + ' / ' + (foundCount + notFoundCount) + ' รายการ';
      if (notFoundCount) msg += ' (ไม่พบ ' + notFoundCount + ' รายการ)';
      msg += '\n\n📎 เปิดดูสต็อกการ์ดเรล:\n' + viewUrl;
      return msg;
    } catch (e) {
      return '❌ ดึงข้อมูล Odoo ไม่สำเร็จ: ' + tgEsc(e.message);
    }
  }

  // ── /สต็อก [คำค้น] — เช็คสต็อกสินค้าจาก Odoo ──────────────────────────
  // รองรับหลายแบบ:
  //   /สต็อก แผ่น 3.2 ชุบ   |   /stock เหล็ก
  //   แผ่น 3.2 ชุบ เหลือเท่าไร   (พิมพ์เปล่าๆ ไม่มี / ก็ได้ — ตัดคำถามท้ายออก)
  {
    let stockKw = null;
    if (cleaned.startsWith('/สต็อก') || lower.startsWith('/stock')) {
      stockKw = cleaned.replace(/^\/สต็อก/, '').replace(/^\/stock/i, '').trim();
    } else if (!cleaned.startsWith('/')) {
      // พิมพ์เปล่าๆ ไม่มี / — ถือเป็นการค้นสต็อก ถ้ามีคำบ่งชี้ว่าถามของ/จำนวน
      const askStock = /(เหลือ|คงเหลือ|สต็อก|มีกี่|มีเท่าไร|กี่ชิ้น|กี่อัน|กี่แผ่น|stock)/i.test(cleaned);
      if (askStock) stockKw = cleaned;
    }

    if (stockKw !== null) {
      // ตัดคำถาม/คำพ่วงท้ายออก เหลือแต่ชื่อสินค้า
      stockKw = stockKw
        .replace(/(เหลือเท่าไร|เหลือเท่าไหร่|เหลือกี่|คงเหลือเท่าไร|คงเหลือ|เหลือ|มีกี่|มีเท่าไร|มีไหม|กี่ชิ้น|กี่อัน|กี่แผ่น|สต็อก|stock|เท่าไร|เท่าไหร่|\?|\？)/gi, '')
        .replace(/\s+/g, ' ').trim();

      if (!stockKw) return 'พิมพ์ชื่อสินค้าด้วยครับ เช่น /สต็อก แผ่น 3.2 ชุบ';
      if (!odooConfigured()) return '❌ ยังไม่ได้ตั้งค่า Odoo ใน Environment Variables ครับ';
      // แยกตัวย่อบริษัทท้ายคำ (md/cg/sep) — ไม่ใส่ = อาคเนย์
      const { keyword: stKw2, company: stCo } = parseCompany(stockKw);
      stockKw = stKw2;
      if (!stockKw) return 'พิมพ์ชื่อสินค้าด้วยครับ เช่น /สต็อก แผ่น 3.2 ชุบ';
      try {
        const products = await odooStock(stockKw, stCo.id);
        if (!products.length) return '🔍 ไม่พบสินค้า "' + tgEsc(stockKw) + '" (บริษัท ' + stCo.name + ') ใน Odoo';
        let msg = '📦 <b>สต็อก "' + tgEsc(stockKw) + '" — ' + stCo.name + ' (' + products.length + ' รายการ)</b>\n\n';
        products.forEach((p, i) => {
          const code = p.default_code ? '[' + tgEsc(p.default_code) + '] ' : '';
          const uom  = Array.isArray(p.uom_id) ? p.uom_id[1] : '';
          msg += (i + 1) + '. ' + code + tgEsc(p.name) + '\n';
          msg += '   📊 คงเหลือ: <b>' + p.qty_available + '</b> ' + tgEsc(uom) + '\n';
          msg += '   🔮 คาดการณ์: ' + p.virtual_available + ' ' + tgEsc(uom) + '\n\n';
        });
        return msg.trim();
      } catch (e) {
        return '❌ ดึงข้อมูล Odoo ไม่สำเร็จ: ' + tgEsc(e.message);
      }
    }
  }

  // ── /po [เลข PO] — ดูใบสั่งซื้อจาก Odoo ────────────────────────────────
  if (lower.startsWith('/po') || cleaned.startsWith('/พีโอ')) {
    const kwRaw = cleaned.replace(/^\/po/i, '').replace(/^\/พีโอ/, '').trim();
    if (!kwRaw) return 'พิมพ์เลข PO ด้วยครับ เช่น /po PO2603068';
    if (!odooConfigured()) return '❌ ยังไม่ได้ตั้งค่า Odoo ใน Environment Variables ครับ';
    const { keyword: kw, company: poCo } = parseCompany(kwRaw);
    try {
      const orders = await odooPO(kw, poCo.id);
      if (!orders.length) return '🔍 ไม่พบ PO "' + tgEsc(kw) + '" (บริษัท ' + poCo.name + ') ใน Odoo';
      const stateMap = {
        draft: '📝 ร่าง', sent: '📤 ส่งแล้ว', 'to approve': '⏳ รออนุมัติ',
        purchase: '✅ ยืนยันแล้ว', done: '✔️ เสร็จสิ้น', cancel: '❌ ยกเลิก'
      };
      let msg = '';
      orders.forEach(o => {
        const partner = Array.isArray(o.partner_id) ? o.partner_id[1] : '';
        msg += '🧾 <b>' + tgEsc(o.name) + '</b>\n';
        if (partner) msg += '   🏢 ' + tgEsc(partner) + '\n';
        msg += '   📌 ' + (stateMap[o.state] || tgEsc(o.state)) + '\n';
        if (o.date_order) msg += '   📅 ' + tgEsc(String(o.date_order).slice(0, 10)) + '\n';
        msg += '   💰 รวม: ' + Number(o.amount_total || 0).toLocaleString() + ' บาท\n';
        if (o.lines && o.lines.length) {
          msg += '   ━━━━━━━━━━\n';
          o.lines.forEach(l => {
            const pname = Array.isArray(l.product_id) ? l.product_id[1] : '';
            const remain = (l.product_qty || 0) - (l.qty_received || 0);
            msg += '   • ' + tgEsc(pname) + '\n';
            msg += '      สั่ง ' + l.product_qty + ' | รับแล้ว ' + l.qty_received + ' | ค้าง ' + remain + '\n';
          });
        }
        msg += '\n';
      });
      return msg.trim();
    } catch (e) {
      return '❌ ดึงข้อมูล Odoo ไม่สำเร็จ: ' + tgEsc(e.message);
    }
  }

  // ── /so [เลข SO] — ดูใบสั่งขายจาก Odoo ─────────────────────────────────
  if (lower.startsWith('/so') || cleaned.startsWith('/ขาย')) {
    const kwRaw = cleaned.replace(/^\/so/i, '').replace(/^\/ขาย/, '').trim();
    if (!kwRaw) return 'พิมพ์เลข SO ด้วยครับ เช่น /so 2606007';
    if (!odooConfigured()) return '❌ ยังไม่ได้ตั้งค่า Odoo ใน Environment Variables ครับ';
    const { keyword: kw, company: soCo } = parseCompany(kwRaw);
    try {
      const orders = await odooSO(kw, soCo.id);
      if (!orders.length) return '🔍 ไม่พบ SO "' + tgEsc(kw) + '" (บริษัท ' + soCo.name + ') ใน Odoo';
      const stateMap = {
        draft: '📝 ใบเสนอราคา', sent: '📤 ส่งใบเสนอราคาแล้ว',
        sale: '✅ ยืนยันแล้ว', done: '✔️ ปิดงานแล้ว', cancel: '❌ ยกเลิก'
      };
      let msg = '';
      orders.forEach(o => {
        const partner = Array.isArray(o.partner_id) ? o.partner_id[1] : '';
        msg += '🧾 <b>' + tgEsc(o.name) + '</b>\n';
        if (partner) msg += '   🏢 ' + tgEsc(partner) + '\n';
        if (o.state) msg += '   📌 ' + (stateMap[o.state] || tgEsc(o.state)) + '\n';
        if (o.date_order) msg += '   📅 ' + tgEsc(String(o.date_order).slice(0, 10)) + '\n';
        if (o.amount_total !== undefined) msg += '   💰 รวม: ' + Number(o.amount_total || 0).toLocaleString() + ' บาท\n';
        if (o.lines && o.lines.length) {
          msg += '   ━━━━━━━━━━\n';
          o.lines.forEach(l => {
            const pname = Array.isArray(l.product_id) ? l.product_id[1] : '';
            const qty = l.product_uom_qty || 0;
            const deliv = l.qty_delivered || 0;
            msg += '   • ' + tgEsc(pname) + '\n';
            msg += '      สั่ง ' + qty + ' | ส่งแล้ว ' + deliv + ' | ค้าง ' + (qty - deliv) + '\n';
          });
        }
        msg += '\n';
      });
      return msg.trim();
    } catch (e) {
      return '❌ ดึงข้อมูล Odoo ไม่สำเร็จ: ' + tgEsc(e.message);
    }
  }

  // ── /pr [เลข PR] — ดูใบขอซื้อจาก Odoo ──────────────────────────────────
  if (lower.startsWith('/pr') || cleaned.startsWith('/ขอซื้อ')) {
    const kwRaw = cleaned.replace(/^\/pr/i, '').replace(/^\/ขอซื้อ/, '').trim();
    if (!kwRaw) return 'พิมพ์เลข PR ด้วยครับ เช่น /pr PR01881';
    if (!odooConfigured()) return '❌ ยังไม่ได้ตั้งค่า Odoo ใน Environment Variables ครับ';
    const { keyword: kw, company: prCo } = parseCompany(kwRaw);
    try {
      const reqs = await odooPR(kw, prCo.id);
      if (!reqs.length) return '🔍 ไม่พบ PR "' + tgEsc(kw) + '" (บริษัท ' + prCo.name + ') ใน Odoo';
      const stateMap = {
        draft: '📝 ร่าง', to_approve: '⏳ รออนุมัติ', approved: '✅ อนุมัติแล้ว',
        rejected: '❌ ไม่อนุมัติ', done: '✔️ เสร็จสิ้น'
      };
      let msg = '';
      reqs.forEach(r => {
        const reqBy = Array.isArray(r.requested_by) ? r.requested_by[1] : '';
        msg += '📄 <b>' + tgEsc(r.name) + '</b>\n';
        if (r.state) msg += '   📌 ' + (stateMap[r.state] || tgEsc(r.state)) + '\n';
        if (reqBy) msg += '   👤 ขอโดย: ' + tgEsc(reqBy) + '\n';
        if (r.date_start) msg += '   📅 ' + tgEsc(String(r.date_start).slice(0, 10)) + '\n';
        if (r.description) msg += '   📝 ' + tgEsc(r.description) + '\n';
        if (r.lines && r.lines.length) {
          msg += '   ━━━━━━━━━━\n';
          r.lines.forEach(l => {
            const pname = Array.isArray(l.product_id) ? l.product_id[1] : (l.name || '');
            const uom = Array.isArray(l.product_uom_id) ? l.product_uom_id[1] : '';
            msg += '   • ' + tgEsc(pname) + ' — ' + (l.product_qty || 0) + ' ' + tgEsc(uom) + '\n';
          });
        }
        msg += '\n';
      });
      return msg.trim();
    } catch (e) {
      return '❌ ดึงข้อมูล Odoo ไม่สำเร็จ: ' + tgEsc(e.message);
    }
  }

  // ── /ใบส่งของ [ชื่อโครงการ/เลขใบ] — ดูใบส่งของจาก Odoo (เดิม /ส่งของ — เก็บไว้เป็น alias) ──
  if (cleaned.startsWith('/ใบส่งของ') || cleaned.startsWith('/ส่งของ') || cleaned.startsWith('/จัดส่ง') || lower.startsWith('/delivery')) {
    const kw = cleaned.replace(/^\/ใบส่งของ/, '').replace(/^\/ส่งของ/, '').replace(/^\/จัดส่ง/, '').replace(/^\/delivery/i, '').trim();
    if (!kw) return 'พิมพ์ชื่อโครงการหรือเลขใบด้วยครับ เช่น /ใบส่งของ อุตรดิตถ์';
    if (!odooConfigured()) return '❌ ยังไม่ได้ตั้งค่า Odoo ใน Environment Variables ครับ';
    try {
      const picks = await odooDelivery(kw);
      if (!picks.length) return '🔍 ไม่พบใบส่งของที่มีคำว่า "' + tgEsc(kw) + '" ใน Odoo';
      const stateMap = {
        draft: '📝 ร่าง', waiting: '⏳ รอ', confirmed: '⏳ รอของ',
        assigned: '📦 พร้อมส่ง', done: '✅ ส่งแล้ว', cancel: '❌ ยกเลิก'
      };
      let msg = '🚚 <b>ใบส่งของ "' + tgEsc(kw) + '" (' + picks.length + ' ใบ)</b>\n\n';
      picks.forEach((p, idx) => {
        const partner = Array.isArray(p.partner_id) ? p.partner_id[1] : '';
        msg += (idx + 1) + '. 🧾 <b>' + tgEsc(p.name) + '</b>\n';
        if (p.origin) msg += '   📋 ' + tgEsc(p.origin) + '\n';
        if (partner) msg += '   🏢 ' + tgEsc(partner) + '\n';
        if (p.state) msg += '   📌 ' + (stateMap[p.state] || tgEsc(p.state)) + '\n';
        const d = p.date_done || p.scheduled_date;
        if (d) msg += '   📅 ' + tgEsc(String(d).slice(0, 10)) + '\n';
        if (p.lines && p.lines.length) {
          p.lines.forEach(l => {
            const pname = Array.isArray(l.product_id) ? l.product_id[1] : '';
            const qty = l.quantity || l.product_uom_qty || 0;
            const uom = Array.isArray(l.product_uom) ? l.product_uom[1] : '';
            msg += '      • ' + tgEsc(pname) + ' — ' + qty + ' ' + tgEsc(uom) + '\n';
          });
        }
        msg += '\n';
      });
      return msg.trim();
    } catch (e) {
      return '❌ ดึงข้อมูล Odoo ไม่สำเร็จ: ' + tgEsc(e.message);
    }
  }

  // ไม่ใช่คำสั่งที่รู้จัก — เงียบไว้ (return null = ไม่ตอบ)
  return null;
}

// ============================================================================
//  CRON: สรุปงานรับ/ส่งประจำวัน (07:45 น.)
// ============================================================================
async function dailyReceiveSend() {
  const today = todayStr();

  // ── ดึงงานวันนี้ (ทุก field รวมไฟล์แนบ) ────────────────────────────────
  const { data: todayData } = await db.from('tasks').select('*')
    .eq('action_date', today)
    .order('done', { ascending: true })
    .order('seq',  { ascending: true });
  const list = todayData || [];

  // ── ดึงงานค้างจากวันก่อน (ยังไม่ done, action_date < today) ────────────
  const { data: overdueData } = await db.from('tasks').select('*')
    .eq('done', false)
    .lt('action_date', today)
    .order('action_date', { ascending: true })
    .order('seq',         { ascending: true });
  const overdueList = overdueData || [];

  // ถ้าไม่มีงานเลย → ส่งข้อความแจ้งว่าวันนี้ไม่มีงาน
  if (!list.length && !overdueList.length) {
    await notifyTelegram(
      '🌅 <b>สรุปงานประจำวัน</b>\n' +
      '📅 ' + tgDate(today) + '\n\n' +
      '📊 วันนี้ไม่มีงานรับ/ส่งครับ'
    );
    return { success: true, count: 0 };
  }

  // ── helper แสดงรายละเอียด 1 งาน พร้อมสถานะ + วันที่ + ไฟล์แนบ ──────────
  const fmtTask = (t, i, showDate = false) => {
    const statusIcon = t.done ? '✅' : t.task_status === 'Doing' ? '🟣' : '🔵';
    let s = (i + 1) + '. 📋 <b>' + tgEsc(t.task || '-') + '</b>\n';
    s += '   ' + statusIcon + ' ' + tgEsc(t.done ? 'Done' : (t.task_status || 'To Do')) + '\n';
    if (showDate && t.action_date)
      s += '   📅 กำหนด: ' + tgDate(t.action_date) + ' (' + tgEsc(calcDays(dstr(t.action_date))) + ')\n';
    if (t.categories) s += '   🏷️ ' + tgEsc(t.categories) + '\n';
    if (t.sales_name) s += '   👤 ' + tgEsc(t.sales_name) + '\n';
    if (t.note)       s += '   📝 ' + tgEsc(t.note) + '\n';
    try {
      const files = typeof t.attachments === 'string'
        ? JSON.parse(t.attachments || '[]')
        : (Array.isArray(t.attachments) ? t.attachments : []);
      files.forEach(f => {
        const fname = tgEsc(f.name || 'ไฟล์');
        const url = f.webViewLink || f.wl || '';
        if (url) s += '   📎 <a href="' + url + '">' + fname + '</a>\n';
        else if (fname) s += '   📎 ' + fname + '\n';
      });
    } catch (e) {}
    return s;
  };

  // ── แยกประเภท รับ / ส่ง / อื่นๆ สำหรับงานวันนี้ ──────────────────────
  const rap   = list.filter(t => t.duration === 'รับ');
  const send  = list.filter(t => t.duration === 'ส่ง');
  const other = list.filter(t => t.duration !== 'รับ' && t.duration !== 'ส่ง');

  // ── สร้างข้อความ ──────────────────────────────────────────────────────
  let msg = '🌅 <b>สรุปงานประจำวัน</b>\n';
  msg += '📅 ' + tgDate(today) + '\n';

  // สรุปตัวเลขงานวันนี้
  if (list.length) {
    msg += '\n📊 <b>งานวันนี้ทั้งหมด ' + list.length + ' งาน</b>';
    if (rap.length)   msg += '  |  📦 รับ ' + rap.length;
    if (send.length)  msg += '  |  🚚 ส่ง ' + send.length;
    if (other.length) msg += '  |  📋 อื่นๆ ' + other.length;
    msg += '\n';
  } else {
    msg += '\n📊 วันนี้ไม่มีงานใหม่\n';
  }

  // งานรับวันนี้
  if (rap.length) {
    msg += '\n━━━━━━━━━━━━━━━━\n';
    msg += '📦 <b>งานรับวันนี้ (' + rap.length + ')</b>\n';
    msg += '━━━━━━━━━━━━━━━━\n';
    rap.forEach((t, i) => { msg += fmtTask(t, i) + '\n'; });
  }

  // งานส่งวันนี้
  if (send.length) {
    msg += '\n━━━━━━━━━━━━━━━━\n';
    msg += '🚚 <b>งานส่งวันนี้ (' + send.length + ')</b>\n';
    msg += '━━━━━━━━━━━━━━━━\n';
    send.forEach((t, i) => { msg += fmtTask(t, i) + '\n'; });
  }

  // งานอื่นๆ วันนี้
  if (other.length) {
    msg += '\n━━━━━━━━━━━━━━━━\n';
    msg += '📋 <b>งานอื่นๆ วันนี้ (' + other.length + ')</b>\n';
    msg += '━━━━━━━━━━━━━━━━\n';
    other.forEach((t, i) => { msg += fmtTask(t, i) + '\n'; });
  }

  // งานค้างจากวันก่อน
  if (overdueList.length) {
    msg += '\n━━━━━━━━━━━━━━━━\n';
    msg += '🔴 <b>งานค้างจากวันก่อน (' + overdueList.length + ')</b>\n';
    msg += '━━━━━━━━━━━━━━━━\n';
    overdueList.forEach((t, i) => { msg += fmtTask(t, i, true) + '\n'; });
  }

  await notifyTelegram(msg);
  return { success: true, count: list.length + overdueList.length };
}

// ============================================================================
//  CRON: สรุปงานตอนเย็น + แจ้งเตือนงานพรุ่งนี้ (16:45 น.)
// ============================================================================
async function eveningReport() {
  const today = todayStr();
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const tmrStr = tomorrow.toISOString().slice(0, 10);

  // สรุปวันนี้
  const { data: todayData } = await db.from('tasks').select('done, task_status').eq('action_date', today);
  const todayList = todayData || [];
  const doneToday = todayList.filter(t => t.done).length;
  const pendingToday = todayList.filter(t => !t.done).length;

  // งานพรุ่งนี้ — ดึงครบทุก field รวมไฟล์แนบ
  const { data: tmrData } = await db.from('tasks').select('*')
    .eq('done', false).eq('action_date', tmrStr).order('seq', { ascending: true });
  const tmrList = tmrData || [];

  // งานค้างทั้งหมด
  const { data: allPending } = await db.from('tasks').select('task_status').eq('done', false);
  const totalPending = (allPending || []).length;

  // helper แสดงรายละเอียดงาน 1 รายการ (พร้อมไฟล์แนบ)
  const fmtTask = (t, i) => {
    let s = (i + 1) + '. 📋 <b>' + tgEsc(t.task || '-') + '</b>\n';
    if (t.categories) s += '   🏷️ ' + tgEsc(t.categories) + '\n';
    if (t.sales_name)  s += '   👤 ' + tgEsc(t.sales_name) + '\n';
    if (t.note)        s += '   📝 ' + tgEsc(t.note) + '\n';
    // ไฟล์แนบ
    try {
      const files = typeof t.attachments === 'string'
        ? JSON.parse(t.attachments || '[]')
        : (Array.isArray(t.attachments) ? t.attachments : []);
      files.forEach(f => {
        const fname = tgEsc(f.name || 'ไฟล์');
        const url = f.webViewLink || f.wl || '';
        if (url) s += '   📎 <a href="' + url + '">' + fname + '</a>\n';
        else if (fname) s += '   📎 ' + fname + '\n';
      });
    } catch (e) {}
    return s;
  };

  // แยกประเภท รับ / ส่ง / อื่นๆ
  const rapList  = tmrList.filter(t => t.duration === 'รับ');
  const sendList = tmrList.filter(t => t.duration === 'ส่ง');
  const otherList = tmrList.filter(t => t.duration !== 'รับ' && t.duration !== 'ส่ง');

  let msg = '🌆 <b>สรุปงานประจำวัน</b>\n';
  msg += '📅 ' + tgDate(today) + '\n\n';
  msg += '📊 <b>สรุปวันนี้</b>\n';
  msg += '✅ เสร็จแล้ว: ' + doneToday + ' งาน\n';
  msg += '⏳ ยังค้าง: ' + pendingToday + ' งาน\n';
  msg += '📋 ค้างทั้งหมดในระบบ: ' + totalPending + ' งาน\n';

  if (!tmrList.length) {
    msg += '\n📅 พรุ่งนี้ (' + tgDate(tmrStr) + ') ไม่มีงานครับ\n';
  } else {
    msg += '\n━━━━━━━━━━━━━━━━\n';
    msg += '📅 <b>งานพรุ่งนี้ ' + tgDate(tmrStr) + ' (' + tmrList.length + ' งาน)</b>\n';
    msg += '━━━━━━━━━━━━━━━━\n';

    if (rapList.length) {
      msg += '\n📦 <b>งานรับ (' + rapList.length + ')</b>\n';
      rapList.forEach((t, i) => { msg += fmtTask(t, i) + '\n'; });
    }

    if (sendList.length) {
      msg += '\n🚚 <b>งานส่ง (' + sendList.length + ')</b>\n';
      sendList.forEach((t, i) => { msg += fmtTask(t, i) + '\n'; });
    }

    if (otherList.length) {
      msg += '\n📋 <b>งานอื่นๆ (' + otherList.length + ')</b>\n';
      otherList.forEach((t, i) => { msg += fmtTask(t, i) + '\n'; });
    }
  }
  await notifyTelegram(msg);
  return { success: true };
}

// ============================================================================
//  CRON: สรุป KPI รายเดือน (วันที่ 1 ของเดือน 8:00 น.)
// ============================================================================
async function monthlyKPIReport() {
  // ดึงเดือนที่แล้ว
  const now = new Date();
  const prevMonth = now.getMonth() === 0 ? 12 : now.getMonth(); // getMonth() คืน 0-11
  const prevYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();

  const { data: staff } = await db.from('kpi_staff').select('*').neq('active', false);
  if (!staff || !staff.length) return { success: true, count: 0 };

  let passCount = 0, failCount = 0, noDataCount = 0;
  let details = '';

  for (const emp of staff) {
    const { data: km } = await db.from('kpi_monthly').select('*')
      .eq('emp_id', emp.id).eq('month', prevMonth).eq('year', prevYear);
    const row = km && km[0];
    const fullName = tgEsc((emp.name || '') + ' ' + (emp.surname || ''));
    if (!row) {
      noDataCount++;
      details += '⬜ ' + fullName + ' — ไม่มีข้อมูล\n';
      continue;
    }
    const items = Array.isArray(row.kpi_data) ? row.kpi_data : [];
    const tMax = items.reduce((s, x) => s + (parseFloat(x.maxScore) || 0), 0);
    const tScore = items.reduce((s, x) => s + (parseFloat(x.score) || 0), 0);
    const pct = tMax > 0 ? Math.round(tScore / tMax * 100) : 0;
    const thr = parseFloat(row.pass_threshold) || 70;
    const pass = pct >= thr;
    if (pass) passCount++; else failCount++;
    details += (pass ? '✅' : '❌') + ' ' + fullName + ' — ' + pct + '% (' + tScore + '/' + tMax + ')\n';
  }

  let msg = '📈 <b>สรุป KPI เดือน ' + prevMonth + '/' + prevYear + '</b>\n\n';
  msg += '✅ ผ่าน: ' + passCount + ' คน\n';
  msg += '❌ ไม่ผ่าน: ' + failCount + ' คน\n';
  if (noDataCount) msg += '⬜ ไม่มีข้อมูล: ' + noDataCount + ' คน\n';
  msg += '\n<b>รายละเอียด:</b>\n' + details;

  await notifyTelegram(msg);
  return { success: true, pass: passCount, fail: failCount };
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
  msg += '📅 ' + tgDate(today) + '\n';
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
// ============================================================================
//  เอกสาร รับ-ส่ง (Document Receive-Send) — แยกตามเดือน
// ============================================================================
// ดึงรายการเดือนทั้งหมดที่มีข้อมูล (สำหรับ sidebar ประวัติ)
async function getDocRSMonths() {
  const { data, error } = await db.from('docs_receive').select('month_key').order('month_key', { ascending: false });
  if (error) throw error;
  const seen = {};
  (data || []).forEach(r => { if (r.month_key) seen[r.month_key] = true; });
  return Object.keys(seen).sort().reverse();
}

// ดึงข้อมูลของเดือนที่ระบุ (month_key = 'YYYY-MM')
async function getDocRSByMonth(monthKey) {
  const { data, error } = await db.from('docs_receive').select('*')
    .eq('month_key', monthKey).order('seq', { ascending: true });
  if (error) throw error;
  return (data || []).filter(r => r.id).map(r => ({
    id: String(r.id),
    company: String(r.company || ''),
    recvDate: dstr(r.recv_date),
    headSet: r.head_set === true,
    headMo:  r.head_mo === true,
    headSep: r.head_sep === true,
    poNo: String(r.po_no || ''),
    docTaxOriginal: r.doc_tax_original === true,
    docTemp: r.doc_temp === true,
    docWeight: r.doc_weight === true,
    docReport: r.doc_report === true,
    docGoods: r.doc_goods === true
  }));
}

// บันทึกข้อมูลทั้งเดือน (ลบเก่าของเดือนนั้นแล้วใส่ใหม่)
async function saveDocRSBatch(payload) {
  const monthKey = payload.monthKey;
  if (!monthKey) return { success: false, error: 'ไม่มี monthKey' };
  await db.from('docs_receive').delete().eq('month_key', monthKey);
  const rows = payload.rows || [];
  if (rows.length > 0) {
    const vals = rows.map((r, i) => ({
      id: 'DR' + Date.now().toString(36).toUpperCase() + i,
      month_key: monthKey,
      seq: i,
      company: r.company || '',
      recv_date: r.recvDate || null,
      head_set: r.headSet === true,
      head_mo:  r.headMo === true,
      head_sep: r.headSep === true,
      po_no: r.poNo || '',
      doc_tax_original: r.docTaxOriginal === true,
      doc_temp: r.docTemp === true,
      doc_weight: r.docWeight === true,
      doc_report: r.docReport === true,
      doc_goods: r.docGoods === true
    }));
    const { error } = await db.from('docs_receive').insert(vals);
    if (error) return { success: false, error: error.message };
  }
  return { success: true, count: rows.length };
}

// ลบข้อมูลทั้งเดือน
async function deleteDocRSMonth(monthKey) {
  const { error } = await db.from('docs_receive').delete().eq('month_key', monthKey);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

// ── ฐานข้อมูลชื่อบริษัท (สำหรับ dropdown ในเอกสาร รับ-ส่ง) ──────────────────
async function getDocRSCompanies() {
  const { data, error } = await db.from('docs_companies').select('*').order('name');
  if (error) throw error;
  return (data || []).filter(r => r.id).map(r => ({ id: String(r.id), name: String(r.name || '') }));
}

async function addDocRSCompany(name) {
  const nm = (name || '').trim();
  if (!nm) return { success: false, error: 'ชื่อบริษัทว่าง' };
  // กันชื่อซ้ำ
  const { data: existing } = await db.from('docs_companies').select('id').eq('name', nm);
  if (existing && existing.length) return { success: false, error: 'มีชื่อบริษัทนี้แล้ว' };
  const id = 'DC' + Date.now().toString(36).toUpperCase();
  const { error } = await db.from('docs_companies').insert({ id, name: nm });
  if (error) return { success: false, error: error.message };
  return { success: true, id, name: nm };
}

async function deleteDocRSCompany(id) {
  const { error } = await db.from('docs_companies').delete().eq('id', id);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

// ── นับผู้ใช้งานออนไลน์ (heartbeat) ──────────────────────────────────────────
// ไม่มีระบบ user/login รายคน เลยใช้วิธี: หน้าเว็บฝั่ง browser สุ่ม session id
// เก็บไว้ใน localStorage แล้วยิง heartbeat มาทุกๆ ~30 วินาที
// "ออนไลน์" = session ที่ ping เข้ามาภายใน 2 นาทีที่ผ่านมา
async function heartbeat(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return { online: 0 };
  const now = new Date().toISOString();
  try {
    await db.from('active_sessions').upsert({ session_id: String(sessionId).slice(0, 100), last_seen: now });
  } catch (e) { /* ไม่ต้อง throw แม้ upsert ไม่สำเร็จ ยังคืน count ได้ */ }

  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { count, error } = await db.from('active_sessions')
    .select('session_id', { count: 'exact', head: true })
    .gte('last_seen', cutoff);
  if (error) return { online: 1 };
  return { online: count || 0 };
}

const HANDLERS = {
  heartbeat,
  getTasks, addTask, updateTask, deleteTask,
  checkDueTasks, dailyReceiveSend, eveningReport, monthlyKPIReport,
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
  getKPIForm, saveKPIForm,
  getDocRSMonths, getDocRSByMonth, saveDocRSBatch, deleteDocRSMonth,
  getDocRSCompanies, addDocRSCompany, deleteDocRSCompany,
  notifyNewTask
};

// ── สร้าง PDF ใบส่งของจาก Odoo แล้วส่งเข้า Telegram ─────────────────────────
// คืน { ok, error } — เรียกจาก telegram.js เมื่อเจอคำสั่ง /ใบส่งของpdf
export async function sendDeliveryPDF(chatId, keyword, statusFilter = 'pending', dateFilter = null) {
  if (!TG_TOKEN) return { ok: false, error: 'ยังไม่ได้ตั้ง TELEGRAM_BOT_TOKEN' };
  if (!odooConfigured()) {
    await sendTelegramReply(chatId, '❌ ยังไม่ได้ตั้งค่า Odoo ครับ');
    return { ok: false };
  }
  try {
    const { keyword: dkw, company: dCo } = parseCompany(keyword);
    const allPicks = await odooDelivery(dkw, dCo.id);
    if (!allPicks.length) {
      await sendTelegramReply(chatId, '🔍 ไม่พบใบส่งของ "' + dkw + '" (บริษัท ' + dCo.name + ') ใน Odoo');
      return { ok: false };
    }
    // กรองตาม statusFilter
    let picks = allPicks.filter(p => {
      if (statusFilter === 'done') return p.state === 'done';
      if (statusFilter === 'all')  return true;
      return p.state !== 'done' && p.state !== 'cancel';
    });
    // กรองตามวันที่ Scheduled (ถ้าระบุ)
    if (dateFilter) {
      picks = picks.filter(p => String(p.scheduled_date || '').slice(0, 10) === dateFilter);
    }
    if (!picks.length) {
      const lb = statusFilter === 'done' ? 'ส่งแล้ว' : statusFilter === 'all' ? 'ทั้งหมด' : 'รอส่ง';
      const dnote = dateFilter ? ' วันที่ ' + dateFilter : '';
      await sendTelegramReply(chatId, '🔍 ไม่พบใบส่งของสถานะ "' + lb + '"' + dnote + ' ของ "' + dkw + '"\n(มีทั้งหมด ' + allPicks.length + ' ใบ ลอง /ใบส่งของ ' + dkw + ' ทั้งหมด)');
      return { ok: false };
    }
    const stateMap = {
      draft: 'ร่าง', waiting: 'รอ', confirmed: 'รอของ',
      assigned: 'พร้อมส่ง', done: 'ส่งแล้ว', cancel: 'ยกเลิก'
    };
    // เตรียมข้อมูลสำหรับ PDF
    let cntDone = 0, cntPending = 0, cntCancel = 0;
    const picksData = picks.map(p => {
      // Done = ส่งแล้ว(แดง), Cancel = ยกเลิก(เทา), ที่เหลือ = รอส่ง(เขียว)
      let statusText, statusColor;
      if (p.state === 'done')        { statusText = 'ส่งแล้ว'; statusColor = 'red';  cntDone++; }
      else if (p.state === 'cancel') { statusText = 'ยกเลิก';  statusColor = 'gray'; cntCancel++; }
      else                           { statusText = 'รอส่ง';   statusColor = 'green'; cntPending++; }
      return {
        name: p.name || '-',
        origin: p.origin || '',
        partner: Array.isArray(p.partner_id) ? p.partner_id[1] : '',
        statusText,
        statusColor,
        shipped: p.state === 'done',
        date: String(p.date_done || p.scheduled_date || '').slice(0, 10),
        lines: (p.lines || []).map(l => ({
          name: Array.isArray(l.product_id) ? l.product_id[1] : '',
          qty: l.quantity || l.product_uom_qty || 0,
          uom: Array.isArray(l.product_uom) ? l.product_uom[1] : ''
        })),
        images: p.images || []
      };
    });
    const statusLabel2 = (typeof statusFilter !== 'undefined' && statusFilter === 'done') ? 'ส่งแล้ว'
      : (typeof statusFilter !== 'undefined' && statusFilter === 'all') ? 'ทั้งหมด' : 'รอส่ง';
    const data = {
      summary: { total: picks.length, done: cntDone, pending: cntPending, cancel: cntCancel },
      picks: picksData
    };

    // บันทึกลง delivery_views แล้วส่งลิงก์ (ภาษาไทยชัด เปิดมือถือ/พิมพ์ PDF ได้)
    const viewId = 'D' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();
    const { error: insErr } = await db.from('delivery_views').insert({
      id: viewId,
      title: 'ใบส่งของ — ' + dkw + ' (' + dCo.name + ')',
      company: dCo.name,
      status_label: statusLabel2,
      data: data
    });
    if (insErr) {
      await sendTelegramReply(chatId, '⚠️⚠️⚠️ บันทึกใบส่งของไม่สำเร็จ: ' + insErr.message);
      return { ok: false };
    }
    const viewUrl = 'https://inventory-rho-hazel.vercel.app/delivery.html?id=' + viewId;
    const sumLine = 'รวม ' + picks.length + ' ใบ'
      + (cntDone    ? ' | ส่งแล้ว ' + cntDone    : '')
      + (cntPending ? ' | รอส่ง '   + cntPending : '')
      + (cntCancel  ? ' | ยกเลิก '  + cntCancel  : '');
    await sendTelegramReply(chatId,
      '📄 ใบส่งของ "' + dkw + '" — ' + dCo.name + ' [' + statusLabel2 + ']\n' + sumLine +
      '\n\n📎 เปิดดูใบส่งของ:\n' + viewUrl
    );
    return { ok: true };
  } catch (e) {
    await sendTelegramReply(chatId, '⚠️⚠️⚠️ สร้างใบส่งของไม่สำเร็จ: ' + e.message);
    return { ok: false, error: e.message };
  }
}

export const __handlers = HANDLERS;
export { checkDueTasks, dailyReceiveSend, eveningReport, monthlyKPIReport, handleTelegramCommand };

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
  const id = String(chatId);
  if (id === String(TG_CHAT)) return true;
  if (TG_CHAT2 && id === String(TG_CHAT2)) return true;
  return false;
}

// เช็คว่าเป็นกลุ่มหลักหรือกลุ่มใหม่
export function getChatType(chatId) {
  const id = String(chatId);
  if (id === String(TG_CHAT)) return 'main';
  if (TG_CHAT2 && id === String(TG_CHAT2)) return 'sub';
  return null;
}

// ส่งข้อความไปกลุ่มหลัก (ใช้แจ้งเตือนเมื่อมีงานใหม่จากกลุ่มย่อย)
export async function notifyMainChat(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
  } catch(e) { console.error('notify main failed:', e.message); }
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
