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
| `npm run test:e2e:full` | **คำสั่งเดียวจบ**: oracle self-test → backup → ล้าง DB → seed → รัน suite 01–19 |
| `npm run test:e2e:oracle` | ตรวจ `oracle.mjs` ด้วยชุดตัวเลขที่คนคำนวณเอง (ไม่แตะ DB) |
| `npm run test:e2e:backup` | `mysqldump` ผ่าน `docker exec` ลง `backups/` (เงื่อนไขที่ reset-db ต้องการ) |
| `npm run test:e2e:reset` | ล้างทุกตารางข้อมูล **เก็บ** `system_config` + `email_templates` (ยกเว้น `--wipe-config`) และ **เก็บเสมอ** `schema_migrations` เพราะเป็นบันทึกว่า migration ไหนรันแล้ว — ถ้าถูก truncate ครั้งถัดไปที่รัน `db:migrate` จะสร้างตารางซ้ำแล้วพัง |
| `npm run test:e2e:seed` | ใส่ข้อมูลจำลอง 21 เงินกู้ / 16 เดือน + เขียน `expected.json`, `seed-manifest.json` |
| `npm run test:e2e:run` | รัน suite ทั้งหมด (server ต้องรันอยู่) |
| รันเฉพาะบางชุด | `node scripts/test/run-e2e.mjs 07-posting 15-invariants` (ต้องใช้ชื่อเต็ม) |
| `npm run test:migrations` | ตรวจระบบ migration: สร้าง `loan_migrate_check` จาก migration ล้วน ๆ แล้วเทียบ `information_schema` (ตาราง/คอลัมน์/อินเด็กซ์) กับ `loan_management` ทีละบรรทัด + ทดลอง revert — **ไม่แตะข้อมูลจริง** (เปิด `loan_management` แบบอ่านอย่างเดียวผ่าน `information_schema`) และลบ scratch ทิ้งเมื่อจบ |
| `npm run logs:scrub` / `logs:scrub:apply` | สแกน (แล้วแต่จะล้าง) ค่าลับที่ค้างในไฟล์ log — ดูหัวข้อ 7 |

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
  waiver/write-off ห้ามเกินยอดคงค้าง, สถานะปิดเมื่อยอดเป็น 0, ค่านิยาม "ถึงรอบชำระ" (dueDate − leadDays),
  และ `earlySettlementFeeCents` (เปอร์เซ็นต์ของต้นเงินคงเหลือ เฉพาะกรณีปิดก่อนครบสัญญา)
- `expected.json` เขียนตอน seed และถูก harness อ่านเทียบ; `seed-manifest.json` บันทึกว่าใส่ตารางละกี่แถว
- บัญชีผู้ใช้ทดสอบ: `test_admin`, `test_head`, `test_checker1`, `test_checker2`, `test_op1`, `test_op2`,
  `test_view1`, `test_disabled`, `test_noemail`, `test_unverified`, `test_deleted`
  รหัสผ่านเดียวกันหมด `Tst@2026#a` (เปลี่ยนได้ผ่าน `TEST_PASSWORD`) · คนละ port/เครื่อง ตั้งได้ผ่าน `TEST_BASE_URL`

## 5. ตาราง 19 ชุดทดสอบ

