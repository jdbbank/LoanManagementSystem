# TEST PLAN — Pre-Production Full System Test (ข้อมูลจำลองชุดใหม่ + ล้างฐานข้อมูลทดสอบ)

สถานะ: **รอการอนุมัติ** — ยังไม่ได้ล้างข้อมูล ยังไม่ได้เขียนโค้ดทดสอบ
วันที่สำรวจ: 2026-10-12 | ผู้สำรวจ: Qoder agent | repo: `D:\Project\indee-code\LoanManagementSystem`

---

## ตอนที่ 0 — Stage 0: มาตรการความปลอดภัย (ทำแล้ว / ออกแบบไว้)

### 0.1 ค่า DB ที่ระบบใช้อยู่จริง (อ่านจากโค้ด + ไฟล์ env)

| รายการ | ค่าจริง | ที่มา |
|---|---|---|
| `DB_HOST` | `127.0.0.1` | `server/.env` |
| `DB_PORT` | `3307` (host) → `3306` ใน container | `server/.env`, `docker-compose.yml:11` |
| `DB_USER` | `root` | `server/.env` |
| `DB_NAME` | **`loan_management`** | `server/.env` |
| `NODE_ENV` | `development` | `server/.env` |
| `DB_SYNCHRONIZE` | ไม่ได้ตั้งใน `server/.env` แต่ `synchronize: !env.isProduction` → **true ในโหมด dev** · ข้อนี้เก่า: ปัจจุบันโครงสร้างตารางมาจาก migration แล้ว (`npm run db:migrate`) ดู scripts/test/README.md หัวข้อ 8 | `server/src/datasource.ts:67` |
| `SEED_ON_BOOT` | **`true`** ⚠️ | `server/.env` |
| Container MySQL | `loan-ms-mysql` (mysql:8.4, healthy) | `docker ps` |
| Container อื่น | `kafka` (redpanda) up, **ไม่มี** zookeeper/mailer/backend/frontend ที่รันอยู่ | `docker ps` |

โหมด production (docker-compose) ใช้ `DB_HOST=mysql DB_PORT=3306 DB_SYNCHRONIZE=false NODE_ENV=production` — คนละชุดค่ากับที่รันอยู่ที่ยืนยันว่าตอนนี้คือ **เครื่อง-local dev เท่านั้น**

> ⚠️ **จุดที่ต้องรู้ก่อนสั่งล้าง**: `SEED_ON_BOOT=true` ทำให้ `runSeed()` เติมข้อมูล demo (users: admin/head/checker/maker/viewer, 3 ผลิตภัณฑ์, ลูกค้า CUST-000001.., สินเชื่อ LN-0000xx) กลับมา **ทุกครั้งที่รีสตาร์ตเซิร์ฟเวอร์** ถ้าล้างแล้วลืมปิด จะกลายเป็นข้อมูลสองชุดปนกันและ `expected.json` จะเทียบไม่ตรง แผนนี้จึงบังคับรันเซิร์ฟเวอร์สำหรับเทสต์ด้วย `SEED_ON_BOOT=false`

### 0.2 ข้อมูลเดิมที่จะถูกลบ (นับจริง ณ ตอนนี้)

| ตาราง | แถว | ตาราง | แถว |
|---|---|---|---|
| users | 5 | payment_requests | 8 |
| system_config | 12 | payment_allocations | 24 |
| customers | 10 | approval_workflows | 5 |
| loan_products | 3 | approval_steps | 6 |
| loans | 13 | audit_logs | **260** |
| financial_transactions | 24 | reconciliation_records | 3 |
| financial_transaction_lines | 41 | settlement_agreements | 1 |
| kyc_documents | 19 | kyc_document_contents | 19 |
| email_templates | 9 | notification_outbox | 2 |
| password_reset_tokens | 2 | user_avatars / user_avatar_contents | 0 / 0 |
| customer_credits | 1 | credit_ledger | 1 |

รวม 23 ตาราง, 485 แถว

### 0.3 สำรองข้อมูล — **ทำแล้ว**

```
ไฟล์: backups/loan_management_20261012_234508.sql
ขนาด: 1,278,013 bytes | CREATE TABLE: 23 | INSERT block: 22 ตาราง
คำสั่ง: docker exec loan-ms-mysql mysqldump --single-transaction --routines --set-gtid-purged=OFF -uroot … loan_management
กู้คืน: docker exec -i loan-ms-mysql mysql -uroot -p<pw> loan_management < backups/loan_management_20261012_234508.sql
```
ไฟล์นี้มี `passwordHash` ของผู้ใช้เดิมอยู่ — เป็นไฟล์ในเครื่อง ไม่ push ที่ไหน และก่อนล้างจริงฉันจะ dump ซ้ำอีกรอบด้วย timestamp ใหม่ (เก็บไฟล์แรกไว้เป็น snapshot ก่อนเริ่มงาน)

### 0.4 Guard ที่จะต้องมีใน `scripts/test/reset-db.mjs` (เขียนบังคับในสคริปต์ ไม่ใช่แค่ในเอกสาร)

1. **Allowlist ชื่อ DB**: ตัวแปร env `TEST_DB_NAME` ต้องตรงกับค่าที่ผู้ใช้ยืนยันในสคริปต์ (`EXPECTED_DB` hard-code ไว้ที่ `loan_management`) ไม่ตรง → `process.exit(1)` พร้อมชื่อ DB ที่อ่านได้จริง
2. **Production lockdown**: ถ้า `NODE_ENV=production` → ปฏิเสธ; ถ้า `DB_HOST` ไม่อยู่ใน `{127.0.0.1, localhost, host.docker.internal, 172.16.0.0/12, loan-ms-mysql}` → ปฏิเสธ; ถ้า `mysqldump` backup ยังไม่มีใน `backups/` สำหรับ run นี้ → ปฏิเสธ
3. **ยืนยันแบบ interactive ปิดไว้** และใช้ `--confirm-loan_management` flag เป็นกุญแจอีกชั้น (รันอัตโนมัติได้ แต่ต้องใส่ flag ชื่อ DB ผูกกับ guard ข้อ 1)
4. วิธีล้าง: ไม่มี migration ไฟล์ในโปรเจกต์ (โครงสร้างตารางสร้างด้วย `synchronize`) → **จะไม่แตะ DDL เลย** ใช้ `SET FOREIGN_KEY_CHECKS=0` → `TRUNCATE TABLE` ทีละตารางตามรายชื่อที่อ่านจาก `information_schema` (ไม่ hard-code) → `SET FOREIGN_KEY_CHECKS=1` → ตรวจนับว่าทุกตารางเหลือ 0 แถว → พิมพ์รายงาน
5. ตารางที่ **ไม่แตะ** เลย (ค่าตั้งระบบที่ต้องอยู่ต่อ): `system_config`, `email_templates` — ค่าดีฟอลต์ policy และเทมเพลตมากจาก bootstrap ของระบบเอง (ถ้าสั่ง `--wipe-config` ค่อยล้างและให้เซิร์ฟเวอร์ seed กลับ) และ `schema_migrations` — บันทึกว่า migration ไหนรันแล้ว ซึ่ง **ไม่ถูกล้างแม้สั่ง `--wipe-config`** เพราะถ้าตารางนี้ว่างทั้งที่ยังมีตารางอยู่ `db:migrate` จะเข้าใจว่ายังไม่เคยสร้างและไปรัน `CREATE TABLE` ซ้ำ
6. รันซ้ำได้เสมอ (idempotent) และต้องทำต่อเมื่อเซิร์ฟเวอร์หยุดเขียนอยู่แล้ว (ตรวจ `GET /health` แล้วเตือน)

### 0.5 ลำดับขั้นตอนที่ผมจะทำหลังได้รับอนุมัติ

```
backup(ใหม่) → หยุดเซิร์ฟเวอร์ dev → reset-db.mjs → ตั้ง SEED_ON_BOOT=false
→ boot เซิร์ฟเวอร์ (synchronize สร้างเฉพาะ structure ถ้ามีตารางหาย, seed config/templates)
→ seed-test-data.mjs → สร้าง expected.json (oracle อิสระ) → รัน suite → TEST-REPORT.md
```

---

## ตอนที่ 1 — Stage 1: ผลสำรวจระบบ (ของจริงในโค้ด ไม่ใช่ความจำ)

### 1.1 โครงสร้างการป้องกัน (middleware)

