# Loan Management System — Locked Requirements
## React.js + Node.js + TypeScript

> Purpose: This document is the baseline requirement for an AI/development team to build the Loan Management System.
>
> **Important:** Requirements marked as "LOCKED" must not be changed unless a new business requirement or a real conflict is identified and explicitly approved.

---

# 1. Technology Stack

## Frontend
- React.js
- TypeScript
- Recommended: React Router
- Recommended: React Query / TanStack Query for server state
- Form validation: Zod or equivalent
- UI component library can be selected during implementation

## Backend
- Node.js
- TypeScript
- REST API
- Recommended framework: NestJS or Express
- Database ORM: Prisma or TypeORM
- Database: PostgreSQL recommended

## General Engineering Requirements
- Strong typing with TypeScript
- Financial transactions must be auditable
- Do not update financial truth by directly editing balances
- Use transaction IDs and immutable financial transaction records
- All important state changes require audit trail
- Financial posting must be atomic

---

# 2. Core Financial Principles — LOCKED

## 2.1 Posted Transaction Is Financial Truth

Only a **POSTED financial transaction** may change:
- Loan outstanding
- Payment allocation
- Loan financial balance
- Loan closure/reopen state when driven by financial truth

The following must NOT change financial outstanding:
- Pending payment request
- Rejected payment request
- Unapproved reversal
- Unapproved waiver
- Settlement agreement by itself
- Draft transactions

---

# 3. Loan Outstanding — LOCKED

Use a hybrid model:

### Operational Balance
Store `currentOutstanding` on the Loan record for normal operational use.

### Transaction History
Financial transaction history is the source for:
- Audit
- Reconciliation
- Investigation

Do **not** recalculate the loan balance from the entire transaction history on every request.

### Reconciliation
The system must provide a reconciliation process comparing:
- Current operational outstanding
- Posted financial transaction history

If a mismatch occurs:
- Do not directly edit the outstanding to force a match.
- Identify the root cause.
- Correct through an approved adjustment transaction with audit trail.

---

# 4. Payment Request Lifecycle — LOCKED

## Lifecycle

```text
Payment Request
    ↓
PENDING
    ↓
Verify money received
    ↓
APPROVE
    ↓
Create Payment Transaction
    ↓
POST
    ↓
Payment Allocation
    ↓
Update Outstanding
```

## Rejection

If rejected:

```text
Payment Request
    ↓
REJECTED
```

Then:
- No Payment Transaction is created.
- Loan outstanding is not changed.
- No payment allocation occurs.
- Rejection reason must be stored.
- Original request must remain immutable for audit.

## Resubmission — LOCKED

If a rejected request is submitted again:

- Create a NEW Payment Request.
- New request gets a new ID.
- Link the new request to the previous rejected request.
- Do not edit or overwrite the rejected request.
- Preserve the original rejection reason.
- New request follows the normal lifecycle.

---

# 5. Payment Allocation — LOCKED

## Default Allocation Order

```text
1. Penalty
2. Past Interest
3. Past Principal
```

This is the global system default.

Do not introduce Loan Product-level allocation configuration in the first phase.

Future product-level configuration may be added if a real business requirement appears.

## Partial Payment

Payment can continue across components sequentially.

Example:

```text
Penalty = 100,000
Past Interest = 800,000
Past Principal = 1,000,000

Payment = 150,000
```

Result:

```text
Penalty paid = 100,000
Past Interest paid = 50,000
Past Principal paid = 0
```

The system does not move to the next component until the current component is fully satisfied.

---

# 6. Overpayment — LOCKED

If the customer pays more than the amount currently required:

Example:

```text
Required = 100,000 LAK
Received = 102,000 LAK
```

The system must:

```text
Payment allocation = 100,000
Customer credit = 2,000
```

Default behavior:
- Store excess as customer credit.
- Use the credit for a future payment.

Do NOT automatically:
- Refund
- Apply excess to principal early

Refund or early principal payment may be added later through explicit business policy.

---

# 7. Staff Allocation Override — LOCKED

The system automatically proposes the default allocation.

Authorized staff may adjust allocation amounts.

However:

- Allocation must not exceed actual payment amount.
- Allocation must not exceed outstanding amount.
- Hard validation is required.
- If allocation exceeds payment or outstanding, the system must reject immediately.
- No warning-only mode.
- No override approval to bypass this validation.

If an already-posted transaction needs correction:
- Do not edit the original payment.
- Use adjustment/reversal workflow.

---

# 8. Payment Posting Atomicity — LOCKED

Payment posting is a financial transaction.

The following must succeed as one atomic database transaction:

```text
POST Payment
+
Create Allocation
+
Update Loan Outstanding
+
Create Financial Transaction History
```

If any required step fails:

```text
ROLLBACK EVERYTHING
```

No partial financial posting is allowed.

Recovery/reconciliation mechanisms may exist for technical exceptions after commit, but they do not replace atomic posting.

---

# 9. Payment Reversal — LOCKED

A reversal must always be a NEW transaction.

Never edit the original payment.

## Normal Reversal

```text
Original Payment
      ↓
Reversal Request
      ↓
Approval Workflow
      ↓
Reversal Transaction
      ↓
POST
      ↓
Reverse Original Allocation
      ↓
Increase Outstanding
```

Requirements:
- Separate reversal transaction ID
- Reference original payment ID
- Approval workflow
- Complete audit trail
- Original payment remains immutable

---

# 10. Partial Reversal — LOCKED

Partial reversal must reverse according to the **original allocation order sequentially**.

Do NOT use pro-rata allocation.

Do NOT allow staff to manually select components.

Example:

Original allocation:

```text
Penalty       = 300,000
Past Interest = 200,000
Principal     = 200,000
```

If reversing `100,000`:

```text
Reverse Penalty = 100,000
```

If reversal amount is large enough to exhaust the original Penalty, continue sequentially into:

```text
Past Interest
then Principal
```

The reversal must follow the original allocation sequence exactly.

---

# 11. Reversal With Downstream Transactions — LOCKED

Do not recalculate historical allocation based on the current balance.

If the original allocation has no downstream financial transaction that prevents direct reversal:

- Reverse according to the original allocation.

If downstream transactions already depend on the original payment/allocation and direct reversal would create inconsistency:

- Do NOT directly reverse the payment.
- Use a separate Adjustment Workflow.
- Adjustment requires approval.
- Adjustment requires audit trail.
- Original transactions remain immutable.

This is a hybrid reversal rule.

---

# 12. Reversal Approval Threshold — LOCKED

Use one global approval threshold configuration across the system.

Initial example:

| Amount | Approval |
|---|---|
| ≤ 1,000,000 LAK | Maker → Checker |
| > 1,000,000 to 10,000,000 LAK | Maker → Checker → Head Approver |
| > 10,000,000 LAK | Maker → Checker → Head → Admin Final Approval |

Thresholds must be centrally configurable.

They must not be independently configured by different modules.

## Admin Final Approval

For reversal > 10,000,000 LAK:

- Admin MUST approve as the final approval step.
- System must NOT post before Admin approval.
- Admin rejection stops the transaction.
- Audit trail must record:
  - Admin user ID
  - Approval time
  - Approval decision

---

# 13. Reversal and Outstanding — LOCKED

When a reversal is POSTED:

```text
Loan Outstanding increases by the reversed financial amount.
```

The increase follows the reversed original allocation.

Do not use an adjustment instead of a normal reversal when a normal reversal is valid.

---

# 14. Loan Closure — LOCKED

A Loan may become `CLOSED` only when:

```text
ALL payable outstanding components = 0
```

Do not check Principal only.

For example:

```text
Principal = 0
Interest = 0
Penalty = 0
```

Then the loan can be closed.

But:

```text
Principal = 0
Interest > 0
```

or:

```text
Principal = 0
Penalty > 0
```

means the loan must NOT be closed.

## Manual Status Change

Staff must NOT directly change:

```text
ACTIVE → CLOSED
```

Closure must be driven by posted financial truth.

Examples of transactions that may lead to closure:
- Posted Payment
- Posted Waiver
- Posted Settlement-related financial transaction
- Approved/Post adjustment
- Other approved financial transaction that legitimately reduces all outstanding to zero

