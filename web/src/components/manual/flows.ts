import type { FlowSpec, NodeKind } from './FlowDiagram';

/** Which edition of the manual the operator is reading — the same key selects the flow sheets. */
export type ManualEdition = 'en' | 'th';

/**
 * The four sheets the manual points at, keyed first by the manual edition and then by the chapter number
 * used in both `USER-MANUAL-EN.md` and `USER-MANUAL-TH.md` (## 11, ## 13 …) rather than by heading text,
 * so rewording a chapter never silently drops its picture. Every box states the screen name the operator
 * actually sees plus the rule behind it, in the language of the edition being read.
 */

const LEGEND_TH: Record<NodeKind, string> = {
  step: 'ขั้นตอนที่ผู้ใช้กด',
  gate: 'กฎที่ระบบบล็อก (แก้จากหน้าจอไม่ได้)',
  money: 'จุดที่เงินขยับจริงใน ledger',
  stop: 'ผลเมื่อไม่ผ่านเงื่อนไข',
  end: 'สถานะที่ได้หลังจบขั้นตอน',
};

const LEGEND_EN: Record<NodeKind, string> = {
  step: 'What the operator does',
  gate: 'A rule the system enforces (not changeable on screen)',
  money: 'Where money actually moves in the ledger',
  stop: 'What happens when the condition is not met',
  end: 'The state reached when the step finishes',
};