- `app.use('/api/auth', authRouter)` ลงทะเบียน **ก่อน** `app.use('/api', authMiddleware)` → `/api/auth/*` เป็น public ทั้งหมด ยกเว้น `GET /me` ที่ใส่ guard เอง (`server/src/app.ts:33-34`)
- ทุก router อื่นอยู่หลัง `authMiddleware` → ต้องมี JWT ที่ถูกต้องเสมอ; `requireRole(...)` คืน 403 `Requires role: …`; `requireAuth` เป็นด่านซ้ำใน router
- `canDecideLevel`: CHECKER→{CHECKER,ADMIN}, HEAD→{HEAD_APPROVER,ADMIN}, ADMIN→{ADMIN} (`middleware/auth.ts:47-51`)

**Public endpoints ทั้งหมด (6 ตัว)**: `GET /health`, `POST /api/auth/login`, `POST /api/auth/forgot-password`, `POST /api/auth/verify-otp`, `POST /api/auth/reset-password`, `GET /api/auth/password-policy`

### 1.2 Endpoint inventory (57 routes / 16 routers)

| Router (mount) | Routes (method path — guard) |
|---|---|
| `auth` `/api/auth` | POST `/login` public · GET `/me` token · POST `/forgot-password` public · POST `/verify-otp` public · POST `/reset-password` public · GET `/password-policy` public |
| `users` `/api/users` | GET `/` ADMIN · POST `/` ADMIN · PATCH `/:id` ADMIN · GET/PUT/DELETE `/:id/avatar` self-or-ADMIN(runtime) · DELETE `/:id` ADMIN · POST `/:id/restore` ADMIN · POST `/:id/send-reset-link` ADMIN · POST `/send-reset-links` ADMIN |
| `config` `/api/config` | GET/PUT `/thresholds` (auth / ADMIN) · GET/PUT `/kyc` · GET/PUT `/password` · GET/PUT `/avatar` |
| `audit` `/api/audit` | GET `/` auth(ทุก role) |
| `customers` `/api/customers` | GET `/` auth · POST `/` OPERATOR · GET `/:id` auth |
| `kyc` `/api/customers/:customerId/kyc` | GET `/documents` auth · GET `/documents/:documentId/content` auth · POST `/documents` OPERATOR · DELETE `/documents/:documentId` OPERATOR+owner · POST `/submit` OPERATOR · POST `/verify` REVIEW · POST `/reject` REVIEW · POST `/reopen` ADMIN |
| `loan-products` `/api/loan-products` | GET `/` auth · POST `/` ADMIN · PATCH `/:id` ADMIN |
| `loans` `/api/loans` | GET `/` auth · POST `/` OPERATOR(=อนุมัติ+เบิกในcallเดียว) · GET `/:id` auth · GET `/:id/allocation-preview` · GET `/:id/schedule` |
| `payment-requests` `/api/payment-requests` | GET `/` · GET `/pending-count` · POST `/` OPERATOR · GET `/:id` · POST `/:id/approve` REVIEW · POST `/:id/reject` REVIEW · POST `/:id/resubmit` OPERATOR |
| `transactions` `/api/transactions` | GET `/` · GET `/:id` · POST `/:id/post` OPERATOR · POST `/reversals` · `/penalties` · `/penalties/accrue` · `/waivers` · `/write-offs` · `/write-off-reversals` · `/adjustments` (OPERATOR ทั้งหมด) |
| `approvals` `/api/approvals` | GET `/pending` REVIEW · POST `/steps/:stepId/decision` REVIEW · GET `/workflows/:id` auth |
| `settlements` `/api/settlements` | GET `/` · POST `/` OPERATOR · GET `/:id` · POST `/:id/settlement-payment` OPERATOR · POST `/:id/waive-shortfall` OPERATOR |
| `credits` `/api/credits` | GET `/` · GET `/ledger?customerId` (auth, read-only) |
| `reconciliation` `/api/reconciliation` | POST `/run` OPERATOR · GET `/records` · GET `/records/:id` |
| `reports` `/api/reports` | GET `/monthly` **ADMIN + HEAD_APPROVER เท่านั้น** |
| `dashboard` `/api/dashboard` | GET `/stats` · GET `/recent-activity` (auth ทุก role) |
| `notifications` `/api/notifications` | GET `/templates` ADMIN · PATCH `/templates/:id` ADMIN · GET `/` ADMIN · POST `/:id/requeue` ADMIN · GET `/summary` ทุก role |

OPERATOR_ROLES = {MAKER, CHECKER, HEAD_APPROVER, ADMIN} · REVIEW = {CHECKER, HEAD_APPROVER, ADMIN}

### 1.3 Enum literals ที่เทสต์ต้องครอบ

`UserRole` ADMIN|HEAD_APPROVER|CHECKER|MAKER|VIEWER · `LoanStatus` ACTIVE|CLOSED|WRITTEN_OFF · `TransactionType` DISBURSEMENT|PAYMENT|SETTLEMENT_PAYMENT|PAYMENT_REVERSAL|PENALTY|WAIVER|WRITE_OFF|WRITE_OFF_REVERSAL|ADJUSTMENT · `TransactionStatus` DRAFT|PENDING_APPROVAL|APPROVED|POSTED|REJECTED · `PaymentRequestStatus` PENDING|APPROVED|REJECTED · `ApprovalLevel` CHECKER|HEAD|ADMIN · `WorkflowStatus`/`StepStatus` PENDING|APPROVED|REJECTED · `SettlementStatus` PENDING_APPROVAL|APPROVED|REJECTED · `CreditLedgerType` ACCRUED|USED · `ReconciliationStatus` MATCHED|MISMATCHED · `KycStatus` NOT_VERIFIED|PENDING|VERIFIED|REJECTED · `KycDocumentType` NATIONAL_ID|ID_CARD|PASSPORT|FAMILY_BOOK|SELFIE_WITH_ID|SIGNATURE · `KycDocumentVariant` MAIN|FRONT|BACK · `PeriodUnit` DAY|WEEK|MONTH|YEAR · `PenaltyMode` NONE|PERCENT_OF_OVERDUE|FIXED_PER_PERIOD · `SchedulePeriodStatus` PENDING|DUE|OVERDUE|PARTIAL|PAID · `NotificationEventType` (9) · `NotificationStatus` PENDING|SENT|FAILED|DEAD · `ResetTokenKind` OTP|LINK · `ComponentType` PENALTY|PAST_INTEREST|PAST_PRINCIPAL

### 1.4 กฎธุรกิจที่ล็อกไว้ (= สูตรของ oracle)