---

# 15. Loan Reopen After Payment Reversal — LOCKED

If a loan is:

```text
CLOSED
```

and a posted reversal causes:

```text
Outstanding > 0
```

then:

```text
CLOSED → ACTIVE
```

automatically.

Staff cannot manually change the status.

If reversal is posted but:

```text
Outstanding = 0
```

then:

```text
CLOSED remains CLOSED
```

---

# 16. Settlement — LOCKED

Settlement Agreement must be separated from Financial Transactions.

A Settlement Agreement itself does NOT reduce outstanding.

Only posted financial transactions affect financial truth.

Example:

```text
Outstanding = 1,000,000 LAK
Settlement Agreement = 700,000 LAK
Customer Payment = 700,000 LAK
```

The posted payment reduces outstanding by 700,000.

Remaining:

```text
300,000 LAK
```

The 300,000 must NOT disappear simply because the settlement was approved.

If the 300,000 is to be forgiven:

```text
Create separate Waiver Transaction
        ↓
Approval Workflow
        ↓
POST
        ↓
Outstanding reduction
```

Settlement Agreement and Waiver Transaction must remain separate for accounting and audit purposes.

---

# 17. Penalty Waiver — LOCKED

Penalty Waiver supports:

- Partial waiver
- Full waiver (100%)

Do not create Loan Product-specific waiver policy in the first phase.

Future product-level configuration may be added if business requirements require it.

## Waiver Data Model Principle

Never overwrite the original penalty.

Example:

```text
Original Penalty = 100,000
Waiver = 30,000
Outstanding Penalty = 70,000
```

Store:

```text
Original Penalty Transaction = 100,000

Penalty Waiver Transaction = 30,000
```

The system calculates outstanding automatically.

## Waiver Requirements

Every waiver:
- Is a separate transaction
- Has its own transaction ID
- Uses approval workflow
- Has complete audit trail
- Preserves original penalty transaction
- Supports full 100% waiver

---

# 18. Write-off — LOCKED BASE RULES

Write-off must be clearly separated from:

- Payment
- Settlement
- Waiver
- Reversal

## Write-off Status

Use a separate loan status:

```text
WRITTEN_OFF
```

Do NOT treat:

```text
WRITTEN_OFF == CLOSED
```

They are different business states.

Write-off must have separate reporting and accounting treatment.

It must not appear as a normal Payment or Waiver.

## Write-off Reversal

Write-off reversal:
- Must be a separate transaction.
- Must not edit the original write-off.
- Requires approval workflow.
- Requires complete audit trail.
- Must have clear reporting separation.

If a posted Write-off Reversal creates outstanding > 0:

```text
WRITTEN_OFF → ACTIVE
```

automatically.

Staff cannot manually change this status.

If posted reversal leaves outstanding = 0:

```text
WRITTEN_OFF remains WRITTEN_OFF
```

---

# 19. Important State Principles — LOCKED

Financial truth drives state.

Example:

```text
Pending Payment
    ≠ Financial Truth

Rejected Payment
    ≠ Financial Truth

Approved but not Posted
    ≠ Financial Truth

Posted Payment
    = Financial Truth
```

Loan status changes must be based on posted financial results.

---

# 20. Audit Trail — LOCKED

All financial actions must be traceable.

At minimum capture:

- Transaction ID
- Transaction type
- Loan ID
- Customer ID
- Previous status
- New status
- Previous relevant balance
- New relevant balance
- Amount
- Currency
- Maker user ID
- Checker user ID
- Head approver user ID when applicable
- Admin user ID when applicable
- Action timestamp
- Approval timestamp
- Rejection timestamp
- Reason
- Reference/original transaction ID
- Related transaction ID
- Source/request ID
- IP/device/session information where appropriate

Original financial transactions must be immutable.

---

# 21. Approval Workflow — LOCKED

Generic financial approval pattern:

```text
Maker
  ↓
Checker
  ↓
Head Approver
  ↓
Admin Final Approval (when threshold requires)
  ↓
POST
```

The exact number of levels depends on the globally configured threshold.

Approval is not the same as posting.