const FLOWS_EN: Record<string, FlowSpec> = {
  '11': {
    heading: 'Figure 1 — The life of one loan contract: from pressing New to the day it closes',
    caption:
      'Read top to bottom: the left column is the main story, the right column is the effect the system forces. Orange = the point where the system blocks, green = the point where money really moves in the ledger',
    legend: LEGEND_EN,
    rows: [
      {
        main: {
          kind: 'step',
          title: 'MAKER presses “New loan”',
          sub: 'Choose customer · product · principal · term · disbursement date',
        },
      },
      {
        main: {
          kind: 'step',
          title: 'The system attaches an approval queue based on the amount',
          sub: 'The number of decision tiers comes from the central values in the Admin menu (see Figure 4)',
        },
      },
      {
        main: {
          kind: 'gate',
          title: 'Maker–Checker: the creator cannot approve their own document',
          sub: 'Whoever raised the document is excluded from every tier of this queue',
        },
        side: {
          kind: 'stop',
          title: 'MAKER approves their own document → 403',
          sub: 'Hand it on to a CHECKER or a HEAD',
          label: 'If you try to approve it yourself',
        },
      },
      {
        main: {
          kind: 'step',
          title: 'All tiers approved → status APPROVED',
          sub: 'No money has moved at all — a separate Post is still required',
        },
      },
      {
        main: {
          kind: 'gate',
          title: 'Gate before disbursement: the customer KYC status',
          sub: 'Central value blockDisbursementUntilVerified = on → the customer must be VERIFIED',
        },
        side: {
          kind: 'stop',
          title: 'Not verified → the loan cannot be disbursed',
          sub: 'Upload or verify the evidence in the KYC menu first',
          label: 'If KYC has not passed yet',
        },
      },
      {
        main: {
          kind: 'money',
          title: 'Press “Disburse” → the principal enters the ledger',
          sub: 'FLAT: the interest for the whole contract is billed once · DECLINING: only the first period is billed, later periods accrue interest receivable',
        },
      },
      {
        main: {
          kind: 'end',
          title: 'The contract is ACTIVE with its instalment schedule',
          sub: 'The product penalty policy is frozen onto the contract on disbursement day',
        },
      },
    ],
  },

  '13': {
    heading: 'Figure 2 — Receiving a repayment: periods that have arrived · credit · auto-debit',
    caption:
      'The heart of it is the second row: the system accepts only what has already fallen due. Anything received above that is kept as customer credit, and auto-debit draws it against a period when the time comes',
    legend: LEGEND_EN,
    rows: [
      {
        main: {
          kind: 'step',
          title: 'MAKER presses “New payment request”',
          sub: 'Choose the contract · the amount to receive · the receipt date · a note',
        },
      },
      {
        main: {
          kind: 'gate',
          title: 'Checks the boundary of the periods that have already arrived',
          sub: 'Maximum payable today = min(amount due, outstanding in the ledger)',
        },
        side: {
          kind: 'stop',
          title: 'Not one period has arrived → 422 “no instalment has arrived yet”',
          sub: 'Penalty or interest cannot be booked ahead of schedule — that is a system rule',
          label: 'If you try to pay before a period is due',
        },
      },
      {
        main: {
          kind: 'step',
          title: 'Still want to take the money now → choose “Deposit to credit”',
          sub: 'The money goes to the customer credit, cuts no period, and leaves no instalment current',
        },
      },
      {
        main: {
          kind: 'step',
          title: 'CHECKER / HEAD approve the request',
          sub: 'Once approved the document is APPROVED — the money has still not moved',
        },
      },
      {
        main: {
          kind: 'money',
          title: 'Post in the Transactions menu → allocation in the fixed order',
          sub: 'Order of application: PENALTY → PAST_INTEREST → PAST_PRINCIPAL · whatever is left over becomes credit',
        },
      },
      {
        main: {
          kind: 'money',
          title: 'auto-debit applies credit to a period on its own',
          sub: 'This job is off by default · when it is on, it debits autoDebitLeadDays days before the due date (default 3) · one oldest period per contract per run, once the credit >= the amount to collect',
        },
        side: {
          kind: 'end',
          title: 'Credit is not enough → this contract is skipped for now',
          sub: 'The next run tries again; being skipped never creates a penalty',
          label: 'If the credit falls short',
        },
      },
      {
        main: {
          kind: 'end',
          title: 'The schedule and the balances are recomputed from POSTED entries',
          sub: 'Every screen reads the same running ledger — never change the figures by any other means',
        },
      },
    ],
  },

  '18': {
    heading: 'Figure 3 — Settling the whole debt before the contract ends (+ early-settlement fee)',
    caption:
      'The fee is tied to “how early”, not to settling the balance: a contract that already ran its full term, or a product with fee = 0, carries no charge here',
    legend: LEGEND_EN,
    rows: [
      {
        main: {
          kind: 'step',
          title: 'MAKER presses “New agreement” in the Settlements menu',
          sub: 'Choose the contract · the agreed amount · the reason',
        },
      },
      {
        main: {
          kind: 'step',
          title: 'The system works out the full settlement figure',
          sub: 'Remaining principal + interest + penalty, from POSTED entries only',
        },
      },
      {
        main: {
          kind: 'gate',
          title: 'Early-settlement fee = earlySettlementFeePercent × remaining principal',
          sub: 'The rate is set per product and frozen onto the contract at disbursement · rounded to 2 decimals',
        },
        side: {
          kind: 'end',
          title: 'Settling after the full term has run → fee = 0',
          sub: 'The same when the product sets the fee to 0',
          label: 'If the “early” condition is not met',
        },
      },
      {
        main: {
          kind: 'step',
          title: 'Send it into the approval queue (maker ≠ checker)',
          sub: 'The ceiling you may receive = agreed amount + fee',
        },
      },
      {
        main: {
          kind: 'money',
          title: 'Post the fee first, then receive the settlement payment',
          sub: 'The fee has to be inside the outstanding balance first; otherwise the payment overflows into credit and gets waived back',
        },
        side: {
          kind: 'stop',
          title: 'If the fee was not posted → the payment is refused (422)',
          sub: 'Go to Transactions and Post the penalty document first',
          label: 'If you skip this step',
        },
      },
      {
        main: {
          kind: 'money',
          title: 'Receive and Post — never more than agreed + fee',
          sub: 'Paying less than the settlement figure needs the difference relieved through a shortcut waiver you are entitled to use',
        },
      },
      {
        main: {
          kind: 'end',
          title: 'Contract CLOSED · agreement SETTLED · the whole schedule is closed',
          sub: 'The system emails the customer using the template configured in the Admin menu',
        },
      },
    ],
  },

  '17': {
    heading: 'Figure 4 — Maker-checker and the approval thresholds',
    caption:
      'Every document with a financial effect passes through this same structure: loan contracts, payment requests, settlement agreements, penalty/waiver/write-off, and interest accrual',
    legend: LEGEND_EN,
    rows: [
      {
        main: {
          kind: 'step',
          title: 'The document is created (the creator is called the maker)',
          sub: 'The system records the amount of the case as the basis for counting tiers',
        },
      },
      {
        main: {
          kind: 'gate',
          title: 'Count the tiers this amount needs',
          sub: 'Up to the checker threshold → 1 tier (CHECKER) · up to the head threshold → add a HEAD tier · above that → add an ADMIN tier as the last one',
        },
      },
      {
        main: {
          kind: 'step',
          title: 'A workflow is created with steps ordered by tier',
          sub: 'The maker who raised the document is stripped of decision rights at every tier of their own queue',
        },
        side: {
          kind: 'stop',
          title: 'The creator comes back to approve it themselves → refused',
          sub: 'Change the decision-maker, or let Admin set the values again',
          label: 'Maker-checker breach',
        },
      },
      {
        main: {
          kind: 'step',
          title: 'Decide one tier at a time in the Approvals menu',
          sub: 'CHECKER decides the CHECKER tier · HEAD/ADMIN decide the HEAD tier · only ADMIN the ADMIN tier · several cases can be approved at once (Bulk)',
        },
      },
      {
        main: {
          kind: 'end',
          title: 'Every tier passed → the document is APPROVED',
          sub: 'Each step is locked; a second person clicking at the same moment cannot write over it',
        },
        side: {
          kind: 'stop',
          title: 'Any one tier Rejects → the case is REJECTED',
          sub: 'The running ledger never moved; a new case has to be raised',
          label: 'If it is not approved',
        },
      },
      {
        main: {
          kind: 'money',
          title: 'A “Post” in the Transactions menu is still needed before money moves',
          sub: 'Before Post it can still be reversed or corrected · after Post only by raising a reversal document',
        },
      },
    ],
  },
};