| suite | ครอบคลุม | ข้อค้นพบที่ **ตั้งใจให้แดง** (ห้ามแก้สูตรเพื่อให้ผ่าน) |
|---|---|---|
| `01-auth` | login, JWT, role, revocation token หลังปิดใช้งาน/ลบผู้ใช้ | — |
| `02-forgot-password` | OTP 6 หลัก, attempts, link, reset, sealing in outbox | — |
| `03-users` | CRUD ผู้ใช้, avatar, enable/disable, delete/restore, self-service profile + เปลี่ยนรหัสผ่าน, อายุรหัสผ่าน (`passwordExpiry` บน `/users/me`), ห้ามใช้รหัสเดิม (`PASSWORD_REUSED`),รหัสหมดอายุ (403 `PASSWORD_EXPIRED`) + `change-expired-password` | — |
| `04-kyc` | อัปโหลดเอกสาร, maker-checker, gate ก่อนจ่ายเงินกู้ | — |
| `05-loans` | ผลิตภัณฑ์, create/approve/disburse, snapshot อัตรา–นโยบายค่าปรับ | — |
| `06-payments` | payment request, allocation, credit, stale approval (ยอดที่เกินกว่าหนี้ย้ายไปช่องทาง `DEPOSIT_TO_CREDIT` ตามประตูข้อ 2) | F-PAY-1 |
| `07-posting` | โพสต์รายการ, สถานะ, waiver, write-off, adjustment, reversal | F-PEN-1/2 |
| `08-settlement` | ข้อตกลงปิดบัญชี, ชำระตามข้อตกลง, เพดานวงเงิน, ค่าปรับปิดก่อนครบสัญญา (quote → snapshot → บิลเป็น PENALTY → เพดานรวมค่าปรับ) | F-SET-1 |
| `09-reconciliation` | reconcile ledger ↔ loan book ↔ รายงาน | F-REC-1/2/3 |
| `10-reports` | รายงานรายเดือน, MoM/YoY, dashboard, schedule summary | F-RPT-1 |
| `11-notifications` | outbox, template, locale lo/en, transport=log | F-NTF-1/2/3 |
| `12-logger` | winston file/level, ห้าม secret ใน log, rotation | F-LOG-1..4, F-NTF-4/5 |
| `13-config` | system_config, threshold, KYC policy, email template | F-CFG-1 (ปิดแล้ว — เก็บไว้เป็นเคสกันถอยหลัง), F-CFG-2 (ปิดแล้ว), F-NTF-7 (outbox กลับมาเกิดใหม่หลังถูกลบ — suite รอให้รอบส่งจบก่อนลบ) + F-CFG-OBS-1..5 |
| `14-concurrency` | ยิงพร้อมกัน: โพสต์/อนุมัติ/กลับรายการ/credit/OTP/reset | F-CONC-1/3/4/5 + F-CONC-OBS-1/2 |
| `15-invariants` | **ประตูก่อน Production**: reconcile 4 มุม (คอลัมน์ในตาราง / derive จาก ledger / replay ด้วย oracle / HTTP API) ทั้งเล่ม | F-INV-1 |
| `16-interest` | ดอกเบี้ยสองวิธีบนผลิตภัณฑ์ (FLAT ↔ DECLINING): วิธีคิดตอนปล่อยกู้, ตารางงวด, due list, dry-run + idempotency ของ accrual, bulk maker-checker, snapshot บนเงินกู้ชนะค่าปัจจุบันของผลิตภัณฑ์, ตรวจ ledger ทั้งเล่ม | — |
| `17-collection` | หน้าต่าง "ถึงรอบชำระแล้ว" (`GET /loans/:id/payable-now`), ประตู 422 ห้ามจ่ายก่อนรอบ (รวม lead days จากนโยบายค่าปรับ) และวัดเพดานใหม่ทุกครั้งที่—เพดานรอบสองคือเงินต้นของงวดที่ยังไม่ถูกตัด ไม่ใช่ 0, ตรวจเงินไม่รั่ว Σคงค้างรายงวด = ledger, ช่องฝากเข้า credit (`DEPOSIT_TO_CREDIT`), งาน auto-debit (สวิตช์ระดับ ADMIN ค่าเริ่มต้น OFF, lead days, idempotent ต่องวด, dry run ไม่เขียนอะไร, audit ระบุว่าเป็นระบบ) | — |
| `18-hardship` | งานปรับโครงสร้างหนี้ด้วยเหตุ hardship: ผู้ค้ำ/ผู้ชำระแทน (KYC นับใหม่ต่อการรับบทบาททุกครั้ง + เส้นทาง reopen/submit/await/verify), หลักทรัพย์ค้ำประกัน (จด/ปลด/อายุใบประเมิน/เพดาน coverage), "บันทึกแก้ไขสัญญา" ที่เข้าเครื่อง maker-checker ตัวเดิมด้วยเพดานต่ำสุด Checker+Head, apply ผ่าน ledger (relief = WAIVER ที่ต้องอนุมัติและโพสต์เอง, before/after snapshot, ห้ามใช้ใบที่สัญญาเลื่อนไป, relief ซ้ำยอดเดิมไม่ได้), การแจ้งเตือนถึงทุกฝ่าย และ audit trail | F-HSR-1 (ขยาย term แล้ว re-spread งวดที่ผ่านไปแล้ว), F-HSR-2 (วันใน coverage/audit ไม่ใช่ ISO day) |
| `19-evidence` | หลักฐานทางการเงิน: บัญชีธนาคารของลูกค้า (ลงทะเบียน/ปิด/เปิดกลับเป็นแถวเดิม/ย้าย primary, unique ต่อเจ้าของ, บัญชีแรกเป็น primary เอง, ปิด/ย้ายต้อง HEAD ขึ้นไป) · เอกสารยืนยันบัญชี + สลิปโอนเงิน/ใบรับเงินสด (ชนิดไฟล์จาก magic bytes png/jpeg/webp, ซ้ำ checksum ต่อเจ้าของ = 409, เพดานขนาด+โควตาตามนโยบาย `evidence.*` ที่แก้ได้ตอนรัน, ลบแล้วหายทั้ง metadata และ blob, เจ้าของหรือ ADMIN เท่านั้นที่ลบได้) · ช่องทางปล่อยกู้ BANK↔CASH ทั้งตอนสร้างและ PATCH (422 เมื่อขัดกันเอง, ไม่บังคับกับกู้เดิม) · **เลขบัญชีที่หลุดออกจากเซิร์ฟเวอร์ต้องเป็นแบบ mask ทุกช่องทาง** (REST, รายการกู้, payload, หัวข้อ/เนื้ออีเมล, audit reason) · audit BANK_ACCOUNT_*/EVIDENCE_*/LOAN_DISBURSEMENT_CHANNEL_SET · อีเมล 2 event ใหม่ (ผู้รับ exact set, template locale lo) | F-EVD-1 (เลขเดียวกันที่พิมพ์คั่นด้วยช่องว่างลงทะเบียนซ้ำได้ — `normalizeAccountNumber` แค่ยุบช่องว่าง ไม่ได้ลบ), F-EVD-2 (เลขสั้นไม่เกิน 4 หลักคืนทั้งเส้น ไม่ถูก mask) |

