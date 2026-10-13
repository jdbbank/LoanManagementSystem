# วิธีรันชุดทดสอบก่อนขึ้น Production (scripts/test)

ชุดทดสอบนี้ **ล้างฐานข้อมูลทดสอบ → สร้างข้อมูลจำลองชุดใหม่ → ยิง API จริงทุกฟังก์ชัน → เทียบตัวเลขกับ
oracle ที่คำนวณแยกจากเซิร์ฟเวอร์** แล้วเก็บผลทุกข้อไว้ให้ตรวจทีละบรรทัด

ขอบเขต: MySQL `loan_management` บนเครื่อง dev เท่านั้น ห้ามชี้ไประบบจริงเด็ดขาด
(`reset-db.mjs` มี guardบังคับ: `DB_HOST` ต้องเป็น localhost/docker, `NODE_ENV≠production`,
ต้องใส่ `--confirm-loan_management` และต้องมีไฟล์ backup อายุไม่เกิน 30 นาที)

---

## 1. เตรียมสภาพแวดล้อม

```bash
docker compose up -d mysql            # หรือ npm run db:up
```

1. แก้ `server/.env` → `SEED_ON_BOOT=false`
   (ถ้าเป็น `true` ทุกครั้งที่รีสตาร์ต เซิร์ฟเวอร์จะเติมข้อมูล demo `LN-0000xx` กลับมาปนกับชุดทดสอบ
   ทำให้ `expected.json` เทียบไม่ตรง — dotenv ให้ค่าที่ set ใน shell ชนะค่าในไฟล์)
2. สตาร์ท backend: `npm run dev:server` (ค่าเริ่มต้น `PORT=4000`) แล้วตรวจ `http://127.0.0.1:4000/health` = 200
3. การส่งเมล/OTP: ปล่อย `NOTIFY_TRANSPORT` เป็นค่าเริ่มต้น **log** — ห้ามต่อ SMTP/SMS หรือบริการจริง
   ชุดทดสอบอ่าน OTP จาก `notification_outbox` (ค่าถูก seal ไว้ harness ปลดด้วย `NOTIFY_SECRET_KEY`)
4. Kafka/mailer ไม่ต้องรัน — ทุก suite ทำงานกับ backend ตรง ๆ

สคริปต์ทั้งหมดอ่านค่าเชื่อมต่อจาก `server/.env` ไฟล์เดียวกันนี้ ไม่ต้องตั้ง env เพิ่ม

## 2. รัน

| คำสั่ง | ทำอะไร |
|---|---|
| `npm run test:e2e:full` | **คำสั่งเดียวจบ**: oracle self-test → backup → ล้าง DB → seed → รัน suite 01–15 |
| `npm run test:e2e:oracle` | ตรวจ `oracle.mjs` ด้วยชุดตัวเลขที่คนคำนวณเอง (ไม่แตะ DB) |
| `npm run test:e2e:backup` | `mysqldump` ผ่าน `docker exec` ลง `backups/` (เงื่อนไขที่ reset-db ต้องการ) |
| `npm run test:e2e:reset` | ล้างทุกตารางข้อมูล **เก็บ** `system_config` + `email_templates` แล้วพิมพ์จำนวนแถวที่ยืนยันว่าว่าง |
| `npm run test:e2e:seed` | ใส่ข้อมูลจำลอง 21 เงินกู้ / 16 เดือน + เขียน `expected.json`, `seed-manifest.json` |
| `npm run test:e2e:run` | รัน suite ทั้งหมด (server ต้องรันอยู่) |
| รันเฉพาะบางชุด | `node scripts/test/run-e2e.mjs 07-posting 15-invariants` (ต้องใช้ชื่อเต็ม) |

`test:e2e:full` **จะไม่ start/stop backend ให้** — เจ้าของ process คือตัวคุณ ถ้า `/health` ไม่ตอบ
สคริปต์จะจบทันทีโดยยังไม่ล้างหรือ seed ใด ๆ

## 3. อ่านผลลัพธ์

- `scripts/test/results.json` — ทุกข้อ: `id / category / name / input / expected / actual / pass / note`
  **เปิดด้วย editor เท่านั้น** (ข้อความไทย; console บน Windows เป็น cp1252 จึงพิมพ์ไม่ได้)
- consoleของ `run-e2e.mjs` เป็น ASCIIล้วน: 1 บรรทัดต่อ suite = จำนวนข้อ / ผ่าน / ไม่ผ่าน + id ที่ไม่ผ่าน
- exit code: `0` = ทุกข้อผ่าน · `2` = มีข้อไม่ผ่าน (เก็บไว้เป็นข้อค้นพบ) · `1` = เริ่มรันไม่ได้ (server ไม่ตอบ / suite crash)
- ดูรายข้อจาก shell ได้ด้วย: `node -e "const r=require('./scripts/test/results.json');console.log(r.cases.filter(c=>!c.pass).map(c=>c.id).join(','))"`

## 4. ข้อมูลจำลองและสูตรที่ล็อกไว้

- generator: `dataset.mjs` ใช้อัลกอริทึม deterministic (`mulberry32`, seed `12345`, `REFERENCE_NOW` คงที่)
  รันซ้ำได้ข้อมูลชุดเดียวกันเป๊ะ