const FLOWS_TH: Record<string, FlowSpec> = {
  '11': {
    heading: 'รูปที่ 1 — วงจรชีวิตสัญญากู้หนึ่งฉบับ: ตั้งแต่กดสร้างจนถึงวันปิดสัญญา',
    caption:
      'อ่านจากบนลงล่าง: ช่องซ้ายคือเส้นเรื่องหลัก ช่องขวาคือผลข้างทางที่ระบบบังคับ สีส้ม = จุดที่ระบบบล็อก, สีเขียว = จุดที่เงินขยับจริงในบัญชีเดินรายการ',
    legend: LEGEND_TH,
    rows: [
      {
        main: {
          kind: 'step',
          title: 'MAKER กด “New loan”',
          sub: 'เลือกลูกค้า · ผลิตภัณฑ์ · เงินต้น · ระยะเวลา · วันที่ปล่อยกู้ (Disbursement date)',
        },
      },
      {
        main: {
          kind: 'step',
          title: 'ระบบผูกคิวอนุมัติตามวงเงิน',
          sub: 'จำนวนชั้นผู้ตัดสินมาจากค่ากลางในเมนู Admin (ดูรูปที่ 4)',
        },
      },
      {
        main: {
          kind: 'gate',
          title: 'Maker–Checker: ผู้สร้างอนุมัติเองไม่ได้',
          sub: 'คนสร้างเรื่องจะถูกกันออกจากทุกชั้นของคิวนี้',
        },
        side: {
          kind: 'stop',
          title: 'MAKER กดอนุมัติเรื่องตัวเอง → 403',
          sub: 'ต้องส่งต่อให้ CHECKER หรือ HEAD',
          label: 'ถ้าพยายามอนุมัติเอง',
        },
      },
      {
        main: {
          kind: 'step',
          title: 'อนุมัติครบทุกชั้น → สถานะ APPROVED',
          sub: 'ยังไม่มีการขยับเงินใด ๆ ทั้งสิ้น — ต้อง Post อีกครั้ง',
        },
      },
      {
        main: {
          kind: 'gate',
          title: 'ประตูก่อนปล่อยกู้: สถานะ KYC ของลูกค้า',
          sub: 'ค่ากลาง blockDisbursementUntilVerified = เปิดอยู่ → ลูกค้าต้อง VERIFIED',
        },
        side: {
          kind: 'stop',
          title: 'ยังไม่ Verified → ปล่อยกู้ไม่ได้',
          sub: 'กลับไปอัปโหลด/ตรวจหลักฐานที่เมนู KYC ก่อน',
          label: 'ถ้า KYC ยังไม่ผ่าน',
        },
      },
      {
        main: {
          kind: 'money',
          title: 'กด “Disburse” → เงินต้นเข้าบัญชีเดินรายการ',
          sub: 'FLAT: ดอกทั้งสัญญาถูก billed ครั้งเดียว · DECLINING: billed เฉพาะงวดแรก งวดถัดไปค่อยตั้งดอกเบี้ยค้างรับ',
        },
      },
      {
        main: {
          kind: 'end',
          title: 'สัญญาเป็น ACTIVE พร้อมตารางงวด',
          sub: 'นโยบายค่าปรับของผลิตภัณฑ์ถูกตรึงไว้กับสัญญา ณ วันปล่อยกู้',
        },
      },
    ],
  },

  '13': {
    heading: 'รูปที่ 2 — รับชำระหนี้: งวดที่ถึงรอบ · credit · auto-debit',
    caption:
      'หัวใจอยู่บรรทัดที่ 2: ระบบยอมให้ชำระเฉพาะยอดที่ “ถึงกำหนดแล้ว” เท่านั้น เงินที่รับมาเกินจะถูกเก็บเป็นเครดิตของลูกค้า แล้ว auto-debit จะดึงไปตัดงวดเองเมื่อถึงเวลา',
    legend: LEGEND_TH,
    rows: [
      {
        main: {
          kind: 'step',
          title: 'MAKER กด “New payment request”',
          sub: 'เลือกสัญญา · จำนวนเงินที่จะรับ · วันที่รับ · ช่องหมายเหตุ',
        },
      },
      {
        main: {
          kind: 'gate',
          title: 'ตรวจขอบเขตงวดที่ถึงกำหนดแล้ว',
          sub: 'Maximum payable today = min(ยอดที่ถึงรอบ, ยอดคงค้างใน ledger)',
        },
        side: {
          kind: 'stop',
          title: 'ยังไม่ถึงกำหนดสักงวด → 422 “no instalment has arrived yet”',
          sub: 'บันทึกเป็นค่าปรับ/ดอกเบี้ยก่อนกำหนดไม่ได้ — เป็นกฎของระบบ',
          label: 'ถ้าจะจ่ายทั้งที่ยังไม่ถึงรอบ',
        },
      },
      {
        main: {
          kind: 'step',
          title: 'ยังอยากรับเงินไว้ก่อน → เลือก “Deposit to credit”',
          sub: 'เงินเข้าเครดิตลูกค้า ไม่ตัดงวดใด ไม่ทำให้ค่างวดเป็นปัจจุบัน',
        },
      },
      {
        main: {
          kind: 'step',
          title: 'CHECKER / HEAD อนุมัติคำขอ',
          sub: 'อนุมัติแล้วเอกสารเป็น APPROVED — เงินยังไม่ได้เดิน',
        },
      },
      {
        main: {
          kind: 'money',
          title: 'Post ที่เมนู Transactions → จัดสรรตามกระบอก',
          sub: 'ลำดับการตัด: PENALTY → PAST_INTEREST → PAST_PRINCIPAL · ส่วนที่เกินคงเหลือกลายเป็นเครดิต',
        },
      },
      {
        main: {
          kind: 'money',
          title: 'auto-debit ตัดงวดจากเครดิตอัตโนมัติ',
          sub: 'งานอัตโนมัติตัวนี้ปิดเป็นค่าเริ่มต้น · เมื่อเปิด จะตัดก่อนถึงกำหนด autoDebitLeadDays วัน (ค่าเริ่มต้น 3) · ครั้งละ 1 งวดเก่าสุดต่อสัญญา เมื่อเครดิต >= ยอดที่ต้องเก็บ',
        },
        side: {
          kind: 'end',
          title: 'เครดิตไม่พอ → ข้ามสัญญานี้ไปก่อน',
          sub: 'รอบถัดไปจะลองใหม่ ไม่เกิดค่าปรับจากการที่ถูกข้าม',
          label: 'ถ้าเครดิตยังไม่พอ',
        },
      },
      {
        main: {
          kind: 'end',
          title: 'ตารางงวดและยอดคงเหลือคำนวณใหม่จากรายการที่ POSTED',
          sub: 'หน้าจอทุกหน้าอ่านจากบัญชีเดินรายการเดียวกัน ห้ามแก้ตัวเลขด้วยวิธีอื่น',
        },
      },
    ],
  },

  '18': {
    heading: 'รูปที่ 3 — ปิดหนี้ทั้งหมดก่อนครบสัญญา (+ ค่าปรับปิดก่อนกำหนด)',
    caption:
      'ค่าปรับผูกกับ “ความก่อนกำหนด” ไม่ใช่กับการปิดยอด: สัญญาที่เดินครบเทอมแล้ว หรือผลิตภัณฑ์ที่ตั้ง fee = 0 จะไม่มีค่าปรับตรงนี้',
    legend: LEGEND_TH,
    rows: [
      {
        main: {
          kind: 'step',
          title: 'MAKER กด “New agreement” ที่เมนู Settlements',
          sub: 'เลือกสัญญา · ยอดที่ตกลงกัน (Agreed amount) · เหตุผล',
        },
      },
      {
        main: {
          kind: 'step',
          title: 'ระบบคำนวณยอดปิดทั้งหมด',
          sub: 'เงินต้น + ดอกเบี้ย + ค่าปรับคงเหลือ จากรายการที่ POSTED เท่านั้น',
        },
      },
      {
        main: {
          kind: 'gate',
          title: 'ค่าปรับปิดก่อนกำหนด = earlySettlementFeePercent × เงินต้นคงเหลือ',
          sub: 'อัตราตั้งต่อผลิตภัณฑ์ และถูกตรึงไว้กับสัญญาตอนปล่อยกู้ · ปัด 2 ตำแหน่ง',
        },
        side: {
          kind: 'end',
          title: 'ปิดเมื่อเดินครบเทอมแล้ว → ค่าปรับ = 0',
          sub: 'เช่นกันถ้าผลิตภัณฑ์ตั้ง fee เป็น 0',
          label: 'ถ้าไม่เข้าเงื่อนไข “ก่อนกำหนด”',
        },
      },
      {
        main: {
          kind: 'step',
          title: 'ส่งเข้าคิวอนุมัติ (maker ≠ checker)',
          sub: 'เพดานที่รับชำระได้ = Agreed amount + ค่าปรับ',
        },
      },
      {
        main: {
          kind: 'money',
          title: 'Post ค่าปรับก่อน แล้วจึงรับชำระปิดยอด',
          sub: 'ค่าปรับต้องอยู่ในยอดคงค้างก่อน ไม่งั้นเงินที่จ่ายจะล้นไปเป็นเครดิตแล้วถูก waive คืน',
        },
        side: {
          kind: 'stop',
          title: 'ถ้ายังไม่ได้ post ค่าปรับ → ระบบปฏิเสธรับชำระ (422)',
          sub: 'ไปที่ Transactions แล้ว Post เอกสารค่าปรับก่อน',
          label: 'ถ้าข้ามขั้นตอนนี้',
        },
      },
      {
        main: {
          kind: 'money',
          title: 'รับชำระและ Post — จ่ายได้ไม่เกิน agreed + fee',
          sub: 'จ่ายน้อยกว่ายอดปิด ต้องผ่อนปรนส่วนต่างผ่าน shortcut waiver ที่ต้องได้รับสิทธิ์',
        },
      },
      {
        main: {
          kind: 'end',
          title: 'สัญญา CLOSED · ข้อตกลง SETTLED · ปิดตารางงวดทั้งฉบับ',
          sub: 'ระบบส่งอีเมลแจ้งลูกค้าตามเทมเพลตที่ตั้งไว้ในเมนู Admin',
        },
      },
    ],
  },

  '17': {
    heading: 'รูปที่ 4 — Maker-checker และ threshold การอนุมัติ',
    caption:
      'ทุกเอกสารที่มีผลทางการเงินผ่านโครงเดียวกันนี้ ได้แก่ สัญญากู้, คำขอรับชำระ, ข้อตกลงปิดยอด, ค่าปรับ/ผ่อนปรน/ตัดหนี้, และการตั้งดอกเบี้ยค้างรับ',
    legend: LEGEND_TH,
    rows: [
      {
        main: {
          kind: 'step',
          title: 'สร้างเอกสาร (ผู้สร้างเรียกว่า maker)',
          sub: 'ระบบจำวงเงินของเรื่องไว้เป็นฐานการนับชั้น',
        },
      },
      {
        main: {
          kind: 'gate',
          title: 'นับชั้นที่ต้องใช้จากวงเงิน',
          sub: 'ไม่เกิน checker threshold → 1 ชั้น (CHECKER) · ไม่เกิน head threshold → เพิ่มชั้น HEAD · มากกว่านั้น → เพิ่มชั้น ADMIN เป็นชั้นสุดท้าย',
        },
      },
      {
        main: {
          kind: 'step',
          title: 'เกิด workflow + ขั้นตอนเรียงตามชั้น',
          sub: 'maker ที่สร้างเรื่องถูกกันออกจากสิทธิ์ตัดสินทุกชั้นของคิวตัวเอง',
        },
        side: {
          kind: 'stop',
          title: 'คนสร้างมากดอนุมัติเอง → ถูกปฏิเสธ',
          sub: 'เปลี่ยนผู้ตัดสิน หรือให้ Admin ตั้งค่าใหม่',
          label: 'ละเมิด maker-checker',
        },
      },
      {
        main: {
          kind: 'step',
          title: 'ตัดสินทีละชั้นที่เมนู Approvals',
          sub: 'CHECKER ตัดสินชั้น CHECKER · HEAD/ADMIN ตัดสินชั้น HEAD · ADMIN เท่านั้นชั้น ADMIN · อนุมัติพร้อมกันหลายเรื่องได้ (Bulk)',
        },
      },
      {
        main: {
          kind: 'end',
          title: 'ครบทุกชั้น → เอกสารเป็น APPROVED',
          sub: 'แต่ละขั้นถูกล็อกไว้ คนที่สองที่กดพร้อมกันจะไม่ได้เขียนซ้ำ',
        },
        side: {
          kind: 'stop',
          title: 'ชั้นใดชั้นหนึ่ง Reject → เรื่องเป็น REJECTED',
          sub: 'บัญชีเดินรายการไม่ขยับเลย ต้องสร้างเรื่องใหม่',
          label: 'ถ้าไม่อนุมัติ',
        },
      },
      {
        main: {
          kind: 'money',
          title: 'ยังต้อง “Post” ที่เมนู Transactions เงินจึงขยับ',
          sub: 'ก่อน Post ยังกลับรายการ/แก้ได้ · หลัง Post ต้องออกเอกสารกลับรายการเท่านั้น',
        },
      },
    ],
  },
};

export const FLOWS: Record<ManualEdition, Record<string, FlowSpec>> = { en: FLOWS_EN, th: FLOWS_TH };