An approved transaction must still pass posting validation before becoming financial truth.

---

# 22. Financial Transaction State Model

Recommended generic state:

```text
DRAFT
  ↓
PENDING_APPROVAL
  ↓
APPROVED
  ↓
POSTED
```

Alternative terminal state:

```text
REJECTED
```

Invalid financial states must not affect outstanding.

Only:

```text
POSTED
```

may affect financial truth.

---

# 23. Suggested Core Entities

The initial database design should consider at least:

```text
Customer
Loan
LoanProduct
LoanAccount / LoanBalance
PaymentRequest
PaymentTransaction
PaymentAllocation
PenaltyTransaction
PenaltyWaiverTransaction
SettlementAgreement
SettlementTransaction
WriteOffTransaction
WriteOffReversalTransaction
ReversalTransaction
AdjustmentTransaction
ApprovalWorkflow
ApprovalStep
AuditLog
CustomerCredit
FinancialTransaction
FinancialTransactionLine
ReconciliationRecord
```

The final schema should be normalized appropriately and use immutable transaction records.

---

# 24. Recommended Transaction Architecture

Prefer a common financial transaction model:

```text
FinancialTransaction
    ├── Payment
    ├── Payment Reversal
    ├── Penalty
    ├── Penalty Waiver
    ├── Settlement Payment
    ├── Write-off
    ├── Write-off Reversal
    └── Adjustment
```

Each transaction should have:

```text
id
loanId
customerId
transactionType
status
amount
currency
referenceTransactionId
sourceRequestId
createdBy
postedBy
createdAt
approvedAt
postedAt
```

Transaction-specific detail tables can hold additional fields.

---

# 25. End-to-End Validation Matrix — BEFORE DATABASE FINALIZATION

Before final database design, validate these scenarios:

## Payment
- Approved payment
- Rejected payment
- Resubmitted payment
- Partial payment
- Full payment
- Overpayment
- Staff allocation override
- Allocation exceeds payment → hard reject

## Reversal
- Full reversal
- Partial reversal
- Reversal approval
- Reversal rejection
- Reversal > 10M LAK → Admin final approval
- Reversal with downstream transaction
- Adjustment workflow

## Loan Status
- Outstanding > 0 → ACTIVE
- All outstanding = 0 → CLOSED
- Closed + reversal creates outstanding > 0 → ACTIVE
- Closed + reversal leaves outstanding = 0 → CLOSED
- Written-off + reversal creates outstanding > 0 → ACTIVE
- Written-off + reversal leaves outstanding = 0 → WRITTEN_OFF

## Settlement
- Settlement agreement only
- Settlement + payment
- Settlement with waiver
- Settlement payment posted
- Waiver posted separately

## Write-off
- Full write-off
- Partial write-off
- Write-off status
- Write-off reversal
- Write-off reversal with outstanding
- Write-off reporting separation

## Waiver
- Partial waiver
- Full 100% waiver
- Waiver approval
- Waiver rejection
- Original transaction remains unchanged

---

# 26. Critical Invariants

The system must enforce these invariants:

1. Pending/rejected transactions never change financial outstanding.
2. Only posted financial transactions change financial truth.
3. Original financial transactions are immutable.
4. Reversal is always a new transaction.
5. Partial reversal follows original allocation sequentially.
6. No pro-rata reversal.
7. Staff cannot select reversal components manually.
8. Allocation cannot exceed payment amount.
9. Allocation cannot exceed outstanding.
10. Payment posting is atomic.
11. Settlement Agreement does not itself reduce outstanding.
12. Settlement shortfall requires a separate Waiver Transaction if it is forgiven.
13. Loan closes only when every payable outstanding component is zero.
14. Closed loan automatically reopens when a posted reversal creates outstanding > 0.
15. Written-off is a distinct status from Closed.
16. Write-off reversal is a separate transaction.
17. All important financial actions have audit trails.
18. Financial corrections use adjustment/reversal transactions rather than editing history.
19. Global approval thresholds are centrally configured.
20. Reconciliation must detect inconsistencies between operational balances and posted transaction history.

---

# 27. Implementation Guidance for AI Coding Agent

Build in this order:

### Phase 1 — Foundation
- Project structure
- Authentication/authorization
- User/role model
- Loan Product
- Customer
- Loan

### Phase 2 — Financial Core
- Financial Transaction
- Transaction status
- Posting engine
- Atomic database transaction
- Audit log

### Phase 3 — Payment
- Payment Request
- Approval workflow
- Payment posting
- Allocation engine
- Customer credit
- Overpayment

### Phase 4 — Reversal
- Full reversal
- Partial sequential reversal
- Reversal approval
- Downstream transaction validation
- Adjustment workflow

### Phase 5 — Loan Lifecycle
- Outstanding
- Closure engine
- Reopen engine
- Status transitions
- Reconciliation

### Phase 6 — Settlement
- Settlement Agreement
- Settlement payment
- Waiver transaction for settlement shortfall

### Phase 7 — Waiver
- Penalty waiver
- Partial/full waiver
- Approval workflow
- Audit trail

### Phase 8 — Write-off
- Write-off transaction
- WRITTEN_OFF status
- Write-off reversal
- Auto reopen rules
- Reporting separation

### Phase 9 — Validation
- End-to-end scenario matrix
- Unit tests
- Integration tests
- Transaction/rollback tests
- Approval workflow tests
- Reconciliation tests
- Audit trail tests

---

# 28. Explicit Non-Goals for First Phase

Do NOT implement unless a new requirement is approved:

- Loan Product-specific payment allocation policies
- Loan Product-specific penalty waiver policies
- Automatic refund for overpayment
- Automatic principal prepayment from overpayment
- Pro-rata reversal
- Manual component selection during reversal
- Direct staff editing of posted financial transactions
- Direct staff editing of Loan status
- Recalculating outstanding from full transaction history on every request

These may be future extensions, not first-phase behavior.

---

# 29. Definition of Done

The first implementation is considered functionally aligned when:

- All locked rules are implemented.
- All financial postings are atomic.
- Pending/rejected transactions do not affect balances.
- Posted transactions correctly affect balances.
- Allocation follows the locked order.
- Reversal follows original allocation sequentially.
- Settlement and Waiver are separate.
- Write-off has its own status.
- Closure and reopen are automatically driven by financial truth.
- Approval thresholds work globally.
- Audit trail is complete.
- Reconciliation is available.
- End-to-end validation matrix passes.
- No original financial transaction is overwritten.

---

# 30. Final Locked Flow

```text
Customer
   ↓
Payment Request
   ↓
Pending
   ↓
Verify
   ├── Reject → End / New Request for Resubmission
   │
   └── Approve
          ↓
      Payment Transaction
          ↓
        POST
          ↓
   Payment Allocation
   Penalty
      ↓
   Past Interest
      ↓
   Past Principal
          ↓
   Update Outstanding
          ↓
   Closure Check
      ├── Outstanding > 0 → ACTIVE
      └── All Outstanding = 0 → CLOSED

If Reversal:
   ↓
New Reversal Transaction
   ↓
Approval Workflow
   ↓
POST
   ↓
Reverse Original Allocation Sequentially
   ↓
Increase Outstanding
   ↓
Status Check
   ├── Outstanding > 0 → ACTIVE
   └── Outstanding = 0 → CLOSED

If Write-off:
   ↓
Write-off Transaction
   ↓
POST
   ↓
WRITTEN_OFF
   ↓
Write-off Reversal
   ↓
Approval Workflow
   ↓
POST
   ↓
If Outstanding > 0 → ACTIVE
If Outstanding = 0 → WRITTEN_OFF
```

---

## Important Instruction to AI Developer

Treat this document as the current **source of truth for business requirements**.

Do not silently invent new financial rules.

If implementation exposes a conflict:
1. Identify the exact conflicting requirements.
2. Stop and present the conflict.
3. Do not choose a business rule automatically.
4. Ask for a decision.
5. Update the requirement only after approval.

The primary goals are:
- Financial correctness
- Auditability
- Immutable transaction history
- Reconciliation
- Atomic posting
- Clear loan lifecycle
- Safe reversal
- Clear accounting separation
- Extensibility for future Loan Product configuration