- `oracle.mjs` คำนวณคาดหวังกฎธุรกิจ **โดยไม่ให้ import โค้ดเซิร์ฟเวอร์**: จัดสรรเงินตามลำดับ
  ค่าปรับ → ดอกเบี้ยค้าง → ต้นเงิน, 30 วัน/เดือน 365 วัน/ปี, กลับรายการต้องเดินตาม allocation เดิม,
  waiver/write-off ห้ามเกินยอดคงค้าง, สถานะปิดเมื่อยอดเป็น 0
- `expected.json` เขียนตอน seed และถูก harness อ่านเทียบ; `seed-manifest.json` บันทึกว่าใส่ตารางละกี่แถว
- บัญชีผู้ใช้ทดสอบ: `test_admin`, `test_head`, `test_checker1`, `test_checker2`, `test_op1`, `test_op2`,
  `test_view1`, `test_disabled`, `test_noemail`, `test_unverified`, `test_deleted`
  รหัสผ่านเดียวกันหมด `Tst@2026#a` (เปลี่ยนได้ผ่าน `TEST_PASSWORD`) · คนละ port/เครื่อง ตั้งได้ผ่าน `TEST_BASE_URL`

## 5. ตาราง 15 ชุดทดสอบ

| suite | ครอบคลุม | ข้อค้นพบที่ **ตั้งใจให้แดง** (ห้ามแก้สูตรเพื่อให้ผ่าน) |
|---|---|---|
| `01-auth` | login, JWT, role, revocation token หลังปิดใช้งาน/ลบผู้ใช้ | — |
| `02-forgot-password` | OTP 6 หลัก, attempts, link, reset, sealing in outbox | — |
| `03-users` | CRUD ผู้ใช้, avatar, enable/disable, delete/restore | — |
| `04-kyc` | อัปโหลดเอกสาร, maker-checker, gate ก่อนจ่ายเงินกู้ | — |
| `05-loans` | ผลิตภัณฑ์, create/approve/disburse, snapshot อัตรา–นโยบายค่าปรับ | — |
| `06-payments` | payment request, allocation, credit, stale approval | F-PAY-1 |
| `07-posting` | โพสต์รายการ, สถานะ, waiver, write-off, adjustment, reversal | F-PEN-1/2 |
| `08-settlement` | ข้อตกลงปิดบัญชี, ชำระตามข้อตกลง, เพดานวงเงิน | F-SET-1 |
| `09-reconciliation` | reconcile ledger ↔ loan book ↔ รายงาน | F-REC-1/2/3 |
| `10-reports` | รายงานรายเดือน, MoM/YoY, dashboard, schedule summary | F-RPT-1 |
| `11-notifications` | outbox, template, locale lo/en, transport=log | F-NTF-1/2/3 |
| `12-logger` | winston file/level, ห้าม secret ใน log, rotation | F-LOG-1..4, F-NTF-4/5 |
| `13-config` | system_config, threshold, KYC policy, email template | F-CFG-1/2 + F-CFG-OBS-1..5 |
| `14-concurrency` | ยิงพร้อมกัน: โพสต์/อนุมัติ/กลับรายการ/credit/OTP/reset | F-CONC-1/3/4/5 + F-CONC-OBS-1/2 |
| `15-invariants` | **ประตูก่อน Production**: reconcile 4 มุม (คอลัมน์ในตาราง / derive จาก ledger / replay ด้วย oracle / HTTP API) ทั้งเล่ม | F-INV-1 |

หมายเหตุ `15-invariants`: อ่านอย่างเดียว ไม่เขียนอะไรลง DB และนับเฉพาะเงินกู้ 21 ฉบับจาก seed
จึงไม่ได้รับผลกระทบจากแถวที่ suite อื่นสร้าง-ลบไว้

## 6. กติกาขณะใช้ชุดทดสอบนี้

1. **ห้ามแก้กฎธุรกิจหรือสูตรคำนวณที่ล็อกไว้เพื่อให้เทสต์ผ่าน** — ถ้าตัวเลขไม่ตรง ให้รายงานพร้อมหลักฐาน
2. เจอบั๊กให้รายงานก่อน — ห้ามแก้โค้ดระบบเองโดยไม่ถาม ยกเว้นได้รับคำสั่ง
3. ห้ามใช้ข้อมูล/บัญชีจริง และห้ามเรียก SMTP/SMS/บริการภายนอกจริง
4. suite ที่เขียนข้อมูลต้องล้างของตัวเองออก (สร้าง → ตรวจ → purge + คืนค่า config) เพื่อให้รันซ้ำแล้วผลเหมือนเดิม
5. UI บนเบราว์เซอร์จะไม่ตรวจถ้ายังไม่ได้รับอนุญาต (ใช้ `npm run test -w server`, `tsc --noEmit`, `vite build`, `oxlint` แทน)

## 7. ล้างของทดสอบออกก่อนขึ้น Production (Stage 5)

- `scripts/test/cleanup-before-prod.mjs` — **เตรียมไว้เท่านั้น ห้ามรันถ้าไม่ได้สั่ง**
  ต้องลบไฟล์ log เก่าที่ยังมี OTP plain text (`server/logs/*LoanSystem.log`) และแถวทดสอบออกจาก DB
- วิธีคืนข้อมูลจาก backup:

```bash
docker exec -i loan-ms-mysql mysql -uroot -p<DB_PASSWORD> < backups/loan_management_<stamp>.sql
```

- ถ้า container ใช้ชื่ออื่นนอกเหนือจาก `loan-ms-mysql` ให้ตั้ง `LOAN_DB_CONTAINER`
  ถ้าอยากเก็บ backup ไว้โฟลเดอร์อื่นให้ตั้ง `LOAN_BACKUP_DIR`
