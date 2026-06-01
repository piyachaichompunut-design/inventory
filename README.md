# 📋 Task Management System — GitHub + Supabase + Vercel

ระบบบริหารงาน/คลังสินค้า เดิมเขียนด้วย **Google Apps Script + Google Sheets**
โปรเจกต์นี้ได้แปลงให้รันบนสถาปัตยกรรมใหม่:

| เดิม (Apps Script) | ใหม่ (โปรเจกต์นี้) |
|---|---|
| Google Sheets | **Supabase** (PostgreSQL) |
| `Code.gs` (server functions) | **Vercel Serverless Function** `api/rpc.js` |
| `google.script.run` | **`app-shim.js`** (เรียก `/api/rpc` แทน) |
| Google Drive (ไฟล์แนบ) | **Supabase Storage** (bucket `attachments`) |
| HTML Service | ไฟล์ static `index.html` เสิร์ฟผ่าน Vercel |

หน้าจอ (UI) ทั้งหมดเหมือนเดิมทุกประการ — ไม่ได้แก้โค้ดส่วนแสดงผล มีแค่ชั้นเชื่อมต่อข้อมูลที่เปลี่ยนไป

---

## โครงสร้างไฟล์

```
.
├── index.html          # หน้าเว็บแอป (UI เดิม + แทรก app-shim.js)
├── app-shim.js         # เลียนแบบ google.script.run → เรียก /api/rpc
├── api/
│   └── rpc.js          # Serverless function: ทุกฟังก์ชันฝั่งเซิร์ฟเวอร์ (port จาก Code.gs)
├── supabase/
│   └── schema.sql      # สคริปต์สร้างตาราง + ข้อมูลตัวอย่างทั้งหมด
├── package.json        # ประกาศ dependency @supabase/supabase-js
├── vercel.json
├── .env.example        # ตัวอย่างค่า Environment Variables
└── .gitignore
```

---

## 🧭 ขั้นตอนการติดตั้ง (ทำตามลำดับ)

### ขั้นที่ 1 — สร้างฐานข้อมูลบน Supabase

1. ไปที่ <https://supabase.com> → **Sign in** → **New project**
2. ตั้งชื่อโปรเจกต์ + ตั้ง **Database Password** (จดเก็บไว้) → เลือก Region ใกล้ไทย (เช่น Singapore) → **Create new project** แล้วรอ ~2 นาที
3. เมนูซ้าย → **SQL Editor** → **New query**
4. เปิดไฟล์ `supabase/schema.sql` ในโปรเจกต์นี้ คัดลอก **ทั้งหมด** ไปวาง แล้วกด **Run** (มุมขวาล่าง)
   - จะได้ตาราง 15 ตาราง + ข้อมูลตัวอย่าง + bucket `attachments` สำหรับไฟล์แนบ
   - สคริปต์รันซ้ำได้ ถ้าต้องการรีเซ็ตข้อมูลก็รันใหม่ได้เลย
5. ไปที่ **Project Settings** (รูปเฟือง) → **API** แล้วจดค่า 2 ตัวนี้ไว้:
   - **Project URL** → ใช้เป็น `SUPABASE_URL`
   - **Project API keys → `service_role`** (กด reveal) → ใช้เป็น `SUPABASE_SERVICE_ROLE_KEY`

   > ⚠️ `service_role` เป็นกุญแจลับระดับสูง **ห้าม** นำไปใส่ในโค้ดฝั่งเบราว์เซอร์หรือ commit ขึ้น GitHub เด็ดขาด — ใช้เฉพาะเป็น Environment Variable บน Vercel เท่านั้น

---

### ขั้นที่ 2 — เก็บโค้ดขึ้น GitHub

**วิธี A — ผ่านเว็บ GitHub (ง่ายสุด ไม่ต้องใช้ command line)**

1. ไปที่ <https://github.com/new> → ตั้งชื่อ repo (เช่น `task-management`) → เลือก **Private** → **Create repository**
2. ในหน้า repo ที่ว่าง กด **uploading an existing file**
3. ลากไฟล์/โฟลเดอร์ทั้งหมดในโปรเจกต์นี้ (รวม `api/` และ `supabase/`) ไปวาง แล้วกด **Commit changes**

**วิธี B — ผ่าน Git (command line)**

```bash
cd task-management            # โฟลเดอร์โปรเจกต์นี้
git init
git add .
git commit -m "Task Management System: Supabase + Vercel"
git branch -M main
git remote add origin https://github.com/<ชื่อคุณ>/<ชื่อ-repo>.git
git push -u origin main
```

> ไฟล์ `.gitignore` กันไม่ให้ `node_modules/` และ `.env` ขึ้น GitHub อยู่แล้ว

---

### ขั้นที่ 3 — Deploy ขึ้น Vercel

