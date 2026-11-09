# User Manual — Loan Management System

A manual for staff of every role level, covering every function of the system.
References the current code behaviour (`server/` + `web/`). Edition dated 2026-10-17.

> **About screen languages**: The UI exists only in **English** and **Lao**; there is no Thai interface.
> This manual therefore quotes **menu names / button labels / error messages exactly as the English UI shows them**.
> If you work with the Lao UI, compare menu names against the table in chapter 3. A Thai edition of this manual exists as `USER-MANUAL-TH.md`, chapter for chapter — switch between the two with the selector at the top right of this page.

---

## Contents

0. [1. System Overview and Prerequisites](#1-system-overview-and-prerequisites)
1. [2. User Roles](#2-user-roles)
2. [3. All Menus and Access Rights](#3-all-menus-and-access-rights)
3. [4. Core System Concepts to Understand Before Use](#4-core-system-concepts-to-understand-before-use)
4. [5. Sign In, User Accounts and Passwords](#5-sign-in-user-accounts-and-passwords)
5. [6. My profile — Looking After Your Own Account](#6-my-profile--looking-after-your-own-account)
6. [7. Dashboard — The Work Summary Page](#7-dashboard--the-work-summary-page)
7. [8. Customers — The Customer Register](#8-customers--the-customer-register)
8. [9. KYC — The Customer Identity Evidence File](#9-kyc--the-customer-identity-evidence-file)
9. [9A. Bank accounts & payment evidence](#9a-bank-accounts--payment-evidence)
10. [10. Loan Products](#10-loan-products)
11. [11. Loans — Disbursement](#11-loans--disbursement)
12. [12. Loan Detail — Tracking One Contract](#12-loan-detail--tracking-one-contract)
13. [13. Payment Requests](#13-payment-requests)
14. [14. Transactions — Financial Documents and Post Work](#14-transactions--financial-documents-and-post-work)
15. [15. Penalty / Waiver / Write-off / Adjustment / Reversal](#15-penalty--waiver--write-off--adjustment--reversal)
16. [16. Interest: FLAT vs DECLINING and Accruing Interest Receivable](#16-interest-flat-vs-declining-and-accruing-interest-receivable)
17. [17. Approvals — The Pending-Approval Queue](#17-approvals--the-pending-approval-queue)
18. [18. Settlements — Agreements to Settle and Close](#18-settlements--agreements-to-settle-and-close)
19. [18A. Debt restructuring when the borrower cannot pay (Hardship restructure)](#18a-debt-restructuring-when-the-borrower-cannot-pay-hardship-restructure)
20. [19. Customer Credit — the customer's credit balance](#19-customer-credit--the-customers-credit-balance)
21. [20. Reconciliation — balance matching](#20-reconciliation--balance-matching)
22. [21. Monthly Reports — monthly reports](#21-monthly-reports--monthly-reports)
23. [22. Audit Trail — The Inspection Trail](#22-audit-trail--the-inspection-trail)
24. [23. Users — Manage Staff Accounts (Admin)](#23-users--manage-staff-accounts-admin)
25. [24. Admin — System Configuration Centre (Admin)](#24-admin--system-configuration-centre-admin)
26. [25. Notifications and Email](#25-notifications-and-email)
27. [26. Role-by-Role Guide: Day-to-Day Work](#26-role-by-role-guide-day-to-day-work)
28. [27. End-of-Day / End-of-Month Checklist](#27-end-of-day--end-of-month-checklist)
29. [28. Common Error → Cause → Fix Table](#28-common-error--cause--fix-table)
30. [29. Do-Not / Do Practices](#29-do-not--do-practices)
31. [30. Appendix A: All Statuses and Enum Values](#30-appendix-a-all-statuses-and-enum-values)
32. [31. Appendix B: API List and Permissions (for the IT team)](#31-appendix-b-api-list-and-permissions-for-the-it-team)

---

## 1. System Overview and Prerequisites

This system manages the **entire loan lifecycle**: customer registration → identity verification (KYC) → products → loan disbursement → repayment/interest schedules → payment receipt → penalties/relief/write-offs → reconciliation → reports → an audit trail of every step.

Design principles every user must know (these are system rules and cannot be changed from the screen):

- **Maker–Checker** — the person who creates a document with a financial effect (the maker) cannot approve it themselves; another person must approve it.
- **Approval is not posting** — approval only moves a document to `APPROVED`. A separate **Post** command is required before any money actually moves.
- **Every money figure comes from the running ledger** — instalment schedules and outstanding balances are not stored independently; they are computed from entries that are `POSTED`. Never change figures by any means other than documents in the system.
- **Every action is recorded in the Audit Trail** with the actor, the time, the IP, and the before/after amounts.
- The main currency is **LAK** with 2 decimal places; there is no unit smaller than a kip (the system rounds at 2 decimal places, with a tolerance of 0.005).

### What You Need Before You Start

| Item | Details |
|---|---|
| System URL | Dev/test: `http://localhost:5173` (API on port `4000`) — production: as provided by the IT department |
| User account | Issued only by an Admin through the `Users` menu; you receive a username / initial password / role |
| Email on the account | Required to use "Forgot password" (the system sends a 6-digit OTP to your email) and to receive payment-result notification emails |
| Browser | A recent version of Chrome / Edge / Firefox; recommended screen width at least 1280px |

> **Test accounts** (`test_admin`, `test_head`, `test_checker1`, `test_op1`, `test_view1`), which the shortcut buttons on the `Login` page fill in for you, belong to the **mock dataset for testing only**. Never use them in a real environment, and delete them before go-live (see chapter 29).

---

## 2. User Roles

The system has 5 roles (actual values in the system: `ADMIN`, `HEAD_APPROVER`, `CHECKER`, `MAKER`, `VIEWER`).

| Role | Name used in this document | What it can do, in brief |
|---|---|---|
| `ADMIN` | Administrator | Everything + manage staff accounts + change system-wide settings (thresholds, KYC, passwords, profile photos, email templates) + `Reopen review` on KYC jobs |
| `HEAD_APPROVER` | Head approver | Head-level approval, view reports, reconciliation, and all operator work |
| `CHECKER` | Checker | Checker-level approval, reconciliation, all operator work (**cannot view reports** — reports are restricted to Admin/Head) |
| `MAKER` | Maker | Create customers / record payments / financial documents / disburse loans / upload KYC documents — **cannot approve their own work** |
| `VIEWER` | Viewer | View only: Dashboard, Customers, Products, Loans, Transactions, Credits, Audit — no create/approve buttons |

The permission groups the system actually uses (referenced in later chapters):

- **OPERATOR_ROLES** = `MAKER` + `CHECKER` + `HEAD_APPROVER` + `ADMIN` → all operational work (create documents, upload, Post)
- **canCreate** = `MAKER` + `ADMIN` → the `New Customer`, `New Payment Request`, `New Agreement` buttons
- **canApprove** = `CHECKER` + `HEAD_APPROVER` + `ADMIN` → the `Approvals` queue, the `Review` / `Reject` buttons
- **canSeeReports** = `ADMIN` + `HEAD_APPROVER` → the `Monthly Reports` menu
- **The "close / release" group** (`CLOSE_ROLES` / `RELEASE_ROLES`) = `HEAD_APPROVER` + `ADMIN` → close a customer's bank account, release a guarantor / alternate payer, release collateral (MAKER/CHECKER cannot press these)
- **Approval decider tiers**: the CHECKER tier is decided by `CHECKER`/`ADMIN`; the HEAD tier by `HEAD_APPROVER`/`ADMIN`; the ADMIN tier by `ADMIN` only

---

## 3. All Menus and Access Rights

The left menu bar is divided into 4 groups: **LENDING / CASH FLOW / OVERSIGHT / ADMINISTRATION**

| Menu on screen | Address (route) | MAKER | CHECKER | HEAD | ADMIN | VIEWER | What it is used for |
|---|---|:--:|:--:|:--:|:--:|:--:|---|
| `Dashboard` | `/` | Yes | Yes | Yes | Yes | Yes | View summary totals and pending work |
| `Customers` | `/customers` | Yes (can create) | Yes | Yes | Yes | Yes (view) | Customer registry |
| `Loan Products` | `/products` | Yes (view) | Yes (view) | Yes (view) | Yes (create/edit pricing) | Yes (view) | Define product terms |
| `Loans` | `/loans` | Yes (disburse) | Yes | Yes | Yes | Yes (view) | Disburse loans and view balances |
| `Hardship Addendums` | `/restructures` | Yes | Yes | Yes | Yes | No (menu hidden) | The whole debt-restructuring queue (chapter 18A) |
| `Payment Requests` | `/payment-requests` | Yes | Yes | Yes | Yes | No (menu hidden) | Receive debt payments |
| `Transactions` | `/transactions` | Yes | Yes | Yes | Yes | Yes (view) | Penalties / relief / write-offs / balance adjustments / Post |
| `Settlements` | `/settlements` | Yes | Yes | Yes | Yes | No | Settlement agreements |
| `Customer Credit` | `/credits` | Yes | Yes | Yes | Yes | Yes | Credit balances and history |
| `Approvals` | `/approvals` | No (menu hidden) | Yes | Yes | Yes | No | Approval queue + interest setting |
| `Reconciliation` | `/reconciliation` | No | Yes | Yes | Yes | No | Reconciliation |
| `Monthly Reports` | `/reports` | No | No | Yes | Yes | No | Monthly performance reports |
| `Audit Trail` | `/audit` | Yes | Yes | Yes | Yes | Yes | Search the work history and export CSV |
| `Users` | `/users` | No | No | No | Yes | No | Enable / disable / delete / restore staff accounts |
| `Admin` | `/admin` | No | No | No | Yes | No | System-wide settings |
| `My profile` (top-right corner) | `/profile` | Yes | Yes | Yes | Yes | Yes | Personal info, password, profile photo |

General usage tips:

- **Quick search**: press `Ctrl+K` (macOS `Cmd+K`) and type at least 2 characters; the system suggests both customers and loan agreements (5 items each). Press Enter to open a result.
- **Collapse/expand the menu bar**: use the three-line menu button or press `[`. The state is remembered on your machine.
- **Change language**: the `Select` control in the top-right corner (English / Lao). **Dark mode**: the moon/sun icon — both are saved on your machine.
- **Every time you press save**, a "Processing…" screen appears to prevent double clicks. Do not close the window while it is running.
- **Every table on every page** has a pager (Rows per page 10/12/25/50) and, where that page offers one, a search/filter box.
- **Export CSV**: the system generates the file on the user's machine with a BOM (UTF-8), so Excel opens it without garbled characters.
- Hiding a menu is only for convenience; **the actual pages are enforced by server-side permissions** — calling a URL directly without the right permission returns 403.

---

## 4. Core System Concepts to Understand Before Use

### 4.1 Loan Status

| Status | Meaning | Who can change it |
|---|---|---|
| `ACTIVE` | The contract is in effect. It has an outstanding balance, can receive payments, can accrue interest and can charge penalties. | The system sets it at disbursement, and automatically reopens it when an adjustment brings the outstanding balance back above 0 |
| `CLOSED` | Total outstanding = 0 (normal account closure) | **The system computes it at Post** — there is no button to set the status |
| `WRITTEN_OFF` | Bad debt written off | The system sets it when a Write-off document is Posted for the full outstanding balance |

> The system follows "the truth of the running ledger". The contract status is rewritten only on each Post. Users cannot change it directly.

### 4.2 Financial Document (Transaction) Status

`DRAFT` → `PENDING_APPROVAL` → `APPROVED` → `POSTED` · the branch off is `REJECTED`

- Every menu that creates a financial document (Penalty, Waiver, Write-off, Adjustment, Reversal, Accrue and approved payment requests) saves the status as **`PENDING_APPROVAL` and automatically creates the approval workflow**
- **`APPROVED`** — approved through all levels, but it has no financial effect yet
- **`POSTED`** — the ledger has moved. Outstanding balances, reports and customer emails change from this point
- **`REJECTED`** — sent back (a reason must be given) and the whole workflow dies. You must create a new document; you cannot edit the old one to make it usable again

### 4.3 Approval Thresholds

The document amount decides how many approval levels are required (see the default values under `Admin` → Global thresholds)

| Document amount | Approval levels required |
|---|---|
| ≤ `checkerThreshold` (default 1,000,000 LAK) | CHECKER |
| ≤ `headThreshold` (default 10,000,000 LAK) | CHECKER → HEAD_APPROVER |
| More than `headThreshold` | CHECKER → HEAD_APPROVER → ADMIN |

- For `ADJUSTMENT` documents the system considers the sum of the absolute values of all components as the amount, so that approval levels cannot be dodged
- The next level only opens after the previous level has passed. If you try to skip a level the system shows `"This step is not the current level; waiting for ..."`

### 4.4 Allocation Order

When a payment is received, the system allocates it **penalty → accrued interest → outstanding principal**, in that order. One component must be fully closed before the next begins.

- If the payment exceeds the outstanding balance of the whole contract, the surplus becomes **Customer Credit** (it is not treated as a duplicate payment)
- The customer's remaining credit can be used together with the next payment received

### 4.5 The Installment Schedule Is Not Stored

The repayment schedule is **computed on read** from the documents already POSTED (number of installments = number of months in the contract, principal split equally across installments, the last installment absorbs the rounding remainder)

- Money the "customer actually paid" and money "relieved (waiver/write-off)" are always counted separately — relief is not treated as money paid by the customer
- Early repayment **does not accrue daily interest** (no daily proration); it reduces the base of the next installment instead

---

## 5. Sign In, User Accounts and Passwords

### 5.1 Signing In

1. Open the system URL → it goes to `/login` automatically if you are not signed in
2. Enter `Username` and `Password` → press the **`Sign In`** button (while waiting the button shows `Signing in…`)
3. On success you enter the `Dashboard` · if the session expires while you work, the system bounces back to `/login` and **after signing in again it returns to the page you were on**

Messages you may see:

- Wrong account/password → an error Alert on the form (the system does not say which side was wrong)
- Account turned off → `Account is disabled`
- Session revoked → `Session is no longer valid, please sign in again`

### 5.2 Forgot Password

1. Press **`Forgot password?`** on the login page
2. Step 1: enter **the email of the account** → the system sends a 6-digit OTP (there is a delay per email to prevent repeated pressing)
3. Step 2: enter **the 6-digit OTP** (the system strips any non-digit characters automatically)
4. On success the system sends a one-time password reset link → it opens the `Reset password` page
5. Set a new password (the password rule hints are shown live on screen) → press confirm → sign in again

Things to know:

- **After a password change or reset, every existing session of that account is revoked immediately** (the system compares timestamps at millisecond level; you must sign in again on every device)
- The OTP may be tried only a limited number of times. Once reached it dies (`DEAD`). Request a new round, or ask an Admin to send a reset link from the `Users` menu
- OTPs and links are **encrypted at rest**. Nobody sees them as plain text in the database or in log files

### 5.3 Admin Sends a Password Reset Link to Staff

Menu `Users` → the **Send reset link** icon (one person) or select several rows and press **`Send reset links (n)`** (as a batch) — the system sends a link to that account's email. The employee does not need an OTP.

### 5.4 Password Rules (configured under `Admin` → Password policy)

Defaults: 6–16 characters long, must contain a digit, an uppercase letter and a lowercase letter (a symbol is not required). The system warns on screen as soon as what you type breaks the rule.

---

## 6. My profile — Looking After Your Own Account

Open it from the top-right corner (account name) → `My profile` · every role can only reach their own data

| Section | Fields/buttons | Notes |
|---|---|---|
| Account details | Shows username, role, account status | Read only |
| Personal information | `Upload` / `Remove photo` (avatar), `Full name`*, `Email`, `Save` button | After changing the email there is a hint that it must be confirmed again (the email is used to receive OTPs and system emails) |
| Change password | `Current password`*, `New password`* (rule hints shown live), `Confirm new password`* | If the confirmation does not match, the system blocks it before sending · after saving, the system **forces sign out** so you Sign in again |

Avatar file rules: it must really be JPEG/PNG/WEBP (not just a changed extension), no larger than the limit set under `Admin` → Avatar policy, and only your own picture can be managed (or an Admin does it for you)

---

## 7. Dashboard — The Work Summary Page

Every role sees the same thing. It is a read-only page, used to start the working day.

- 7 number cards: `Customers`, `Loans` (labelled "N posted transactions"), `Total Outstanding`, `Customer Credit`, `Pending Payment Requests`, `Pending Approvals`, `Active Outstanding`
- **Loans by Status** — a proportion bar for ACTIVE / CLOSED / WRITTEN_OFF
- **Recent Transactions** — the 8 latest entries; each row has a `view` link to the `Transactions` page
- The `Pending Approvals` value tells you there is work waiting in the `Approvals` queue — anyone with approval rights should clear it first

---

## 8. Customers — The Customer Register

Menu `Customers` (`/customers`)

### 8.1 Search and Browse Records

- The `Search name / number / phone` box (type and wait a moment; the system searches automatically)
- Table: `Number` (link), `Full Name`, `Phone`, `National ID`, `Products Borrowed` (see below), `Loans` (number of contracts), `Credit Balance`, and a `KYC` column (status badge + `Open KYC file` button)
- There is a pager at the bottom of the table

**The `Products Borrowed` column** — shows what products this customer is borrowing under, or what products they have borrowed before. It is one "product name button" (chip) per product:

- A multiplier `product name ×n` appears when that product group has more than 1 contract
- Button style: a solid button (primary colour) = there is still an `ACTIVE` contract with that product · an outline button (pale colour) = borrowed before but all closed
- Point the mouse at the button → you see "how many contracts still outstanding / how many in total / the combined outstanding balance"
- **Click the button** → it opens that customer's `Loan history` dialog. The table shows `Loan #` (a link into the contract page), `Product`, `Status`, `Principal`, `Outstanding`, `Disbursed` — so you can read each contract's details right away without searching from the `Loans` page
- A customer who has never borrowed shows `—`

### 8.2 Creating a New Customer (MAKER and ADMIN only)

Press **`New Customer`** → fill in:

| Field | Required | Notes |
|---|---|---|
| `Full Name`* | ✅ | First name and surname exactly as on the identity document |
| `Phone` | — | Contact number |
| `National ID` | — | ID card number — you should fill it in, because it is used for search and for matching KYC evidence |
| `Email` | — | Must be in a valid email format |
| `Address` | — | Residential address |

Press **`Create`** → the system issues the `customerNumber` automatically. The KYC status starts at `NOT_VERIFIED`.

**Important**: after creating a customer you still **cannot disburse a loan** until KYC reaches the `VERIFIED` status (when the policy gate is closed, and the default is closed). See chapter 9.

On the same customer file page, below the KYC documents, there are **Bank accounts** and **Bank account proofs** cards for recording the account the customer receives money in and attaching the supporting proof — these are a separate matter from KYC and are not a disbursement gate (see chapter 9A).

---

## 9. KYC — The Customer Identity Evidence File

Open it from `Customers` → `Open KYC file` (`/customers/:id`) · designed as "a document file + a checklist + approval work".

### 9.1 Page Structure

- **Evidence documents** — a table of the documents already uploaded, with `View` (opens the image in a dialog), `Delete`, file size, and issue/expiry dates
- **Required evidence** — a checklist of what is complete or missing, notices for expired documents (error) and documents nearing expiry (warning), and the disbursement gate status message (gateBlocked / gateOpen / gateDisabled)
- **Storage** — shows "x of y KB" according to the per-customer quota
- **Upload card** — appears only for the operator group (MAKER/CHECKER/HEAD/ADMIN)
- **Action button bar** — `Submit for verification`, `Verify identity`, `Reject`, `Reopen review` (shown according to status and role)

### 9.2 Document Types the System Knows

`NATIONAL_ID` (national ID card), `ID_CARD`, `PASSPORT`, `FAMILY_BOOK` (family book / house registration), `SELFIE_WITH_ID` (selfie holding the card), `SIGNATURE` (signature)
· the optional category for each card image side: `MAIN` / `FRONT` / `BACK`

### 9.3 Uploading a Document (every operator role except VIEWER)

1. Choose a **Document type** that is enabled in the policy (some types can be disabled under `Admin` → KYC policy)
2. Choose the files — the system checks that they **must really be JPEG/PNG/WEBP images** (PDF is rejected with 415), each file no larger than `maxFileSizeKb`, no more than `maxFilesPerRequest` files per request, no duplicates of files already present (compared by SHA-256 → 409), and the `maxTotalBytesPerCustomer` quota must not be exceeded
3. Enter `issuedAt` (it must not be in the future) and `expiresAt` (it must be after the issue date) for documents that have an expiry date
4. Press confirm → the files are stored in the database (not in a folder on the machine) and an audit entry is recorded

Caution: **if the `reverifyOnDocumentChange` policy is open, adding or deleting a document after status `VERIFIED` pulls the customer straight back to `PENDING`**. Another reviewer must approve it again.

### 9.4 Submit → Verify / Reject / Reopen

| Step | Who can do it | Conditions |
|---|---|---|
| `Submit for verification` | operator (the maker) | Status must be `NOT_VERIFIED` or `REJECTED` · the checklist must be complete |
| `Verify identity` | `CHECKER` / `HEAD_APPROVER` / `ADMIN` | Status `PENDING` · **must not be the person who submitted it or the person who uploaded the documents in that file** (the button is disabled with a tooltip) · the note is not required |
| `Reject` | as above | **the rejection reason must be given**; if left blank the button cannot be pressed |
| `Reopen review` | `ADMIN` only | From `VERIFIED` → `PENDING`; a reason must be given |

What the system checks in the checklist (according to the default values): at least one identity document type from the `requiredIdentityTypes` set · if selfie / signature / family book are required, all of them must be present · expired documents are accepted only when the `acceptExpiredDocuments` policy is open.

### 9.5 The Pre-Disbursement Gate (Disbursement gate)

While the `kyc.blockDisbursementUntilVerified` policy is open (the default), the system **refuses every disbursement whenever the customer is not `VERIFIED`**, with a message that KYC has not passed. The correct fix is to make KYC pass, not to close the policy (closing the policy is an Admin power and is recorded in the audit).

---

## 9A. Bank accounts & payment evidence

This chapter is the layer that answers "which account does the money arrive in, and which file proves it". It is **a completely separate layer from KYC**.

- Registering an account or attaching account evidence **never changes the KYC status**. A customer who is already `VERIFIED` does not go back into the review queue because a new evidence file was uploaded.
- A transfer slip or a cash receipt is **not the gate that releases the loan**. The loan and the disbursement ledger entries are already recorded when the contract is created (section 11). The evidence tab only keeps "a copy" next to that record afterwards, so it needs no approval and does not move any balance.
- Every screen, every email and every audit entry sees only the **last 4 digits** of the account number.

Reachable from 2 places:

| Place | Route | What it is used for |
|---|---|---|
| Customer file | `Customers` → `Open KYC file` (`/customers/:id`) → the **Bank accounts** and **Bank account proofs** cards | Register an account, close an account, change the primary account, attach evidence that confirms an account |
| Loan contract | `Loans` → open the contract (`/loans/:id`) → **Disbursement & evidence** tab | Record the channel the money was received through (BANK/CASH) + transfer reference, upload slips/receipts |

### 9A.1 Account number: stored in full, masked almost the whole length on screen

The system **stores the full account number** in the database, because it must be matched against bank statements afterwards. But on every route by which that number leaves the server it is masked as `************3456` (one asterisk for each digit that is not one of the last 4) — the REST response, the loan list, email bodies, notification payloads, audit reasons and document binaries. No screen ever prints the full number back so that it can be copied.

> **Type account numbers with no spaces, every time.** The system's "duplicate account" check only collapses several consecutive spaces into one; it **does not delete the spaces**. So `5 5 0 0 …` and `550…` are read as different numbers and the account can be registered twice (an observation that has already been reported, not yet fixed). The only protection available today is data-entry discipline: copy the number from the passbook copy without leaving any spaces.

### 9A.2 Registering / closing / setting the primary account

| Task | Who can press it | Button/field | Rules the system enforces |
|---|---|---|---|
| Register a new account | every operator role except VIEWER (`MAKER`/`CHECKER`/`HEAD_APPROVER`/`ADMIN`) | **`Register account`** → `Bank`*, `Account number`*, `Account holder`*, `Branch`, the `Set as primary` switch, `Note` | account name 2-128 characters; account number **4-64 characters**; account holder 2-191; a duplicate of an existing one → 409 `This account is already registered for <customer account name>` |
| Close an account | **`HEAD_APPROVER` / `ADMIN` only** | **`Close`** → `Reason for closing`* | **the reason may not be left blank** (if it is blank the button cannot be pressed; 400 `Closing an account needs a reason on record`). Only an `ACTIVE` account can be closed, otherwise 422 `Bank account is CLOSED — only an ACTIVE one can be closed`. Contracts that were paid into this account **still point at the same row**, because that row is the proof of where the money went on that day. |
| Change the primary account | operator | **`Set as primary`** (shown only for an `ACTIVE` account that is not already the primary) | One command removes the old flag and sets the new one. A closed account cannot be the primary: 422 `Bank account is CLOSED — a closed one cannot be the primary` |

- The `{{count}} proof(s)` label at the end of a row gives the number of documents that confirm that account — **0 means there is no evidence yet**, so a reviewer should see first that this account is still an unsupported claim.
- `Account` in the table is shown as a masked number. The `Status` column shows `ACTIVE`/`CLOSED`, and once an account is closed the closing date and the reason are shown as small text under the badge.
- The loan form screen (section 11) and the `Disbursement & evidence` screen can only choose from that customer's `ACTIVE` accounts.

### 9A.3 Bank account proofs

The **Bank account proofs** card sits under the accounts card. It holds the image of a passbook page or a bank letter that confirms this account number really belongs to the customer.

1. The account must be **registered first**. If there is no active account, the card shows `Register an active account first — a proof has to name the account it documents.` and hides the upload form.
2. Choose **`Bank account`** (required) + **`Choose image`** + `Note`, then press **`Upload account proof`**.
3. The system checks in this order: it must be a **real image** (detected from the magic bytes, not the file name) → 415 `Only image uploads are accepted for evidence documents`; the image type must be allowed by the policy → 415 `Image type image/png is not allowed (allowed: image/jpeg, image/png, image/webp)`; the size per file → 413/422 `File is too large (…) Current limit is … KB per evidence image.`; **the file may not be a duplicate of one already stored** (compared by SHA-256) → 409 `This exact image is already filed here as BANK_ACCOUNT_PROOF — delete it first to re-upload`; the quota is exceeded → 422 `Evidence storage quota reached for this customer (…) Delete an old document first.`
4. Evidence is **immutable** — fixing a wrong file always means **delete it and upload it again**. The `Delete` button appears only for the person who uploaded it or for `ADMIN`; anyone else gets 403 `Only the uploader or an ADMIN can delete an evidence document`.
5. `View` opens the image in a dialog. This image is a BLOB that must be fetched with a token, so there is a `Loading image…` state, and if the load fails the dialog shows `The image could not be loaded`.

> **The kind of evidence is always tied to its owner.** Uploading `DISBURSEMENT_SLIP` under a customer, or `BANK_ACCOUNT_PROOF` under a loan, is rejected with 422, for example `BANK_ACCOUNT_PROOF is filed under a CUSTOMER, not under a LOAN`. The owner of a document is taken from the **URL** only, never from data attached to the form.

### 9A.4 Contract receipt channel + slips/receipts (Disbursement & evidence tab)

On `LoanDetailPage`, the **Disbursement & evidence** tab shows 3 parts: `Recorded channel` (the current status), the form for recording the channel, and the **Disbursement slips** table.

| Channel | Must an account be chosen? | Note shown on screen |
|---|---|---|
| `BANK TRANSFER` | **required** — the `Save channel` button is disabled together with the warning `Choose the account the money was sent to.` | `Money is transferred to a registered account, so the number on the slip is the number on file — never one typed into a note.` |
| `CASH` | Do not choose one (if one is still selected, the system asks you to clear it) | `Cash needs no account. File the signed receipt afterwards so the paper proof sits next to the ledger entry.` |

- The `Transfer reference` field is at most 64 characters (the bank's transfer number or the cash receipt number).
- **`Save channel`** does nothing when the value has not changed from the one already recorded (`unchanged`), and the tab shows the `Not recorded` badge when nothing has been recorded yet — **the system never guesses the channel for you**, because "it was probably a transfer" is exactly what the slip exists to prove.
- Changing from `BANK` to `CASH` **clears the linked account immediately** (the badge must state that the money did not go through that account).
- If you choose another customer's account, or an account that was closed while the contract was being created: 404 `Bank account of this customer` / 422 `Bank account is CLOSED — money cannot be sent to a closed account`.
- **Slips are not linked to individual accounts** — they are attached to the contract, so the table shows `-` in the `Account` column for slips. They can be uploaded without approval, they do not move any balance and they do not change the contract status (verified: the ledger still holds exactly one `DISBURSEMENT` row).
- The **`New Loan (Disburse)`** form can record the channel right away (not compulsory), with the explanation `Recording how the money was handed over is optional here — it can be set later on the loan's Disbursement tab.`

### 9A.5 Evidence policy — Admin → `Evidence upload policy`

The **Evidence upload policy** card in the `Admin` menu (`/admin`) governs every upload in this area. **The values are read again on each file you submit, so a change takes effect immediately without restarting the server** (unlike the KYC policy, which governs identity documents).

| Field | Key in `system_config` | Default | Accepted ceiling |
|---|---|---|---|
| `Largest single image (KB)` | `evidence.maxFileSizeKb` | 2048 | 1 — 102,400 |
| `Most images per request` | `evidence.maxFilesPerRequest` | 1 | 1 — 10 |
| `Accepted image types` | `evidence.allowedMimeTypes` | `image/jpeg, image/png, image/webp` | at least 1 type |
| `Evidence storage per customer or loan (MB)` | `evidence.maxTotalBytesPerOwner` | 10 MB | must be at least one image of the largest allowed size |

- **The quota is split by owner**: the evidence folder of one customer and the slips of one contract each get their own allowance and do not eat into each other.
- Only `ADMIN` may edit. Any other role sees the message `Only an admin can change the evidence policy.` and the API answers 403.
- Under the card, `Current policy checksum: …` lets you compare which policy the server is using, and `Server defaults: …` shows the initial values taken from env.
- **This policy has nothing to do with KYC** — identity documents still use the `KYC policy` (section 24.2) as before.

### 9A.6 Automated emails in this area

| Event | When it happens | Recipients | What the email contains |
|---|---|---|---|
| `CUSTOMER_BANK_ACCOUNT_REGISTERED` | A new account is registered successfully | every authorised level (`CHECKER` / `HEAD_APPROVER` / `ADMIN` who are active) **except the person who pressed save**, plus the customer (if they have an email address) | `customerName`, `customerNumber`, `bankName`, **`accountNumberMasked` (mask only)**, `accountHolderName`, `accountStatus`, `createdByName`, `registeredDate` |
| `LOAN_DISBURSEMENT_EVIDENCE_UPLOADED` | A slip/receipt is uploaded under the contract successfully | the borrower + the authorised staff (the same set as the collection job) | `loanCode`, `customerName`, `channel` (a label that reads clearly, e.g. `Bank transfer`), **`accountNumberMasked`**, `fileName`, `uploadedByName`, `uploadedDate` |

- Both events have Lao-language templates enabled and are sent through the normal email queue (section 25) — **no SMS/SMTP is actually sent in the test environment**.
- The reason the person who recorded it does not get an email addressed to themself: the system removes the actor from the recipient list, so there can be no self-confirmation email pretending that "someone else has acknowledged it".
- Every message can be traced at `Admin` → the email queue, and every action is audited: `BANK_ACCOUNT_REGISTERED`, `BANK_ACCOUNT_CLOSED`, `BANK_ACCOUNT_PRIMARY_SET`, `EVIDENCE_UPLOADED`, `EVIDENCE_DELETED`, `LOAN_DISBURSEMENT_CHANNEL_SET` (the reason in the audit uses the masked number).

### 9A.7 Short checklist for routine work

- Before disbursing through an account: that account must be `ACTIVE`, must have at least 1 confirming evidence file, and the account holder's name must match the customer.
- On the same day the transfer is done: record `Channel` + `Transfer reference`, then upload the slip straight away. Do not leave it outstanding across the week.
- Never "upload the same file again because you think it did not show up" — the system blocks duplicate files by SHA-256. If you want to replace the picture, press `Delete` first.
- If the account number has to change: register the new number (the system blocks duplicates) → `Set as primary` → always have `HEAD_APPROVER`/`ADMIN` close the old number with a reason.

---

## 10. Loan Products

The `Loan Products` menu (`/products`) — everyone can view it, but **only `ADMIN` can create products or edit pricing**.

### 10.1 Product Table

Columns: `Code`, `Name`, `Rate`, `Interest basis`, `Term`, `Penalty`, `Early-Settlement Fee (% of principal left)`, `Currency`, `Active` (an on/off switch for Admin, shown as a badge for other roles), `Actions` → **`Edit pricing`**
Below the table header is a time-unit explanation (`products.interestInfo`) that helps convert between "monthly/annual rate < → number of months".

### 10.2 Create Product / Edit Pricing Form

| Field | Required | Description |
|---|---|---|
| `Code`* | Yes | Must be unique (it cannot be changed while editing) |
| `Name`* | Yes | The product name |
| `Interest Rate (%)`* | Yes | Up to 6 decimal places; must be greater than or equal to 0 |
| `Charged per` | Yes | The time unit of the rate (day/week/month/year); the system converts it into a monthly equivalent |
| `Interest basis` | Yes | **FLAT** (the same interest over the whole contract) or **DECLINING** (equal principal, declining interest). See section 16 |
| `Term Length`* | Yes | The term / number of periods |
| `Measured in` | Yes | The time unit of the penalty period length |
| `Penalty` (switch) | — | Turns penalty charging on or off for the product |
| `Penalty basis` | When on | `PERCENT_OF_OVERDUE` (a percentage of the overdue amount for the time) or `FIXED_PER_PERIOD` (a fixed amount per period) |
| `Penalty Rate (%)` / `Penalty Amount` | By basis | Must be greater than 0, according to the selected mode |
| `Penalty charged per` | When on | The time unit of the penalty period |
| `Grace Period (days)` | — | 0-3650 days — no penalty is charged during the grace period |
| `Penalty Cap` | — | The penalty ceiling as a % of principal (0 = no ceiling). If entered it must be ≥ 0.01 and ≤ 1000 |
| `Early-Settlement Fee (% of principal left)` | — | The fee when a customer **settles the whole balance before the final period is due**, charged as a % of the "principal still left" on that day; enter `0` = no fee; the value must be between 0-100 (above 100 the system answers 400 `Validation failed`). See section 18.4 |
| `Description` | — | Details |
| `Active` | — | On sale / off sale — once it is off you cannot disburse new loans on it, but existing contracts are not affected |

**The snapshot rule you must make customers and auditors understand**: when a loan is disbursed, the system embeds the rate / time unit / interest basis / term / penalty policy / **early-settlement fee %** into the contract. Editing the product later **does not affect existing contracts** — the screen confirms "Product updated. Existing loans keep their own snapshot.", and a newly edited rate applies only to contracts disbursed after that.

---

## 11. Loans — Disbursement

The `Loans` menu (`/loans`) — the **`New Loan (Disburse)`** button is for operators only (MAKER/CHECKER/HEAD/ADMIN).

### 11.1 Checklist Before Pressing Disburse

1. The customer is in the register and **KYC = `VERIFIED`** (when the policy gate is closed).
2. The product is still `Active`.
3. The amount being disbursed matches the staff member's authority and the approval tier that will result.

### 11.2 Disbursement Form

| Field | Notes |
|---|---|
| `Customer`* | Customers who failed KYC cannot be selected (greyed) while the disbursement gate is open |
| `Product`* | Only active products |
| `Principal (LAK)`* | The amount field inserts thousands separators automatically; must be greater than or equal to 0.01 |
| `Term override` + unit | Leave blank = use the product's value |
| (live calculation area) | The system shows an interest preview: FLAT gives the total for the whole contract, DECLINING gives the period 1 amount |
| `Note` | Internal note |
| `Channel` (optional) | `Not recorded` / `BANK TRANSFER` / `CASH` — with the explanation `Recording how the money was handed over is optional here — it can be set later on the loan's Disbursement tab.` |
| `Bank account` (when BANK is selected) | Only this customer's `ACTIVE` accounts + `Transfer reference` (≤64 characters) — details in section 9A.4 |

Confirm → the system **creates the contract and Posts the `DISBURSEMENT` entry in one transaction**. The contract starts as `ACTIVE` immediately, and the audit log records `LOAN_DISBURSED`.

### 11.3 Filters and Totals

- `Status` filter: All / ACTIVE / CLOSED / WRITTEN_OFF
- Search box: `Search loan no / customer / national ID`
- Top totals bar: principal / interest / penalty / outstanding balance of the data currently filtered
- Every row has a **`Schedule & summary`** link to the Loan Detail page

---

## 12. Loan Detail — Tracking One Contract

Open it from `Loans` → `Schedule & summary` (`/loans/:id`). The heading shows `Loan {number}` and a status badge.

- **Details** — customer, product, principal, rate and interest basis, term, disbursement date, the penalty policy in force, KYC snapshot
- **Outstanding Balance** — `Penalty`, `Past Interest`, `Past Principal`, `Total`

The 8 tabs (in the order shown on screen):

| Tab | Content | Buttons/Actions |
|---|---|---|
| **Summary** | Amounts collected / amounts waived / credit, the overdue period badge, the penalty rule message, **the early-settlement penalty message** (section 18.4), settlement agreement chips | **`Payment Allocation Preview`** (enter a hypothetical amount; the system shows the allocation split component by component and warns if a balance remains), **`Charge accrued penalty`** (the system works out the penalty still owed and creates it as a document pending approval), **`Charge this period's interest (amount)`** — DECLINING only — the last two buttons are visible only to operators and the contract must be `ACTIVE` |
| **Interest & penalty by month** | A period-by-period table: due date, principal, interest, penalty, paid, waived, remaining, period status | Read-only (the per-period interest charge button is on `Approvals` → InterestRunCard) |
| **Payment history** | The movements of this contract, paged | Link to open that entry's detail |
| **Customer credit** | This customer's credit history (ledger) | Read-only |
| **Disbursement & evidence** | The contract's channel for receiving money + transfer slips / cash receipts (section 9A.4) | `Save channel`, upload a slip, `View` / `Delete` files |
| **Guarantors & Payers** | This contract's guarantors and payers (section 18A.2) | `Engage a party`, `Release`, `Re-engage`, each person's KYC status |
| **Security** | Collateral items and their appraised values (section 18A.3) | `Pledge an item`, edit the value/appraisal date, `Cover right now` |
| **Hardship Addendums** | This contract's debt-restructuring addendum documents (section 18A.4) | `New addendum`, `Send for approval`, `Apply` |

---

## 13. Payment Requests

The `Payment Requests` menu (`/payment-requests`) — visible to MAKER/CHECKER/HEAD/ADMIN.

### 13.1 The Preparer (MAKER) Creates a Request

The **`New Payment Request`** button → fields:

| Field | Required | Notes |
|---|---|---|
| `Purpose` | Yes | `Pay debt` (collect a debt that is due) or `Deposit to credit` (deposit into the customer's credit, not applied to debt yet) — see 13.1A |
| `Active loan`* | Yes | Only `ACTIVE` contracts (closed or written-off contracts cannot be selected) |
| `Cash received (LAK)`* | Yes | The cash/transfer actually received today |
| `Customer credit to apply (LAK)` | — | Also apply the customer's credit; must not exceed the credit still remaining |
| `Note` | — | Slip reference / who received the money |

The system **proposes an allocation plan (allocation snapshot)** in the order penalty → interest → principal for you to see before submitting. Submit → the request becomes `PENDING` and waits for approval.

### 13.1A The "Period Not Yet Due" Gate and the Deposit to Credit Field (New Rule)

**Money received today may settle only the periods that have already fallen due.**

- After you select a contract, the form shows an information line (`payments.maxPayableToday`) with:
  - `Maximum payable today` = the highest amount the system accepts (periods already due, plus penalties already charged)
  - `Arrived periods` = how many periods / what total
  - If the next period is not due yet, it states the period number and the date (`next period #x due ...`)
  - It also shows the customer's remaining credit when there is any
- If you enter **more** than `Maximum payable today`, the submit button is blocked on screen, and if you force a direct API call the system answers **422** with a message that a not-yet-due amount cannot be settled — **do not change the numbers to get past it**; use the `Deposit to credit` field instead
- The correct procedure when the customer pays more than the due periods, or pays in advance:
  1. Select `Purpose` = **`Deposit to credit`**
  2. Enter `Cash received` for the amount you received (no settlement amount is needed, because nothing is settled)
  3. Submit into the same maker-checker approval queue → after Post the system records a `PAYMENT` document with **allocated amount = 0** and **the whole amount goes into the customer's `Customer Credit`** (with an audit line naming both the maker and the checker)
- Credit that has been deposited is applied to periods in two ways: the system applies it automatically before the due date (section 24.6), or staff create a `Pay debt` request and select `Customer credit to apply`
- **The only exception that lets you settle the whole balance early** = the Settlement path (section 18), which has its own separate approval and may carry an early-settlement fee

### 13.1B Money Approved but a Receipt Could Not Be Issued in Time (stale APPROVED)

For a request already `APPROVED` that was not Posted immediately, if that period then loses its standing (for example it passes its due date, or another payment settles it first), the next Post will **not settle the debt twice** but will hold the money in the customer's credit under rule 13.1A — the system always checks again at Post time.

### 13.2 The Reviewer (CHECKER / HEAD_APPROVER / ADMIN) Decides

Row buttons: **`Review`** (the "Verify and approve payment" dialog) or **`Reject`** ("Reject payment request").

- In `Review` the reviewer **may edit the 3 per-component amount fields** (override), but the system checks strictly: no negative values, no component above its own outstanding amount, and the total must not exceed the money received.
  - A field you leave untouched is taken as acceptance of the original plan (no override value is sent)
- `Reject` **requires a reason**
- The maker of this request may not approve their own — message: `"Maker cannot verify their own payment request (maker-checker separation)"`

After approval: the request becomes `APPROVED` and a `PAYMENT` financial document is created with status `APPROVED` — **this is not yet money moving in the ledger; you must Post it** (section 14.4).

### 13.3 Reworking a Rejected Request

Only `REJECTED` requests show the **`Resubmit as new`** button (MAKER/ADMIN) — the system creates a new request and links a reference to the original. **The old one cannot be edited back into effect.**

### 13.4 Counting Pending Work

The `Payment Requests` page shows the number of `PENDING` requests (`/pending-count`), used for the end-of-day check.

---

## 14. Transactions — Financial Documents and Post Work

The `Transactions` menu (`/transactions`) — every role can view it (VIEWER has no buttons); the create buttons are visible only to canCreate (MAKER/ADMIN)

### 14.1 Header create buttons

| Button | Document type created | When to use |
|---|---|---|
| `Penalty` | `PENALTY` | Charge a penalty (from the amount the system calculates, or enter it yourself) |
| `Waiver` | `WAIVER` | Waive part of a debt (penalty/interest/principal) |
| `Write-off` | `WRITE_OFF` | Write off part or the whole balance as a bad debt |
| `Adjustment` | `ADJUSTMENT` | Correct an amount recorded wrong; increase or decrease |

Per-row action buttons in the table:

- **`Post`** — shows rows with status `APPROVED` (operator of every role)
- **`Reverse`** — shows `POSTED` rows of type `PAYMENT` / `SETTLEMENT_PAYMENT`
- **`Reverse write-off`** — for a `WRITE_OFF` that is already POSTED (a document of type `WRITE_OFF_REVERSAL`)

Filters: `Transaction type` and `Status` (the full enum values are in section 30)

### 14.2 Fields shared by every financial document

| Field | Required | Notes |
|---|---|---|
| `Active loan`* or "reference entry" | Yes | A new document must be linked to a loan · a reversal must identify the source entry |
| `Amount (LAK)`* | Yes (penalty / reversal) | A single lump sum |
| Per-component amounts (penalty / interest / principal) | Yes (waiver / write-off / adjustment) | `ADJUSTMENT` **accepts negative values** to reduce a debt · waiver/write-off must not be negative and must be greater than 0 |
| `Reason`* | Yes | Every document: write it so an outsider understands without asking the maker |

Submit button: **`Submit for approval`** → the document becomes `PENDING_APPROVAL`, with the workflow following the tiers in section 4.3

### 14.3 Standard task sequence (make it a habit)

```
The maker creates the document (PENDING_APPROVAL)
  → the checker/supervisor/admin approves it in Approvals (APPROVED)
    → the operator presses Post (POSTED)   ← money moves here
      → if it is wrong: Reverse (PAYMENT only) or Reverse write-off
```

The system blocks out-of-sequence steps — you can Post only `APPROVED` documents, you can approve only the tier whose turn has come, and a maker cannot approve their own task

### 14.4 What the system does on Post (why you must be careful)

One Post is a single transaction that: checks the conditions (loan status, penalty ceiling, settlement ceiling, enough credit or not) → allocates the payment in order → updates the outstanding balances → recomputes the loan status (0 → `CLOSED`, full write-off → `WRITTEN_OFF`) → counts credit in/out → writes the audit → queues a receipt email to the customer (only for money actually POSTED) · if anything fails, it **rolls back everything**; no balance is left half-updated

---

## 15. Penalty / Waiver / Write-off / Adjustment / Reversal

### 15.1 Penalty

- The penalty policy comes with the product (section 10) and is snapshotted into the loan
- How it is calculated: `PERCENT_OF_OVERDUE` = overdue amount × rate% × (overdue days ÷ time unit) · `FIXED_PER_PERIOD` = fixed amount × number of periods (rounded up) — **it starts accruing only after the grace period ends**
- The `Charge accrued penalty` button in Loan Detail lets the system calculate the amounts that should be charged, then creates them as a document awaiting approval (the proposed amount is re-cut from newest to oldest so it does not exceed the ceiling)
- **Ceiling**: the accumulated POSTED penalty must not exceed `principal × maxPercentOfPrincipal%`; if it would exceed, the system rejects it at Post with the message "Penalty would exceed the product ceiling: ..." · a waiver **does not return ceiling headroom** (the ceiling counts the accumulated amount charged)
- It is linked to an `ACTIVE` loan only, both at creation and at Post (`CLOSED` / `WRITTEN_OFF` are excluded) — the message `Loan is WRITTEN_OFF — penalty can only be charged on an ACTIVE loan`

### 15.2 Waiver

- Specify the amounts per component (penalty / interest / principal); each part must be greater than 0 and **not exceed the outstanding amount of that component**
- A Waiver does not overwrite the original penalty entries — it is a separate document, keeping the original history fully intact
- Effect: the "waived" amount for the installment increases, but it **is not counted as money the customer paid** (kept strictly separate in reports)
- It must pass the workflow and be Post like other documents, and it falls under the ceiling check at Post

### 15.3 Write-off

- Used only with an `ACTIVE` loan; the default is the whole outstanding amount, and it must not exceed the amount outstanding
- After Post the loan becomes `WRITTEN_OFF` (**not `CLOSED`** — it still has an accounting outstanding balance, but the debt burden is written off, and it is **not counted** in Active Outstanding)
- Reverse it with **`Reverse write-off`** → if the outstanding balance comes back to more than 0, the loan reverts to `ACTIVE`; if it is 0, it stays `WRITTEN_OFF`

### 15.4 Adjustment

- You can enter negative/positive amounts per component; use it for entries recorded wrong (for example a duplicate Post, linked to the wrong loan, or a miscalculation)
- The amount that determines the approval tier = the sum of the |all components|
- **You must not push any outstanding balance component negative**
- Once an ADJUSTMENT is POSTED, it **blocks directly reversing the source entry**; you must make a new ADJUSTMENT instead (see the error in section 28)

### 15.5 Reversal

- You can reverse only `PAYMENT` / `SETTLEMENT_PAYMENT` that are **already POSTED** (it creates a new document; it does not delete the original history)
- The payment allocation of a reversal **follows the original plan component by component** (it does not re-average, and you cannot pick the amount yourself), and it must not exceed the amount never reversed before
- If a POSTED ADJUSTMENT touches that entry, the system blocks the direct reversal

### 15.6 Wrong settlement payment / wrongly posted interest

- A `SETTLEMENT_PAYMENT` is treated as a kind of repayment → it can be reversed with a Reversal, and the system still checks the original agreement's ceiling at Post to prevent paying more than the settlement price
- Interest set wrong: use an **Adjustment** to reduce `PAST_INTEREST` (there is no per-installment reversal)

---

## 16. Interest: FLAT vs DECLINING and Accruing Interest Receivable

### 16.1 The time units the system uses (neutral values; do not convert on your own)

1 month = **30 days** · 1 year = **365 days** · 1 week = 7 days · number of installments = `max(1, round the term converted to months)`

### 16.2 FLAT (fixed interest over the whole loan)

```
total interest = principal × (rate% ÷ months per unit) × the total number of months of the loan
```

The system **charges the whole amount on the disbursement date** (the entire interest of the loan is recorded as `PAST_INTEREST` from the first day), then it is allocated payment by payment per installment

### 16.3 DECLINING (equal principal · declining interest)

```
principal per installment = principal ÷ number of installments          (the last installment takes the rounding remainder)
interest per installment = outstanding principal at the start of the period × (rate% ÷ months per unit)
```

At disbursement the system records **only the 1st installment** · the next installments must be "accrued" (set interest receivable) periodically

- **There is no daily interest**: an early payment reduces the base of the next installment; there is no prorate interest discount

### 16.4 How to accrue interest (the per-period / monthly routine task)

Do this in the `Approvals` menu → **InterestRunCard** (data from `/transactions/interest/due`)

1. The system shows `DECLINING` loans still `ACTIVE` whose next installment is due (one loan yields 1 entry per run)
2. Press **`Create every charge`** (the whole portfolio) or **`Charge`** row by row
3. On the API side there is a dry-run and you can pick specific loans (a maximum of 500 ids per call); you should check before actually creating
4. The entries produced are `INTEREST_ACCRUAL` with status `PENDING_APPROVAL` → approve → Post (adds to the `PAST_INTEREST` balance)
5. **Duplicate-accrual guard**: an installment already in `PENDING_APPROVAL` / `APPROVED` / `POSTED` is skipped · if an installment was `REJECTED`, it can be accrued again

### 16.5 Bulk approval

In `Approvals` — use the checkboxes to select several rows (or select all), then press **`Approve selected (n)`** / **`Reject selected (n)`** (a maximum of 200 steps per run; each step runs in its own transaction). The result is shown as an Alert that lists the failures one by one. **Read the Alert to the end; do not assume everything passed** — a disabled row with the tooltip "Created by you — maker cannot approve own request" is our own work; someone else must decide it

---

## 17. Approvals — The Pending-Approval Queue

The `Approvals` menu (`/approvals`) — only `CHECKER` / `HEAD_APPROVER` / `ADMIN`

- The page's standing warning: *"Approval changes a transaction to APPROVED; it does not post it."* (after approving you still have to go Post it)
- The entries shown = the approval steps whose turn has come "for your role" only
- The decision dialog: approve / reject · **a rejection must have a typed reason** (leaving it blank cannot be submitted)
- Deciding at the wrong moment gives: "This step is not the current level; waiting for ..." (a level was skipped) or 409 (this step was already decided / someone pressed it first — the system locks against collisions)
- Permission not high enough for the level: "Your role cannot decide a HEAD approval step"

After all tiers are approved, the operator goes to **Post** in the `Transactions` menu to make the real financial effect take place

> The **hardship addendum** work is an exception: once all tiers are approved (CHECKER + HEAD for every copy), you do not Post in `Transactions`; instead you go back and press **`Apply`** in the `Hardship Addendums` tab of the loan — it is that apply step which rewrites the loan and creates the `WAIVER` document for the waived amount (chapter 18A.4)

---

## 18. Settlements — Agreements to Settle and Close

The `Settlements` menu (`/settlements`) — all operators (VIEWER does not have this menu)

### 18.1 Create an agreement (New Agreement) — the maker

Fields: `Active loan`* (only ACTIVE loans), `Agreed payment amount`* (must **not exceed the total outstanding amount of the loan**), `Reason`* → after submitting, a document awaiting approval is created (the workflow follows the amount); the initial status is `PENDING_APPROVAL`

**An agreement changes no amounts by itself**; it is an "agreed settlement price" that must be approved before it is used

Once a loan is selected, the form immediately shows a summary bar of the early-settlement fee (section 18.4) — if it qualifies, a yellow warning message shows the "% used · outstanding principal · the fee amount", along with a note that the customer must pay a total of = `the agreed amount + this fee`; if it does not qualify, it states the reason (the product does not charge it / all installments are already due)

### 18.2 Record a payment per the agreement (Record payment)

The **`Record payment`** button appears on an agreement row that is `APPROVED` → the form: cash*, credit used, note · under the agreement name there is a line for the amount ceiling (when there is a fee): `agreed + fee = total`

The conditions the system checks: it must be linked to an APPROVED agreement, it must be the same loan, and the amount paid (cash+credit) **must not exceed `agreedAmount + earlySettlementFee`** — exceeding it triggers an error at Post (preventing a duplicate/overpayment of the settlement price) · if that agreement has an early-settlement fee, **the fee document must be approved and posted first**; otherwise the system returns 422 with "Early-settlement fee of … must be approved and posted before the settlement payment" · the document type is `SETTLEMENT_PAYMENT` → approve → Post

### 18.3 Waive the difference (Waive shortfall)

The **`Waive shortfall`** button → a form specifying `Waiver reason`* with a description (`waiverInfo`) in the dialog

The condition: the amount actually paid per the agreement (after reversals) must **have reached the `agreedAmount + the early-settlement fee` of that agreement**, so it can issue a `WAIVER` document to release all the remaining debt burden (do not use this button to "cancel the fee" — if the fee has not been charged yet, cancel that penalty document first, then waive the difference)

### 18.4 Early-settlement fee

**Definition**: money the customer pays additionally when **closing the whole debt before the last installment of the loan is due**; it is not a penalty for "paying an installment early" (the system rejects that from the start, per section 13.1A)

| Topic | The system's rule |
|---|---|
| Rate | Set on the product (`Early-Settlement Fee (% of principal left)`) · **snapshotted into the loan at disbursement** · editing the product later does not affect loans already disbursed · `0` = do not charge |
| Calculation base | The **outstanding principal remaining** (`outstandingPastPrincipal`) on the date the agreement is created × the loan's % · rounded to Kip (2 decimal places) using the same formula as the ledger |
| When it qualifies | Decided from the actual installment schedule: if **there are still installments not yet due** (a `nextPendingPeriod` value exists) = an early settlement → there is a fee · if all installments are already due (even if unpaid they count as due) = it does not qualify → the fee is 0 |
| What it is recorded as | One **`PENALTY`** document, linked to that agreement, starting status `PENDING_APPROVAL` → it must pass a **separate maker-checker** → Post · the reason in the document states the "% used · outstanding principal · the agreement number" |
| Ceiling | This fee **counts under the product's penalty ceiling** (the `Penalty Cap` % of the principal) as before — if it would exceed the ceiling, the Post is rejected |
| The order you must follow | 1) create the agreement (the system calculates the fee + issues the fee document automatically) 2) approve + Post **the fee document** 3) create/approve/Post **the settlement payment request** 4) if a balance remains, then waive the difference |
| The amount the customer pays | `agreedAmount + earlySettlementFee` (shown in the `Early-settlement fee` column of the table, and in the record-payment dialog) |
| A fixed permanent amount | The fee is **hard-fixed on the agreement** (`earlySettlementFee`) from the day the agreement is created; changing the product/loan % later does not change an agreement already negotiated |
| Check before making an agreement | The `Loan Detail` page → the Summary tab shows a line "closing today costs how much in the fee, and the total to pay", and the New Agreement dialog also calculates it for viewing · both are **read-only** and create no document (the API `GET /api/settlements/early-settlement-fee/:loanId`) |
| Audit | `SETTLEMENT_AGREEMENT_CREATED` stores the reason together with the computed numbers (fee, %, outstanding principal) · the fee document has its own workflow + audit |

Practice note: quote the customer with figures matching the numbers on the screen when the agreement is created (the agreed amount + the fee), and if the amount the customer is ready to pay does not yet include the fee, do not Post the settlement payment request first — either charge the fee in full first, or renegotiate the agreement

---

## 18A. Debt restructuring when the borrower cannot pay (Hardship restructure)

Use this chapter when the borrower genuinely **cannot pay under the original contract**. It covers three connected areas in sequence: changing or adding payers (guarantors and substitute payers), checking the collateral, and drafting an **addendum to the contract** that lowers the interest rate, extends the term, or grants relief on overdue interest. Every step passes an approving authority, and every affected party receives an email.

`LoanDetailPage` gains three tabs after the existing ones: **`Guarantors & Payers`**, **`Security`**, **`Hardship Addendums`**. There is also a page in the book that lists every addendum at menu **`Hardship Addendums`** (`/restructures`); the `Open loan` button on that page takes you back into the contract.

### 18A.1 The five principles of this chapter

- **An addendum is a maker-checker document** — whoever drafts it cannot approve it, and **the lowest tier is always Checker + Head Approver**, no matter how small the amount (the form page states: *"Every addendum needs a checker and a head approver, and an admin joins above the head threshold. Whoever drafts it cannot approve it."*)
- **Relief does not "deduct" inside the contract** — the system drafts it as a separate **WAIVER** entry that must pass approval + Post on its own (sections 14-15) before money actually moves
- **Every guarantor or substitute payer must file KYC "once per role taken on"** — a KYC that passed in the past as an ordinary customer does not count (see section 18A.2)
- **Collateral must be appraised within the allowed age** before it counts as coverage, and if the policy that requires collateral before restructuring is switched on, filing an addendum is blocked
- **Old records are never rewritten** — a previous payer is "RELEASED" with a reason and a date, not deleted; the original contract can still reference all of its history

### 18A.2 Guarantors & Payers — guarantors and substitute payers

The **`Engage a party`** button (every operator role except VIEWER) opens the **`Name a guarantor or a payer`** dialog. Fields: `Person`*, `Role` (`GUARANTOR` / `PAYER`), `Relationship to the borrower`, `Note`

| Rule | Response from the system |
|---|---|
| The contract must be `ACTIVE` only | 422 `Loan is <status> — a guarantor/payer needs an ACTIVE loan` |
| The borrower cannot be the substitute payer of their own contract | 422 `The borrower is already the payer of their own loan` — the screen also blocks this in advance with the badge `The borrower cannot replace themselves as payer` |
| Two active substitute payers at the same time are not allowed | 422 `<name> is already the active payer of this loan — release that payer before naming another one` |
| The same person in the same role cannot be engaged twice | 409 `<name> is already a guarantor/payer of this loan` — the screen shows the badge `Already engaged in this role` |
| **That person's KYC must have "passed after this engagement"** | 422 `GUARANTOR KYC is not verified for this engagement — <reason>` / `PAYER KYC is not verified for this engagement — <reason>` |

**How "passed after the engagement" is measured**: the system checks that `kycStatus = VERIFIED` **and** that the latest verification date is **on or after the `engagedAt` of this role**. If the person was VERIFIED a long time ago and only now takes on this role, they must reopen, file and be verified again. The button on the row is **`Open identity check`** (it goes to that person's KYC page), and the chip states the work that still has to be done:

| Chip on screen | Meaning / what to do |
|---|---|
| `Verified for this loan` | Complete; the person can be used as a contracting party |
| `No KYC documents on file for the …` | No documents on file yet — the operator uploads identity documents |
| `Upload documents` / `Send for review` | Uploaded but not submitted — press submit on the KYC page (section 9.4) |
| `Awaiting review` | Submitted; waiting for a `CHECKER`/`HEAD_APPROVER`/`ADMIN` to verify (it must not be the person who submitted it) |
| `Re-upload and submit again` | Rejected — read the reason and start over |

**Releasing a guarantor or substitute payer (`Release`)** — the button appears only for `HEAD_APPROVER` / `ADMIN` and only on rows that are `ACTIVE`. The **`Release this party`** dialog **requires you to type a reason** (`Why are they being released`); it cannot be left blank (400 `A release needs a reason on record`). Releasing a person who is already released gives 422 `Loan party is RELEASED — only an ACTIVE one can be released`. If a previously released person is brought back, the system **revives the original row with a new `engagedAt`** (so KYC must be verified again under the rule above)

### 18A.3 Security — collateral and coverage

The **`Pledge an item`** button opens the **`Pledge property as security`** dialog.

| Field | Required | Rule |
|---|---|---|
| `Type` | Yes | `LAND` (land), `BUILDING` (a building/structure), `VEHICLE` (vehicle), `DEPOSIT` (deposit), `EQUIPMENT` (machinery/equipment), `GOLD` (gold), `OTHER` |
| `Description of the item *` | Yes | 3-255 characters |
| `Title deed or certificate no.` | No | Title deed or guarantee letter number, no more than 64 characters |
| `Appraised value *` | Yes | Always greater than 0 — 422 `An appraisal of zero pledges nothing` |
| `Appraised on` | No | Format `YYYY-MM-DD` only (400 `Use the YYYY-MM-DD format`) and **it must not be in the future** (422 `valuedAt cannot be in the future`) |
| `Who owns it` | No | `Not recorded` / `<name> — the borrower` / only an ACTIVE guarantor or substitute payer of this contract — anyone else is rejected with 422 `<name> holds no active role on this loan, so their property cannot be pledged against it` |

**The coverage card** (recomputed every time): `Cover right now` = the percentage of collateral that counts, judged against the policy as `Enough cover` or `Short of cover`. **Only `PLEDGED` items whose appraisal has not expired are counted.** Items that are too old are reported as `This loan has no pledged collateral on record` or `Every pledge on record is out of date, so nothing counts as coverage` or `Coverage <p>% of the outstanding <o> is below the required <r>% (<need>)`, together with a warning of how many items were excluded

- If another step tries to continue while the collateral is short, it hits 422 `Collateral check failed — <reason>`
- **Closing/releasing a pledge**: the `Release` button is for `HEAD_APPROVER`/`ADMIN` only and the reason is mandatory. Releasing twice gives 422 `Collateral is RELEASED — only a PLEDGED item can be released`. If releasing the item would make coverage short, the screen warns you first: `The loan is already short of cover — releasing this makes it worse.`
- Policies (Admin, re-read on every check): `collateral.minCoveragePercent` (default 100), `collateral.maxValuationAgeDays` (365), `collateral.requirePledgeForRestructure` (on = **there must be an appraisal that counts before an addendum can be filed**; if it is off **and** there is no collateral at all, the system **warns** instead of blocking)

### 18A.4 Hardship Addendums — lower the rate / extend the term / change the payer / relieve interest

The **`New addendum`** button opens the **`Draft a hardship addendum`** dialog. The top of the dialog shows context to read before you fill anything in (outstanding balance, accrued interest, the contract's current terms, coverage) and a note about the approval tiers.

You can choose more than one change in a single document — four checkboxes (chips: `LOWER RATE`, `LONGER TERM`, `NEW PAYER`, `INTEREST RELIEF`):

| Change type | Fields to fill in | Checks performed by the system (all 422 unless noted) |
|---|---|---|
| `INTEREST_RATE_REDUCTION` | `New interest rate` | Must be > 0 (`A rate reduction needs the new rate, greater than zero`) and **must be below the current rate** (`The new rate (…) is not below the rate the loan carries (…) — this paper relieves a borrower, it does not re-price them upward`) |
| `TERM_EXTENSION` | `New term (months)` | A whole number **above the current contract term** (`An extension needs a whole number of months above the current term (…)`) and **no more than 600 months** (`A restructured term cannot exceed 600 months`) |
| `PAYER_CHANGE` | `Replacement payer` | A person must be chosen (`A payer change needs the customer who will pay from now on`) and they must be an `ACTIVE` party of this contract whose KYC has passed (`The proposed payer is not an active party on this loan — register them as a guarantor or payer first`) — **so section 18A.2 must always be done first** |
| `INTEREST_RELIEF` | `Interest relief` | Must be > 0 (`Interest relief needs an amount greater than zero`) and **must not exceed the interest still owed** (`Relief (…) cannot cancel more interest than is still owed (…)`) |
| All types | `Why the borrower cannot pay *` | **At least 10 characters** (400 `Explain why this borrower can no longer pay as contracted`), maximum 2000 |

Sending values that were filled in for a change type that was not selected is blocked with 422 such as `A new rate was sent without asking for a rate reduction`, `A new payer was sent without asking for a payer change`. Selecting the same type twice in one list gives 400 `changeTypes contains a duplicate`. The contract must be `ACTIVE` (`Loan is <status> — a hardship addendum rewrites a live contract`)

**Approval route**: after creation the status is `PENDING_APPROVAL` and the workflow that is opened **always requires Checker + Head Approver**. If the outstanding balance is above the `Head threshold`, `ADMIN` is added as the last tier (the amount test uses the contract's outstanding balance on the filing date against the thresholds in section 24.1). Decisions are made by `CHECKER`/`HEAD_APPROVER`/`ADMIN` according to tier (the work sits in the `Approvals` queue, section 17, and can be approved in batches)

| Status | Meaning |
|---|---|
| `PENDING_APPROVAL` | Waiting on the current tier — `This step is not the current level; waiting for <level>` if someone clicks across tiers |
| `APPROVED` | Approved at every tier **but still has no effect on the contract** — `Apply` must be pressed |
| `REJECTED` | Rejected at one of the tiers (a reason is required, 400 `A rejection reason is required`) |
| `APPLIED` | Applied to the contract; the document is closed permanently |

Approving the same tier twice gives 409 `This approval step has already been decided`. A workflow that is already closed gives 409 `This approval workflow is already closed`. The wrong tier gives 403 `Your role cannot decide a <level> approval step`. The maker pressing it themselves gives 422 `Maker-Checker separation: the maker cannot approve their own request`

**Apply (put the addendum into force)** — the `Apply` button appears only in status `APPROVED` and only for operators:

1. Check that it has never been applied (409 `Addendum <number> has already been applied`) and was not rejected (422 `Addendum <number> is <status> — only an approved one can be applied`)
2. The contract must still be `ACTIVE` (422 `Loan is <status> — the contract this addendum rewrites is no longer live`)
3. **Check the drift of the terms** — if the contract was amended by another document while approval was pending, the system refuses: 422 `The loan no longer carries the terms this addendum was approved against (…) — withdraw it and write a new one` (it never applies on top of newer terms)
4. Write the new terms into the contract (rate/unit/term/number of months) and **record the before/after values plus the coverage snapshot of the filing date** with the document
5. `PAYER_CHANGE`: release the old payer automatically with the reason `Replaced as payer by addendum <number>`, then set the new person to `ACTIVE` (if that person is no longer a party in the meantime, 422 `The payer named in this addendum is no longer an active party on the loan`)
6. `INTEREST_RELIEF`: **draft it as a WAIVER in status `PENDING_APPROVAL`** (component = `PAST_INTEREST`, reason `Interest relief under addendum <number>: <reason for the hardship>`) with its own workflow — the user must **approve + Post that waiver separately** before the money actually decreases (if the interest owed has shrunk until it is no longer enough, 422 `Interest still owed (…) no longer covers the (…) this addendum relieves`)

Confirmation messages on screen: `Addendum <number> is on file and waiting for approval.` / `… is in force; the schedule now follows the new terms.` / `… relief is drafted as waiver <number> and must still be approved and posted separately.` The table at menu `Hardship Addendums` (`/restructures`) has a `Waiting for approval` column for tracking every document

### 18A.5 The emails every party receives

The 5 new events use the same recipient set (**hardship audience**) = the borrower + everyone who is an `ACTIVE` party on this contract + the active authorities `CHECKER`/`HEAD_APPROVER`/`ADMIN` (duplicate emails removed), with extra recipients for some events only:

| Event | Fired when | Extra recipients | In the email |
|---|---|---|---|
| `PARTY_REGISTERED` | A guarantor/substitute payer is registered successfully | — | `loanCode`, role, name of the person engaged, `partyCustomerNumber`, effective date (no monetary figures) |
| `PARTY_RELEASED` | A party is released | **the person released** | plus `releaseReason` |
| `RESTRUCTURE_REQUESTED` | An addendum is filed | — | `requestNo`, the types requested, new rate/new term/relief amount, status |
| `RESTRUCTURE_DECIDED` | When the request **passes every tier** or **is rejected at any tier** (fired once per document) | **the maker of the request** | the decision (`approved` / `not approved`) plus a note |
| `RESTRUCTURE_APPLIED` | Apply succeeds | **the maker of the request** | the new terms + the effective date |

Every event has a Lao-language template, and **no bank account number appears in any payload in this chapter** (account numbers exist only in the financial evidence emails, section 9A.6, which mask the entire line)

### 18A.6 The correct work sequence (steps cannot be skipped)

1. **18A.2** Register the new guarantor/substitute payer, have that person file KYC, have another reviewer press `Verify identity`, until the chip shows `Verified for this loan`
2. **18A.3** Survey or add collateral and appraisal dates until coverage meets the threshold (or an Admin deliberately switches `requirePledgeForRestructure` off and owns that decision)
3. **18A.4** The operator drafts the addendum and selects every change type in the same document, then presses `Send for approval`
4. `Approvals` — `CHECKER` approves, then `HEAD_APPROVER` approves, then `ADMIN` if the amount exceeds the head threshold
5. The maker (or another operator) presses **`Apply`**; the installment/interest table then follows the new contract
6. If interest relief was granted: go and perform the **approval + Post** of the `WAIVER` that the system drafted in Transactions (section 14.3), otherwise the balance never falls
7. Check that every party really received the email (Admin, email queue) and that the audit log holds all of it: `LOAN_PARTY_REGISTERED` / `LOAN_PARTY_REENGAGED` / `LOAN_PARTY_RELEASED`, `LOAN_COLLATERAL_PLEDGED` / `LOAN_COLLATERAL_RELEASED`, `RESTRUCTURE_REQUESTED` / `RESTRUCTURE_REQUEST_APPROVED` / `RESTRUCTURE_APPLIED`, `APPROVAL_STEP_APPROVED` / `APPROVAL_STEP_REJECTED`, `TRANSACTION_CREATED`

> **Note before use**: extending `termMonths` makes the system **recompute the installment schedule for the whole contract**. Installments that have already passed may receive new amounts (the totals still match the ledger) — this is documented design behavior of the "schedule derives from the ledger" model (F-HSR-1). Users should therefore request an extension early, "before many installments have passed", and always check the monthly reports after apply.

---

## 19. Customer Credit — the customer's credit balance

Menu `Customer Credit` (`/credits`) — everyone can view it (there are no entry buttons). Credit **arises** in 2 ways:

1. **A payment above the amount due** — the excess becomes credit (`CREDIT_ACCRUED`)
2. **A request of type `Deposit to credit`** (section 13.1A) — the whole amount goes into credit, without deducting any debt

and credit **is used** in 2 ways:

- A staff member creates a `Pay debt` request and fills in `Customer credit to apply` (`CREDIT_USED`) — there must be enough, and the amount is checked at 2 stages (when the request is created, and at Post)
- **Automatic offset (auto-debit)** before the installment due date, according to the policy at `Admin` > Payment policy (section 24.6) — the system performs the entry under the machine account `system.auto-debit` and records in the audit log every time that "no human pressed the button"

On the page: a list of customers with their credit balances, and the **`Ledger`** button, which opens the full history of entries with balances. Use it to answer the customer's question "how much money do we have left?" (this balance falls on its own when auto-debit applies it to an installment that is about to be due)

---

## 20. Reconciliation — balance matching

Menu `Reconciliation` (`/reconciliation`) — users who see the menu: `ADMIN`, `CHECKER`, `HEAD_APPROVER`. Who may run it: operator

Steps: enter a `Loan ID` (leave it blank = the whole portfolio) — press **`Run reconciliation`** (while it runs the button shows `Running…`) — a one-line summary plus a record table

- The system totals the **POSTED entries** and compares them with the operational outstanding balances, split by component (penalty / interest / principal)
- Each row's result is `MATCHED` (green) or `MISMATCHED` (red)
- **The system never corrects anything automatically** — when a row is MISMATCHED, record it (audit entry `RECONCILIATION_MISMATCH`) and **fix it with an `Adjustment` document that goes through the normal workflow**. Never edit the database directly

---

## 21. Monthly Reports — monthly reports

Menu `Monthly Reports` (`/reports`) — users who see the menu: `ADMIN`, `HEAD_APPROVER` only

- Choose a **6 / 12 / 24 month** window (the API side supports 1-36 months, default 12) and filter by customer
- Six cards with MoM arrows, the **TrendChart** (click or use the keyboard to select a month column to focus — the month chips appear above and can be removed), the **ShareDonut** shares, and a monthly table with MoM/YoY plus a **Window total** row
- The **`Export CSV`** button saves a file to the local machine (it carries a BOM, so Excel opens it without garbled language)

What the figures mean (every figure counts **POSTED entries only**, grouped into months by `postedAt`):

| Figure | Source |
|---|---|
| `disbursed` | Money lent out (DISBURSEMENT) |
| `moneyIn` | Money actually received = PAYMENT + SETTLEMENT_PAYMENT |
| `reversed` | Amounts that were reversed |
| `collected` | `moneyIn − reversed` (the performance figure used for reporting) |
| `writtenOff` / `waived` | Debt written off / interest relieved |
| `interestAccrued` / `penaltyAdded` | Interest/penalty charged on (the positive side of the ledger) |
| `principalPaid` / `interestPaid` / `penaltyPaid` | Amounts closed off (the negative side of the ledger) |
| `closingOutstanding` | Outstanding balance at the end of the report window (accumulates the ledger differences from before the window) |
| MoM / YoY (%) | Shown as an empty value when the divisor is 0 or the comparison period falls outside the window (the system deliberately does not compute it) |

> **Why report figures may not match what you see on other screens**: only POSTED entries are counted — a document that is `APPROVED` but has not been posted yet is not in the report, and that is the work to clear before closing the period

---

## 22. Audit Trail — The Inspection Trail

The `Audit Trail` menu (`/audit`) — visible to every role · the **`Export CSV`** button (file name `audit-page-N.csv`)

- 4 free-text filter fields + the **`Search`** button: e.g. the actor, loan/customer id, action, reference
- Table: time, `action`, actor, the related document/contract/customer, status before → after, amount, reason, IP, user-agent, and the workflow maker/checker/head/admin

The actions the system records (use them to search in the filter field):
`LOAN_DISBURSED`, `LOAN_STATUS_CHANGED`, `TRANSACTION_CREATED`, `TRANSACTION_APPROVED`, `TRANSACTION_POSTED`, `APPROVAL_STEP_APPROVED`, `APPROVAL_STEP_REJECTED`, `PAYMENT_REQUEST_CREATED`, `PAYMENT_REQUEST_RESUBMITTED`, `PAYMENT_REQUEST_APPROVED`, `PAYMENT_REQUEST_REJECTED`, `SETTLEMENT_AGREEMENT_CREATED`, `SETTLEMENT_AGREEMENT_APPROVED`, `RECONCILIATION_MISMATCH`, `CREDIT_ACCRUED`, `CREDIT_USED`, `KYC_DOCUMENT_UPLOADED`, `KYC_DOCUMENT_DELETED`, `KYC_SUBMITTED`, `KYC_VERIFIED`, `KYC_REJECTED`, `KYC_REOPENED`, `KYC_REVERIFY_REQUIRED`, `CONFIG_UPDATED`, `LOAN_PRODUCT_CREATED`, `LOAN_PRODUCT_UPDATED`, `EMAIL_TEMPLATE_UPDATED`, `NOTIFICATION_REQUEUED`, `CUSTOMER_CREATED`, and the `USER_*` group (login, change/reset password, send/verify/use OTP, create/edit/delete/restore account, profile, avatar)

In practice: investigating "who changed this amount, when, and why" — the `reason` field is the evidence the actor must write so that an outsider can understand.

---

## 23. Users — Manage Staff Accounts (Admin)

The `Users` menu (`/users`) — **`ADMIN` only**

| Action | Button/How | Fields and cautions |
|---|---|---|
| Create account | **`New user`** | `Username`*, `Full name`*, `Email`, `Role` (5 options), initial `Password` (the screen shows the current password rules), the `Account active` switch, avatar upload |
| Edit | the **Edit** icon | Change name/email/role/status · the password field "New password (leave empty to keep)" — leaving it empty means no change |
| Suspend account | the `Account active` switch in Edit | A disabled account cannot log in, and its existing token stops working (`Account is disabled`) |
| Delete (soft delete) | the **Delete** icon (with a confirmation box) | History is not deleted · the account disappears from the normal list · turn on **Show deleted** to see deleted entries |
| Restore | the **Restore** icon (while Show deleted is on) | It returns to being a normally usable account |
| Reset password | the **Send reset link** icon, or select several rows → **`Send reset links (n)`** | Sends a link to the email · the user opens the link and sets the password themselves · **after a password change, every session of that account is revoked immediately** |

Best practices:

- Do not give the `ADMIN` role to operational staff (ADMIN is the top approval tier and can change central settings).
- Staff resignation → **suspend the account first** to preserve the audit trail, then follow company policy.
- Changing a role takes effect from the next action; already-issued tokens still hold the old data until the user logs in again.

---

## 24. Admin — System Configuration Centre (Admin)

The `Admin` menu (`/admin`) — **`ADMIN` only** · every card works as "edit the value into a draft (draft) → press Save" and **records a `CONFIG_UPDATED` audit entry** (old/new values, with a checksum)

Central-layer principle: defaults come from the environment → **values changed on this page override them immediately**, without restarting the system.

### 24.1 Global thresholds (Approval tiers)

- The `Checker threshold (LAK)` and `Head threshold (LAK)` fields (API: `PUT /api/config/thresholds`)
- Must be greater than 0 and **`head ≥ checker`** — if you enter a lower value, the card disables the Save button (and the server checks again as a second layer).
- Takes effect for documents created after saving · documents already queued before the change keep the old tier (the value is baked into the workflow).
- Saves the two rows + the audit entry as a single transaction, so there is no "half-changed" state.

### 24.2 KYC policy (14 fields)

| Field | Range the system accepts | Meaning |
|---|---|---|
| `maxFileSizeKb` | 1–102400 | Image size per file (KB) |
| `maxFilesPerRequest` | 1–10 | Number of files per 1 upload request |
| `allowedMimeTypes` | Only `image/jpeg`, `image/png`, `image/webp` | Accepted file types — **PDF is deliberately not supported** |
| `allowedDocumentTypes` | The KYC types this branch/office accepts | At least 1 type is required |
| `requiredIdentityTypes` | Must be a subset of the above | At least 1 type in this set is required |
| `requireSelfieWithId` / `requireSignature` / `requireFamilyBook` | true/false | Enforce each additional kind of evidence |
| `acceptExpiredDocuments` | true/false | Whether expired documents may be accepted |
| `expiryWarningDays` | **0**–3650 | How many days before expiry to warn — **0 = turn off warnings, and 0 takes real effect** |
| `maxTotalBytesPerCustomer` | At least the size of one maximum-size file | Storage quota per customer |
| `blockDisbursementUntilVerified` | true/false | **The disbursement gate** — turn it off only on a written order |
| `reverifyOnDocumentChange` | true/false | Editing a document after `VERIFIED` sends it back to `PENDING` |

The business rules the system enforces (returns 422 with a message): at least 1 document type · at least 1 identity type · identity must be a subset of allowed · no non-image mimetype · the quota must fit at least 1 largest file.

> The value `0` in the other numeric fields (`maxFileSizeKb`, `maxFilesPerRequest`, `maxTotalBytesPerCustomer`) **is not a valid value**. The system reads it as "not set" and falls back to the default · the only exception is `expiryWarningDays`, where 0 means "warnings really turned off".

### 24.3 Password policy

`minLength` 4–64 · `maxLength` 4–128 and must be ≥ minLength · the switches `requireDigit`, `requireUppercase`, `requireLowercase`, `requireSymbol` — **at least 1 rule must be on** · the defaults are 6/16 with digit+uppercase+lowercase.

### 24.4 Avatar policy

`enabled` true/false · `maxFileSizeKb` 1–10240 · file types are images only.

### 24.5 Email templates and email queue maintenance (API `/api/notifications`)

- View the template list (English/Lao), the queue status summary (`/summary`), the outbox list, and the **Requeue** button for `FAILED`/`DEAD` jobs.
- A placeholder in a template must be declared in the system (e.g. `{{amount}}`) · the system rejects templates with risky markup (`script`, `iframe`, event handler).
- **The OTP email subject and the password-reset link are sealed when stored and shown as `<sealed>` in the admin screen** — this is a security measure; do not try to alter it to reveal the code.
- Receipt emails to the customer are queued only for items already POSTED · an error in the email queue **does not roll back the posting** (you must requeue it yourself).

### 24.6 Payment policy — automatic debit before the due date (auto-debit)

The `Repayment collection policy` card on the `Admin` page · **viewable by every role that can reach the Admin page, editable by `ADMIN` only** (other roles see the message `Only an admin can change the collection policy.`, and a direct PUT returns 403 `Requires role: ADMIN`).

| Field (as labelled on the screen) | Value | Meaning |
|---|---|---|
| The `Let the system auto-debit instalments from customer credit` switch | Default **off** | Off = the system never debits on its own (even while the timer runs, the job does not execute) |
| `Auto-debit this many days before the due date` | 0–90, default 3 | "How many days before the instalment falls due" the system will debit credit to pay that instalment · `0` = debit only instalments already due |

The card also shows `Current policy checksum` and `Server defaults` · once you press **`Save collection policy`** the value is stored as a central policy (keys `payment.autoDebitEnabled`, `payment.autoDebitLeadDays`), has an audit record every time, and **takes effect on the next job run immediately, with no need to restart the server**.

**The defaults from `.env` apply only when nothing has ever been set on the screen**: `AUTO_DEBIT_ENABLED=false`, `AUTO_DEBIT_LEAD_DAYS=3`, `AUTO_DEBIT_POLL_INTERVAL_MS=900000` (job polling interval = 15 minutes) · once ADMIN saves a value on the Admin page, **the database value beats the environment value every time**.

**What the system does during automatic debit (per one `ACTIVE` contract)**

1. Lock the contract (pessimistic lock), then compute the collectable amount by extending the "due" window forward by `lead days`.
2. If that instalment already has a scheduled debit (a `PAYMENT` document from the machine account bound to that instalment is already APPROVED/POSTED) → skip that instalment (**prevents double debit per instalment** — a leftover job from a previous run is posted to completion first).
3. If the customer's credit is insufficient/absent → skip with the reason "Nothing is collectable on this loan right now".
4. If the conditions are met → create a payment request exactly as staff would (cash 0, use the full amount from credit, state the instalment number) → approve → Post.
5. Every document uses the machine account name **`system.auto-debit`** and `userAgent = auto-debit-job`, so on the Audit page it is distinguishable from jobs a person clicked.

**The `Preview the next pass` button (test before enabling)** — fires `POST /api/config/payment/auto-debit/run` with `dryRun: true` = **read-only**: it creates no document, creates no machine account, and touches no amount · the screen summarises how many ACTIVE contracts it scanned (`previewSummary` / `previewNone`), then shows each row as `loan · period n · amount · falls due <date>` per the key `plannedRow` · an instalment already debited by the machine account (a `PAYMENT` document of `system.auto-debit` bound to that instalment number) is not planned again · if the switch is still off, the message `The switch is off, so none of these is debited by itself.` appears at the end of the list.

**Run a single contract only** — ADMIN can call the same endpoint with `{"loanId": "..."}` (not a dry run) even while the switch is off (the authorisation is ADMIN themselves) · the system records an `AUTO_DEBIT_RUN` audit entry stating who ran it, how many contracts were scanned, and the switch's state.

Best practice: turn the switch on only when the customer has genuinely prepaid credit (Section 13.1A), and periodically check `Approvals`/`Audit` for any `system.auto-debit` items still pending Post.

### 24.7 Collateral policy (Collateral for Debt Restructuring)

The `Collateral policy` card on the `Admin` page · editable by `ADMIN` only (other roles see `Only an admin can change the collateral policy.`, and a direct PUT returns 403) · API `GET/PUT /api/config/collateral`.

| Field on the screen | Key in `system_config` | Default | Accepted range | Meaning |
|---|---|---|---|---|
| `Minimum cover (percent of what is owed)` | `collateral.minCoveragePercent` | 100 | 0 – 1000 | The collateral must be appraisable at at least what % of the outstanding balance · **0 = no cover requirement at all** (0 takes real effect) |
| `An appraisal stops counting after (days)` | `collateral.maxValuationAgeDays` | 365 | 0 – 3650 | The appraisal age that still counts as cover · **0 = never expires** |
| `Refuse a hardship addendum when nothing is pledged` | `collateral.requirePledgeForRestructure` | on | true/false | A contract with no collateral "must not have a restructuring document" at all |

- The system **re-reads the values on every restructure check** → a change takes effect for the next request without a restart.
- Below the card there is `Current policy checksum: …` and `Server defaults: …` · the `Save collateral policy` button → `Collateral policy updated.` · audit `CONFIG_UPDATED`.
- The effect of these values on the screen work is explained in Chapter 18A.3 (`Cover right now`, `Collateral check failed — …`).

### 24.8 Evidence upload policy (Financial evidence)

The `Evidence upload policy` card · API `GET/PUT /api/config/evidence` · controls **financial evidence only** (account-confirmation evidence + slips/receipts) — identity documents still use `KYC policy` (24.2).

| Field on the screen | Key | Default | Accepted range |
|---|---|---|---|
| `Largest single image (KB)` | `evidence.maxFileSizeKb` | 2048 | 1 – 102,400 |
| `Most images per request` | `evidence.maxFilesPerRequest` | 1 | 1 – 10 |
| `Accepted image types` | `evidence.allowedMimeTypes` | jpeg, png, webp | At least 1 type must remain |
| `Evidence storage per customer or loan (MB)` | `evidence.maxTotalBytesPerOwner` | 10 MB | Must be ≥ the size of one maximum-size image — if not enough you get 422 `maxTotalBytesPerOwner must allow at least one maximum-size image` (the screen blocks it first with the message `The quota has to fit at least one image of the maximum size.`) |

- The quota is **per owner** — one customer file and one contract each get their own allocation; they do not eat into each other.
- Read on every upload click → takes effect immediately · other roles see `Only an admin can change the evidence policy.` · the `Save evidence policy` button → `Evidence policy updated.` · audit `CONFIG_UPDATED`.
- The upload details and all the error messages the system enforces are in Chapter 9A.3–9A.5.

---

## 25. Notifications and Email

The events for which the system generates a notification/email:

The system enqueues emails/notifications for **26 events** (the real values in `NotificationEventType`). The recipients fall into 3 kinds: **the customer alone**, **every approval-tier holder (active CHECKER/HEAD/ADMIN)**, and **everyone in the circle (borrower, guarantor, payer + approval-tier holders, excluding the person who clicked save)**.

| Event | When it happens | Recipients |
|---|---|---|
| `LOAN_APPLICATION_SUBMITTED` | Contract created / disbursement completed | Customer (borrower) |
| `LOAN_APPROVED` / `LOAN_REJECTED` | The final decision on the loan request | Customer — with amount, term, rate, or the reason |
| `PAYMENT_REQUEST_SUBMITTED` | The maker submits a payment request | Borrower + approval-tier holders |
| `PAYMENT_REQUEST_APPROVED` / `PAYMENT_REQUEST_REJECTED` | The request passes/fails (+ the original maker also receives it) | Borrower + approval-tier holders + maker |
| `PAYMENT_POSTED` | The money is actually POSTED (receipt) | Customer only |
| `CREDIT_DEPOSITED` | Deposited into the customer's credit (not yet offset against debt) | Customer only |
| `AUTO_DEBIT_POSTED` | The auto-debit job debits credit to pay an instalment | Customer only |
| `PENALTY_POSTED` / `WAIVER_POSTED` / `WRITE_OFF_POSTED` | A penalty / waiver / write-off already POSTED | Borrower + approval-tier holders (not reaching the guarantor, because this group of work does not change the guarantor's obligation) |
| `SETTLEMENT_REQUESTED` / `SETTLEMENT_DECIDED` | Submit / decide a settlement agreement | Customer (borrower) |
| `PARTY_REGISTERED` / `PARTY_RELEASED` | Register a guarantor/payer, or release one | Everyone in the circle (Chapter 18A.5) |
| `RESTRUCTURE_REQUESTED` / `RESTRUCTURE_DECIDED` / `RESTRUCTURE_APPLIED` | Submit / decide / apply a debt restructuring | Everyone in the circle (Chapter 18A.5) |
| `CUSTOMER_BANK_ACCOUNT_REGISTERED` | Registers the customer's bank account | Approval-tier holders (except the clicker) + customer |
| `LOAN_DISBURSEMENT_EVIDENCE_UPLOADED` | Uploads a slip/receipt under the contract | Borrower + approval-tier holders |
| `CUSTOMER_REGISTERED` | Opens a new customer record | Approval-tier holders (except the clicker) + customer — states the KYC status so it is clear documents still need submitting |
| `LOAN_PRODUCT_CREATED` | Admin creates a new product | Approval-tier holders (except the clicker) |
| `USER_CREATED` | Admin opens a staff account | That staff member |
| `PASSWORD_RESET_OTP` / `PASSWORD_RESET_LINK` | Forgotten password | The account owner — **the subject and body are sealed when stored (`<sealed>`)** |

- **There is no email to the guarantor/payer for the "payment/penalty" group of events** — the whole-circle recipient set occurs only for hardship work and financial evidence.
- You can check the actual number of events the system knows at `Admin` → the template list (every event has an EN + LO template).

The job states in the queue (outbox): `PENDING` → `SENT` or `FAILED` (retries with backoff) → `DEAD` after 5 attempts — Admin can recover them with Requeue.

---

## 26. Role-by-Role Guide: Day-to-Day Work

### 26.1 MAKER (originator)

1. Open `Dashboard` and check the pending work and the day's totals.
2. `Customers` → `New Customer`: create a new customer and fill in every required field (National ID above all).
3. Go into the customer file → **upload the KYC documents** per the checklist (real photos, no duplicates, within the quota).
4. Press `Submit for verification` once the checklist is complete — wait for the reviewer; do not press it again.
5. `Loans` → `New Loan (Disburse)`: disburse a loan (the customer must be `VERIFIED`) — if the money goes to an account, pick an `ACTIVE` account; you can enter the `Transfer reference` right in the form.
6. Same day as the disbursement: on the contract's `Disbursement & evidence` tab → save the channel then **upload the slip/receipt** (chapter 9A.4) · for customers paid by account: record the account and attach the confirmation proof on the customer file (chapter 9A.2-9A.3).
7. `Payment Requests` → `New Payment Request`: take the daily payments; check the slip or the cash before submitting.
8. `Transactions` → create `Penalty` / `Waiver` / `Write-off` / `Adjustment` as assigned (the Reason must be clear).
9. Borrower-cannot-pay work (chapter 18A): record the guarantor/substitute payer → attach collateral until the cover is complete → create a `New addendum` → `Send for approval` (never press `Apply` yourself).
10. Clear work that was `REJECTED`: read the reason → `Resubmit as new` or create a new one.
11. **Post** documents that are `APPROVED` (key job before closing the day).
12. `Reconciliation` is not in your permissions — if you find a mismatched figure, report it to HEAD/ADMIN.

### 26.2 CHECKER (reviewing approver)

1. `Approvals` → approve at the CHECKER level (check the documents, slips and reasons before pressing) · bulk actions are allowed, but **you must read the result Alert for every item**.
2. `Payment Requests` → `Review` / `Reject` (check the allocation the system proposes; you may only change it within the outstanding amount).
3. Customer file → `Verify identity` / `Reject` (never review work you submitted or uploaded yourself).
4. `Settlements` → approve the agreement and check the ceiling before Post.
5. `Reconciliation` → `Run reconciliation` on schedule, and chase that MISMATCHED items are fixed with an Adjustment.
6. `Hardship Addendums` (`/restructures`) → check the contract's before/after snapshot, the KYC documents of the guarantor/substitute payer, and the collateral cover before approving at the CHECKER level (chapter 18A.4).
7. Work you created yourself must be decided by someone else.

### 26.3 HEAD_APPROVER (head approver)

Does everything CHECKER does, plus: approves at the HEAD level for medium-to-high value documents, views/produces `Monthly Reports`, and interprets work policy (for example a waiver above the reviewer's authority) · **still cannot change global settings in the `Admin` menu**.

Work in this category that "requires the head level only" (other roles cannot press it): `Close` a customer bank account · `Release` a guarantor/substitute payer · `Release` collateral · HEAD-level approval of every addendum (chapters 9A.2, 18A.2-18A.4).

### 26.4 ADMIN (system administrator)

1. `Users`: create/disable/delete/restore accounts, send reset links, change roles.
2. `Admin`: Global thresholds, KYC policy, Password policy, Avatar policy, Repayment collection policy, Collateral policy, Evidence upload policy, email templates, Requeue email — every time you save, check the `CONFIG_UPDATED` audit entry.
3. Approve at the ADMIN level (highest-value documents) and `Reopen review` for KYC work.
4. `Audit Trail`: investigate complaints and export CSV to keep as evidence.
5. Check that pending `APPROVED` work has all been Posted and that `Reconciliation` has no MISMATCHED items left.

### 26.5 VIEWER (read-only user)

- Can view `Dashboard`, `Customers`, `Loan Products`, `Loans` (and Loan Detail), `Transactions`, `Customer Credit`, `Audit Trail`, and their own profile.
- The `Guarantors & Payers`, `Security`, `Hardship Addendums`, `Disbursement & evidence` tabs in Loan Detail **are visible to VIEWER, but the work buttons cannot be pressed** (every action in this category requires OPERATOR_ROLES, so the server returns 403) · the `Hardship Addendums` menu is only hidden — the API `GET /api/restructures` is open for reading to every logged-in role, so you can open the `/restructures` URL directly to see the queue, but you cannot create or apply.
- **There are no create/approve/Post buttons**, and the `Approvals`, `Reconciliation`, `Reports`, `Users`, `Admin` menus are hidden (calling the URL directly also returns 403).
- Use `Ctrl+K` to search for a customer or contract when answering customer questions, and copy data from `Audit Trail` for your supervisor.

---

## 27. End-of-Day / End-of-Month Checklist

**End of day (originator + reviewer)**

- [ ] `Dashboard`: `Pending Payment Requests` and `Pending Approvals` are 0, or the remaining items have a recorded reason.
- [ ] `Transactions` filtered by `Status = APPROVED` → **Post them all**.
- [ ] Today's documents/requests that were `REJECTED` → fix them or create new ones to completion.
- [ ] The cash received matches the POSTED `PAYMENT` records (compare from each contract's `Payment history`).
- [ ] KYC work still submitted and pending → chase the reviewer to verify/reject.
- [ ] Contracts disbursed today: `Channel` + `Transfer reference` recorded and the slip/receipt uploaded (chapter 9A.4).
- [ ] Bank accounts that will be used to receive money next week have at least 1 confirmation proof file (the `proof(s)` column is not 0).

**End of period / end of month (head + Admin)**

- [ ] `Approvals` → InterestRunCard: `Create every charge` for every DECLINING contract (check the dry-run first), then approve + Post.
- [ ] `Charge accrued penalty` for contracts past their grace period.
- [ ] `Reconciliation` → `Run reconciliation` on the whole portfolio → MISMATCHED items must be fixed with an `Adjustment` (approve + Post), then run again until MATCHED.
- [ ] `Monthly Reports` → check the cards and the Window total row, then `Export CSV` and keep it.
- [ ] `Audit Trail` → spot-check the month's waivers / write-offs / adjustments.
- [ ] Check the settings in the `Admin` menu (thresholds / KYC policy) still match this month's resolution.

---

## 28. Common Error → Cause → Fix Table

| Message on screen (EN) | Cause | Fix |
|---|---|---|
| `Session is no longer valid, please sign in again` | The token expired, or the password was just changed/reset | Sign in again |
| `Account is disabled` | Admin suspended the account | Contact Admin |
| `Missing bearer token` / `Invalid or expired token` | You opened an old link, or the token is gone from the device | Sign in again |
| `Requires role: ADMIN` (403) / `Your role cannot decide a HEAD approval step` | Your role is not at that level | Hand it to someone with the right role |
| `Maker-Checker separation: the maker cannot approve their own request` | You created this document yourself | Let someone else approve it (do not try to change the creator) |
| `Maker cannot verify their own payment request (maker-checker separation)` | Same case for a payment request | Have another CHECKER/HEAD/ADMIN review it |
| `Maker-Checker separation: you submitted this KYC and cannot verify it` / `...you uploaded one of these documents...` | You are the submitter or the uploader in that file | A different reviewer is required |
| `Rejection reason is required` | You pressed reject without typing a reason | Type the reason and submit again |
| `This step is not the current level; waiting for ...` | You tried to skip an approval level | Wait for the previous level to approve first |
| `Cannot add penalty to a CLOSED loan` / `Loan is WRITTEN_OFF — penalty can only be charged on an ACTIVE loan` | The contract is not in status `ACTIVE` | Cancel that document · if it was a posting mistake, use an Adjustment |
| `Penalty would exceed the product ceiling: ...` | The accumulated penalty exceeds the product ceiling | Reduce the amount, or let Admin consider changing the product policy (existing contracts do not change) |
| `Only x LAK is due on loan LN-… today (period n / no instalment has arrived yet), but y was requested. Bring the rest as a deposit to credit — the system auto-debits it when the instalment falls due. Next instalment k falls due on YYYY-MM-DD.` | Cash received is more than the instalment due (section 13.1A) | Reduce the amount to `Maximum payable today`, then **create a request of type `Deposit to credit`** for the excess — never edit the amount just to get through, and never Post twice to force it to fit |
| `Settlement payment (x) exceeds the agreed amount (y) plus its early-settlement fee (z)` | The settlement payment is above the payoff price (including the early-settlement fee) | Re-check the slip/amount paid · if the amount is correct, Post the penalty first (see the next row) |
| `Early-settlement fee of x must be approved and posted before the settlement payment — y posted so far` | The early-settlement penalty document for that agreement has not been approved/Posted | Go to `Approvals`, approve the `PENALTY` document linked to the agreement number, then `Post` it in `Transactions` before submitting the settlement payment request (section 18.4) |
| `Settlement payments posted (x) are below what the agreement asks for (total: …)` | You waived the difference before the payoff price was fully paid | Take the payments to completion first, then waive |
| `A posted adjustment already depends on this transaction. Direct reversal is blocked — use the Adjustment Workflow (locked section 11).` | A POSTED ADJUSTMENT references this transaction | Create a new `Adjustment`; do not try to reverse it directly |
| KYC: file-type rejection message (415) / "Only image uploads are supported" | A PDF was submitted or the extension was changed | Convert to JPEG/PNG/WEBP and submit again |
| KYC 409 (duplicate) | This file was already uploaded (matching SHA-256) | Do not submit it again; check the file list in the folder first |
| 413 `configured limit of ... KB` | The file is larger than `maxFileSizeKb` | Shrink the image and submit again |
| Quota full (`maxTotalBytesPerCustomer`) | The customer folder exceeds the configured space | Delete unneeded files (KYC goes back to `PENDING` if reverify is enabled), or ask Admin to raise the quota |
| Disbursement blocked because of KYC | `blockDisbursementUntilVerified` is on | Get KYC to `VERIFIED` (do not switch the policy off to force a pass) |
| `A bank disbursement has to name the receiving account` (422) | The channel was saved as `BANK TRANSFER` but no account was chosen | Choose a customer account (only `ACTIVE` ones are listed) or change the channel to `CASH` (chapter 9A.4) |
| `A cash disbursement cannot carry a bank account` (422) | `CASH` was chosen but an account is still selected | Clear the account from the form before saving |
| `This account is already registered for …` (409) | That account number is already recorded | Use the existing account, or `Set as primary` if you want it to be the main one |
| `Closing an account needs a reason on record` (400) | You pressed `Close` without typing a reason | Type the reason first · only `HEAD_APPROVER`/`ADMIN` may close an account |
| `Bank account is CLOSED — only an ACTIVE one can be closed` / `… a closed one cannot be the primary` (422) | Work attempted on an already-closed account | A closed account is history — register a new number instead |
| `Bank account is CLOSED — money cannot be sent to a closed account` (422) | A closed account was chosen as the receiving channel | Switch to an `ACTIVE` account or to `CASH` |
| `Only image uploads are accepted for evidence documents` / `Image type … is not allowed (allowed: …)` (415) | A PDF or a file type outside the policy was submitted | Convert to JPEG/PNG/WEBP · see the enabled types in `Admin` → Evidence upload policy (chapter 9A.5) |
| `This exact image is already filed here as … — delete it first to re-upload` (409) | The same file (matching SHA-256) is already stored | If you only want to change the frame/crop, `Delete` it and upload again |
| `Evidence storage quota reached for this …` (422) | Above `evidence.maxTotalBytesPerOwner` | Delete old evidence that is not needed, or let Admin raise the quota (do not edit it in order to delete needed records) |
| `Only the uploader or an ADMIN can delete an evidence document` (403) | Someone tried to delete a file a colleague uploaded | Let the uploader or Admin delete it · every deletion is audited |
| `BANK_ACCOUNT_PROOF is filed under a CUSTOMER, not under a LOAN` (422) | The evidence type and the owner do not match | Account proofs go under the customer · slips/receipts go under the contract (chapter 9A) |
| `Loan party is … — only an ACTIVE one can be released` (422) | The guarantor/substitute payer was already released | Check the status in the `Guarantors & Payers` tab first |
| `The borrower is already the payer of their own loan` (422) | The borrower was recorded as their own substitute payer | No need to record one — the borrower is already the primary debtor (chapter 18A.2) |
| `Loan is … — a hardship addendum rewrites a live contract` (422) | The contract is not `ACTIVE` | A closed/written-off contract cannot be amended (chapter 18A.4) |
| `Collateral check failed — …` (422) | Cover below the threshold / stale valuation / no collateral | `Cover right now` states the reasons item by item · add collateral or fix the valuation (chapters 18A.3, 24.7) |
| `A restructured term cannot exceed 600 months` (422) | The extension exceeds the system ceiling | Splitting into several addenda does not help — reconsider the principal amount or a write-off |
| `Addendum … has already been applied` (409) | `Apply` was pressed again | The document is already used; do not create duplicates to move the figures · use an Adjustment instead |
| 400 `Validation failed` | The form is malformed or out of range | Read the message under that field and submit again |
| 422 naming a field the user did not fill in (for example `maxFileSizeKb must be between 1 and 102400`) | A global value in the database is out of range (set outside the system) | Send that field's value along to correct it, or let Admin check it in the KYC policy menu |
| OTP does not arrive, or does not work | The delay window passed, or retries reached until status `DEAD` | Wait a moment and request a new lot, or let Admin send a reset link |

Principle: **the system never edits values by itself, and there is no way to "skip" a rule.** Every error has an outlet in the form of a document or the correct global setting. If you are genuinely stuck, collect the screen + `referenceNo` + time and send it to Admin.

---

## 29. Do-Not / Do Practices

**Do not**

- Do not share accounts or passwords (every audit entry is tied to the account actually in use).
- Do not edit the database or tables directly, and do not ask IT to change figures — use `Adjustment` or an in-system document only.
- Do not switch off policies (`blockDisbursementUntilVerified`, `requireSignature`, lowering an approval level) to let work pass without written approval.
- Do not type a full bank account number in `Note` or `Reason` — every channel in the system shows only the last 4 digits; free text should not differ from that.
- Do not delete financial evidence (slips, account confirmation letters) before a replacement file exists — evidence is immutable, so a deletion is immediately a hole in the audit.
- Do not change a contract's `Channel` to escape the search for a slip (BANK → CASH) — record the channel the money actually travelled by.
- Do not use a restructuring document (addendum) instead of Posting a document — `APPROVED` has not yet amended the contract, and `Apply` can be done only once per document.
- Do not approve work you created yourself (the system already blocks it; do not look for a workaround).
- Do not Post a document whose real evidence (slip, contract, KYC documents) has not been checked.
- Do not store or forward OTPs / password reset links as plain text or screenshots.
- Do not use test accounts (`test_*`) or mock data in the production environment — test data must be cleared and test accounts deleted before going live.

**Do**

- Type account numbers as one continuous string with no spaces, and reference the account holder's name only as it appears on the passbook copy.
- Write the `Reason` on every document so that "someone who was not in the room can understand it" (who, did what, why, referencing what).
- Look at the Preview (allocation / interest) before every submission.
- Clear `APPROVED` work so that everything is Posted before the day closes, so report figures are not skewed.
- When a document is rejected, read the reason before creating a new one; do not just press again.
- After changing a global setting, check the `CONFIG_UPDATED` audit entry (it shows the old/new checksum) and keep a screenshot as evidence.
- Review staff permissions monthly — on transfer/departure, suspend the account immediately.

---

## 30. Appendix A: All Statuses and Enum Values

| Value set | Values in use |
|---|---|
| Role | `ADMIN`, `HEAD_APPROVER`, `CHECKER`, `MAKER`, `VIEWER` |
| Loan contract status | `ACTIVE`, `CLOSED`, `WRITTEN_OFF` |
| Financial document status | `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `POSTED`, `REJECTED` |
| Payment request status | `PENDING`, `APPROVED`, `REJECTED` |
| Received-amount type (purpose of the request) | `PAY_DEBT` (applies to debt that is due), `DEPOSIT_TO_CREDIT` (deposited to credit; not applied to debt) |
| Machine account used for automatic deductions | `system.auto-debit` (userAgent `auto-debit-job`) — visible in Approvals/Transactions/Audit |
| Workflow status / approval step | `PENDING`, `APPROVED`, `REJECTED` (layers: CHECKER, HEAD, ADMIN) |
| Settlement agreement status | `PENDING_APPROVAL`, `APPROVED`, `REJECTED` |
| Customer KYC status | `NOT_VERIFIED`, `PENDING`, `VERIFIED`, `REJECTED` |
| KYC document type | `NATIONAL_ID`, `ID_CARD`, `PASSPORT`, `FAMILY_BOOK`, `SELFIE_WITH_ID`, `SIGNATURE` (variant `MAIN`, `FRONT`, `BACK`) |
| Installment status | `PENDING`, `DUE`, `PARTIAL`, `OVERDUE`, `PAID` |
| Interest calculation method | `FLAT`, `DECLINING` |
| Penalty mode | `NONE`, `PERCENT_OF_OVERDUE`, `FIXED_PER_PERIOD` |
| Financial document type (key types) | `DISBURSEMENT`, `PAYMENT`, `SETTLEMENT_PAYMENT`, `PENALTY`, `INTEREST_ACCRUAL`, `WAIVER`, `WRITE_OFF`, `WRITE_OFF_REVERSAL`, `REVERSAL`, `ADJUSTMENT` |
| Currency | `LAK` (2 decimal places, DECIMAL 18,2) |
| Time units | day(1), week(7), month(30), year(365) |
| Customer bank account status (`BankAccountStatus`) | `ACTIVE`, `CLOSED` |
| Evidence owner (`EvidenceOwnerType`) | `CUSTOMER`, `LOAN` (always taken from the URL) |
| Evidence kind (`EvidenceKind`) | `BANK_ACCOUNT_PROOF` (under a customer), `DISBURSEMENT_SLIP` (under a contract) |
| Disbursement channel (`DisbursementChannel`) | `BANK`, `CASH`; if never recorded, it is shown as `Not recorded` |
| Third-party role on a contract (`LoanPartyRole`) | `GUARANTOR` (guarantor), `PAYER` (payer on behalf of the customer) |
| Third-party status (`LoanPartyStatus`) | `ACTIVE`, `RELEASED` |
| Collateral type (`CollateralType`) | `LAND`, `BUILDING`, `VEHICLE`, `DEPOSIT`, `EQUIPMENT`, `GOLD`, `OTHER` |
| Collateral status (`CollateralStatus`) | `PLEDGED`, `RELEASED` |
| Item a restructuring document asks to change (`RestructureChangeType`) | `INTEREST_RATE_REDUCTION`, `TERM_EXTENSION`, `PAYER_CHANGE`, `INTEREST_RELIEF` (several may be selected together) |
| Restructuring document status (`RestructureStatus`) | `PENDING_APPROVAL`, `APPROVED`, `REJECTED`, `APPLIED` — `APPROVED` does not yet change the contract; it must reach `APPLIED` |
| KYC status labels for a guarantor/payer (UI side) | `No action needed`, `Upload documents`, `Send for review`, `Awaiting review`, `Re-upload and submit again` |
| Notification event type (`NotificationEventType`) | 26 values — see the full table in chapter 25 |

---

## 31. Appendix B: API List and Permissions (for the IT team)

All routes sit under `/api` and pass through token-verification middleware first (except the public routes noted). Reference `server/src/app.ts:38-61`. Customer and loan routes are bound to the owner in the URL: `/api/customers/:customerId/{kyc,bank-accounts,evidence}` and `/api/loans/:loanId/{parties,collaterals,evidence}`; the owner always comes from the path, never from the body

| Module | Route | Permissions |
|---|---|---|
| auth | `POST /api/auth/login`, `/forgot-password`, `/verify-otp`, `/reset-password` | public (with cooldown and rate limiting) |
| auth | `GET /api/auth/me`, `GET /api/auth/password-policy` | any logged-in role |
| users | `GET/POST /api/users`, `PATCH/DELETE /api/users/:id`, `POST /:id/restore`, `/:id/send-reset-link`, `/send-reset-links` | `ADMIN` |
| users (self) | `GET/PATCH /api/users/me`, `POST /api/users/me/password`, `GET/PUT/DELETE /api/users/:id/avatar` | the account owner, or `ADMIN` (avatar) |
| config | `GET /api/config/{thresholds,kyc,password,avatar,payment,collateral,evidence}`, `PUT /api/config/{...same list}` | GET: any role; PUT: `ADMIN` |
| config (auto-debit) | `POST /api/config/payment/auto-debit/run` — body `{loanId?, asOf?, dryRun?}`; `dryRun:true` is read-only and creates no documents | `ADMIN` |
| audit | `GET /api/audit` | all roles |
| customers | `GET /api/customers` (each row carries `borrowings` = the products this customer is currently borrowing under or has borrowed under), `GET /:id` all roles; `POST /api/customers` | OPERATOR_ROLES |
| kyc | `GET /documents`, `GET /documents/:id/content` | all roles (read) |
| kyc | `POST /documents`, `DELETE /documents/:id`, `POST /submit` | OPERATOR_ROLES |
| kyc | `POST /verify`, `POST /reject` | CHECKER, HEAD_APPROVER, ADMIN |
| kyc | `POST /reopen` | ADMIN |
| loan-products | `GET /api/loan-products` | all roles |
| loan-products | `POST /api/loan-products`, `PATCH /:id` | ADMIN |
| loans | `GET /api/loans`, `/:id`, `/:id/allocation-preview`, `/:id/schedule`, `/:id/payable-now` (installments due plus the maximum amount that can be accepted today) | all roles |
| loans | `POST /api/loans` (create + disburse; optional `disbursementChannel`, `disbursementBankAccountId`, `disbursementReference`) | OPERATOR_ROLES |
| loans (payment channel) | `PATCH /api/loans/:id/disbursement` — `{channel, bankAccountId?, reference? (≤64)}` does not move any balance and needs no approval | OPERATOR_ROLES |
| bank-accounts | `GET /api/customers/:customerId/bank-accounts` (`?status=ACTIVE`), `POST /` to register an account | GET: all roles; POST: OPERATOR_ROLES |
| bank-accounts | `POST /:accountId/close` (a reason is required), `POST /:accountId/primary` | close: HEAD_APPROVER, ADMIN; primary: OPERATOR_ROLES |
| evidence | `GET /api/customers/:customerId/evidence`; `GET /api/loans/:loanId/evidence` (returns `documents` + `policy` + `policyText`), `GET /:documentId/content` | all roles (read) |
| evidence | `POST /` (multipart: `kind` + file), `DELETE /:documentId` | OPERATOR_ROLES; deletion only by the uploader themselves or `ADMIN` |
| parties | `GET /api/loans/:loanId/parties`, `POST /` (register a guarantor/payer), `POST /:partyId/release` | GET: all roles; POST: OPERATOR_ROLES; release: HEAD_APPROVER, ADMIN |
| collaterals | `GET /api/loans/:loanId/collaterals`, `GET /coverage`, `POST /`, `POST /:collateralId/release` | same as parties |
| restructures | `GET /api/restructures` (`?loanId=`), `GET /context/:loanId`, `GET /:id` all roles; `POST /`, `POST /:id/apply`, `POST /proposed-payer/:loanId` | OPERATOR_ROLES; approval goes through the shared queue `PATCH/POST /api/approvals/steps/:stepId/decision` |
| payment-requests | `GET /`, `/:id`, `/pending-count` | all roles |
| payment-requests | `POST /`, `POST /:id/resubmit` | OPERATOR_ROLES |
| payment-requests | `POST /:id/approve`, `POST /:id/reject` | CHECKER, HEAD_APPROVER, ADMIN |
| transactions | `GET /`, `GET /interest/due`, `GET /:id` | all roles |
| transactions | `POST /:id/post`, `/reversals`, `/penalties`, `/penalties/accrue`, `/interest/accrue`, `/waivers`, `/write-offs`, `/write-off-reversals`, `/adjustments` | OPERATOR_ROLES |
| approvals | `GET /workflows/:id` | all roles |
| approvals | `GET /pending`, `POST /steps/:stepId/decision`, `POST /steps/bulk-decision` | CHECKER, HEAD_APPROVER, ADMIN |
| settlements | `GET /`, `GET /:id`, `GET /early-settlement-fee/:loanId` (how much it costs to close the debt today) | all roles |
| settlements | `POST /`, `POST /:id/settlement-payment`, `POST /:id/waive-shortfall` | OPERATOR_ROLES |
| credits | `GET /api/credits`, `GET /ledger` | all roles |
| reconciliation | `GET /records`, `GET /records/:id` | all roles |
| reconciliation | `POST /run` | OPERATOR_ROLES |
| reports | `GET /api/reports/monthly` | ADMIN, HEAD_APPROVER (the whole router) |
| dashboard | `GET /api/dashboard/stats`, `GET /recent-activity` | all roles |
| notifications | `GET /summary` | all roles |
| notifications | `GET /templates`, `PATCH /templates/:id`, `GET /`, `POST /:id/requeue` | ADMIN |

Standard response codes: `401` (session), `403 Forbidden` / `Requires role: ...`, `404`, `409` (conflict/duplicate), `413` (file size), `415` (file type), `422` (business rules), `400` (validation) — for the full description see the table in chapter 28

---

### Document Maintenance

This document was derived from the actual code behavior (`server/src`, `web/src`). Whenever business rules, configuration values, or role permissions change, the manual must be updated in the same change, especially chapters 2, 3, 24, and 28. If any statement in the manual does not match the screen, treat the **screen and the API responses as the source of truth** and notify the administrator so the configuration can be checked.