| หัวข้อ | กฎจริงในโค้ด | อ้างอิง |
|---|---|---|
| เงิน/ปัด | `DECIMAL(18,2)`, `round2(n)=Math.round((n+EPS)*100)/100` **ปัดทุกขั้น ไม่ปัดครั้งเดียว**, เทียบศูนย์ใช้ `EPS=0.005` | `utils/money.ts:7-9` |
| นับวัน | 1 เดือน = 30 วัน, 1 ปี = 365 วัน, 1 สัปดาห์ = 7 วัน, 12 เดือน/ปี | `utils/period.ts:9-21` |
| ดอกเบี้ย | flat เบิกครั้งเดียว ณ วันปล่อย: `ratePerMonth = rate%/MONTHS_PER_UNIT[rateUnit]`, `total = round2(P × rate/100 × months)`, `months = termValue × MONTHS_PER_UNIT[termUnit]` | `period.ts:34-50`, `loans.router.ts:186-213` |
| งวด | `periodCount = max(1, round(termInMonths))`, due date ใช้ปฏิทินจริงแบบ clamp (31 ม.ค.+1ด. = 28 ก.พ.) | `period.ts:27-28,74-82` |
| ค่าปรับ | `NONE`→0 · `FIXED_PER_PERIOD` = `round2(amount × ceil(overdueDays/DAYS_PER_UNIT[period]))` · `PERCENT_OF_OVERDUE` = `round2(base × rate/100 × overdueDays/DAYS_PER_UNIT[period])` · `overdueDays = max(0, floor((asOf − (due+grace))/86400000))` · cap = `round2(principal × maxPercentOfPrincipal/100)` ตัดจากงวดใหม่สุดย้อนกลับ | `loan-schedule.service.ts:150-175,243-262` |
| accrual | ไม่มี-auto; `POST /transactions/penalties/accrue` สร้าง PENDING_APPROVAL จำนวน `round2(max(0, accrued − charged − relieved))`; ≤0.005 → ปฏิเสธ; CLOSED → ปฏิเสธ | `transactions.router.ts:343-382` |
| ลำดับการจัดสรร | `PENALTY → PAST_INTEREST → PAST_PRINCIPAL` เท่านั้น, `applied>0.005` ถึงจะบันทึก, เหลือ = excess | `allocation.service.ts:6-41` |
| จ่ายเกิน → credit | `excess = round2(total − allocated)` >0.005 → `adjustCredit(+excess, ACCRUED)` เขียน `customer_credits` + `credit_ledger` + audit `CREDIT_ACCRUED`/`CREDIT_USED` (ห้ามเอาไปหักเงินต้นก่อน — ล็อก §6) | `posting-engine.service.ts:196-212,120-157` |
| ใช้ credit | ตรวจทั้งตอนสร้างคำขอและตอนโพสต์ (`available+0.005 < creditApplied` → 422 `Insufficient customer credit…`) แล้ว `adjustCredit(−used, USED)` | `payment-requests.router.ts:87-95` |
| ความจริงทางการเงิน | **เฉพาะ POSTED**; schedule/reconciliation/reversal-eligibility กรอง `status=POSTED` ทั้งหมด | `loan-schedule.service.ts:124`, `reconciliation.router.ts:31-33` |
| สถานะ txn ที่เกิดขึ้นจริง | disbursement → POSTED ทันที · payment → APPROVED (ต้อง post) · penalty/waiver/write-off/reversal/adjustment/settlement → PENDING_APPROVAL · `DRAFT` ไม่เคยถูกบันทึก | `loans.router.ts:226`, `payment-requests.router.ts:284` |
| โพสต์ = atomic | ทรานแซกชันเดียว +pessimistic lock ที่ txn+loan, เขียน lines/allocations/balances/credit/status/audit พร้อมกัน | `posting-engine.service.ts:322-335` |
| เฉพาะ APPROVED ที่โพสต์ได้ | `Only APPROVED transactions can be posted (current status: X)` | `posting-engine.service.ts:328-330` |
| Reversal | เป็น txn ใหม่ + `referenceTransactionId`, ห้ามแตะ of line เดิม, หักตามลำดับ allocation เดิม (`reversible = original − alreadyReversed`), ห้ามเลือก component เอง, ถ้ามี POSTED ADJUSTMENT อ้างอิง → 422 บังคับใช้ Adjustment Workflow, DISBURSEMENT reverse ไม่ได้ | `allocation.service.ts:77-93`, `posting-engine.service.ts:66-79,227-269` |
| Maker-checker | ผู้สร้างห้ามอนุมัติ/ปฏิเสธคำขอชำระเงินของตัวเอง · ผู้สร้าง KYC ห้าม verify · maker ห้ามตัดสินทุก step ของ workflow ตัวเอง | `payment-requests.router.ts:241-243`, `kyc.router.ts:314-326`, `approval.service.ts:149-151` |
| Threshold | `amount ≤ checker` → [CHECKER] · `≤ head` → [CHECKER,HEAD] · else [CHECKER,HEAD,ADMIN]; ค่าเริ่มต้น 1,000,000 / 10,000,000 LAK แก้ได้ผ่าน `system_config` (ADMIN) | `approval.service.ts:25-57` |
| ตัดสินตามลำดับ | step ต้องตามลำดับ + role map ตามชั้น · อนุมัติ ≠ โพสต์ | `approval.service.ts:140-143` |
| สถานะสินเชื่อ | คำนวณหลังโพสต์เท่านั้น: `WRITE_OFF` type → total<0.005=WRITTEN_OFF; `WRITE_OFF_REVERSAL` → total>0.005=ACTIVE; อื่น ๆ → total>0.005=ACTIVE (เปิดกลับอัตโนมัติ) / ≤0.005=CLOSED (WRITTEN_OFF ที่ 0 อยู่ WRITTEN_OFF) | `loan-balance.service.ts:42-57` |
| KYC gate | `blockDisbursementUntilVerified && kycStatus!==VERIFIED` → 422 `Customer KYC is X — disbursement requires VERIFIED KYC (CUST-…)` ตรวจตอนสร้างสินเชื่อเท่านั้น | `loans.router.ts:172-177` |
| KYC upload | ตรวจ magic bytes (JPEG `FFD8FF`, PNG `8950 4E47`, WEBP `RIFF…WEBP`) ไม่เชื่อ client MIME → 415 · ขนาด > policy → 422 · sha256 ซ้ำต่อลูกค้า → 409 · quota รวมต่อลูกค้า → 422 · `issuedAt` ไม่อนาคต, `expiresAt > issuedAt` | `kyc.service.ts:27-42,50-94` |
| Settlement | `agreedAmount ≤ outstanding+0.005` · อนุมัติแล้วไม่แตะยอด · `settlement-payment` ต้อง APPROVED และ `cash+credit ≤ agreedAmount+0.005` · shortfall waiver ต้อง `netPaid+0.005 ≥ agreedAmount` และ waives ทั้งยอดคงเหลือเป็น WAIVER แยก | `settlement.service.ts:6-36`, `settlements.router.ts:87-111,205-268` |
| Reconciliation | `computed = Σ signed lines (POSTED)` vs `operational` = คอลัมน์ยอดคงเหลือ · `MATCHED` ⟺ ทุก component `|diff|<0.005` · บันทึกทุก run · MISMATCHED → audit `RECONCILIATION_MISMATCH` ไม่แก้อัตโนมัติ | `reconciliation.router.ts:30-114` |
| Policy 2 ชั้น | env → `system_config` ทับ: `approval.*`(2), `kyc.*`(13), `password.*`(6), `avatar.*`(3) · เลขอ่านทับเมื่อ finite>0, bool `===1`, CSV ต้องไม่ว่าง · MIME ตัดเหลือ 3 نوعภาพเท่านั้น · `minLength>maxLength` → self-heal | `kyc-policy.service.ts:30-152`, `password-policy.service.ts:14-64`, `avatar-policy.service.ts:12-42` |
| Reset security | OTP = `randomInt(0,1e6)` pad6, TTL 10 น. · LINK = `randomBytes(32) base64url`, TTL 60 น. · เก็บเฉพาะ `sha256hex` · cooldown ต่อ user 60 วิ · IP throttle ใช้ `otpMaxAttempts` ตัวเดียวกัน (5 ครั้ง/60 วิ ทุกบัญชี) · `retireAllSecrets` หลังรีเซ็ตสำเร็จ | `password-reset.service.ts:11-145` |
| Audit action strings | 34 ตัว เช่น `TRANSACTION_POSTED`, `LOAN_STATUS_CHANGED`, `CREDIT_ACCRUED`, `KYC_REVERIFY_REQUIRED`, `USER_RESET_BURNED`, `RECONCILIATION_MISMATCH`, `CONFIG_UPDATED`, `NOTIFICATION_REQUEUED` | รวบรวมจากทุก router + service |

### 1.5 ฟีเจอร์ใหม่ 4 ชุด (Stage 0–4) ที่ต้องเทสต์เพิ่ม

- **Logger**: winston, 2 transports (console silly + ไฟล์ info), ไฟล์ `server/src/logs/YYYYMMDDHH_LoanSystem.log` (Asia/Bangkok, rollover ราย ชม.), format ข้อความธรรมดา `YYYY-MM-DD HH:mm:ss [LEVEL  ]: msg`, **meta/error ถูกละทิ้งทั้งหมด** (`logger.ts:94-96`), ไม่มี redaction
- **Mailer/Outbox**: ตาราง `notification_outbox` (คอลัมน์ camelCase) เขียนในทรานแซกชันเดียวกับ business event (ยกเว้น `USER_CREATED` ที่อยู่นอกทรานแซกชัน) · dispatcher `setInterval` 5 วิ, batch 20, linear backoff `backoffSeconds × attempts`, DEAD ที่ attempts ≥ 5 · transport `log|kafka|http` (ค่าไม่รู้จัก → log เงียบ ๆ) · mailer: `POST /api/send` (x-api-key, timingSafeEqual) + Kafka consumer group `mailer-send`, topic `loan.notification`, DLQ `loan.notification.dlq`, ไม่มี dedup
- **User management**: email/isEmailVerified/hasAvatar/lastLoginAt/passwordChangedAt/deletedAt · avatar = multer memory + `detectImage` + ตาราง BLOB แยก + policy `avatar.*` · soft delete/restore (restore + write แยกเพื่อ set isActive) · send-reset-link เดี่ยว/bulk(≤200, ไม่ abort)
- **Forgot password**: 3 จังหวะ (OTP → LINK → reset) · ตอบ 202/400 แบบเดียวกันเพื่อไม่ให้สำรวจอีเมลได้ · OTP เทียบแบบ per-user row (นับ attempt ได้) · LINK เทียบด้วย hash
- **Reports**: `GET /api/reports/monthly?months=1..36&customerId=` → `{data:{currency,from,to,months,customerId,openingOutstanding,closingOutstanding,loanBookOutstanding,rows[],totals}}` · rows[] = 17 ฟิลด์ + `mom`/`yoy` {collected,disbursed,outstanding}×{absolute,percent|null} · guard ADMIN+HEAD เท่านั้น