หมายเหตุ `15-invariants`: อ่านอย่างเดียว ไม่เขียนอะไรลง DB และนับเฉพาะเงินกู้ 21 ฉบับจาก seed
จึงไม่ได้รับผลกระทบจากแถวที่ suite อื่นสร้าง-ลบไว้

หมายเหตุ mapping ฟีเจอร์ที่ขอเพิ่มเข้ามาเป็นรอบ ๆ (ข้อ 1–7):
- ข้อ 1 (สีผลิตภัณฑ์ที่ลูกค้ากำลังกู้/เคยยืมในหน้า customers) — ฝั่ง API คือคอลัมน์ `borrowings` ของ
  `GET /api/customers` ตรวจใน `05-loans` (รวมยอดคงค้างต่อผลิตภัณฑ์); chip บนเบราว์เซอร์ไม่อยู่ในชุดนี้
  เพราะการตรวจ UI ต้องได้รับอนุญาตก่อน (ข้อ 5 หัวข้อ 6)
- ข้อ 2 (ยังไม่ถึงรอบห้ามชำระ + เก็บเข้า credit + auto-debit ก่อน N วัน) — `17-collection` ทั้งหมวด A–D
- ข้อ 3 (ค่าปรับปิดหนี้ทั้งหมดก่อนครบสัญญา) — `08-settlement` หมวด E2 + `14-concurrency` F-CONC-5
- ข้อ 4 (ปรับโครงสร้างหนี้เมื่อผู้กู้ชำระไม่ได้: ลดดอกเบี้ย/ขยายเวลา/เปลี่ยนผู้ชำระ + หลักทรัพย์ + KYC ผู้ค้ำ-ผู้ชำระ
  + อีเมลทุกฝ่าย + อนุมัติผู้มีอำนาจทุกขั้น) — `18-hardship` ทั้งหมวด A–I
- ข้อ 5 (แจ้งเตือนกลุ่มเงิน 8 event ใหม่: `PAYMENT_REQUEST_SUBMITTED` / `APPROVED` / `REJECTED`,
  `CREDIT_DEPOSITED`, `AUTO_DEBIT_POSTED`, `PENALTY_POSTED`, `WAIVER_POSTED`, `WRITE_OFF_POSTED`) —
  ตรวจใน `06-payments` (คำขอ + ค่าปรับ + ฝากเข้า credit), `07-posting` (ค่าปรับ manual/accrual, waiver
  ที่ถูก reject ต้องไม่มีเมล, write-off ทั้งบางส่วนและทั้งก้อน), `08-settlement` (waiver ส่วนขาดทุน,
  คำขอของข้อตกลงปิดบัญชี, credit ที่เกินยอด, ค่าปรับปิดก่อนครบสัญญา), `17-collection` (เมล auto-debit
  ถึงลูกค้าคนเดียว + ไม่มีเมลซ้ำจากงานของระบบ) และ `11-notifications` (รายการ template ตรงกับ enum
  ที่ derive จาก `server/src/entities/types.ts` — เพิ่ม event ใหม่แล้วไม่ต้องแก้ตัวเลขใน suite)
  กติกาที่วัด: ผู้รับ = ผู้กู้ + ผู้มีอำนาจ (Checker/Head/Admin ที่ inbox ไม่ว่าง), event ที่คือการตัดสิน
  เพิ่มผู้สร้างคำขอ (maker) อีกหนึ่งคน, event เงินเข้าบัญชีส่งเฉพาะลูกค้า, 1 ข้อความต่อ 1 mailbox