1. ไปที่ <https://vercel.com> → **Sign up / Log in ด้วยบัญชี GitHub**
2. **Add New… → Project** → เลือก repo ที่เพิ่ง push ขึ้นไป → **Import**
3. หน้า Configure Project:
   - **Framework Preset:** ปล่อยเป็น **Other** (ไม่ต้องตั้ง Build Command — เป็น static + serverless)
   - กดเปิดหัวข้อ **Environment Variables** แล้วเพิ่ม 2 ตัว:

     | Name | Value |
     |---|---|
     | `SUPABASE_URL` | (Project URL จากขั้นที่ 1) |
     | `SUPABASE_SERVICE_ROLE_KEY` | (service_role key จากขั้นที่ 1) |

4. กด **Deploy** แล้วรอจนเสร็จ → กด **Visit** เพื่อเปิดเว็บแอป

เสร็จแล้ว! เปิดเว็บจะเห็นข้อมูลตัวอย่างที่ใส่ไว้ในขั้นที่ 1 และสามารถ เพิ่ม/แก้/ลบ ได้จริง บันทึกลง Supabase ทันที

> ถ้าแก้ Environment Variables ภายหลัง ต้องไปที่ **Deployments → … → Redeploy** หนึ่งครั้งเพื่อให้ค่าใหม่มีผล

---

## 🔧 ทดสอบบนเครื่องตัวเอง (ไม่บังคับ)

```bash
npm install -g vercel
vercel dev          # ระบบจะถามให้ใส่ Environment Variables ครั้งแรก
```

แล้วเปิด <http://localhost:3000>

---

## 🗄️ ตารางข้อมูลทั้งหมด (15 ตาราง)

| ตาราง | หน้าที่ |
|---|---|
| `tasks` | งานหลัก + สถานะ + ไฟล์แนบ (jsonb) |
| `categories` | หมวดหมู่งาน |
| `weight_jobs` | คำนวณน้ำหนักชิ้นงาน |
| `products` | รายการสินค้า / น้ำหนักต่อหน่วย |
| `loedaroon_po` | ระบบติดตาม PO เลิศอรุณ (การเรียกของแต่ละครั้งเก็บเป็น jsonb) |
| `ot_employees`, `ot_records` | พนักงาน OT และบันทึก OT รายวัน |
| `emp_staff`, `emp_attendance` | พนักงานและการเข้างานรายวัน |
| `kpi_records` | KPI รุ่นเดิม |
| `wire_notes` | Note สายไฟ (อาคเนย์ / เมิร์ค) |
| `kpi_staff`, `kpi_monthly` | KPI พนักงาน v2 + คะแนนรายเดือน |
| `wh_dashboard` | Dashboard คลังสินค้า (JSON ราย เดือน/ปี) |
| `kpi_form` | แบบฟอร์มรายงาน KPI FM-MR-03 |

---

## ❓ แก้ปัญหาเบื้องต้น

- **หน้าเว็บโหลดได้แต่ไม่มีข้อมูล / กดอะไรไม่ทำงาน** → ส่วนใหญ่คือยังไม่ได้ตั้ง Environment Variables หรือยังไม่ได้ Redeploy หลังตั้งค่า ลองเปิด DevTools (F12) → แท็บ Network ดู `/api/rpc` ว่ามี error ข้อความว่าอะไร
- **ขึ้นว่า "ยังไม่ได้ตั้งค่า SUPABASE_URL…"** → ใส่ Environment Variables ทั้ง 2 ตัวบน Vercel ให้ครบแล้ว Redeploy
- **อัปโหลดไฟล์แนบไม่ได้** → ตรวจว่ารัน `schema.sql` ครบ (ส่วนสร้าง bucket `attachments`) และที่ Supabase → **Storage** มี bucket ชื่อ `attachments` และตั้งเป็น public
- **อยากรีเซ็ตข้อมูลทั้งหมด** → รัน `supabase/schema.sql` ใหม่ใน SQL Editor

---

## 🔐 หมายเหตุด้านความปลอดภัย

แอปนี้ออกแบบให้ **เบราว์เซอร์ไม่ติดต่อ Supabase โดยตรง** — ทุกคำขอผ่าน Serverless Function `api/rpc.js` ที่ถือ `service_role` key อยู่ฝั่งเซิร์ฟเวอร์เท่านั้น จึงไม่จำเป็นต้องเปิด RLS ตั้งแต่แรกเพื่อให้เริ่มใช้งานได้ง่าย

หากนำไปใช้งานจริงและต้องการเพิ่มความปลอดภัย แนะนำให้:
1. เพิ่มระบบล็อกอิน/ตรวจสิทธิ์ก่อนเข้าถึง `/api/rpc`
2. เปิด Row Level Security ในแต่ละตาราง (`alter table <name> enable row level security;`) — `service_role` จะยังข้าม RLS ได้ตามปกติ 