---

## ตอนที่ 2 — Stage 2: ออกแบบข้อมูลจำลอง

### 2.1 หลักการสร้าง

- สคริปต์ `scripts/test/seed-test-data.mjs`รันซ้ำได้ (ต้องรันหลัง reset เท่านั้น; ถ้ามีข้อมูล test อยู่แล้วจะ abort เพื่อไม่ให้เลขซ้ำ)
- **Deterministic**: ใช้ PRNG seed 12345 (`mulberry32`) ไม่ใช้ faker แบบสุ่ม; ทุกรหัสผ่าน/id/เบอร์อ้างอิงคงที่ตาม seed → รันแล้วได้ข้อมูลเดิมทุกครั้ง
- ทุก email ลงท้าย `@test.local` · ทุก username ขึ้นต้น `test_` · ทุก fullName/ชื่อบริษัทติด prefix `TEST` หรืออักษรลาว/ไทย/อังกฤษปนกันตามเคส
- ทุกยอดเงินเป็น "ตัวเลขที่ oracle คำนวณเองได้" (ไม่ใช้ทศนิยมสุ่มที่ยาวเกิน 2 ตำแหน่ง) และมีเคสจงใจให้ตกที่ขอบ `0.005`
- เกณฑ์เวลา: seed บันทึก `referenceNow` (ISO) ไว้ใน `seed-manifest.json` ทุกเคสที่ขึ้นกับ `asOf` จะส่งวันที่ absolute เอง จึงไม่เปราะต่อวันที่รัน

### 2.2 ผู้ใช้ทดสอบ (10 คน)

| username | role | สถานะ | ใช้เทสต์อะไร |
|---|---|---|---|
| `test_admin` | ADMIN | ปกติ | ควบคุม everything, reports, config |
| `test_head` | HEAD_APPROVER | ปกติ | tier HEAD/ADMIN approval, reports |
| `test_checker1` | CHECKER | ปกติ | approval, KYC review, payment approve |
| `test_checker2` | CHECKER | ปกติ | แยกผู้ตัดสินเพื่อ maker≠checker |
| `test_maker1` | MAKER | ปกติ | create payment request, upload KYC,โพสต์ |
| `test_maker2` | MAKER | ปกติ | เคส owner-only (KYC delete, avatar) |
| `test_viewer` | VIEWER | ปกติ | ยืนยันว่าถูกกันจากงาน write + reports |
| `test_disabled` | CHECKER | `isActive=false` | login ต้อง 401 |
| `test_nomail` | MAKER | email ว่าง | skip notification path, send-reset-link → 422 |
| `test_unverified` | ADMIN | email มีแต่ `isEmailVerified=false` | สนาม isEmailVerified + reset path |

รหัสผ่านทดสอบ `Tst@2026#a` (10 ตัว, มี digit/upper/lower/symbol) — ผ่าน policy ปัจจุบัน (min6/max16) และผ่าน policy เข้มสุดที่เปิดได้ (min8 + requireSymbol)
+ soft-deleted user 1 คน (`test_deleted`) สำหรับ `includeDeleted`/restore

### 2.3 ข้อมูลธุรกิจ (ครอบคลุมทุกสถานะ + กระจาย ≥ 14 เดือน)

**Loan products 5 ตัว** (ทดสอบ `rateUnit`/`termUnit`/`PenaltyMode` ครบ):
`TST-FLAT-M` (flat %/month, 12 งวด, penalty PERCENT_OF_OVERDUE 1.5%/month, cap 20%) · `TST-FLAT-Y` (%/year, term เดือน) · `TST-DAY` (rate %/day, 45 วัน) · `TST-WEEK` (rate %/week, term สัปดาห์) · `TST-FIXED-PEN` (FIXED_PER_PERIOD 50,000/เดือน, grace 5) + `TST-NOPEN` (mode NONE)

**ลูกค้า 18 ราย** กระจายกรณี KYC:
VERIFIED ครบ 7 · PENDING รออนุมัติ 3 · REJECTED 2 · NOT_VERIFIED ไม่มีเอกสาร 2 · ขาด SELFIE/SIGNATURE 2 · เอกสารหมดอายุ/ใกล้หมดอายุ 2 (มี expiringSoon) — รวม case "รูปผิดประเภท" (ไฟล์ .jpg ปลอมเป็น PNG magic bytes) และ "ไฟล์เกิน quota" ในกลุ่มที่อัปโหลดจริง
ชื่อลูกค้า: ลาวล้วน / ไทยล้วน / อังกฤษล้วน / ผสม 3 ภาษา + ชื่อมีเครื่องหมายพิเศษ `'` `"` `<` `>` `--` (SQLi/XSS probe)

**สินเชื่อ 20 สัญญา** ครอบคลุม: ACTIVE ปกติ 8 · ค้างชำระ/OVERDUE (มีค่าปรับ accrual) 5 · จ่ายปิดแล้ว CLOSED 3 · WRITTEN_OFF 2 (1 เคสมี reversal กลับมาเป็น ACTIVE) · ยอด 0/น้อยมาก/สูงมาก (999,999,999) · ปล่อยกู้เดือนก.พ. ปีอธิกสุรทิน (2028) · ปล่อยกู้วันสิ้นเดือน · สัญญา 1 งวด (`periodCount=1`) · สัญญาข้ามปี
**ธุรกรรม POSTED ≥ 120 รายการ กระจาย 16 เดือน** (2025-07..2026-10 เพื่อให้เห็นทั้ง MoM และ YoY จริง มีเดือนที่ 0 และเดือนที่มียอดเดียวสำหรับเคสหารศูนย์)
**Payment requests**: PENDING 4 · APPROVED-but-not-posted 3 · POSTED ตรงงวด 12 · บางส่วน 6 · เกิน (เกิด credit) 5 · ใช้ credit 4 · REJECTED 3 + resubmit 2 · override การจัดสรร 3 · override เกินยอด → 422 2
**Transactions other types**: PENALTY manual 2 · accrue 4 · WAIVER บางส่วน/ทั้งหมด 4 · WRITE_OFF บาง/เต็ม 4 · WRITE_OFF_REVERSAL 2 · PAYMENT_REVERSAL เต็ม/บาง 5 · reversal ที่มี ADJUSTMENT ขวาง 1 · ADJUSTMENT บวก/ลบ/เกินจนติดลบ 4
**Settlement**: PENDING_APPROVAL 1 · APPROVED + payment + shortfall waiver 1 · APPROVED จ่ายครบ 1 · REJECTED 1
**Credit**: `customer_credits` ≥3 (1 เคสเหลือ 0), `credit_ledger` ACCRUED/USED ครบ
**Config**: policy เดิมตั้งไว้ตามดีฟอลต์ + เคสแก้แล้วทดสอบต่อ (จะ restore กลับท้าย-suite)

### 2.4 Oracle อิสระ (`scripts/test/expected.json`)

- เขียน **ใหม่ทั้งหมด** ในไฟล์ `scripts/test/oracle.mjs` — ห้าม import จาก `server/src/**` แม้แต่บรรทัดเดียว (จะมีเทสต์ assert เรื่องนี้)
- สิ่งที่ต้องคำนวณเอง: `round2`, day-count, flat interest, จำนวนงวด/due date (calendar clamp), penalty (2โหมด+cap), allocation sequence, credit accrual/use, ไล่ลำดับ status transition, ยอดคงเหลือรายงวด, และ **ตัวเลขรายงานรายเดือนทั้ง 17 คอลัมน์ + totals + mom/yoy** จากชุดข้อมูลเดียวกับที่ seed เขียนลง DB
- รูปแบบ: `{"meta":{...},"loans":{"LN-TST-000001":{"interestTotal":...,"schedule":[...],"expectedStatus":"ACTIVE"}},"monthly":{"2025-07":{...}},,"reports":{"window12":{"rows":[...],"totals":{...}}}}`
- เทียบด้วย `assertMoney(actual, expected)` ที่ require ตรงกัน **ทุกทศนิยม 2 ตำแหน่ง** (ต่าง absolute ≤0.005 และต้องไม่แตะขอบการปัดผิดทิศ) — ถ้าต่างจะพิมพ์ diff ทั้งก้อนพร้อมสูตรที่ใช้