- ข้อ 6 (แจ้งเตือนทะเบียน 2 event: `CUSTOMER_REGISTERED`, `LOAN_PRODUCT_CREATED`) — ตรวจใน `04-kyc`
  (ผู้รับคือผู้มีอำนาจทุกคน + ตัวลูกค้าเองเฉพาะเมื่อลูกค้ามีอีเมล, ไม่ส่งเมลถึงคนที่กดสร้างเอง, payload
  ตรงตาม template) และ `16-interest` (ผู้รับคือผู้มีอำนาจทุกคนลบผู้สร้าง, subject มี code ของผลิตภัณฑ์,
  อัตรา+หน่วย/วิธีคำนวณ/ระยะเวลา/สกุลเงินตรงกับแถวที่บันทึก, ถ้าสร้างไม่สำเร็จต้องไม่มีเมลเกิดใหม่)
  ทั้งสอง event ไม่ผูกกับรายการกู้ แถวจึง `loanId IS NULL` — แบบแผน purge ของ suite อื่นที่กรองด้วย
  loanId เก็บไม่ถึง `04`/`16` จึงจำ id ของแถวที่ตัวเองสร้างไว้ลบตอนจบ ส่วน `08`/`18` กวาดเพิ่มจาก
  เลขลูกค้ากับ code ผลิตภัณฑ์ที่ตัวเองสร้าง ซึ่งอ่านค่าได้ตอนเปิด payload ใน JS เท่านั้น
- ข้อ 7 (บันทึกรับบัญชีธนาคารของลูกค้าพร้อมเอกสารยืนยันบัญชี ตอนลงทะเบียน/อัปเดตข้อมูลการเงิน + อัปโหลดสลิปโอนเงิน
  หรือใบรับเงินสดหลังอนุมัติกู้ พร้อมตัวเลือกว่ารับผ่านบัญชีหรือเงินสด) — `19-evidence` ทั้งหมวด A–J
  (A นโยบาย `evidence.*` ผ่าน `GET/PUT /api/config/evidence` + validation/422 + audit checksum, B–C วงจรชีวิตรายการ,
  D–E เอกสารยืนยันบัญชี, F ช่องทางปล่อยกู้, G สลิป+การลบ, H อีเมล 2 event ใหม่, I ทดลองโควตา/ขนาด/ประเภทไฟล์, J คืนของ)
  จุดที่ suite อื่นต้องแก้มากพร้อมกัน: `01-auth` เพิ่ม 4 endpoint ใหม่ใน RBAC matrix
  (`/api/customers/:id/bank-accounts`, `/api/customers/:id/evidence`, `/api/loans/:id/evidence`, `/api/config/evidence`) ·
  `11-notifications` เพิ่ม payload contract ของ `CUSTOMER_BANK_ACCOUNT_REGISTERED` และ
  `LOAN_DISBURSEMENT_EVIDENCE_UPLOADED` (เคส "template == enum" อ่านรายการ code จาก source จึงไม่ต้องแก้ตัวเลข) ·
  `18-hardship` แก้ชื่อตาราง `kyc_document_contents` (เดิมเขียนขาด s ทำให้ purge ระเบิด) · `run-e2e.mjs` ลงทะเบียน suite 19
  และเพิ่ม namespace `evidence` ในรายการที่ล็อกตอนเริ่มรัน
  migration ของรอบนี้คือ `PaymentEvidence` (ตาราง `customer_bank_accounts`, `evidence_documents`,
  `evidence_document_contents`, 3 คอลัมน์ช่องทางบน `loans`, widen enum 2 event ใหม่) — ข้ามขั้น `db:migrate` + boot
  แล้วหมวด H/B จะแดงตั้งแต่ query แรกทั้งที่โค้ดถูก
