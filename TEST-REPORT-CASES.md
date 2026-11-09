# TEST-REPORT-CASES — ตารางทุกเคส (ไฟล์นี้ generate อัตโนมัติ อย่าแก้ด้วยมือ)

- แหล่งข้อมูล: `scripts/test/results.json` (run เมื่อ 2026-10-15T02:20:24.674Z) · backend `http://127.0.0.1:4000`
- สร้างใหม่ด้วย: `npm run test:e2e:report` หรือ `node scripts/test/report.mjs`
- บทวิเคราะห์/บั๊ก/severity อยู่ใน [TEST-REPORT.md](TEST-REPORT.md) — ตารางนี้อ้าง reference จากคอลัมน์ ผล
- ข้อมูลในฐานข้อมูลตอนรัน: ชุดจำลอง deterministic seed 12345 (`scripts/test/seed-manifest.json` สร้างเมื่อ 2026-10-15 02:18:12)

| หมวด (suite) | เคส | ผ่าน | ไม่ผ่าน |
|---|---:|---:|---:|
| auth/authz | 314 | 314 | 0 |
| forgot-password | 50 | 50 | 0 |
| users | 92 | 92 | 0 |
| kyc | 57 | 45 | **12** |
| loans | 184 | 184 | 0 |
| payments | 190 | 190 | 0 |
| posting | 118 | 118 | 0 |
| settlement | 173 | 173 | 0 |
| reconciliation | 46 | 46 | 0 |
| reports | 78 | 77 | **1** |
| notifications | 128 | 127 | **1** |
| logger | 66 | 61 | **5** |
| config | 76 | 71 | **5** |
| concurrency | 51 | 50 | **1** |
| invariants | 51 | 51 | 0 |
| interest | 80 | 80 | 0 |
| collection | 79 | 65 | **14** |
| **รวม** | **1833** | **1794** | **39** |

## ทุกเคส เรียงตาม ID

| ID | หมวด | สิ่งที่ทดสอบ | input | ผล |
|---|---|---|---|---|
| E2E-001 | auth/authz | login ADMIN ด้วยรหัสผ่านถูกต้องได้ token | test_admin | ผ่าน |
| E2E-002 | auth/authz | login ADMIN: body มี token + user.role ตรงตามบทบาท | test_admin | ผ่าน |
| E2E-003 | auth/authz | login HEAD_APPROVER ด้วยรหัสผ่านถูกต้องได้ token | test_head | ผ่าน |
| E2E-004 | auth/authz | login HEAD_APPROVER: body มี token + user.role ตรงตามบทบาท | test_head | ผ่าน |
| E2E-005 | auth/authz | login CHECKER ด้วยรหัสผ่านถูกต้องได้ token | test_checker1 | ผ่าน |
| E2E-006 | auth/authz | login CHECKER: body มี token + user.role ตรงตามบทบาท | test_checker1 | ผ่าน |
| E2E-007 | auth/authz | login MAKER ด้วยรหัสผ่านถูกต้องได้ token | test_op1 | ผ่าน |
| E2E-008 | auth/authz | login MAKER: body มี token + user.role ตรงตามบทบาท | test_op1 | ผ่าน |
| E2E-009 | auth/authz | login VIEWER ด้วยรหัสผ่านถูกต้องได้ token | test_view1 | ผ่าน |
| E2E-010 | auth/authz | login VIEWER: body มี token + user.role ตรงตามบทบาท | test_view1 | ผ่าน |
| E2E-011 | auth/authz | login รหัสผ่านผิด → 401 Invalid credentials | test_admin / wrong | ผ่าน |
| E2E-012 | auth/authz | login ผู้ใช้ไม่มีจริง → 401 ข้อความเดียวกับรหัสผ่านผิด (กัน enumeration) | test_nonexistent | ผ่าน |
| E2E-013 | auth/authz | login ผู้ใช้ที่ถูกปิดใช้งาน → 401 | test_disabled | ผ่าน |
| E2E-014 | auth/authz | login ผู้ใช้ที่ soft-delete → 401 | test_deleted | ผ่าน |
| E2E-015 | auth/authz | login โดยไม่ส่ง username/password → 400 Validation failed |  | ผ่าน |
| E2E-016 | auth/authz | GET /api/auth/me พร้อม token → 200 |  | ผ่าน |
| E2E-017 | auth/authz | GET /api/auth/me คืนข้อมูลตรงกับผู้ใช้ | test_admin | ผ่าน |
| E2E-018 | auth/authz | token ที่เซ็นด้วย secret อื่น → 401 |  | ผ่าน |
| E2E-019 | auth/authz | ปลอม role=ADMIN ใน token → 401 (ไม่ได้สิทธิ์) |  | ผ่าน |
| E2E-020 | auth/authz | token หมดอายุ (ต่อ secret ถูก) → 401 |  | ผ่าน |
| E2E-021 | auth/authz | token alg=none ไม่มีลายเซ็น → 401 |  | ผ่าน |
| E2E-022 | auth/authz | เรียก API โดยไม่มี header → 401 Missing bearer token |  | ผ่าน |
| E2E-023 | auth/authz | tokenรูปแบบไม่ถูกต้อง → 401 |  | ผ่าน |
| E2E-024 | auth/authz | GET /health public → 200 |  | ผ่าน |
| E2E-025 | auth/authz | GET /api/auth/password-policy public → 200 |  | ผ่าน |
| E2E-026 | auth/authz | RBAC อ่าน customers list ด้วย ADMIN | GET /api/customers | ผ่าน |
| E2E-027 | auth/authz | RBAC อ่าน customers list ด้วย HEAD_APPROVER | GET /api/customers | ผ่าน |
| E2E-028 | auth/authz | RBAC อ่าน customers list ด้วย CHECKER | GET /api/customers | ผ่าน |
| E2E-029 | auth/authz | RBAC อ่าน customers list ด้วย MAKER | GET /api/customers | ผ่าน |
| E2E-030 | auth/authz | RBAC อ่าน customers list ด้วย VIEWER | GET /api/customers | ผ่าน |
| E2E-031 | auth/authz | RBAC อ่าน customers list ไม่ส่ง token → 401 | /api/customers | ผ่าน |
| E2E-032 | auth/authz | RBAC อ่าน loan products list ด้วย ADMIN | GET /api/loan-products | ผ่าน |
| E2E-033 | auth/authz | RBAC อ่าน loan products list ด้วย HEAD_APPROVER | GET /api/loan-products | ผ่าน |
| E2E-034 | auth/authz | RBAC อ่าน loan products list ด้วย CHECKER | GET /api/loan-products | ผ่าน |
| E2E-035 | auth/authz | RBAC อ่าน loan products list ด้วย MAKER | GET /api/loan-products | ผ่าน |
| E2E-036 | auth/authz | RBAC อ่าน loan products list ด้วย VIEWER | GET /api/loan-products | ผ่าน |
| E2E-037 | auth/authz | RBAC อ่าน loan products list ไม่ส่ง token → 401 | /api/loan-products | ผ่าน |
| E2E-038 | auth/authz | RBAC อ่าน loans list ด้วย ADMIN | GET /api/loans | ผ่าน |
| E2E-039 | auth/authz | RBAC อ่าน loans list ด้วย HEAD_APPROVER | GET /api/loans | ผ่าน |
| E2E-040 | auth/authz | RBAC อ่าน loans list ด้วย CHECKER | GET /api/loans | ผ่าน |
| E2E-041 | auth/authz | RBAC อ่าน loans list ด้วย MAKER | GET /api/loans | ผ่าน |
| E2E-042 | auth/authz | RBAC อ่าน loans list ด้วย VIEWER | GET /api/loans | ผ่าน |
| E2E-043 | auth/authz | RBAC อ่าน loans list ไม่ส่ง token → 401 | /api/loans | ผ่าน |
| E2E-044 | auth/authz | RBAC อ่าน loan detail ด้วย ADMIN | GET /api/loans/00000000-7000-4000-8000-000000000001 | ผ่าน |
| E2E-045 | auth/authz | RBAC อ่าน loan detail ด้วย HEAD_APPROVER | GET /api/loans/00000000-7000-4000-8000-000000000001 | ผ่าน |
| E2E-046 | auth/authz | RBAC อ่าน loan detail ด้วย CHECKER | GET /api/loans/00000000-7000-4000-8000-000000000001 | ผ่าน |
| E2E-047 | auth/authz | RBAC อ่าน loan detail ด้วย MAKER | GET /api/loans/00000000-7000-4000-8000-000000000001 | ผ่าน |
| E2E-048 | auth/authz | RBAC อ่าน loan detail ด้วย VIEWER | GET /api/loans/00000000-7000-4000-8000-000000000001 | ผ่าน |
| E2E-049 | auth/authz | RBAC อ่าน loan detail ไม่ส่ง token → 401 | /api/loans/00000000-7000-4000-8000-000000000001 | ผ่าน |
| E2E-050 | auth/authz | RBAC อ่าน loan schedule ด้วย ADMIN | GET /api/loans/00000000-7000-4000-8000-000000000001/schedule | ผ่าน |
| E2E-051 | auth/authz | RBAC อ่าน loan schedule ด้วย HEAD_APPROVER | GET /api/loans/00000000-7000-4000-8000-000000000001/schedule | ผ่าน |
| E2E-052 | auth/authz | RBAC อ่าน loan schedule ด้วย CHECKER | GET /api/loans/00000000-7000-4000-8000-000000000001/schedule | ผ่าน |
| E2E-053 | auth/authz | RBAC อ่าน loan schedule ด้วย MAKER | GET /api/loans/00000000-7000-4000-8000-000000000001/schedule | ผ่าน |
| E2E-054 | auth/authz | RBAC อ่าน loan schedule ด้วย VIEWER | GET /api/loans/00000000-7000-4000-8000-000000000001/schedule | ผ่าน |
| E2E-055 | auth/authz | RBAC อ่าน loan schedule ไม่ส่ง token → 401 | /api/loans/00000000-7000-4000-8000-000000000001/schedule | ผ่าน |
| E2E-056 | auth/authz | RBAC อ่าน allocation preview ด้วย ADMIN | GET /api/loans/00000000-7000-4000-8000-000000000001/allocation-preview?amount=100000 | ผ่าน |
| E2E-057 | auth/authz | RBAC อ่าน allocation preview ด้วย HEAD_APPROVER | GET /api/loans/00000000-7000-4000-8000-000000000001/allocation-preview?amount=100000 | ผ่าน |
| E2E-058 | auth/authz | RBAC อ่าน allocation preview ด้วย CHECKER | GET /api/loans/00000000-7000-4000-8000-000000000001/allocation-preview?amount=100000 | ผ่าน |
| E2E-059 | auth/authz | RBAC อ่าน allocation preview ด้วย MAKER | GET /api/loans/00000000-7000-4000-8000-000000000001/allocation-preview?amount=100000 | ผ่าน |
| E2E-060 | auth/authz | RBAC อ่าน allocation preview ด้วย VIEWER | GET /api/loans/00000000-7000-4000-8000-000000000001/allocation-preview?amount=100000 | ผ่าน |
| E2E-061 | auth/authz | RBAC อ่าน allocation preview ไม่ส่ง token → 401 | /api/loans/00000000-7000-4000-8000-000000000001/allocation-preview?amount=100000 | ผ่าน |
| E2E-062 | auth/authz | RBAC อ่าน KYC documents ด้วย ADMIN | GET /api/customers/00000000-2000-4000-8000-000000000001/kyc/documents | ผ่าน |
| E2E-063 | auth/authz | RBAC อ่าน KYC documents ด้วย HEAD_APPROVER | GET /api/customers/00000000-2000-4000-8000-000000000001/kyc/documents | ผ่าน |
| E2E-064 | auth/authz | RBAC อ่าน KYC documents ด้วย CHECKER | GET /api/customers/00000000-2000-4000-8000-000000000001/kyc/documents | ผ่าน |
| E2E-065 | auth/authz | RBAC อ่าน KYC documents ด้วย MAKER | GET /api/customers/00000000-2000-4000-8000-000000000001/kyc/documents | ผ่าน |
| E2E-066 | auth/authz | RBAC อ่าน KYC documents ด้วย VIEWER | GET /api/customers/00000000-2000-4000-8000-000000000001/kyc/documents | ผ่าน |
| E2E-067 | auth/authz | RBAC อ่าน KYC documents ไม่ส่ง token → 401 | /api/customers/00000000-2000-4000-8000-000000000001/kyc/documents | ผ่าน |
| E2E-068 | auth/authz | RBAC อ่าน payment requests ด้วย ADMIN | GET /api/payment-requests | ผ่าน |
| E2E-069 | auth/authz | RBAC อ่าน payment requests ด้วย HEAD_APPROVER | GET /api/payment-requests | ผ่าน |
| E2E-070 | auth/authz | RBAC อ่าน payment requests ด้วย CHECKER | GET /api/payment-requests | ผ่าน |
| E2E-071 | auth/authz | RBAC อ่าน payment requests ด้วย MAKER | GET /api/payment-requests | ผ่าน |
| E2E-072 | auth/authz | RBAC อ่าน payment requests ด้วย VIEWER | GET /api/payment-requests | ผ่าน |
| E2E-073 | auth/authz | RBAC อ่าน payment requests ไม่ส่ง token → 401 | /api/payment-requests | ผ่าน |
| E2E-074 | auth/authz | RBAC อ่าน payment pending count ด้วย ADMIN | GET /api/payment-requests/pending-count | ผ่าน |
| E2E-075 | auth/authz | RBAC อ่าน payment pending count ด้วย HEAD_APPROVER | GET /api/payment-requests/pending-count | ผ่าน |
| E2E-076 | auth/authz | RBAC อ่าน payment pending count ด้วย CHECKER | GET /api/payment-requests/pending-count | ผ่าน |
| E2E-077 | auth/authz | RBAC อ่าน payment pending count ด้วย MAKER | GET /api/payment-requests/pending-count | ผ่าน |
| E2E-078 | auth/authz | RBAC อ่าน payment pending count ด้วย VIEWER | GET /api/payment-requests/pending-count | ผ่าน |
| E2E-079 | auth/authz | RBAC อ่าน payment pending count ไม่ส่ง token → 401 | /api/payment-requests/pending-count | ผ่าน |
| E2E-080 | auth/authz | RBAC อ่าน transactions ด้วย ADMIN | GET /api/transactions | ผ่าน |
| E2E-081 | auth/authz | RBAC อ่าน transactions ด้วย HEAD_APPROVER | GET /api/transactions | ผ่าน |
| E2E-082 | auth/authz | RBAC อ่าน transactions ด้วย CHECKER | GET /api/transactions | ผ่าน |
| E2E-083 | auth/authz | RBAC อ่าน transactions ด้วย MAKER | GET /api/transactions | ผ่าน |
| E2E-084 | auth/authz | RBAC อ่าน transactions ด้วย VIEWER | GET /api/transactions | ผ่าน |
| E2E-085 | auth/authz | RBAC อ่าน transactions ไม่ส่ง token → 401 | /api/transactions | ผ่าน |
| E2E-086 | auth/authz | RBAC อ่าน settlements ด้วย ADMIN | GET /api/settlements | ผ่าน |
| E2E-087 | auth/authz | RBAC อ่าน settlements ด้วย HEAD_APPROVER | GET /api/settlements | ผ่าน |
| E2E-088 | auth/authz | RBAC อ่าน settlements ด้วย CHECKER | GET /api/settlements | ผ่าน |
| E2E-089 | auth/authz | RBAC อ่าน settlements ด้วย MAKER | GET /api/settlements | ผ่าน |
| E2E-090 | auth/authz | RBAC อ่าน settlements ด้วย VIEWER | GET /api/settlements | ผ่าน |
| E2E-091 | auth/authz | RBAC อ่าน settlements ไม่ส่ง token → 401 | /api/settlements | ผ่าน |
| E2E-092 | auth/authz | RBAC อ่าน customer credits ด้วย ADMIN | GET /api/credits | ผ่าน |
| E2E-093 | auth/authz | RBAC อ่าน customer credits ด้วย HEAD_APPROVER | GET /api/credits | ผ่าน |
| E2E-094 | auth/authz | RBAC อ่าน customer credits ด้วย CHECKER | GET /api/credits | ผ่าน |
| E2E-095 | auth/authz | RBAC อ่าน customer credits ด้วย MAKER | GET /api/credits | ผ่าน |
| E2E-096 | auth/authz | RBAC อ่าน customer credits ด้วย VIEWER | GET /api/credits | ผ่าน |
| E2E-097 | auth/authz | RBAC อ่าน customer credits ไม่ส่ง token → 401 | /api/credits | ผ่าน |
| E2E-098 | auth/authz | RBAC อ่าน credit ledger ด้วย ADMIN | GET /api/credits/ledger?customerId=00000000-2000-4000-8000-000000000001 | ผ่าน |
| E2E-099 | auth/authz | RBAC อ่าน credit ledger ด้วย HEAD_APPROVER | GET /api/credits/ledger?customerId=00000000-2000-4000-8000-000000000001 | ผ่าน |
| E2E-100 | auth/authz | RBAC อ่าน credit ledger ด้วย CHECKER | GET /api/credits/ledger?customerId=00000000-2000-4000-8000-000000000001 | ผ่าน |
| E2E-101 | auth/authz | RBAC อ่าน credit ledger ด้วย MAKER | GET /api/credits/ledger?customerId=00000000-2000-4000-8000-000000000001 | ผ่าน |
| E2E-102 | auth/authz | RBAC อ่าน credit ledger ด้วย VIEWER | GET /api/credits/ledger?customerId=00000000-2000-4000-8000-000000000001 | ผ่าน |
| E2E-103 | auth/authz | RBAC อ่าน credit ledger ไม่ส่ง token → 401 | /api/credits/ledger?customerId=00000000-2000-4000-8000-000000000001 | ผ่าน |
| E2E-104 | auth/authz | RBAC อ่าน reconciliation records ด้วย ADMIN | GET /api/reconciliation/records | ผ่าน |
| E2E-105 | auth/authz | RBAC อ่าน reconciliation records ด้วย HEAD_APPROVER | GET /api/reconciliation/records | ผ่าน |
| E2E-106 | auth/authz | RBAC อ่าน reconciliation records ด้วย CHECKER | GET /api/reconciliation/records | ผ่าน |
| E2E-107 | auth/authz | RBAC อ่าน reconciliation records ด้วย MAKER | GET /api/reconciliation/records | ผ่าน |
| E2E-108 | auth/authz | RBAC อ่าน reconciliation records ด้วย VIEWER | GET /api/reconciliation/records | ผ่าน |
| E2E-109 | auth/authz | RBAC อ่าน reconciliation records ไม่ส่ง token → 401 | /api/reconciliation/records | ผ่าน |
| E2E-110 | auth/authz | RBAC อ่าน audit log ด้วย ADMIN | GET /api/audit | ผ่าน |
| E2E-111 | auth/authz | RBAC อ่าน audit log ด้วย HEAD_APPROVER | GET /api/audit | ผ่าน |
| E2E-112 | auth/authz | RBAC อ่าน audit log ด้วย CHECKER | GET /api/audit | ผ่าน |
| E2E-113 | auth/authz | RBAC อ่าน audit log ด้วย MAKER | GET /api/audit | ผ่าน |
| E2E-114 | auth/authz | RBAC อ่าน audit log ด้วย VIEWER | GET /api/audit | ผ่าน |
| E2E-115 | auth/authz | RBAC อ่าน audit log ไม่ส่ง token → 401 | /api/audit | ผ่าน |
| E2E-116 | auth/authz | RBAC อ่าน dashboard stats ด้วย ADMIN | GET /api/dashboard/stats | ผ่าน |
| E2E-117 | auth/authz | RBAC อ่าน dashboard stats ด้วย HEAD_APPROVER | GET /api/dashboard/stats | ผ่าน |
| E2E-118 | auth/authz | RBAC อ่าน dashboard stats ด้วย CHECKER | GET /api/dashboard/stats | ผ่าน |
| E2E-119 | auth/authz | RBAC อ่าน dashboard stats ด้วย MAKER | GET /api/dashboard/stats | ผ่าน |
| E2E-120 | auth/authz | RBAC อ่าน dashboard stats ด้วย VIEWER | GET /api/dashboard/stats | ผ่าน |
| E2E-121 | auth/authz | RBAC อ่าน dashboard stats ไม่ส่ง token → 401 | /api/dashboard/stats | ผ่าน |
| E2E-122 | auth/authz | RBAC อ่าน dashboard activity ด้วย ADMIN | GET /api/dashboard/recent-activity | ผ่าน |
| E2E-123 | auth/authz | RBAC อ่าน dashboard activity ด้วย HEAD_APPROVER | GET /api/dashboard/recent-activity | ผ่าน |
| E2E-124 | auth/authz | RBAC อ่าน dashboard activity ด้วย CHECKER | GET /api/dashboard/recent-activity | ผ่าน |
| E2E-125 | auth/authz | RBAC อ่าน dashboard activity ด้วย MAKER | GET /api/dashboard/recent-activity | ผ่าน |
| E2E-126 | auth/authz | RBAC อ่าน dashboard activity ด้วย VIEWER | GET /api/dashboard/recent-activity | ผ่าน |
| E2E-127 | auth/authz | RBAC อ่าน dashboard activity ไม่ส่ง token → 401 | /api/dashboard/recent-activity | ผ่าน |
| E2E-128 | auth/authz | RBAC อ่าน notification summary ด้วย ADMIN | GET /api/notifications/summary | ผ่าน |
| E2E-129 | auth/authz | RBAC อ่าน notification summary ด้วย HEAD_APPROVER | GET /api/notifications/summary | ผ่าน |
| E2E-130 | auth/authz | RBAC อ่าน notification summary ด้วย CHECKER | GET /api/notifications/summary | ผ่าน |
| E2E-131 | auth/authz | RBAC อ่าน notification summary ด้วย MAKER | GET /api/notifications/summary | ผ่าน |
| E2E-132 | auth/authz | RBAC อ่าน notification summary ด้วย VIEWER | GET /api/notifications/summary | ผ่าน |
| E2E-133 | auth/authz | RBAC อ่าน notification summary ไม่ส่ง token → 401 | /api/notifications/summary | ผ่าน |
| E2E-134 | auth/authz | RBAC อ่าน thresholds config ด้วย ADMIN | GET /api/config/thresholds | ผ่าน |
| E2E-135 | auth/authz | RBAC อ่าน thresholds config ด้วย HEAD_APPROVER | GET /api/config/thresholds | ผ่าน |
| E2E-136 | auth/authz | RBAC อ่าน thresholds config ด้วย CHECKER | GET /api/config/thresholds | ผ่าน |
| E2E-137 | auth/authz | RBAC อ่าน thresholds config ด้วย MAKER | GET /api/config/thresholds | ผ่าน |
| E2E-138 | auth/authz | RBAC อ่าน thresholds config ด้วย VIEWER | GET /api/config/thresholds | ผ่าน |
| E2E-139 | auth/authz | RBAC อ่าน thresholds config ไม่ส่ง token → 401 | /api/config/thresholds | ผ่าน |
| E2E-140 | auth/authz | RBAC อ่าน kyc config ด้วย ADMIN | GET /api/config/kyc | ผ่าน |
| E2E-141 | auth/authz | RBAC อ่าน kyc config ด้วย HEAD_APPROVER | GET /api/config/kyc | ผ่าน |
| E2E-142 | auth/authz | RBAC อ่าน kyc config ด้วย CHECKER | GET /api/config/kyc | ผ่าน |
| E2E-143 | auth/authz | RBAC อ่าน kyc config ด้วย MAKER | GET /api/config/kyc | ผ่าน |
| E2E-144 | auth/authz | RBAC อ่าน kyc config ด้วย VIEWER | GET /api/config/kyc | ผ่าน |
| E2E-145 | auth/authz | RBAC อ่าน kyc config ไม่ส่ง token → 401 | /api/config/kyc | ผ่าน |
| E2E-146 | auth/authz | RBAC อ่าน password config ด้วย ADMIN | GET /api/config/password | ผ่าน |
| E2E-147 | auth/authz | RBAC อ่าน password config ด้วย HEAD_APPROVER | GET /api/config/password | ผ่าน |
| E2E-148 | auth/authz | RBAC อ่าน password config ด้วย CHECKER | GET /api/config/password | ผ่าน |
| E2E-149 | auth/authz | RBAC อ่าน password config ด้วย MAKER | GET /api/config/password | ผ่าน |
| E2E-150 | auth/authz | RBAC อ่าน password config ด้วย VIEWER | GET /api/config/password | ผ่าน |
| E2E-151 | auth/authz | RBAC อ่าน password config ไม่ส่ง token → 401 | /api/config/password | ผ่าน |
| E2E-152 | auth/authz | RBAC อ่าน avatar config ด้วย ADMIN | GET /api/config/avatar | ผ่าน |
| E2E-153 | auth/authz | RBAC อ่าน avatar config ด้วย HEAD_APPROVER | GET /api/config/avatar | ผ่าน |
| E2E-154 | auth/authz | RBAC อ่าน avatar config ด้วย CHECKER | GET /api/config/avatar | ผ่าน |
| E2E-155 | auth/authz | RBAC อ่าน avatar config ด้วย MAKER | GET /api/config/avatar | ผ่าน |
| E2E-156 | auth/authz | RBAC อ่าน avatar config ด้วย VIEWER | GET /api/config/avatar | ผ่าน |
| E2E-157 | auth/authz | RBAC อ่าน avatar config ไม่ส่ง token → 401 | /api/config/avatar | ผ่าน |
| E2E-158 | auth/authz | RBAC อ่าน approval workflow detail ด้วย ADMIN | GET /api/approvals/workflows/00000000-8000-4000-8000-000000000007 | ผ่าน |
| E2E-159 | auth/authz | RBAC อ่าน approval workflow detail ด้วย HEAD_APPROVER | GET /api/approvals/workflows/00000000-8000-4000-8000-000000000007 | ผ่าน |
| E2E-160 | auth/authz | RBAC อ่าน approval workflow detail ด้วย CHECKER | GET /api/approvals/workflows/00000000-8000-4000-8000-000000000007 | ผ่าน |
| E2E-161 | auth/authz | RBAC อ่าน approval workflow detail ด้วย MAKER | GET /api/approvals/workflows/00000000-8000-4000-8000-000000000007 | ผ่าน |
| E2E-162 | auth/authz | RBAC อ่าน approval workflow detail ด้วย VIEWER | GET /api/approvals/workflows/00000000-8000-4000-8000-000000000007 | ผ่าน |
| E2E-163 | auth/authz | RBAC อ่าน approval workflow detail ไม่ส่ง token → 401 | /api/approvals/workflows/00000000-8000-4000-8000-000000000007 | ผ่าน |
| E2E-164 | auth/authz | RBAC users list → 200 เฉพาะ ADMIN | /api/users | ผ่าน |
| E2E-165 | auth/authz | RBAC users list → 403 | /api/users | ผ่าน |
| E2E-166 | auth/authz | RBAC users list → 403 | /api/users | ผ่าน |
| E2E-167 | auth/authz | RBAC users list → 403 | /api/users | ผ่าน |
| E2E-168 | auth/authz | RBAC users list → 403 | /api/users | ผ่าน |
| E2E-169 | auth/authz | RBAC notification outbox → 200 เฉพาะ ADMIN | /api/notifications | ผ่าน |
| E2E-170 | auth/authz | RBAC notification outbox → 403 | /api/notifications | ผ่าน |
| E2E-171 | auth/authz | RBAC notification outbox → 403 | /api/notifications | ผ่าน |
| E2E-172 | auth/authz | RBAC notification outbox → 403 | /api/notifications | ผ่าน |
| E2E-173 | auth/authz | RBAC notification outbox → 403 | /api/notifications | ผ่าน |
| E2E-174 | auth/authz | RBAC email templates → 200 เฉพาะ ADMIN | /api/notifications/templates | ผ่าน |
| E2E-175 | auth/authz | RBAC email templates → 403 | /api/notifications/templates | ผ่าน |
| E2E-176 | auth/authz | RBAC email templates → 403 | /api/notifications/templates | ผ่าน |
| E2E-177 | auth/authz | RBAC email templates → 403 | /api/notifications/templates | ผ่าน |
| E2E-178 | auth/authz | RBAC email templates → 403 | /api/notifications/templates | ผ่าน |
| E2E-179 | auth/authz | RBAC monthly report → ADMIN | /api/reports/monthly?months=6 | ผ่าน |
| E2E-180 | auth/authz | RBAC monthly report → HEAD_APPROVER | /api/reports/monthly?months=6 | ผ่าน |
| E2E-181 | auth/authz | RBAC monthly report → CHECKER | /api/reports/monthly?months=6 | ผ่าน |
| E2E-182 | auth/authz | RBAC monthly report → MAKER | /api/reports/monthly?months=6 | ผ่าน |
| E2E-183 | auth/authz | RBAC monthly report → VIEWER | /api/reports/monthly?months=6 | ผ่าน |
| E2E-184 | auth/authz | RBAC approval queue → ADMIN | /api/approvals/pending | ผ่าน |
| E2E-185 | auth/authz | RBAC approval queue → HEAD_APPROVER | /api/approvals/pending | ผ่าน |
| E2E-186 | auth/authz | RBAC approval queue → CHECKER | /api/approvals/pending | ผ่าน |
| E2E-187 | auth/authz | RBAC approval queue → MAKER | /api/approvals/pending | ผ่าน |
| E2E-188 | auth/authz | RBAC approval queue → VIEWER | /api/approvals/pending | ผ่าน |
| E2E-189 | auth/authz | RBAC เขียน create customer → ADMIN | POST /api/customers body {} | ผ่าน |
| E2E-190 | auth/authz | RBAC เขียน create customer → HEAD_APPROVER | POST /api/customers body {} | ผ่าน |
| E2E-191 | auth/authz | RBAC เขียน create customer → CHECKER | POST /api/customers body {} | ผ่าน |
| E2E-192 | auth/authz | RBAC เขียน create customer → MAKER | POST /api/customers body {} | ผ่าน |
| E2E-193 | auth/authz | RBAC เขียน create customer → VIEWER | POST /api/customers body {} | ผ่าน |
| E2E-194 | auth/authz | RBAC เขียน create product → ADMIN | POST /api/loan-products body {} | ผ่าน |
| E2E-195 | auth/authz | RBAC เขียน create product → HEAD_APPROVER | POST /api/loan-products body {} | ผ่าน |
| E2E-196 | auth/authz | RBAC เขียน create product → CHECKER | POST /api/loan-products body {} | ผ่าน |
| E2E-197 | auth/authz | RBAC เขียน create product → MAKER | POST /api/loan-products body {} | ผ่าน |
| E2E-198 | auth/authz | RBAC เขียน create product → VIEWER | POST /api/loan-products body {} | ผ่าน |
| E2E-199 | auth/authz | RBAC เขียน patch product → ADMIN | PATCH /api/loan-products/00000000-0000-4000-8000-000000000001 body {"interestRatePeriod":"FORTNIGHT"} | ผ่าน |
| E2E-200 | auth/authz | RBAC เขียน patch product → HEAD_APPROVER | PATCH /api/loan-products/00000000-0000-4000-8000-000000000001 body {"interestRatePeriod":"FORTNIGHT"} | ผ่าน |
| E2E-201 | auth/authz | RBAC เขียน patch product → CHECKER | PATCH /api/loan-products/00000000-0000-4000-8000-000000000001 body {"interestRatePeriod":"FORTNIGHT"} | ผ่าน |
| E2E-202 | auth/authz | RBAC เขียน patch product → MAKER | PATCH /api/loan-products/00000000-0000-4000-8000-000000000001 body {"interestRatePeriod":"FORTNIGHT"} | ผ่าน |
| E2E-203 | auth/authz | RBAC เขียน patch product → VIEWER | PATCH /api/loan-products/00000000-0000-4000-8000-000000000001 body {"interestRatePeriod":"FORTNIGHT"} | ผ่าน |
| E2E-204 | auth/authz | RBAC เขียน create loan + disburse → ADMIN | POST /api/loans body {} | ผ่าน |
| E2E-205 | auth/authz | RBAC เขียน create loan + disburse → HEAD_APPROVER | POST /api/loans body {} | ผ่าน |
| E2E-206 | auth/authz | RBAC เขียน create loan + disburse → CHECKER | POST /api/loans body {} | ผ่าน |
| E2E-207 | auth/authz | RBAC เขียน create loan + disburse → MAKER | POST /api/loans body {} | ผ่าน |
| E2E-208 | auth/authz | RBAC เขียน create loan + disburse → VIEWER | POST /api/loans body {} | ผ่าน |
| E2E-209 | auth/authz | RBAC เขียน create payment request → ADMIN | POST /api/payment-requests body {} | ผ่าน |
| E2E-210 | auth/authz | RBAC เขียน create payment request → HEAD_APPROVER | POST /api/payment-requests body {} | ผ่าน |
| E2E-211 | auth/authz | RBAC เขียน create payment request → CHECKER | POST /api/payment-requests body {} | ผ่าน |
| E2E-212 | auth/authz | RBAC เขียน create payment request → MAKER | POST /api/payment-requests body {} | ผ่าน |
| E2E-213 | auth/authz | RBAC เขียน create payment request → VIEWER | POST /api/payment-requests body {} | ผ่าน |
| E2E-214 | auth/authz | RBAC เขียน approve payment request → ADMIN | POST /api/payment-requests/00000000-5000-4000-8000-000000000001/approve body {} | ผ่าน |
| E2E-215 | auth/authz | RBAC เขียน approve payment request → HEAD_APPROVER | POST /api/payment-requests/00000000-5000-4000-8000-000000000001/approve body {} | ผ่าน |
| E2E-216 | auth/authz | RBAC เขียน approve payment request → CHECKER | POST /api/payment-requests/00000000-5000-4000-8000-000000000001/approve body {} | ผ่าน |
| E2E-217 | auth/authz | RBAC เขียน approve payment request → MAKER | POST /api/payment-requests/00000000-5000-4000-8000-000000000001/approve body {} | ผ่าน |
| E2E-218 | auth/authz | RBAC เขียน approve payment request → VIEWER | POST /api/payment-requests/00000000-5000-4000-8000-000000000001/approve body {} | ผ่าน |
| E2E-219 | auth/authz | RBAC เขียน accrue penalty → ADMIN | POST /api/transactions/penalties body {} | ผ่าน |
| E2E-220 | auth/authz | RBAC เขียน accrue penalty → HEAD_APPROVER | POST /api/transactions/penalties body {} | ผ่าน |
| E2E-221 | auth/authz | RBAC เขียน accrue penalty → CHECKER | POST /api/transactions/penalties body {} | ผ่าน |
| E2E-222 | auth/authz | RBAC เขียน accrue penalty → MAKER | POST /api/transactions/penalties body {} | ผ่าน |
| E2E-223 | auth/authz | RBAC เขียน accrue penalty → VIEWER | POST /api/transactions/penalties body {} | ผ่าน |
| E2E-224 | auth/authz | RBAC เขียน waive → ADMIN | POST /api/transactions/waivers body {} | ผ่าน |
| E2E-225 | auth/authz | RBAC เขียน waive → HEAD_APPROVER | POST /api/transactions/waivers body {} | ผ่าน |
| E2E-226 | auth/authz | RBAC เขียน waive → CHECKER | POST /api/transactions/waivers body {} | ผ่าน |
| E2E-227 | auth/authz | RBAC เขียน waive → MAKER | POST /api/transactions/waivers body {} | ผ่าน |
| E2E-228 | auth/authz | RBAC เขียน waive → VIEWER | POST /api/transactions/waivers body {} | ผ่าน |
| E2E-229 | auth/authz | RBAC เขียน write off → ADMIN | POST /api/transactions/write-offs body {} | ผ่าน |
| E2E-230 | auth/authz | RBAC เขียน write off → HEAD_APPROVER | POST /api/transactions/write-offs body {} | ผ่าน |
| E2E-231 | auth/authz | RBAC เขียน write off → CHECKER | POST /api/transactions/write-offs body {} | ผ่าน |
| E2E-232 | auth/authz | RBAC เขียน write off → MAKER | POST /api/transactions/write-offs body {} | ผ่าน |
| E2E-233 | auth/authz | RBAC เขียน write off → VIEWER | POST /api/transactions/write-offs body {} | ผ่าน |
| E2E-234 | auth/authz | RBAC เขียน adjust → ADMIN | POST /api/transactions/adjustments body {} | ผ่าน |
| E2E-235 | auth/authz | RBAC เขียน adjust → HEAD_APPROVER | POST /api/transactions/adjustments body {} | ผ่าน |
| E2E-236 | auth/authz | RBAC เขียน adjust → CHECKER | POST /api/transactions/adjustments body {} | ผ่าน |
| E2E-237 | auth/authz | RBAC เขียน adjust → MAKER | POST /api/transactions/adjustments body {} | ผ่าน |
| E2E-238 | auth/authz | RBAC เขียน adjust → VIEWER | POST /api/transactions/adjustments body {} | ผ่าน |
| E2E-239 | auth/authz | RBAC เขียน payment reversal → ADMIN | POST /api/transactions/reversals body {} | ผ่าน |
| E2E-240 | auth/authz | RBAC เขียน payment reversal → HEAD_APPROVER | POST /api/transactions/reversals body {} | ผ่าน |
| E2E-241 | auth/authz | RBAC เขียน payment reversal → CHECKER | POST /api/transactions/reversals body {} | ผ่าน |
| E2E-242 | auth/authz | RBAC เขียน payment reversal → MAKER | POST /api/transactions/reversals body {} | ผ่าน |
| E2E-243 | auth/authz | RBAC เขียน payment reversal → VIEWER | POST /api/transactions/reversals body {} | ผ่าน |
| E2E-244 | auth/authz | RBAC เขียน write-off reversal → ADMIN | POST /api/transactions/write-off-reversals body {} | ผ่าน |
| E2E-245 | auth/authz | RBAC เขียน write-off reversal → HEAD_APPROVER | POST /api/transactions/write-off-reversals body {} | ผ่าน |
| E2E-246 | auth/authz | RBAC เขียน write-off reversal → CHECKER | POST /api/transactions/write-off-reversals body {} | ผ่าน |
| E2E-247 | auth/authz | RBAC เขียน write-off reversal → MAKER | POST /api/transactions/write-off-reversals body {} | ผ่าน |
| E2E-248 | auth/authz | RBAC เขียน write-off reversal → VIEWER | POST /api/transactions/write-off-reversals body {} | ผ่าน |
| E2E-249 | auth/authz | RBAC เขียน settlement agreement → ADMIN | POST /api/settlements body {} | ผ่าน |
| E2E-250 | auth/authz | RBAC เขียน settlement agreement → HEAD_APPROVER | POST /api/settlements body {} | ผ่าน |
| E2E-251 | auth/authz | RBAC เขียน settlement agreement → CHECKER | POST /api/settlements body {} | ผ่าน |
| E2E-252 | auth/authz | RBAC เขียน settlement agreement → MAKER | POST /api/settlements body {} | ผ่าน |
| E2E-253 | auth/authz | RBAC เขียน settlement agreement → VIEWER | POST /api/settlements body {} | ผ่าน |
| E2E-254 | auth/authz | RBAC เขียน create user → ADMIN | POST /api/users body {} | ผ่าน |
| E2E-255 | auth/authz | RBAC เขียน create user → HEAD_APPROVER | POST /api/users body {} | ผ่าน |
| E2E-256 | auth/authz | RBAC เขียน create user → CHECKER | POST /api/users body {} | ผ่าน |
| E2E-257 | auth/authz | RBAC เขียน create user → MAKER | POST /api/users body {} | ผ่าน |
| E2E-258 | auth/authz | RBAC เขียน create user → VIEWER | POST /api/users body {} | ผ่าน |
| E2E-259 | auth/authz | RBAC เขียน set thresholds → ADMIN | PUT /api/config/thresholds body {} | ผ่าน |
| E2E-260 | auth/authz | RBAC เขียน set thresholds → HEAD_APPROVER | PUT /api/config/thresholds body {} | ผ่าน |
| E2E-261 | auth/authz | RBAC เขียน set thresholds → CHECKER | PUT /api/config/thresholds body {} | ผ่าน |
| E2E-262 | auth/authz | RBAC เขียน set thresholds → MAKER | PUT /api/config/thresholds body {} | ผ่าน |
| E2E-263 | auth/authz | RBAC เขียน set thresholds → VIEWER | PUT /api/config/thresholds body {} | ผ่าน |
| E2E-264 | auth/authz | RBAC เขียน set kyc policy → ADMIN | PUT /api/config/kyc body {} | ผ่าน |
| E2E-265 | auth/authz | RBAC เขียน set kyc policy → HEAD_APPROVER | PUT /api/config/kyc body {} | ผ่าน |
| E2E-266 | auth/authz | RBAC เขียน set kyc policy → CHECKER | PUT /api/config/kyc body {} | ผ่าน |
| E2E-267 | auth/authz | RBAC เขียน set kyc policy → MAKER | PUT /api/config/kyc body {} | ผ่าน |
| E2E-268 | auth/authz | RBAC เขียน set kyc policy → VIEWER | PUT /api/config/kyc body {} | ผ่าน |
| E2E-269 | auth/authz | RBAC เขียน set password policy → ADMIN | PUT /api/config/password body {} | ผ่าน |
| E2E-270 | auth/authz | RBAC เขียน set password policy → HEAD_APPROVER | PUT /api/config/password body {} | ผ่าน |
| E2E-271 | auth/authz | RBAC เขียน set password policy → CHECKER | PUT /api/config/password body {} | ผ่าน |
| E2E-272 | auth/authz | RBAC เขียน set password policy → MAKER | PUT /api/config/password body {} | ผ่าน |
| E2E-273 | auth/authz | RBAC เขียน set password policy → VIEWER | PUT /api/config/password body {} | ผ่าน |
| E2E-274 | auth/authz | RBAC เขียน set avatar policy → ADMIN | PUT /api/config/avatar body {} | ผ่าน |
| E2E-275 | auth/authz | RBAC เขียน set avatar policy → HEAD_APPROVER | PUT /api/config/avatar body {} | ผ่าน |
| E2E-276 | auth/authz | RBAC เขียน set avatar policy → CHECKER | PUT /api/config/avatar body {} | ผ่าน |
| E2E-277 | auth/authz | RBAC เขียน set avatar policy → MAKER | PUT /api/config/avatar body {} | ผ่าน |
| E2E-278 | auth/authz | RBAC เขียน set avatar policy → VIEWER | PUT /api/config/avatar body {} | ผ่าน |
| E2E-279 | auth/authz | RBAC เขียน restore user → ADMIN | POST /api/users/00000000-9000-4000-8000-000000000001/restore body {} | ผ่าน |
| E2E-280 | auth/authz | RBAC เขียน restore user → HEAD_APPROVER | POST /api/users/00000000-9000-4000-8000-000000000001/restore body {} | ผ่าน |
| E2E-281 | auth/authz | RBAC เขียน restore user → CHECKER | POST /api/users/00000000-9000-4000-8000-000000000001/restore body {} | ผ่าน |
| E2E-282 | auth/authz | RBAC เขียน restore user → MAKER | POST /api/users/00000000-9000-4000-8000-000000000001/restore body {} | ผ่าน |
| E2E-283 | auth/authz | RBAC เขียน restore user → VIEWER | POST /api/users/00000000-9000-4000-8000-000000000001/restore body {} | ผ่าน |
| E2E-284 | auth/authz | RBAC เขียน send reset link → ADMIN | POST /api/users/00000000-9000-4000-8000-000000000001/send-reset-link body {} | ผ่าน |
| E2E-285 | auth/authz | RBAC เขียน send reset link → HEAD_APPROVER | POST /api/users/00000000-9000-4000-8000-000000000001/send-reset-link body {} | ผ่าน |
| E2E-286 | auth/authz | RBAC เขียน send reset link → CHECKER | POST /api/users/00000000-9000-4000-8000-000000000001/send-reset-link body {} | ผ่าน |
| E2E-287 | auth/authz | RBAC เขียน send reset link → MAKER | POST /api/users/00000000-9000-4000-8000-000000000001/send-reset-link body {} | ผ่าน |
| E2E-288 | auth/authz | RBAC เขียน send reset link → VIEWER | POST /api/users/00000000-9000-4000-8000-000000000001/send-reset-link body {} | ผ่าน |
| E2E-289 | auth/authz | RBAC เขียน bulk reset links → ADMIN | POST /api/users/send-reset-links body {} | ผ่าน |
| E2E-290 | auth/authz | RBAC เขียน bulk reset links → HEAD_APPROVER | POST /api/users/send-reset-links body {} | ผ่าน |
| E2E-291 | auth/authz | RBAC เขียน bulk reset links → CHECKER | POST /api/users/send-reset-links body {} | ผ่าน |
| E2E-292 | auth/authz | RBAC เขียน bulk reset links → MAKER | POST /api/users/send-reset-links body {} | ผ่าน |
| E2E-293 | auth/authz | RBAC เขียน bulk reset links → VIEWER | POST /api/users/send-reset-links body {} | ผ่าน |
| E2E-294 | auth/authz | RBAC เขียน patch user → ADMIN | PATCH /api/users/00000000-9000-4000-8000-000000000001 body {} | ผ่าน |
| E2E-295 | auth/authz | RBAC เขียน patch user → HEAD_APPROVER | PATCH /api/users/00000000-9000-4000-8000-000000000001 body {} | ผ่าน |
| E2E-296 | auth/authz | RBAC เขียน patch user → CHECKER | PATCH /api/users/00000000-9000-4000-8000-000000000001 body {} | ผ่าน |
| E2E-297 | auth/authz | RBAC เขียน patch user → MAKER | PATCH /api/users/00000000-9000-4000-8000-000000000001 body {} | ผ่าน |
| E2E-298 | auth/authz | RBAC เขียน patch user → VIEWER | PATCH /api/users/00000000-9000-4000-8000-000000000001 body {} | ผ่าน |
| E2E-299 | auth/authz | RBAC เขียน soft delete user → ADMIN | DELETE /api/users/00000000-9000-4000-8000-000000000001 body {} | ผ่าน |
| E2E-300 | auth/authz | RBAC เขียน soft delete user → HEAD_APPROVER | DELETE /api/users/00000000-9000-4000-8000-000000000001 body {} | ผ่าน |
| E2E-301 | auth/authz | RBAC เขียน soft delete user → CHECKER | DELETE /api/users/00000000-9000-4000-8000-000000000001 body {} | ผ่าน |
| E2E-302 | auth/authz | RBAC เขียน soft delete user → MAKER | DELETE /api/users/00000000-9000-4000-8000-000000000001 body {} | ผ่าน |
| E2E-303 | auth/authz | RBAC เขียน soft delete user → VIEWER | DELETE /api/users/00000000-9000-4000-8000-000000000001 body {} | ผ่าน |
| E2E-304 | auth/authz | RBAC เขียน requeue notification → ADMIN | POST /api/notifications/00000000-9000-4000-8000-000000000001/requeue body {} | ผ่าน |
| E2E-305 | auth/authz | RBAC เขียน requeue notification → HEAD_APPROVER | POST /api/notifications/00000000-9000-4000-8000-000000000001/requeue body {} | ผ่าน |
| E2E-306 | auth/authz | RBAC เขียน requeue notification → CHECKER | POST /api/notifications/00000000-9000-4000-8000-000000000001/requeue body {} | ผ่าน |
| E2E-307 | auth/authz | RBAC เขียน requeue notification → MAKER | POST /api/notifications/00000000-9000-4000-8000-000000000001/requeue body {} | ผ่าน |
| E2E-308 | auth/authz | RBAC เขียน requeue notification → VIEWER | POST /api/notifications/00000000-9000-4000-8000-000000000001/requeue body {} | ผ่าน |
| E2E-309 | auth/authz | RBAC KYC verify → ADMIN | POST kyc/verify | ผ่าน |
| E2E-310 | auth/authz | RBAC KYC verify → HEAD_APPROVER | POST kyc/verify | ผ่าน |
| E2E-311 | auth/authz | RBAC KYC verify → CHECKER | POST kyc/verify | ผ่าน |
| E2E-312 | auth/authz | RBAC KYC verify → MAKER | POST kyc/verify | ผ่าน |
| E2E-313 | auth/authz | RBAC KYC verify → VIEWER | POST kyc/verify | ผ่าน |
| E2E-314 | auth/authz | ไม่มี endpoint ไหนใน matrix ตอบ 500 | 50 probes | ผ่าน |
| E2E-315 | forgot-password | มีบัญชี fixture สำหรับทดสอบ reset (สร้างหรือกู้คืนซ้ำได้) | test_pwreset | ผ่าน |
| E2E-316 | forgot-password | forgot-password (อีเมลมีจริง) ตอบ 202 | test_pwreset@test.local | ผ่าน |
| E2E-317 | forgot-password | forgot-password (อีเมลไม่มีจริง) ตอบ 202 เหมือนกัน | nobody-here@test.local | ผ่าน |
| E2E-318 | forgot-password | คำตอบสองกรณีเหมือนกันทุกตัวอักษร (enumeration-proof) | existing vs non-existing email | ผ่าน |
| E2E-319 | forgot-password | อีเมลที่ไม่รู้จักไม่สร้าง reset token (ตารางเพิ่ม 0 แถว) | POST forgot-password(nobody-here@test.local) | ผ่าน |
| E2E-320 | forgot-password | บัญชีที่ปิดใช้งาน: ตอบ 202 แบบเดียวกัน | test_disabled@test.local | ผ่าน |
| E2E-321 | forgot-password | บัญชีที่ปิดใช้งานไม่ได้รับ OTP | test_disabled@test.local | ผ่าน |
| E2E-322 | forgot-password | บัญชีไม่มีอีเมล: ตอบ 202 แบบเดียวกัน (ไม่พัง) | test_noemail@test.local | ผ่าน |
| E2E-323 | forgot-password | ขอ OTP ซ้ำทันที: ตอบ 202 (cooldown) | test_pwreset@test.local | ผ่าน |
| E2E-324 | forgot-password | cooldown 60s: คำขอซ้ำไม่ออก OTP ใหม่ | forgot-password x2 ภายใน 60s | ผ่าน |
| E2E-325 | forgot-password | OTP ในฐานข้อมูลเก็บเป็น SHA-256 ไม่ใช่เลข 6 หลัก | password_reset_tokens.tokenHash | ผ่าน |
| E2E-326 | forgot-password | OTP ถูกส่งออกทาง outbox (มีเหตุการณ์ PASSWORD_RESET_OTP) | notification_outbox lookup | ผ่าน |
| E2E-327 | forgot-password | ค่า OTP ไม่ถูกเก็บเป็น plaintext ในฐานข้อมูล (ทุกตาราง) | OTP=566948 | ผ่าน |
| E2E-328 | forgot-password | ตาราง token ไม่มีคอลัมน์เก็บ plaintext | information_schema | ผ่าน |
| E2E-329 | forgot-password | ไม่มี OTP ปรากฏในไฟล์ log | 566948 | ผ่าน |
| E2E-330 | forgot-password | audit log บันทึกเหตุการณ์ขอ reset โดยไม่มียอดความลับ | audit_logs USER_RESET_REQUESTED | ผ่าน |
| E2E-331 | forgot-password | เดา OTP ผิด 5 ครั้ง: ทุกครั้งตอบ 400 ข้อความเดียวกัน | verify-otp x5 ด้วยรหัสผิด | ผ่าน |
| E2E-332 | forgot-password | ครบ 5 ครั้งที่ผิด: OTP ถูก burn (attempts=5, usedAt ตั้งแล้ว) | password_reset_tokens after 5 wrong guesses | ผ่าน |
| E2E-333 | forgot-password | มี audit USER_RESET_BURNED | audit_logs | ผ่าน |
| E2E-334 | forgot-password | ใช้รหัสที่ถูกต้องหลังกดเดาครบ 5 ครั้ง: ต้อง 400 (burn แล้ว) | verify-otp(correct otp after burn) | ผ่าน |
| E2E-335 | forgot-password | ออก OTP ใหม่ได้หลังพ้น cooldown | test_pwreset@test.local | ผ่าน |
| E2E-336 | forgot-password | login ด้วยรหัสผ่านเก่าได้ก่อน reset (baseline) | test_pwreset | ผ่าน |
| E2E-337 | forgot-password | OTP ไม่ใช่ 6 หลัก: 400 validation | otp=12345 | ผ่าน |
| E2E-338 | forgot-password | OTP ถูกต้อง: 200 + คืน resetUrl | otp=996334 | ผ่าน |
| E2E-339 | forgot-password | resetUrl มี token เดียวใช้ (base64url 43 ตัว) | /reset-password?token=fMU9oGHmiwCFtr2Xev9J5ST9ezIhpgKnrqlNTpE15uA | ผ่าน |
| E2E-340 | forgot-password | LINK token เก็บเป็น hash เช่นกัน | password_reset_tokens kind=LINK | ผ่าน |
| E2E-341 | forgot-password | OTP ใช้แล้วนำมาใช้ซ้ำไม่ได้ (single-use) | same otp twice | ผ่าน |
| E2E-342 | forgot-password | link reset ถูกเก็บใน outbox แบบซีลเท่านั้น (ยังเปิดอ่านได้ตอน dispatch) | token fMU9oGHm… | ผ่าน |
| E2E-343 | forgot-password | รหัสผ่านใหม่อ่อน: ถูกปฏิเสธตาม policy | reset-password(password=abc) | ผ่าน |
| E2E-344 | forgot-password | reset ที่อ่อนไม่เปลี่ยนรหัสผ่านจริง | login with the old password after the rejected reset | ผ่าน |
| E2E-345 | forgot-password | reset-password ด้วย token เดียวใช้: 200 | valid link + strong password | ผ่าน |
| E2E-346 | forgot-password | link ใช้แล้วใช้ซ้ำไม่ได้ | same link twice | ผ่าน |
| E2E-347 | forgot-password | login ด้วยรหัสใหม่ได้ | test_pwreset | ผ่าน |
| E2E-348 | forgot-password | รหัสผ่านเก่าใช้ไม่ได้แล้ว | old password | ผ่าน |
| E2E-349 | forgot-password | ไม่มี reset link token ในไฟล์ log | fMU9oGHmiwCF… | ผ่าน |
| E2E-350 | forgot-password | audit USER_PASSWORD_RESET ถูกต้อง และไม่มีรหัสผ่านในเหตุผล | audit_logs | ผ่าน |
| E2E-351 | forgot-password | token ที่ออกก่อนการ reset ต้องใช้ไม่ได้หลังเปลี่ยนรหัสผ่าน | GET /api/auth/me ด้วย JWT ที่ login ก่อน reset | ผ่าน |
| E2E-352 | forgot-password | login บันทึกเวลาออก token แบบ millisecond (mintedAtMs) ไว้ข้าง ๆ iat | base64url-decode payload ของ JWT ที่ /api/auth/login คืน | ผ่าน |
| E2E-353 | forgot-password | password change ที่ mintedAtMs+1ms: token ที่ออกก่อนถูกเพิกถอนทันที (401) | mintedAtMs=1792030698918 -> เขียน passwordChangedAt='2026-10-15 02:18:18.919' (หลัง token 1 ms) | ผ่าน |
| E2E-354 | forgot-password | ขอบเขตพอดี instant (passwordChangedAt == mintedAtMs): session ที่ออกพร้อมกันยังใช้ได้ (200) | passwordChangedAt='2026-10-15 02:18:18.918' ด้วย token เดิม | ผ่าน |
| E2E-355 | forgot-password | users.passwordChangedAt เก็บ millisecond ได้จริง (datetime(3) ไม่ใช่ datetime ที่ปัด) | เขียน '2026-10-15 02:18:18.918' แล้วอ่านกลับด้วย DATE_FORMAT('%f') | ผ่าน |
| E2E-356 | forgot-password | คืน passwordChangedAt ของบัญชี fixture ตรงถึง microsecond ที่อ่านมา (suites ถัดไปเห็นค่าเดิม) | restore จาก DATE_FORMAT ที่อ่านก่อนแตะแถว | ผ่าน |
| E2E-357 | forgot-password | หลัง reset ทุก secret ของบัญชีนี้ถูก retire เหลือแค่ที่ใช้จริง | unused non-expired rows for the fixture user | ผ่าน |
| E2E-358 | forgot-password | OTP หมดอายุ: 400 แม้รหัสจะถูก | otp after expiry | ผ่าน |
| E2E-359 | forgot-password | link หมดอายุ: 400 และไม่เปลี่ยนรหัสผ่าน | link past expiresAt | ผ่าน |
| E2E-360 | forgot-password | token ที่ไม่มีอยู่จริง: 400 | random token | ผ่าน |
| E2E-361 | forgot-password | IP throttle: คำขอจาก IP เดิมครบ 5 ครั้งแล้วไม่ออก OTP อีก (ตอบ 202 เหมือนเดิม) | 5 issuances then a 6th from the same client ip=::ffff:127.0.0.1 | ผ่าน |
| E2E-362 | forgot-password | forgot-password ด้วยรูปแบบอีเมลผิด: 400 | email=not-an-email | ผ่าน |
| E2E-363 | forgot-password | forgot-password โดยไม่มี email: 400 | {} | ผ่าน |
| E2E-364 | forgot-password | ล้างบัญชี fixture กลับรหัสผ่านมาตรฐานแล้ว | PATCH /api/users/:id {password} | ผ่าน |
| E2E-365 | users | บัญชี fixture ด้านผู้ใช้งานพร้อมทั้ง 3 บัญชี | test_mgmt1,test_mgmt2,test_avatar | ผ่าน |
| E2E-366 | users | GET /api/users (ADMIN) ตอบ list ที่ไม่มี field ลับ | GET /api/users | ผ่าน |
| E2E-367 | users | บัญชีที่ soft-delete แล้วไม่ปรากฏใน list ปกติ | GET /api/users | ผ่าน |
| E2E-368 | users | includeDeleted=true มองเห็นบัญชีที่ลบแล้ว | GET /api/users?includeDeleted=true | ผ่าน |
| E2E-369 | users | สร้างซ้ำด้วย username เดิม: 409 | test_mgmt1 | ผ่าน |
| E2E-370 | users | สร้างใหม่แต่อีเมลซ้ำกับบัญชีอื่น: 409 | test_mgmt1@test.local | ผ่าน |
| E2E-371 | users | รหัสผ่านไม่ผ่าน policy ตอนสร้าง: ถูกปฏิเสธ | password=abc | ผ่าน |
| E2E-372 | users | role ที่ไม่มีใน enum: 400 validation | role=SUPERUSER | ผ่าน |
| E2E-373 | users | username สั้นกว่า 3 ตัว: 400 | username=ab | ผ่าน |
| E2E-374 | users | สร้างบัญชีไม่มีอีเมลได้ (ระบบอนุญาต) และต้องไม่ใช่ 5xx | POST /api/users without email (test_nomail_694288) | ผ่าน |
| E2E-375 | users | อีเมลที่มีช่องว่างหัวท้าย: ต้อง trim ก่อนเก็บ หรือปฏิเสธ (ห้ามเก็บค่าที่มีช่องว่าง) | email="  test_trim_694288@test.local  " | ผ่าน |
| E2E-376 | users | ทุกครั้งที่สร้างผู้ใช้มี audit USER_CREATED | audit_logs USER_CREATED by admin | ผ่าน |
| E2E-377 | users | สร้าง username ที่เคยถูก soft-delete ซ้ำ: ต้อง 409 ไม่ใช่ 500 | test_dupdel_694288 | ผ่าน |
| E2E-378 | users | สร้างด้วยอีเมลของบัญชีที่ soft-delete แล้ว: ต้อง 409 ไม่ใช่ 500 | test_dupdel_694288@test.local | ผ่าน |
| E2E-379 | users | แก้ fullName ได้ | test_mgmt1 | ผ่าน |
| E2E-380 | users | แก้ fullName แล้วอ่านกลับมาได้ค่าใหม่จริง | Test Mgmt One Edited | ผ่าน |
| E2E-381 | users | เปลี่ยนอีเมลแล้ว isEmailVerified ต้องกลับไป false | PATCH email | ผ่าน |
| E2E-382 | users | ย้ายไปอีเมลที่บัญชีอื่นใช้อยู่: 409 | test_mgmt2@test.local | ผ่าน |
| E2E-383 | users | สลับ role เป็น VIEWER แล้ว token ใหม่มี role VIEWER | PATCH role=VIEWER then login | ผ่าน |
| E2E-384 | users | VIEWER ที่เพิ่งสลับ role ยังเขียนข้อมูลการเงินไม่ได้ | POST penalties with the new token | ผ่าน |
| E2E-385 | users | ปิดใช้งานบัญชี: login ถูกปฏิเสธทันที | PATCH isActive=false then login | ผ่าน |
| E2E-386 | users | token ที่ออกก่อนปิดบัญชียังใช้ไม่ได้ (บัญชี inactive) | GET /api/auth/me ด้วย JWT เก่าของบัญชีที่ถูกปิด | ผ่าน |
| E2E-387 | users | เปิดใช้งาน kembali แล้ว login ได้อีก | PATCH isActive=true then login | ผ่าน |
| E2E-388 | users | ADMIN ตั้งรหัสผ่านใหม่ให้ผู้ใช้ได้ และรหัสเก่าใช้ไม่ได้ | PATCH password then two logins | ผ่าน |
| E2E-389 | users | ทุกครั้งแก้ผู้ใช้มี audit USER_UPDATED | audit_logs USER_UPDATED by admin | ผ่าน |
| E2E-390 | users | PATCH บัญชีที่ไม่มีอยู่: 404 | random uuid | ผ่าน |
| E2E-391 | users | อัปโหลด avatar PNG ถูกต้อง: 201 | multipart field "file", 3KB png | ผ่าน |
| E2E-392 | users | avatar ที่เก็บมี mimeType/size ตรงกับไบต์จริง | {"id":"c2083c7d-e222-4ba2-9518-85c4d2a8cdf2","mimeType":"image/png","sizeBytes":3082,"updatedAt":"2026-10-15T02:18:21.826Z"} | ผ่าน |
| E2E-393 | users | GET avatar คืนไบต์ตรงกับที่อัปโหลด | GET /api/users/:id/avatar | ผ่าน |
| E2E-394 | users | list บอก hasAvatar=true | GET /api/users | ผ่าน |
| E2E-395 | users | ไฟล์ที่ไม่ใช่รูป (ต่อให้มีนามสกุล .png): 415 | html/script bytes named evil.png | ผ่าน |
| E2E-396 | users | รูปใหญ่เกิน limit ของ policy: 413 | 4MB png (policy 512KB) | ผ่าน |
| E2E-397 | users | รูปจริงแต่นามสกุล .txt: ยอมรับตาม magic bytes (ไม่เชื่อชื่อไฟล์) | jpeg bytes named notes.txt | ผ่าน |
| E2E-398 | users | avatar แบบ WebP ใช้ได้ | webp bytes | ผ่าน |
| E2E-399 | users | เจ้าของบัญชีอัปโหลดรูปตัวเองได้ | test_avatar PUT own avatar | ผ่าน |
| E2E-400 | users | ผู้ใช้คนอื่นแก้ avatar ของบัญชีอื่นไม่ได้: 403 | test_op2 PUT test_avatar avatar | ผ่าน |
| E2E-401 | users | ส่ง multipartผิดชื่อ field: 400 | field=wrongField | ผ่าน |
| E2E-402 | users | ลบ avatar ได้ | DELETE /users/:id/avatar | ผ่าน |
| E2E-403 | users | ลบ avatar ครั้งที่ไม่มีรูปอยู่แล้ว: 404 | DELETE again | ผ่าน |
| E2E-404 | users | มี audit ทุกครั้งที่แก้ avatar | audit_logs USER_AVATAR_UPDATED | ผ่าน |
| E2E-405 | users | ห้าม ADMIN ลบบัญชีที่ตนเอง login อยู่ | DELETE own account | ผ่าน |
| E2E-406 | users | soft delete บัญชีอื่น: 200 {deleted:true} | test_mgmt2 | ผ่าน |
| E2E-407 | users | response soft delete คืน id ตรงบัญชีที่ลบ | {"deleted":true,"id":"a9db51c1-cf11-4652-a5cf-76baaa9cb850"} | ผ่าน |
| E2E-408 | users | บัญชีที่ลบแล้ว login ไม่ได้ | test_mgmt2 | ผ่าน |
| E2E-409 | users | บัญชีที่ลบแล้วหายจาก list | GET /api/users | ผ่าน |
| E2E-410 | users | restore โดยไม่ reactivate: บัญชีกลับมาแต่ยังปิดใช้งาน | POST /:id/restore {} | ผ่าน |
| E2E-411 | users | restore + reactivate: บัญชีบัญชีกลับมาใช้ได้ (409 เพราะไม่ถูก delete ซ้ำ) | POST /:id/restore {reactivate:true} | ผ่าน |
| E2E-412 | users | เปิดใช้งานแล้ว login ได้จริง | PATCH isActive=true then login | ผ่าน |
| E2E-413 | users | restore บัญชีที่ไม่ได้ถูกลบ: 409 | test_mgmt1 | ผ่าน |
| E2E-414 | users | มี audit USER_DELETED และ USER_RESTORED | audit_logs | ผ่าน |
| E2E-415 | users | ส่ง reset link ทีละบัญชี: 200 {sent:true} | test_mgmt1 | ผ่าน |
| E2E-416 | users | reset link เก็บเป็น hash ในฐานข้อมูลและกำหนดอายุ | 2026-10-15T03:18:23.004Z | ผ่าน |
| E2E-417 | users | มี audit USER_RESET_SENT ทุกครั้งที่ส่ง link | audit_logs | ผ่าน |
| E2E-418 | users | ส่ง link ซ้ำทันที: 422 (cooldown) | test_mgmt1 | ผ่าน |
| E2E-419 | users | บัญชีไม่มีอีเมล: 422 บอกให้ตั้งอีเมลก่อน | test_noemail | ผ่าน |
| E2E-420 | users | บัญชีถูกปิดใช้งาน: 422 บอกว่าต้องเปิดก่อน | test_disabled | ผ่าน |
| E2E-421 | users | ส่ง link ให้ id ที่ไม่มีอยู่: 404 | random uuid | ผ่าน |
| E2E-422 | users | ส่ง link แบบ bulk: 200 และแยก sent/skipped | 3 ids: 1 ส่งได้, 1 ไม่มีอีเมล, 1 ไม่มีอยู่ | ผ่าน |
| E2E-423 | users | bulk: คนที่ส่งได้/ถูกข้ามรายงานตรงตามเหตุผลจริง | {"sent":["test_mgmt2"],"skipped":[{"id":"00000000-0000-4000-8000-000000000009","reason":"test_noemail has no email address — set one before resetting"},{"id":"0 | ผ่าน |
| E2E-424 | users | bulk ด้วย ids ว่าง: 400 | ids=[] | ผ่าน |
| E2E-425 | users | bulk ด้วย id ที่ไม่ใช่ uuid: 400 | ids=[not-a-uuid] | ผ่าน |
| E2E-426 | users | MAKER อ่านข้อมูลตนเองผ่าน GET /api/users/me ได้ (ไม่ถูก route ADMIN /:id กัน) | GET /api/users/me (test_mgmt1) | ผ่าน |
| E2E-427 | users | GET /api/users/me คืนสนามที่หน้าจอ Profile ต้องแสดง และไม่มี field ลับ | createdAt,deletedAt,email,fullName,hasAvatar,id,isActive,isEmailVerified,lastLoginAt,passwordChangedAt,role,username | ผ่าน |
| E2E-428 | users | GET /api/users/me โดยไม่มี token: 401 | no bearer token | ผ่าน |
| E2E-429 | users | MAKER ยังใช้ route ของ ADMIN (GET /api/users) ไม่ได้: 403 | GET /api/users ด้วย token ของ test_mgmt1 | ผ่าน |
| E2E-430 | users | พยายามยกระดับสิทธิ์ตนเองผ่าน PATCH /api/users/me (role=ADMIN): 400 | { role: "ADMIN" } | ผ่าน |
| E2E-431 | users | พยายามปิดใช้งานบัญชีตัวเองผ่าน /me (isActive): 400 | { isActive: false } | ผ่าน |
| E2E-432 | users | ส่ง password ผ่าน PATCH /api/users/me (ต้องเปลี่ยนผ่าน endpoint เฉพาะ): 400 | { password: "Self@2026#q" } | ผ่าน |
| E2E-433 | users | PATCH /api/users/me ด้วย body ว่าง: 400 | {} | ผ่าน |
| E2E-434 | users | ข้อมูลบัญชีไม่เปลี่ยนจากรอบที่พยายามยกระดับสิทธิ์/ปิดตัวเอง | role + isActive หลัง 4 คำขอที่ถูกปฏิเสธ | ผ่าน |
| E2E-435 | users | เจ้าของบัญชีแก้ fullName ของตนเองได้: 200 | { fullName } | ผ่าน |
| E2E-436 | users | ชื่อที่แก้ผ่าน /me ถูกเก็บจริง (ADMIN list เห็นค่าเดียวกัน) | GET /api/users แล้วเทียบ fullName | ผ่าน |
| E2E-437 | users | ย้ายอีเมลของตนเองไปชนบัญชีอื่น: 409 | test_mgmt2@test.local | ผ่าน |
| E2E-438 | users | เปลี่ยนอีเมลตนเองได้ และ isEmailVerified ต้องกลับไป false (ที่อยู่ใหม่ยังไม่เคยพิสูจน์) | { email: self_*@test.local } | ผ่าน |
| E2E-439 | users | การแก้ข้อมูลตนเองมี audit USER_PROFILE_UPDATED | audit_logs USER_PROFILE_UPDATED ของ test_mgmt1 | ผ่าน |
| E2E-440 | users | POST /api/users/me/password โดยไม่มี token: 401 | no bearer token | ผ่าน |
| E2E-441 | users | ไม่ใส่ currentPassword: 400 (ห้ามเปลี่ยนโดยไม่ verify รหัสเก่า) | { newPassword } เท่านั้น | ผ่าน |
| E2E-442 | users | ไม่ใส่ newPassword: 400 | { currentPassword } เท่านั้น | ผ่าน |
| E2E-443 | users | เปลี่ยนรหัสผ่านด้วยรหัสเก่าที่ไม่ถูกต้อง: 401 | currentPassword=Wrong@2026#z | ผ่าน |
| E2E-444 | users | รหัสเก่าผิด: passwordHash ในฐานข้อมูลไม่เปลี่ยน และรหัสเก่ายัง login ได้ | hash before/after + login ด้วย PASSWORD | ผ่าน |
| E2E-445 | users | รหัสเก่าผิดต้องมี audit USER_PASSWORD_CHANGE_FAILED (ไว้ตรวจการเดารหัส) | audit_logs USER_PASSWORD_CHANGE_FAILED ของ test_mgmt1 | ผ่าน |
| E2E-446 | users | รหัสเก่าถูก แต่รหัสใหม่ไม่ผ่าน policy: 422 และยังไม่เปลี่ยนรหัส | newPassword=abc | ผ่าน |
| E2E-447 | users | ตั้งรหัสใหม่ซ้ำรหัสเดิม: 422 | newPassword == currentPassword | ผ่าน |
| E2E-448 | users | สองครั้งที่ถูกปฏิเสธไม่แตะ passwordHash | hash หลัง weakNew + sameAsOld | ผ่าน |
| E2E-449 | users | ใส่รหัสเก่าถูกต้องแล้วเปลี่ยนรหัสผ่านได้: 200 | currentPassword + compliant newPassword | ผ่าน |
| E2E-450 | users | เปลี่ยนแล้ว: รหัสเก่า login ไม่ได้ (401) และรหัสใหม่ login ได้ (200) | login ด้วย PASSWORD / NEW_PW | ผ่าน |
| E2E-451 | users | JWT ที่ออกก่อนเปลี่ยนรหัสใช้ไม่ได้ทันที (ทุก session ถูกเพิกถอน) | GET /api/auth/me ด้วย token เก่า | ผ่าน |
| E2E-452 | users | passwordHash ถูกเขียนใหม่เป็น bcrypt และไม่เก็บรหัสผ่าน plain text | hash หลังเปลี่ยนรหัส | ผ่าน |
| E2E-453 | users | passwordChangedAt ขยับไปหลังการเปลี่ยนรหัส (หน้า Profile ใช้แสดงอายุรหัสผ่าน) | GET /api/users/me ด้วย token ใหม่ | ผ่าน |
| E2E-454 | users | การเปลี่ยนรหัสผ่านมี audit USER_PASSWORD_CHANGED และ reason ไม่มีรหัสผ่าน (ข้อกำหนดห้ามความลับใน log) | audit_logs reason | ผ่าน |
| E2E-455 | users | คืนสภาพบัญชี fixture หลังเทสต์ self-service แล้ว (ชื่อ/อีเมล/รหัสผ่านใช้ได้) | test_mgmt1 หลัง cleanup | ผ่าน |
| E2E-456 | users | เก็บกวาดบัญชีเฉพาะกิจที่สร้างระหว่างเทสต์แล้ว (เหลือแค่ 3 บัญชี fixture) | test_nomail_694288,test_trim_694288,test_dupdel_694288,test_dupmail_694288 | ผ่าน |
| E2E-457 | kyc | สร้างลูกค้าใหม่เพื่อทดสอบ KYC (สถานะเริ่มต้น NOT_VERIFIED) | Test Kyc Flow | ผ่าน |
| E2E-458 | kyc | GET สถานะ KYC คืน kycState ครบชุด | /api/customers/90bf56e6-aa4e-48db-a400-e6334ac91cff/kyc | ผ่าน |
| E2E-459 | kyc | kycState มี customer/documents/policy/checklist ตามสัญญา | GET /kyc/documents | ผ่าน |
| E2E-460 | kyc | ยังไม่มีเอกสาร → checklist บอกว่าขาด IDENTITY_DOCUMENT, SELFIE_WITH_ID, SIGNATURE | checklist.missing | ผ่าน |
| E2E-461 | kyc | satisfied=false ก่อนอัปโหลด | checklist.satisfied | ผ่าน |
| E2E-462 | kyc | อัปโหลด NATIONAL_ID (PNG จริง): 201 | NATIONAL_ID 30KB png | **ไม่ผ่าน** |
| E2E-463 | kyc | เก็บ mimeType/size/checksum ตรงกับไบต์จริง (ไม่เชื่อ Content-Type) | sha256 of the uploaded bytes | **ไม่ผ่าน** |
| E2E-464 | kyc | ชื่อไฟล์ภาษาไทยต้องถูกเก็บถูกต้อง (UTF-8) | filename บัตรประชาชน.png | **ไม่ผ่าน** |
| E2E-465 | kyc | อัปโหลดไบต์ซ้ำกับภาพที่มีอยู่: 409 | same bytes, different type | **ไม่ผ่าน** |
| E2E-466 | kyc | อัปโหลดไฟล์ที่ไม่ใช่รูป (นามสกุล .png): 415 | html bytes named id.png | ผ่าน |
| E2E-467 | kyc | อัปโหลดใหญ่กว่า policy: 413 | pngBytes(6144 KB) | ผ่าน |
| E2E-468 | kyc | documentType ที่ไม่มีใน enum: 4xx ไม่ใช่ 5xx | documentType=DRIVING_LICENSE | ผ่าน |
| E2E-469 | kyc | รูปแบบวันที่ไม่ถูกต้อง: 400 | issuedAt=11/04/2023 | ผ่าน |
| E2E-470 | kyc | issuedAt เป็นอนาคต: 422 | issuedAt=2099-01-01 | ผ่าน |
| E2E-471 | kyc | expiresAt ก่อน issuedAt: 422 | expiresAt<issuedAt | ผ่าน |
| E2E-472 | kyc | ไม่ส่งไบต์ใน field "file": 400 | field=wrong | ผ่าน |
| E2E-473 | kyc | VIEWER อัปโหลดหลักฐานไม่ได้: 403 | viewer token | ผ่าน |
| E2E-474 | kyc | GET เนื้อหาเอกสารคืนไบต์ตรงกับที่อัปโหลด (sha256 เท่ากัน) | GET /documents/:id/content | **ไม่ผ่าน** |
| E2E-475 | kyc | ข้ามไปอ่านเอกสารของลูกค้าอื่นด้วย id จริง: 404 (กัน IDOR) | other customerId + this documentId | ผ่าน |
| E2E-476 | kyc | คนที่ไม่ใช่ผู้อัปโหลด/ADMIN ลบเอกสารไม่ได้: 403 | test_op2 deletes test_op1 upload | **ไม่ผ่าน** |
| E2E-477 | kyc | ผู้อัปโหลดลบเองได้ | uploader DELETE | **ไม่ผ่าน** |
| E2E-478 | kyc | ลบเอกสารที่ไม่อยู่แล้ว: 404 | same id twice | ผ่าน |
| E2E-479 | kyc | submit ก่อนเอกสารครบ: 422 พร้อมรายการที่ขาด | no documents uploaded | ผ่าน |
| E2E-480 | kyc | ข้อความ 422 ระบุโค้ดที่ขาด (IDENTITY_DOCUMENT, SELFIE_WITH_ID, SIGNATURE) | KYC checklist is incomplete — missing: IDENTITY_DOCUMENT, SELFIE_WITH_ID, SIGNATURE | ผ่าน |
| E2E-481 | kyc | อัปโหลดชุดเอกสารครบตาม policy (3 รายการ) สำเร็จทุกใบ | NATIONAL_ID,SELFIE_WITH_ID,SIGNATURE | **ไม่ผ่าน** |
| E2E-482 | kyc | ครบเงื่อนไขแล้ว checklist.satisfied=true | GET /kyc/documents | ผ่าน |
| E2E-483 | kyc | submit เมื่อเอกสารครบ: 200 + สถานะ PENDING | maker submits | ผ่าน |
| E2E-484 | kyc | submit บันทึกผู้ส่ง + เวลา แต่ยังไม่มี policy snapshot (เก็บตอนอนุมัติ) | submit.json.data.customer | ผ่าน |
| E2E-485 | kyc | maker ตรวจอนุมัติเองไม่ได้ (maker-checker): 422 | submitter verifies | ผ่าน |
| E2E-486 | kyc | MAKER อื่น verify ไม่ได้: 403 | MAKER token | ผ่าน |
| E2E-487 | kyc | reject โดยไม่มีเหตุผล: 400 | reason="" | ผ่าน |
| E2E-488 | kyc | CHECKER reject พร้อมเหตุผล: 200 + สถานะ REJECTED | reason provided | ผ่าน |
| E2E-489 | kyc | เหตุผลที่ถูก reject ถูกเก็บไว้ให้เห็นใน state | ภาพบัตรประชาชนไม่ชัด ต้องถ่ายใหม่ | ผ่าน |
| E2E-490 | kyc | verify ตอนไม่ได้อยู่ใน PENDING: 422 | status=REJECTED | ผ่าน |
| E2E-491 | kyc | หลัง reject ส่งใหม่ได้ (PENDING อีกครั้ง) | resubmit after rejection | ผ่าน |
| E2E-492 | kyc | CHECKER อนุมัติ: 200 + VERIFIED | checker verifies | ผ่าน |
| E2E-493 | kyc | อนุมัติแล้วบันทึก reviewer + เวลา + snapshot ของ policy ที่ใช้ | {"id":"90bf56e6-aa4e-48db-a400-e6334ac91cff","customerNumber":"CUST-000027","fullName":"Test Kyc Flow","nationalId":"kyc-flow","kycStatus":"VERIFIED","kycSubmit | ผ่าน |
| E2E-494 | kyc | อนุมัติซ้ำตอน VERIFIED: 422 | already verified | ผ่าน |
| E2E-495 | kyc | เพิ่มเอกสารหลัง VERIFIED → สถานะกลับเป็น PENDING (reverifyOnDocumentChange) | POST /documents after VERIFIED | ผ่าน |
| E2E-496 | kyc | อ่านสถานะหลังเปลี่ยนเอกสาร: PENDING จริงตาม state | GET /kyc/documents | ผ่าน |
| E2E-497 | kyc | CHECKER ใช้ reopen ไม่ได้: 403 | CHECKER token | ผ่าน |
| E2E-498 | kyc | reopen โดยไม่มีเหตุผล: 400 | reason="" | ผ่าน |
| E2E-499 | kyc | ADMIN reopen: 200 และกลับสถานะเป็น PENDING | ADMIN reopen | ผ่าน |
| E2E-500 | kyc | มี audit CUSTOMER_CREATED | audit_logs where customerId=CUST-000027 | ผ่าน |
| E2E-501 | kyc | มี audit KYC_DOCUMENT_UPLOADED | audit_logs where customerId=CUST-000027 | ผ่าน |
| E2E-502 | kyc | มี audit KYC_DOCUMENT_DELETED | audit_logs where customerId=CUST-000027 | **ไม่ผ่าน** |
| E2E-503 | kyc | มี audit KYC_SUBMITTED | audit_logs where customerId=CUST-000027 | ผ่าน |
| E2E-504 | kyc | มี audit KYC_REJECTED | audit_logs where customerId=CUST-000027 | ผ่าน |
| E2E-505 | kyc | มี audit KYC_VERIFIED | audit_logs where customerId=CUST-000027 | ผ่าน |
| E2E-506 | kyc | มี audit KYC_REVERIFY_REQUIRED | audit_logs where customerId=CUST-000027 | ผ่าน |
| E2E-507 | kyc | มี audit KYC_REOPENED | audit_logs where customerId=CUST-000027 | ผ่าน |
| E2E-508 | kyc | อัปโหลดเอกสารที่หมดอายุไปแล้ว (ยังบันทึกได้) | expiresAt=2020-01-01 | **ไม่ผ่าน** |
| E2E-509 | kyc | checklist ระบุ expired + satisfied=false เมื่อไม่รับเอกสารหมดอายุ | checklist | **ไม่ผ่าน** |
| E2E-510 | kyc | submit ด้วยเอกสารหมดอายุ: 422 | expired evidence | ผ่าน |
| E2E-511 | kyc | เอกสารใกล้หมดอายุ (<= expiryWarningDays) ถูกแจ้งเตือนใน expiringSoon | expiresAt=2026-11-04, warningDays=60 | **ไม่ผ่าน** |
| E2E-512 | kyc | เอกสารทุกใบต้องมีไบต์เก็บใน kyc_document_contents | orphans without content row | ผ่าน |
| E2E-513 | kyc | จำนวนแถวเอกสาร/ไบต์สอดคล้องกันทั้งตาราง | join count | ผ่าน |
| E2E-514 | loans | GET /api/loans ตอบกลับ 200 | limit=100 | ผ่าน |
| E2E-515 | loans | list คืน loanครบทุกแถวที่ seed ไว้ | pagination.total | ผ่าน |
| E2E-516 | loans | ทุกรายการมี outstanding {penalty,pastInterest,pastPrincipal,total} และ total = ผลบวก 3 ส่วน = currentOutstanding | 21 rows | ผ่าน |
| E2E-517 | loans | aggregates.principalCharged = ผลรวมอิสระจากข้อมูล seed | GET /api/loans?limit=100 (no filter) | ผ่าน |
| E2E-518 | loans | aggregates.outstandingPrincipal = ผลรวมอิสระจากข้อมูล seed | GET /api/loans?limit=100 (no filter) | ผ่าน |
| E2E-519 | loans | aggregates.outstandingInterest = ผลรวมอิสระจากข้อมูล seed | GET /api/loans?limit=100 (no filter) | ผ่าน |
| E2E-520 | loans | aggregates.outstandingPenalty = ผลรวมอิสระจากข้อมูล seed | GET /api/loans?limit=100 (no filter) | ผ่าน |
| E2E-521 | loans | aggregates.outstandingTotal = ผลรวมอิสระจากข้อมูล seed | GET /api/loans?limit=100 (no filter) | ผ่าน |
| E2E-522 | loans | aggregates.closedCount นับเฉพาะสถานะ CLOSED | expected.statuses | ผ่าน |
| E2E-523 | loans | filter status=ACTIVE: ทุกแถวเป็นสถานะนั้น จำนวนและตัวเลขรวมตรง expected | status=ACTIVE | ผ่าน |
| E2E-524 | loans | filter status=CLOSED: ทุกแถวเป็นสถานะนั้น จำนวนและตัวเลขรวมตรง expected | status=CLOSED | ผ่าน |
| E2E-525 | loans | filter status=WRITTEN_OFF: ทุกแถวเป็นสถานะนั้น จำนวนและตัวเลขรวมตรง expected | status=WRITTEN_OFF | ผ่าน |
| E2E-526 | loans | filter ด้วยสถานะที่ไม่มีใน enum: ต้องไม่ 500 (คืนชุดว่างหรือ 400) | status=NOT_A_STATUS | ผ่าน |
| E2E-527 | loans | filter customerId คืนเฉพาะ loan ของลูกค้านั้น | customerId=00000000-2000-4000-8000-000000000003 | ผ่าน |
| E2E-528 | loans | GET /api/customers: ตอบ 200 (ไม่มี parameter = คืนทุกแถว) | no query | ผ่าน |
| E2E-529 | loans | ทุกรายการมี activeLoanCount + borrowings[{productId,productName,loanCount,activeCount,outstanding}] | 28 rows | ผ่าน |
| E2E-530 | loans | ลูกค้าที่มีหลายสัญญา: borrowings รวมตามผลิตภัณฑ์ + loanCount = ผลบวกทุกผลิตภัณฑ์ | customerId=00000000-2000-4000-8000-000000000003 (CUST-TST-0003, 2 loans) | ผ่าน |
| E2E-531 | loans | activeLoanCount = ผลรวม activeCount ของทุกผลิตภัณฑ์ (ทุกแถว) | 28 rows | ผ่าน |
| E2E-532 | loans | เรียงผลิตภัณฑ์: ที่มีหนี้ค้างอยู่ต้องขึ้นก่อนที่เคยกู้เสร็จไปแล้ว | 28 rows | ผ่าน |
| E2E-533 | loans | ประวัติเคยกู้ (loan ปิด/ตัดจำหน่ายแล้ว): activeCount=0 และ outstanding=0 แต่ยังแสดงชื่อผลิตภัณฑ์ | 7 สัญญาที่ลูกค้าไม่มีหนี้ ACTIVE | ผ่าน |
| E2E-534 | loans | ผลรวม outstanding ใน borrowings ของลูกค้าทุกคน = ยอดคงค้าง ACTIVE รวมจากหน้า loans | GET /api/customers เทียบ GET /api/loans?limit=100 (21 แถว) | ผ่าน |
| E2E-535 | loans | ค้นหาด้วยเลข loan (q) เจอ 1 รายการ | q=LN-TST-000003 | ผ่าน |
| E2E-536 | loans | ค้นหาด้วยชื่อภาษาลาว: ต้องเจอและคืนเฉพาะloan ของลูกค้าคนนั้น | q=<Lao name fragment> | ผ่าน |
| E2E-537 | loans | ค้นหาด้วยเลขบัตรประชาชน (013474718503) | q=nationalId | ผ่าน |
| E2E-538 | loans | limit ที่ไม่สมเหตุสมผลต้องถูกกำกับ: 0/abc -> ค่า default 20, 5000 -> 100 | limit=0 / limit=abc / limit=5000 | ผ่าน |
| E2E-539 | loans | page ที่เกินจำนวน: data ว่าง แต่ total คงเดิม | page=999 | ผ่าน |
| E2E-540 | loans | แบ่งหน้าไม่ซ้ำและไม่ตกหล่น (5 หน้าที่ limit=5 ครอบคลุม 21 รายการ) | page 1..5, limit 5 | ผ่าน |
| E2E-541 | loans | เรียงลำดับตาม createdAt ใหม่สุดก่อน | GET /api/loans?limit=100 | ผ่าน |
| E2E-542 | loans | VIEWER อ่าน list loan ได้ (สิทธิ์อ่าน) | test_view1 | ผ่าน |
| E2E-543 | loans | loan ที่ไม่มีอยู่: 404 | 00000000-7000-4000-8000-0000000000ff | ผ่าน |
| E2E-544 | loans | ข้อความ error ของ 404 ต้องอ่านรู้เรื่อง (เช่น "Loan not found") | GET /api/loans/<unknown> | ผ่าน |
| E2E-545 | loans | detail มี loan + transactions + transactionPagination + credit + settlements | GET /api/loans/:id | ผ่าน |
| E2E-546 | loans | ยอดคงค้าง 21 loan ตรง expected.json เป๊ะถึงทศนิยม | GET /api/loans/:id outstanding vs expected.loans | ผ่าน |
| E2E-547 | loans | สถานะ loan ทุกตัวตรงกับ expected.json (ACTIVE/CLOSED/WRITTEN_OFF) | loan.status | ผ่าน |
| E2E-548 | loans | จำนวน transaction POSTED/PENDING ต่อ loan ตรงกับ expected.json | detail.transactions grouped by status | ผ่าน |
| E2E-549 | loans | ทุก transaction ที่ POSTED (71 แถว): ผลรวม line รายส่วน = ยอดที่ตัดกับ loan จริง (หนี้+/ชำระ-, ไม่นับส่วนที่กลายเป็น credit) | financial_transaction_lines vs financial_transactions.amount - credit_ledger.ACCRUED | ผ่าน |
| E2E-550 | loans | payment/settlement ที่ POSTED (34 ใบ): tx.amount = เงินสด + credit ที่ใช้ และทุกการใช้ credit มี แถว USED ใน credit_ledger | payment_requests.cashAmount/creditApplied vs financial_transactions.amount + credit_ledger USED | ผ่าน |
| E2E-551 | loans | ไม่มี payment request nào มียอดเงินสดติดลบ (ข้อมูลทดสอบต้องสมเหตุสมผลก่อนใช้ตรวจยอดคงค้าง) | payment_requests.cashAmount of posted payments | ผ่าน |
| E2E-552 | loans | line ของ DISBURSEMENT ทุก loan = เงินต้น + ดอกเบี้ย flat ตาม expected.json (คำนวณจาก ledger) | DISBURSEMENT component lines vs expected.principal/billedInterest | ผ่าน |
| E2E-553 | loans | ตัวอย่าง LN-TST-000005 (ค้างทั้งดอกเบี้ยและเงินต้น): แยกยอดคงค้างถูกต้อง | 00000000-7000-4000-8000-000000000005 | ผ่าน |
| E2E-554 | loans | detail ของ loan ที่ลูกค้ามีเงินรอใช้ (credit) แสดงยอดตาม expected.json | LN-TST-000021 | ผ่าน |
| E2E-555 | loans | pagination ของ transactions ใน detail ใช้ได้จริง | limit=3&page=2 | ผ่าน |
| E2E-556 | loans | GET /api/loans/:id/schedule ตอบกลับ 200 พร้อม data ครบทุก loan | 21 loans | ผ่าน |
| E2E-557 | loans | จำนวนงวด (periodCount) ตรงกับ expected.json ทุก loan | schedule.periodCount | ผ่าน |
| E2E-558 | loans | วันครบกำหนดรายงวดตรง expected.json ทุก loan (รวมกรณีปลายเดือน 31 -> 30 วัน) | schedule.periods[].dueDate vs expected.scheduleDueDates | ผ่าน |
| E2E-559 | loans | ค่างวดรายงวดรวมกัน = totals.principalCharged/interestCharged และ = ผลรวม line ประเภทหนี้ใน ledger (เศษตกงวดสุดท้าย) | Σ period.*Due vs totals.*Charged vs Σ ledger charge lines | ผ่าน |
| E2E-560 | loans | loan ที่ไม่มีการปรับยอด/กลับรายการ write-off (18 ตัว): ยอดเรียกเก็บ = principal + billedInterest ตาม expected.json | schedule totals vs expected.principal/billedInterest | ผ่าน |
| E2E-561 | loans | ค่างต้นแต่ละงวดเท่ากัน ยกเว้นงวดสุดท้ายที่รับเศษ | principalDue across periods 1..n-1 | ผ่าน |
| E2E-562 | loans | schedule.totals.outstanding = ยอดคงค้างของบัญชี loan (สองมุมมองต้องตรงกัน) | schedule totals vs loan outstanding | ผ่าน |
| E2E-563 | loans | Σ outstanding รายงวด = คงค้างส่วนดอกเบี้ย+เงินต้น (ค่าปรับไม่อยู่ในงวด) | Σ period.outstanding | ผ่าน |
| E2E-564 | loans | aging.maturityDate = วันครบกำหนดงวดสุดท้ายเสมอ | aging.maturityDate | ผ่าน |
| E2E-565 | loans | loan ที่ CLOSED (6 รายการ) งวดต้องปิดครบ PAID และหมด | status CLOSED | ผ่าน |
| E2E-566 | loans | penaltySuggested (ค่าปรับที่ระบบเสนอให้เรียกเก็บ) ต้องไม่ติดลบ | totals.penaltySuggested | ผ่าน |
| E2E-567 | loans | ไม่มีส่วนใดของยอดคงค้างติดลบ (ห้ามชำระ/ยกเว้นค่าปรับเกินยอดที่เรียกเก็บ) | totals.outstanding components | ผ่าน |
| E2E-568 | loans | asOf คนละเวลา: จำนวนงวดค้าง/วันค้างต้องมากขึ้นตามเวลา ณ ตอนนั้น | asOf 2026-01-05 vs 2026-03-05 on undefined (ค้างครบทุกงวด) | ผ่าน |
| E2E-569 | loans | schedule ด้วย asOf ที่ไม่ใช่วันที่: 400 | asOf=not-a-date | ผ่าน |
| E2E-570 | loans | schedule แบบไม่ส่ง asOf (ใช้เวลาระบบ): 200 | no asOf | ผ่าน |
| E2E-571 | loans | schedule ของ loan ที่ไม่มีอยู่: 404 | 00000000-7000-4000-8000-0000000000ff | ผ่าน |
| E2E-572 | loans | [F-SCH-1] งวดที่เลยกำหนดมากับมีชำระบางส่วน: aging ต้องนับว่าค้างด้วย | aging.overduePeriods vs count(PARTIAL periods past dueDate) | ผ่าน |
| E2E-573 | loans | [F-SCH-2] loan ที่ไม่เคยมี payment (write-off แล้วกลับรายการ): งวดต้องไม่แสดงว่าชำระแล้ว | LN-TST-000020 periods.paid vs its transactions | ผ่าน |
| E2E-574 | loans | [F-SCH-2] loan ที่ write-off บางส่วน: ยอด write-off ต้องไม่โผล่เป็นงวดที่ชำระแล้ว | LN-TST-000019 (write-off 5,000,000 of principal) | ผ่าน |
| E2E-575 | loans | การกระจายเงินชำระ (loan ค้างดอกเบี้ย+เงินต้น): เรียง PENALTY -> PAST_INTEREST -> PAST_PRINCIPAL | amount 4,000,000 on LN-TST-000005 | ผ่าน |
| E2E-576 | loans | ชำระเกินยอดคงค้าง: ส่วนเกินออกมาเป็น excess (จะกลายเป็นเงินรอใช้ของลูกค้า) | amount 20,000,000 on outstanding 18,120,000 | ผ่าน |
| E2E-577 | loans | เงินก้อนเล็กมาก (1 LAK) ต้องตัดที่ส่วนแรกที่ยังค้าง = ดอกเบี้ย | amount 1 | ผ่าน |
| E2E-578 | loans | ค่าปรับเป็น 0 (ห้ามติดลบเป็นฐานกระจายเงิน): ตัดเงินต้นค้างครบ ที่เหลือเกินเป็น excess | amount 600,000 on LN-TST-000017 (PENALTY 0, PAST_PRINCIPAL 312,000) | ผ่าน |
| E2E-579 | loans | loan ที่ปิดแล้ว: allocation เป็น 0 ทั้งหมด และ excess = จำนวนเงิน | amount 1,000 on CLOSED LN-TST-000002 | ผ่าน |
| E2E-580 | loans | preview ตรงกับ oracle ที่คำนวณอิสระทุกกรณี (25 ชุดยอด x loan) | oracle.allocateComponents vs API | ผ่าน |
| E2E-581 | loans | preview ด้วย amount="0": 400 | amount=0 | ผ่าน |
| E2E-582 | loans | preview ด้วย amount="-5": 400 | amount=-5 | ผ่าน |
| E2E-583 | loans | preview ด้วย amount="abc": 400 | amount=abc | ผ่าน |
| E2E-584 | loans | preview ด้วย amount="": 400 | amount= | ผ่าน |
| E2E-585 | loans | preview ของ loan ที่ไม่มีอยู่: 404 | 00000000-7000-4000-8000-0000000000ff | ผ่าน |
| E2E-586 | loans | VIEWER สร้าง loan ไม่ได้: 403 | test_view1 | ผ่าน |
| E2E-587 | loans | MAKER สร้าง loan + บันทึกจ่ายกู้ได้: 201 | test_op1 | ผ่าน |
| E2E-588 | loans | audit LOAN_DISBURSED ของ MAKER อ้างถึงผู้ใช้ที่สร้างจริงและลงสถานะ ACTIVE | test_op1 (id 00000000...) | ผ่าน |
| E2E-589 | loans | CHECKER สร้าง loan + บันทึกจ่ายกู้ได้: 201 | test_checker1 | ผ่าน |
| E2E-590 | loans | audit LOAN_DISBURSED ของ CHECKER อ้างถึงผู้ใช้ที่สร้างจริงและลงสถานะ ACTIVE | test_checker1 (id 00000000...) | ผ่าน |
| E2E-591 | loans | HEAD_APPROVER สร้าง loan + บันทึกจ่ายกู้ได้: 201 | test_head | ผ่าน |
| E2E-592 | loans | audit LOAN_DISBURSED ของ HEAD_APPROVER อ้างถึงผู้ใช้ที่สร้างจริงและลงสถานะ ACTIVE | test_head (id 00000000...) | ผ่าน |
| E2E-593 | loans | ลูกค้า KYC ยัง PENDING: ห้ามจ่ายเงินกู้ 422 | CUST-TST-0021 (PENDING) | ผ่าน |
| E2E-594 | loans | ลูกค้า KYC NOT_VERIFIED: 422 พร้อมระบุรหัสลูกค้า | CUST-TST-0024 | ผ่าน |
| E2E-595 | loans | KYC gate ต้องไม่เหลือแถว loan/transaction ไว้ | POST rejected by KYC gate | ผ่าน |
| E2E-596 | loans | ลูกค้า UUID ที่ไม่มีอยู่ในระบบ: 400 Customer not found | valid UUID that is not in customers | ผ่าน |
| E2E-597 | loans | ลูกค้า id ไม่ใช่ UUID: 400 validation | malformed customerId | ผ่าน |
| E2E-598 | loans | ผลิตภัณฑ์ที่ปิดใช้แล้ว (TST-INACTIVE): 400 |  | ผ่าน |
| E2E-599 | loans | ผลิตภัณฑ์ที่ไม่มีอยู่: 400 |  | ผ่าน |
| E2E-600 | loans | validation: body ว่าง -> 400 | body ว่าง | ผ่าน |
| E2E-601 | loans | validation: customerId ไม่ใช่ uuid -> 400 | customerId ไม่ใช่ uuid | ผ่าน |
| E2E-602 | loans | validation: principal เป็น string -> 400 | principal เป็น string | ผ่าน |
| E2E-603 | loans | validation: principal = 0 -> 400 | principal = 0 | ผ่าน |
| E2E-604 | loans | validation: principal ติดลบ -> 400 | principal ติดลบ | ผ่าน |
| E2E-605 | loans | validation: termValue ไม่มี termUnit -> 400 | termValue ไม่มี termUnit | ผ่าน |
| E2E-606 | loans | validation: termValue = 0 -> 400 | termValue = 0 | ผ่าน |
| E2E-607 | loans | validation: termValue เกิน 7300 -> 400 | termValue เกิน 7300 | ผ่าน |
| E2E-608 | loans | validation: termUnit ไม่อยู่ใน enum -> 400 | termUnit ไม่อยู่ใน enum | ผ่าน |
| E2E-609 | loans | validation: disbursedAt ไม่ใช่ ISO datetime -> 400 | disbursedAt ไม่ใช่ ISO datetime | ผ่าน |
| E2E-610 | loans | validation: note ยาวเกิน 1000 ตัว -> 400 | note ยาวเกิน 1000 ตัว | ผ่าน |
| E2E-611 | loans | validation: productId ไม่ใช่ uuid -> 400 | productId ไม่ใช่ uuid | ผ่าน |
| E2E-612 | loans | สร้าง loan (ผลิตภัณฑ์ 1.5%/เดือน 12 เดือน (ใช้ term จากผลิตภัณฑ์)): 201 | TST-FLAT-M12 principal 5000000 | ผ่าน |
| E2E-613 | loans | ดอกเบี้ยที่บันทึกตอนออกกู้ (ผลิตภัณฑ์ 1.5%/เดือน 12 เดือน (ใช้ term จากผลิตภัณฑ์)) = สูตร flat ตาม oracle เป๊ะถึงเซนต์ | P=5000000 rate=1.5/MONTH term=12MONTH | ผ่าน |
| E2E-614 | loans | ยอดคงค้างรวม = เงินต้น + ดอกเบี้ย flat ที่บันทึกทั้งก้อน (ผลิตภัณฑ์ 1.5%/เดือน 12 เดือน (ใช้ term จากผลิตภัณฑ์)) | loan.outstanding / currentOutstanding | ผ่าน |
| E2E-615 | loans | transaction DISBURSEMENT ถูกโพสต์ทันที (POSTED) และแยกรายส่วนครบ (ผลิตภัณฑ์ 1.5%/เดือน 12 เดือน (ใช้ term จากผลิตภัณฑ์)) | disbursementTransaction | ผ่าน |
| E2E-616 | loans | schedule ของ loan ใหม่: จำนวนงวด/เงินต้น/ดอกเบี้ย ตรงกับที่บันทึก (ผลิตภัณฑ์ 1.5%/เดือน 12 เดือน (ใช้ term จากผลิตภัณฑ์)) | GET /api/loans/:id/schedule | ผ่าน |
| E2E-617 | loans | preview ยอดเต็มของ loan ใหม่: กระจายครบทุกส่วน ไม่มีเงินเกิน (ผลิตภัณฑ์ 1.5%/เดือน 12 เดือน (ใช้ term จากผลิตภัณฑ์)) | amount 5900000 | ผ่าน |
| E2E-618 | loans | สร้าง loan (ส่ง termMonths=6 ทับ term ของผลิตภัณฑ์): 201 | TST-FLAT-M12 principal 5000000 | ผ่าน |
| E2E-619 | loans | ดอกเบี้ยที่บันทึกตอนออกกู้ (ส่ง termMonths=6 ทับ term ของผลิตภัณฑ์) = สูตร flat ตาม oracle เป๊ะถึงเซนต์ | P=5000000 rate=1.5/MONTH term=6MONTH | ผ่าน |
| E2E-620 | loans | ยอดคงค้างรวม = เงินต้น + ดอกเบี้ย flat ที่บันทึกทั้งก้อน (ส่ง termMonths=6 ทับ term ของผลิตภัณฑ์) | loan.outstanding / currentOutstanding | ผ่าน |
| E2E-621 | loans | transaction DISBURSEMENT ถูกโพสต์ทันที (POSTED) และแยกรายส่วนครบ (ส่ง termMonths=6 ทับ term ของผลิตภัณฑ์) | disbursementTransaction | ผ่าน |
| E2E-622 | loans | schedule ของ loan ใหม่: จำนวนงวด/เงินต้น/ดอกเบี้ย ตรงกับที่บันทึก (ส่ง termMonths=6 ทับ term ของผลิตภัณฑ์) | GET /api/loans/:id/schedule | ผ่าน |
| E2E-623 | loans | preview ยอดเต็มของ loan ใหม่: กระจายครบทุกส่วน ไม่มีเงินเกิน (ส่ง termMonths=6 ทับ term ของผลิตภัณฑ์) | amount 5450000 | ผ่าน |
| E2E-624 | loans | สร้าง loan (อัตรา 0.4%/สัปดาห์ 26 สัปดาห์): 201 | TST-WEEK-TERM principal 1234567 | ผ่าน |
| E2E-625 | loans | ดอกเบี้ยที่บันทึกตอนออกกู้ (อัตรา 0.4%/สัปดาห์ 26 สัปดาห์) = สูตร flat ตาม oracle เป๊ะถึงเซนต์ | P=1234567 rate=0.4/WEEK term=26WEEK | ผ่าน |
| E2E-626 | loans | ยอดคงค้างรวม = เงินต้น + ดอกเบี้ย flat ที่บันทึกทั้งก้อน (อัตรา 0.4%/สัปดาห์ 26 สัปดาห์) | loan.outstanding / currentOutstanding | ผ่าน |
| E2E-627 | loans | transaction DISBURSEMENT ถูกโพสต์ทันที (POSTED) และแยกรายส่วนครบ (อัตรา 0.4%/สัปดาห์ 26 สัปดาห์) | disbursementTransaction | ผ่าน |
| E2E-628 | loans | schedule ของ loan ใหม่: จำนวนงวด/เงินต้น/ดอกเบี้ย ตรงกับที่บันทึก (อัตรา 0.4%/สัปดาห์ 26 สัปดาห์) | GET /api/loans/:id/schedule | ผ่าน |
| E2E-629 | loans | preview ยอดเต็มของ loan ใหม่: กระจายครบทุกส่วน ไม่มีเงินเกิน (อัตรา 0.4%/สัปดาห์ 26 สัปดาห์) | amount 1362961.97 | ผ่าน |
| E2E-630 | loans | สร้าง loan (อัตรา 0.05%/วัน 90 วัน (เงินต้นที่มีเศษเซนต์)): 201 | TST-DAY-RATE principal 999999.99 | ผ่าน |
| E2E-631 | loans | ดอกเบี้ยที่บันทึกตอนออกกู้ (อัตรา 0.05%/วัน 90 วัน (เงินต้นที่มีเศษเซนต์)) = สูตร flat ตาม oracle เป๊ะถึงเซนต์ | P=999999.99 rate=0.05/DAY term=90DAY | ผ่าน |
| E2E-632 | loans | ยอดคงค้างรวม = เงินต้น + ดอกเบี้ย flat ที่บันทึกทั้งก้อน (อัตรา 0.05%/วัน 90 วัน (เงินต้นที่มีเศษเซนต์)) | loan.outstanding / currentOutstanding | ผ่าน |
| E2E-633 | loans | transaction DISBURSEMENT ถูกโพสต์ทันที (POSTED) และแยกรายส่วนครบ (อัตรา 0.05%/วัน 90 วัน (เงินต้นที่มีเศษเซนต์)) | disbursementTransaction | ผ่าน |
| E2E-634 | loans | schedule ของ loan ใหม่: จำนวนงวด/เงินต้น/ดอกเบี้ย ตรงกับที่บันทึก (อัตรา 0.05%/วัน 90 วัน (เงินต้นที่มีเศษเซนต์)) | GET /api/loans/:id/schedule | ผ่าน |
| E2E-635 | loans | preview ยอดเต็มของ loan ใหม่: กระจายครบทุกส่วน ไม่มีเงินเกิน (อัตรา 0.05%/วัน 90 วัน (เงินต้นที่มีเศษเซนต์)) | amount 1044999.99 | ผ่าน |
| E2E-636 | loans | สร้าง loan (อัตรา 18%/ปี 2 ปี): 201 | TST-YEAR-TERM principal 10000000 | ผ่าน |
| E2E-637 | loans | ดอกเบี้ยที่บันทึกตอนออกกู้ (อัตรา 18%/ปี 2 ปี) = สูตร flat ตาม oracle เป๊ะถึงเซนต์ | P=10000000 rate=18/YEAR term=2YEAR | ผ่าน |
| E2E-638 | loans | ยอดคงค้างรวม = เงินต้น + ดอกเบี้ย flat ที่บันทึกทั้งก้อน (อัตรา 18%/ปี 2 ปี) | loan.outstanding / currentOutstanding | ผ่าน |
| E2E-639 | loans | transaction DISBURSEMENT ถูกโพสต์ทันที (POSTED) และแยกรายส่วนครบ (อัตรา 18%/ปี 2 ปี) | disbursementTransaction | ผ่าน |
| E2E-640 | loans | schedule ของ loan ใหม่: จำนวนงวด/เงินต้น/ดอกเบี้ย ตรงกับที่บันทึก (อัตรา 18%/ปี 2 ปี) | GET /api/loans/:id/schedule | ผ่าน |
| E2E-641 | loans | preview ยอดเต็มของ loan ใหม่: กระจายครบทุกส่วน ไม่มีเงินเกิน (อัตรา 18%/ปี 2 ปี) | amount 13600000 | ผ่าน |
| E2E-642 | loans | สร้าง loan (ผลิตภัณฑ์ดอกเบี้ย 0% (ค่างวด = เงินต้นล้วน)): 201 | TST-NOPEN-ZERO principal 100 | ผ่าน |
| E2E-643 | loans | ดอกเบี้ยที่บันทึกตอนออกกู้ (ผลิตภัณฑ์ดอกเบี้ย 0% (ค่างวด = เงินต้นล้วน)) = สูตร flat ตาม oracle เป๊ะถึงเซนต์ | P=100 rate=0/MONTH term=3MONTH | ผ่าน |
| E2E-644 | loans | ยอดคงค้างรวม = เงินต้น + ดอกเบี้ย flat ที่บันทึกทั้งก้อน (ผลิตภัณฑ์ดอกเบี้ย 0% (ค่างวด = เงินต้นล้วน)) | loan.outstanding / currentOutstanding | ผ่าน |
| E2E-645 | loans | transaction DISBURSEMENT ถูกโพสต์ทันที (POSTED) และแยกรายส่วนครบ (ผลิตภัณฑ์ดอกเบี้ย 0% (ค่างวด = เงินต้นล้วน)) | disbursementTransaction | ผ่าน |
| E2E-646 | loans | schedule ของ loan ใหม่: จำนวนงวด/เงินต้น/ดอกเบี้ย ตรงกับที่บันทึก (ผลิตภัณฑ์ดอกเบี้ย 0% (ค่างวด = เงินต้นล้วน)) | GET /api/loans/:id/schedule | ผ่าน |
| E2E-647 | loans | preview ยอดเต็มของ loan ใหม่: กระจายครบทุกส่วน ไม่มีเงินเกิน (ผลิตภัณฑ์ดอกเบี้ย 0% (ค่างวด = เงินต้นล้วน)) | amount 100 | ผ่าน |
| E2E-648 | loans | สร้าง loan (termValue=7 + termUnit=DAY บนผลิตภัณฑ์รายเดือน (หน่วยผสม)): 201 | TST-FLAT-M12 principal 1000000 | ผ่าน |
| E2E-649 | loans | ดอกเบี้ยที่บันทึกตอนออกกู้ (termValue=7 + termUnit=DAY บนผลิตภัณฑ์รายเดือน (หน่วยผสม)) = สูตร flat ตาม oracle เป๊ะถึงเซนต์ | P=1000000 rate=1.5/MONTH term=7DAY | ผ่าน |
| E2E-650 | loans | ยอดคงค้างรวม = เงินต้น + ดอกเบี้ย flat ที่บันทึกทั้งก้อน (termValue=7 + termUnit=DAY บนผลิตภัณฑ์รายเดือน (หน่วยผสม)) | loan.outstanding / currentOutstanding | ผ่าน |
| E2E-651 | loans | transaction DISBURSEMENT ถูกโพสต์ทันที (POSTED) และแยกรายส่วนครบ (termValue=7 + termUnit=DAY บนผลิตภัณฑ์รายเดือน (หน่วยผสม)) | disbursementTransaction | ผ่าน |
| E2E-652 | loans | schedule ของ loan ใหม่: จำนวนงวด/เงินต้น/ดอกเบี้ย ตรงกับที่บันทึก (termValue=7 + termUnit=DAY บนผลิตภัณฑ์รายเดือน (หน่วยผสม)) | GET /api/loans/:id/schedule | ผ่าน |
| E2E-653 | loans | preview ยอดเต็มของ loan ใหม่: กระจายครบทุกส่วน ไม่มีเงินเกิน (termValue=7 + termUnit=DAY บนผลิตภัณฑ์รายเดือน (หน่วยผสม)) | amount 1003500 | ผ่าน |
| E2E-654 | loans | สร้าง loan (termMonths=3 + termUnit=YEAR (3 ปี)): 201 | TST-FLAT-M6 principal 2000000 | ผ่าน |
| E2E-655 | loans | ดอกเบี้ยที่บันทึกตอนออกกู้ (termMonths=3 + termUnit=YEAR (3 ปี)) = สูตร flat ตาม oracle เป๊ะถึงเซนต์ | P=2000000 rate=1.8/MONTH term=3YEAR | ผ่าน |
| E2E-656 | loans | ยอดคงค้างรวม = เงินต้น + ดอกเบี้ย flat ที่บันทึกทั้งก้อน (termMonths=3 + termUnit=YEAR (3 ปี)) | loan.outstanding / currentOutstanding | ผ่าน |
| E2E-657 | loans | transaction DISBURSEMENT ถูกโพสต์ทันที (POSTED) และแยกรายส่วนครบ (termMonths=3 + termUnit=YEAR (3 ปี)) | disbursementTransaction | ผ่าน |
| E2E-658 | loans | schedule ของ loan ใหม่: จำนวนงวด/เงินต้น/ดอกเบี้ย ตรงกับที่บันทึก (termMonths=3 + termUnit=YEAR (3 ปี)) | GET /api/loans/:id/schedule | ผ่าน |
| E2E-659 | loans | preview ยอดเต็มของ loan ใหม่: กระจายครบทุกส่วน ไม่มีเงินเกิน (termMonths=3 + termUnit=YEAR (3 ปี)) | amount 3296000 | ผ่าน |
| E2E-660 | loans | สร้าง loan (เงินต้นมาก 200,000,000): 201 | TST-FLAT-M12 principal 200000000 | ผ่าน |
| E2E-661 | loans | ดอกเบี้ยที่บันทึกตอนออกกู้ (เงินต้นมาก 200,000,000) = สูตร flat ตาม oracle เป๊ะถึงเซนต์ | P=200000000 rate=1.5/MONTH term=12MONTH | ผ่าน |
| E2E-662 | loans | ยอดคงค้างรวม = เงินต้น + ดอกเบี้ย flat ที่บันทึกทั้งก้อน (เงินต้นมาก 200,000,000) | loan.outstanding / currentOutstanding | ผ่าน |
| E2E-663 | loans | transaction DISBURSEMENT ถูกโพสต์ทันที (POSTED) และแยกรายส่วนครบ (เงินต้นมาก 200,000,000) | disbursementTransaction | ผ่าน |
| E2E-664 | loans | schedule ของ loan ใหม่: จำนวนงวด/เงินต้น/ดอกเบี้ย ตรงกับที่บันทึก (เงินต้นมาก 200,000,000) | GET /api/loans/:id/schedule | ผ่าน |
| E2E-665 | loans | preview ยอดเต็มของ loan ใหม่: กระจายครบทุกส่วน ไม่มีเงินเกิน (เงินต้นมาก 200,000,000) | amount 236000000 | ผ่าน |
| E2E-666 | loans | สร้าง loan (วันออกกู้ย้อนหลังปลายเดือน 2026-09-30): 201 | TST-FLAT-M12 principal 3000000 | ผ่าน |
| E2E-667 | loans | ดอกเบี้ยที่บันทึกตอนออกกู้ (วันออกกู้ย้อนหลังปลายเดือน 2026-09-30) = สูตร flat ตาม oracle เป๊ะถึงเซนต์ | P=3000000 rate=1.5/MONTH term=12MONTH | ผ่าน |
| E2E-668 | loans | ยอดคงค้างรวม = เงินต้น + ดอกเบี้ย flat ที่บันทึกทั้งก้อน (วันออกกู้ย้อนหลังปลายเดือน 2026-09-30) | loan.outstanding / currentOutstanding | ผ่าน |
| E2E-669 | loans | transaction DISBURSEMENT ถูกโพสต์ทันที (POSTED) และแยกรายส่วนครบ (วันออกกู้ย้อนหลังปลายเดือน 2026-09-30) | disbursementTransaction | ผ่าน |
| E2E-670 | loans | schedule ของ loan ใหม่: จำนวนงวด/เงินต้น/ดอกเบี้ย ตรงกับที่บันทึก (วันออกกู้ย้อนหลังปลายเดือน 2026-09-30) | GET /api/loans/:id/schedule | ผ่าน |
| E2E-671 | loans | preview ยอดเต็มของ loan ใหม่: กระจายครบทุกส่วน ไม่มีเงินเกิน (วันออกกู้ย้อนหลังปลายเดือน 2026-09-30) | amount 3540000 | ผ่าน |
| E2E-672 | loans | สร้าง loan (วันออกกู้ข้ามปี 2024-12-31): 201 | TST-FLAT-M6 principal 3000000 | ผ่าน |
| E2E-673 | loans | ดอกเบี้ยที่บันทึกตอนออกกู้ (วันออกกู้ข้ามปี 2024-12-31) = สูตร flat ตาม oracle เป๊ะถึงเซนต์ | P=3000000 rate=1.8/MONTH term=6MONTH | ผ่าน |
| E2E-674 | loans | ยอดคงค้างรวม = เงินต้น + ดอกเบี้ย flat ที่บันทึกทั้งก้อน (วันออกกู้ข้ามปี 2024-12-31) | loan.outstanding / currentOutstanding | ผ่าน |
| E2E-675 | loans | transaction DISBURSEMENT ถูกโพสต์ทันที (POSTED) และแยกรายส่วนครบ (วันออกกู้ข้ามปี 2024-12-31) | disbursementTransaction | ผ่าน |
| E2E-676 | loans | schedule ของ loan ใหม่: จำนวนงวด/เงินต้น/ดอกเบี้ย ตรงกับที่บันทึก (วันออกกู้ข้ามปี 2024-12-31) | GET /api/loans/:id/schedule | ผ่าน |
| E2E-677 | loans | preview ยอดเต็มของ loan ใหม่: กระจายครบทุกส่วน ไม่มีเงินเกิน (วันออกกู้ข้ามปี 2024-12-31) | amount 3324000 | ผ่าน |
| E2E-678 | loans | transaction ใหม่ทุกแถวมี 2 line (เงินต้น + ดอกเบี้ย) และผลรวม line = ยอด tx | 14 created transactions | ผ่าน |
| E2E-679 | loans | ทุกการออกกู้มี audit LOAN_DISBURSED + TRANSACTION_POSTED ครบคู่ | 14 loans | ผ่าน |
| E2E-680 | loans | audit LOAN_DISBURSED บันทึกจำนวนเงิน = เงินต้นที่กู้ | audit_logs LOAN_DISBURSED.amount vs loans.principalAmount | ผ่าน |
| E2E-681 | loans | audit TRANSACTION_POSTED บันทึกเงิน = ยอด transaction (เงินต้น+ดอกเบี้ย) | audit_logs TRANSACTION_POSTED.amount vs transaction.amount | ผ่าน |
| E2E-682 | loans | ออกกู้แล้วมี event LOAN_APPLICATION_SUBMITTED ส่งถึงอีเมลลูกค้า @test.local | 14 loans | ผ่าน |
| E2E-683 | loans | การบันทึกเงินออกกู้โพสต์ตรง ไม่ค้าง approval workflow ให้ต้องอนุมัติซ้ำ | approval_workflows referencing created loans/transactions | ผ่าน |
| E2E-684 | loans | loan ใหม่ทุกตัว: สถานะ ACTIVE, สกุลเงิน LAK และมี snapshot นโยบายค่าปรับจากผลิตภัณฑ์ | 14 loans | ผ่าน |
| E2E-685 | loans | เลข loan ตั้ง auto เป็น LN-###### และไม่ซ้ำกัน | LN-000023,LN-000034,LN-000029,LN-000031,LN-000030,LN-000035,LN-000024,LN-000027,LN-000032,LN-000033,LN-000025,LN-000026,LN-000028,LN-000022 | ผ่าน |
| E2E-686 | loans | เลขอ้างอิง transaction (FT-######) ไม่ชนกับแถวอื่นที่มีอยู่ก่อน | 14 new reference numbers | ผ่าน |
| E2E-687 | loans | disbursedAt ที่ส่งไป = ค่าที่เก็บและค่าที่อ่านกลับ (ไม่เลื่อนวัน/เดือน) | sent 2026-06-15T02:00:00.000Z | ผ่าน |
| E2E-688 | loans | งวดแรกนับจากวันออกกู้จริง (2026-06-15 -> due 2026-07-15) | schedule of the back-dated loan | ผ่าน |
| E2E-689 | loans | วันที่ออกกู้เป็นอนาคต: ต้องปฏิเสธ (422) มิฉะนั้น ledger จะมีเงินในเดือนที่ยังไม่ถึง | disbursedAt=2031-01-31 | ผ่าน |
| E2E-690 | loans | วันที่ออกกู้ย้อนหลังไกล (2015) ควรถูกจำกัด (ห้ามลง ledger ก่อนระบบมีข้อมูล) | disbursedAt=2015-01-05 | ผ่าน |
| E2E-691 | loans | ลูกค้าหนึ่งรายมี loan หลายรายการได้ และเลขไม่ซ้ำกัน | two loans, same customer/product | ผ่าน |
| E2E-692 | loans | หลังสร้าง loan: list และ aggregate รวมรายการใหม่ด้วย | GET /api/loans?limit=100 | ผ่าน |
| E2E-693 | loans | อ่าน detail ของ loan ที่สร้างใหม่ได้ทันที (มี transaction เดียวคือ DISBURSEMENT/POSTED) | LN-000037 | ผ่าน |
| E2E-694 | loans | ล้างข้อมูลทดสอบแล้ว: จำนวน loan กลับเป็นค่า seed และ aggregates ตรงกับก่อนทดสอบ | GET /api/loans?limit=100 after purge | ผ่าน |
| E2E-695 | loans | loan ที่ล้างออกแล้ว: detail 404 | fc8617e6-852e-42ca-8f40-3f63c3cbdf59 | ผ่าน |
| E2E-696 | loans | ล้างแล้วไม่มีแถวค้างในตารางอื่น (no orphan rows) | counts for created loan ids | ผ่าน |
| E2E-697 | loans | ตาราง loans มีแถว = rowCounts ใน manifest หลัง cleanup | SELECT COUNT(*) FROM loans | ผ่าน |
| E2E-698 | payments | probe: สร้าง loan และบันทึกเงินออกกู้ตรงกับ oracle (เงินต้น + ดอกเบี้ย flat) | TST-FLAT-M6 principal 500000.00 @1.8%/MONTH 6MONTH | ผ่าน |
| E2E-699 | payments | POST /api/payment-requests ด้วย role anon: 401 | token=anon | ผ่าน |
| E2E-700 | payments | POST /api/payment-requests ด้วย role viewer: 403 | token=viewer | ผ่าน |
| E2E-701 | payments | POST /api/payment-requests ด้วย role maker: 201 | token=maker | ผ่าน |
| E2E-702 | payments | POST /api/payment-requests ด้วย role checker: 201 | token=checker | ผ่าน |
| E2E-703 | payments | POST /api/payment-requests ด้วย role head: 201 | token=head | ผ่าน |
| E2E-704 | payments | POST /api/payment-requests ด้วย role admin: 201 | token=admin | ผ่าน |
| E2E-705 | payments | POST /:id/approve ด้วย role anon: 401 | request status PENDING | ผ่าน |
| E2E-706 | payments | POST /:id/approve ด้วย role viewer: 403 | request status PENDING | ผ่าน |
| E2E-707 | payments | POST /:id/approve ด้วย role maker (creator): 403 | request status PENDING | ผ่าน |
| E2E-708 | payments | POST /:id/approve ด้วย role other maker: 403 | request status PENDING | ผ่าน |
| E2E-709 | payments | POST /:id/approve ด้วย role checker: 200 | request status PENDING | ผ่าน |
| E2E-710 | payments | POST /:id/reject ด้วย role viewer: 403 | reason given | ผ่าน |
| E2E-711 | payments | POST /:id/reject ด้วย role maker: 403 | reason given | ผ่าน |
| E2E-712 | payments | POST /:id/reject ด้วย role checker: 200 | reason given | ผ่าน |
| E2E-713 | payments | POST /:id/resubmit ด้วย role anon: 401 | of a REJECTED request | ผ่าน |
| E2E-714 | payments | POST /:id/resubmit ด้วย role viewer: 403 | of a REJECTED request | ผ่าน |
| E2E-715 | payments | POST /:id/resubmit ด้วย role maker: 201 | of a REJECTED request | ผ่าน |
| E2E-716 | payments | POST /api/transactions/:id/post ด้วย role anon: 401 | APPROVED payment transaction | ผ่าน |
| E2E-717 | payments | POST /api/transactions/:id/post ด้วย role viewer: 403 | APPROVED payment transaction | ผ่าน |
| E2E-718 | payments | POST /api/transactions/:id/post ด้วย role maker: 200 | APPROVED payment transaction | ผ่าน |
| E2E-719 | payments | โพสต์จาก role probe (maker): ledger + ยอดคงค้างตรงกับ oracle 5,000 ทั้งหมดลงดอกเบี้ย | POST /api/transactions/:id/post as test_op1 | ผ่าน |
| E2E-720 | payments | GET /api/payment-requests ด้วย role viewer: 200 (read allowed) | list | ผ่าน |
| E2E-721 | payments | GET /api/payment-requests ด้วย role maker: 200 (read allowed) | list | ผ่าน |
| E2E-722 | payments | GET /api/payment-requests ด้วย role admin: 200 (read allowed) | list | ผ่าน |
| E2E-723 | payments | loanId ไม่ใช่ uuid: 400 | loanId=not-a-uuid | ผ่าน |
| E2E-724 | payments | loan ที่ไม่มีอยู่: 404 | 00000000-7000-4000-8000-0000000000ff | ผ่าน |
| E2E-725 | payments | ข้อความ error ของ 404 payment request ต้องอ่านรู้เรื่อง | POST /api/payment-requests with unknown loan | ผ่าน |
| E2E-726 | payments | cashAmount ติดลบ: 400 | cashAmount=-1 | ผ่าน |
| E2E-727 | payments | cashAmount=0 และไม่ใช้ credit: 400 ยอดชำระต้อง > 0 | cashAmount=0 | ผ่าน |
| E2E-728 | payments | cashAmount=0 + creditToApply>0 แต่ credit ไม่มี: 422 (insufficient credit) | cash 0, credit 1000, customer has no credit | ผ่าน |
| E2E-729 | payments | creditToApply ติดลบ: 400 | creditToApply=-5 | ผ่าน |
| E2E-730 | payments | note ยาว 1001 ตัวอักษร: 400 | note length 1001 | ผ่าน |
| E2E-731 | payments | ชำระเงินของ loan ที่ CLOSED แล้ว: 422 | CLOSED seed loan | ผ่าน |
| E2E-732 | payments | ชำระเงินของ loan ที่ WRITE_OFF แล้ว: 422 | WRITTEN_OFF seed loan | ผ่าน |
| E2E-733 | payments | settlementAgreementId ไม่ใช่ uuid: 400 | settlementAgreementId=x | ผ่าน |
| E2E-734 | payments | settlementAgreementId ที่ไม่มีอยู่: 404 | unknown agreement id | ผ่าน |
| E2E-735 | payments | สร้าง payment request ด้วยยอดทศนิยม: 201 | cashAmount 12345.67 | ผ่าน |
| E2E-736 | payments | requestNo ตั้งตามรูปแบบ PR-6 หลัก และไม่ชนกับเลขของข้อมูล seed | PR-000046 | ผ่าน |
| E2E-737 | payments | status ตอนสร้างต้องเป็น PENDING และบันทึก cash/credit ตามที่ส่ง | POST response request | ผ่าน |
| E2E-738 | payments | createdBy ของ request = user ที่ login (ไม่ใช่ user อื่น) | request.createdBy vs JWT id of test_op1 | ผ่าน |
| E2E-739 | payments | ใน DB: มี payment_allocations ครบ 3 รายส่วน และ finalAmount = 0 ก่อน approve | payment_allocations of the new request | ผ่าน |
| E2E-740 | payments | proposed allocation ที่ระบบ snapshot = oracle (ดอกเบี้ยก่อนเงินต้น เพราะค่าปรับยังไม่มีการเรียกเก็บ) | oracle.allocateComponents(12345.67, outstanding) | ผ่าน |
| E2E-741 | payments | response ตอนสร้างคืน proposed + allocations ครบ | POST /api/payment-requests body | ผ่าน |
| E2E-742 | payments | ยังไม่มี financial_transaction ก่อนที่ checker จะอนุมัติ (LOCKED: POSTED เท่านั้นที่เป็นหนี้จริง) | financial_transactions by sourceRequestId | ผ่าน |
| E2E-743 | payments | ตอนสร้าง request ยอดคงค้าง loan ต้องยังไม่ขยับ | loan outstanding after create only | ผ่าน |
| E2E-744 | payments | audit PAYMENT_REQUEST_CREATED ถูกเขียนพร้อมยอดรวม cash+credit และ user | audit_logs for the new request | ผ่าน |
| E2E-745 | payments | approve id ที่ไม่มีอยู่: 404 | 00000000-7000-4000-8000-0000000000ff | ผ่าน |
| E2E-746 | payments | ผู้สร้างอนุมัติเอง (checker2 สร้าง/อนุมัติ): 422 maker-checker separation | same user as creator | ผ่าน |
| E2E-747 | payments | approve ด้วย checker อื่น: 200 | reason given | ผ่าน |
| E2E-748 | payments | approve สร้าง transaction สถานะ APPROVED (ยังไม่ใช่ POSTED) ยอด = เงินสด+credit | approve response transaction | ผ่าน |
| E2E-749 | payments | approve คืน allocation เท่ากับ snapshot ที่ระบบเสนอ (ไม่มี override) | approve response allocation vs proposed | ผ่าน |
| E2E-750 | payments | finalAmount ของ payment_allocations ถูกเขียนตอน approve ตรงกับ proposed | payment_allocations after approve | ผ่าน |
| E2E-751 | payments | request เปลี่ยนเป็น APPROVED พร้อม approvedBy/approvedAt | GET /api/payment-requests/:id | ผ่าน |
| E2E-752 | payments | approve ซ้ำ: 422 (สถานะเปลี่ยนแล้วห้ามอนุมัติซ้ำ) | second approve | ผ่าน |
| E2E-753 | payments | reject หลัง approve: 422 | reject an APPROVED request | ผ่าน |
| E2E-754 | payments | payment request ใช้ single-checker verify (ไม่มี approval_workflow ของ transaction นี้) | approval_workflows by transaction id | ผ่าน |
| E2E-755 | payments | audit PAYMENT_REQUEST_APPROVEDบันทึก maker + checker คนละคน | audit_logs row of the approve | ผ่าน |
| E2E-756 | payments | หลัง approve แต่ยังไม่ post: ยอดคงค้าง loan ไม่เปลี่ยน (transaction ยังไม่ POSTED) | loan outstanding between approve and post | ผ่าน |
| E2E-757 | payments | override รวมทุกส่วนเกินยอดชำระ: 422 | sum 31000 > payment 30000 | ผ่าน |
| E2E-758 | payments | override ส่วนเงินต้นเกินยอดคงค้าง: 422 | principal allocation above outstanding | ผ่าน |
| E2E-759 | payments | override ติดลบ: 400 (zod min 0 กันไว้ก่อนชั้น business) | PENALTY=-1 | ผ่าน |
| E2E-760 | payments | override ไม่ครบทุกส่วน (ขาด PAST_PRINCIPAL): 400 | partial override object | ผ่าน |
| E2E-761 | payments | override ที่อยู่ในกรอบ (จ่ายเงินต้นก่อนดอกเบี้ย): 200 — สัมภาษณ์พนักงานเลือกได้ | PAST_PRINCIPAL 30000 of a 54,000+500,000 outstanding | ผ่าน |
| E2E-762 | payments | override ที่ได้รับอนุญาตถูกบันทึกเป็น finalAmount และ componentAmounts ของ transaction | approved transaction componentAmounts | ผ่าน |
| E2E-763 | payments | reject โดยไม่มีเหตุผล: 400 | reason missing | ผ่าน |
| E2E-764 | payments | reject ด้วยเหตุผลว่าง (str): 400 | reason="" | ผ่าน |
| E2E-765 | payments | reject โดย checker: 200 | valid reason | ผ่าน |
| E2E-766 | payments | record หลัง reject: สถานะ REJECTED +เหตุผลการปฏิเสธ + ผู้ปฏิเสธ | reject response | ผ่าน |
| E2E-767 | payments | request ที่ถูกปฏิเสธต้องไม่มี transaction ใน ledger เลย | financial_transactions of a rejected request | ผ่าน |
| E2E-768 | payments | audit PAYMENT_REQUEST_REJECTED บันทึกเหตุผลตรงกับที่ส่ง | audit_logs | ผ่าน |
| E2E-769 | payments | resubmit request ที่ยังไม่ถูกปฏิเสธ (PENDING): 422 | resubmit a PENDING request | ผ่าน |
| E2E-770 | payments | resubmit id ที่ไม่มีอยู่: 404 | 00000000-7000-4000-8000-0000000000ff | ผ่าน |
| E2E-771 | payments | resubmit request ที่ REJECTED: 201 สร้าง request ใหม่ | by another maker | ผ่าน |
| E2E-772 | payments | request ใหม่-linked ถึงของเดิมผ่าน previousRequestId และกลับเป็น PENDING | resubmit response | ผ่าน |
| E2E-773 | payments | ต้นฉบับที่ถูกรีเจกต์ต้องคงสถานะ REJECTED ตลอด (ห้ามแก้ — LOCKED: ต้นฉบับห้ามแก้) | GET original rejected request | ผ่าน |
| E2E-774 | payments | audit PAYMENT_REQUEST_RESUBMITTEDชี้กลับไปยัง request เดิม | audit_logs | ผ่าน |
| E2E-775 | payments | resubmit ซ้ำ (สถานะ PENDING แล้ว): 422 | resubmit the resubmitted request | ผ่าน |
| E2E-776 | payments | โพสต์ payment ที่ APPROVED: 200 | transaction of reqA | ผ่าน |
| E2E-777 | payments | allocation ณ ตอนโพสต์ = oracle (ตัดดอกเบี้ยก่อน เพราะค่าปรับยังไม่มี) | post response allocation | ผ่าน |
| E2E-778 | payments | ยอดคงค้าง loan ลดตามส่วนที่ตัดจริง (12,345.67 ลงดอกเบี้ยทั้งหมด เพราะค่าปรับยังไม่มี) | loan outstanding after post | ผ่าน |
| E2E-779 | payments | ledger lines ของ payment เป็นลบตามส่วนที่ตัด และมีเฉพาะส่วนที่ไม่ใช่ 0 | financial_transaction_lines of the posted payment | ผ่าน |
| E2E-780 | payments | โพสต์ซ้ำ transaction เดียวกัน: 422 (ต้อง APPROVED เท่านั้น) | second post | ผ่าน |
| E2E-781 | payments | audit TRANSACTION_POSTED มีแถวเดียว และผู้โพสต์ถูกต้อง | audit_logs TRANSACTION_POSTED | ผ่าน |
| E2E-782 | payments | โพสต์แล้วมีแถวใน notification_outbox สำหรับใบเสร็จ (PAYMENT_POSTED ของ loan นี้) | notification_outbox by loanId + type PAYMENT_POSTED | ผ่าน |
| E2E-783 | payments | pen-loan: สร้าง loan และบันทึกเงินออกกู้ตรงกับ oracle (เงินต้น + ดอกเบี้ย flat) | TST-FLAT-M12 principal 2000000.00 @1.5%/MONTH 12MONTH | ผ่าน |
| E2E-784 | payments | เรียกเก็บค่าปรับ 50,000 ผ่าน workflow: 201 สถานะ PENDING_APPROVAL | POST /api/transactions/penalties | ผ่าน |
| E2E-785 | payments | ค่าปรับ <=1M ต้องการชั้น CHECKER ชั้นเดียวและเห็นใน queue ของ checker | GET /api/approvals/pending as checker1 | ผ่าน |
| E2E-786 | payments | checker อนุมัติค่าปรับ: 200 และ transaction เป็น APPROVED | single-level workflow | ผ่าน |
| E2E-787 | payments | โพสต์ค่าปรับ: 200 ยอดคงค้างส่วน PENALTY เพิ่ม 50,000 | POST /api/transactions/:id/post | ผ่าน |
| E2E-788 | payments | หลังโพสต์ค่าปรับ: outstanding = ค่าปรับ+ดอกเบี้ย+เงินต้น ตาม ledger | loan outstanding | ผ่าน |
| E2E-789 | payments | order-1 (ค่าปรับ 50,000 ต้องถูกตัดก่อนดอกเบี้ย): การกระจายเงิน ณ ตอนโพสต์ เรียง PENALTY -> PAST_INTEREST -> PAST_PRINCIPAL ตาม oracle | cash 60000.00 + credit 0.00 | ผ่าน |
| E2E-790 | payments | order-1 (ค่าปรับ 50,000 ต้องถูกตัดก่อนดอกเบี้ย): ยอดคงค้างรายส่วนหลังโพสต์ ตรง oracle ทุกทศนิยม | GET /api/loans/:id outstanding | ผ่าน |
| E2E-791 | payments | order-1 (ค่าปรับ 50,000 ต้องถูกตัดก่อนดอกเบี้ย): สถานะ loan หลังโพสต์ = ACTIVE (ปิดเมื่อยอดค้างทุกส่วนเป็น 0) | loan.status | ผ่าน |
| E2E-792 | payments | order-1 (ค่าปรับ 50,000 ต้องถูกตัดก่อนดอกเบี้ย): ยอดที่เกิน (excess) ต้องกลายเป็น credit ตาม oracle | post result excess | ผ่าน |
| E2E-793 | payments | order-1 (ค่าปรับ 50,000 ต้องถูกตัดก่อนดอกเบี้ย): ledger lines เป็นลบตามส่วนที่ตัด และมีเฉพาะส่วนที่ไม่ใช่ 0 | financial_transaction_lines | ผ่าน |
| E2E-794 | payments | order-2 (ดอกเบี้ยที่เหลือจนหมด): การกระจายเงิน ณ ตอนโพสต์ เรียง PENALTY -> PAST_INTEREST -> PAST_PRINCIPAL ตาม oracle | cash 350000.00 + credit 0.00 | ผ่าน |
| E2E-795 | payments | order-2 (ดอกเบี้ยที่เหลือจนหมด): ยอดคงค้างรายส่วนหลังโพสต์ ตรง oracle ทุกทศนิยม | GET /api/loans/:id outstanding | ผ่าน |
| E2E-796 | payments | order-2 (ดอกเบี้ยที่เหลือจนหมด): สถานะ loan หลังโพสต์ = ACTIVE (ปิดเมื่อยอดค้างทุกส่วนเป็น 0) | loan.status | ผ่าน |
| E2E-797 | payments | order-2 (ดอกเบี้ยที่เหลือจนหมด): ยอดที่เกิน (excess) ต้องกลายเป็น credit ตาม oracle | post result excess | ผ่าน |
| E2E-798 | payments | order-2 (ดอกเบี้ยที่เหลือจนหมด): ledger lines เป็นลบตามส่วนที่ตัด และมีเฉพาะส่วนที่ไม่ใช่ 0 | financial_transaction_lines | ผ่าน |
| E2E-799 | payments | หลังชำระ 2 รอบ: ค่าปรับกับดอกเบี้ยเป็น 0 เหลือแต่เงินต้น 2,000,000 | loan outstanding | ผ่าน |
| E2E-800 | payments | order-3 (เงินต้นปิดทั้งก้อน -> CLOSED): การกระจายเงิน ณ ตอนโพสต์ เรียง PENALTY -> PAST_INTEREST -> PAST_PRINCIPAL ตาม oracle | cash 2000000.00 + credit 0.00 | ผ่าน |
| E2E-801 | payments | order-3 (เงินต้นปิดทั้งก้อน -> CLOSED): ยอดคงค้างรายส่วนหลังโพสต์ ตรง oracle ทุกทศนิยม | GET /api/loans/:id outstanding | ผ่าน |
| E2E-802 | payments | order-3 (เงินต้นปิดทั้งก้อน -> CLOSED): สถานะ loan หลังโพสต์ = CLOSED (ปิดเมื่อยอดค้างทุกส่วนเป็น 0) | loan.status | ผ่าน |
| E2E-803 | payments | order-3 (เงินต้นปิดทั้งก้อน -> CLOSED): ยอดที่เกิน (excess) ต้องกลายเป็น credit ตาม oracle | post result excess | ผ่าน |
| E2E-804 | payments | order-3 (เงินต้นปิดทั้งก้อน -> CLOSED): ledger lines เป็นลบตามส่วนที่ตัด และมีเฉพาะส่วนที่ไม่ใช่ 0 | financial_transaction_lines | ผ่าน |
| E2E-805 | payments | ปิด loan ด้วยยอดชำระพอดีทุกส่วน: สถานะ CLOSED และ outstanding = 0 | final payment result | ผ่าน |
| E2E-806 | payments | over-loan: สร้าง loan และบันทึกเงินออกกู้ตรงกับ oracle (เงินต้น + ดอกเบี้ย flat) | TST-FLAT-M12 principal 1000000.00 @1.5%/MONTH 12MONTH | ผ่าน |
| E2E-807 | payments | payable-now หลังกู้ครบทั้งสัญญา: maxPayable = dueToPay = หนี้ทั้งก้อนใน ledger | GET /api/loans/:id/payable-now | ผ่าน |
| E2E-808 | payments | ชำระเกินยอดที่ถึงกำหนด: 422 พร้อมชี้ช่อง deposit to credit | cash 1255000.00 ทั้งที่เก็บได้ 1180000.00 | ผ่าน |
| E2E-809 | payments | ข้อความ 422 บอกตัวเลขที่เก็บได้จริงและอ้างถึง auto-debit เพื่อให้ staff อธิบายลูกค้าได้ | POST /api/payment-requests เกิน due scope | ผ่าน |
| E2E-810 | payments | 422 มี details ให้ UI ยืนยันตัวเลข (maxPayable/requested/duePeriods/nextPendingPeriod) | error.details ของคำขอที่ถูก gate | ผ่าน |
| E2E-811 | payments | คำขอที่ถูก gate ต้องไม่เหลือแถวใน DB (rollback ทั้ง transaction) — กติกาใหม่ไม่สร้างหนี้ค้างครึ่งตัว | payment_requests ของ over-loan หลัง 422 | ผ่าน |
| E2E-812 | payments | deposit 75,000 (ช่องทางที่gate ชี้): สร้างคำขอ purpose DEPOSIT_TO_CREDIT — proposed allocation เป็น 0 ทุกส่วน (ไม่ตัดหนี้ใด ๆ) | POST /api/payment-requests purpose=DEPOSIT_TO_CREDIT | ผ่าน |
| E2E-813 | payments | deposit 75,000 (ช่องทางที่gate ชี้): อนุมัติ deposit -> transaction PAYMENT สถานะ APPROVED ยอด = เงินที่ฝาก | POST /api/payment-requests/:id/approve | ผ่าน |
| E2E-814 | payments | deposit 75,000 (ช่องทางที่gate ชี้): โพสต์ deposit -> allocation 0 ทุกส่วน, excess = ยอดทั้งก้อน, หนี้คงค้างไม่ขยับ | POST /api/transactions/981977e0-f490-44a3-8962-a79750485706/post | ผ่าน |
| E2E-815 | payments | เงินที่ฝากไว้กลายเป็น credit ของลูกค้า 75,000 (LOCKED section 6) | customer_credits.balance | ผ่าน |
| E2E-816 | payments | credit_ledger มีแถว ACCRUED 75,000 พร้อม balanceAfter | credit_ledger | ผ่าน |
| E2E-817 | payments | การขยับ credit มี audit ทุกรายการ (CREDIT_ACCRUED) | audit_logs credit actions | ผ่าน |
| E2E-818 | payments | payoff พอดีทุกส่วน (เงิน 75,000 ที่ฝากไว้ยังเป็น credit): การกระจายเงิน ณ ตอนโพสต์ เรียง PENALTY -> PAST_INTEREST -> PAST_PRINCIPAL ตาม oracle | cash 1180000.00 + credit 0.00 | ผ่าน |
| E2E-819 | payments | payoff พอดีทุกส่วน (เงิน 75,000 ที่ฝากไว้ยังเป็น credit): ยอดคงค้างรายส่วนหลังโพสต์ ตรง oracle ทุกทศนิยม | GET /api/loans/:id outstanding | ผ่าน |
| E2E-820 | payments | payoff พอดีทุกส่วน (เงิน 75,000 ที่ฝากไว้ยังเป็น credit): สถานะ loan หลังโพสต์ = CLOSED (ปิดเมื่อยอดค้างทุกส่วนเป็น 0) | loan.status | ผ่าน |
| E2E-821 | payments | payoff พอดีทุกส่วน (เงิน 75,000 ที่ฝากไว้ยังเป็น credit): ยอดที่เกิน (excess) ต้องกลายเป็น credit ตาม oracle | post result excess | ผ่าน |
| E2E-822 | payments | payoff พอดีทุกส่วน (เงิน 75,000 ที่ฝากไว้ยังเป็น credit): ledger lines เป็นลบตามส่วนที่ตัด และมีเฉพาะส่วนที่ไม่ใช่ 0 | financial_transaction_lines | ผ่าน |
| E2E-823 | payments | loan ที่ปิดพอดี: สถานะ CLOSED และยังมียอด credit ค้าง (ไม่ถูกนำไปปิดหนี้ loan อื่นอัตโนมัติ) | post-payoff loan + customer_credits | ผ่าน |
| E2E-824 | payments | credit-loan: สร้าง loan และบันทึกเงินออกกู้ตรงกับ oracle (เงินต้น + ดอกเบี้ย flat) | TST-NOPEN-ZERO principal 100000.00 @0%/MONTH 3MONTH | ผ่าน |
| E2E-825 | payments | credit-source-loan: สร้าง loan และบันทึกเงินออกกู้ตรงกับ oracle (เงินต้น + ดอกเบี้ย flat) | TST-FLAT-M6 principal 300000.00 @1.8%/MONTH 6MONTH | ผ่าน |
| E2E-826 | payments | credit-source deposit (+120,000): สร้างคำขอ purpose DEPOSIT_TO_CREDIT — proposed allocation เป็น 0 ทุกส่วน (ไม่ตัดหนี้ใด ๆ) | POST /api/payment-requests purpose=DEPOSIT_TO_CREDIT | ผ่าน |
| E2E-827 | payments | credit-source deposit (+120,000): อนุมัติ deposit -> transaction PAYMENT สถานะ APPROVED ยอด = เงินที่ฝาก | POST /api/payment-requests/:id/approve | ผ่าน |
| E2E-828 | payments | credit-source deposit (+120,000): โพสต์ deposit -> allocation 0 ทุกส่วน, excess = ยอดทั้งก้อน, หนี้คงค้างไม่ขยับ | POST /api/transactions/b5ebcc1d-8ced-4ddd-b89d-573a2fc72572/post | ผ่าน |
| E2E-829 | payments | ลูกค้า C5 มี credit จากการฝากเข้า credit ของ loan แรก 120,000 | customer_credits.balance for C5 | ผ่าน |
| E2E-830 | payments | ขอใช้ credit เกินยอดที่มี: 422 | creditToApply 200,000 บนหนี้ 332,400 ขณะที่ credit คงเหลือ 120,000 | ผ่าน |
| E2E-831 | payments | ชำระเงินด้วย credit ล้วน (เงินสด 0): 201 | cash 0 + credit 100000 | ผ่าน |
| E2E-832 | payments | approve payment ที่ใช้ credit ล้วน: 200 | credit-only request | ผ่าน |
| E2E-833 | payments | โพสต์ payment ที่ใช้ credit ล้วน: 200 | post | ผ่าน |
| E2E-834 | payments | payment แบบใช้ credit อย่างเดียว: tx.amount = ยอดที่ใช้ credit และ allocation ครบตามลำดับ | posted transaction | ผ่าน |
| E2E-835 | payments | credit_ledger ของ C5: ACCRUED 120,000 แล้ว USED 100,000 -> เหลือ credit 20,000 | credit_ledger rows | ผ่าน |
| E2E-836 | payments | loan ที่ปิดด้วย credit อย่างเดียว: outstanding 0 สถานะ CLOSED | loan after credit-only payment | ผ่าน |
| E2E-837 | payments | race-loan: สร้าง loan และบันทึกเงินออกกู้ตรงกับ oracle (เงินต้น + ดอกเบี้ย flat) | TST-FLAT-M6 principal 600000.00 @1.8%/MONTH 6MONTH | ผ่าน |
| E2E-838 | payments | อนุมัติ 2 request บน loan เดียวกันก่อนโพสต์ (ทั้งสอง 200) | request 1 full payoff | ผ่าน |
| E2E-839 | payments | request ที่สอง (100,000) อนุมัติได้ เพราะยอดยังไม่ลด | request 2 | ผ่าน |
| E2E-840 | payments | โพสต์ request แรก (ปิดหนี้ทั้งก้อน): 200 | post full payoff | ผ่าน |
| E2E-841 | payments | โพสต์ request ที่สองบน loan ที่หมดหนี้แล้ว: ต้องไม่ตัดหนี้ซ้ำ และควรกลายเป็น credit | post of a payment approved against the old balance | ผ่าน |
| E2E-842 | payments | late-loan: สร้าง loan และบันทึกเงินออกกู้ตรงกับ oracle (เงินต้น + ดอกเบี้ย flat) | TST-FLAT-M6 principal 250000.00 @1.8%/MONTH 6MONTH | ผ่าน |
| E2E-843 | payments | late-loan payoff: การกระจายเงิน ณ ตอนโพสต์ เรียง PENALTY -> PAST_INTEREST -> PAST_PRINCIPAL ตาม oracle | cash 277000.00 + credit 0.00 | ผ่าน |
| E2E-844 | payments | late-loan payoff: ยอดคงค้างรายส่วนหลังโพสต์ ตรง oracle ทุกทศนิยม | GET /api/loans/:id outstanding | ผ่าน |
| E2E-845 | payments | late-loan payoff: สถานะ loan หลังโพสต์ = CLOSED (ปิดเมื่อยอดค้างทุกส่วนเป็น 0) | loan.status | ผ่าน |
| E2E-846 | payments | late-loan payoff: ยอดที่เกิน (excess) ต้องกลายเป็น credit ตาม oracle | post result excess | ผ่าน |
| E2E-847 | payments | late-loan payoff: ledger lines เป็นลบตามส่วนที่ตัด และมีเฉพาะส่วนที่ไม่ใช่ 0 | financial_transaction_lines | ผ่าน |
| E2E-848 | payments | approve request ที่ค้างอยู่ หลัง loan กลายเป็น CLOSED: 422 | approve after closure | ผ่าน |
| E2E-849 | payments | odd-loan: สร้าง loan และบันทึกเงินออกกู้ตรงกับ oracle (เงินต้น + ดอกเบี้ย flat) | TST-FLAT-M12 principal 333333.33 @1.5%/MONTH 12MONTH | ผ่าน |
| E2E-850 | payments | odd-1 ทศนิยม 2 ตำแหน่ง: การกระจายเงิน ณ ตอนโพสต์ เรียง PENALTY -> PAST_INTEREST -> PAST_PRINCIPAL ตาม oracle | cash 1000.01 + credit 0.00 | ผ่าน |
| E2E-851 | payments | odd-1 ทศนิยม 2 ตำแหน่ง: ยอดคงค้างรายส่วนหลังโพสต์ ตรง oracle ทุกทศนิยม | GET /api/loans/:id outstanding | ผ่าน |
| E2E-852 | payments | odd-1 ทศนิยม 2 ตำแหน่ง: สถานะ loan หลังโพสต์ = ACTIVE (ปิดเมื่อยอดค้างทุกส่วนเป็น 0) | loan.status | ผ่าน |
| E2E-853 | payments | odd-1 ทศนิยม 2 ตำแหน่ง: ยอดที่เกิน (excess) ต้องกลายเป็น credit ตาม oracle | post result excess | ผ่าน |
| E2E-854 | payments | odd-1 ทศนิยม 2 ตำแหน่ง: ledger lines เป็นลบตามส่วนที่ตัด และมีเฉพาะส่วนที่ไม่ใช่ 0 | financial_transaction_lines | ผ่าน |
| E2E-855 | payments | odd-2 ปิดด้วยยอดที่เหลือทศนิยม: การกระจายเงิน ณ ตอนโพสต์ เรียง PENALTY -> PAST_INTEREST -> PAST_PRINCIPAL ตาม oracle | cash 392333.32 + credit 0.00 | ผ่าน |
| E2E-856 | payments | odd-2 ปิดด้วยยอดที่เหลือทศนิยม: ยอดคงค้างรายส่วนหลังโพสต์ ตรง oracle ทุกทศนิยม | GET /api/loans/:id outstanding | ผ่าน |
| E2E-857 | payments | odd-2 ปิดด้วยยอดที่เหลือทศนิยม: สถานะ loan หลังโพสต์ = CLOSED (ปิดเมื่อยอดค้างทุกส่วนเป็น 0) | loan.status | ผ่าน |
| E2E-858 | payments | odd-2 ปิดด้วยยอดที่เหลือทศนิยม: ยอดที่เกิน (excess) ต้องกลายเป็น credit ตาม oracle | post result excess | ผ่าน |
| E2E-859 | payments | odd-2 ปิดด้วยยอดที่เหลือทศนิยม: ledger lines เป็นลบตามส่วนที่ตัด และมีเฉพาะส่วนที่ไม่ใช่ 0 | financial_transaction_lines | ผ่าน |
| E2E-860 | payments | GET /api/payment-requests: 200 | limit=100 | ผ่าน |
| E2E-861 | payments | pagination.total ของ list ตรงกับจำนวนแถวใน DB | GET list total vs COUNT(*) payment_requests | ผ่าน |
| E2E-862 | payments | limit=0 ต้องได้ 20 (0 -> ตกเป็นค่า default 20) | ?limit=0 | ผ่าน |
| E2E-863 | payments | limit=abc ต้องได้ 20 (ค่าที่ไม่ใช่ตัวเลข -> 20) | ?limit=abc | ผ่าน |
| E2E-864 | payments | limit=5000 ต้องได้ 100 (เกินเพดาน -> clamp ที่ 100) | ?limit=5000 | ผ่าน |
| E2E-865 | payments | limit=-3 ต้องได้ 1 (ค่าติดลบไม่ได้กลับเป็น default แต่ถูก clamp ที่ 1 (ยังปลอดภัย ไม่ crash)) | ?limit=-3 | ผ่าน |
| E2E-866 | payments | แบ่งหน้า: หน้า 1/2 ไม่ซ้ำกัน และเรียงตาม createdAt DESC | page=1 & page=2 limit=5 | ผ่าน |
| E2E-867 | payments | filter status=PENDING ตรงกับ DB และไม่มียอดสถานะอื่นปน | ?status=PENDING vs DB count | ผ่าน |
| E2E-868 | payments | filter ค่า enum ปลอม: ระบบไม่ crash (คืนทั้งชุดหรือว่าง) และตอบ 200 | ?status=NOT_A_STATUS | ผ่าน |
| E2E-869 | payments | filter loanId คืนเฉพาะ request ของ loan นั้น | ?loanId=LN-000022 | ผ่าน |
| E2E-870 | payments | GET /pending-count = จำนวน PENDING จริงใน DB | pending-count vs DB | ผ่าน |
| E2E-871 | payments | detail ของ PENDING: allocations ครบ 3 และ transaction = null | GET /api/payment-requests/PR-000054 | ผ่าน |
| E2E-872 | payments | detail ของ request ที่โพสต์แล้ว: คืน transaction สถานะ POSTED | GET detail of posted request | ผ่าน |
| E2E-873 | payments | detail id ปลอม: 404 | 00000000-7000-4000-8000-0000000000ff | ผ่าน |
| E2E-874 | payments | detail โดยไม่ส่ง token: 401 | no token | ผ่าน |
| E2E-875 | payments | GET /api/credits: 200 (ทุก role อ่านได้) | list | ผ่าน |
| E2E-876 | payments | GET /api/credits คืนตรงตามตาราง customer_credits | list vs DB | ผ่าน |
| E2E-877 | payments | GET /api/credits/ledger?customerId: 200 | 00000000-2000-4000-8000-000000000007 | ผ่าน |
| E2E-878 | payments | credit ledger (ACCRUED - USED) = currentBalance ที่ระบบคืน (invariant หนี้ credit) | ledger of C5 (has ACCRUED+USED) | ผ่าน |
| E2E-879 | payments | ledger ของ C5 ผ่าน API: ACCRUED + USED และ balance 20,000 ที่เหลือจากใช้ credit ปิด loan | C5 ledger | ผ่าน |
| E2E-880 | payments | GET /api/credits/ledger โดยไม่มี customerId: 400 | no query | ผ่าน |
| E2E-881 | payments | ledger ของลูกค้าที่ไม่มีอยู่: 200 + ว่าง + balance 0 (ไม่ใช่ 404) | unknown customerId | ผ่าน |
| E2E-882 | payments | suite นี้ไม่แตะ credit ของข้อมูล seed (CUST-TST-0003 ยัง 160,000) | seeded credit balance | ผ่าน |
| E2E-883 | payments | transaction ที่ approve แต่ไม่โพสต์: คง APPROVED, postedAt NULL, ไม่กระทบยอดคงค้าง | financial_transactions row of the unposted override approval | ผ่าน |
| E2E-884 | payments | หลัง purge: จำนวนแถวทุกตารางกลับเท่าก่อนเริ่ม suite | row counts before vs after | ผ่าน |
| E2E-885 | payments | ข้อมูล seed ยังครบ 21 loan และ aggregates คืนค่าเท่าเดิม | GET /api/loans after cleanup | ผ่าน |
| E2E-886 | payments | loan ของ suite หายไปจริงหลัง purge: 404 | deea1eed-b371-4c2f-a575-0e82eb75ce99 | ผ่าน |
| E2E-887 | payments | ไม่เหลือแถวกำพร้า (lines/allocations) หลังลบข้อมูลของ suite | orphan financial_transaction_lines + payment_allocations | ผ่าน |
| E2E-888 | posting | POST /transactions/penalties بدون token: 401 (ไม่ใช่ 403) | anonymous | ผ่าน |
| E2E-889 | posting | POST /transactions/penalties ด้วย VIEWER: 403 | viewer | ผ่าน |
| E2E-890 | posting | POST /transactions/penalties/accrue بدون token: 401 (ไม่ใช่ 403) | anonymous | ผ่าน |
| E2E-891 | posting | POST /transactions/penalties/accrue ด้วย VIEWER: 403 | viewer | ผ่าน |
| E2E-892 | posting | POST /transactions/waivers بدون token: 401 (ไม่ใช่ 403) | anonymous | ผ่าน |
| E2E-893 | posting | POST /transactions/waivers ด้วย VIEWER: 403 | viewer | ผ่าน |
| E2E-894 | posting | POST /transactions/write-offs بدون token: 401 (ไม่ใช่ 403) | anonymous | ผ่าน |
| E2E-895 | posting | POST /transactions/write-offs ด้วย VIEWER: 403 | viewer | ผ่าน |
| E2E-896 | posting | POST /transactions/adjustments بدون token: 401 (ไม่ใช่ 403) | anonymous | ผ่าน |
| E2E-897 | posting | POST /transactions/adjustments ด้วย VIEWER: 403 | viewer | ผ่าน |
| E2E-898 | posting | penalties amount <= 0: 400 | amount=0 | ผ่าน |
| E2E-899 | posting | penalties ไม่มี reason: 400 | no reason | ผ่าน |
| E2E-900 | posting | penalties loanId ไม่ใช่ uuid: 400 | loanId=not-a-uuid | ผ่าน |
| E2E-901 | posting | penalties บน loan ที่ไม่มีจริง: 404 | unknown loan id | ผ่าน |
| E2E-902 | posting | waiver ทุก component = 0: 400 | sum = 0 | ผ่าน |
| E2E-903 | posting | adjustment ทุก component = 0: 400 | sum of magnitudes = 0 | ผ่าน |
| E2E-904 | posting | waiver เกินยอดคงค้าง: 422 | PAST_PRINCIPAL 99,999,999 | ผ่าน |
| E2E-905 | posting | adjustment ที่ทำให้ component ติดลบ: 422 | PENALTY −1 บน loan ที่ไม่มีค่าปรับ | ผ่าน |
| E2E-906 | posting | reversal ของ txn ที่ไม่มีจริง: 404 | unknown reference id | ผ่าน |
| E2E-907 | posting | penalty <= checkerThreshold (500000.00): requiredLevels=CHECKER และ txn PENDING_APPROVAL | amount 500000.00 | ผ่าน |
| E2E-908 | posting | penalty <= checkerThreshold ที่ reject ไม่แตะยอดคงค้าง | loan outstanding | ผ่าน |
| E2E-909 | posting | penalty <= headThreshold (5000000.00): requiredLevels=CHECKER+HEAD และ txn PENDING_APPROVAL | amount 5000000.00 | ผ่าน |
| E2E-910 | posting | penalty <= headThreshold ที่ reject ไม่แตะยอดคงค้าง | loan outstanding | ผ่าน |
| E2E-911 | posting | penalty > headThreshold (20000000.00): requiredLevels=CHECKER+HEAD+ADMIN และ txn PENDING_APPROVAL | amount 20000000.00 | ผ่าน |
| E2E-912 | posting | penalty > headThreshold ที่ reject ไม่แตะยอดคงค้าง | loan outstanding | ผ่าน |
| E2E-913 | posting | maker ไม่มี step ให้ตัดสินใจงานของตัวเอง (pending list ไม่ให้สิทธิ์) | GET /api/approvals/pending as test_op1 | ผ่าน |
| E2E-914 | posting | VIEWER ตัดสินใจ approval step: 403 | viewer | ผ่าน |
| E2E-915 | posting | HEAD จะข้ามขั้น CHECKER ไม่ได้ | decide the CHECKER step as head | ผ่าน |
| E2E-916 | posting | REJECT โดยไม่มีเหตุผล: 400 | decision=REJECT without reason | ผ่าน |
| E2E-917 | posting | CHECKER ตัดสินใจ step ของตัวเอง: 200 | decision=APPROVE | ผ่าน |
| E2E-918 | posting | ตัดสินใจ step เดิมซ้ำ: 409 | same stepId twice | ผ่าน |
| E2E-919 | posting | โพสต์หลังอนุมัติครบ: 200 | POST /:id/post | ผ่าน |
| E2E-920 | posting | penalty manual 100,000: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | PENALTY on LN-000022 | ผ่าน |
| E2E-921 | posting | penalty manual 100,000: สถานะ loan = ACTIVE ตามกฎปิดบัญชี (ทุกส่วนต้องเป็น 0) | loan.status after post | ผ่าน |
| E2E-922 | posting | penalty manual 100,000: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย (บวก=เพิ่มหนี้, ลบ=ลดหนี้) | financial_transaction_lines | ผ่าน |
| E2E-923 | posting | โพสต์ซ้ำ (idempotency): ต้องถูกปฏิเสธ และไม่มี line ซ้ำ | POST /api/transactions/:id/post x2 | ผ่าน |
| E2E-924 | posting | REJECT พร้อมเหตุผล: 200 | decision=REJECT + reason | ผ่าน |
| E2E-925 | posting | txn ที่ reject: REJECTED + workflow REJECTED + เก็บเหตุผลไว้ | GET /api/transactions/:id | ผ่าน |
| E2E-926 | posting | txn ที่ reject ไม่แตะยอดคงค้างเลย (invariant #1: POSTED เท่านั้นคือความจริง) | outstanding after a rejected waiver of 50,000 | ผ่าน |
| E2E-927 | posting | post txn ที่ reject แล้ว: 422 | POST /:id/post on REJECTED | ผ่าน |
| E2E-928 | posting | txn ที่ reject ไม่มี ledger line เลย | lines of the rejected waiver | ผ่าน |
| E2E-929 | posting | accrue ก่อนถึงวันครบกำหนด: 422 ไม่มีค่าปรับให้เรียกเก็บ | asOf one day after disbursement | ผ่าน |
| E2E-930 | posting | ผลิตภัณฑ์ penaltyMode=NONE: accrue ไม่ได้แม้ loan ค้างชำระ | LN-000025 overdue, policy NONE | ผ่าน |
| E2E-931 | posting | schedule เสนอค่าปรับ FIXED_PER_PERIOD = 25,000.00 (5,000/วัน x 5 วันหลัง grace 3 วัน) | GET LN-000023 schedule asOf 2026-10-13 | ผ่าน |
| E2E-932 | posting | accrue บน loan ที่ค้างจริง: 201 | asOf 2026-10-13T00:00:00.000Z | ผ่าน |
| E2E-933 | posting | จำนวนที่ accrue = ค่าที่ระบบเสนอใน schedule (ไม่ได้เดายอดเอง) | transaction.amount vs totals.penaltySuggested | ผ่าน |
| E2E-934 | posting | accrual ที่อนุมัติครบแล้วโพสต์ได้: 200 | POST /:id/post | ผ่าน |
| E2E-935 | posting | accrual FIXED 25,000: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | PENALTY on LN-000023 | ผ่าน |
| E2E-936 | posting | accrual FIXED 25,000: สถานะ loan = ACTIVE ตามกฎปิดบัญชี (ทุกส่วนต้องเป็น 0) | loan.status after post | ผ่าน |
| E2E-937 | posting | accrual FIXED 25,000: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย (บวก=เพิ่มหนี้, ลบ=ลดหนี้) | financial_transaction_lines | ผ่าน |
| E2E-938 | posting | accrue ซ้ำที่ asOf เดิม: ไม่เกิด billed ซ้ำ (422 ไม่มีค่าปรับเหลือ) | second accrual, same asOf | ผ่าน |
| E2E-939 | posting | cap = 10% ของเงินต้น (10,000.00) และตัดงวดใหม่สุดออกก่อน | LN-000024 totals + per-period penaltyAccrued | ผ่าน |
| E2E-940 | posting | waive penalty 10,000: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | WAIVER on LN-000023 | ผ่าน |
| E2E-941 | posting | waive penalty 10,000: สถานะ loan = ACTIVE ตามกฎปิดบัญชี (ทุกส่วนต้องเป็น 0) | loan.status after post | ผ่าน |
| E2E-942 | posting | waive penalty 10,000: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย (บวก=เพิ่มหนี้, ลบ=ลดหนี้) | financial_transaction_lines | ผ่าน |
| E2E-943 | posting | หลัง waive ค่าปรับ: suggested = accrued − charged − relieved และไม่ออก billed ใหม่ | accrued 25000 − charged 25000 − relieved 10000 | ผ่าน |
| E2E-944 | posting | penalty manual บน loan CLOSED: 422 | seeded LN-TST-000002 (CLOSED) | ผ่าน |
| E2E-945 | posting | accrue บน loan CLOSED: 422 | seeded LN-TST-000002 (CLOSED) | ผ่าน |
| E2E-946 | posting | penalty manual บน loan WRITTEN_OFF: ต้องถูกปฏิเสธเหมือน CLOSED (F-PEN-1) | seeded LN-TST-000018 (WRITTEN_OFF) | ผ่าน |
| E2E-947 | posting | manual penalty เกิน cap ของผลิตภัณฑ์: โพสต์ไม่ผ่าน 422 ยอดคงค้างไม่ขยับ (F-PEN-2) | manual 500,000 on a product capped at 100000.00, already billed 15000.00 | ผ่าน |
| E2E-948 | posting | waive penalty ทั้งยอด: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | WAIVER on LN-000023 | ผ่าน |
| E2E-949 | posting | waive penalty ทั้งยอด: สถานะ loan = ACTIVE ตามกฎปิดบัญชี (ทุกส่วนต้องเป็น 0) | loan.status after post | ผ่าน |
| E2E-950 | posting | waive penalty ทั้งยอด: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย (บวก=เพิ่มหนี้, ลบ=ลดหนี้) | financial_transaction_lines | ผ่าน |
| E2E-951 | posting | waiver ไม่แก้ transaction ต้นฉบับ (invariant: originals immutable) | the original accrual transaction and its ledger line | ผ่าน |
| E2E-952 | posting | หลัง waive ค่าปรับหมด: PENALTY = 0 ส่วนอื่นไม่เปลี่ยน | LN-000023 | ผ่าน |
| E2E-953 | posting | ชำระ 400,000: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | PAYMENT on LN-000026 | ผ่าน |
| E2E-954 | posting | ชำระ 400,000: สถานะ loan = ACTIVE ตามกฎปิดบัญชี (ทุกส่วนต้องเป็น 0) | loan.status after post | ผ่าน |
| E2E-955 | posting | ชำระ 400,000: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย (บวก=เพิ่มหนี้, ลบ=ลดหนี้) | financial_transaction_lines | ผ่าน |
| E2E-956 | posting | reverse 150,000 บางส่วน: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | PAYMENT_REVERSAL on LN-000026 | ผ่าน |
| E2E-957 | posting | reverse 150,000 บางส่วน: สถานะ loan = ACTIVE ตามกฎปิดบัญชี (ทุกส่วนต้องเป็น 0) | loan.status after post | ผ่าน |
| E2E-958 | posting | reverse 150,000 บางส่วน: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย (บวก=เพิ่มหนี้, ลบ=ลดหนี้) | financial_transaction_lines | ผ่าน |
| E2E-959 | posting | reversal บางส่วนไล่ตามลำดับ allocation เดิม (ไม่ใช่ pro-rata) และบรรทัดเป็นบวก | original allocation {"PENALTY":0,"PAST_INTEREST":21600000,"PAST_PRINCIPAL":18400000}, reversal 150,000 | ผ่าน |
| E2E-960 | posting | reverse เกินส่วนที่ยัง reverse ได้: 422 | amount 900,000 against a 400,000 payment with 150,000 already reversed | ผ่าน |
| E2E-961 | posting | reverse transaction ที่ไม่ใช่ payment: 422 | reference a PAYMENT_REVERSAL | ผ่าน |
| E2E-962 | posting | reverse txn ที่ยัง PENDING_APPROVAL: 422 | reference a PENDING_APPROVAL transaction | ผ่าน |
| E2E-963 | posting | adjustment +50,000 เงินต้น: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | ADJUSTMENT on LN-000026 | ผ่าน |
| E2E-964 | posting | adjustment +50,000 เงินต้น: สถานะ loan = ACTIVE ตามกฎปิดบัญชี (ทุกส่วนต้องเป็น 0) | loan.status after post | ผ่าน |
| E2E-965 | posting | adjustment +50,000 เงินต้น: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย (บวก=เพิ่มหนี้, ลบ=ลดหนี้) | financial_transaction_lines | ผ่าน |
| E2E-966 | posting | payment ที่มี adjustment พิงอยู่: ห้าม reverse ตรง (ชี้ไป Adjustment Workflow) | reverse a payment that a posted ADJUSTMENT depends on | ผ่าน |
| E2E-967 | posting | write-off บางส่วน 60,000: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | WRITE_OFF on LN-000027 | ผ่าน |
| E2E-968 | posting | write-off บางส่วน 60,000: สถานะ loan = ACTIVE ตามกฎปิดบัญชี (ทุกส่วนต้องเป็น 0) | loan.status after post | ผ่าน |
| E2E-969 | posting | write-off บางส่วน 60,000: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย (บวก=เพิ่มหนี้, ลบ=ลดหนี้) | financial_transaction_lines | ผ่าน |
| E2E-970 | posting | write-off บางส่วน: loan ยัง ACTIVE (ยังไม่ล้างทั้งบัญชี) | LN-000027 | ผ่าน |
| E2E-971 | posting | write-off เกินยอดคงค้าง: 422 | PAST_PRINCIPAL 99,999,999 | ผ่าน |
| E2E-972 | posting | write-off ยอด 0: ปฏิเสธ 400 ก่อนเข้า workflow | all components zero | ผ่าน |
| E2E-973 | posting | write-off ทั้งจำนวน (default = ยอดคงค้าง): ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | WRITE_OFF on LN-000027 | ผ่าน |
| E2E-974 | posting | write-off ทั้งจำนวน (default = ยอดคงค้าง): สถานะ loan = WRITTEN_OFF ตามกฎปิดบัญชี (ทุกส่วนต้องเป็น 0) | loan.status after post | ผ่าน |
| E2E-975 | posting | write-off ทั้งจำนวน (default = ยอดคงค้าง): ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย (บวก=เพิ่มหนี้, ลบ=ลดหนี้) | financial_transaction_lines | ผ่าน |
| E2E-976 | posting | write-off แบบไม่ระบุ component = ยอดคงค้างทุกส่วนพอดี แล้ว loan เป็น WRITTEN_OFF | POST /write-offs without componentAmounts | ผ่าน |
| E2E-977 | posting | write-off reversal 200,000: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | WRITE_OFF_REVERSAL on LN-000027 | ผ่าน |
| E2E-978 | posting | write-off reversal 200,000: สถานะ loan = ACTIVE ตามกฎปิดบัญชี (ทุกส่วนต้องเป็น 0) | loan.status after post | ผ่าน |
| E2E-979 | posting | write-off reversal 200,000: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย (บวก=เพิ่มหนี้, ลบ=ลดหนี้) | financial_transaction_lines | ผ่าน |
| E2E-980 | posting | write-off reversal ที่ยังมียอดคงค้างใหม่: loan กลับเป็น ACTIVE | LN-000027 | ผ่าน |
| E2E-981 | posting | write-off reversal เกินจำนวนที่ล้างไว้: 422 | amount 99,999,999 | ผ่าน |
| E2E-982 | posting | write-off reversal โดยชี้ txn ที่ไม่ใช่ write-off: 422 | reference a POSTED payment | ผ่าน |
| E2E-983 | posting | adjustment −20,000 ดอกเบี้ย: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | ADJUSTMENT on LN-000022 | ผ่าน |
| E2E-984 | posting | adjustment −20,000 ดอกเบี้ย: สถานะ loan = ACTIVE ตามกฎปิดบัญชี (ทุกส่วนต้องเป็น 0) | loan.status after post | ผ่าน |
| E2E-985 | posting | adjustment −20,000 ดอกเบี้ย: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย (บวก=เพิ่มหนี้, ลบ=ลดหนี้) | financial_transaction_lines | ผ่าน |
| E2E-986 | posting | adjustment +5,000 ค่าปรับ / −5,000 ดอกเบี้ย: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | ADJUSTMENT on LN-000022 | ผ่าน |
| E2E-987 | posting | adjustment +5,000 ค่าปรับ / −5,000 ดอกเบี้ย: สถานะ loan = ACTIVE ตามกฎปิดบัญชี (ทุกส่วนต้องเป็น 0) | loan.status after post | ผ่าน |
| E2E-988 | posting | adjustment +5,000 ค่าปรับ / −5,000 ดอกเบี้ย: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย (บวก=เพิ่มหนี้, ลบ=ลดหนี้) | financial_transaction_lines | ผ่าน |
| E2E-989 | posting | amount ของ adjustment = Σ\|component\| (magnitude) ไม่ใช่ net → ระดับอนุมัติถูกต้อง | PENALTY +5,000 และ PAST_INTEREST −5,000 (net 0) | ผ่าน |
| E2E-990 | posting | adjustment magnitude > 10,000,000 ต้องผ่าน 3 ระดับ | PAST_PRINCIPAL +12,000,000 | ผ่าน |
| E2E-991 | posting | อนุมัติถึงแค่ HEAD: txn ยัง PENDING_APPROVAL และ post ไม่ได้ | trail CHECKER:200 HEAD:200 | ผ่าน |
| E2E-992 | posting | txn ที่ค้างกลางทาง (อนุมัติไม่ครบระดับ) ไม่กระทบยอดคงค้างและไม่มี line | LN-000022 | ผ่าน |
| E2E-993 | posting | ชำระปิดบัญชีพอดี 554000.00: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | PAYMENT on LN-000028 | ผ่าน |
| E2E-994 | posting | ชำระปิดบัญชีพอดี 554000.00: สถานะ loan = CLOSED ตามกฎปิดบัญชี (ทุกส่วนต้องเป็น 0) | loan.status after post | ผ่าน |
| E2E-995 | posting | ชำระปิดบัญชีพอดี 554000.00: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย (บวก=เพิ่มหนี้, ลบ=ลดหนี้) | financial_transaction_lines | ผ่าน |
| E2E-996 | posting | reverse 10,000 ของรายการปิดบัญชี: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | PAYMENT_REVERSAL on LN-000028 | ผ่าน |
| E2E-997 | posting | reverse 10,000 ของรายการปิดบัญชี: สถานะ loan = ACTIVE ตามกฎปิดบัญชี (ทุกส่วนต้องเป็น 0) | loan.status after post | ผ่าน |
| E2E-998 | posting | reverse 10,000 ของรายการปิดบัญชี: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย (บวก=เพิ่มหนี้, ลบ=ลดหนี้) | financial_transaction_lines | ผ่าน |
| E2E-999 | posting | reversal ที่ทำให้เกิดยอดคงค้างใหม่: loan ที่ CLOSED แล้วกลับเป็น ACTIVE | LN-000028 | ผ่าน |
| E2E-1000 | posting | ทุก loan ของ suite: ยอดคงค้าง = Σ signed lines ของ txn ที่ POSTED เท่านั้น (invariant #1) | financial_transaction_lines joined to POSTED transactions | ผ่าน |
| E2E-1001 | posting | ไม่มี ledger line ของ txn ที่ยังไม่ได้โพสต์ | lines joined to non-POSTED transactions | ผ่าน |
| E2E-1002 | posting | หลัง purge: จำนวนแถวทุกตารางกลับเท่าก่อนเริ่ม suite | row counts before vs after | ผ่าน |
| E2E-1003 | posting | ข้อมูล seed ยังครบตาม expected.json | GET /api/loans after cleanup | ผ่าน |
| E2E-1004 | posting | loan ของ suite หายไปจริงหลัง purge: 404 | 35570c98-442e-4d50-9f9a-81c6dd531aba | ผ่าน |
| E2E-1005 | posting | ไม่เหลือแถวกำพร้า (lines / workflows) หลัง purge | orphan lines + orphan approval workflows | ผ่าน |
| E2E-1006 | settlement | ทุก role ที่มีอยู่อ่าน list of settlements ได้ (200) | GET /api/settlements as each role | ผ่าน |
| E2E-1007 | settlement | ไม่มี token: 401 | no bearer | ผ่าน |
| E2E-1008 | settlement | token ปลอม: 401 | garbage bearer | ผ่าน |
| E2E-1009 | settlement | VIEWER ไม่สามารถสร้างข้อตกลง: 403 | POST /api/settlements as VIEWER | ผ่าน |
| E2E-1010 | settlement | VIEWER ไม่สามารถชำระเงินตามข้อตกลง: 403 | POST /api/settlements/00000000-8500-4000-8000-000000000001/settlement-payment as VIEWER | ผ่าน |
| E2E-1011 | settlement | VIEWER ไม่สามารถขอยกยอดขาด: 403 | POST /api/settlements/00000000-8500-4000-8000-000000000001/waive-shortfall as VIEWER | ผ่าน |
| E2E-1012 | settlement | ส่ง body ว่าง: 400 Validation failed | {} | ผ่าน |
| E2E-1013 | settlement | loanId ไม่ใช่ uuid: 400 |  | ผ่าน |
| E2E-1014 | settlement | loanId ไม่มีอยู่ในระบบ: 404 |  | ผ่าน |
| E2E-1015 | settlement | agreedAmount = 0: 400 (ต้องเป็นจำนวนบวกเท่านั้น) | 0 | ผ่าน |
| E2E-1016 | settlement | agreedAmount = -1000: 400 (ต้องเป็นจำนวนบวกเท่านั้น) | -1000 | ผ่าน |
| E2E-1017 | settlement | agreedAmount = abc: 400 (ต้องเป็นจำนวนบวกเท่านั้น) | abc | ผ่าน |
| E2E-1018 | settlement | reason ว่าง: 400 | reason '' | ผ่าน |
| E2E-1019 | settlement | reason ยาวเกิน 1000 ตัวอักษร: 400 | reason length 1001 | ผ่าน |
| E2E-1020 | settlement | agreedAmount มากกว่ายอดคงค้าง: 422 และข้อความบอกยอดทั้งสองข้าง | agreedAmount 300001 on outstanding 300000 | ผ่าน |
| E2E-1021 | settlement | ข้อตกลงบน loan สถานะ CLOSED: 422 ต้องเป็น ACTIVE เท่านั้น | POST /api/settlements on a CLOSED loan | ผ่าน |
| E2E-1022 | settlement | ข้อตกลงบน loan สถานะ WRITTEN_OFF: 422 ต้องเป็น ACTIVE เท่านั้น | POST /api/settlements on a WRITTEN_OFF loan | ผ่าน |
| E2E-1023 | settlement | agreedAmount = ยอดคงค้างพอดี: 201 (อนุญาต ไม่มียอดขาดให้ยก) | agreedAmount 300000 == outstanding | ผ่าน |
| E2E-1024 | settlement | โครงสร้าง agreement ที่ตอบกลับครบตาม entity | POST /api/settlements response data | ผ่าน |
| E2E-1025 | settlement | agreedAmount ต่ำกว่ายอดคงค้าง: 201 (ไม่มีกฎขั้นต่ำ/ส่วนลด — ที่เหลือกลายเป็นยอดขาด) | agreedAmount 1,000 on outstanding 2,216,000 | ผ่าน |
| E2E-1026 | settlement | agreedAmount ถูกปัดเป็น 2 ตำแหน่ง (round2) ก่อนเก็บ | agreedAmount 1234.567 | ผ่าน |
| E2E-1027 | settlement | loan เดียวกันมีข้อตกลง PENDING ได้หลายฉบับ (ไม่มีกฎกันซ้ำ — ข้อสังเกต F-SET-1) | second agreement on a loan that already has two | ผ่าน |
| E2E-1028 | settlement | การสร้างข้อตกลงไม่สร้าง financial transaction ใด ๆ (document ล้วน ๆ) | transaction types on suite loans after 4 agreement creations | ผ่าน |
| E2E-1029 | settlement | ข้อตกลงเข้า approval_workflows แบบ subjectType=SETTLEMENT_AGREEMENT และระดับตาม threshold | approval_workflows row of the new agreement (300,000) | ผ่าน |
| E2E-1030 | settlement | ข้อตกลงมูลค่า 500,000 (<= checkerThreshold 1,000,000): requiredLevels = CHECKER | approval_workflows.requiredLevels | ผ่าน |
| E2E-1031 | settlement | ข้อตกลงมูลค่า 2,000,000 (<= headThreshold 10,000,000): requiredLevels = CHECKER+HEAD | approval_workflows.requiredLevels | ผ่าน |
| E2E-1032 | settlement | ข้อตกลงมูลค่า 12,000,000 (> headThreshold): requiredLevels = CHECKER+HEAD+ADMIN | approval_workflows.requiredLevels | ผ่าน |
| E2E-1033 | settlement | maker ตัดสินใจขั้นตอนของคำขอตัวเอง: 422 Maker-Checker separation | checker1 approves an agreement they created | ผ่าน |
| E2E-1034 | settlement | ข้อตกลง 1,800,000 ยังไม่อนุมัติ: สถานะ PENDING_APPROVAL | SA-000013 | ผ่าน |
| E2E-1035 | settlement | คิว /approvals/pending คืนขั้นตอนปัจจุบันให้ทุก role (ไม่ได้กรองตาม role — UI ต้องกรองเอง) | pending item for the same subject as HEAD while CHECKER is the current level | ผ่าน |
| E2E-1036 | settlement | HEAD พยายามตัดสินขั้นตอนระดับ CHECKER ที่ถึงตาอยู่: 403 role cannot decide (role guard ทำงานก่อน) | HEAD decides the current CHECKER-level step | ผ่าน |
| E2E-1037 | settlement | ข้ามไปตัดสินขั้นตอน HEAD ก่อนถึงตา: 409 waiting for CHECKER | HEAD decides the HEAD-level step while currentLevel is CHECKER | ผ่าน |
| E2E-1038 | settlement | ตัดสินขั้นเดิมซ้ำ: 409 already been decided | same stepId twice | ผ่าน |
| E2E-1039 | settlement | CHECKER พยายามตัดสินขั้นตอน HEAD ที่ถึงตาแล้ว: 403 role cannot decide | checker1 decides the HEAD level step | ผ่าน |
| E2E-1040 | settlement | REJECT โดยไม่ใส่ reason: 400 | REJECT without reason | ผ่าน |
| E2E-1041 | settlement | ขั้น CHECKER ผ่านแล้ว workflow ยังเปิด (currentLevelIndex เลื่อนไป HEAD) | workflow after first approval | ผ่าน |
| E2E-1042 | settlement | REJECT ทำ agreement เป็น REJECTED พร้อม decidedBy/decidedAt/decisionReason | GET /api/settlements/:id after rejection | ผ่าน |
| E2E-1043 | settlement | ข้อตกลงที่ถูกปฏิเสธ: ห้ามรับชำระเงิน (422 must be APPROVED first) | settlement-payment on a REJECTED agreement | ผ่าน |
| E2E-1044 | settlement | workflow ที่ปิดแล้ว: ตัดสินเพิ่มไม่ได้ 409 | decide a step of a rejected workflow | ผ่าน |
| E2E-1045 | settlement | ชำระเงินตามข้อตกลงที่ยัง PENDING_APPROVAL: 422 | agreement still pending | ผ่าน |
| E2E-1046 | settlement | agreement id ไม่รู้จัก: 404 |  | ผ่าน |
| E2E-1047 | settlement | cashAmount ติดลบ: 400 (zod min 0) | cashAmount -1 | ผ่าน |
| E2E-1048 | settlement | cash + credit = 0: 400 "Settlement payment amount must be greater than zero" | cashAmount 0 with a REJECTED agreement on an ACTIVE loan | ผ่าน |
| E2E-1049 | settlement | ข้อตกลง 1,500,000 อนุมัติครบ 2 ระดับแล้ว | newAgreement(A2, 1500000) | ผ่าน |
| E2E-1050 | settlement | อนุมัติ agreement ไม่ขยับเงิน: ยอดคงค้างเท่าเดิมก่อนชำระเงิน (locked: ข้อตกลงไม่ใช่รายการการเงิน) | loan outstanding before/after agreement approval | ผ่าน |
| E2E-1051 | settlement | ชำระเงินมากกว่า agreedAmount: 422 exceeds the agreed amount | cashAmount 1,500,001 vs agreed 1,500,000 | ผ่าน |
| E2E-1052 | settlement | ใช้ credit ลูกค้าเมื่อไม่มีวงเงิน: 422 Insufficient customer credit | creditToApply 100,000 on a customer with no credit | ผ่าน |
| E2E-1053 | settlement | เอารหัส agreement ของ loan อื่นมาจ่ายกับ loan นี้: 422 belongs to a different loan | POST /api/payment-requests with mismatched settlementAgreementId | ผ่าน |
| E2E-1054 | settlement | settlement-payment สร้าง payment request พร้อม settlementAgreementId + note เริ่มต้น | POST /api/settlements/:id/settlement-payment | ผ่าน |
| E2E-1055 | settlement | proposed allocation ของ settlement payment เป็นแบบเรียงส่วน (penalty→interest→principal) | 700,000 against PENALTY=0.00 PAST_INTEREST=216000.00 PAST_PRINCIPAL=2000000.00 | ผ่าน |
| E2E-1056 | settlement | อนุมัติ settlement payment แล้วเกิด transaction ชนิด SETTLEMENT_PAYMENT (ไม่ใช่ PAYMENT) | payment request approve -> financial_transactions row | ผ่าน |
| E2E-1057 | settlement | settlement payment 700,000: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | SETTLEMENT_PAYMENT on LN-000023 | ผ่าน |
| E2E-1058 | settlement | settlement payment 700,000: สถานะ loan = ACTIVE (ปิดบัญชีเมื่อยอดคงค้างทุกส่วนเป็น 0) | loan.status after post | ผ่าน |
| E2E-1059 | settlement | settlement payment 700,000: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย | financial_transaction_lines | ผ่าน |
| E2E-1060 | settlement | โพสต์ซ้ำ: 422 Only APPROVED transactions can be posted | POST /transactions/:id/post twice | ผ่าน |
| E2E-1061 | settlement | settlement payment 800,000 (รวมครบ agreedAmount): ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | SETTLEMENT_PAYMENT on LN-000023 | ผ่าน |
| E2E-1062 | settlement | settlement payment 800,000 (รวมครบ agreedAmount): สถานะ loan = ACTIVE (ปิดบัญชีเมื่อยอดคงค้างทุกส่วนเป็น 0) | loan.status after post | ผ่าน |
| E2E-1063 | settlement | settlement payment 800,000 (รวมครบ agreedAmount): ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย | financial_transaction_lines | ผ่าน |
| E2E-1064 | settlement | GET /api/settlements/:id แสดง paymentRequests และ transactions ที่เชื่อมกันครบ | SA-000017 | ผ่าน |
| E2E-1065 | settlement | transactions ที่เชื่อม agreement มี settlementAgreementId ตรงกันทุกรายการ | financial_transactions of the agreement | ผ่าน |
| E2E-1066 | settlement | waive-shortfall บน agreement ที่ยังไม่ APPROVED: 422 ระบุสถานะปัจจุบัน | waive on PENDING_APPROVAL agreement | ผ่าน |
| E2E-1067 | settlement | path ผิดของ agreement (ไม่มี route นี้): 404 | POST /api/settlements/:id | ผ่าน |
| E2E-1068 | settlement | VIEWER ขอ waive-shortfall: 403 |  | ผ่าน |
| E2E-1069 | settlement | waive-shortfall โดย reason ว่าง: 400 | reason '' | ผ่าน |
| E2E-1070 | settlement | ยังไม่ชำระเงินตามข้อตกลง: waive ได้แต่ "ยอดที่จ่ายจริง (0) ต่ำกว่ายอดที่ข้อตกลงเรียก (agreed + ค่าปรับ)" = 422 | waive right after approval, nothing posted | ผ่าน |
| E2E-1071 | settlement | settlement payment 250,000 (จ่ายไม่ครบ agreed): ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | SETTLEMENT_PAYMENT on LN-000024 | ผ่าน |
| E2E-1072 | settlement | settlement payment 250,000 (จ่ายไม่ครบ agreed): สถานะ loan = ACTIVE (ปิดบัญชีเมื่อยอดคงค้างทุกส่วนเป็น 0) | loan.status after post | ผ่าน |
| E2E-1073 | settlement | settlement payment 250,000 (จ่ายไม่ครบ agreed): ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย | financial_transaction_lines | ผ่าน |
| E2E-1074 | settlement | จ่ายไม่ครบตาม agreedAmount: waive ยังถูกปฏิเสธ พร้อมตัวเลข netPaid ที่ถูกต้อง | netPaid 250,000 vs agreed 400,000 | ผ่าน |
| E2E-1075 | settlement | settlement payment 150,000 (netPaid ครบ 400,000): ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | SETTLEMENT_PAYMENT on LN-000024 | ผ่าน |
| E2E-1076 | settlement | settlement payment 150,000 (netPaid ครบ 400,000): สถานะ loan = ACTIVE (ปิดบัญชีเมื่อยอดคงค้างทุกส่วนเป็น 0) | loan.status after post | ผ่าน |
| E2E-1077 | settlement | settlement payment 150,000 (netPaid ครบ 400,000): ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย | financial_transaction_lines | ผ่าน |
| E2E-1078 | settlement | netPaid ครบตาม agreedAmount แล้ว: waive-shortfall สร้าง WAIVER transaction PENDING_APPROVAL | POST /api/settlements/:id/waive-shortfall | ผ่าน |
| E2E-1079 | settlement | WAIVER จาก settlement มี settlementAgreementId และ reason อ้างอิงเลข agreement | financial_transactions row of the settlement waiver | ผ่าน |
| E2E-1080 | settlement | waiver ผ่าน approval แล้วโพสต์ได้: loan ปิดบัญชี (CLOSED) ยอดคงค้างเป็น 0 ทุกส่วน | LN-000024 | ผ่าน |
| E2E-1081 | settlement | waive shortfall of settlement: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | WAIVER on LN-000024 | ผ่าน |
| E2E-1082 | settlement | waive shortfall of settlement: สถานะ loan = CLOSED (ปิดบัญชีเมื่อยอดคงค้างทุกส่วนเป็น 0) | loan.status after post | ผ่าน |
| E2E-1083 | settlement | waive shortfall of settlement: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย | financial_transaction_lines | ผ่าน |
| E2E-1084 | settlement | หลัง settlement payment ครบ + waive ยอดขาด: สถานะ CLOSED และ outstanding 0.00 | LN-000024 | ผ่าน |
| E2E-1085 | settlement | waive ซ้ำเมื่อไม่มียอดขาด: 422 no outstanding shortfall | second waive-shortfall on a closed settlement | ผ่าน |
| E2E-1086 | settlement | ข้อตกลง 200,000 บนหนี้ 300,000 อนุมัติครบระดับ CHECKER | newAgreement(A1, 200000) | ผ่าน |
| E2E-1087 | settlement | settlement payment 200,000 ของ A1: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | SETTLEMENT_PAYMENT on LN-000022 | ผ่าน |
| E2E-1088 | settlement | settlement payment 200,000 ของ A1: สถานะ loan = ACTIVE (ปิดบัญชีเมื่อยอดคงค้างทุกส่วนเป็น 0) | loan.status after post | ผ่าน |
| E2E-1089 | settlement | settlement payment 200,000 ของ A1: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย | financial_transaction_lines | ผ่าน |
| E2E-1090 | settlement | reverse settlement payment 100,000: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | PAYMENT_REVERSAL on LN-000022 | ผ่าน |
| E2E-1091 | settlement | reverse settlement payment 100,000: สถานะ loan = ACTIVE (ปิดบัญชีเมื่อยอดคงค้างทุกส่วนเป็น 0) | loan.status after post | ผ่าน |
| E2E-1092 | settlement | reverse settlement payment 100,000: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย | financial_transaction_lines | ผ่าน |
| E2E-1093 | settlement | reverse settlement payment แล้ว: waive ถูกปฏิเสธเพราะ netPaid ต่ำกว่ายอดที่ข้อตกลงเรียก | netPaid = 200,000 - 100,000 = 100,000 vs agreed 200,000 | ผ่าน |
| E2E-1094 | settlement | settlement payment เพิ่ม 100,000 ให้ netPaid ครบ: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | SETTLEMENT_PAYMENT on LN-000022 | ผ่าน |
| E2E-1095 | settlement | settlement payment เพิ่ม 100,000 ให้ netPaid ครบ: สถานะ loan = ACTIVE (ปิดบัญชีเมื่อยอดคงค้างทุกส่วนเป็น 0) | loan.status after post | ผ่าน |
| E2E-1096 | settlement | settlement payment เพิ่ม 100,000 ให้ netPaid ครบ: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย | financial_transaction_lines | ผ่าน |
| E2E-1097 | settlement | เมื่อ netPaid กลับมาครบ (นับ reverse ด้วย): waive อนุญาตอีกครั้ง | waive after topping up the reversed amount | ผ่าน |
| E2E-1098 | settlement | waive ยอดคงค้างที่เหลือของ A1: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | WAIVER on LN-000022 | ผ่าน |
| E2E-1099 | settlement | waive ยอดคงค้างที่เหลือของ A1: สถานะ loan = CLOSED (ปิดบัญชีเมื่อยอดคงค้างทุกส่วนเป็น 0) | loan.status after post | ผ่าน |
| E2E-1100 | settlement | waive ยอดคงค้างที่เหลือของ A1: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย | financial_transaction_lines | ผ่าน |
| E2E-1101 | settlement | เส้นทาง reverse + ชดเชย + waive: A1 ปิดบัญชีด้วยยอดคงค้าง 0 (netPaid นับเฉพาะ POSTED) | LN-000022 | ผ่าน |
| E2E-1102 | settlement | ชำระเต็มยอดด้วยเส้นทางปกติ (ปิด loan): ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | PAYMENT on LN-000026 | ผ่าน |
| E2E-1103 | settlement | ชำระเต็มยอดด้วยเส้นทางปกติ (ปิด loan): สถานะ loan = CLOSED (ปิดบัญชีเมื่อยอดคงค้างทุกส่วนเป็น 0) | loan.status after post | ผ่าน |
| E2E-1104 | settlement | ชำระเต็มยอดด้วยเส้นทางปกติ (ปิด loan): ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย | financial_transaction_lines | ผ่าน |
| E2E-1105 | settlement | loan ถูกปิดด้วยรายการอื่นไปแล้ว: settlement-payment ถูกปฏิเสธตามสถานะ loan | settlement-payment on a CLOSED loan | ผ่าน |
| E2E-1106 | settlement | waive 19,600,000 เพื่อให้หนี้เหลือ 4,000,000 ต่ำกว่า agreedAmount: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | WAIVER on LN-000025 | ผ่าน |
| E2E-1107 | settlement | waive 19,600,000 เพื่อให้หนี้เหลือ 4,000,000 ต่ำกว่า agreedAmount: สถานะ loan = ACTIVE (ปิดบัญชีเมื่อยอดคงค้างทุกส่วนเป็น 0) | loan.status after post | ผ่าน |
| E2E-1108 | settlement | waive 19,600,000 เพื่อให้หนี้เหลือ 4,000,000 ต่ำกว่า agreedAmount: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย | financial_transaction_lines | ผ่าน |
| E2E-1109 | settlement | ชำระเงินตามข้อตกลงมากกว่ายอดคงค้างที่เหลือ (แต่ไม่เกิน agreedAmount): รับได้ 201 | cashAmount 5,000,000 against outstanding 4,000,000 / agreed 5,000,000 | ผ่าน |
| E2E-1110 | settlement | settlement payment 5,000,000 (จ่ายเกินยอดคงค้างที่เหลือ 1,000,000): ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | SETTLEMENT_PAYMENT on LN-000025 | ผ่าน |
| E2E-1111 | settlement | settlement payment 5,000,000 (จ่ายเกินยอดคงค้างที่เหลือ 1,000,000): สถานะ loan = CLOSED (ปิดบัญชีเมื่อยอดคงค้างทุกส่วนเป็น 0) | loan.status after post | ผ่าน |
| E2E-1112 | settlement | settlement payment 5,000,000 (จ่ายเกินยอดคงค้างที่เหลือ 1,000,000): ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย | financial_transaction_lines | ผ่าน |
| E2E-1113 | settlement | โพสต์ตอบค่า excess = ส่วนที่เกินยอดคงค้าง | POST /transactions/:id/post response | ผ่าน |
| E2E-1114 | settlement | ส่วนที่เกินยอดคงค้างกลายเป็น customer credit (ACCRUED) ไม่ใช่ลบยอดหนี้ซ้ำ | credit_ledger + customer_credits of C8 after the settlement payment | ผ่าน |
| E2E-1115 | settlement | หนี้ปิดพอดีเมื่อมี agreement + waiver + payment ครบ: A4 CLOSED และยอดคงค้าง 0 (credit ไม่ลดหนี้ซ้ำ) | LN-000025 | ผ่าน |
| E2E-1116 | settlement | ผลิตภัณฑ์ตั้ง earlySettlementFeePercent ได้ และค่าที่เก็บใน DB เท่ากับที่ส่ง | POST /api/loan-products code=TST-S08-FEE earlySettlementFeePercent=2.5 | ผ่าน |
| E2E-1117 | settlement | audit ของการสร้างผลิตภัณฑ์ระบุค่าปรับปิดก่อนกำหนด ทำให้อ่าน trail ได้โดยไม่ต้อง lookup | audit_logs LOAN_PRODUCT_CREATED ของ TST-S08-FEE | ผ่าน |
| E2E-1118 | settlement | earlySettlementFeePercent = -1: 400 (zod 0..100) | earlySettlementFeePercent=-1 | ผ่าน |
| E2E-1119 | settlement | earlySettlementFeePercent = 101: 400 (zod 0..100) | earlySettlementFeePercent=101 | ผ่าน |
| E2E-1120 | settlement | loan แช่แข็งเปอร์เซ็นต์ค่าปรับจากผลิตภัณฑ์ไว้ตอนปล่อยกู้ | POST /api/loans บน TST-S08-FEE | ผ่าน |
| E2E-1121 | settlement | ADMIN แก้เปอร์เซ็นต์ค่าปรับของผลิตภัณฑ์เป็น 9%: 200 | earlySettlementFeePercent=9 | ผ่าน |
| E2E-1122 | settlement | ผลิตภัณฑ์ถูกตั้งใหม่เป็น 9% แล้ว แต่กู้ที่ปล่อยไว้ยังคิด 2.5% ตาม snapshot (ห้ามไปเพิ่มหนี้สัญญาที่เซ็นแล้ว) | GET /api/settlements/early-settlement-fee/{loanId} ของ LN-000027 หลัง PATCH ผลิตภัณฑ์ | ผ่าน |
| E2E-1123 | settlement | GET /settlements/early-settlement-fee กู้ที่ยังไม่ถึงกำหนด: คำนวณ % ของเงินต้นคงเหลือตรง oracle | เงินต้นคงเหลือ 1000000 @ 2.5%, งวดล่าสุดยังมาไม่ถึง | ผ่าน |
| E2E-1124 | settlement | endpoint คิดค่าปรับเป็น read-only: เรียกซ้ำกี่ครั้งก็ไม่มี agreement หรือ transaction ใหม่ | GET /api/settlements/early-settlement-fee 2 ครั้งบน F3 | ผ่าน |
| E2E-1125 | settlement | กู้ที่งวดครบทั้งสัญญาแล้ว (F2): ปิดบัญชีไม่คิดค่าปรับ เพราะการปิดตอนสิ้นสัญญาไม่ใช่การขอปิดก่อนกำหนด | GET early-settlement-fee ของ LN-000028 (ปล่อย 2026-01-05, 6 เดือน) | ผ่าน |
| E2E-1126 | settlement | ผลิตภัณฑ์ที่ไม่ได้ตั้งค่าปรับ (seed เดิม = 0): ปิดก่อนกำหนดยังไม่มีค่าปรับ ระบบไม่เก็บเพราะคอลัมน์ใหม่ | GET early-settlement-fee ของ LN-000029 (TST-FLAT-M12, งวดยังไม่ครบ) | ผ่าน |
| E2E-1127 | settlement | ทุก role ที่มี token ขอยอดปิดบัญชีพบได้ (read-only ไม่มี role guard) ส่วนผู้ไม่ login ถูกกัน | GET early-settlement-fee as VIEWER and as anonymous | ผ่าน |
| E2E-1128 | settlement | early-settlement-fee ของ loan ที่ไม่มีอยู่: 404 Loan not found | unknown loan uuid | ผ่าน |
| E2E-1129 | settlement | ข้อตกลงปิดก่อนกำหนดเก็บค่าปรับ 25000.00 ไว้กับสัญญา พร้อมยอดที่ต้องชำระรวม | POST /api/settlements agreedAmount 1060000 บน LN-000027 | ผ่าน |
| E2E-1130 | settlement | audit ของข้อตกลงบอกที่มาของค่าปรับ (เปอร์เซ็นต์ + เงินต้นที่คิด) ให้ผู้ตรวจสอบคำนวณเองได้ | audit_logs SETTLEMENT_AGREEMENT_CREATED ของ F1 | ผ่าน |
| E2E-1131 | settlement | ค่าปรับปิดก่อนกำหนดกลายเป็นรายการ PENALTY ที่ผูกกับ agreement และยังไม่โพสต์ (เข้า maker-checker เหมือนค่าปรับทั่วไป) | financial_transactions ของ F1 ชนิด PENALTY | ผ่าน |
| E2E-1132 | settlement | ห้ามชำระเงินปิดบัญชีก่อนโพสต์ค่าปรับ: 422 ระบุว่ายอดที่โพสต์แล้วคือ 0 | settlement-payment 1060000 ตอนที่ fee ยัง PENDING_APPROVAL | ผ่าน |
| E2E-1133 | settlement | ค่าปรับผ่าน approval ของ PENALTY แล้วโพสต์ได้ 200 (เส้นทางเดียวกับค่าปรับปกติ) | approve levels + POST /transactions/:feeId/post | ผ่าน |
| E2E-1134 | settlement | billed early-settlement fee: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | PENALTY on LN-000027 | ผ่าน |
| E2E-1135 | settlement | billed early-settlement fee: สถานะ loan = ACTIVE (ปิดบัญชีเมื่อยอดคงค้างทุกส่วนเป็น 0) | loan.status after post | ผ่าน |
| E2E-1136 | settlement | billed early-settlement fee: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย | financial_transaction_lines | ผ่าน |
| E2E-1137 | settlement | หลังโพสต์ค่าปรับ: เงินต้นคงเหลือยังไม่เปลี่ยน และ quotation ยังให้ตัวเลขเดิม (ค่าปรับเข้า.bucket PENALTY ไม่ใช่ต้น) | GET early-settlement-fee ของ LN-000027 หลังโพสต์ fee | ผ่าน |
| E2E-1138 | settlement | ชำระเงินปิดบัญชีเกิน agreedAmount + ค่าปรับ: 422 และข้อความระบุเพดานทั้งสองส่วน | cashAmount 1085000.01 เทียบ totalDue 1085000 | ผ่าน |
| E2E-1139 | settlement | create-time check เทียบค่าปิดบัญชีทีละฉบับ: อนุมัติค้างไว้สองฉบับพร้อมกันได้ (ยังไม่ขยับเงิน) | draft 1085000 + draft 25000 บน agreement เดียวกัน | ผ่าน |
| E2E-1140 | settlement | โพสต์ฉบับย่อยที่เท่าค่าปรับก่อน: 200 | POST /transactions/7d0ae6f6-b9f7-4097-894f-4ff301a37dee/post | ผ่าน |
| E2E-1141 | settlement | settlement payment ส่วนค่าปรับ 25,000: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | SETTLEMENT_PAYMENT on LN-000027 | ผ่าน |
| E2E-1142 | settlement | settlement payment ส่วนค่าปรับ 25,000: สถานะ loan = ACTIVE (ปิดบัญชีเมื่อยอดคงค้างทุกส่วนเป็น 0) | loan.status after post | ผ่าน |
| E2E-1143 | settlement | settlement payment ส่วนค่าปรับ 25,000: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย | financial_transaction_lines | ผ่าน |
| E2E-1144 | settlement | เงินก้อนแรกใช้ค่าปรับก่อนเงินต้น: allocation เรียง PENALTY -> PAST_INTEREST -> PAST_PRINCIPAL | จ่าย 25000 ตอนที่ PENALTY 25000.00 จากค่าปรับอยู่ในยอดคงค้าง | ผ่าน |
| E2E-1145 | settlement | เพดานตอนโพสต์นับค่าปรับรวมด้วย: ฉบับใหญ่ที่อนุมัติค้างไว้ถูกปฏิเสธเมื่อมีเงินถูกโพสต์ไปแล้ว | POST /transactions/0e18c804/post หลังโพสต์ 25000 | ผ่าน |
| E2E-1146 | settlement | การโพสต์ที่ถูกปฏิเสธไม่ขยับเงิน: ยอดคงค้างยังเท่า oracle (ไม่มี partial write) | GET /api/loans/F1 หลังโพสต์ฉบับใหญ่ล้มเหลว | ผ่าน |
| E2E-1147 | settlement | ยกยอดขาดไม่ได้ถ้ายังจ่ายไม่ครบ agreedAmount + ค่าปรับ: 422 ระบุยอดที่ต้องชำระรวม | netPaid 25000 เทียบ totalDue 1085000 | ผ่าน |
| E2E-1148 | settlement | settlement payment ส่วนที่เหลือ 1060000.00 ปิดบัญชี: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | SETTLEMENT_PAYMENT on LN-000027 | ผ่าน |
| E2E-1149 | settlement | settlement payment ส่วนที่เหลือ 1060000.00 ปิดบัญชี: สถานะ loan = CLOSED (ปิดบัญชีเมื่อยอดคงค้างทุกส่วนเป็น 0) | loan.status after post | ผ่าน |
| E2E-1150 | settlement | settlement payment ส่วนที่เหลือ 1060000.00 ปิดบัญชี: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย | financial_transaction_lines | ผ่าน |
| E2E-1151 | settlement | ฉบับสุดท้ายใช้ดอกเบี้ยแล้วจึงเงินต้น (ค่าปรับถูกใช้ไปแล้ว) และไม่มีส่วนเกินไปเป็น credit | จ่าย 1060000 บน PENALTY=0.00 PAST_INTEREST=60000.00 PAST_PRINCIPAL=1000000.00 | ผ่าน |
| E2E-1152 | settlement | จ่ายครบ agreedAmount + ค่าปรับแล้ว: F1 ปิดบัญชี (CLOSED) ยอดคงค้าง 0 โดยไม่ต้องยกยอดขาด | LN-000027 | ผ่าน |
| E2E-1153 | settlement | ปิดครบทั้งก้อนแล้ว: waive-shortfall ให้ 422 เพราะไม่มียอดขาด | waive-shortfall หลังจ่ายครบ totalDue | ผ่าน |
| E2E-1154 | settlement | ค่าปรับปิดก่อนกำหนดไม่กลายเป็น customer credit (ไม่มี overpayment เหลือจากเส้นทางนี้) | credit_ledger ของ C5 หลังปิด F1 ครบทั้งก้อน | ผ่าน |
| E2E-1155 | settlement | ข้อตกลงบนกู้ที่งวดครบทั้งสัญญา: earlySettlementFee = 0.00 | POST /api/settlements บน LN-000028 | ผ่าน |
| E2E-1156 | settlement | ข้อตกลงแบบไม่มีค่าปรับไม่สร้าง transaction PENALTY ใด ๆ (เอกสารล้วน ๆ ตามกฎเดิม) | financial_transactions ของ LN-000028 | ผ่าน |
| E2E-1157 | settlement | ปิดบัญชีเมื่อไม่มียอดค่าปรับ: รับ settlement-payment ได้ทันทีโดยไม่ต้องรอโพสต์อะไรเพิ่ม | settlement-payment 530000 บน agreement ที่ earlySettlementFee=0 | ผ่าน |
| E2E-1158 | settlement | settlement payment ปิด F2 (ไม่มีค่าปรับ): ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle | SETTLEMENT_PAYMENT on LN-000028 | ผ่าน |
| E2E-1159 | settlement | settlement payment ปิด F2 (ไม่มีค่าปรับ): สถานะ loan = CLOSED (ปิดบัญชีเมื่อยอดคงค้างทุกส่วนเป็น 0) | loan.status after post | ผ่าน |
| E2E-1160 | settlement | settlement payment ปิด F2 (ไม่มีค่าปรับ): ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย | financial_transaction_lines | ผ่าน |
| E2E-1161 | settlement | PUT /api/settlements/:id ไม่มี route (ห้ามแก้/ลบข้อตกลง): 404 | PUT /api/settlements/:id | ผ่าน |
| E2E-1162 | settlement | PATCH /api/settlements/:id ไม่มี route (ห้ามแก้/ลบข้อตกลง): 404 | PATCH /api/settlements/:id | ผ่าน |
| E2E-1163 | settlement | DELETE /api/settlements/:id ไม่มี route (ห้ามแก้/ลบข้อตกลง): 404 | DELETE /api/settlements/:id | ผ่าน |
| E2E-1164 | settlement | GET /api/settlements/:id ของ id ที่ไม่มีอยู่จริง: 404 |  | ผ่าน |
| E2E-1165 | settlement | GET /api/settlements?loanId= กรองเหลือเฉพาะของ loan นั้น | loanId=LN-000023 | ผ่าน |
| E2E-1166 | settlement | filter status=APPROVED ได้เฉพาะ APPROVED; ค่าไม่รู้จักคืนรายการว่าง (200 ไม่ใช่ 400) | status=APPROVED and status=NOT_A_STATUS | ผ่าน |
| E2E-1167 | settlement | pagination clamp: limit 500 -> 100, page 0 -> 1 | GET /api/settlements?limit=500&page=0 | ผ่าน |
| E2E-1168 | settlement | เกิด notification SETTLEMENT_REQUESTED + SETTLEMENT_DECIDED ให้ลูกค้าของ loan | LN-000023 | ผ่าน |
| E2E-1169 | settlement | เนื้อหา notification ถูกซีลในฐานข้อมูล แต่เปิดได้จริงและมีเลขสัญญาในข้อความ | SETTLEMENT_REQUESTED body | ผ่าน |
| E2E-1170 | settlement | audit trail บันทึก CREATED + APPROVED ของข้อตกลง พร้อมมูลค่าและสถานะใหม่ | audit_logs actions for the A2 agreement | ผ่าน |
| E2E-1171 | settlement | ทุก loan ของ suite (8 ฉบับ): ยอดคงค้าง = Σ signed lines ของรายการ POSTED เท่านั้น (invariant #1) | loan book vs posted ledger | ผ่าน |
| E2E-1172 | settlement | ไม่มี loan ใดมียอดคงค้างติดลบจากเส้นทาง settlement (จ่ายเกิน+ยกยอดต้องจบที่ 0) | Σ signed lines per loan | ผ่าน |
| E2E-1173 | settlement | สถานะ loan ทุกฉบับสอดคล้องกับยอดคงค้าง (0 -> CLOSED, >0 -> ACTIVE) | loans of the suite | ผ่าน |
| E2E-1174 | settlement | ข้อมูล seed: agreement ทั้ง 4 ฉบับ (SA-TST-000001..4) ไม่ถูก suite นี้แก้ | seeded settlement_agreements | ผ่าน |
| E2E-1175 | settlement | หลัง purge: จำนวนแถวทุกตารางกลับเท่าก่อนเริ่ม suite | row counts before vs after | ผ่าน |
| E2E-1176 | settlement | ข้อมูล seed ยังครบ 21 loan และยอดคงค้างรวมเท่าเดิม | GET /api/loans after cleanup | ผ่าน |
| E2E-1177 | settlement | agreement ของ suite หายจริงหลัง purge: 404 | dbd5e044-e346-45a0-9c3a-ed9b190f77b1 | ผ่าน |
| E2E-1178 | settlement | ไม่เหลือ workflow หรือ agreement กำพร้าหลัง purge | orphan SETTLEMENT_AGREEMENT workflows + orphan agreements | ผ่าน |
| E2E-1179 | reconciliation | run ทั้งสมุด: ทุก loan ของ seed (21 ฉบับ) ให้ผล MATCHED | POST /api/reconciliation/run (no loanId) | ผ่าน |
| E2E-1180 | reconciliation | บันทึกที่ MATCHED ต้อง difference = 0 ทั้งสามส่วน | records[].difference of the book run | ผ่าน |
| E2E-1181 | reconciliation | เทียบค่าที่ได้กับ expected.json ทีละ loan (21 ฉบับ) | records vs expected.loans[*].outstanding | ผ่าน |
| E2E-1182 | reconciliation | run ไม่ใช่ write operation ต่อสมุดเงิน: ไม่แก้ loan และไม่มี transaction/line ใหม่ | row counts after the book run | ผ่าน |
| E2E-1183 | reconciliation | ไม่มี token: run ถูกปฏิเสธ 401 | anonymous POST /run | ผ่าน |
| E2E-1184 | reconciliation | ไม่มี token: อ่าน records ก็ 401 | anonymous GET /records | ผ่าน |
| E2E-1185 | reconciliation | VIEWER เรียก run: 403 (เป็น read-only role สำหรับโมดูลนี้) | POST /run as VIEWER | ผ่าน |
| E2E-1186 | reconciliation | คำขอที่ถูก 403 ไม่ทิ้ง record ไว้ในตารางเลย | reconciliation_records count around the refused run | ผ่าน |
| E2E-1187 | reconciliation | ทุก role อ่านประวัติการตรวจได้ (200) | GET /records as each role | ผ่าน |
| E2E-1188 | reconciliation | loan ที่เพิ่ง disbursed: run ได้ 1 record สถานะ MATCHED และ difference = 0 | POST /run?loanId=LN-000022 | ผ่าน |
| E2E-1189 | reconciliation | computedFromHistory = Σ signed lines ของรายการ POSTED จริง (ไม่ใช่ copy ของยอดคงค้าง) | LN-000022 | ผ่าน |
| E2E-1190 | reconciliation | operationalOutstanding = ยอดคงค้างที่ loan กำลังถืออยู่ | LN-000022 | ผ่าน |
| E2E-1191 | reconciliation | record เก็บ runBy เป็น user id ที่เรียกจริง พร้อม createdAt | reconciliation_records row | ผ่าน |
| E2E-1192 | reconciliation | resolvedAt เป็น NULL เสมอ: ไม่มี endpoint ใดปิดรายการได้ (ข้อสังเกต F-REC-3) | reconciliation_records.resolvedAt | ผ่าน |
| E2E-1193 | reconciliation | run ที่ MATCHED ไม่สร้าง audit row (บันทึกเฉพาะ mismatch) | audit action RECONCILIATION_MISMATCH on LN-000022 | ผ่าน |
| E2E-1194 | reconciliation | waiver ที่ยัง PENDING_APPROVAL ไม่มีผลต่อการ reconcile (นับเฉพาะ POSTED) | run with a pending waiver of 50,000 on LN-000022 | ผ่าน |
| E2E-1195 | reconciliation | เมื่ออนุมัติ+โพสต์ waiver แล้ว reconciliation ยัง MATCHED (สองฝั่งขยับพร้อมกัน) | approve+post waiver 50,000 on LN-000022 | ผ่าน |
| E2E-1196 | reconciliation | ตั้งค่าทดสอบ: แก้ยอดคงค้างของ loan suite ด้วยมือ −50,000 (ไม่แตะข้อมูล seed) | direct UPDATE of the suite loan balance | ผ่าน |
| E2E-1197 | reconciliation | ยอดคงค้างกับ ledger ไม่ตรงกัน: ได้ MISMATCHED และ difference = operational − ledger | LN-000022 | ผ่าน |
| E2E-1198 | reconciliation | run ไม่ auto-correct: หลังพบ mismatch ยอดคงค้างของ loan ยังเหมือนเดิม | loan balances after the mismatching run | ผ่าน |
| E2E-1199 | reconciliation | mismatch สร้าง audit RECONCILIATION_MISMATCH พร้อมยอดสองฝั่ง และ amount = Σ\|difference\| | audit_logs row of the mismatch | ผ่าน |
| E2E-1200 | reconciliation | run ซ้ำบน loan เดิม: สร้าง record ใหม่ทุกครั้ง (ไม่มี dedup — ข้อสังเกต F-REC-1) | two runs in a row on the same mismatching loan | ผ่าน |
| E2E-1201 | reconciliation | adjustment ที่อนุมัติ+โพสต์แล้วขยับสองฝั่งพร้อมกัน: difference ยัง −50,000 (F-REC-2) | LN-000022 after posting a +50,000 PAST_INTEREST adjustment | ผ่าน |
| E2E-1202 | reconciliation | เมื่อ revert ยอดที่ถูกแก้ด้วยมือ: run กลับให้ MATCHED และสองฝั่งตรงกันจริง | LN-000022 | ผ่าน |
| E2E-1203 | reconciliation | ยอดคงค้างปิดรอบตรงกับตัวเลขจริง: ดอกเบี้ย billed − waiver + adjustment, เงินต้นเท่าเดิม | LN-000022 | ผ่าน |
| E2E-1204 | reconciliation | loan ดอกเบี้ย 0: MATCHED ทันทีที่ disbursed และยอดเงินต้นตรงตามสัญญา | LN-000023 | ผ่าน |
| E2E-1205 | reconciliation | run โดย MAKER คนละคนถูกบันทึก runBy ต่างกัน | reconciliation_records.runBy | ผ่าน |
| E2E-1206 | reconciliation | run ทั้งสมุดครั้งที่สอง: loan ที่ suite สร้างรวมอยู่ด้วยและ MATCHED หมด | POST /api/reconciliation/run after suite writes | ผ่าน |
| E2E-1207 | reconciliation | loanId ที่ไม่มีจริง: คืน 200 พร้อม total 0 (ไม่ใช่ 404) | POST /run?loanId=<unknown uuid> | ผ่าน |
| E2E-1208 | reconciliation | loanId ไม่ใช่ uuid: ไม่ crash ไม่ create record และไม่มีแถวแปลกปลอมค้าง | loanId=not-a-uuid | ผ่าน |
| E2E-1209 | reconciliation | GET /records คืน data เป็น array พร้อม pagination (page/limit/total) | GET /records?limit=100 | ผ่าน |
| E2E-1210 | reconciliation | pagination clamp: limit 500 -> 100, page 0 -> 1 | GET /records?limit=500&page=0 | ผ่าน |
| E2E-1211 | reconciliation | การแบ่งหน้าไม่ให้แถวซ้ำกันระหว่างหน้า และเรียงใหม่ที่สุดก่อน | page 1 vs page 2 at limit 5 | ผ่าน |
| E2E-1212 | reconciliation | filter status=MISMATCHED คืนเฉพาะ mismatch และมียอดของ loan ที่ทดสอบ | GET /records?status=MISMATCHED | ผ่าน |
| E2E-1213 | reconciliation | status ที่ไม่รู้จัก: 200 + ข้อมูลว่าง (ไม่ validate enum) | GET /records?status=NOT_A_STATUS | ผ่าน |
| E2E-1214 | reconciliation | filter loanId คืนเฉพาะ record ของ loan นั้น และให้ครบทุกครั้งที่รัน | loanId=LN-000023 | ผ่าน |
| E2E-1215 | reconciliation | GET /records/:id คืน record เดียวพร้อม JSON ทั้งสามช่อง | 2c982562-6848-43fb-a99f-cb6cc41be04d | ผ่าน |
| E2E-1216 | reconciliation | GET /records/:id ของ id ที่ไม่มี: 404 พร้อมข้อความชัดเจน | unknown record id | ผ่าน |
| E2E-1217 | reconciliation | record เป็น read-only: PUT /records/:id ไม่มี route (404) | PUT /records/:id | ผ่าน |
| E2E-1218 | reconciliation | reconciliation สร้างเฉพาะ record ไม่สร้าง transaction/line และไม่แก้ loan | transaction + line + loan counts around a whole-book run | ผ่าน |
| E2E-1219 | reconciliation | ทุก record ที่เกิดใน suite อยู่ในรายการที่จะลบ (ไม่มี record หลุดการติดตาม) | reconciliation_records not captured by this suite | ผ่าน |
| E2E-1220 | reconciliation | notification ที่เกิดใน suite ถูกลบครบ (รวมแถวที่ commit ช้ากว่า purge ครั้งแรก) | outbox rows still present after cleanup | ผ่าน |
| E2E-1221 | reconciliation | หลัง purge: จำนวนแถวทุกตารางกลับเท่าก่อนเริ่ม suite | row counts before vs after | ผ่าน |
| E2E-1222 | reconciliation | ข้อมูล seed ครบ 21 loan และยอดคงค้างรวมเท่าเดิมหลัง suite | GET /api/loans after cleanup | ผ่าน |
| E2E-1223 | reconciliation | record ของ suite หายจริงหลัง purge: 404 | 2c982562-6848-43fb-a99f-cb6cc41be04d | ผ่าน |
| E2E-1224 | reconciliation | loan ของ suite หายจริงหลัง purge: 404 | LN-000022 | ผ่าน |
| E2E-1225 | reports | รายงานรายเดือน: ไม่มี token = 401 | GET /api/reports/monthly (anonymous) | ผ่าน |
| E2E-1226 | reports | รายงานรายเดือน: บทบาท MAKER (test_op1) ถูกปฏิเสธ 403 พร้อมรายการ role ที่ต้องมี | MAKER (test_op1) | ผ่าน |
| E2E-1227 | reports | รายงานรายเดือน: บทบาท CHECKER (test_checker1) ถูกปฏิเสธ 403 พร้อมรายการ role ที่ต้องมี | CHECKER (test_checker1) | ผ่าน |
| E2E-1228 | reports | รายงานรายเดือน: บทบาท VIEWER (test_view1) ถูกปฏิเสธ 403 พร้อมรายการ role ที่ต้องมี | VIEWER (test_view1) | ผ่าน |
| E2E-1229 | reports | รายงานรายเดือน: บทบาท HEAD_APPROVER อ่านได้ 200 | HEAD_APPROVER | ผ่าน |
| E2E-1230 | reports | รายงานรายเดือน: บทบาท ADMIN อ่านได้ 200 | ADMIN | ผ่าน |
| E2E-1231 | reports | รายงานเป็น read-only เท่านั้น: POST /api/reports/monthly = 404 | POST | ผ่าน |
| E2E-1232 | reports | รายงานเป็น read-only เท่านั้น: PUT /api/reports/monthly = 404 | PUT | ผ่าน |
| E2E-1233 | reports | รายงานเป็น read-only เท่านั้น: PATCH /api/reports/monthly = 404 | PATCH | ผ่าน |
| E2E-1234 | reports | รายงานเป็น read-only เท่านั้น: DELETE /api/reports/monthly = 404 | DELETE | ผ่าน |
| E2E-1235 | reports | route ที่ไม่มีในโมดูลรายงาน: /api/reports/annual = 404 (role ผ่านก่อน แล้วจึงไม่ match path) | GET /api/reports/annual | ผ่าน |
| E2E-1236 | reports | /api/reports โดยไม่มี path ย่อย = 404 | GET /api/reports | ผ่าน |
| E2E-1237 | reports | HEAD_APPROVER เรียก route ที่ไม่มีอยู่ก็ยัง 404 (ไม่ใช่ 403 ซ้อนกัน) | HEAD + unknown path | ผ่าน |
| E2E-1238 | reports | months=0 ต้องถูก zod ปฏิเสธ 400 Validation failed | ?months=0 | ผ่าน |
| E2E-1239 | reports | months=37 ต้องถูก zod ปฏิเสธ 400 Validation failed | ?months=37 | ผ่าน |
| E2E-1240 | reports | months=-3 ต้องถูก zod ปฏิเสธ 400 Validation failed | ?months=-3 | ผ่าน |
| E2E-1241 | reports | months=1.5 ต้องถูก zod ปฏิเสธ 400 Validation failed | ?months=1.5 | ผ่าน |
| E2E-1242 | reports | months=abc ต้องถูก zod ปฏิเสธ 400 Validation failed | ?months=abc | ผ่าน |
| E2E-1243 | reports | months= (ค่าว่าง) ต้องถูก zod ปฏิเสธ 400 Validation failed | ?months= | ผ่าน |
| E2E-1244 | reports | ไม่ส่ง months = ค่าเริ่มต้น 12 เดือน และ from/to สะท้อนหน้าต่างจริง | GET /api/reports/monthly | ผ่าน |
| E2E-1245 | reports | ส่ง months ซ้ำสองค่า (Express ให้เป็น array) ไม่ crash แต่ตกกลับค่าเริ่มต้น 12 | ?months=6&months=12 | ผ่าน |
| E2E-1246 | reports | months=1 ให้แถวเดียวและ from === to === เดือนปัจจุบัน | ?months=1 | ผ่าน |
| E2E-1247 | reports | months=36 (ขอบบนของหน้าต่าง) = 200 |  | ผ่าน |
| E2E-1248 | reports | months=36 ขยายหน้าต่างย้อนถึง 2023-11 และแถวที่ไม่มีข้อมูลต้องเป็น 0 ทั้งหมด | ?months=36 | ผ่าน |
| E2E-1249 | reports | customerId ที่ไม่ใช่ uuid ต้อง 400 |  | ผ่าน |
| E2E-1250 | reports | customerId รูปแบบถูกแต่ไม่มีอยู่จริง: ตัวเลขจาก ledger เป็น 0 ทุกแถว และ header ปิดยอด 0 (ไม่ใช่ error) | ?customerId=<valid uuid, no rows> | ผ่าน |
| E2E-1251 | reports | หน้าต่างรายงานต้องอยู่เดือนเดียวกับที่ fixture สร้าง มิฉะนั้นตัวเลขเทียบกันไม่ได้ | monthKey(now UTC) vs expected.meta.to | ผ่าน |
| E2E-1252 | reports | ?months=34: ตรงกับ expected.apiRows ทุกแถว ทุกฟิลด์ (เงิน / ตัวนับ / MoM / YoY) | 34 rows vs oracle | ผ่าน |
| E2E-1253 | reports | หน้าต่าง 6 เดือนตรงกับ fixture ทั้ง header, แถว และ totals | ?months=6 | ผ่าน |
| E2E-1254 | reports | หน้าต่าง 12 เดือนตรงกับ fixture ทั้ง header, แถว และ totals | ?months=12 | ผ่าน |
| E2E-1255 | reports | หน้าต่าง 16 เดือนตรงกับ fixture ทั้ง header, แถว และ totals | ?months=16 | ผ่าน |
| E2E-1256 | reports | header: สกุลเงิน LAK และ customerId ของหน้าต่างเต็มเป็น null | data.currency / data.customerId | ผ่าน |
| E2E-1257 | reports | openingOutstanding = closing แถวแรก - outstandingDelta แถวแรก (เปิดหน้าต่างด้วย ledger ไม่ใช่ snapshot วันนี้) | rows[0] | ผ่าน |
| E2E-1258 | reports | closingOutstanding = แถวสุดท้าย = ยอดคงค้างรวมที่ oracle ล็อกไว้ | data.closingOutstanding | ผ่าน |
| E2E-1259 | reports | loanBookOutstanding = SUM(loans.currentOutstanding) จาก DB = ค่าที่ oracle ล็อกไว้ | data.loanBookOutstanding vs DB | ผ่าน |
| E2E-1260 | reports | ปิดสมุด: opening + Σ outstandingDelta ทุกแถว = loanBookOutstanding (ledger เป็นแหล่งความจริงเดียว) | opening + Σ delta over 16 rows | ผ่าน |
| E2E-1261 | reports | totals = ผลรวมของแถวในหน้าต่างเท่านั้น (ไม่มีแถวลับนอกหน้าต่างถูกปนมาบวก) | sum(rows) vs data.totals | ผ่าน |
| E2E-1262 | reports | collected รายเดือน = moneyIn - reversed ทุกแถว (reversal ไม่ถูกนับเป็นเงินสดรับ) | every row | ผ่าน |
| E2E-1263 | reports | closingOutstanding เป็น running sum ของ signed lines ต่อเนื่องทุกแถว | replay running sum from the opening balance | ผ่าน |
| E2E-1264 | reports | เดือน 2025-07: แถวรายงานตรงกับ SQL ที่คำนวณจากตาราง ledger ตรง ๆ | SQL aggregates for 2025-07 | ผ่าน |
| E2E-1265 | reports | เดือน 2026-01: แถวรายงานตรงกับ SQL ที่คำนวณจากตาราง ledger ตรง ๆ | SQL aggregates for 2026-01 | ผ่าน |
| E2E-1266 | reports | เดือน 2026-06: แถวรายงานตรงกับ SQL ที่คำนวณจากตาราง ledger ตรง ๆ | SQL aggregates for 2026-06 | ผ่าน |
| E2E-1267 | reports | เดือน 2026-07: แถวรายงานตรงกับ SQL ที่คำนวณจากตาราง ledger ตรง ๆ | SQL aggregates for 2026-07 | ผ่าน |
| E2E-1268 | reports | เดือน 2026-08: แถวรายงานตรงกับ SQL ที่คำนวณจากตาราง ledger ตรง ๆ | SQL aggregates for 2026-08 | ผ่าน |
| E2E-1269 | reports | เดือน 2026-09: แถวรายงานตรงกับ SQL ที่คำนวณจากตาราง ledger ตรง ๆ | SQL aggregates for 2026-09 | ผ่าน |
| E2E-1270 | reports | เดือน 2026-10: แถวรายงานตรงกับ SQL ที่คำนวณจากตาราง ledger ตรง ๆ | SQL aggregates for 2026-10 | ผ่าน |
| E2E-1271 | reports | filter customerId: ตัวเลขเงินและตัวนับทุกตัวในแถวมาจาก ledgerของลูกหนี้รายนั้นเท่านั้น | ?customerId=00000000-2000-4000-8000-000000000001 active months 2025-07, 2025-08, 2025-09, 2025-10, 2025-11, 2026-01 | ผ่าน |
| E2E-1272 | reports | filter customerId: loanBookOutstanding และ loansOpened ต้อง scope ตามลูกหนี้ด้วย (ข้อสังเกต F-RPT-1) | ?customerId=00000000-2000-4000-8000-000000000001 | **ไม่ผ่าน** (F-RPT-1) |
| E2E-1273 | reports | filter customerId: Σ outstandingDelta ทั้งหน้าต่าง = ยอดคงค้างสะสมของลูกหนี้รายนั้น (ปิดยอดตัวเองได้จริง) | ?customerId=00000000-2000-4000-8000-000000000001&months=34 | ผ่าน |
| E2E-1274 | reports | MoM/YoY ใช้สูตร delta() ตรงกันทุกแถว: ฐานนอกหน้าต่าง = {0,null}, ฐาน 0 = percent null, ฐานลบใช้ค่าสัมบูรณ์ | recompute every growth cell of 34 rows | ผ่าน |
| E2E-1275 | reports | ฐาน 0: MoM collected ของ 2026-01 (เดือนก่อนเก็บเงิน 0) ต้อง absolute = ยอดเดือนนั้น และ percent = null | 2026-01.mom.collected where 2025-12 collected = 0 | ผ่าน |
| E2E-1276 | reports | ฐานติดลบ (2026-07 collected ติดลบจาก reversal): ตัวหารต้องเป็นค่าสัมบูรณ์ของฐาน | 2026-08.mom.collected | ผ่าน |
| E2E-1277 | reports | months=1 ยังคำนวณ MoM/YoY ได้ เพราะ query window ย้อนไป 12 เดือนเกินหน้าต่างที่ขอ | ?months=1 | ผ่าน |
| E2E-1278 | reports | dashboard/stats: ไม่มี token = 401 |  | ผ่าน |
| E2E-1279 | reports | dashboard/stats: VIEWER อ่านได้ (โมดูลนี้ใช้ requireAuth อย่างเดียว ไม่มี requireRole) | GET /api/dashboard/stats as VIEWER | ผ่าน |
| E2E-1280 | reports | dashboard/stats เป็น read-only: POST = 404 |  | ผ่าน |
| E2E-1281 | reports | dashboard/stats: ตัวนับและยอดคงค้างทุกตัวตรงกับ DB ในสถานะ seed | GET /api/dashboard/stats | ผ่าน |
| E2E-1282 | reports | cross-module: dashboard.totalOutstanding = reports.loanBookOutstanding = oracle (สามทางต้องเท่ากันถึงทศนิยม) | dashboard vs reports vs expected.json | ผ่าน |
| E2E-1283 | reports | dashboard: pendingPaymentRequests / pendingApprovals ตรงกับงานที่ค้างในตารางจริง | payment_requests + approval_workflows in PENDING | ผ่าน |
| E2E-1284 | reports | recent-activity: ไม่เกิน 10 แถว เรียง createdAt ใหม่ไปเก่า และตรงกับกลุ่มบนสุดของ DB | GET /api/dashboard/recent-activity | ผ่าน |
| E2E-1285 | reports | recent-activity: anonymous = 401, VIEWER = 200 |  | ผ่าน |
| E2E-1286 | reports | recent-activity ของ VIEWER อ่านได้ 200 |  | ผ่าน |
| E2E-1287 | reports | backdated disbursement: postedAt เก็บเป็น UTC instants ตรงตามที่ส่ง และ report bucket ที่เดือนนั้น | disbursedAt 2026-08-31T18:00:00.000Z -> DB literal "2026-08-31 18:00:00" | ผ่าน |
| E2E-1288 | reports | disbursement ใหม่สะท้อนในแถว 2026-08: disbursed / transactions / outstandingDelta / closing ขยับตรงตาม ledger | row 2026-08 before vs after | ผ่าน |
| E2E-1289 | reports | payment ที่โพสต์วันนี้เข้าแถวเดือนปัจจุบัน (2026-10) เท่านั้น: moneyIn / collected / paid รายส่วนขยับตาม allocation จริง | row 2026-10 before vs after | ผ่าน |
| E2E-1290 | reports | แถวเดือนอื่นต้องไม่ขยับ: ธุรกรรมใหม่สองรายการกระทบ outstandingDelta เฉพาะเดือนของตัวเอง | all other months | ผ่าน |
| E2E-1291 | reports | ปิดยอดต่อเนื่อง: ทุกแถวต้องเลื่อน +2216000.00 ตั้งแต่ 2026-08 และ -369333.33 ตั้งแต่ 2026-10 | closingOutstanding of every row | ผ่าน |
| E2E-1292 | reports | loan สร้างวันนี้แต่ disbursedAt ย้อนหลัง: loansOpened นับที่ createdAt (2026-10) ส่วน disbursement นับที่ postedAt (2026-08) | row 2026-10.loansOpened and 2026-08.loansOpened | ผ่าน |
| E2E-1293 | reports | loanBookOutstanding ขยับเท่าผลสุทธิของรายการใหม่ และเท่ากับ SUM(currentOutstanding) ใน DB | data.loanBookOutstanding | ผ่าน |
| E2E-1294 | reports | หลังโพสต์: dashboard.totalOutstanding ต้องขยับเท่า report (สองโมดูลมองสมุดเดียวกัน) | dashboard vs reports after live postings | ผ่าน |
| E2E-1295 | reports | ledger ของสองธุรกรรมใหม่: Σ signed lines = ผลสุทธิที่ report แสดงในสมุด | financial_transaction_lines of the two new transactions | ผ่าน |
| E2E-1296 | reports | รายงานคำนวณจาก ledger ทุกครั้ง (ไม่มี cache): เรียกซ้ำได้ผลเหมือนกัน และพารามิเตอร์ไม่รู้จักถูกข้าม | two identical calls + ?unknown=42 | ผ่าน |
| E2E-1297 | reports | หลังลบข้อมูลของ suite: รายงานกลับมาเป็นค่าเดิมทุกไบต์ (ทุกตัวเลข derive จาก POSTED ledger ล้วน ๆ) | months=16 before vs after cleanup | ผ่าน |
| E2E-1298 | reports | หลัง purge: จำนวนแถวทุกตารางกลับเท่าก่อนเริ่ม suite (endpoint รายงานไม่เคยเขียนลง DB) | row counts before vs after | ผ่าน |
| E2E-1299 | reports | ข้อมูล seed คงเดิม: 21 loan และยอดคงค้างรวม 375,068,000.00 หลัง suite รายงาน | GET /api/loans after cleanup | ผ่าน |
| E2E-1300 | reports | loan ของ suite หายจริงหลัง purge: 404 | LN-000022 | ผ่าน |
| E2E-1301 | reports | ลูกหนี้ที่ไม่มีกิจกรรมในหน้าต่างที่ขอ: แถวกระแสเงินเป็น 0 ทุกเดือน แต่ closing ยัง carry forward ยอดสะสมของลูกหนี้รายนั้น | ?customerId=00000000-2000-4000-8000-000000000001&months=6 (กิจกรรมสุดท้าย 2026-01) | ผ่าน |
| E2E-1302 | reports | สุดท้าย: รายงานทั้งหน้าต่างกลับตรงกับ oracle เดิมทุกแถว (ไม่เหลือรอยจาก suite) | ?months=34 after cleanup | ผ่าน |
| E2E-1303 | notifications | ไม่ login: GET /templates ถูกปฏิเสธ 401 | GET /api/notifications/templates (anonymous) | ผ่าน |
| E2E-1304 | notifications | ไม่ login: GET delivery log ถูกปฏิเสธ 401 | GET /api/notifications (anonymous) | ผ่าน |
| E2E-1305 | notifications | ไม่ login: GET /summary ถูกปฏิเสธ 401 | GET /api/notifications/summary (anonymous) | ผ่าน |
| E2E-1306 | notifications | ไม่ login: POST /requeue ถูกปฏิเสธ 401 (ก่อนแตะข้อมูล) | POST /api/notifications/:id/requeue (anonymous) | ผ่าน |
| E2E-1307 | notifications | MAKER: GET /templates ต้อง 403 (ADMIN เท่านั้น) | GET /api/notifications/templates as MAKER | ผ่าน |
| E2E-1308 | notifications | CHECKER: GET /templates ต้อง 403 (ADMIN เท่านั้น) | GET /api/notifications/templates as CHECKER | ผ่าน |
| E2E-1309 | notifications | HEAD_APPROVER: GET /templates ต้อง 403 (ADMIN เท่านั้น) | GET /api/notifications/templates as HEAD_APPROVER | ผ่าน |
| E2E-1310 | notifications | VIEWER: GET /templates ต้อง 403 (ADMIN เท่านั้น) | GET /api/notifications/templates as VIEWER | ผ่าน |
| E2E-1311 | notifications | MAKER: GET delivery log ต้อง 403 | GET /api/notifications as MAKER | ผ่าน |
| E2E-1312 | notifications | VIEWER: GET delivery log ต้อง 403 | GET /api/notifications as VIEWER | ผ่าน |
| E2E-1313 | notifications | HEAD_APPROVER: GET delivery log ต้อง 403 | GET /api/notifications as HEAD_APPROVER | ผ่าน |
| E2E-1314 | notifications | MAKER: PATCH template ต้อง 403 | PATCH /api/notifications/templates/:id as MAKER | ผ่าน |
| E2E-1315 | notifications | CHECKER: POST /requeue ต้อง 403 | POST /api/notifications/:id/requeue as CHECKER | ผ่าน |
| E2E-1316 | notifications | 403 ที่ role ห้าม requeue ไม่แก้แถวใน outbox เลย | 19e9202e-f284-4dc1-8ff8-b462392e375d | ผ่าน |
| E2E-1317 | notifications | VIEWER: GET /summary ใช้ได้ (health probe สำหรับทุกบทบาท) | GET /api/notifications/summary as VIEWER | ผ่าน |
| E2E-1318 | notifications | MAKER: GET /summary ใช้ได้ (health probe สำหรับทุกบทบาท) | GET /api/notifications/summary as MAKER | ผ่าน |
| E2E-1319 | notifications | HEAD_APPROVER: GET /summary ใช้ได้ (health probe สำหรับทุกบทบาท) | GET /api/notifications/summary as HEAD_APPROVER | ผ่าน |
| E2E-1320 | notifications | sub-path ที่ไม่มี route: 404 | GET /api/notifications/nope | ผ่าน |
| E2E-1321 | notifications | PUT /templates ไม่มี route: 404 | PUT /api/notifications/templates | ผ่าน |
| E2E-1322 | notifications | template ลบผ่าน API ไม่ได้ (เก็บประวัติไว้): 404 | DELETE /api/notifications/templates/:id | ผ่าน |
| E2E-1323 | notifications | DELETE ที่ไม่มี route ไม่ทำให้ template หายไป | 582a1600-288b-4e5a-8235-63a129eb9116 | ผ่าน |
| E2E-1324 | notifications | GET /templates ตอบ 200 | GET /api/notifications/templates | ผ่าน |
| E2E-1325 | notifications | GET /templates คืนครบ 9 code ที่ระบบรองรับ | codes | ผ่าน |
| E2E-1326 | notifications | template ทุกแถวเป็น locale lo และเปิดใช้งาน | locale/isActive | ผ่าน |
| E2E-1327 | notifications | ลำดับของ GET /templates ตรงกับลำดับที่ DB เรียง (ENUM order) | order: api vs DB ORDER BY code | ผ่าน |
| E2E-1328 | notifications | คอลัมน์ variables ของทุก template ตรงกับ placeholder ที่อ่านได้จากเนื้อหาจริง | declaredVariablesOf() คำนวณซ้ำจาก subject+bodyHtml+bodyText | ผ่าน |
| E2E-1329 | notifications | defaults คืน code + variables ของแบบทั้ง 9 | data.defaults | ผ่าน |
| E2E-1330 | notifications | template ใน DB ตรงกับ defaults ที่ code แจกจ่าย และทุก placeholder มีตัวป้อน | defaults vs stored variables, then stored placeholders vs the emitter payload contract | **ไม่ผ่าน** (F-NTF-3) |
| E2E-1331 | notifications | render ตาม payload contract แล้วไม่เหลือ curly brace (ค่าที่ missing หายไปแบบเงียบ ๆ) | renderEmail-equivalent fill of the stored SETTLEMENT_REQUESTED body | ผ่าน |
| E2E-1332 | notifications | id ของ template เป็น uuid ไม่ซ้ำกัน 9 ค่า | ids | ผ่าน |
| E2E-1333 | notifications | PATCH subject ของ template: 200 | PATCH subject + placeholder ใหม่ | ผ่าน |
| E2E-1334 | notifications | คำตอบ PATCH คืน subject ที่แก้ และ variables ถูกคำนวณรวม placeholder ใหม่ | data.template | ผ่าน |
| E2E-1335 | notifications | ค่าที่ PATCH ถูกบันทึกลงฐานข้อมูลจริง (รวม updatedByเป็นผู้ดูแล) | email_templates row | ผ่าน |
| E2E-1336 | notifications | PATCH template สร้าง audit EMAIL_TEMPLATE_UPDATED พร้อม old -> new | audit_logs EMAIL_TEMPLATE_UPDATED | ผ่าน |
| E2E-1337 | notifications | PATCH bodyHtml ที่มีเฉพาะ markup ปลอดภัย: 200 + บันทึกตรงตัว | <p>ok <b>{{loanCode}}</b> &amp; {{amount}}</p> | ผ่าน |
| E2E-1338 | notifications | bodyHtml แบบ script tag: 422 ถูกปฏิเสธ ไม่บันทึก | <script>alert(1)</script> | ผ่าน |
| E2E-1339 | notifications | payload script tag ไม่แตะ content เดิมของ template | bodyHtml after rejected PATCH | ผ่าน |
| E2E-1340 | notifications | bodyHtml แบบ iframe: 422 ถูกปฏิเสธ ไม่บันทึก | <iframe src="https://evil.test"></iframe> | ผ่าน |
| E2E-1341 | notifications | payload iframe ไม่แตะ content เดิมของ template | bodyHtml after rejected PATCH | ผ่าน |
| E2E-1342 | notifications | bodyHtml แบบ event handler: 422 ถูกปฏิเสธ ไม่บันทึก | <p onclick="steal()">x</p> | ผ่าน |
| E2E-1343 | notifications | payload event handler ไม่แตะ content เดิมของ template | bodyHtml after rejected PATCH | ผ่าน |
| E2E-1344 | notifications | bodyHtml แบบ javascript: url: 422 ถูกปฏิเสธ ไม่บันทึก | <a href="javascript:alert(1)">x</a> | ผ่าน |
| E2E-1345 | notifications | payload javascript: url ไม่แตะ content เดิมของ template | bodyHtml after rejected PATCH | ผ่าน |
| E2E-1346 | notifications | ตรวจ markup ก่อน lookup: template อื่นก็ไม่ถูกแก้ (422 ไม่ใช่ 404/200) | PATCH another template with a script payload | ผ่าน |
| E2E-1347 | notifications | subject ไม่ได้ถูกตรวจ markup (ป้องกันเฉพาะ bodyHtml) — บันทึกได้ทั้ง <script> | PATCH subject with <script> markup | ผ่าน |
| E2E-1348 | notifications | validateBody ปฏิเสธ subject ว่าง: 400 | {"subject":""} | ผ่าน |
| E2E-1349 | notifications | validateBody ปฏิเสธ bodyHtml ว่าง: 400 | {"bodyHtml":""} | ผ่าน |
| E2E-1350 | notifications | validateBody ปฏิเสธ bodyText ว่าง: 400 | {"bodyText":""} | ผ่าน |
| E2E-1351 | notifications | validateBody ปฏิเสธ isActive ไม่ใช่ boolean: 400 | {"isActive":"yes"} | ผ่าน |
| E2E-1352 | notifications | validateBody ปฏิเสธ subject ยาว 256: 400 | {"subject":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx | ผ่าน |
| E2E-1353 | notifications | PATCH template id ที่ไม่มีอยู่: 404 (ไม่ใช่ 500) | PATCH /templates/00000000-dead-4000-8000-000000000cad | ผ่าน |
| E2E-1354 | notifications | PATCH template id ไม่ใช่ uuid: 404 | PATCH /templates/not-a-uuid | ผ่าน |
| E2E-1355 | notifications | PATCH {} ไม่แก้ content แต่ยังคงเขียน audit เพิ่ม 1 แถว | PATCH {} then count EMAIL_TEMPLATE_UPDATED | ผ่าน |
| E2E-1356 | notifications | คืนค่า template LOAN_REJECTED กลับ snapshot เดิมแบบ byte-exact | SQL restore of LOAN_REJECTED | ผ่าน |
| E2E-1357 | notifications | PATCH subject ของ USER_CREATED สำเร็จ (ใช้เป็น sentinel) | SENTINEL-A {{username}} | ผ่าน |
| E2E-1358 | notifications | แถวที่ enqueue หลังแก้ template ใช้ subject แบบใหม่ (ไม่ cache) | outbox.subject after SENTINEL-A | ผ่าน |
| E2E-1359 | notifications | แก้ template ซ้ำครั้งที่สอง also มีผลต่อแถวถัดไปทันที | SENTINEL-B then create another user | ผ่าน |
| E2E-1360 | notifications | ปิดใช้งาน template USER_CREATED ผ่าน API: 200 | PATCH isActive=false | ผ่าน |
| E2E-1361 | notifications | ปิด template แล้ว: สร้างผู้ใช้สำเร็จแต่ไม่มีแถวใน outbox (กระบวนการธุรกิจไม่พัง) | user tst_ntf_694315_off while the USER_CREATED template is inactive | ผ่าน |
| E2E-1362 | notifications | เปิด template กลับ: 200 | PATCH isActive=true | ผ่าน |
| E2E-1363 | notifications | markup ที่มาจากผู้ใช้ถูก escape ใน bodyHtml (ไม่มี <script> ดิบในส่วนของ html) | unseal(bodyHtml) of the USER_CREATED row | ผ่าน |
| E2E-1364 | notifications | bodyText ไม่มี {{recipientName}}: fullName ของผู้ใช้ไม่ไหลเข้าส่วน plain text เลย | unseal(bodyText) of the USER_CREATED row | ผ่าน |
| E2E-1365 | notifications | สามคอลัมน์เนื้อหาถูกซีลทั้งหมด (bodyHtml/bodyText/payload) | isSealed() on the stored columns | ผ่าน |
| E2E-1366 | notifications | payload เปิดได้และตรงข้อมูลบัญชีที่สร้าง | unseal(payload) | ผ่าน |
| E2E-1367 | notifications | subject ของ USER_CREATED ใส่ username ดิบ (ไม่ escape) | outbox.subject of the USER_CREATED row | ผ่าน |
| E2E-1368 | notifications | username ไม่มี pattern: รับค่าที่มี upline แล้วส่งต่อไปยัง subject/log | username = "tst_lf_694315\n[ERROR  ]: FORGED-LINE-9131 <b>lf</b>" | ผ่าน |
| E2E-1369 | notifications | บรรทัด log ของ transport ไม่ถูกปลอมจากข้อมูลผู้ใช้ (log forging) | scan log files for FORGED-LINE-9131 | ผ่าน |
| E2E-1370 | notifications | markup ใน username: subject เก็บดิบ แต่ bodyHtml ถูก escape | the same row, subject vs bodyHtml | ผ่าน |
| E2E-1371 | notifications | bodyText (plain text) ไม่ถูก escape: markup จาก username คงอยู่แบบดิบ | unseal(bodyText) of the row whose username carried <b>lf</b> | ผ่าน |
| E2E-1372 | notifications | ผู้ใช้ไม่มี email: สร้างสำเร็จ แต่ไม่มีแถว outbox (ข้ามการส่ง) | user tst_ntf_694315_nomail with email=null | ผ่าน |
| E2E-1373 | notifications | แถวที่ enqueue ก่อนหน้าถูก dispatcher ส่งออกครบก่อนตรวจ contract ของ list | 4 rows before the list checks | ผ่าน |
| E2E-1374 | notifications | GET /api/notifications: 200 | GET /api/notifications | ผ่าน |
| E2E-1375 | notifications | total อยู่ระดับ top-level และ equals จำนวนแถวทั้งตาราง | GET /api/notifications -> total | ผ่าน |
| E2E-1376 | notifications | หน้า default คืน 50 แถวล่าสุด (limit default) | no limit param | ผ่าน |
| E2E-1377 | notifications | รายการใน delivery log ไม่แนบเนื้อหาอีเมล (bodyHtml/bodyText/payload หายไปจริง) | keys of one item | ผ่าน |
| E2E-1378 | notifications | เรียง createdAt DESC | createdAt sequence | ผ่าน |
| E2E-1379 | notifications | list query limit=0: 400 | GET /api/notifications?limit=0 | ผ่าน |
| E2E-1380 | notifications | list query limit=201: 400 | GET /api/notifications?limit=201 | ผ่าน |
| E2E-1381 | notifications | list query limit=abc: 400 | GET /api/notifications?limit=abc | ผ่าน |
| E2E-1382 | notifications | list query limit=1.5: 400 | GET /api/notifications?limit=1.5 | ผ่าน |
| E2E-1383 | notifications | list query offset=-1: 400 | GET /api/notifications?offset=-1 | ผ่าน |
| E2E-1384 | notifications | list query status ไม่อยู่ใน enum: 400 | GET /api/notifications?status=BOGUS | ผ่าน |
| E2E-1385 | notifications | Pagination ด้วย limit/offset: สองหน้าไม่ซ้อนกัน | limit=5 offset=0 / offset=5 | ผ่าน |
| E2E-1386 | notifications | limit=200 (ค่าสูงสุดที่ schema รับ) ใช้ได้ | limit=200 | ผ่าน |
| E2E-1387 | notifications | offset เลยจำนวนแถว: 200 + รายการว่าง แต่ total คงเดิม | offset=100000 | ผ่าน |
| E2E-1388 | notifications | filter status=SENT: ทุกแถวบ status ตรงกัน และ total คือจำนวนที่ filter แล้ว | status=SENT | ผ่าน |
| E2E-1389 | notifications | GET /summary: 200 | GET /api/notifications/summary | ผ่าน |
| E2E-1390 | notifications | counts ของ /summary ตรงกับ GROUP BY status ในฐานข้อมูล | summary vs DB | ผ่าน |
| E2E-1391 | notifications | ทั้งสี่สถานะรวมแล้วเท่ากับจำนวนแถวจริง | sum(counts) vs COUNT(*) | ผ่าน |
| E2E-1392 | notifications | VIEWER เห็นตัวเลขเดียวกับ ADMIN (health probe เท่านั้น ไม่เปิดเผยเนื้อหา) | GET /summary as VIEWER | ผ่าน |
| E2E-1393 | notifications | transport ที่เซิร์ฟเวอร์ใช้คือ log (ไม่แตะ SMTP/Kafka/mailer จริง) | server/.env NOTIFY_TRANSPORT | ผ่าน |
| E2E-1394 | notifications | แถวที่ suite สร้างถูก dispatcher ส่งออกครบ (PENDING -> SENT) | 4 suite rows | ผ่าน |
| E2E-1395 | notifications | แถว SENT: sentAt ถูกset lastErrorว่าง และ attempts ยัง 0 (markSent ไม่นับ attempt) | sentAt/lastError/attempts of SENT rows | ผ่าน |
| E2E-1396 | notifications | ไม่มีแถวใดของ suite มี lastError อ้างถึง SMTP/Kafka/mailer | lastError scan | ผ่าน |
| E2E-1397 | notifications | ไฟล์ log มีบรรทัด [notify:log] ของแถวที่ suite สร้าง (หลักฐานว่าใช้ transport ในเครื่อง) | scan for the notify:log line of tst_ntf_a_694315@test.local | ผ่าน |
| E2E-1398 | notifications | forgot-password ของบัญชี suite: 202 | tst_ntf_otp_694315@test.local | ผ่าน |
| E2E-1399 | notifications | รอ cooldown/IP throttle ว่างก่อนเรียก reset | recent password_reset_tokens count | ผ่าน |
| E2E-1400 | notifications | PASSWORD_RESET_OTP ถูก enqueue พร้อม body แบบซีล | outbox row type PASSWORD_RESET_OTP | ผ่าน |
| E2E-1401 | notifications | เปิด body แล้วได้ OTP ที่ใช้จริงได้ (message ไม่เสียหายจากการซีล) | unseal(payload).otp + unseal(bodyText) | ผ่าน |
| E2E-1402 | notifications | OTP ไม่ปรากฏเป็น plaintext ที่เก็บในตารางเลย (รวม subject) | notification_outbox columns vs the live OTP | ผ่าน |
| E2E-1403 | notifications | OTP ไม่หลุดไปอยู่ในไฟล์ log (transport redact content ของ event ที่มี secret) | scan every log file for the 6-digit code | ผ่าน |
| E2E-1404 | notifications | บรรทัด log ของ PASSWORD_RESET_OTP ใช้รูปแบบ <redacted ...> | scan for the redaction marker | ผ่าน |
| E2E-1405 | notifications | verify-otp ด้วยโค้ดจาก outbox: 200 + ได้ link | POST /api/auth/verify-otp | ผ่าน |
| E2E-1406 | notifications | PASSWORD_RESET_LINK เก็บลิงก์แบบซีลเท่านั้น | outbox row PASSWORD_RESET_LINK | ผ่าน |
| E2E-1407 | notifications | link reset อยู่ใน body ที่เปิดแล้ว และ subject ไม่มี token | unseal(bodyText) + subject | ผ่าน |
| E2E-1408 | notifications | แถวความลับของ suite ออกด้วย log transport จน SENT (ไม่มี SMTP/Kafka เข้ามาเกี่ยว) | OTP + LINK rows after the poller runs | ผ่าน |
| E2E-1409 | notifications | requeue แถวที่ SENT แล้ว: 404 (ส่งไปแล้วห้ามส่งซ้ำ) | POST /api/notifications/2603acd9-1f75-4c6b-b741-1a99bbdcd03c/requeue | ผ่าน |
| E2E-1410 | notifications | requeue ที่ถูกปฏิเสธไม่แก้สถานะ | 2603acd9-1f75-4c6b-b741-1a99bbdcd03c | ผ่าน |
| E2E-1411 | notifications | FAILED + nextRetryAt เลยเวลา: dispatcher เก็บมาส่งใหม่จน SENT | status=FAILED, attempts=4, nextRetryAt=now-60s | ผ่าน |
| E2E-1412 | notifications | ส่งสำเร็จแล้ว: lastError ถูกclear แต่ attempts/ nextRetryAt เดิมยังอยู่ (markSent ไม่รีเซ็ต) | row after the successful retry | ผ่าน |
| E2E-1413 | notifications | FAILED + nextRetryAt ยังไม่ถึงเวลา: dispatcher ข้าม (backoff เคารพเวลา) | status=FAILED, nextRetryAt=now+1h, then wait 8s | ผ่าน |
| E2E-1414 | notifications | DEAD ปรากฏใน delivery log ตาม filter | GET /api/notifications?status=DEAD | ผ่าน |
| E2E-1415 | notifications | requeue แถว DEAD: 200 | 2603acd9-1f75-4c6b-b741-1a99bbdcd03c | ผ่าน |
| E2E-1416 | notifications | หลัง requeue: attempts=0 + lastError/nextRetryAtถูกล้าง (สถานะกลับเป็น PENDING/ronda ส่ง) | the requeued row | ผ่าน |
| E2E-1417 | notifications | คำตอบ requeue คืน id + สถานะใหม่ | response body | ผ่าน |
| E2E-1418 | notifications | requeue สร้าง audit NOTIFICATION_REQUEUED 1 แถว (PENDING + เหตุผลระบุ type และ recipient ของแถวนั้น) | audit_logs ใหม่หลัง requeue 2603acd9-1f75-4c6b-b741-1a99bbdcd03c | ผ่าน |
| E2E-1419 | notifications | แถวที่ requeue ถูก dispatcher ส่งออกไปจริงรอบสอง (SENT + sentAt ถูกset ใหม่) | poll after requeue | ผ่าน |
| E2E-1420 | notifications | requeue แถวที่ PENDING อยู่แล้ว: รับได้ 200 (กันเฉพาะ SENT) | POST requeue on a PENDING row | ผ่าน |
| E2E-1421 | notifications | requeue id ที่ไม่มีอยู่: 404 | POST /api/notifications/00000000-dead-4000-8000-000000000cad/requeue | ผ่าน |
| E2E-1422 | notifications | requeue id ไม่ใช่ uuid: 404 ไม่ใช่ 500 | POST /api/notifications/not-a-uuid/requeue | ผ่าน |
| E2E-1423 | notifications | DEAD จาก maxAttempts ตรวจได้เพียง config (transport=log ทำให้ส่งไม่พัง) | NOTIFY_MAX_ATTEMPTS / NOTIFY_BACKOFF_SECONDS | ผ่าน |
| E2E-1424 | notifications | GET /templates กลับเป็น snapshot เดิมแบบ byte-for-byte | stringify(data) before vs after the suite | ผ่าน |
| E2E-1425 | notifications | ฐานข้อมูล: template ทั้ง 9 คืนค่าครบทุกคอลัมน์ (รวม updatedBy/updatedAt) | row-by-row column diff vs the snapshot | ผ่าน |
| E2E-1426 | notifications | audit rows ใหม่ของ suite ถูกลบครบตามที่ระบุ id ไว้ | id-set differencing on audit_logs | ผ่าน |
| E2E-1427 | notifications | ไม่มีแถวของ suite ค้างใน notification_outbox | suite outbox ids | ผ่าน |
| E2E-1428 | notifications | จำนวนแถวทุกตารางที่เกี่ยวข้องกลับมาเท่า baseline | users,notification_outbox,audit_logs,email_templates,password_reset_tokens,user_avatars | ผ่าน |
| E2E-1429 | notifications | ผู้ใช้ของ suite หายไปจาก GET /api/users ทั้งหมด (รวม includeDeleted) | check 7 throwaway usernames | ผ่าน |
| E2E-1430 | notifications | บัญชีที่ถูกลบถาวร login ไม่ได้ (ไม่เหลือ session ใช้ได้) | login tst_ntf_694315_otp | ผ่าน |
| E2E-1431 | logger | มีโฟลเดอร์ log ที่ logger ระบุไว้ (server/src/logs) ให้อ่านก่อนเริ่ม suite | server/src/logs + server/dist/logs | ผ่าน |
| E2E-1432 | logger | child process ที่ใช้ logger ตัวเดียวกับเซิร์ฟเวอร์รันได้ | tsx child: info/debug/warn/error/silly + meta-error | ผ่าน |
| E2E-1433 | logger | ชื่อไฟล์ทุกไฟล์เป็นรูปแบบ ชั่วโมง-ชื่อระบบ.log เท่านั้น | 2026101418_LoanSystem.log,2026101420_LoanSystem.log,2026101421_LoanSystem.log,2026101422_LoanSystem.log,2026101423_LoanSystem.log,2026101509_LoanSystem.log | ผ่าน |
| E2E-1434 | logger | มีไฟล์ของชั่วโมงปัจจุบัน (Asia/Bangkok) และ logger เขียนต่อชั่วโมง | 2026101509_LoanSystem.log | ผ่าน |
| E2E-1435 | logger | ชื่อไฟล์ใช้ชั่วโมง Asia/Bangkok ไม่ใช่ UTC | bangkok=2026101509 utc=2026101502 | ผ่าน |
| E2E-1436 | logger | มีไฟล์ log หลายชั่วโมงในโฟลเดอร์ (การแบ่งไฟล์ตามชั่วโมงทำงานจริง) | 6 files | ผ่าน |
| E2E-1437 | logger | ไม่มีไฟล์ log ที่ชื่อชั่วโมงอยู่อนาคต | 2026101422 2026101423 2026101509 | ผ่าน |
| E2E-1438 | logger | ทุกบรรทัดที่ logger เขียนเอง ตรงรูปแบบ time [LEVEL  ]: message | 314 non-empty lines across 6 files | ผ่าน |
| E2E-1439 | logger | ไฟล์ log มีบรรทัดที่ไม่ใช่ record จากเหตุ log forging ของ suite 11 (F-NTF-2) ปรากฏอยู่ | lines that do not start with a timestamp | ผ่าน |
| E2E-1440 | logger | ช่อง level กว้าง 7 ตัวอักษรเสมอ (padEnd) | the bracketed level field | ผ่าน |
| E2E-1441 | logger | ไฟล์ log มีเฉพาะระดับ info ขึ้นไป (debug/silly ไม่ถูกเขียนไฟล์) | levels seen: INFO   ,ERROR  ,WARN | ผ่าน |
| E2E-1442 | logger | เวลาในไฟล์เรียงจากเก่าไปใหม่ไม่ย้อนหลัง | per-file timestamp sequence | ผ่าน |
| E2E-1443 | logger | ชั่วโมงในบรรทัดตรงกับชื่อไฟล์เสมอ (ไม่มีบรรทัดตกไฟล์ผิดชั่วโมง) | line stamp hour vs file name hour | ผ่าน |
| E2E-1444 | logger | ไม่มี stamp อยู่ในอนาคต | max stamp vs bangkok now | ผ่าน |
| E2E-1445 | logger | ทุก record จบด้วย newline ตัวเดียว (ไม่มีบรรทัดว่างคั่นทุกบรรทัด) | count of "\r\n\n" / "\n\n" in 6 files | **ไม่ผ่าน** (F-LOG-1) |
| E2E-1446 | logger | สร้างบัญชีที่มี email (สำหรับดูบรรทัด transport log): 201 | tst_lg_694318_mail | ผ่าน |
| E2E-1447 | logger | การ enqueue ที่สำเร็จเขียนบรรทัด [notify:log] ลงไฟล์ชั่วโมงปัจจุบัน | needle: [notify:log] USER_CREATED -> tst_lg_mail_694318@test.local | ผ่าน |
| E2E-1448 | logger | บรรทัด log ที่เขียนสดใช้รูปแบบ time [INFO   ]: และเวลาตรงตามจริง | 2026-10-15 09:19:55 [INFO   ]: [notify:l | ผ่าน |
| E2E-1449 | logger | สร้างบัญชีที่ไม่มี email (เส้น warn ของ enqueue): 201 | tst_lg_694318_nomail | ผ่าน |
| E2E-1450 | logger | ไม่มี recipient email: enqueue เขียน WARN แล้วข้ามแถว (กระบวนการธุรกิจไม่พัง) | create user with email = NULL | ผ่าน |
| E2E-1451 | logger | template ปิดอยู่: enqueue เขียน WARN "no active email template" แล้วข้าม | isActive=false on USER_CREATED, then create a user | ผ่าน |
| E2E-1452 | logger | บรรทัด startup (db connected / listening / dispatcher started) ถูกเขียนลงไฟล์ | three boot needles | ผ่าน |
| E2E-1453 | logger | บรรทัด dispatcher started รายงาน transport/interval ตรงกับ env ที่เซิร์ฟเวอร์ใช้จริง | env: transport=log poll=5000ms | ผ่าน |
| E2E-1454 | logger | บรรทัด db connected ไม่ใส่รหัสผ่านลง log | 2026-10-14 23:52:02 [INFO   ]: [db] connected to 127.0.0.1:3307/loan_management | ผ่าน |
| E2E-1455 | logger | route ไม่มีจริง: 404 Not found | GET /api/definitely-not-a-route | ผ่าน |
| E2E-1456 | logger | ไม่ส่ง token: 401 | GET /api/users (anonymous) | ผ่าน |
| E2E-1457 | logger | 404/401 ไม่กลายเป็น [unhandled error] ในไฟล์ log (เฉพาะ error ตัวจริงเท่านั้น) | one 404 + one 401 request | ผ่าน |
| E2E-1458 | logger | subject ภาษาลาวจาก template เขียนลงไฟล์ log ได้ครบไม่เพี้ยน (UTF-8 รอบปลายทาง) | search the log for the rendered Lao subject of the user the suite just created | ผ่าน |
| E2E-1459 | logger | ไม่มีอักขระเสีย (U+FFFD) ในไฟล์ log ที่อ่านกลับเป็น UTF-8 | 6 files decoded as utf8 | ผ่าน |
| E2E-1460 | logger | ไม่มีร่องรอย mojibake (ไฟล์ถูกเขียน/อ่านด้วย encoding เดียวกันคือ UTF-8) | scan for latin-1 mis-decoding patterns | ผ่าน |
| E2E-1461 | logger | debug ส่งออก console แต่ไม่ลงไฟล์ (level threshold ของ stream transport = info) | logger.debug() in a tsx child process | ผ่าน |
| E2E-1462 | logger | silly ก็ไม่ลงไฟล์เช่นกัน | logger.silly() | ผ่าน |
| E2E-1463 | logger | info/warn/error จาก code path เดียวกันลงไฟล์ครบ | three probes at/above info | ผ่าน |
| E2E-1464 | logger | NODE_ENV=test: logger silent สมบูรณ์ (ไม่เขียนไฟล์และไม่ออก console) | tsx child with NODE_ENV=test | ผ่าน |
| E2E-1465 | logger | F-LOG-2: logger.error(msg, err) ต้องเก็บ stack ของ err ไว้ตามที่ renderMessage ตั้งใจไว้ | the line produced by logger.error(metaMsg, new Error(metaCause)) | **ไม่ผ่าน** (F-LOG-2) |
| E2E-1466 | logger | cause message ของ err ยังโผล่มาในบรรทัด log (พอระบุสาเหตุระดับหนึ่ง) | same line, inner error message | ผ่าน |
| E2E-1467 | logger | message ที่เป็น object ถูก renderMessage แปลงเป็น JSON ครบทุก field (not string branch) | logger.info({ marker, detail }) | ผ่าน |
| E2E-1468 | logger | log ไม่เก็บ รหัสผ่านบัญชีเทสต์ (PASSWORD) แบบ plaintext | scan 6 files for the value (length 10) | ผ่าน |
| E2E-1469 | logger | log ไม่เก็บ DB_PASSWORD แบบ plaintext | scan 6 files for the value (length 8) | ผ่าน |
| E2E-1470 | logger | log ไม่เก็บ JWT_SECRET แบบ plaintext | scan 6 files for the value (length 40) | ผ่าน |
| E2E-1471 | logger | log ไม่เก็บ NOTIFY_SECRET_KEY แบบ plaintext | scan 6 files for the value (length 42) | ผ่าน |
| E2E-1472 | logger | log ไม่เก็บ access token ของ run นี้ แบบ plaintext | scan 6 files for the value (length 333) | ผ่าน |
| E2E-1473 | logger | ขอ OTP สำหรับตรวจ log (202) — ข้ามได้ถ้า cooldown/IP throttle ยังทำงาน | POST /api/auth/forgot-password for tst_lg_mail_694318@test.local | ผ่าน |
| E2E-1474 | logger | OTP ที่ run นี้ issuance ขึ้นไป ไม่พบในไฟล์ log เลย (transport redact) | scan every log file for the live 6-digit code | ผ่าน |
| E2E-1475 | logger | บรรทัด transport ของ OTP ที่ run นี้ issuance ใช้ <redacted ...> (โค้ดปัจจุบัน) | notify:log lines of tst_lg_mail_694318@test.local | ผ่าน |
| E2E-1476 | logger | ไม่มีบรรทัด log เก่าที่เก็บ OTP เป็น plaintext เหลืออยู่ในโฟลเดอร์ log | scan all files for the OTP subject pattern (Lao prefix + 6 digits) | ผ่าน |
| E2E-1477 | logger | H1 template body ที่ยาวกว่าคอลัมน์ TEXT ต้องถูก reject เป็น client error (400) | PATCH bodyHtml with 70007 chars | **ไม่ผ่าน** (F-NTF-4) |
| E2E-1478 | logger | H2 คำตอบ 500 ไม่ปล่อย stack/SQL/ชื่อคอลัมน์ให้ client | the 500 response body | ผ่าน |
| E2E-1479 | logger | H3 PATCH ที่ล้มเหลวไม่แก้แถว template (transaction rollback ครบ) | stored bodyHtml after the failed PATCH | ผ่าน |
| E2E-1480 | logger | H4 PATCH ที่ล้มเหลวไม่เขียน audit EMAIL_TEMPLATE_UPDATED | audit rows for LOAN_REJECTED | ผ่าน |
| E2E-1481 | logger | H5 request body เกิน limit ของ express.json (100kb) ควรตอบ 413 ไม่ใช่ 500 | PATCH with a 300007 char body | **ไม่ผ่าน** (F-LOG-3) |
| E2E-1482 | logger | H6 ทุก 500 ที่เกิดขึ้นถูกเขียน log พร้อม method+url+cause | delta of "[unhandled error] PATCH /api/notifications/templates/582a1600-288b-4e5a-8235-63a129eb9116" lines | ผ่าน |
| E2E-1483 | logger | เซิร์ฟเวอร์ยังทำงานต่อได้หลัง 500 สองครั้ง (ไม่ crash, ไม่มี connection ค้าง) | GET /health + GET /api/notifications/templates | ผ่าน |
| E2E-1484 | logger | I1 template body ~60KB เก็บลงคอลัมน์ TEXT ได้ (200) | 60007 chars | ผ่าน |
| E2E-1485 | logger | I2 การ queue ที่ล้มเหลวไม่ทำให้ signup พัง (201 เหมือนเดิม) | POST /api/users while the USER_CREATED body is 60KB | ผ่าน |
| E2E-1486 | logger | I3 แถว notification ต้องถูก enqueue เมื่อ template ยัง active | notification_outbox rows for the user created with a 60KB template | **ไม่ผ่าน** (F-NTF-5) |
| E2E-1487 | logger | I4 ความล้มเหลวนั้นมีร่องรอยใน log พร้อมข้อความจาก driver | the [notify] could not queue line | ผ่าน |
| E2E-1488 | logger | I5 หลังคืน template แล้วการ queue กลับมาทำงานปกติ (มีแถว 1 แถว) | create a user after the restore | ผ่าน |
| E2E-1489 | logger | ฐานข้อมูล: template ทั้ง 9 กลับเป็นค่าเดิมทุกคอลัมน์ | column-by-column diff vs the snapshot | ผ่าน |
| E2E-1490 | logger | audit rows ที่ suite นี้ก่อถูกลบครบ และไม่มี action อื่นเจือ | id-set differencing on audit_logs | ผ่าน |
| E2E-1491 | logger | ไม่มีบัญชีของ suite ค้างในตาราง users | 5 ids | ผ่าน |
| E2E-1492 | logger | จำนวนแถวทุกตารางที่เกี่ยวข้องกลับมาเท่า baseline | users,notification_outbox,audit_logs,email_templates,password_reset_tokens,user_avatars | ผ่าน |
| E2E-1493 | logger | suite ไม่ลบหรือตั้งชื่อไฟล์ log ใหม่ (ไฟล์ที่เพิ่มต้องเป็นชั่วโมงถัดไปเท่านั้น) | file-name set diff before/after | ผ่าน |
| E2E-1494 | logger | ไม่มีไฟล์ log ใดหดลง (append-only, suite ไม่ได้ truncate) | 6 files compared with their baseline size | ผ่าน |
| E2E-1495 | logger | ไม่ทิ้งไฟล์ probe ไว้ใน scripts/test | tmp-logger-probe-694318.mts | ผ่าน |
| E2E-1496 | logger | เซิร์ฟเวอร์ยังปกติหลัง suite จบ | GET /health | ผ่าน |
| E2E-1497 | config | GET /thresholds ให้ object เปลือย 2 คีย์เท่านั้น (ไม่มี data wrapper) | GET /api/config/thresholds | ผ่าน |
| E2E-1498 | config | GET /thresholds ตรงกับคอลัมน์ value ใน system_config จริง (ไม่ได้ hardcode 1,000,000) | CAST(value AS CHAR) ของ approval.checkerThreshold / approval.headThreshold | ผ่าน |
| E2E-1499 | config | GET /kyc คืน {data:{policy,defaults,checksum}} ครบ 3 คีย์ | GET /api/config/kyc | ผ่าน |
| E2E-1500 | config | GET /password คืน {data:{policy,defaults,checksum}} เช่นกัน | GET /api/config/password | ผ่าน |
| E2E-1501 | config | GET /avatar ไม่มี checksum (สัญญาต่างจากอีก 3 endpoint) | GET /api/config/avatar | ผ่าน |
| E2E-1502 | config | checksum = sha256(JSON(policy)) 16 hex แรก ตามที่ service คำนวณจริง (ทั้ง kyc และ password) | recompute sha256(...).hex.slice(0,16) from the response body | ผ่าน |
| E2E-1503 | config | defaults ที่ API คืน = layer env ของเซิร์ฟเวอร์ที่รันอยู่จริง (server/.env ไม่ได้ตั้ง KYC_*/PASSWORD_*/AVATAR_*) | env fallbacks: kyc 13 ฟิลด์, password 6, avatar 3 | ผ่าน |
| E2E-1504 | config | policy ที่อ่านได้ = กฎ layering env -> rows ของ system_config จริง (kyc 13 + password 6 + avatar 3 ฟิลด์) | independent overlay ของ 12 แถว baseline | ผ่าน |
| E2E-1505 | config | ทุก GET ของ /api/config ใช้ได้กับทุก role ที่ login แล้ว (VIEWER อ่าน policy ได้) | GET /api/config/kyc with test_view1 | ผ่าน |
| E2E-1506 | config | แก้ system_config ด้วย SQL แล้ว GET อ่านค่าใหม่ทันทีทั้ง 4 surface (ไม่มี cache, ไม่ต้อง restart) | SQL UPDATE 4 แถว -> GET /kyc /password /avatar /thresholds | ผ่าน |
| E2E-1507 | config | หลังคืนค่าด้วย snapshot แล้ว fingerprint ทั้ง 4 surface กลับเท่าก่อนเริ่ม suite | applySnapshot() then re-read all four endpoints | ผ่าน |
| E2E-1508 | config | GET /api/auth/password-policy เปิดให้คนไม่ login อ่าน policy ที่บังคับใช้จริงได้ (ข้อมูล policy หลุดออกนอกระบบ) | GET /api/auth/password-policy without a token | ผ่าน |
| E2E-1509 | config | ทุก endpoint ของ /api/config ตอบ 401 เมื่อไม่มี token (8 เส้นทาง) | 4 GET + 4 PUT without a bearer token | ผ่าน |
| E2E-1510 | config | PUT ทั้ง 4 endpoint ตอบ 403 กับ role ที่ไม่ใช่ ADMIN (16 calls) | HEAD_APPROVER/CHECKER/MAKER/VIEWER x 4 endpoints | ผ่าน |
| E2E-1511 | config | คำขอที่ถูกปฏิเสธไม่ทิ้งร่องรอย: system_config ทุกแถว, audit, checksum ไม่เปลี่ยนเลย | row-by-row config diff + audit row count + 4 fingerprints | ผ่าน |
| E2E-1512 | config | path ที่ไม่มีใน /api/config: 404 Not found (ไม่วนเข้า errorHandler เป็น 500) | GET /api/config/nope | ผ่าน |
| E2E-1513 | config | ร่าง request ผิดชนิด/เกินขอบเขตของ zod ทั้ง 28 เคส: 400 Validation failed ทุกเคส | 28 malformed bodies | ผ่าน |
| E2E-1514 | config | 400 จาก zod มี details ระบุว่าฟิลด์ไหนผิด (flatten ของ zod) | PUT /kyc {maxFileSizeKb:0} | ผ่าน |
| E2E-1515 | config | คีย์ที่ไม่รู้จักใน body ถูก zod ตัดทิ้ง (ไม่กลายเป็น config row ใหม่) | PUT /kyc with totallyUnknownField | ผ่าน |
| E2E-1516 | config | หลังชุด 400 + PUT ที่สำเร็จ 1 ครั้งแล้ว revert: system_config เท่ากับ baseline ทุกแถว | full table diff vs the baseline snapshot | ผ่าน |
| E2E-1517 | config | business validation 7 เคส: 422 พร้อมข้อความตรงตามที่ service throw | kyc 4 + password 2 + avatar 1 patch ที่ขัดกติกาของ policy | ผ่าน |
| E2E-1518 | config | 422 ทุกเคส rollback เกลี้ยง: ไม่แก้แถวไหน ไม่สร้าง audit CONFIG_UPDATED | value/valueText diff ของทุกแถว + นับ CONFIG_UPDATED จากจุดเริ่มต้น | ผ่าน |
| E2E-1519 | config | ข้อความ 422 ที่ path ปกติเข้าไม่ถึง (zod กันขอบเขตเดียวกันไว้ก่อน): ได้ 400 ไม่ใช่ 422 | 5 patch ที่ค่าอยู่นอกขอบเขตทั้งของ zod และของ business check | ผ่าน |
| E2E-1520 | config | ขอบเขต maxTotalBytesPerCustomer = maxFileSizeKb*1024 พอดี: 200 (ไม่ปัดตกแบบ off-by-one) | PUT /kyc {40 KB, 40960 bytes} | ผ่าน |
| E2E-1521 | config | PUT /thresholds ที่ถูกต้อง: 200 + object เปลือยค่าใหม่ และ system_config ถูกเขียน 2 คีย์ | PUT {checker:1500000, head:15000000} | ผ่าน |
| E2E-1522 | config | PUT /thresholds เขียน description ของ 2 คีย์ตามที่โค้ดกำหนด และ updatedBy = ผู้กระทำ | description/updatedBy ของทั้งสองแถว | ผ่าน |
| E2E-1523 | config | audit CONFIG_UPDATED ของ threshold: previousStatus/newStatus เป็น checker=..,head=.. และ reason ระบุ before -> after | แถว CONFIG_UPDATED ที่ PUT นี้สร้าง | ผ่าน |
| E2E-1524 | config | ขอบเขต head == checker ใช้ได้ (เงื่อนไขเป็น >= ไม่ใช่ >) | PUT {1, 1} | ผ่าน |
| E2E-1525 | config | head < checker: 400 พร้อมข้อความ invariant และไม่มีแถวถูกแก้เพิ่ม | PUT {100, 99.99} ต่อจาก PUT {1,1} | ผ่าน |
| E2E-1526 | config | PUT /kyc patch 7 ฟิลด์: 200 + policy อ่านกลับตรงทั้ง 7 ฟิลด์ | patch 7 fields at once | ผ่าน |
| E2E-1527 | config | PUT /kyc เขียนเฉพาะ key ของ field ที่ส่งมา และ key อื่นในระบบไม่ถูกแตะ | row-level diff by key | **ไม่ผ่าน** |
| E2E-1528 | config | แถวแบบ csv/docTypes ที่สร้างใหม่เก็บ value เป็น 0.00 (คอลัมน์เดียวใช้ร่วม, overlay อ่านเฉพาะ valueText) | แถว kyc.allowedDocumentTypes ที่เพิ่งสร้าง | ผ่าน |
| E2E-1529 | config | audit CONFIG_UPDATED ของ kyc: previousStatus/newStatus = checksum 16 hex ของ policy ก่อน/หลัง + reason แบบ describe | แถว CONFIG_UPDATED ของ PUT นี้ | **ไม่ผ่าน** |
| E2E-1530 | config | PUT /password 4 ฟิลด์: 200 + audit reason เป็น describePasswordPolicy แบบ "length a-b, rule\|rule" | PUT {8, 24, digit:false, symbol:true} | ผ่าน |
| E2E-1531 | config | PUT /password เก็บ boolean เป็น 0/1 ในคอลัมน์ value เดียวกับ numeric | 4 แถว password หลัง PUT | ผ่าน |
| E2E-1532 | config | PUT /avatar 2 ฟิลด์: 200 + reason "Avatar policy enabled=1,<=512KB  ->  enabled=0,<=600KB" | PUT {enabled:false, maxFileSizeKb:600} | ผ่าน |
| E2E-1533 | config | audit ของ avatar ไม่เก็บ previousStatus/newStatus เลย (ต่างจาก kyc/password ที่เก็บ checksum) | แถว CONFIG_UPDATED ของ avatar PUT | ผ่าน |
| E2E-1534 | config | PUT body เปล่า {} ยัง 200 และสร้าง audit CONFIG_UPDATED 1 แถวทั้งที่ไม่ได้แก้อะไร (audit noise) | PUT /api/config/avatar {} | ผ่าน |
| E2E-1535 | config | PUT /kyc {}: checksum เดิมทั้งสองฝั่งของ audit และไม่มีแถวขยับ | PUT /api/config/kyc {} | ผ่าน |
| E2E-1536 | config | ตั้ง requireSymbol=true แล้วรหัสผ่านไม่มีสัญลักษณ์: 422 MISSING_SYMBOL พร้อมข้อความ policy ใหม่ | PUT /password {requireSymbol:true} then POST /api/users password=Abcdef1 | ผ่าน |
| E2E-1537 | config | รหัสผ่านที่มี @ ผ่านนโยบายใหม่ (201) — ค่า config ที่แก้มีผลกับ endpoint อื่นทันทีโดยไม่ต้อง restart | POST /api/users password=Tst@2026#a | ผ่าน |
| E2E-1538 | config | บัญชีเดิมที่รหัสไม่ตรง policy ใหม่ยัง login ได้ (policy บังคับเฉพาะตอนเขียนรหัสใหม่) | POST /api/auth/login ด้วยรหัสทดสอบ 9 ตัวอักษร ขณะ requireSymbol=true (รหัสทดสอบมี @ จึงยังไม่ชัดเท่า min length) | ผ่าน |
| E2E-1539 | config | ตั้ง minLength=12 แล้วรหัส 7 ตัว: 422 TOO_SHORT | PUT /password {minLength:12} then POST /api/users password=Abc123! | ผ่าน |
| E2E-1540 | config | หลังคืน policy เป็น baseline รหัส 7 ตัวผ่านอีกครั้ง (201) — พิสูจน์ว่า overlay อ่านค่าใหม่จริง ไม่ได้ cache ของเสียไว้ | restore + POST /api/users password=Abc123! | ผ่าน |
| E2E-1541 | config | out of section F1: fingerprint ของ password กลับเป็นค่าเดิมก่อนเริ่ม section | sha16 of GET /api/config/password policy | ผ่าน |
| E2E-1542 | config | avatar.enabled=false แล้วอัปโหลดรูป: 422 "Avatars are disabled by the current system policy" | PUT /avatar {enabled:false} then PUT /api/users/:id/avatar (multipart png) | ผ่าน |
| E2E-1543 | config | avatar.maxFileSizeKb=1 ทำให้ไฟล์ 4KB ถูกปัด 413 พร้อมเลข limit ที่ตั้งใหม่ (multer อ่าน policy ต่อ request) | PUT /avatar {enabled:true, maxFileSizeKb:1} then 4 KB upload | ผ่าน |
| E2E-1544 | config | avatar.allowedMimeTypes=[image/png] แล้วส่ง jpeg: 415 ระบุรายการที่อนุญาต | PUT /avatar {allowedMimeTypes:[image/png]} then jpeg bytes | ผ่าน |
| E2E-1545 | config | หลังคืนค่า baseline อัปโหลดได้ 201 และอ่านไบต์กลับตรงกับที่ส่ง (เปิด/ปิด config ได้จริง ไม่มี cache ค้าง) | restore + upload 1 KB png + GET /api/users/:id/avatar | ผ่าน |
| E2E-1546 | config | ลบ avatar ของบัญชีทดสอบกลับสู่สภาพเดิม (200) เพื่อไม่ให้ตาราง avatar มีข้อมูลของ suite ค้าง | DELETE /api/users/:id/avatar | ผ่าน |
| E2E-1547 | config | kyc.upload.maxFileSizeKb=1 ทำให้เอกสาร 4KB ของลูกค้าถูกปัด 413 "configured limit of 1 KB" (ค่ากลางมีผลทันที) | PUT /kyc {maxFileSizeKb:1} then upload to CUST-000027 (PENDING) | ผ่าน |
| E2E-1548 | config | หลังคืน policy เป็น 5120 KB อัปโหลดภาพ 4KB ได้ 201 (ยืนยันว่าไม่ cache ค่า 1 KB ไว้) | restore + POST document | **ไม่ผ่าน** |
| E2E-1549 | config | ลบเอกสารที่ใช้ทดสอบเสร็จ: 200 และจำนวนเอกสาร + kycStatus ของลูกค้ากลับเท่าก่อนทดสอบ | CUST-000027: DELETE document แล้วนับเอกสาร + อ่านสถานะ | **ไม่ผ่าน** |
| E2E-1550 | config | แถว number ที่ 0 เป็นค่าที่ตั้งใจตั้ง (zeroIsValue): overlay ให้ 0 มีผลจริง | SQL kyc.expiryWarningDays = 0 | ผ่าน |
| E2E-1551 | config | แถว number ค่า 0 ของฟิลด์ที่ 0 ไม่ใช่ค่าที่ถูกต้อง: overlay ถือเป็น "ไม่ได้ตั้ง" แล้วถอยกลับไป env default | SQL kyc.upload.maxFileSizeKb = 0 | ผ่าน |
| E2E-1552 | config | แถว number ติดลบ: ถูกมองข้ามแบบเดียวกัน | SQL kyc.maxTotalBytesPerCustomer = -1 | ผ่าน |
| E2E-1553 | config | แถว boolean ค่า 2: ไม่ใช่ 1 จึงอ่านเป็น false | SQL avatar.enabled = 2 | ผ่าน |
| E2E-1554 | config | แถว csv ที่ valueText ว่าง: overlay ไม่ทับ จึงได้ default | SQL kyc.upload.allowedMimeTypes = 0 , valueText="" | ผ่าน |
| E2E-1555 | config | docTypes มีค่าแปลกปลอมปน: กรองเหลือเฉพาะชนิดที่รู้จัก | SQL kyc.allowedDocumentTypes = 0 , valueText="NATIONAL_ID,BOGUS_TYPE" | **ไม่ผ่าน** |
| E2E-1556 | config | docTypes แปลกปลอมทั้งแถว: ผลกรองว่าง จึงถอยกลับไป default ทั้งชุด | SQL kyc.allowedDocumentTypes = 0 , valueText="NOPE,NUH_UH" | ผ่าน |
| E2E-1557 | config | mime เก็บ pdf ไว้แถวเดียว: policy แลกเป็น 3 ชนิดที่รองรับ (แถวถูกข้ามเงียบ) | SQL kyc.upload.allowedMimeTypes = 0 , valueText="application/pdf" | ผ่าน |
| E2E-1558 | config | requiredIdentityTypes ตัดกับ allowedDocumentTypes ตอนอ่าน (ชนิดที่ปิดใช้งานถูกลืม) | SQL kyc.allowedDocumentTypes = 0 , valueText="PASSPORT" | ผ่าน |
| E2E-1559 | config | minLength ใน DB ใหญ่กว่า maxLength: overlay แก้ตัวเอง ด้วย clamp (ไม่มี warning) | SQL password.minLength = 100 | ผ่าน |
| E2E-1560 | config | แถว number ทศนิยม (6.50) ผ่าน overlay ได้ ทั้งที่ PUT ต้องจำนวนเต็ม: policy คืน 6.5 (read path ไม่ตรวจ int) | SQL password.minLength = 6.50 | ผ่าน |
| E2E-1561 | config | แต่ API ไม่ยอมรับทศนิยม: PUT {minLength:6.5} = 400 | PUT /api/config/password {minLength: 6.5} | ผ่าน |
| E2E-1562 | config | แถว out-of-band (200000 KB) ทำให้ PUT ที่ไม่เกี่ยวกับ field นั้น fail 422 แต่แก้ได้ใน-band โดยส่ง field นั้นมาด้วย | SQL 200000 -> GET -> PUT {requireFamilyBook} -> PUT {maxFileSizeKb:5120} | ผ่าน |
| E2E-1563 | config | F-CFG-1 (regression): PUT /kyc {expiryWarningDays: 0} ต้องตั้งค่าปิดคำเตือนเอกสารหมดอายุได้จริง (zod อนุญาต 0 และ assertPolicyMakesSense อนุญาต 0) | PUT /api/config/kyc {expiryWarningDays: 0} | ผ่าน |
| E2E-1564 | config | หลัง PUT {expiryWarningDays:60} ค่ากลับมาใช้ได้ปกติ (ยืนยันว่า 0 คือค่าที่ตั้งใจ ไม่ใช่ cache เสีย) | PUT /kyc {expiryWarningDays:60} | ผ่าน |
| E2E-1565 | config | F-CFG-2: PUT /thresholds ต้อง atomic — ค่าที่คอลัมน์ DECIMAL(18,2) รับไม่ไหวไม่ควรทิ้ง config ไว้ครึ่งเดียว | PUT {checker: 5e15 (ในขอบเขต DECIMAL), head: 1e18 (นอกขอบเขต)} | ผ่าน |
| E2E-1566 | config | คืน threshold จาก snapshot ได้ตรง (รวม updatedAt) และ fingerprint กลับเท่า baseline | applySnapshot() + full row diff | ผ่าน |
| E2E-1567 | config | กรณีค่าเกิน DECIMAL ทั้งสองฝั่ง: ไม่ได้เขียนอะไรค้างไว้เลย (เพราะแถวแรกพังก่อน) | PUT {1e18, 1e18} | ผ่าน |
| E2E-1568 | config | audit rows ที่ suite นี้ก่อถูกลบครบ และไม่มี action อื่นเจือ | id-set differencing on audit_logs | ผ่าน |
| E2E-1569 | config | system_config กลับเป็นค่าเดิมทุกแถว ทุกคอลัมน์ (รวม updatedAt) และไม่มี key ค้าง | 24 แถว baseline, เทียบรายคอลัมน์ | ผ่าน |
| E2E-1570 | config | ปิด suite แล้ว fingerprint ทั้ง 4 surface เท่ากับก่อนเริ่ม (config กลางไม่เสียหาย) | thresholds + kyc/password checksum + avatar policy | ผ่าน |
| E2E-1571 | config | จำนวนแถวทุกตารางที่เกี่ยวข้องกลับมาเท่า baseline | system_config,users,user_avatars,user_avatar_contents,kyc_documents,notification_outbox,password_reset_tokens,audit_logs | ผ่าน |
| E2E-1572 | config | ไม่มีบัญชีทดสอบของ suite ค้างใน users | username LIKE 'tst_cf_694321%' | ผ่าน |
| E2E-1573 | concurrency | fixture: สร้างเงินกู้ 6 ฉบับสำหรับแข่งยิง + อ่าน threshold ที่ใช้งานจริงมาคำนวณระดับอนุมัติ | checker=1000000 head=10000000 | ผ่าน |
| E2E-1574 | concurrency | A: โพสต์ transaction APPROVED เดียวพร้อมกัน 4 ครั้ง — สำเร็จครั้งเดียว ที่เหลือ 4xx (มี loan+tx lock) | Promise.all x4 POST /api/transactions/:id/post (admin) | ผ่าน |
| E2E-1575 | concurrency | A: ledger lines ของ transaction ที่ถูกโพสต์ซ้ำ 4 ครั้งมีชุดเดียว (allocation ไม่ถูกเขียนทบ) | financial_transaction_lines ของ tx ที่โพสต์แข่งกัน | ผ่าน |
| E2E-1576 | concurrency | A: audit TRANSACTION_POSTED มีแถวเดียวต่อ transaction (trail ไม่ซ้ำ) | COUNT audit_logs TRANSACTION_POSTED | ผ่าน |
| E2E-1577 | concurrency | LP: ยอดคงค้างจริง = oracle ทุกทศนิยม (race ไม่ทำให้เงินงอกหรือหาย) | GET /api/loans/LN-000022 | ผ่าน |
| E2E-1578 | concurrency | B: approve payment request PENDING เดียวพร้อมกัน 3 ครั้ง — สำเร็จครั้งเดียว (request row ถูก write-lock) | Promise.all x3 POST /api/payment-requests/:id/approve | ผ่าน |
| E2E-1579 | concurrency | B: ไม่เกิด transaction ซ้ำจาก request เดียว (เงินไม่ถูกบันทึกลง ledger สองรอบ) | COUNT financial_transactions WHERE sourceRequestId = request ที่ approve พร้อมกัน 3 ครั้ง | ผ่าน |
| E2E-1580 | concurrency | B: request จบที่ APPROVED ครั้งเดียว + audit PAYMENT_REQUEST_APPROVED 1 แถว | payment_requests.status + COUNT audit | ผ่าน |
| E2E-1581 | concurrency | F-CONC-3: Checker สองคนอนุมัติ approval step เดียวกันพร้อมกัน — ต้องมีผู้ชนะคนเดียว | penalty 5000000.00 (ระดับ CHECKER -> HEAD) แล้ว POST /api/approvals/steps/53ae7f04-13ff-4b93-b12c-b7c9a467e4aa/decision x2 (checker1, checker2) | ผ่าน |
| E2E-1582 | concurrency | C: workflow ไม่ข้ามระดับ — currentLevelIndex เพิ่มครั้งเดียวและยังไม่ APPROVED | approval_workflows ของ penalty ที่ถูกกดซ้ำ | ผ่าน |
| E2E-1583 | concurrency | C: หลักฐานการอนุมัติระดับ CHECKER มีครั้งเดียวใน audit trail | COUNT audit APPROVAL_STEP_APPROVED ของ transaction ที่กดซ้ำพร้อมกัน | ผ่าน |
| E2E-1584 | concurrency | C: ยังโพสต์ไม่ได้ถ้า HEAD ไม่ได้ approve (ลำดับชั้นอนุมัติยังบังคับจริงหลัง race) | POST /transactions/:id/post หลัง race ที่ระดับ CHECKER | ผ่าน |
| E2E-1585 | concurrency | C: หลัง HEAD approve ตามทางเดินจริงจึงโพสต์ได้ และค่าปรับเข้าบัญชีครั้งเดียว | HEAD decision + POST /transactions/:id/post | ผ่าน |
| E2E-1586 | concurrency | LA: ยอดคงค้างจริง = oracle ทุกทศนิยม (race ไม่ทำให้เงินงอกหรือหาย) | GET /api/loans/LN-000026 | ผ่าน |
| E2E-1587 | concurrency | D fixture: ฝาก 400,000 เป็น deposit -> credit คงเหลือ 400,000 ส่วนหนี้ LC1 ไม่ขยับ | cash 400000.00 purpose DEPOSIT_TO_CREDIT บนยอดค้าง 1108000.00 | ผ่าน |
| E2E-1588 | concurrency | D fixture: จ่ายปิด LC1 พอดีทุกส่วน -> CLOSED และ credit 400,000 ยังอยู่ (ไม่ถูกดึงไปปิดหนี้เอง) | cash 1108000.00 บนยอดค้าง 1108000.00 | ผ่าน |
| E2E-1589 | concurrency | D: ตอนสร้างคำขอ ระบบยอมรับให้ใช้ credit 400,000 ซ้ำสองรอบ (ไม่มีการกันวงเงิน) | POST /api/payment-requests x2 (คนละ loan, ลูกค้าเดียวกัน) creditToApply 400,000 เท่ากัน | ผ่าน |
| E2E-1590 | concurrency | F-CONC-1: ใช้ credit 400,000 บนเงินกู้ 2 ฉบับพร้อมกัน — ต้องมีอย่างน้อยหนึ่งครั้งที่ถูกปฏิเสธ | Promise.all POST /transactions/:id/post x2 (approve codes=200/200) | ผ่าน |
| E2E-1591 | concurrency | F-CONC-1: บัญชี credit ปิดยอด — ACCRUED - USED ต้องเท่ากับ balance ที่เก็บไว้ | SUM(credit_ledger ACCRUED/USED) vs customer_credits.balance ของ C5 | ผ่าน |
| E2E-1592 | concurrency | F-CONC-1: ยอด credit ที่ใช้รวม (USED) ต้องไม่เกิน 400,000 ที่มีอยู่จริง (เงินไม่ถูกเสกขึ้น) | SUM(amount) ของ credit_ledger type=USED | ผ่าน |
| E2E-1593 | concurrency | D: balance ของลูกค้าไม่ติดลบ (invariant ที่ล็อกไว้) | customer_credits.balance | ผ่าน |
| E2E-1594 | concurrency | LC2: ยอดคงค้างจริง = oracle ทุกทศนิยม (race ไม่ทำให้เงินงอกหรือหาย) | GET /api/loans/LN-000024 | ผ่าน |
| E2E-1595 | concurrency | LC3: ยอดคงค้างจริง = oracle ทุกทศนิยม (race ไม่ทำให้เงินงอกหรือหาย) | GET /api/loans/LN-000025 | ผ่าน |
| E2E-1596 | concurrency | E fixture: โพสต์ payment 600,000 ของต้นทางที่จะถูกกลับรายการ (ต้อง POSTED reversal ถึงสร้างได้) | POST /api/transactions/:id/post ของ payment ที่ approve แล้ว | ผ่าน |
| E2E-1597 | concurrency | LP: ยอดคงค้างจริง = oracle ทุกทศนิยม (race ไม่ทำให้เงินงอกหรือหาย) | GET /api/loans/LN-000022 | ผ่าน |
| E2E-1598 | concurrency | F-CONC-OBS-2: ยิงสร้างคำขอกลับรายการทั้งจำนวนพร้อมกัน 2 ครั้ง — อีกครั้งล้มเหลวด้วย 409 (ชนเลข referenceNo ไม่ใช่การกันยอด) | Promise.all x2 POST /api/transactions/reversals amount=600,000 (ทั้งจำนวนของต้นทาง) | ผ่าน |
| E2E-1599 | concurrency | E: ระบบยอมให้สร้าง reversal ทั้งจำนวนอีกฉบับ ทั้งที่มี draft 600,000 ค้างอยู่ (นับเฉพาะยอดที่ POSTED) | POST /api/transactions/reversals amount=600,000 ตามหลังคำขอแรก (201,409) | ผ่าน |
| E2E-1600 | concurrency | E: reversal ทั้งจำนวนของ payment เดียวถูกโพสต์พร้อมกัน — สำเร็จครั้งเดียว (จุดนี้ระบบป้องกันได้จริง) | POST /transactions/:id/post x2 สำหรับ reversal ที่อนุมัติแล้ว codes=422,200 | ผ่าน |
| E2E-1601 | concurrency | E: ยอดรวมที่กลับรายการ (POSTED) ต้องไม่เกิน 600,000 ของรายการต้นทาง | SUM \|lines\| ของ PAYMENT_REVERSAL ที่ POSTED ซึ่งอ้างถึง payment เดียว | ผ่าน |
| E2E-1602 | concurrency | LP: ยอดคงค้างจริง = oracle ทุกทศนิยม (race ไม่ทำให้เงินงอกหรือหาย) | GET /api/loans/LN-000022 | **ไม่ผ่าน** |
| E2E-1603 | concurrency | F fixture: ขอ OTP ผ่าน forgot-password แล้วอ่านรหัสจาก outbox แบบซีลได้ | POST /api/users (tst_cj_694324_pw) แล้ว POST /api/auth/forgot-password | ผ่าน |
| E2E-1604 | concurrency | F-CONC-4: OTP เดียวถูกนำไป verify พร้อมกัน 3 ครั้ง — ต้องแลก reset link ได้ครั้งเดียว (single use) | Promise.all x3 POST /api/auth/verify-otp ด้วยรหัสที่ถูก | ผ่าน |
| E2E-1605 | concurrency | F: จำนวนแถว LINK ที่เกิดจากการ verify พร้อมกัน เท่ากับจำนวนครั้งที่ระบบตอบ 200 | password_reset_tokens kind=LINK ของบัญชีทดสอบ | ผ่าน |
| E2E-1606 | concurrency | F: ใช้ OTP เดียวซ้ำแบบตามหลัง (ไม่ใช่พร้อมกัน) ถูกปฏิเสธ 400 | verify-otp ด้วยรหัสเดิมหลัง burst | ผ่าน |
| E2E-1607 | concurrency | F-CONC-4: การเดารหัสผิดพร้อมกัน 8 ครั้งต้องถูกนับครบและ burn ภายใน 5 ครั้ง | Promise.all x8 verify-otp ด้วยรหัสผิด (400=8, 429=0) | ผ่าน |
| E2E-1608 | concurrency | F-CONC-4: หลังเดารหัสผิดครบ 5 ครั้ง OTP ต้องใช้ไม่ได้แม้ใส่รหัสที่ถูก | verify-otp ด้วยรหัสที่ถูกหลัง burst ของรหัสผิด | ผ่าน |
| E2E-1609 | concurrency | F-CONC-4: reset link ใช้ครั้งเดียว — ส่ง 2 รหัสผ่านต่างกันไปพร้อมกันต้องมีผู้ชนะคนเดียว | Promise.all x2 POST /api/auth/reset-password ด้วย link เดียว (password ต่างกัน) | ผ่าน |
| E2E-1610 | concurrency | F: รหัสผ่านที่ระบบ "ยืนยันว่าตั้งสำเร็จ" ต้องเป็นรหัสที่ login ได้จริง | POST /api/auth/login x2 (A=401, B=200) หลัง race reset | ผ่าน |
| E2E-1611 | concurrency | G fixture: ข้อตกลงปิดบัญชี 300,000 ผ่าน approval เป็น APPROVED แล้ว | POST /api/settlements + CHECKER decision | ผ่าน |
| E2E-1612 | concurrency | F-CONC-OBS-1: ยิงสร้างคำขอชำระตามข้อตกลงพร้อมกัน 2 ครั้ง — อีกครั้งล้มเหลวด้วย 409 "That record already exists" (ชนเลข requestNo ไม่ใช่การกันเงิน) | Promise.all x2 POST /api/settlements/:id/settlement-payment cash=300,000 | ผ่าน |
| E2E-1613 | concurrency | G: ระบบยอมให้สร้างคำขอชำระตามข้อตกลงเต็มจำนวนอีกคำขอ ทั้งที่มีคำขอ 300,000 ค้างอยู่ (ไม่มีการกันวงเงิน) | POST /api/settlements/:id/settlement-payment cash=300,000 (ตามหลังคำขอแรก 409,201) | ผ่าน |
| E2E-1614 | concurrency | F-CONC-5: ยอดที่ POSTED ตามข้อตกลงปิดบัญชีต้อง <= agreedAmount 300,000 (จ่ายซ้ำไม่ได้) | SUM(amount) ของ SETTLEMENT_PAYMENT ที่ POSTED (2 โพสต์แข่งกัน codes=200,422) | ผ่าน |
| E2E-1615 | concurrency | LS: ยอดคงค้างจริง = oracle ทุกทศนิยม (race ไม่ทำให้เงินงอกหรือหาย) | GET /api/loans/LN-000027 | ผ่าน |
| E2E-1616 | concurrency | H: สอง admin ตั้ง approval threshold พร้อมกัน — ค่าที่ใช้งานจริงต้องยัง head >= checker (race ไม่คงที่: run ใดสลับแถวจะผิดทันที) | Promise.all PUT {checker:1200000, head:10200000} และ {checker:700000, head:900000} | ผ่าน |
| E2E-1617 | concurrency | H: คืน threshold ด้วย snapshot แล้ว GET ได้ค่าเดิมเป๊ะ (config กลางไม่เสียหายจาก suite นี้) | restore จากแถว approval.* ใน system_config | ผ่าน |
| E2E-1618 | concurrency | I: ไม่มี loan ใด (รวม 21 สินทรัพย์จาก seed) มียอดคงค้างติดลบหลังจบทุก race | SELECT loans WHERE outstandingPenalty/PastInterest/PastPrincipal < 0 | ผ่าน |
| E2E-1619 | concurrency | I: ลบ audit trail ที่ suite นี้ก่อออกครบ (id differencing) และไม่มี action แปลกปลอมเจือ | id-set differencing บน audit_logs เทียบกับก่อนเริ่ม suite | ผ่าน |
| E2E-1620 | concurrency | I: บัญชี credit ทุกรายปิดยอด (SUM ledger = balance) เท่ากับสถานะก่อนเริ่ม suite | เทียบ set ของลูกค้าที่ ledger ไม่ตรงกับ balance หลัง purge | ผ่าน |
| E2E-1621 | concurrency | I: จำนวนแถวทุกตารางที่เกี่ยวข้องกลับมาเท่า baseline (suite ไม่ทิ้งข้อมูลไว้) | loans,payment_requests,payment_allocations,financial_transactions,financial_transaction_lines,credit_ledger,customer_credits,approval_workflows,approval_steps,s | ผ่าน |
| E2E-1622 | concurrency | I: ไม่มี loan / user / credit / agreement ของ suite ค้างในตาราง | COUNT ตาม id ที่ suite สร้าง | ผ่าน |
| E2E-1623 | concurrency | I: ลูกค้า C5-C8 กลับไปไม่มีแถว credit (สถานะเดียวกับที่ suite ก่อนหน้าทิ้งไว้) | customer_credits WHERE customerId IN (C5,C6,C7,C8) | ผ่าน |
| E2E-1624 | invariants | A: เงินกู้ทั้ง 21 ฉบับจาก expected.json มีอยู่จริงใน DB และอ่านยอดคงค้างครบทุกแถว | loans JOIN expected.loans ตาม loanId | ผ่าน |
| E2E-1625 | invariants | A: จำนวนแถวของตารางบัญชีใน scope seed เท่ากับตอน seed (ไม่มีแถวหาย/เกิดเพิ่มหลังรัน 14 suite) | COUNT ของ transactions / lines / payment_requests / agreements (เฉพาะ loan จาก seed) | ผ่าน |
| E2E-1626 | invariants | A: ไม่มีความสัมพันธ์โหว่ (ทุกแถวอ้างถึงแถวที่มีอยู่จริง) | ตรวจ reference ของ 6 ความสัมพันธ์หลัก | ผ่าน |
| E2E-1627 | invariants | A: ลูกค้าของเงินกู้ seedทุกรายมีแถวใน customers ครบ และไม่ซ้ำกับ loan ที่ไม่มีจริง | DISTINCT loans.customerId ของ scope seed | ผ่าน |
| E2E-1628 | invariants | B: ยอดคงค้างรายส่วนทุก loan = expected.json (ต้นทางคือ oracle ที่ generate ข้อมูล) | loans.outstandingPenalty/PastInterest/PastPrincipal/currentOutstanding vs expected.loans[*].outstanding | ผ่าน |
| E2E-1629 | invariants | B: currentOutstanding = ผลรวมสามส่วนเสมอ (invariant ของคอลัมน์ที่เก็บไว้) | SUM(outstandingPenalty+PastInterest+PastPrincipal) vs currentOutstanding | ผ่าน |
| E2E-1630 | invariants | B: ยอดที่ derive จาก ledger (เส้น POSTED) = คอลัมน์ที่เก็บไว้ ทุก loan ทุกทศนิยม | SUM(financial_transaction_lines.amount) ราย loan ราย component vs loans.outstanding* | ผ่าน |
| E2E-1631 | invariants | B: สถานะ loan ทุกฉบับ = ตามกฎปิดบัญชีใน expected.statuses | loans.status vs expected.statuses | ผ่าน |
| E2E-1632 | invariants | B: จำนวน transaction (POSTED / ที่ยังไม่โพสต์) ของทุก loan = expected | COUNT financial_transactions ราย loan แยกตามสถานะ | ผ่าน |
| E2E-1633 | invariants | B: มุมมองที่สี่ — GET /api/loans/:id ให้ยอดคงค้างตรงกับ DB ทุกฉบับ | GET /api/loans/:id สำหรับ loan seed 21 ฉบับ | ผ่าน |
| E2E-1634 | invariants | B: สกุลเงินเป็น LAK ทุกบัญชี, snapshot นโยบายค่าปรับตรงกับผลิตภัณฑ์, ดอกเบี้ย flat = สูตร | loans.currency / penaltyPolicy vs loan_products + billedInterestCents() vs เส้น DISBURSEMENT | ผ่าน |
| E2E-1635 | invariants | C: replay ทั้งชุดด้วย oracle ไม่มีรายการใดผิดกติกา (relief เกินยอด / ชนิดไม่รู้จัก / ต้นทาง reversal หาย / เพิ่มยอดไม่ตรงจำนวน) | postEvent() ทุกแถว POSTED เรียงตาม postedAt ของ loan seed | ผ่าน |
| E2E-1636 | invariants | C: การจัดสรรเงินจ่ายรายส่วน = ลำดับล็อก (ค่าปรับ -> ดอกเบี้ย -> ต้นเงิน) ทุกฉบับ | allocateComponents() ของ oracle vs financial_transactions.componentAmounts | ผ่าน |
| E2E-1637 | invariants | C: ไม่มีส่วนใดของยอดคงค้างติดลบระหว่าง replay (invariant ที่ล็อกไว้) | ตรวจ components >= 0 ทุกขั้นตอนของ replay | ผ่าน |
| E2E-1638 | invariants | C: ยอดกลับรายการไม่เคยเกินรายการต้นทาง (walk ตาม allocation เดิม ไม่เฉลี่ย pro-rata) | reverseAllocation(originalAllocation, amount) ของทุก *_REVERSAL | ผ่าน |
| E2E-1639 | invariants | C: สั้น ๆ — replay จากเส้น ledger ให้ยอดคงค้างสุดท้ายตรงกับ expected.json ทุกฉบับ | state หลัง replay vs expected.loans[*].outstanding | ผ่าน |
| E2E-1640 | invariants | C: สถานะสุดท้ายจาก replay = สถานะใน DB = ตามกฎปิดบัญชี | statusAfterPost() ทุกเหตุการณ์ vs loans.status | ผ่าน |
| E2E-1641 | invariants | D: booked รายเดือนจาก ledger = expected.monthly (เงินที่ปล่อยกู้จริง/ที่บันทึกรวมดอกเบี้ย) | SUM(POSTED DISBURSEMENT) จัดกลุ่มตามเดือนของ postedAt | ผ่าน |
| E2E-1642 | invariants | D: disbursedCash รายเดือนจาก ledger = expected.monthly (เงินที่ปล่อยกู้จริง/ที่บันทึกรวมดอกเบี้ย) | SUM(POSTED DISBURSEMENT) จัดกลุ่มตามเดือนของ postedAt | ผ่าน |
| E2E-1643 | invariants | D: moneyIn รายเดือนจาก ledger = expected.monthly | SUM(รายการ POSTED) ตามประเภท/รายส่วน จัดกลุ่มตามเดือน | ผ่าน |
| E2E-1644 | invariants | D: collected รายเดือนจาก ledger = expected.monthly | SUM(รายการ POSTED) ตามประเภท/รายส่วน จัดกลุ่มตามเดือน | ผ่าน |
| E2E-1645 | invariants | D: interestPaid รายเดือนจาก ledger = expected.monthly | SUM(รายการ POSTED) ตามประเภท/รายส่วน จัดกลุ่มตามเดือน | ผ่าน |
| E2E-1646 | invariants | D: penaltyPaid รายเดือนจาก ledger = expected.monthly | SUM(รายการ POSTED) ตามประเภท/รายส่วน จัดกลุ่มตามเดือน | ผ่าน |
| E2E-1647 | invariants | D: principalPaid รายเดือนจาก ledger = expected.monthly | SUM(รายการ POSTED) ตามประเภท/รายส่วน จัดกลุ่มตามเดือน | ผ่าน |
| E2E-1648 | invariants | D: penaltyCharged รายเดือนจาก ledger = expected.monthly | SUM(รายการ POSTED) ตามประเภท/รายส่วน จัดกลุ่มตามเดือน | ผ่าน |
| E2E-1649 | invariants | D: reversed รายเดือนจาก ledger = expected.monthly | SUM(รายการ POSTED) ตามประเภท/รายส่วน จัดกลุ่มตามเดือน | ผ่าน |
| E2E-1650 | invariants | D: waived รายเดือนจาก ledger = expected.monthly | SUM(รายการ POSTED) ตามประเภท/รายส่วน จัดกลุ่มตามเดือน | ผ่าน |
| E2E-1651 | invariants | D: writtenOff รายเดือนจาก ledger = expected.monthly | SUM(รายการ POSTED) ตามประเภท/รายส่วน จัดกลุ่มตามเดือน | ผ่าน |
| E2E-1652 | invariants | D: จำนวน transaction ต่อเดือน = expected.monthly | COUNT(POSTED) รายเดือน | ผ่าน |
| E2E-1653 | invariants | D: รวม 16 เดือนต้องเท่ากับ expected.totals (รายงานจะสลับช่วงเวลาไม่ได้ถ้ายอดรวมไม่ปิด) | SUM รายเดือนทั้ง 16 เทียบ expected.totals | ผ่าน |
| E2E-1654 | invariants | D: จำนวน transaction ที่โพสต์ทั้งชุด = expected.totals.postedTransactions | COUNT(POSTED ของ loan seed) | ผ่าน |
| E2E-1655 | invariants | E: ค่า book สิ้นงวดราย loan รายเดือน = replay ของ oracle ตาม expected.closingOutstandingByLoan | 21 loans x 16 เดือน (มูลค่าจาก history ที่ postedAt <= สิ้นเดือน) | ผ่าน |
| E2E-1656 | invariants | E: ค่า book สิ้นงวดยรวมทุก loan = expected.closingOutstandingByMonth | SUM ราย loan แล้วเทียบระดับเดือน | ผ่าน |
| E2E-1657 | invariants | E: invariants สุดท้ายของงวด — ledger = loan book = ปิดยอดสิ้นเดือน = expected.totals | SUM(loans.currentOutstanding) vs SUM(replay components) vs closingOutstandingByMonth เดือนสุดท้าย | ผ่าน |
| E2E-1658 | invariants | E: การกระจายสถานะและ loan ยอดใหญ่สุด = expected.invariant | GROUP BY loans.status + MAX(currentOutstanding) | ผ่าน |
| E2E-1659 | invariants | F: บัญชี credit ของลูกค้า = expected.credits ทั้งจำนวนและลำดับเส้น | customer_credits + credit_ledger เทียบ expected.credits | ผ่าน |
| E2E-1660 | invariants | F: เส้น credit_ledger เดินยอดต่อเนื่องและ balance ที่เก็บไว้ = ผลเดินเส้น (บัญชีไม่ปิดเกินจริง) | replay credit_ledger รายลูกค้า (ACCRUED บวก, USED ลบ) | ผ่าน |
| E2E-1661 | invariants | F: ทุกเส้น USED ผูกกับ payment ที่ใช้ credit จริง และไม่มี ledger ของบัญชีที่ไม่มี customer_credits | credit_ledger JOIN financial_transactions JOIN payment_requests | ผ่าน |
| E2E-1662 | invariants | G: ระดับอนุมัติของทุกรายการ = สูตร threshold ที่ล็อกไว้ (คำนวณซ้ำจากจำนวนเงินปัจจุบัน) | computeRequiredLevels() ใหม่ เทียบ approval_workflows.requiredLevels (checker 1000000 head 10000000) | ผ่าน |
| E2E-1663 | invariants | G: maker-checker แยกขาดจริงในข้อมูล — ไม่มีรายการที่อนุมัติโดยผู้สร้าง และไม่มี step ค้างหลังการโพสต์ | approval_steps.status/userId + payment_requests.approvedBy + settlement_agreements.decidedBy | ผ่าน |
| E2E-1664 | invariants | G: เลขอ้างอิงไม่ซ้ำ && payment request หนึ่งใบสร้าง transaction ได้สูงสุดหนึ่งครั้ง | ตรวจ duplicate ของ 4 คอลัมน์เลขอ้างอิง + COUNT(tx per request) | ผ่าน |
| E2E-1665 | invariants | G: ทุกรายการ POSTED ต้องมีเส้น ledger ที่รวมแล้ว = เงินที่เข้ามา หัก credit ที่เกิดจากใบนั้น และรายการที่ยังไม่โพสต์ต้องไม่มีเส้น ledger | financial_transaction_lines JOIN financial_transactions + credit_ledger(ACCRUED per transaction) | ผ่าน |
| E2E-1666 | invariants | G: ที่ข้อมูลพักอยู่ — ยอดกลับรายการ<=ต้นทาง และยอดที่โพสต์ตามข้อตกลงปิดบัญชี<=วงเงินที่ตกลง | SUM(POSTED reversals) per referenceTransactionId + SUM(POSTED SETTLEMENT_PAYMENT) per agreement | ผ่าน |
| E2E-1667 | invariants | G: audit trail ครอบคลุมเหตุการณ์เงินจริงทุกรายการ (ไม่มี money movement โดยไม่มี trail) | NOT EXISTS บน audit_logs สำหรับทุก POSTED / ทุก request ที่ APPROVED + COUNT แถว step เทียบจำนวน step ที่อนุมัติ | ผ่าน |
| E2E-1668 | invariants | F-INV-1: ทุก step ที่ APPROVED ต้องมี audit ที่อ้าง transactionId ของเอกสารที่ถูกอนุมัติ (per-document attribution) | approval_steps -> audit_logs(APPROVAL_STEP_APPROVED, transactionId, userId) | ผ่าน |
| E2E-1669 | invariants | H: ทุก loan ที่เกิดขึ้นมาแล้วต้องเป็นของลูกค้าที่ KYC VERIFIED เท่านั้น (hard gate ก่อน disbursal) | loans JOIN customers WHERE kycStatus != VERIFIED | ผ่าน |
| E2E-1670 | invariants | H: threshold ที่ใช้งานจริงต้อง head >= checker (invariant ของ config กลาง) | system_config approval.checkerThreshold / approval.headThreshold | ผ่าน |
| E2E-1671 | invariants | H: ยอดคงค้างทุกฉบับอยู่ภายในขอบ [0, เงินต้น + ดอกเบี้ย flat + ค่าปรับที่เรียกเก็บจริง] | เพดานคำนวณต่อ loan จาก expected.billedInterest + PENALTY ที่โพสต์แล้ว | ผ่าน |
| E2E-1672 | invariants | I: รายการ loans ผ่าน API ให้ยอดคงค้างรวมเท่ากับ loan book ใน DB | GET /api/loans?limit=100 แล้ว SUM(outstanding.total) เฉพาะ loan ของ seed | ผ่าน |
| E2E-1673 | invariants | I: รายงาน /api/reports/monthly = ตัวเลขที่ derive จาก ledger (มุมที่สามต้องตรงกัน) | GET /api/reports/monthly?months=16 เทียบ ledger-derived รายเดือน | ผ่าน |
| E2E-1674 | invariants | I: dashboard อ่านได้และตัวเลขตรงกับตาราง (มุมที่ห้า: นับทั้งตาราง ไม่ใช่เฉพาะ scope seed) | GET /api/dashboard/stats เทียบ COUNT/SUM ตรงจากตาราง | ผ่าน |
| E2E-1675 | interest | ผลิตภัณฑ์ตั้ง interestMethod = DECLINING ได้ และอ่านกลับค่าเดิมทั้ง API + DB | POST /api/loan-products code=TST-S16-DECL interestMethod=DECLINING | ผ่าน |
| E2E-1676 | interest | ไม่ส่ง interestMethod = FLAT ซึ่งเป็นพฤติกรรมเดิมของผู้เรียกเก่า | POST /api/loan-products โดยไม่ระบุ interestMethod | ผ่าน |
| E2E-1677 | interest | interestMethod ที่ไม่ใช่ FLAT/DECLINING: 400 | interestMethod=REDUCING_MONTHLY | ผ่าน |
| E2E-1678 | interest | PATCH เปลี่ยนผลิตภัณฑ์เป็น DECLINING: 200 | interestMethod=DECLINING | ผ่าน |
| E2E-1679 | interest | audit ของ PATCH describes วิธีคิดดอกเบี้ยให้อ่านรู้เรื่องโดยไม่ lookup | TST-S16-DEFAULT -> DECLINING | ผ่าน |
| E2E-1680 | interest | ผลิตภัณฑ์ seed เดิมทั้งสมุดยัง FLAT (ค่า default ไม่ไปแก้ของที่มีอยู่ก่อน) | 8 seeded products | ผ่าน |
| E2E-1681 | interest | LN-000022: DISBURSEMENT บิลดอกเบี้ยแค่งวดแรกงวดเดียว = 14400.00 (ต้น 1200000.00 x 1.2%/เดือน) | oracle.decliningPeriodInterestCents(P, 1 period) | ผ่าน |
| E2E-1682 | interest | LN-000022: ไม่ bill ดอกทั้ง_termก้อนเดียว (FLAT would be 172800.00 > booked 14400.00) | oracle.billedInterestCents over 12m = 172800.00 | ผ่าน |
| E2E-1683 | interest | LN-000022: loan snapshot interestMethod = DECLINING ทั้ง API และ DB | loans.interestMethod | ผ่าน |
| E2E-1684 | interest | LN-000022: แถว DISBURSEMENT ถือ periodIndex = 1 (งวดแรกที่จ่ายไปตอนปล่อยกู้) | financial_transactions.periodIndex | ผ่าน |
| E2E-1685 | interest | LN-000023: DISBURSEMENT บิลดอกเบี้ยแค่งวดแรกงวดเดียว = 14400.00 (ต้น 1200000.00 x 1.2%/เดือน) | oracle.decliningPeriodInterestCents(P, 1 period) | ผ่าน |
| E2E-1686 | interest | LN-000023: ไม่ bill ดอกทั้ง_termก้อนเดียว (FLAT would be 172800.00 > booked 14400.00) | oracle.billedInterestCents over 12m = 172800.00 | ผ่าน |
| E2E-1687 | interest | LN-000023: loan snapshot interestMethod = DECLINING ทั้ง API และ DB | loans.interestMethod | ผ่าน |
| E2E-1688 | interest | LN-000023: แถว DISBURSEMENT ถือ periodIndex = 1 (งวดแรกที่จ่ายไปตอนปล่อยกู้) | financial_transactions.periodIndex | ผ่าน |
| E2E-1689 | interest | LN-000025: DISBURSEMENT บิลดอกเบี้ยแค่งวดแรกงวดเดียว = 1200.00 (ต้น 100000.00 x 1.2%/เดือน) | oracle.decliningPeriodInterestCents(P, 1 period) | ผ่าน |
| E2E-1690 | interest | LN-000025: ไม่ bill ดอกทั้ง_termก้อนเดียว (FLAT would be 14400.00 > booked 1200.00) | oracle.billedInterestCents over 12m = 14400.00 | ผ่าน |
| E2E-1691 | interest | LN-000025: loan snapshot interestMethod = DECLINING ทั้ง API และ DB | loans.interestMethod | ผ่าน |
| E2E-1692 | interest | LN-000025: แถว DISBURSEMENT ถือ periodIndex = 1 (งวดแรกที่จ่ายไปตอนปล่อยกู้) | financial_transactions.periodIndex | ผ่าน |
| E2E-1693 | interest | LN-000024 (FLAT control): ยัง bill ก้อนเดียว 36000.00 และ periodIndex = NULL | oracle.billedInterestCents + DB periodIndex | ผ่าน |
| E2E-1694 | interest | LN-000022: schedule บอก interestMethod = DECLINING และนับงวดตาม term (12) | GET /loans/:id/schedule?asOf=2026-02-16 | ผ่าน |
| E2E-1695 | interest | LN-000022: ก่อน accrual ดอกเบี้ยอยู่แค่งวด 1 ส่วนงวด 2..12 เป็น 0 | periods[].interestDue | ผ่าน |
| E2E-1696 | interest | LN-000023: ชำระกลางงวด 100,000.00 -> จ่ายดอกว่างวด 1 ก่อน แล้วที่เหลือตัดเงินต้น (PENALTY->INTEREST->PRINCIPAL) | payment 100000.00 | ผ่าน |
| E2E-1697 | interest | LN-000023: prepay กลางงวดไม่ re-price งวด 1 ที่ bill แล้ว (ไม่ prorate รายวัน) | periods[0].interestDue หลังชำระเงินต้น | ผ่าน |
| E2E-1698 | interest | asOf ยังไม่ถึงต้นงวด 2: ไม่มีอะไรต้องเก็บ และ skipped ว่างวดที่เริ่มไปแล้วถูก bill หมด | GET /interest/due?asOf=2026-02-01&loanIds=A,B (งวด 2 เริ่ม 2026-02-15) | ผ่าน |
| E2E-1699 | interest | asOf เลยต้นงวด 2 แล้ว: due list คืนงวดถัดไปของทั้งสองกู้ ยอดคำนวณจากเงินต้นคงเหลือจริง | GET /interest/due?asOf=2026-02-16&loanIds=A,B | ผ่าน |
| E2E-1700 | interest | กู้ที่จ่ายต้นกลางงวดถูก bill งวดถัดไปถูกลง (13372.80 < 14400.00) — base คือยอดคงเหลือ ไม่ใช่เงินต้นตอนปล่อยกู้ | B base 1114400 x 1.2% | ผ่าน |
| E2E-1701 | interest | due list มี totals ครบ (loans/periods/amount) และแต่ละแถวมี loanNumber + customerName ให้ UI ใช้ได้ทันที | GET /interest/due | ผ่าน |
| E2E-1702 | interest | กู้ FLAT ไม่โผล่ใน due list เลย (ไม่ถูก query ทั้ง items และ skipped) | GET /interest/due?loanIds=LN-000024 | ผ่าน |
| E2E-1703 | interest | asOf เลยไปหลายงวด: เรียกเก็บทีละงวดต่อครั้ง และ missingPeriods นับงวดที่ยังไม่ bill ครบ | GET /interest/due?asOf=2028-01-01&loanIds=B (bill แล้วแค่งวด 1) | ผ่าน |
| E2E-1704 | interest | accrue แบบ dryRun: 200 พร้อม wouldCreate แต่ไม่มีแถวเกิดขึ้นจริง | dryRun=true | ผ่าน |
| E2E-1705 | interest | dryRun คืน wouldCreate ตรงกับ due list และไม่สร้าง INTEREST_ACCRUAL | POST /interest/accrue dryRun | ผ่าน |
| E2E-1706 | interest | accrue จริง: 201 สร้าง INTEREST_ACCRUAL ต่อกู้หนึ่งรายการ | POST /interest/accrue | ผ่าน |
| E2E-1707 | interest | รายการที่สร้างเป็น PENDING_APPROVAL, periodIndex = 2, ยอดตรงกับ due list | financial_transactions ของรอบ accrue แรก | ผ่าน |
| E2E-1708 | interest | accrue รับ reason จากผู้ใช้งานไปเก็บตรงๆ (ให้บันทึกชุดดอกทั้งรอบอธิบายตัวเองได้) | POST /interest/accrue + reason="monthly interest run (suite 16)" | ผ่าน |
| E2E-1709 | interest | ดอกเบี้ยที่ยัง PENDING_APPROVAL ต้องไม่ขยับยอดคงค้าง (maker-checker ยังไม่จบ) | loan outstanding หลัง accrue ก่อน approve | ผ่าน |
| E2E-1710 | interest | accrue ซ้ำด้วย asOf เดิม: ไม่สร้างอะไรเพิ่ม (idempotent ต่อ loan+periodIndex) | POST /interest/accrue ซ้ำครั้งที่สอง | ผ่าน |
| E2E-1711 | interest | accrue ด้วย asOf ก่อนงวดเริ่ม: ไม่สร้างย้อนหลัง (created 0) | asOf=2026-02-01 (งวด 2 เริ่ม 2026-02-15) | ผ่าน |
| E2E-1712 | interest | accrue ไม่มี token: 401 | anonymous | ผ่าน |
| E2E-1713 | interest | accrue ด้วย VIEWER: 403 | test_view1 | ผ่าน |
| E2E-1714 | interest | accrue ด้วย asOf ไม่ถูก format: 400 | asOf=2026-13-45 | ผ่าน |
| E2E-1715 | interest | accrue ด้วย loanIds ที่ไม่ใช่ uuid: 400 | loanIds=["not-a-uuid"] | ผ่าน |
| E2E-1716 | interest | bulk-decision ด้วย MAKER: 403 | test_op1 | ผ่าน |
| E2E-1717 | interest | bulk-decision ด้วย VIEWER: 403 | test_view1 | ผ่าน |
| E2E-1718 | interest | bulk-decision ไม่มี token: 401 | anonymous | ผ่าน |
| E2E-1719 | interest | bulk-decision stepIds ว่าง: 400 | stepIds=[] | ผ่าน |
| E2E-1720 | interest | bulk-decision เกิน 200 step ต่อคำขอ: 400 | 201 stepIds | ผ่าน |
| E2E-1721 | interest | bulk approve สองงวดในคำขอเดียว: 200 | stepIds=[A,B] | ผ่าน |
| E2E-1722 | interest | bulk-decision รายงานรายข้อ (requested/decided/declined + subjectId ต่อข้อ) ให้ UI ลิสต์ผลได้ | POST /approvals/steps/bulk-decision | ผ่าน |
| E2E-1723 | interest | หลัง bulk approve ทั้งสอง workflow ต้อง APPROVED (transaction พร้อมโพสต์) | financial_transactions หลัง bulk approve | ผ่าน |
| E2E-1724 | interest | หลัง approve+post: ยอดคงค้างเพิ่มเท่าดอกเบี้ยที่โพสต์ ตรงกับ oracle ทุก component | loan outstanding vs oracle postEvent(INTEREST_ACCRUAL) | ผ่าน |
| E2E-1725 | interest | ทุก INTEREST_ACCRUAL ที่ POSTED มีเส้นเดียวเป็น PAST_INTEREST = จำนวนเงิน (ไม่แตะต้น/ค่าปรับ) | financial_transaction_lines ของรอบ accrue | ผ่าน |
| E2E-1726 | interest | LN-000022: งวด 2 แสดงดอกเบี้ย 14400.00 ตามงวดที่ ledger บันทึก (ไม่วางกองที่งวดแรก) | periods[0..1].interestDue | ผ่าน |
| E2E-1727 | interest | LN-000023: งวด 2 = 13372.80 วางถูกงวด และผลรวม = interestCharged | periods interestDue sum | ผ่าน |
| E2E-1728 | interest | sum(interestDue) = totals.interestCharged = เส้น ledger ทุกกู้ (DECLINING ไม่ทำให้ค่างวดรวมเกิน/ขาด) | schedule totals vs ledger charges (A, B, C) | ผ่าน |
| E2E-1729 | interest | LN-000024 (FLAT control): schedule ยังแบ่งดอกเบี้ยเท่ากันทุกงวด + interestSuggested = 0 | schedule of the FLAT loan | ผ่าน |
| E2E-1730 | interest | interestSuggested = 0 เมื่อ asOf ยังไม่ถึงต้นงวดถัดไป (ไม่เสนอย้อนหลัง/ไม่เสนอเกิน) | schedule?asOf=2026-02-16 totals.interestSuggested (งวด 3 เริ่ม 2026-03-15) | ผ่าน |
| E2E-1731 | interest | พอ asOf เข้างวด 3 interestSuggested ขึ้นเป็นยอดงวด 3 ทันที เท่ากับที่ due list คำนวณ | schedule?asOf=2026-03-16 totals.interestSuggested | ผ่าน |
| E2E-1732 | interest | accrue โดย CHECKer (เป็นผู้สร้างรายการเอง): 201 | token=checker2 | ผ่าน |
| E2E-1733 | interest | ไม่ส่ง reason: ระบบเขียนข้อความอธิบายฐานคำนวณเอง (งวด/term, เงินต้นคงเหลือ, อัตรา) | POST /interest/accrue โดยไม่ระบุ reason | ผ่าน |
| E2E-1734 | interest | bulk-decision กัน maker อนุมัติงานตัวเอง + step ที่ไม่มีอยู่: ไม่ล่มทั้งคลัง, declined รายข้อพร้อมเหตุผล | approver = checker2 (maker ของเอง), [step, bogus uuid] | ผ่าน |
| E2E-1735 | interest | ข้อที่ declined ใน bulk ต้องไม่เปลี่ยนสถานะ transaction (ยัง PENDING_APPROVAL) | financial_transactions หลัง bulk ที่ถูกปฏิเสธ | ผ่าน |
| E2E-1736 | interest | checker อื่น bulk อนุมัติรายการของ checker2 ได้ (separation นับที่ตัว maker ไม่ใช่ role) | approver = checker1 | ผ่าน |
| E2E-1737 | interest | โพสต์ดอกเบี้ยงวด 3 ได้ (ใช้ flow เดิมกับ transaction types อื่น): 200 | POST /transactions/:id/post | ผ่าน |
| E2E-1738 | interest | LN-000022: งวด 1-3 มีดอกเบี้ยตามงวดที่โพสต์, งวด 4..12 ยัง 0, ยอดคงค้าง = oracle | schedule?asOf=2026-03-16 | ผ่าน |
| E2E-1739 | interest | ปฏิเสธดอกเบี้ยงวด 4 (REJECT พร้อมเหตุผล): 200 | decision=REJECT | ผ่าน |
| E2E-1740 | interest | งวดที่ถูก REJECT เรียกเก็บใหม่ได้ (REJECTED ไม่บล็อก periodIndex เดิม) | accrue ซ้ำหลัง reject, asOf=2026-04-16 | ผ่าน |
| E2E-1741 | interest | ใน DB: งวด 4 มี 1 REJECTED + 1 PENDING และ 0 POSTED (ไม่กลายเป็นเงินค้างสองรอบ) | financial_transactions periodIndex = 4 ของ loan A | ผ่าน |
| E2E-1742 | interest | bulk REJECT ก็ทำงานได้ครบกฎ (ต้องใส่เหตุผล): decided 1, transaction REJECTED | bulk decision REJECT + reason | ผ่าน |
| E2E-1743 | interest | bulk REJECT โดยไม่มีเหตุผล: ข้อนั้นถูกปฏิเสทรายข้อพร้อมเหตุผล (กฎเดียวกับ single decision) | bulk decision REJECT without reason | ผ่าน |
| E2E-1744 | interest | คำขอ bulk ที่ fail ตั้งแต่ validation ต้องไม่แตะ workflow (งวด 5 ยัง PENDING_APPROVAL) | financial_transactions หลัง bulk REJECT ที่ไม่มีเหตุผล | ผ่าน |
| E2E-1745 | interest | ล้างงวด 5 ด้วย bulk REJECT พร้อมเหตุผล: decided 1 | bulk decision REJECT + reason | ผ่าน |
| E2E-1746 | interest | LN-000025: จ่ายปิดครบ 101,200.00 -> CLOSED และยอดคงเหลือ 0 | payment of the full outstanding | ผ่าน |
| E2E-1747 | interest | กู้ CLOSED: due list คืนว่างทั้ง items/skipped และ accrue ไม่สร้างรายการ (ไม่มีหนี้ให้คิดดอก) | GET /interest/due + POST /interest/accrue loanIds=D | ผ่าน |
| E2E-1748 | interest | ไม่มี INTEREST_ACCRUAL ที่ POSTED บนกู้ที่ไม่ ACTIVE เลยทั้ง suite (posting engine ปิดทาง reopen) | join financial_transactions + loans | ผ่าน |
| E2E-1749 | interest | PATCH ผลิตภัณฑ์กลับเป็น FLAT: 200 | interestMethod=FLAT | ผ่าน |
| E2E-1750 | interest | เปลี่ยนผลิตภัณฑ์ย้อนหลังแล้ว: กู้เดิมยัง DECLINING และยังมีงวดค้างเรียกเก็บ (snapshot กันผลกระทบ) | loan A หลัง PATCH product -> FLAT | ผ่าน |
| E2E-1751 | interest | กู้ใหม่บนผลิตภัณฑ์ที่กลับมา FLAT: bill ก้อนเดียวตามพฤติกรรมเดิม + periodIndex NULL | POST /api/loans บน product ที่ PATCH เป็น FLAT | ผ่าน |
| E2E-1752 | interest | reconciliation MATCHED ทั้งสามกู้ และยอดคงค้าง = oracle ที่ replay เหตุการณ์เองทุกขั้น | POST /reconciliation/run?loanId=A,B,C | ผ่าน |
| E2E-1753 | interest | รวมดอกเบี้ยที่โพสต์ = รวมเส้น ledger ของงวดนั้นทุกกู้ (posting engine เขียนครบ ไม่ซ้ำ ไม่ขาด) | SUM(transactions.amount) vs SUM(lines.amount) per loan | ผ่าน |
| E2E-1754 | interest | เลขงวดของ accrual ทุกแถวอยู่ใน term (2..12) และไม่มีการ bill งวดเดียวกันซ้ำสองครั้งในระดับ POSTED/APPROVED | financial_transactions INTEREST_ACCRUAL ของ suite | ผ่าน |
| E2E-1755 | collection | ก่อนเริ่ม suite: ลูกค้าทดสอบทั้งห้าคนต้องไม่มี credit ค้าง (suite ก่อนหน้าล้างครบจริง) | customer_credits ของ C5-C9 | ผ่าน |
| E2E-1756 | collection | payable-now anonymous: 401 |  | ผ่าน |
| E2E-1757 | collection | payable-now ของ loan ที่ไม่มีอยู่: 404 | 00000000-7000-4000-8000-0000000000fe | ผ่าน |
| E2E-1758 | collection | payable-now asOf ไม่ถูกรูปแบบ: 400 | asOf=not-a-date | ผ่าน |
| E2E-1759 | collection | payable-now ด้วย token VIEWER: 200 (ทุก role ต้องเห็นเพดานก่อนตอบลูกค้า) |  | ผ่าน |
| E2E-1760 | collection | payload ของ payable-now มีครบทุก field ที่ UI ต้องใช้ | Object.keys(data) | ผ่าน |
| E2E-1761 | collection | กู้ที่ปล่อยเมื่อ 5 วันก่อน: ยังไม่มีงวดใดถึงกำหนด maxPayable 0 แต่หนี้ทั้งก้อนอยู่ใน ledger แล้ว | GET /payable-now (นาฬิกาจริง, ปล่อยกู้ 2026-10-10) | ผ่าน |
| E2E-1762 | collection | ก่อนงวดแรก 1 วัน (grace 0): เก็บอะไรไม่ได้เลย — เพดาน 0, duePeriods ว่าง, งวดยัง pending | GET /payable-now asOf=2026-10-04 (งวด 1 ครกำหนด 2026-10-05) | ผ่าน |
| E2E-1763 | collection | ในวันครบกำหนดงวด 1: duePeriods มีงวดเดียว, เพดาน = ยอดงวดนั้น (ยังไม่ครึ่งหนี้ทั้งก้อน) | GET /payable-now asOf=2026-10-05 | ผ่าน |
| E2E-1764 | collection | ผ่านไป 2 เดือน: เก็บได้แล้ว 3 งวด, dueToPay เป็นผลรวม collectable และ maxPayable = min(dueToPay, หนี้ใน ledger) | GET /payable-now asOf=2026-12-05 | ผ่าน |
| E2E-1765 | collection | ถึงวันครบสัญญา: ทุกงวดถึงกำหนดแล้ว maxPayable = หนี้ทั้งก้อนใน ledger และไม่มีงวดรอตัด | GET /payable-now asOf=2027-03-05 | ผ่าน |
| E2E-1766 | collection | วันครบกำหนดรายงวดเพิ่มเดือนละเดือนจากวันปล่อยกู้ (ปฏิทินจริง ไม่ใช่ 30 วัน x งวด) | duePeriods[].dueDate ที่ asOf=2027-03-05 (ปล่อยกู้ 2026-09-05) | ผ่าน |
| E2E-1767 | collection | ปิดหนี้เกิน 1 สตางค์: 422 (เพดานคือยอดที่ถึงกำหนด ไม่ใช่ยอดหนี้) | cashAmount 664800.01 บน LN-000022 ที่เก็บได้ทั้ง 664800.00 | ผ่าน |
| E2E-1768 | collection | 422 ตอบ details ให้ UI ยืนยันตัวเลข (maxPayable, requested, duePeriods, nextPendingPeriod) | POST /api/payment-requests เกินเพดาน | ผ่าน |
| E2E-1769 | collection | คำขอที่ถูก gate ปฏิเสธไม่ทิ้งแถวไว้ใน DB (transaction rollback ทั้งก้อน) | payment_requests + payment_allocations ของ FULL หลัง 422 | ผ่าน |
| E2E-1770 | collection | ปิดหนี้ LN-000022 ด้วยยอดพอดี: ยอดที่ตัดเรียง PENALTY -> PAST_INTEREST -> PAST_PRINCIPAL และ ledger line ปิดยอด | POST /api/transactions/05e4a64f-621d-43ee-891d-7f5c88e39e01/post (664800.00) | ผ่าน |
| E2E-1771 | collection | จ่ายพอดีทุกส่วนผ่าน gate ได้: loan เปลี่ยนเป็น CLOSED ยอดคงเหลือและส่วนเกินเป็น 0 | cash 664800.00 (ทั้งสัญญาถึงกำหนดแล้ว) | ผ่าน |
| E2E-1772 | collection | กู้กลางสัญญา: เพดานวันนี้ต่ำกว่าหนี้ทั้งก้อน (งวดในอนาคตยังเรียกเก็บไม่ได้) | GET /payable-now LN-000023 (today 2026-10-15) | ผ่าน |
| E2E-1773 | collection | ขอก้อนเต็มของกู้กลางสัญญา: 422 และข้อความชี้ช่อง deposit + auto-debit | cashAmount 664800.00 เพดาน 110800.00 | ผ่าน |
| E2E-1774 | collection | ข้อความ 422 ระบุยอดที่เก็บได้จริง ชื่อ loan และงวดถัดที่กำลังจะถึงกำหนด | body.error.message | ผ่าน |
| E2E-1775 | collection | จ่ายเท่า maxPayable ของ LN-000023: ยอดที่ตัดเรียง PENALTY -> PAST_INTEREST -> PAST_PRINCIPAL และ ledger line ปิดยอด | POST /api/transactions/747573a7-f0d5-44f2-86a5-06bbdcac3ecc/post (110800.00) | ผ่าน |
| E2E-1776 | collection | จ่ายเท่าเพดาน: loan ยัง ACTIVE, หนี้งวดอนาคตเหลืออยู่ และไม่มีส่วนเกินกลายเป็น credit | GET /api/loans/LN-000023 + customer_credits ของ C6 | ผ่าน |
| E2E-1777 | collection | จ่ายงวดแรกแล้วขอก้อนที่เหลือทันที: 422 อีกครั้ง (gate วัดใหม่ทุกครั้ง ไม่ใช่โควตาครั้งเดียว) | cashAmount 554000.00 หลังจ่าย 110800.00 | **ไม่ผ่าน** |
| E2E-1778 | collection | เพดานเหลือ 0 จริง: ข้อความและ details บอกตรงกันว่ายังไม่มีงวดถึงกำหนด และงวดหน้าคืองวดไหน วันใด | body.error.message + details | **ไม่ผ่าน** |
| E2E-1779 | collection | deposit พร้อม settlementAgreementId: 422 (เงินฝากเข้า credit ห้ามผูกข้อตกลง) | purpose DEPOSIT_TO_CREDIT + settlementAgreementId (UUID ปลอม) | ผ่าน |
| E2E-1780 | collection | deposit ที่ขอใช้ credit ไปด้วย: 422 (เป็นเงินรับเข้าฝ่ายเดียว) | cash 1000 + creditToApply 500 | ผ่าน |
| E2E-1781 | collection | deposit เงินสด 0: 400 ยอดต้องมากกว่า 0 | cashAmount 0 purpose DEPOSIT_TO_CREDIT | ผ่าน |
| E2E-1782 | collection | ฝากเข้า credit บนกู้ที่ยังไม่มีงวดใดถึงกำหนด (maxPayable 0): 201 — นี่คือเส้นทางที่ gate ชี้ | POST /api/payment-requests purpose DEPOSIT_TO_CREDIT (เพดานวันนี้ 0.00) | ผ่าน |
| E2E-1783 | collection | คำขอ deposit บันทึก purpose ไว้ และ proposed allocation เป็น 0 ทุกส่วน | POST response request.purpose + proposed | ผ่าน |
| E2E-1784 | collection | ผู้สร้างอนุมัติ deposit เอง: 422 (รับฝากเงินก็ห้ามคนละคนกันเหมือนกัน) | approve ด้วย token เดียวกับ creator | **ไม่ผ่าน** |
| E2E-1785 | collection | checker อนุมัติ deposit: 200 |  | ผ่าน |
| E2E-1786 | collection | transaction ของ deposit เป็นชนิด PAYMENT สถานะ APPROVED ยอดเท่าเงินสดที่รับ | approve response transaction | ผ่าน |
| E2E-1787 | collection | โพสต์ deposit: 200 |  | ผ่าน |
| E2E-1788 | collection | deposit ไม่ตัดหนี้: allocation 0 ทุกส่วน, excess = เงินทั้งก้อน, ยอดคงค้างเท่า oracle | POST /api/transactions/9d910380-fed8-4c16-a5ab-83f5ca41bbd6/post | ผ่าน |
| E2E-1789 | collection | deposit ไม่สร้าง ledger line (ไม่มีการตัดหนี้) แต่ credit งอกจริงพร้อม balanceAfter | financial_transaction_lines + customer_credits + credit_ledger ของ C9 | ผ่าน |
| E2E-1790 | collection | เส้นทาง deposit มี audit ครบทั้งอนุมัติรายการและ credit ที่งอก (ตรวจย้อนหลังได้) | audit_logs ของ loan FRESH | ผ่าน |
| E2E-1791 | collection | payable-now คืน creditBalance ของลูกค้า (UI ใช้บอกยอดที่ฝากไว้) และเพดานยัง 0 | GET /payable-now หลังฝาก 50,000 | ผ่าน |
| E2E-1792 | collection | deposit บน loan ที่ CLOSED แล้ว: 422 (ต้องมีสถานะ ACTIVE เท่านั้น) | FULL เปลี่ยนเป็น CLOSED แล้ว | ผ่าน |
| E2E-1793 | collection | GET /api/config/payment: VIEWER อ่าน policy ได้ 200 |  | ผ่าน |
| E2E-1794 | collection | policy การเก็บเงินมีสวิตช์ auto-debit + lead days และ env default ปิดสวิตช์ไว้ | GET /api/config/payment | ผ่าน |
| E2E-1795 | collection | POST /config/payment/auto-debit/run ด้วย role anon: 401 | token=anon | ผ่าน |
| E2E-1796 | collection | POST /config/payment/auto-debit/run ด้วย role viewer: 403 | token=viewer | ผ่าน |
| E2E-1797 | collection | POST /config/payment/auto-debit/run ด้วย role maker: 403 | token=maker | ผ่าน |
| E2E-1798 | collection | POST /config/payment/auto-debit/run ด้วย role checker: 403 | token=checker | ผ่าน |
| E2E-1799 | collection | POST /config/payment/auto-debit/run ด้วย role head: 403 | token=head | ผ่าน |
| E2E-1800 | collection | ฝาก 150,000 ให้ AD: credit ของลูกค้า C7 พร้อมใช้แล้ว และหนี้ยังไม่ถูกตัด | customer_credits.balance ของ C7 + GET /api/loans/AD | ผ่าน |
| E2E-1801 | collection | dryRun ของ auto-debit: 200 (รายงานอย่างเดียว ไม่แตะบัญชี) | POST /config/payment/auto-debit/run {loanId: AD, asOf: 2026-10-03, dryRun: true} | ผ่าน |
| E2E-1802 | collection | dryRun วางแผนงวดที่อยู่ใน window (lead days) โดยไม่สร้างคำขอ ไม่เขียน audit และไม่สร้างบัญชีเครื่อง | asOf = 2026-10-03 (งวด 1 ครกำหนด 2026-10-05, lead 3 วัน) | **ไม่ผ่าน** |
| E2E-1803 | collection | reason ของ planned บอกชื่อกู้/งวด/วันครบกำหนด/จำนวนวันล่วงหน้า (ตรวจได้โดยไม่ต้องเปิด DB) | planned[0].reason | ผ่าน |
| E2E-1804 | collection | dryRun บอก skip เหมือนรอบจริง: AD-SMALL ยังไม่มี credit เลย งวดจึงไม่ถูกวางแผน | POST run {loanId: AD-SMALL, asOf: 2026-10-03, dryRun: true} | ผ่าน |
| E2E-1805 | collection | รอบทั้งบัญชีขณะสวิตช์ OFF: คืนผลว่างและไม่แตะอะไรเลย (ระบบไม่เก็บเงินเองถ้าไม่มีใครสั่ง) | POST /config/payment/auto-debit/run {asOf} (ไม่มี loanId, สวิตช์ OFF) | **ไม่ผ่าน** |
| E2E-1806 | collection | ADMIN สั่งรอบเก็บเงินเฉพาะกู้ (loanId) แม้สวิตช์ OFF: 200 และ debit จริง 1 รายการ | POST /config/payment/auto-debit/run {loanId: AD, asOf: 2026-10-03} | ผ่าน |
| E2E-1807 | collection | debit ครั้งแรกตรงกับที่ dryRun วางไว้ (งวด 1, ยอดเดิม, loan เดิม, มี requestNo) | debited[0] | **ไม่ผ่าน** |
| E2E-1808 | collection | auto-debit เดินเส้นทางเดียวกับมนุษย์: request -> approve -> POSTED พร้อม periodIndex | financial_transactions (PAYMENT) ของ AD | ผ่าน |
| E2E-1809 | collection | บัญชีเครื่องของ job ถูกต้อง: inactive, role CHECKER, ไม่มี email | users WHERE username = 'system.auto-debit' | ผ่าน |
| E2E-1810 | collection | login ด้วยบัญชีเครื่อง: 401 (ไม่มีใครใช้บัญชีนี้เข้าระบบได้) | POST /api/auth/login system.auto-debit | ผ่าน |
| E2E-1811 | collection | auto-debit งวด 1 ของ LN-000024: ยอดที่ตัดเรียง PENALTY -> PAST_INTEREST -> PAST_PRINCIPAL และ ledger line ปิดยอด | POST /api/transactions/undefined/post (110800.00) | **ไม่ผ่าน** |
| E2E-1812 | collection | auto-debit ใช้ credit ไม่ใช่เงินสด: ACCRUED แล้ว USED ปิดยอด, balance = ผลต่างเป๊ะ | credit_ledger + customer_credits ของ C7 | ผ่าน |
| E2E-1813 | collection | รันซ้ำด้วย asOf เดิม: ไม่ debit ซ้ำ (งวดถูกตัดจาก ledger แล้ว จึงไม่มีอะไรค้างใน window) | POST /config/payment/auto-debit/run {loanId: AD} ครั้ง 2 | ผ่าน |
| E2E-1814 | collection | reverse auto-debit ที่ POSTED แล้ว: สร้างคำขอ reversal ได้ 201 | POST /api/transactions/reversals amount 110800.00 ของ undefined | **ไม่ผ่าน** |
| E2E-1815 | collection | โพสต์ reversal ของ auto-debit: 200 |  | **ไม่ผ่าน** |
| E2E-1816 | collection | reversal เปิดงวดกลับคืนมา exact: ledger line ตรงข้ามกับยอดที่ debit ไป และยอดคงเหลือเท่า oracle | financial_transaction_lines ของ reversal เทียบกับ allocation ของ debit | **ไม่ผ่าน** |
| E2E-1817 | collection | งวดกลับมา open อีกครั้งหลัง reversal: job ยังปฏิเสธ — periodIndex เดิมถูกจองไว้แล้ว (idempotent จริง) | POST /config/payment/auto-debit/run {loanId: AD} ครั้ง 3 (หลัง reversal) | ผ่าน |
| E2E-1818 | collection | เงินไม่หายเมื่อกลับรายการ: หนี้ที่เปิดกลับ + credit ที่เหลือ = เงินที่ฝากไว้ 150,000 | ยอดที่เปิดกลับ + customer_credits ของ C7 | **ไม่ผ่าน** |
| E2E-1819 | collection | asOf ก่อน window ของ lead days: ยังไม่ถึงเวลาของงวดใด -> skip ว่าไม่มีงวดใน window | asOf = 2026-10-01 (งวด 1 ครกำหนด 2026-10-05, lead 3 วัน) | ผ่าน |
| E2E-1820 | collection | credit ไม่พองวด: ไม่เก็บแบบเศษงวด (รอเก็บทั้งงวด) พร้อมเหตุผลบอกตัวเลขทั้งสองฟาก | POST run {loanId: AD-SMALL, asOf: 2026-10-03} credit 1000.00 | ผ่าน |
| E2E-1821 | collection | กู้ที่ปล่อย 5 วันก่อน (asOf ตามนาฬิกาจริง): ยังไม่มีงวดใน window -> skip และ credit 50,000 ยังอยู่ครบ | POST run {loanId: FRESH} (ไม่ส่ง asOf) | ผ่าน |
| E2E-1822 | collection | ทุกรอบที่ไม่ใช่ dryRun เขียน audit AUTO_DEBIT_RUN (ใครสั่ง สแกนกี่ฉบับ สวิตช์สถานะไหน ผลเท่าไร) | audit_logs WHERE action = AUTO_DEBIT_RUN ของรอบนี้ | **ไม่ผ่าน** |
| E2E-1823 | collection | PUT /config/payment autoDebitLeadDays ติดลบ: 400 (validation ก่อนเขียน) | autoDebitLeadDays=-1 | ผ่าน |
| E2E-1824 | collection | PUT /config/payment autoDebitLeadDays เกิน 90 วัน: 400 | autoDebitLeadDays=91 | ผ่าน |
| E2E-1825 | collection | PUT ที่ถูกปฏิเสธไม่เขียน audit CONFIG_UPDATED (ไม่มีแถวกำพร้าจากรายการที่ล้มเหลว) | audit_logs CONFIG_UPDATED ของ payment policy หลัง 2 คำขอที่ 400 | ผ่าน |
| E2E-1826 | collection | ADMIN แก้ lead days ผ่าน API: 200 (สวิตช์ยังปิด จึงไม่มีรอบไหนเดินเอง) | autoDebitEnabled=false, autoDebitLeadDays=7 | ผ่าน |
| E2E-1827 | collection | policy ที่อ่านกลับมาจาก system_config ทับ env default ตามที่ PUT | GET /api/config/payment หลัง PUT leadDays=7 | ผ่าน |
| E2E-1828 | collection | job อ่าน policy ทุกครั้งที่รัน (ไม่ต้อง restart): dryRun รายงาน leadDays ตัวใหม่ทันที | POST run dryRun หลัง PUT leadDays=7 | ผ่าน |
| E2E-1829 | collection | การเปลี่ยน policy ถูก audit แบบ previous -> updated ให้ตอบผู้ตรวจสอบได้ | audit_logs CONFIG_UPDATED ของ payment policy ที่เกิดจาก suite นี้ | ผ่าน |
| E2E-1830 | collection | สรุปเส้นทางเงินของ LN-000024: ฝาก 150,000 -> debit 110800.00 -> reversal เปิดหนี้กลับ -> credit เหลือเท่าผลต่างเป๊ะ | GET /api/loans/AD + customer_credits ของ C7 | **ไม่ผ่าน** |
| E2E-1831 | collection | หลัง purge: แถวทุกตารางที่ suite นี้แตะกลับเท่าก่อนเริ่ม (loan/request/ledger/credit/audit) | row counts before vs after | ผ่าน |
| E2E-1832 | collection | policy การเก็บเงินถูกคืนค่าเดิม (สวิตช์ปิดตาม default, lead days เท่าเดิม) | GET /api/config/payment หลัง restore | ผ่าน |
| E2E-1833 | collection | ไม่มี credit หรือ loan ค้างของลูกค้าทดสอบ และบัญชีเครื่องเหลือไว้แถวเดียว (เป็นตัวตนถาวรของ job) | customer_credits + loans ของ C5-C9, users system.auto-debit | **ไม่ผ่าน** |