---

## ตอนที่ 3 — Stage 3: Test Matrix (435 เคสเป้าหมาย)

รูปแบบทุกเคส: เรียก **HTTP จริง** ผ่าน `scripts/test/http.mjs` (fetch → `http://localhost:4000/api`) ด้วย token ของ role ที่ระบุ แล้ว assert status + body + DB query (ผ่าน mysql2 โดยตรง) + audit row
ตัวเลขต่อหมวดคือเป้าออกแบบ — เคสจริงอาจเพิ่ม/ยุบตอนเขียนสคริปต์ และจะรายงานตัวเลขจริงทุก ID ใน TEST-REPORT.md
แต่ละเคสมี ID ที่คงที่ ใช้ใน TEST-REPORT.md เพื่อไล่ตรวจทีละข้อ

### หมวด A — ปลอดภัยของการล้างข้อมูล (SFT, 5)
| ID | เคส | คาดหวัง |
|---|---|---|
| SFT-01 | รัน reset โดย `NODE_ENV=production` | ปฏิเสธ exit≠0, ไม่มี SQL รัน |
| SFT-02 | รัน reset โดย `DB_HOST` ภายนอก allowlist | ปฏิเสธ |
| SFT-03 | รัน reset โดย `DB_NAME` ไม่ตรงกับ `EXPECTED_DB` | ปฏิเสธพร้อมชื่อ DB จริง |
| SFT-04 | รัน reset ไม่มีไฟล์ backup ของ run นี้ | ปฏิเสธ |
| SFT-05 | รัน reset สำเร็จ → นับทุกตาราง | ทุกตาราง (เว้น config/templates) = 0 แถว, โครงสร้างตาราง checksum เดิม (ตรวจ `information_schema.columns`) |

### หมวด B — Auth (AUT, 12)
login ถูก/ผิดรหัส/username ไม่Exist/`isActive=false`/soft-deleted · token ปลอม/หมดอายุ/alg=`none`/ลายเซ็นผิด · ไม่มี header/`Bearer` สเปซผิด · `GET /me` ถูกต้อง/401 · audit `USER_LOGIN` เกิดถูกคน · rate-limit/lockout (ถ้าระบบมี) → บันทึกว่าไม่มี = **finding** ไม่ใช่ fail

### หมวด C — RBAC grid (RAC, 96)
สร้างตารางคาดการณ์ `expectedRoleMatrix` ในสคริปต์ (57 routes × 5 roles, RESTRICTED_ROLES ทั้งหมดเป็น MAKER/CHECKER/HEAD/ADMIN) → รันทุกคู่แล้วเทียบ status:
`2xx/422 (allowed)` · `403` (ถูกกัน) · `401` (ไม่มี token) — ทุก endpoint ที่ต้อง auth ทดสอบ 401 หนึ่งครั้ง
จุดที่แผนนี้คาด 403: `users.*` (VIEWER/CHECKER/HEAD/MAKER ทั้งหมดยกเว้น ADMIN), `config` PUT, `loan-products` POST/PATCH, `approvals/*` REVIEW, `reports/monthly` (MAKER/CHECKER/VIEWER), `notifications` ADMIN-only, KYC verify/reject/reopen ตามชั้น
**Guard gap ที่ตรวจพบแล้วและจะรายงานเป็นข้อค้นพบ (ไม่แก้โค้ด)**: ทุก endpoint อ่านข้อมูล (customers/loans/transactions/credits/audit/kyc documents+image/dashboard/config reads) เปิดให้ **VIEWER** ด้วย — จะ assert ตามพฤติกรรมจริงของโค้ด แล้ว mark เป็น risk ในรายงาน ไม่ใช่ fail

### หมวด D — Forgot password (FPW, 20)
อีเมลมี→202 / ไม่มี→202 **body เหมือนกัน byte-for-byte** · ผู้ใช้ disabled→202 · cooldown ซ้ำใน 60 วิ→202 เงียบ · IP throttle ครบ 5 → 429 · `verify-otp` OTP ผิด → 400 `Invalid or expired verification code` · อีเมลไม่มีอยู่ → 400 ข้อความเดียวกัน · ผิดครบ 5 → burn + audit `USER_RESET_BURNED` + ใช้ต่อไม่ได้ · OTP ถูก → `verified:true` + `resetUrl` + LINK row · ใช้ OTP ซ้ำ → 400 · `reset-password`: token ผิด/ไม่มี/เคยใช้/หมดอายุ → 400 `LINK_REJECTED` · รหัสอ่อนกว่า policy → 400 พร้อมรายละเอียด · สำเร็จ → bcrypt เปลี่ยน, `passwordChangedAt`, `retireAllSecrets`, audit `USER_PASSWORD_RESET`, login รหัสใหม่ได้/รหัสเก่าไม่ได้, **OTP/LINK เก่าทั้งหมดยังใช้ไม่ได้** · assert DB: `password_reset_tokens.tokenHash` ไม่มีค่า plain (query ด้วย hash ของ plaintext ที่รู้) · assert log: ไฟล์ log ชั่วโมงปัจจุบันไม่มี OTP/โทเคน (ปัจจุบัน **จะมี OTP โผล่ใน subject** → คาดหวัง fail, ดู §5)

### หมวด E — User management (USR, 22)
สร้าง (role ครบ 5, username ซ้ำ→409, email ซ้ำ→409, password ไม่ผ่าน policy→400/422) · PATCH fullName/email(role/isActive/password) + email เปลี่ยน→`isEmailVerified=false` · avatar: upload JPEG/PNG/WEBP จริง→201, `.jpg` ปลอมเนื้อหา PDF→415/422, ใหญ่เกิน→422, policy `enabled=false`→ปฏิเสธ, MIME ไม่อยู่ใน allowlist→ปฏิเสธ, self vs other user (403), replace ของเดิม→เหลือ 1 BLOB row, DELETE→404 เมื่อไม่มี · list `includeDeleted` · soft delete (self→422, other→200, login ไม่ได้, history คงอยู่) · restore (+`reactivate`) → **ตรวจ isActive ใน DB จริง** · send-reset-link: ปกติ→sent, ไม่มี email→422, disabled→422, cooldown→422 · bulk: mixed valid/invalid → `sent[]`/`skipped[]` ครบ, ids >200→400 · ทุกเคส assert audit action ที่ถูกตัวและ userId ถูกต้อง · publicUser ไม่เคยมี `passwordHash`

### หมวด F — KYC (KYC, 18)
upload ประเภทเอกสารนอก allowlist→422 · magic bytes ปลอม→415 · ซ้ำ sha256→409 · quota ต่อลูกค้าเกิน→422 · issuedAt อนาคต/expiresAt≤issuedAt→400 · checklist: ขาด ID/SELFIE/SIGNATURE → submit 422 ระบุรายการที่ขาด · submit สำเร็จ→PENDING + audit · verify โดยคนละคน→VERIFIED + snapshot `kycAppliedPolicy` · verify โดยผู้ส่ง/ผู้upload→403 · reject ต้องมี reason → REJECTED · reopen (ADMIN จาก VERIFIED เท่านั้น, นอกนั้น→422) · upload/ลบหลัง VERIFIED + `reverifyOnDocumentChange=true` → กลับ PENDING + audit `KYC_REVERIFY_REQUIRED` · ลบเอกสาร by owner vs other(403) vs ADMIN(200) · เปลี่ยน policy ผ่าน `/config/kyc` แล้วผลเปลี่ยนจริง (เช่น ปิด requireSelfieWithId → checklist ผ่าน) · GET content คืน bytes ตรง checksum + cache header