- ข้อ 8 (ล็อกบัญชีเมื่อใส่รหัสผิดครบ 3 ครั้ง + ล็อกเมื่อไม่เข้ามาในระบบใน 90 วัน + บังคับเปลี่ยนรหัสทุกเดือนและห้ามซ้ำของเดิม) —
  ตัวนโยบาย `security.*` ผ่าน `GET/PUT /api/config/security` ถูกครอบคลุมใน RBAC matrix ของ `01-auth` และ `13-config` แล้ว
  ส่วนเคส enforcement จะอยู่ใน `20-account-security` (Stage H)
  migration ของรอบนี้คือ `AccountSecurity` (ตาราง `user_password_history` + 3 คอลัมน์ล็อกบน `users`:
  `failedLoginAttempts`, `lockedAt`, `lockReason` — ไม่มี widen enum เพราะเป็นคอลัมน์ใหม่ล้วน) — ข้ามขั้น `db:migrate`
  แล้วเส้น login ของ Stage C จะพังตั้งแต่ query แรกเพราะคอลัมน์ยังไม่มีอยู่จริง
  หมายเหตุ: namespace `security` **ไม่ถูกล็อก** ตอนเริ่มรันใน `run-e2e.mjs` เพราะค่า default 3/90/30 ทำให้ suite ที่ล็อกอินด้วย
  บัญชี seed เจอ lock + rotation gate ทันที — suite 20 เป็นผู้ล็อกเองเฉพาะในเคสของตัวเอง
  Stage C เปิดใช้ล็อกตอนใส่รหัสผิดจริงแล้ว: รหัสผิดตอบ 401 `Invalid credentials` เท่ากันทุกกรณี (ไม่บอกว่าเหลือกี่ครั้ง),
  รหัสถูกแต่บัญชีถูกล็อกตอบ 403 `ACCOUNT_LOCKED`, และ `POST /api/users/:id/unlock` (ADMIN เท่านั้น) ปลดล็อกแล้วส่งลิงก์
  ตั้งรหัสใหม่ทางอีเมลแบบ best effort — `01-auth` เพิ่มแถว unlock ใน RBAC write matrix แล้ว
  ตัวนับ `failedLoginAttempts` **คงอยู่ข้ามรอบรัน** (รีเซ็ตเมื่อล็อกอินสำเร็จเท่านั้น) จึงตรวจแล้วว่าไม่มี suite ใด
  ใส่รหัสผิดซ้ำบนบัญชี seed เดิมติดกัน 3 ครั้ง: ทุกครั้งที่ผิดจะมีล็อกอินสำเร็จของบัญชีเดียวกันคั่นก่อนครั้งถัดไป
  Stage D เปิดใช้อายุรหัสผ่าน + ห้ามใช้รหัสเดิมแล้ว: login ที่รหัสครบกำหนดตอบ 403 `PASSWORD_EXPIRED` โดยไม่ออก token,
  `POST /api/auth/change-expired-password` (สาธารณะ, ผ่านล็อกเดียวกันกับ login) เป็นทางกลับเข้าระบบ, และการเขียน
  `users.passwordHash` ทุกเส้นทาง (สร้างผู้ใช้, ADMIN ตั้ง, เปลี่ยนเอง, gate) ผ่าน `user-password.service` จึงมีแถวใน
  `user_password_history` เสมอ ผลข้างเคียงที่ทุก suite ต้องรู้: **การตั้งรหัสกลับไปเป็นรหัสที่บัญชีเคยใช้ถูกปฏิเสธ 422
  `PASSWORD_REUSED`** — `02-forgot-password` และ `03-users` จึงล้างประวัติของบัญชี fixture ด้วย
  `DELETE FROM user_password_history WHERE userId=?` เฉพาะก่อนขั้นตอน "คืนรหัสมาตรฐาน" เท่านั้น (ตัวกฎยังถูกตรวจ
  ตอนประวัติครบอยู่) และ `03-users` ไม่ตั้งรหัสซ้ำถ้า login ด้วยรหัสมาตรฐานยังผ่าน
  `seed-test-data.mjs` จึงหยุดใช้ `REFERENCE_NOW` กับรหัสผ่าน: ทุกบัญชี seed ถูกประทับ `passwordChangedAt`
  เป็น "เวลานี้" พร้อมประวัติ 1 แถว มิฉะนั้น rotation gate จะปฏิเสธ login ตั้งแต่เคสแรกด้วยรหัสอายุ 500 วัน
  (ข้อมูลอื่นของ dataset ยัง deterministic ตาม `REFERENCE_NOW` เกณฑ์เดิม — ที่เปลี่ยนมีเฉพาะเวลารหัสผ่าน
  และ manifest บันทึกข้อนี้ไว้ใน `passwordRotationNote`)
  `03-users` เป็น suite แรกที่ล็อก namespace `security` เอง (ผ่าน `pinPolicies(asAdmin, ['security'])` แล้ว `restore()`
  ใน `finally`) เพราะอายุรหัสที่ต้องถอยหลังใน `users` ต้องวัดจากค่า default ที่เซิร์ฟเวอร์รายงาน ไม่ใช่เลขที่คัดมาในไฟล์
  เคสบังคับเปลี่ยนรหัสจริงทั้งหมดยังอยู่ใน `20-account-security` (Stage H)
- **กับดักเขตเวลาของ `seed` และ `conn` (เจอจริงรอบ Stage D เมื่อ 2026-10-18)**: `datasource.ts` ตั้ง `timezone:'Z'` แต่
  connection ที่ `openDb()`/`seed-test-data.mjs` สร้างไม่ได้ตั้งตาม — ดังนั้น (1) ส่ง JS Date เข้า INSERT จะถูกเขียนเป็น
  นาฬิกาของเครื่อง (+07) แล้วเซิร์ฟเวอร์อ่านกลับเป็น UTC กลายเป็น “อนาคต 7 ชั่วโมง” ซึ่งเพิกถอนทุก JWT ที่ mint หลังนั้น
  (`authMiddleware` เทียบ `iat` กับ `passwordChangedAt`) ทำให้ทั้งรันแดงตั้งแต่เคสแรกที่ 401 "Session is no longer valid"
  และ (2) อ่านคอลัมน์ DATETIME ผ่าน `conn` จะได้ Date ที่แปะเขตเวลาของเครื่อง (+07) จึงช้ากว่าความจริง 7 ชั่วโมง
  กติกา: เขียน/อ่านค่าเวลาแบบ “ตอนนี้” ให้ใช้ข้อความ UTC (`utcSql(ms)` ของ harness) หรืออ่านผ่าน API ที่เซิร์ฟเวอร์ serialize ให้
  ส่วน `UPDATE ... DATE_SUB(NOW(), INTERVAL ? DAY)` ปลอดภัยเพราะ `NOW()` เป็น wall clock UTC ของคอนเทนเนอร์อยู่แล้ว
- **จะอ่าน payload ของ `notification_outbox` ต้อง unseal ใน JS**: `enqueueNotification` ซีล payload
  ของทุก event ไม่ใช่เฉพาะ OTP/reset link ดังนั้น `JSON_EXTRACT(payload,'$.x')` บนค่าที่ขึ้นต้นด้วย
  `sealed:v1:` จึงไม่ใช่ JSON ที่ parse ได้ และคืน NULL เงียบ ๆ — เคสที่เทียบช่องแบบนี้จะกลายเป็นเทียบ
  null กับ null แล้วผ่านทั้งที่ไม่มีอะไรถูกตรวจ ชุดเทสต์จึงใช้ `payloadOf(row)` จาก `lib/harness.mjs`
  แทน (บันทึกเป็น F-NTF-6)
- **ลบแถว `notification_outbox` ตอนปิด suite ต้องรอให้ระบบส่งจบก่อน (F-NTF-7)**:
  `dispatchNotifications()` อ่านแถวทั้งรุ่นมาถือไว้ในหน่วยความจำ (`claimableRows`) แล้วค่อยเขียนสถานะ
  คืนทีละแถวด้วย `em.save()` ซึ่งฝั่ง TypeORM เป็น upsert — ถ้าแถวนั้นถูกลบไปกลางคัน `save()` จะ
  INSERT แถวกลับมาจากข้อมูลที่ถือไว้ กลายเป็นแถวกำพร้าของบัญชีที่ไม่มีในตาราง `users` แล้ว
  `13-config` เคยแดงที่ E2E-479 เพราะ `DELETE ... WHERE userId IN (ids)` ข้ามกับรอบส่งพอดี
  (หลักฐาน: สองแถวที่ค้างมี `createdAt`/`updatedAt` เท่ากันละเอียดระดับ millisecond ขณะที่แถวอื่นในรอบเดียวกัน
  มีไมโครวินาทีจาก default ของคอลัมน์ และ `sentAt` อยู่หลังตอนลบ) Suite จึงไล่รอให้ทุกแถวของบัญชีตัวเอง
  ออกจาก `PENDING`/`FAILED` ก่อนลบ — ฝั่งระบบยังไม่แก้ (บันทึกเป็น finding ตามข้อ 2)