### หมวด G — สินเชื่อ/การเบิก (LDN, 14)
KYC ≠ VERIFIED → 422 ห้ามเบิก · VERIFIED → สร้าง ACTIVE + DISBURSEMENT **POSTED ทันที** + 2 lines (PAST_PRINCIPAL/PAST_INTEREST) + `currentOutstanding = round2(P+I)` + audit `LOAN_DISBURSED`+`TRANSACTION_POSTED` · ยอดตรงกับ oracle ทุกเคสรวม rateUnit DAY/WEEK/MONTH/YEAR · `periodCount=1` · ปีอธิกสุรทิน + วันสิ้นเดือน (due date clamp) · VIEWER/HEAD(ในฐานะ maker?) ห้ามสร้างตาม role matrix · principal ≤0 / เกิน max / สินทรัพย์ไม่มี → 400/422 · ตรวจ reference number format `LN-######` · **ตรวจว่า disbursement ไม่ผ่าน workflow (finding ตาม §5 ข้อ 2)**

### หมวด H — Approval workflow (APR, 16)
เพดาน 1M/10M: `amount=1,000,000`→[CHECKER] · `1,000,000.01`→[CHECKER,HEAD] · `10,000,000`→[CHECKER,HEAD] · `10,000,000.01`→[CHECKER,HEAD,ADMIN] · แก้ threshold ผ่าน ADMIN PUT → workflow ใหม่ใช้ค่าใหม่ + ตรวจ `head≥checker`(422) · maker สร้างแล้วพยายามตัดสิน step ของตัวเอง → 403 ทุกชั้น · CHECKER ตัดสิน step HEAD → 403 · ตัดสินข้ามลำดับ (step2 ก่อน step1) → 422 · ADMIN คนเดียวตัดสินทุกชั้น (ปัจจุบันระบบ **ไม่ห้าม** → assert ตามจริง + รายงาน) · reject ต้องมี reason · reject → workflow REJECTED + txn REJECTED + ไม่แตะยอด · approve ครบชั้น → txn APPROVED **ยังไม่ POSTED** (invariant #1/#2) · `GET /approvals/pending` คืนเฉพาะชั้นที่ตัวเองตัดสินได้ + `canDecide/blockedForUser`

### หมวด I — ชำระเงิน + Allocation + Credit (PAY/ALC/CRT, 34)
create (ต้อง ACTIVE loan, ยอด >0, credit ไม่พอ→422) · approve โดย maker คนเดียวกัน→403 · approve โดย checker→APPROVED txn · post → lines เป็น **negative** ตามลำดับ PENALTY→PAST_INTEREST→PAST_PRINCIPAL, `payment_allocations` ตรงกับ lines, ยอดคงเหลือลดตามนั้น, audit `TRANSACTION_POSTED` + `LOAN_STATUS_CHANGED` เมื่อปิดงวด · ชำระบางส่วน → หลายงวด PARTIAL · ชำระเกิน → excess เข้า credit + ledger ACCRUED · ใช้ credit + excess คงเหลือ → USED/ACCRUED พร้อม balanceAfter ถูก · override การจัดสรร: ถูก→ได้, เกิน outstanding→422, เกิน payment total→422, component ลบ→422, ตรวจ re-validate ตอนโพสต์ (ยอดขยับหลังอนุมัติ) → 422 · ห้าม post ซ้ำ (idempotency) → 422/409 · post txn สถานะ PENDING → 422 `Only APPROVED…` · post DISBURSEMENT ผ่าน engine → 422 · VIEWER ห้าม approve/post · ตรวจว่า PENDING/REJECTED request ไม่เปลี่ยนยอดเลย (invariant #1) · ตรวจ credit ไม่มีทางติดลบ

### หมวด J — Reversal (RVS, 14)
reverse เต็ม → ยอดกลับมา + status เปิดกลับ (ACTIVE) · reverse บางส่วน → หักตามลำดับ original allocation (invariant #5/#6: ห้าม pro-rata; ตรวจ `PAYMENT_REVERSAL` lines ไม่ใช่สัดส่วน) · reverse แล้ว `reversible` หมด → 422 · reverse ของ txn ที่ยังไม่ POSTED → 422 · reverse ของ DISBURSEMENT → 422 · reverse ที่มี POSTED ADJUSTMENT อ้างอิง → 422 ข้อความ Adjustment Workflow · `CLOSED + reversal >0 → ACTIVE` · `CLOSED + reversal แล้ว =0 → CLOSED` · `WRITTEN_OFF + reversal >0 → ACTIVE` · `WRITTEN_OFF + reversal =0 → WRITTEN_OFF` (invariant #14/#16) · threshold reversal 10M → ต้อง ADMIN ขั้นสุดท้าย · reject reversal → ไม่แตะยอด · ตรวจ of line เดิมไม่เปลี่ยน (invariant #3) + `referenceTransactionId` ชี้ถูก · ตรวจ staff เลือก component เองไม่ได้ (invariant #7)

### หมวด K — Penalty / Waiver / Write-off / Adjustment (PEN/WVR/WOF/ADJ, 26)
accrue: คำนวณ `suggested` ตรง oracle (PERCENT + FIXED + grace + cap + ยกเลิก relieved แล้ว) · ≤0 → 422 `No penalty left…` · CLOSED → 422 · WRITTEN_OFF → **ปัจจุบันไม่ห้าม** (assert ตามจริง + finding) · manual penalty: ผ่าน workflow, post แล้วเพิ่ม PENALTY component, **ไม่โดน cap** (finding) · waiver บางส่วน/100%/เกิน outstanding→422/reject→ไม่แตะยอด · waiver of penalty ไม่ทำให้ยอดจ่ายจริงถูกแก้ (invariant: original immutable) · write-off บาง/เต็ม → WRITTEN_OFF เฉพาะทุก component เป็น 0 · write-off reversal บางส่วน + status · adjustment บวก/ลบ/ทำให้ component ติดลบ→422 · `adjustmentMagnitude` = Σ|component| ใช้คิด threshold · ตรวจ WAIVER on PAST_INTEREST/PAST_PRINCIPAL ที่สเปก §17 พูดถึงแต่ penalty (finding ขอบเขตกว้างกว่าสเปก) · settlement shortfall waiver เป็น WAIVER แยก (invariant #12)

### หมวด L — Settlement (STL, 10)
สร้าง (≤ outstanding, ACTIVE เท่านั้น) · workflow ตามจำนวนเงิน · อนุมัติแล้วไม่แตะยอด (invariant #11) · settlement-payment เกิน agreedAmount → 422 · POSTED SETTLEMENT_PAYMENT นับใน report `moneyIn` · waive-shortfall ต้อง netPaid ≥ agreed · ยังไม่จ่าย → ไม่ waive ได้ · REJECTED agreement ไม่ให้จ่าย · ตรวจ type ที่ออกมาเป็น SETTLEMENT_PAYMENT ไม่ใช่ PAYMENT · ตรวจ notification `SETTLEMENT_REQUESTED`/`SETTLEMENT_DECIDED`

### หมวด M — Reconciliation (RCT, 6)
run ทุก loans → MATCHED ทั้งหมด (invariant #20 + เป็น proof ว่า ledger derived = operational) · run ราย loan · inject ความต่างผ่าน ADJUSTMENT path ที่ถูกต้อง → MATCHED อีก · ตรวจ `computedFromHistory` ตรง oracle · record ทุก run ไม่แก้อัตโนมัติ · assert POSTED-only (txn PENDING ไม่เข้าผลต่าง)

### หมวด N — รายงาน + Dashboard (RPT/DSH, 24)
`months` = 1/6/12/24/36 → จำนวน rows + หน้าต่าง `from/to` · `months=0/37/abc` → 400 · `customerId` ผิด uuid → 400 · **เทียบกับ `expected.json` ทั้ง 17 คอลัมน์ทุกเดือน** (disbursed, moneyIn, reversed, writtenOff, waived, penaltyCharged, principalPaid, interestPaid, penaltyPaid, interestAccrued, penaltyAdded, outstandingDelta, closingOutstanding, loansOpened, transactions, collected) · MoM/YoY: `%` ตรง + `absolute` ตรง + เดือนก่อนเป็น 0 → `percent:null` (ไม่หารศูนย์) + ไม่มีข้อมูลปีก่อน → `{0,null}` · POSTED-only (PENDING/REJECTED ไม่เข้า) · `closingOutstanding == Σ signed POSTED lines` · **ตรวจ `loanBookOutstanding` ไม่กรองตาม `customerId` (finding §5 ข้อ 4)** · dashboard `/stats` ตัวเลขต้องตรงกับ reports ชุดเดียวกัน (totalOutstanding, activeOutstanding, loansByStatus, postedTransactions, totalCustomerCredit) · `recent-activity` = 10 ล่าสุด DESC · role gate ADMIN/HEAD (MAKER/CHECKER/VIEWER 403) · `collected = moneyIn − reversed`

### หมวด O — Notification / Mailer (NTF/MLR, 24)
ทุก event type ถูก enqueue จาก flow จริง (9 type): assert มี row, `recipientEmail`, `subject`/`bodyHtml`/`bodyText` ตรง render, `payload` ถูก, `status=PENDING`, และ id = `eventId` · assert เขียน**ในทรานแซกชันเดียวกับ business change** โดย inject ความผิดพลาด (เช่น template ปิด) แล้ว business ยังสำเร็จ/outbox ยังอยู่ · no email → skip + warn log · template `isActive=false` → skip · `NOTIFY_ENABLED=false` → ไม่ enqueue/ไม่ dispatch · transport `log` → ไม่ publish อะไร · transport `http` + mailer หยุด → FAILED + backoff (30/60/90/120) → DEAD ที่ 5 · dispatcher หยุดกลางคัน → event ไม่หาย, เปิดใหม่ drain หมด · `POST /notifications/:id/requeue` → PENDING/attempts=0 + audit · SENT requeue → 404 · `GET /summary` counts ตรง · transport `kafka`: produce เข้า `loan.notification` key=eventId + headers (ตรวจด้วย redpanda kafkacat ถ้า kafka container ใช้ได้) · malformed JSON → DLQ `loan.notification.dlq` + header `reason` · send fail → DLQ · mailer auth: ไม่มี key→401, key ผิด→401, ถูก→202 · `jsonTransport` (SMTP_HOST ว่าง) → ไม่มีอะไรออกเน็ต · template variables: `{{otp}}`, `{{expiresMinutes}}` · **sanitize**: ใส่ `<script>`/`onerror=`/`javascript:` ใน template subject/body → PATCH ต้อง 422 (`assertTemplateMarkupSafe`) · ค่า `{{var}}` ที่ inject เข้า HTML ถูก escape · header injection (`\r\n` ในชื่อ) ถูก strip · **ตรวจไม่มี credential จริง/อีเมลจริงใน env ที่เทสต์ใช้** (ดู §5 ข้อ 3)

### หมวด P — Logger (LOG, 8)
ไฟล์เกิดตามรูปแบบ `YYYYMMDDHH_LoanSystem.log` + Asia/Bangkok · rollover ชม. (จำลองโดย/mock หรือตรวจ 2 ไฟล์ถ้ารันคร่อม ชม.) · level ต่ำกว่า info ไม่ลงไฟล์ / info ขึ้นไปลงไฟล์ + console · error handler บันทึก method+URL · **ไม่ลง**: password, passwordHash, JWT, raw OTP, reset token, email recipient ใน request, เลขบัตรประชาชน — scan ทั้ง log dir ด้วย regex · meta ที่ส่งเป็น argที่สองถูกทิ้ง (assert พฤติกรรมจริง + finding "stack/สาเหตุหาย") · `NODE_ENV=test` silent

### หมวด Q — Config/Policy runtime (CFG, 14)
GET ทุก policy คืน `{policy, defaults, checksum}` · PUT โดย ADMIN เท่านั้น (role matrix) · KYC: 13 ฟิลด์, เกิน range (1..102400 KB ฯลฯ) → 400/422 · Password: min>max → 422 หรือ self-heal ตามจริง, ปิดทุก rule → 422 · Avatar: `enabled=false`, MIME list ว่าง → 422, `maxFileSizeKb` ขอบ 1/10240 · overlay semantics: ค่า 0 ใน number row ถูกมองข้าม (assert ตามจริง) · `CONFIG_UPDATED` audit ทุก PUT · ตรวจว่าผลมีผลทันทีไม่ต้อง restart (อ่านผ่าน `GET /api/auth/password-policy` ซึ่งเป็น public) · restore ค่าเดิมท้าย suite

### หมวด R — Concurrency & Idempotency (CNC, 8)
โพสต์ payment เดียวกัน 2 req พร้อมกัน → ต้องสำเร็จ 1 อีกอัน 422/409 และ **ไม่มี line ซ้ำ/ยอดไม่ double** · approve payment request ซ้ำพร้อมกัน → ไม่มี txn ซ้ำ · create payment request 2 ครั้ง body เดิม → 2 record (ระบบไม่มี dedup — assert ตามจริง + finding) · ชำระ 2 สัญญาพร้อมกัน + credit เดียวกัน → credit ไม่ติดลบ (invariant ที่เปราะ: `customer_credits` ไม่ได้ lock) · สร้าง loan พร้อมกัน 2 ครั้ง (KYC gate + reference number) → `LN-######` ไม่ชนกัน · requeue notification พร้อมกัน 2 req · dispatcher 2 โปรเซส → **ส่งซ้ำ** (ไม่มี FOR UPDATE) = finding · reset password 2 หน้าต่างพร้อมกันด้วยโทเคนเดิม → ใช้ได้ครั้งเดียว

### หมวด S — Traceability กับสเปก §25 + §26 (VEC/INV, 46)
- `VEC-*` 26 เคส = ทุกข้อใน §25 matrix (Payment 8, Reversal 7, Loan Status 6, Settlement 5, Write-off 6, Waiver 5 — ตัดข้อซ้ำกับหมวดบนแล้วจะอ้างอิง ID เดิมแทน เช่น `VEC-RVS-03 → RVS-05`)
- `INV-*` 20 เคส = invariant 1–20 จาก §26 ทีละข้อ โดย assert จากหลักฐานจริง (SQL/HTTP) ไม่ใช่การอ่านโค้ด
แผนที่จะทำตาราง mapping `§25/§26 item → case ID → ผล` ไว้ท้าย TEST-REPORT.md เพื่อให้ไล่ตรวจทีละบรรทัดได้

### หมวด T — Web / i18n / Build (WEB, 8)
`tsc --noEmit` (app + server), `vite build`, `oxlint` (0 error), `npm run test -w server` ทั้งหมด, locale parity en/lo **ทุกคีย์** + สแกน codepoint ไทยใน `lo.json` ต้อง 0 + ตรวจทุก literal `t('...')` ใน src มีคีย์จริง, หน้า Reports/Users/Login ไม่ render คีย์ดิบ (ตรวจด้วย regex), axios interceptor mapping, i18n Lao/English switch · **UI จริงผ่านเบราว์เซอร์จะไม่ทำถ้ายังไม่ได้รับอนุญาต** (ตามข้อตกลง) — ถ้าอนุญาตจะใช้ browser-use MCP ไล่ 5 หน้าหลัก + ตรวจ console ไม่ error

### หมวด U — Security probes (SEC, 10)
SQL injection ผ่าน query (`?q=`, `?action=`, `?customerId=`) และ body (fullName, reason) → zod reject / parameterised, ข้อมูลไม่รั่ว · XSS: ชื่อมี `<img onerror>` → API เก็บได้แต่ output เป็น text (ตรวจ escape ใน template render) · filename traversal ผ่าน multipart · body ใหญ่เกิน (JSON 10MB) → 413/422 · CORS/helmet header พื้นฐาน · JWT `alg:none` + secret ผิด + token ของ user อื่นใช้กับ route self-only (avatar) → 403 · enum value ปลอม (`status=BOGUS`) → 400 ไม่ใช่ 500 · UUID ผิดรูป → 400 · error ไม่ stack trace รั่ว (production-like message) · reset link ไม่โผล่ใน query log/URL ที่ cache ได้ (`/reset-password?token=` เป็น client route — ตรวจว่า backend ไม่ log)

### 3.1 วิธีรัน (จะเพิ่มใน root `package.json`)

```
npm run test:e2e:reset    # backup + guard + wipe (ต้องใส่ --confirm-loan_management)
npm run test:e2e:seed     # seed-test-data.mjs + เขียน seed-manifest.json
npm run test:e2e:oracle   # สร้าง expected.json จาก oracle.mjs (ห้าม import src)
npm run test:e2e:run      # ยิง suite HTTP + SQL asserts ทั้งหมด
npm run test:e2e:full     # ทำทั้งหมดตามลำดับ + เขียน TEST-REPORT.md
npm run test:e2e:cleanup  # (Stage 5) เตรียมไว้ ห้ามรันถ้าไม่ได้สั่ง
```
- suite รันแบบ fail-fast ปิด,ผลทุกเคสเก็บใน `scripts/test/results/*.jsonl` แล้ว aggregate
- เซิร์ฟเวอร์สำหรับเทสต์สตาร์ทด้วย `SEED_ON_BOOT=false NODE_ENV=development` (มีสคริปต์ `test:server`) และ suite จะรอ `/health` พร้อมตรวจว่า `users` มีเฉพาะ `test_*`
- README: เพิ่มหัวข้อ "การทดสอบก่อนขึ้น Production" + วิธี restore backup

---

## ตอนที่ 4 — สิ่งที่จะส่งให้ตรวจ (Stage 4)

1. `TEST-REPORT.md` — สรุปรวม/แยกหมวด, ตารางทุกเคส (≈435 ID) (ID | หมวด | สิ่งที่ทดสอบ | input | คาดหวัง | ผลจริง | ผ่าน/ไม่ผ่าน), mapping §25/§26, รายการบั๊กพร้อม severity + ขั้นตอนทำซ้ำ + ไฟล์:บรรทัด + ข้อเสนอ, ตาราง user ทดสอบสำหรับล็อกอิน, ข้อมูลแต่ละตาราง, ช่องโหว่ที่ครอบคลุมไม่ถึง
2. `scripts/test/` ทั้งหมด (reset-db.mjs, seed-test-data.mjs, oracle.mjs, run-suite.mjs, helpers, cleanup-before-prod.mjs) + `results/` raw
3. `expected.json` + `seed-manifest.json`

---

## ตอนที่ 5 — ข้อค้นพบจากการสำรวจ (จะ **รายงาน** เป็นบั๊ก ไม่แก้โดยไม่ได้รับอนุญาต)

| # | ระดับ | เรื่อง | หลักฐาน |
|---|---|---|---|
| 1 | **สูง** | transport=`log` ทำให้ **OTP 6 หลักออกใน subject ที่ถูก log ลงไฟล์** (`PASSWORD_RESET_OTP` template subject มี `{{otp}}`) → ขัดข้อกำหนด 3.7 "ห้ามมีข้อมูลลับใน log" | `email-template.service.ts:219`, `notification-dispatcher.service.ts:58-61` |
| 2 | **สูง** | `notification_outbox.payload` เก็บ **OTP และ resetUrl แบบ plain text** ใน DB ทั้งที่คอมเมนต์บอกไม่เก็บ | `notification.service.ts:63-65`, `notification-events.service.ts:287-316` |
| 3 | **สูง** | `mailer/src/config.ts:50-51` hard-code fallback Gmail user + app password → ถ้า env ไม่ตั้งจะพยายามส่งจริงกับผู้ให้บริการจริง (ขัด "ห้ามเรียกบริการจริง") และ credential อยู่ในซอร์ส | `mailer/src/config.ts:39-51` |
| 4 | กลาง | `loanBookOutstanding` ใน reports **ไม่กรองตาม `customerId` และไม่นับเฉพาะ POSTED window** → ตัว cross-check เทียบกันคนละขอบ อาจสรุปผิดว่าเพี้ยน | `reports.router.ts:198-202` |
| 5 | กลาง | Dispatcher claim ไม่มี `FOR UPDATE`/lock และ mailer ไม่มี dedup → รัน 2 โปรเซสส่งเมลซ้ำ | `notification.service.ts:95-106`, `mailer/src/kafka.ts` |
| 6 | กลาง | endpoint อ่านข้อมูลทั้งหมด (รวมรูป KYC และ PII, audit log) เปิดให้ทุก role รวมถึง VIEWER — ไม่มี role guard | `kyc.router.ts:GET /documents`, `audit.router.ts:11` ฯลฯ |
| 7 | กลาง | disbursement สร้าง txn เป็น POSTED ทันที ไม่ผ่าน maker-checker (ต่างจากสเปก §21/§24) ทั้งที่มีโค้ดรองรับ workflow ของ DISBURSEMENT | `loans.router.ts:221-236` |
| 8 | กลาง | payment request ใช้ผู้ตัดสินคนเดียวทุกจำนวนเงิน (threshold ไม่บังคับกับ payment) | `payment-requests.router.ts:224-320` |
| 9 | กลาง | ค่าปรับ cap เป็นแค่ "คำแนะนำ" — manual penalty ไร้ cap และใส่บน loan WRITTEN_OFF ได้ | `transactions.router.ts:312-337` |
| 10 | กลาง | ผู้ใช้เดียวตัดสิน workflow ได้หลายชั้น (ตรวจแค่ maker≠approver) | `approval.service.ts:149-151` |
| 11 | ต่ำ | `req.ip` ไม่มี `trust proxy` แต่ nginx ส่ง X-Forwarded-For → IP throttle นับ IP ของ proxy ทั้งองค์กร | `app.ts`, `web/nginx.conf:9-13` |
| 12 | ต่ำ | logger ทิ้ง meta/error ทุกตัว → stack ไม่มีในไฟล์ | `logger.ts:94-96` |
| 13 | ต่ำ | `expireStaleSecrets` ไม่มีคนเรียก (row หมดอายุค้างในตาราง) · `TransactionStatus.DRAFT` ไม่มีวันถูกบันทึก · credit row ไม่ได้ lock (race) · reference number แบบ count+unique | `password-reset.service.ts:148-157` ฯลฯ |
| 14 | ต่ำ | `server/src/logs/` มีไฟล์เก่า `*_apiOpenWay.log` คนละ prefix กับโค้ดปัจจุบัน (คราบจากเวอร์ชันก่อน) | ตรวจไฟล์จริง |

ข้อ 1–3 จะถูกทำให้เป็นเทสต์ (LOG/SEC/NTF) และ **จะ fail อย่างมีหลักฐาน** — เป็นเจตนาของแผน: ให้เห็นช่องว่างก่อนขึ้น Production แล้วคุณค่อยตัดสินว่าจะแก้ก่อนหรือหลัง

---

## ตอนที่ 6 — ขอบเขตที่ **ไม่** ทำ (และเหตุผล)

- **ไม่แตะ production/เซิร์ฟจริง** — ไม่มี credential/endpoint ของจริงในแผนนี้ และ guard ของ reset จะปฏิเสธถ้า host ไม่ใช่ local
- **ไม่ส่งเมล/SMS จริง** — ใช้ `SMTP_HOST=""` (nodemailer jsonTransport) หรือ Mailpit ถ้าอนุญาตให้เพิ่ม container; ห้าม outbound internet
- **ไม่เปิดเบราว์เซอร์** จนกว่าจะได้รับอนุญาตเป็นลายลักษณ์อักษร (ข้อจำกัด tooling ปัจจุบัน)
- **ไม่แก้โค้ดระบบ/สูตรธุรกิจ** เพื่อให้เทสต์ผ่าน (ตามข้อกำหนด) — เจอบั๊ก = รายงาน
- **ไม่ load/perf test** และ **ไม่ test multi-tenant/branch hierarchy** ที่ยังไม่มีในสเปกเฟสแรก (§28 Non-Goals)
- **ไม่ตั้ง schema/migration ใหม่** — โปรเจกต์ไม่มี migration files; โครงสร้างมาจาก `synchronize` จะคง DDL เดิม 100% (ตรวจด้วย checksum ของ `information_schema.columns`)

---

## ตอนที่ 7 — ขอการอนุมัติ (ตอบ 4 ข้อนี้แล้วเริ่ม Stage 2 ทันที)

1. **ยืนยันชื่อ DB ที่อนุญาตให้ล้าง**: `loan_management` (ที่ `.env` ใช้อยู่) — ใช่หรือไม่ หรือให้สร้าง DB แยก `loan_test` (ระบบมีตัวรองรับแล้ว: `TEST_ENV.dbName`, `buildDataSource(database)`) แล้วรันเซิร์ฟเวอร์อีกพอร์ตรักษาข้อมูลเดิมไว้
2. **ล้าง `system_config` + `email_templates` ด้วยหรือไม่** (ค่า default policy/เทมเพลตจะ bootstrap กลับเองเมื่อรีสตาร์ต)
3. **เห็นด้วยกับการรัน `SEED_ON_BOOT=false`** ระหว่างเทสต์ เพื่อไม่ให้ข้อมูล demo เดิมหลุดกลับมาปน
4. **ให้เริ่มเขียน `scripts/test/*` ได้เลยไหม** และต้องการให้ตั้ง Mailpit container สำหรับเทสต์ mailer หรือใช้ jsonTransport (ไม่ติดตั้ง container)