- **ลำดับที่ต้องรันก่อนครั้งแรกหลังเพิ่ม event**: `npm run db:migrate -w server` (build `dist/` ให้ก่อน)
  แล้ว start backend หนึ่งครั้งให้ `seedEmailTemplates` เขียน template ใหม่ (idempotent) — ถ้าข้ามขั้นนี้
  `notification_outbox` จะไม่มีแถวของ event ใหม่ (enum ยังไม่กว้าง + ไม่มี template) ทำให้ `11-notifications`
  และทุกเคสในข้อ 5, ข้อ 6 กับข้อ 7 แดงทั้งที่โค้ดถูก

หมายเหตุ นโยบายระบบ (`system_config`): ตอนเริ่มรัน `run-e2e.mjs` จะล็อก namespace `kyc,password,payment,avatar,collateral,evidence`
ให้เท่าค่า default ของผลิตภัณฑ์ (อ่านจาก `GET /api/config/*` ไม่ใช่ตัวเลขที่คัดลอกมาในไฟล์เทสต์) แล้วคืนค่าที่พบจริงเมื่อจบรัน
suite ที่พึ่งพา gate ของตัวเอง (04, 06, 07, 08, 14, 16, 17, 18, 19) ล็อกซ้ำในระดับ suite อีกชั้น
เหตุผล: `reset-db` ตั้งใจเก็บ `system_config` ไว้ ถ้าค่าในตารางเลื่อนจากที่ suite เขียนไว้ (เช่น `autoDebitEnabled=true`)
ตัว job จะย้ายเงินบนบัญชี seed ขณะที่ยังนับแถวอยู่ — ค่า threshold ไม่ได้ล็อกเพราะเซิร์ฟเวอร์ไม่ส่ง `defaults` ของมันออกมา

## 6. กติกาขณะใช้ชุดทดสอบนี้

1. **ห้ามแก้กฎธุรกิจหรือสูตรคำนวณที่ล็อกไว้เพื่อให้เทสต์ผ่าน** — ถ้าตัวเลขไม่ตรง ให้รายงานพร้อมหลักฐาน
2. เจอบั๊กให้รายงานก่อน — ห้ามแก้โค้ดระบบเองโดยไม่ถาม ยกเว้นได้รับคำสั่ง
3. ห้ามใช้ข้อมูล/บัญชีจริง และห้ามเรียก SMTP/SMS/บริการภายนอกจริง
4. suite ที่เขียนข้อมูลต้องล้างของตัวเองออก (สร้าง → ตรวจ → purge + คืนค่า config) เพื่อให้รันซ้ำแล้วผลเหมือนเดิม
5. UI บนเบราว์เซอร์จะไม่ตรวจถ้ายังไม่ได้รับอนุญาต (ใช้ `npm run test -w server`, `tsc --noEmit`, `vite build`, `oxlint` แทน)

## 7. ล้างของทดสอบออกก่อนขึ้น Production (Stage 5)

- `scripts/test/cleanup-before-prod.mjs` — **เตรียมไว้เท่านั้น ห้ามรันถ้าไม่ได้สั่ง**
  ต้องลบแถวทดสอบออกจาก DB (ส่วนไฟล์ log ทำแล้วด้วยสคริปต์ถัดไป)
- `npm run logs:scrub` — สแกนไฟล์ log ใน `server/src/logs` หลังค่าลับ (OTP ใน subject, token ใน URL)
  **รายงานจำนวนอย่างเดียว ไม่แก้ไฟล์** · `npm run logs:scrub:apply` จึงเขียนทับบรรทัดนั้นเป็น `<redacted>`
  (รันซ้ำได้: ครั้งถัดไปจะรายงาน 0 occurrence)
- โค้ดปัจจุบัน redaction ที่ต้นทางอยู่แล้ว (`SECRET_EVENT_TYPES` ใน `notification-dispatcher.service.ts`)
  และ logger มีชั้นป้องกันสุดท้าย (`redactSecretsFrom` ใน `utils/logger.ts`) จึงไม่มีบรรทัดแบบนี้เกิดใหม่
- วิธีคืนข้อมูลจาก backup:

```bash
docker exec -i loan-ms-mysql mysql -uroot -p<DB_PASSWORD> < backups/loan_management_<stamp>.sql
```

- ถ้า container ใช้ชื่ออื่นนอกเหนือจาก `loan-ms-mysql` ให้ตั้ง `LOAN_DB_CONTAINER`
  ถ้าอยากเก็บ backup ไว้โฟลเดอร์อื่นให้ตั้ง `LOAN_BACKUP_DIR`

## 8. โครงสร้างตาราง = migration (ไม่ใช่ synchronize)

`server/src/migrations/` เก็บลำดับการเปลี่ยนโครงสร้างตารางเป็นไฟล์ SQL ที่ review ย้อนหลังได้
ไฟล์แรกคือ `BaselineSchema` ซึ่งแปลงโครงสร้างที่เดิมเกิดจาก `synchronize` มาเป็น migration
(ยืนยันด้วยความตรงกับ `npm run test:migrations`) ทุก environment เริ่มจากไฟล์นี้
`DB_SYNCHRONIZE` ยังอยู่แต่ต้องตั้ง `true` เอง — `NODE_ENV` ไม่ทำให้มันเปิดอีกต่อไป
และคำสั่ง migration ทุกตัวบังคับ `synchronize: false` เพื่อให้อ่านของจริงใน DB ก่อนเขียนไฟล์ใหม่

| คำสั่ง (รันจาก repo root) | ทำอะไร |
|---|---|
| `npm run db:migrate -w server` | Apply migration ที่ยังค้างใน DB ที่ `server/.env` ชี้อยู่ |
| `npm run db:migrate:status -w server` | ดูว่าอันไหน apply แล้ว `[X]` / ยังค้าง `[ ]` |
| `npm run db:migration:generate -w server -- src/migrations/AddPenaltyCap` | build ให้ก่อน แล้วให้ TypeORM diff entity ↔ DB และเขียนไฟล์ migration ใหม่ใน `src/migrations/` (ต่อท้ายด้วยชื่อไฟล์ ไม่ต้องมี `.ts`) |
| `npm run db:schema:diff -w server` | build แล้วพิมพ์ SQL ที่ค้างอยู่ (ว่าง = entity กับ DB ตรงกัน) |
| `npm run db:migrate:revert -w server` | ยกเลิก migration ล่าสุด — ของ `BaselineSchema` ถูกบล็อกไว้ เพราะมัน DROP ทั้ง 23 ตารางพร้อมข้อมูล ต้องตั้ง `DB_BASELINE_REVERT=I-ACCEPT-DATA-LOSS` ถึงจะยอม (ใช้กับ DB ชั่วคราวเท่านั้น) |

ลำดับที่ต้องจำ: **migration ที่รันคือไฟล์ใน `dist/` ไม่ใช่ `src/`** คำสั่ง `db:migrate` / `:revert` / `:status`
จึงต้อง build ก่อนทุกครั้งที่แก้ entity หรือ generate ไฟล์ใหม่ (`db:migration:generate` กับ `db:schema:diff`
build ให้แล้ว) ส่วน image ที่ deploy จริง `dist/` ถูก compile ไว้ในขั้น build ของ Dockerfile
จึงรัน `db:migrate` ได้ทันที

DB เป้าหมายของทุกคำสั่งมาจาก `server/.env` (`DB_NAME`) ถ้าจะรันกับ DB อื่นต้อง override ผ่าน env ของ shell
บน Windows npm เรียก `cmd.exe` จึงตั้งตัวแปรแยกบรรทัดก่อนรัน:

```powershell
$env:DB_NAME = "loan_migrate_check"; npm run db:migrate -w server
```

```bash
DB_NAME=loan_migrate_check npm run db:migrate -w server
```

สำหรับชุดทดสอบ: `reset-db.mjs`/TRUNCATE และ `seed-test-data.mjs` ทำงานกับ **แถว** เท่านั้น ไม่แตะ DDL
และ `schema_migrations` อยู่ในกลุ่มที่ไม่ถูกล้างถาวร (แม้สั่ง `--wipe-config`) ถ้าตารางนั้นว่างอยู่จาก
reset รุ่นเก่า ฐานข้อมูลจะอ้างว่ายังไม่เคยรัน migration ทั้งที่ตารางยังครบ — ให้ INSERT แถวบันทึกกลับ
ตามชื่อในไฟล์ dump ล่าสุดของ `backups/` ก่อน แล้วค่อยรัน `db:migrate` ใหม่
DB ว่างเปล่าต้อง `npm run db:migrate -w server` ก่อน ถึงจะ start backend ได้
(`server/.env` ตั้ง `SEED_ON_BOOT=false` ตามหัวข้อ 1)
