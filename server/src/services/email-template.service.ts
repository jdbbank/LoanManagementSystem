import { EntityManager } from 'typeorm';
import { EmailTemplate } from '../entities/email-template.entity';
import { NotificationEventType } from '../entities/types';
import { unprocessable } from '../utils/errors';

/**
 * The backend owns the whole look and feel of an email: the layout, the inline styles,
 * the Lao wording and the placeholders. The mailer service is handed finished
 * subject/html/text and transports it as-is.
 */

export const TEMPLATE_LOCALE = 'lo';
export const FALLBACK_TEMPLATE_LOCALE = 'en';

const BRAND_NAME = 'ລະບົບຈັດການສິນເຊື່ອ';

/** Frame shared by every template so the house style lives in one place. */
function layout(title: string, body: string): string {
  return [
    '<div style="font-family:Segoe UI,Arial,sans-serif;background:#f4f6fa;padding:24px">',
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #dfe3ec;border-radius:12px;overflow:hidden">',
    `<div style="background:#1f3a8a;color:#ffffff;padding:18px 24px;font-size:17px;font-weight:600">${title}</div>`,
    `<div style="padding:24px;color:#33384a;font-size:14px;line-height:1.7">${body}</div>`,
    `<div style="padding:14px 24px;background:#f4f6fa;color:#6b7280;font-size:12px">${BRAND_NAME}</div>`,
    '</div></div>',
  ].join('');
}

function detailTable(rows: [string, string][]): string {
  if (rows.length === 0) return '';
  const cells = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 0;color:#6b7280;width:45%">${label}</td>` +
        `<td style="padding:6px 0;font-weight:600">${value}</td></tr>`,
    )
    .join('');
  return `<table style="width:100%;border-collapse:collapse;margin:16px 0">${cells}</table>`;
}

function plainText(title: string, rows: [string, string][], note?: string): string {
  const lines = [BRAND_NAME, title, ''];
  for (const [label, value] of rows) lines.push(`${label}: ${value}`);
  if (note) lines.push('', note);
  return lines.join('\n');
}

interface TemplateSeed {
  code: NotificationEventType;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  variables: string[];
}

const GREETING = 'ສະບາຍດີ ທ່ານ{{recipientName}}';

/** Default set of templates seeded once; afterwards ADMIN edits win. */
export const DEFAULT_TEMPLATES: TemplateSeed[] = [
  {
    code: NotificationEventType.LOAN_APPLICATION_SUBMITTED,
    subject: 'ຮັບຄຳຮ້ອງສິນເຊື່ອ {{loanCode}} ຮຽບຮ້ອຍແລ້ວ',
    bodyHtml: layout(
      'ຮັບຄຳຮ້ອງສິນເຊື່ອ',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ຜະລິດຕະພັນ', '{{productName}}'],
        ['ຈຳນວນຂໍກູ້', '{{amount}}'],
        ['ໄລຍະເວລາ', '{{term}}'],
        ['ສະຖານະ', '{{status}}'],
      ])}<p>ທ່ານຈະໄດ້ຮັບແຈ້ງເຕືອນອີກຄັ້ງເມື່ອພິຈາລະນາແລ້ວ.</p>`,
    ),
    bodyText: plainText('ຮັບຄຳຮ້ອງສິນເຊື່ອ', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ຜະລິດຕະພັນ', '{{productName}}'],
      ['ຈຳນວນຂໍກູ້', '{{amount}}'],
      ['ໄລຍະເວລາ', '{{term}}'],
      ['ສະຖານະ', '{{status}}'],
    ], 'ທ່ານຈະໄດ້ຮັບແຈ້ງເຕືອນອີກຄັ້ງເມື່ອພິຈາລະນາແລ້ວ.'),
    variables: ['recipientName', 'loanCode', 'productName', 'amount', 'term', 'status'],
  },
  {
    code: NotificationEventType.LOAN_APPROVED,
    subject: 'ສິນເຊື່ອ {{loanCode}} ໄດ້ຮັບການອະນຸມັດ',
    bodyHtml: layout(
      'ສິນເຊື່ອໄດ້ຮັບການອະນຸມັດ',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ຈຳນວນທີ່ອະນຸມັດ', '{{amount}}'],
        ['ໄລຍະເວລາ', '{{term}}'],
        ['ອັດຕາດອກເບ້ຍ', '{{interestRate}}'],
        ['ໝາຍເຫດ', '{{decisionNote}}'],
      ])}<p>ເງິນຈະໂອນເຂົ້າບັນຊີຂອງທ່ານຕາມຂັ້ນຕອນຕໍ່ໄປ.</p>`,
    ),
    bodyText: plainText('ສິນເຊື່ອໄດ້ຮັບການອະນຸມັດ', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ຈຳນວນທີ່ອະນຸມັດ', '{{amount}}'],
      ['ໄລຍະເວລາ', '{{term}}'],
      ['ອັດຕາດອກເບ້ຍ', '{{interestRate}}'],
      ['ໝາຍເຫດ', '{{decisionNote}}'],
    ], 'ເງິນຈະໂອນເຂົ້າບັນຊີຂອງທ່ານຕາມຂັ້ນຕອນຕໍ່ໄປ.'),
    variables: ['recipientName', 'loanCode', 'amount', 'term', 'interestRate', 'decisionNote'],
  },
  {
    code: NotificationEventType.LOAN_REJECTED,
    subject: 'ສິນເຊື່ອ {{loanCode}} ບໍ່ໄດ້ຮັບການອະນຸມັດ',
    bodyHtml: layout(
      'ສິນເຊື່ອບໍ່ໄດ້ຮັບການອະນຸມັດ',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ຈຳນວນທີ່ຂໍກູ້', '{{amount}}'],
        ['ເຫດຜົນ', '{{decisionNote}}'],
      ])}<p>ທ່ານສາມາດຕິດຕໍ່ເຈົ້າໜ້າທີ່ເພື່ອຂໍຄຳແນະນຳ ຫຼື ຍື່ນຄຳຮ້ອງໃໝ່.</p>`,
    ),
    bodyText: plainText('ສິນເຊື່ອບໍ່ໄດ້ຮັບການອະນຸມັດ', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ຈຳນວນທີ່ຂໍກູ້', '{{amount}}'],
      ['ເຫດຜົນ', '{{decisionNote}}'],
    ], 'ທ່ານສາມາດຕິດຕໍ່ເຈົ້າໜ້າທີ່ເພື່ອຂໍຄຳແນະນຳ ຫຼື ຍື່ນຄຳຮ້ອງໃໝ່.'),
    variables: ['recipientName', 'loanCode', 'amount', 'decisionNote'],
  },
  {
    code: NotificationEventType.PAYMENT_POSTED,
    subject: 'ຢືນຢັນການຊຳລະ {{amount}} ສຳລັບສິນເຊື່ອ {{loanCode}}',
    bodyHtml: layout(
      'ຢືນຢັນການຊຳລະ',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ຈຳນວນຊຳລະ', '{{amount}}'],
        ['ວັນທີຊຳລະ', '{{paidDate}}'],
        ['ແບ່ງຊຳລະເປັນ', '{{allocation}}'],
        ['ຍອດທີ່ຍັງເຫຼືອ', '{{remaining}}'],
      ])}<p>ຂອບໃຈທີ່ຊຳລະຕາມກຳນົດ. ຖ້າທ່ານບໍ່ໄດ້ເຮັດການຊຳລະນີ້ ກະລຸນາແຈ້ງຜູ້ເບິ່ງແຍງທັນທີ.</p>`,
    ),
    bodyText: plainText('ຢືນຢັນການຊຳລະ', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ຈຳນວນຊຳລະ', '{{amount}}'],
      ['ວັນທີຊຳລະ', '{{paidDate}}'],
      ['ແບ່ງຊຳລະເປັນ', '{{allocation}}'],
      ['ຍອດທີ່ຍັງເຫຼືອ', '{{remaining}}'],
    ], 'ຂອບໃຈທີ່ຊຳລະຕາມກຳນົດ. ຖ້າທ່ານບໍ່ໄດ້ເຮັດການຊຳລະນີ້ ກະລຸນາແຈ້ງຜູ້ເບິ່ງແຍງທັນທີ.'),
    variables: ['recipientName', 'loanCode', 'amount', 'paidDate', 'allocation', 'remaining'],
  },
  {
    code: NotificationEventType.SETTLEMENT_REQUESTED,
    subject: 'ຮັບຄຳຮ້ອງປິດບັນຊີ {{loanCode}} ຮຽບຮ້ອຍແລ້ວ',
    bodyHtml: layout(
      'ຮັບຄຳຮ້ອງປິດບັນຊີ',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ຈຳນວນທີ່ຂໍປິດ', '{{settlementAmount}}'],
        ['ຍອດຄົງເຫຼືອລວມ', '{{totalOutstanding}}'],
        ['ສະຖານະ', '{{status}}'],
      ])}<p>ຄຳຮ້ອງນີ້ຈະຕ້ອງຜ່ານການອະນຸມັດຕາມຂັ້ນຕອນອີກຄັ້ງ.</p>`,
    ),
    bodyText: plainText('ຮັບຄຳຮ້ອງປິດບັນຊີ', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ຈຳນວນທີ່ຂໍປິດ', '{{settlementAmount}}'],
      ['ຍອດຄົງເຫຼືອລວມ', '{{totalOutstanding}}'],
      ['ສະຖານະ', '{{status}}'],
    ], 'ຄຳຮ້ອງນີ້ຈະຕ້ອງຜ່ານການອະນຸມັດຕາມຂັ້ນຕອນອີກຄັ້ງ.'),
    variables: [
      'recipientName',
      'loanCode',
      'settlementAmount',
      'totalOutstanding',
      'status',
    ],
  },
  {
    code: NotificationEventType.SETTLEMENT_DECIDED,
    subject: 'ຜົນການພິຈາລະນາປິດບັນຊີ {{loanCode}}: {{decision}}',
    bodyHtml: layout(
      'ຜົນການພິຈາລະນາປິດບັນຊີ',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ຜົນຕັດສິນ', '{{decision}}'],
        ['ຈຳນວນປິດບັນຊີ', '{{settlementAmount}}'],
        ['ກຳນົດຊຳລະ', '{{dueDate}}'],
        ['ໝາຍເຫດ', '{{decisionNote}}'],
      ])}<p>ກະລຸນາຊຳລະຕາມກຳນົດທີ່ລະບຸໄວ້ ເພື່ອໃຫ້ບັນຊີປິດສຳເລັດ.</p>`,
    ),
    bodyText: plainText('ຜົນການພິຈາລະນາປິດບັນຊີ', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ຜົນຕັດສິນ', '{{decision}}'],
      ['ຈຳນວນປິດບັນຊີ', '{{settlementAmount}}'],
      ['ກຳນົດຊຳລະ', '{{dueDate}}'],
      ['ໝາຍເຫດ', '{{decisionNote}}'],
    ], 'ກະລຸນາຊຳລະຕາມກຳນົດທີ່ລະບຸໄວ້ ເພື່ອໃຫ້ບັນຊີປິດສຳເລັດ.'),
    variables: [
      'recipientName',
      'loanCode',
      'decision',
      'settlementAmount',
      'dueDate',
      'decisionNote',
    ],
  },
  {
    code: NotificationEventType.PARTY_REGISTERED,
    subject: 'ທ່ານຖືກລົງທະບຽນເປັນ {{partyRole}} ຂອງສິນເຊື່ອ {{loanCode}}',
    bodyHtml: layout(
      'ລົງທະບຽນຜູ້ຄ້ຳປະກັນ / ຜູ້ຊຳລະແທນ',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ບົດບາດ', '{{partyRole}}'],
        ['ຊື່ຜູ້ຖືກລົງທະບຽນ', '{{partyName}}'],
        ['ເລກທີ່ລູກຄ້າ', '{{partyCustomerNumber}}'],
        ['ມີຜົນຕັ້ງແຕ່', '{{effectiveDate}}'],
      ])}<p>ບົດບາດນີ້ໃຊ້ໄດ້ສະເພາະຫຼັງເມື່ອການຢືນຢັນຕົວຕົນ (KYC) ຜ່ານແລ້ວ. ຖ້າທ່ານບໍ່ໄດ້ຍອມຮັບບົດບາດນີ້ ກະລຸນາແຈ້ງເຈົ້າໜ້າທີ່ທັນທີ.</p>`,
    ),
    bodyText: plainText('ລົງທະບຽນຜູ້ຄ້ຳປະກັນ / ຜູ້ຊຳລະແທນ', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ບົດບາດ', '{{partyRole}}'],
      ['ຊື່ຜູ້ຖືກລົງທະບຽນ', '{{partyName}}'],
      ['ເລກທີ່ລູກຄ້າ', '{{partyCustomerNumber}}'],
      ['ມີຜົນຕັ້ງແຕ່', '{{effectiveDate}}'],
    ], 'ບົດບາດນີ້ໃຊ້ໄດ້ສະເພາະຫຼັງເມື່ອການຢືນຢັນຕົວຕົນ (KYC) ຜ່ານແລ້ວ.'),
    variables: ['recipientName', 'loanCode', 'partyRole', 'partyName', 'partyCustomerNumber', 'effectiveDate'],
  },
  {
    code: NotificationEventType.PARTY_RELEASED,
    subject: 'ປົດ {{partyRole}} {{partyName}} ອອກຈາກສິນເຊື່ອ {{loanCode}}',
    bodyHtml: layout(
      'ປົດຜູ້ຄ້ຳປະກັນ / ຜູ້ຊຳລະແທນ',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ບົດບາດ', '{{partyRole}}'],
        ['ຊື່ຜູ້ຖືກປົດ', '{{partyName}}'],
        ['ເຫດຜົນ', '{{releaseReason}}'],
        ['ມີຜົນຕັ້ງແຕ່', '{{effectiveDate}}'],
      ])}<p>ການປົດນີ້ບໍ່ລົບລ້າງໜີ້ທີ່ເກີດຂຶ້ນໃນຊ່ວງທີ່ທ່ານຍັງຄອບຄອງບົດບາດ.</p>`,
    ),
    bodyText: plainText('ປົດຜູ້ຄ້ຳປະກັນ / ຜູ້ຊຳລະແທນ', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ບົດບາດ', '{{partyRole}}'],
      ['ຊື່ຜູ້ຖືກປົດ', '{{partyName}}'],
      ['ເຫດຜົນ', '{{releaseReason}}'],
      ['ມີຜົນຕັ້ງແຕ່', '{{effectiveDate}}'],
    ], 'ການປົດນີ້ບໍ່ລົບລ້າງໜີ້ທີ່ເກີດຂຶ້ນໃນຊ່ວງທີ່ທ່ານຍັງຄອບຄອງບົດບາດ.'),
    variables: ['recipientName', 'loanCode', 'partyRole', 'partyName', 'releaseReason', 'effectiveDate'],
  },
  {
    code: NotificationEventType.RESTRUCTURE_REQUESTED,
    subject: 'ຮັບຄຳຮ້ອງແກ້ໄຂສັນຍາ {{requestNo}} ຂອງສິນເຊື່ອ {{loanCode}} ຮຽບຮ້ອຍແລ້ວ',
    bodyHtml: layout(
      'ຄຳຮ້ອງແກ້ໄຂສັນຍາ (ປັບໂຄງສ້າງໜີ້)',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ເລກທີຄຳຮ້ອງ', '{{requestNo}}'],
        ['ສິ່ງທີ່ຂໍປັບແປງ', '{{changeTypes}}'],
        ['ອັດຕາດອກເບ້ຍທີ່ຂໍ', '{{newInterestRate}}'],
        ['ໄລຍະເວລາທີ່ຂໍ', '{{newTermMonths}}'],
        ['ດອກເບ້ຍສະສົມທີ່ຂໍຢຸດ', '{{reliefAmount}}'],
        ['ສະຖານະ', '{{status}}'],
      ])}<p>ຄຳຮ້ອງນີ້ຈະມີຜົນກໍຕໍ່ເມື່ອຜູ້ມີອຳນາດອະນຸມັດຄົບທຸຂັ້ນຕອນແລ້ວ.</p>`,
    ),
    bodyText: plainText('ຄຳຮ້ອງແກ້ໄຂສັນຍາ (ປັບໂຄງສ້າງໜີ້)', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ເລກທີຄຳຮ້ອງ', '{{requestNo}}'],
      ['ສິ່ງທີ່ຂໍປັບແປງ', '{{changeTypes}}'],
      ['ອັດຕາດອກເບ້ຍທີ່ຂໍ', '{{newInterestRate}}'],
      ['ໄລຍະເວລາທີ່ຂໍ', '{{newTermMonths}}'],
      ['ດອກເບ້ຍສະສົມທີ່ຂໍຢຸດ', '{{reliefAmount}}'],
      ['ສະຖານະ', '{{status}}'],
    ], 'ຄຳຮ້ອງນີ້ຈະມີຜົນກໍຕໍ່ເມື່ອຜູ້ມີອຳນາດອະນຸມັດຄົບທຸຂັ້ນຕອນແລ້ວ.'),
    variables: [
      'recipientName',
      'loanCode',
      'requestNo',
      'changeTypes',
      'newInterestRate',
      'newTermMonths',
      'reliefAmount',
      'status',
    ],
  },
  {
    code: NotificationEventType.RESTRUCTURE_DECIDED,
    subject: 'ຜົນການພິຈາລະນາຄຳຮ້ອງແກ້ໄຂສັນຍາ {{requestNo}}: {{decision}}',
    bodyHtml: layout(
      'ຜົນການພິຈາລະນາຄຳຮ້ອງແກ້ໄຂສັນຍາ',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ເລກທີຄຳຮ້ອງ', '{{requestNo}}'],
        ['ຜົນຕັດສິນ', '{{decision}}'],
        ['ໝາຍເຫດ', '{{decisionNote}}'],
      ])}<p>ຖ້າອະນຸມັດ, ການປັບແປງຈະບັນທຶກເຂົ້າບັນຊີຂອງສິນເຊື່ອນີ້ຕາມຂັ້ນຕອນຕໍ່ໄປ.</p>`,
    ),
    bodyText: plainText('ຜົນການພິຈາລະນາຄຳຮ້ອງແກ້ໄຂສັນຍາ', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ເລກທີຄຳຮ້ອງ', '{{requestNo}}'],
      ['ຜົນຕັດສິນ', '{{decision}}'],
      ['ໝາຍເຫດ', '{{decisionNote}}'],
    ], 'ຖ້າອະນຸມັດ, ການປັບແປງຈະບັນທຶກເຂົ້າບັນຊີຂອງສິນເຊື່ອນີ້ຕາມຂັ້ນຕອນຕໍ່ໄປ.'),
    variables: ['recipientName', 'loanCode', 'requestNo', 'decision', 'decisionNote'],
  },
  {
    code: NotificationEventType.RESTRUCTURE_APPLIED,
    subject: 'ຄຳຮ້ອງແກ້ໄຂສັນຍາ {{requestNo}} ມີຜົນແລ້ວສຳລັບສິນເຊື່ອ {{loanCode}}',
    bodyHtml: layout(
      'ສັນຍາຖືກແກ້ໄຂແລ້ວ',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ເລກທີຄຳຮ້ອງ', '{{requestNo}}'],
        ['ອັດຕາດອກເບ້ຍໃໝ່', '{{newInterestRate}}'],
        ['ໄລຍະເວລາໃໝ່', '{{newTermMonths}}'],
        ['ດອກເບ້ຍສະສົມທີ່ຢຸດ', '{{reliefAmount}}'],
        ['ມີຜົນຕັ້ງແຕ່', '{{appliedDate}}'],
      ])}<p>ຕາຕະລາງຊຳລະຄິດໄລ່ຈາກບັນຊີທີ່ຜ່ານການບັນທຶກແລ້ວ, ໜີ້ເກົ່າທຸກລາຍການຍັງຄົງກວດສອບໄດ້.</p>`,
    ),
    bodyText: plainText('ສັນຍາຖືກແກ້ໄຂແລ້ວ', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ເລກທີຄຳຮ້ອງ', '{{requestNo}}'],
      ['ອັດຕາດອກເບ້ຍໃໝ່', '{{newInterestRate}}'],
      ['ໄລຍະເວລາໃໝ່', '{{newTermMonths}}'],
      ['ດອກເບ້ຍສະສົມທີ່ຢຸດ', '{{reliefAmount}}'],
      ['ມີຜົນຕັ້ງແຕ່', '{{appliedDate}}'],
    ], 'ຕາຕະລາງຊຳລະຄິດໄລ່ຈາກບັນຊີທີ່ຜ່ານການບັນທຶກແລ້ວ, ໜີ້ເກົ່າທຸກລາຍການຍັງຄົງກວດສອບໄດ້.'),
    variables: ['recipientName', 'loanCode', 'requestNo', 'newInterestRate', 'newTermMonths', 'reliefAmount', 'appliedDate'],
  },
  {
    code: NotificationEventType.USER_CREATED,
    subject: 'ສ້າງບັນຊີຜູ້ໃຊ້ {{username}} ໃໝ່ແລ້ວ',
    bodyHtml: layout(
      'ບັນຊີຜູ້ໃຊ້ໃໝ່',
      `<p>${GREETING}</p>${detailTable([
        ['ຊື່ຜູ້ໃຊ້', '{{username}}'],
        ['ສິດທິການໃຊ້ (role)', '{{role}}'],
        ['ຜູ້ສ້າງ', '{{createdByName}}'],
      ])}<p>ກະລຸນາເຂົ້າສູ່ລະບົບ ແລະ ປ່ຽນລະຫັດຜ່ານໃໝ່ທັນທີ.</p>`,
    ),
    bodyText: plainText('ບັນຊີຜູ້ໃຊ້ໃໝ່', [
      ['ຊື່ຜູ້ໃຊ້', '{{username}}'],
      ['ສິດທິການໃຊ້ (role)', '{{role}}'],
      ['ຜູ້ສ້າງ', '{{createdByName}}'],
    ], 'ກະລຸນາເຂົ້າສູ່ລະບົບ ແລະ ປ່ຽນລະຫັດຜ່ານໃໝ່ທັນທີ.'),
    variables: ['recipientName', 'username', 'role', 'createdByName'],
  },
  {
    code: NotificationEventType.PASSWORD_RESET_OTP,
    subject: 'ເລກຢືນຢັນ {{otp}} ສຳລັບການຕັ້ງລະຫັດຜ່ານໃໝ່',
    bodyHtml: layout(
      'ເລກຢືນຢັນຕັ້ງລະຫັດຜ່ານໃໝ່',
      `<p>${GREETING}</p><p style="font-size:28px;letter-spacing:6px;font-weight:700;color:#1f3a8a;text-align:center;margin:20px 0">{{otp}}</p>${detailTable(
        [['ມີອາຍຸ', '{{expiresMinutes}} ນາທີ']],
      )}<p>ຢ່າແບ່ງປັນເລກນີ້ໃຫ້ຜູ້ອື່ນ. ຖ້າທ່ານບໍ່ໄດ້ເປັນຄົນຮ້ອງຂໍ ບໍ່ຕ້ອງເຮັດຫຍັງກັບຂໍ້ຄວາມນີ້.</p>`,
    ),
    bodyText: plainText('ເລກຢືນຢັນຕັ້ງລະຫັດຜ່ານໃໝ່', [
      ['ເລກຢືນຢັນ', '{{otp}}'],
      ['ມີອາຍຸ', '{{expiresMinutes}} ນາທີ'],
    ], 'ຢ່າແບ່ງປັນເລກນີ້ໃຫ້ຜູ້ອື່ນ. ຖ້າທ່ານບໍ່ໄດ້ເປັນຄົນຮ້ອງຂໍ ບໍ່ຕ້ອງເຮັດຫຍັງກັບຂໍ້ຄວາມນີ້.'),
    variables: ['recipientName', 'otp', 'expiresMinutes'],
  },
  {
    code: NotificationEventType.PASSWORD_RESET_LINK,
    subject: 'ລິ້ງຕັ້ງລະຫັດຜ່ານໃໝ່ ສຳລັບ {{username}}',
    bodyHtml: layout(
      'ຕັ້ງລະຫັດຜ່ານໃໝ່',
      `<p>${GREETING}</p><p style="text-align:center;margin:20px 0"><a href="{{resetUrl}}" style="background:#1f3a8a;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none">ຕັ້ງລະຫັດຜ່ານໃໝ່</a></p>${detailTable(
        [
          ['ຊື່ຜູ້ໃຊ້', '{{username}}'],
          ['ລິ້ງມີອາຍຸ', '{{expiresMinutes}} ນາທີ'],
        ],
      )}<p>ຖ້າກົດປຸ່ມບໍ່ໄດ້ ໃຫ້ຄັດລອກລິ້ງນີ້ໄປເປີດໃຊ້: {{resetUrl}}</p>`,
    ),
    bodyText: plainText('ຕັ້ງລະຫັດຜ່ານໃໝ່', [
      ['ຊື່ຜູ້ໃຊ້', '{{username}}'],
      ['ຕັ້ງລະຫັດຜ່ານໃໝ່ດ້ວຍລິ້ງນີ້', '{{resetUrl}}'],
      ['ລິ້ງມີອາຍຸ', '{{expiresMinutes}} ນາທີ'],
    ], 'ຖ້າທ່ານບໍ່ໄດ້ເປັນຄົນຮ້ອງຂໍ ບໍ່ຕ້ອງເຮັດຫຍັງກັບຂໍ້ຄວາມນີ້.'),
    variables: ['recipientName', 'username', 'resetUrl', 'expiresMinutes'],
  },
  {
    code: NotificationEventType.PAYMENT_REQUEST_SUBMITTED,
    subject: 'ຮັບຄຳຮ້ອງຊຳລະ {{requestNo}} ຂອງສິນເຊື່ອ {{loanCode}} ແລ້ວ',
    bodyHtml: layout(
      'ຮັບຄຳຮ້ອງຊຳລະ',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ເລກທີຄຳຮ້ອງ', '{{requestNo}}'],
        ['ປະເພດ', '{{purposeLabel}}'],
        ['ຈຳນວນ', '{{amount}}'],
        ['ວັນທີຮັບ', '{{receivedDate}}'],
        ['ສະຖານະ', '{{status}}'],
      ])}<p>ຈຳນວນນີ້ຈະບັນທຶກເຂົ້າບັນຊີຫຼັງຈາກຜູ້ມີອຳນາດຢືນຢັນ. ທ່ານຈະໄດ້ຮັບແຈ້ງເຕືອນອີກຄັ້ງເມື່ອຜ່ານການຢືນຢັນ.</p>`,
    ),
    bodyText: plainText('ຮັບຄຳຮ້ອງຊຳລະ', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ເລກທີຄຳຮ້ອງ', '{{requestNo}}'],
      ['ປະເພດ', '{{purposeLabel}}'],
      ['ຈຳນວນ', '{{amount}}'],
      ['ວັນທີຮັບ', '{{receivedDate}}'],
      ['ສະຖານະ', '{{status}}'],
    ], 'ຈຳນວນນີ້ຈະບັນທຶກເຂົ້າບັນຊີຫຼັງຈາກຜູ້ມີອຳນາດຢືນຢັນ.'),
    variables: [
      'recipientName',
      'loanCode',
      'requestNo',
      'purposeLabel',
      'amount',
      'receivedDate',
      'status',
    ],
  },
  {
    code: NotificationEventType.PAYMENT_REQUEST_APPROVED,
    subject: 'ຄຳຮ້ອງຊຳລະ {{requestNo}} ຂອງສິນເຊື່ອ {{loanCode}} ຢືນຢັນແລ້ວ',
    bodyHtml: layout(
      'ຄຳຮ້ອງຊຳລະຢືນຢັນແລ້ວ',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ເລກທີຄຳຮ້ອງ', '{{requestNo}}'],
        ['ຈຳນວນ', '{{amount}}'],
        ['ແບ່ງຊຳລະເປັນ', '{{allocation}}'],
        ['ຍອດທີ່ຍັງເຫຼືອ', '{{remaining}}'],
        ['ສະຖານະ', '{{status}}'],
      ])}<p>ການຢືນຢັນນີ້ຍັງບໍ່ແມ່ນການບັນທຶກເຂົ້າບັນຊີ. ຍອດໜີ້ຈະປ່ຽນແປງເມື່ອທາງຜູ້ເບິ່ງແຍງບັນທຶກຮຽບຮ້ອຍແລ້ວ, ແລະ ທ່ານຈະໄດ້ຮັບໃບຢັ້ງຢືນການຊຳລະອີກຄັ້ງ.</p>`,
    ),
    bodyText: plainText('ຄຳຮ້ອງຊຳລະຢືນຢັນແລ້ວ', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ເລກທີຄຳຮ້ອງ', '{{requestNo}}'],
      ['ຈຳນວນ', '{{amount}}'],
      ['ແບ່ງຊຳລະເປັນ', '{{allocation}}'],
      ['ຍອດທີ່ຍັງເຫຼືອ', '{{remaining}}'],
      ['ສະຖານະ', '{{status}}'],
    ], 'ການຢືນຢັນນີ້ຍັງບໍ່ແມ່ນການບັນທຶກເຂົ້າບັນຊີ. ທ່ານຈະໄດ້ຮັບໃບຢັ້ງຢືນການຊຳລະອີກຄັ້ງ.'),
    variables: [
      'recipientName',
      'loanCode',
      'requestNo',
      'amount',
      'allocation',
      'remaining',
      'status',
    ],
  },
  {
    code: NotificationEventType.PAYMENT_REQUEST_REJECTED,
    subject: 'ຄຳຮ້ອງຊຳລະ {{requestNo}} ຂອງສິນເຊື່ອ {{loanCode}} ບໍ່ຜ່ານການຢືນຢັນ',
    bodyHtml: layout(
      'ຄຳຮ້ອງຊຳລະບໍ່ຜ່ານການຢືນຢັນ',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ເລກທີຄຳຮ້ອງ', '{{requestNo}}'],
        ['ຈຳນວນ', '{{amount}}'],
        ['ເຫດຜົນ', '{{reason}}'],
      ])}<p>ຈຳນວນນີ້ຍັງບໍ່ໄດ້ບັນທຶກເຂົ້າບັນຊີໜີ້. ກະລຸນາຕິດຕໍ່ເຈົ້າໜ້າທີ່ເພື່ອແກ້ໄຂ ຫຼື ຍື່ນຄຳຮ້ອງໃໝ່.</p>`,
    ),
    bodyText: plainText('ຄຳຮ້ອງຊຳລະບໍ່ຜ່ານການຢືນຢັນ', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ເລກທີຄຳຮ້ອງ', '{{requestNo}}'],
      ['ຈຳນວນ', '{{amount}}'],
      ['ເຫດຜົນ', '{{reason}}'],
    ], 'ຈຳນວນນີ້ຍັງບໍ່ໄດ້ບັນທຶກເຂົ້າບັນຊີໜີ້. ກະລຸນາຕິດຕໍ່ເຈົ້າໜ້າທີ່ເພື່ອແກ້ໄຂ ຫຼື ຍື່ນຄຳຮ້ອງໃໝ່.'),
    variables: ['recipientName', 'loanCode', 'requestNo', 'amount', 'reason'],
  },
  {
    code: NotificationEventType.CREDIT_DEPOSITED,
    subject: 'ເພີ່ມເງິນເຂົ້າເຄຣດິດ {{amount}} ສຳລັບສິນເຊື່ອ {{loanCode}}',
    bodyHtml: layout(
      'ເງິນເຂົ້າເຄຣດິດລູກຄ້າ',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ຈຳນວນເພີ່ມ', '{{amount}}'],
        ['ເຄຣດິດຄົງເຫຼືອ', '{{creditBalance}}'],
        ['ວັນທີ', '{{depositedDate}}'],
        ['ໝາຍເຫດ', '{{note}}'],
      ])}<p>ເງິນສ່ວນນີ້ເກີນຍອດໜີ້ທີ່ຮອດຊຳລະແລ້ວ, ຈຶ່ງບັນທຶກເປັນເຄຣດິດຂອງທ່ານ. ລະບົບຈະນຳໄປຊຳລະງວດຖັດໄປເອງກ່ອນເຖິງກຳນົດ, ຫຼື ທ່ານສາມາດຂໍນຳໃຊ້ໄດ້ຕາມຂັ້ນຕອນ.</p>`,
    ),
    bodyText: plainText('ເງິນເຂົ້າເຄຣດິດລູກຄ້າ', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ຈຳນວນເພີ່ມ', '{{amount}}'],
      ['ເຄຣດິດຄົງເຫຼືອ', '{{creditBalance}}'],
      ['ວັນທີ', '{{depositedDate}}'],
      ['ໝາຍເຫດ', '{{note}}'],
    ], 'ເງິນສ່ວນນີ້ເກີນຍອດໜີ້ທີ່ຮອດຊຳລະ, ຈຶ່ງບັນທຶກເປັນເຄຣດິດ ແລະ ລະບົບຈະນຳໄປຊຳລະງວດຖັດໄປ.'),
    variables: [
      'recipientName',
      'loanCode',
      'amount',
      'creditBalance',
      'depositedDate',
      'note',
    ],
  },
  {
    code: NotificationEventType.AUTO_DEBIT_POSTED,
    subject: 'ຕັດຊຳລະງວດທີ {{instalment}} ຈາກເຄຣດິດ ສຳລັບສິນເຊື່ອ {{loanCode}}',
    bodyHtml: layout(
      'ຕັດຊຳລະອັດຕະໂນມັດຈາກເຄຣດິດ',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ງວດທີ', '{{instalment}}'],
        ['ຈຳນວນຕັດຊຳລະ', '{{amount}}'],
        ['ແບ່ງຊຳລະເປັນ', '{{allocation}}'],
        ['ວັນທີບັນທຶກ', '{{paidDate}}'],
        ['ຍອດທີ່ຍັງເຫຼືອ', '{{remaining}}'],
      ])}<p>ງວດນີ້ຖືກຊຳລະຈາກເຄຣດິດທີ່ທ່ານນຳເງິນເຂົ້າໄວ້, ບໍ່ມີການເອີ້ນເງິນໃໝ່. ຖ້າທ່ານບໍ່ເຫັນດີດ້ວຍ ກະລຸນາແຈ້ງຜູ້ເບິ່ງແຍງກ່ອນເຖິງກຳນົດຊຳລະ.</p>`,
    ),
    bodyText: plainText('ຕັດຊຳລະອັດຕະໂນມັດຈາກເຄຣດິດ', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ງວດທີ', '{{instalment}}'],
      ['ຈຳນວນຕັດຊຳລະ', '{{amount}}'],
      ['ແບ່ງຊຳລະເປັນ', '{{allocation}}'],
      ['ວັນທີບັນທຶກ', '{{paidDate}}'],
      ['ຍອດທີ່ຍັງເຫຼືອ', '{{remaining}}'],
    ], 'ງວດນີ້ຖືກຊຳລະຈາກເຄຣດິດທີ່ທ່ານນຳເງິນເຂົ້າໄວ້, ບໍ່ມີການເອີ້ນເງິນໃໝ່.'),
    variables: [
      'recipientName',
      'loanCode',
      'instalment',
      'amount',
      'allocation',
      'paidDate',
      'remaining',
    ],
  },
  {
    code: NotificationEventType.PENALTY_POSTED,
    subject: 'ບັນທຶກຄ່າປັບ {{amount}} ສຳລັບສິນເຊື່ອ {{loanCode}}',
    bodyHtml: layout(
      'ບັນທຶກຄ່າປັບ',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ຈຳນວນຄ່າປັບ', '{{amount}}'],
        ['ວັນທີບັນທຶກ', '{{postedDate}}'],
        ['ເຫດຜົນ', '{{reason}}'],
        ['ຍອດທີ່ຍັງເຫຼືອ', '{{remaining}}'],
      ])}<p>ຄ່າປັບນີ້ຜ່ານການອະນຸມັດຕາມຂັ້ນຕອນແລ້ວຈຶ່ງບັນທຶກເຂົ້າບັນຊີ. ຖ້າທ່ານເຫັນວ່າບໍ່ຖືກຕ້ອງ ກະລຸນາແຈ້ງຜູ້ເບິ່ງແຍງເພື່ອຕິດຕໍ່ທວງ.</p>`,
    ),
    bodyText: plainText('ບັນທຶກຄ່າປັບ', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ຈຳນວນຄ່າປັບ', '{{amount}}'],
      ['ວັນທີບັນທຶກ', '{{postedDate}}'],
      ['ເຫດຜົນ', '{{reason}}'],
      ['ຍອດທີ່ຍັງເຫຼືອ', '{{remaining}}'],
    ], 'ຄ່າປັບນີ້ຜ່ານການອະນຸມັດຕາມຂັ້ນຕອນຈຶ່ງບັນທຶກເຂົ້າບັນຊີ. ຖ້າບໍ່ຖືກຕ້ອງ ກະລຸນາແຈ້ງຜູ້ເບິ່ງແຍງ.'),
    variables: [
      'recipientName',
      'loanCode',
      'amount',
      'postedDate',
      'reason',
      'remaining',
    ],
  },
  {
    code: NotificationEventType.WAIVER_POSTED,
    subject: 'ຍົກເວັ້ນໜີ້ {{amount}} ສຳລັບສິນເຊື່ອ {{loanCode}}',
    bodyHtml: layout(
      'ຍົກເວັ້ນໜີ້',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ຈຳນວນທີ່ຍົກເວັ້ນ', '{{amount}}'],
        ['ຍົກເວັ້ນໃຫ້', '{{components}}'],
        ['ວັນທີບັນທຶກ', '{{postedDate}}'],
        ['ເຫດຜົນ', '{{reason}}'],
        ['ຍອດທີ່ຍັງເຫຼືອ', '{{remaining}}'],
      ])}<p>ຍອດທີ່ຖືກຍົກເວັ້ນແລ້ວຈະບໍ່ຖືກທວງຊຳລະອີກ. ໜີ້ສ່ວນທີ່ເຫຼືອຍັງຕ້ອງຊຳລະຕາມກຳນົດເດີມ.</p>`,
    ),
    bodyText: plainText('ຍົກເວັ້ນໜີ້', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ຈຳນວນທີ່ຍົກເວັ້ນ', '{{amount}}'],
      ['ຍົກເວັ້ນໃຫ້', '{{components}}'],
      ['ວັນທີບັນທຶກ', '{{postedDate}}'],
      ['ເຫດຜົນ', '{{reason}}'],
      ['ຍອດທີ່ຍັງເຫຼືອ', '{{remaining}}'],
    ], 'ຍອດທີ່ຍົກເວັ້ນແລ້ວຈະບໍ່ຖືກທວງຊຳລະອີກ. ໜີ້ສ່ວນທີ່ເຫຼືອຍັງຕ້ອງຊຳລະຕາມກຳນົດເດີມ.'),
    variables: [
      'recipientName',
      'loanCode',
      'amount',
      'components',
      'postedDate',
      'reason',
      'remaining',
    ],
  },
  {
    code: NotificationEventType.WRITE_OFF_POSTED,
    subject: 'ຕັດຈ່າຍໜີ້ {{amount}} ອອກຈາກບັນຊີ ສຳລັບສິນເຊື່ອ {{loanCode}}',
    bodyHtml: layout(
      'ຕັດຈ່າຍໜີ້ອອກຈາກບັນຊີ',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ຈຳນວນທີ່ຕັດຈ່າຍ', '{{amount}}'],
        ['ຕັດຈ່າຍສ່ວນ', '{{components}}'],
        ['ວັນທີບັນທຶກ', '{{postedDate}}'],
        ['ເຫດຜົນ', '{{reason}}'],
        ['ຍອດທີ່ຍັງເຫຼືອ', '{{remaining}}'],
      ])}<p>ການຕັດຈ່າຍນີ້ເປັນການຍ້າຍໜີ້ອອກຈາກບັນຊີເພື່ອບໍລິຫານ, ບໍ່ແມ່ນການຍົກເວັ້ນໜີ້. ສິດທາງທວງຊຳລະຂອງຜູ້ໃຫ້ກູ້ຍັງຄົງມີຕາມກົດໝາຍ.</p>`,
    ),
    bodyText: plainText('ຕັດຈ່າຍໜີ້ອອກຈາກບັນຊີ', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ຈຳນວນທີ່ຕັດຈ່າຍ', '{{amount}}'],
      ['ຕັດຈ່າຍສ່ວນ', '{{components}}'],
      ['ວັນທີບັນທຶກ', '{{postedDate}}'],
      ['ເຫດຜົນ', '{{reason}}'],
      ['ຍອດທີ່ຍັງເຫຼືອ', '{{remaining}}'],
    ], 'ການຕັດຈ່າຍນີ້ຍ້າຍໜີ້ອອກຈາກບັນຊີເພື່ອບໍລິຫານ, ບໍ່ແມ່ນການຍົກເວັ້ນໜີ້. ສິດທາງທວງຊຳລະຍັງຄົງມີຕາມກົດໝາຍ.'),
    variables: [
      'recipientName',
      'loanCode',
      'amount',
      'components',
      'postedDate',
      'reason',
      'remaining',
    ],
  },
  {
    code: NotificationEventType.CUSTOMER_REGISTERED,
    subject: 'ລົງທະບຽນລູກຄ້າໃໝ່ {{customerNumber}}',
    bodyHtml: layout(
      'ລົງທະບຽນລູກຄ້າໃໝ່',
      `<p>${GREETING}</p>${detailTable([
        ['ຊື່ລູກຄ້າ', '{{customerName}}'],
        ['ເລກທີ່ລູກຄ້າ', '{{customerNumber}}'],
        ['ໝາເບີໂທລະສັບ', '{{phone}}'],
        ['ອີເມວ', '{{email}}'],
        ['ສະຖານະເອກະສານ', '{{kycStatus}}'],
        ['ຜູ້ບັນທຶກ', '{{createdByName}}'],
        ['ວັນທີບັນທຶກ', '{{registeredDate}}'],
      ])}<p>ລູກຄ້າໃໝ່ຕ້ອງຜ່ານການກວດສອບເອກະສານ (KYC) ກ່ອນ, ຈຶ່ງສາມາດເຮັດສິນເຊື່ອໄດ້.</p>`,
    ),
    bodyText: plainText('ລົງທະບຽນລູກຄ້າໃໝ່', [
      ['ຊື່ລູກຄ້າ', '{{customerName}}'],
      ['ເລກທີ່ລູກຄ້າ', '{{customerNumber}}'],
      ['ໝາເບີໂທລະສັບ', '{{phone}}'],
      ['ອີເມວ', '{{email}}'],
      ['ສະຖານະເອກະສານ', '{{kycStatus}}'],
      ['ຜູ້ບັນທຶກ', '{{createdByName}}'],
      ['ວັນທີບັນທຶກ', '{{registeredDate}}'],
    ], 'ລູກຄ້າໃໝ່ຕ້ອງຜ່ານການກວດສອບເອກະສານ (KYC) ກ່ອນ, ຈຶ່ງສາມາດເຮັດສິນເຊື່ອໄດ້.'),
    variables: [
      'recipientName',
      'customerName',
      'customerNumber',
      'phone',
      'email',
      'kycStatus',
      'createdByName',
      'registeredDate',
    ],
  },
  {
    code: NotificationEventType.LOAN_PRODUCT_CREATED,
    subject: 'ມີຜະລິດຕະພັນສິນເຊື່ອໃໝ່ {{productCode}}',
    bodyHtml: layout(
      'ຜະລິດຕະພັນສິນເຊື່ອໃໝ່',
      `<p>${GREETING}</p>${detailTable([
        ['ລະຫັດຜະລິດຕະພັນ', '{{productCode}}'],
        ['ຊື່ຜະລິດຕະພັນ', '{{productName}}'],
        ['ອັດຕາດອກເບ້ຍ', '{{interestRate}}'],
        ['ວິທີຄິດໄລ່ດອກເບ້ຍ', '{{interestMethod}}'],
        ['ໄລຍະເວລາ', '{{term}}'],
        ['ສະກຸນເງິນ', '{{currency}}'],
        ['ຜູ້ເປີດໃຊ້', '{{createdByName}}'],
        ['ວັນທີເປີດໃຊ້', '{{createdDate}}'],
      ])}<p>ເງື່ອນໄຂຖືກບັນທຶກຕາມວັນເວລາປ່ອຍກູ້, ດັ່ງນັ້ນສິນເຊື່ອທີ່ເປີດກ່ອນໜ້ານີ້ຍັງໃຊ້ເງື່ອນໄຂເກົ່າຂອງຕົນ.</p>`,
    ),
    bodyText: plainText('ຜະລິດຕະພັນສິນເຊື່ອໃໝ່', [
      ['ລະຫັດຜະລິດຕະພັນ', '{{productCode}}'],
      ['ຊື່ຜະລິດຕະພັນ', '{{productName}}'],
      ['ອັດຕາດອກເບ້ຍ', '{{interestRate}}'],
      ['ວິທີຄິດໄລ່ດອກເບ້ຍ', '{{interestMethod}}'],
      ['ໄລຍະເວລາ', '{{term}}'],
      ['ສະກຸນເງິນ', '{{currency}}'],
      ['ຜູ້ເປີດໃຊ້', '{{createdByName}}'],
      ['ວັນທີເປີດໃຊ້', '{{createdDate}}'],
    ], 'ເງື່ອນໄຂຖືກບັນທຶກຕາມວັນເວລາປ່ອຍກູ້, ດັ່ງນັ້ນສິນເຊື່ອທີ່ເປີດກ່ອນໜ້ານີ້ຍັງໃຊ້ເງື່ອນໄຂເກົ່າຂອງຕົນ.'),
    variables: [
      'recipientName',
      'productCode',
      'productName',
      'interestRate',
      'interestMethod',
      'term',
      'currency',
      'createdByName',
      'createdDate',
    ],
  },
  {
    code: NotificationEventType.CUSTOMER_BANK_ACCOUNT_REGISTERED,
    subject: 'ລົງທະບຽນບັນຊີທະນາຄານຂອງລູກຄ້າ {{customerNumber}}',
    bodyHtml: layout(
      'ບັນຊີທະນາຄານຂອງລູກຄ້າ',
      `<p>${GREETING}</p>${detailTable([
        ['ຊື່ລູກຄ້າ', '{{customerName}}'],
        ['ເລກທີ່ລູກຄ້າ', '{{customerNumber}}'],
        ['ຊື່ທະນາຄານ', '{{bankName}}'],
        ['ເລກທີ່ບັນຊີ', '{{accountNumberMasked}}'],
        ['ຊື່ເຈົ້າຂອງບັນຊີ', '{{accountHolderName}}'],
        ['ສະຖານະບັນຊີ', '{{accountStatus}}'],
        ['ຜູ້ບັນທຶກ', '{{createdByName}}'],
        ['ວັນທີບັນທຶກ', '{{registeredDate}}'],
      ])}<p>ກະລຸນາກວດເບິ່ງເອກະສານຢັ້ງຢືນເລກທີ່ບັນຊີກ່ອນໃຊ້ງານ. ລະບົບສະແດງສະເພາະສີ່ຫຼັກສຸດທ້າຍ.</p>`,
    ),
    bodyText: plainText('ບັນຊີທະນາຄານຂອງລູກຄ້າ', [
      ['ຊື່ລູກຄ້າ', '{{customerName}}'],
      ['ເລກທີ່ລູກຄ້າ', '{{customerNumber}}'],
      ['ຊື່ທະນາຄານ', '{{bankName}}'],
      ['ເລກທີ່ບັນຊີ', '{{accountNumberMasked}}'],
      ['ຊື່ເຈົ້າຂອງບັນຊີ', '{{accountHolderName}}'],
      ['ສະຖານະບັນຊີ', '{{accountStatus}}'],
      ['ຜູ້ບັນທຶກ', '{{createdByName}}'],
      ['ວັນທີບັນທຶກ', '{{registeredDate}}'],
    ], 'ກະລຸນາກວດເບິ່ງເອກະສານຢັ້ງຢືນເລກທີ່ບັນຊີກ່ອນໃຊ້ງານ. ລະບົບສະແດງສະເພາະສີ່ຫຼັກສຸດທ້າຍ.'),
    variables: [
      'recipientName',
      'customerName',
      'customerNumber',
      'bankName',
      'accountNumberMasked',
      'accountHolderName',
      'accountStatus',
      'createdByName',
      'registeredDate',
    ],
  },
  {
    code: NotificationEventType.LOAN_DISBURSEMENT_EVIDENCE_UPLOADED,
    subject: 'ມີຫຼັກຖານການຈ່າຍເງິນກູ້ {{loanCode}}',
    bodyHtml: layout(
      'ຫຼັກຖານການຈ່າຍເງິນກູ້',
      `<p>${GREETING}</p>${detailTable([
        ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
        ['ຊື່ລູກຄ້າ', '{{customerName}}'],
        ['ຊ່ອງທາງຮັບເງິນ', '{{channel}}'],
        ['ບັນຊີຮັບເງິນ', '{{accountNumberMasked}}'],
        ['ຊື່ເອກະສານ', '{{fileName}}'],
        ['ຜູ້ອັບໂຫຼດ', '{{uploadedByName}}'],
        ['ວັນທີອັບໂຫຼດ', '{{uploadedDate}}'],
      ])}<p>ເງິນກູ້ຖືກບັນທຶກໄປຕາມວັນທີຜ່ອນກູ້ແລ້ວ, ເອກະສານນີ້ເປັນຫຼັກຖານການຈ່າຍເງິນເທົ່ານັ້ນ.</p>`,
    ),
    bodyText: plainText('ຫຼັກຖານການຈ່າຍເງິນກູ້', [
      ['ເລກທີ່ສິນເຊື່ອ', '{{loanCode}}'],
      ['ຊື່ລູກຄ້າ', '{{customerName}}'],
      ['ຊ່ອງທາງຮັບເງິນ', '{{channel}}'],
      ['ບັນຊີຮັບເງິນ', '{{accountNumberMasked}}'],
      ['ຊື່ເອກະສານ', '{{fileName}}'],
      ['ຜູ້ອັບໂຫຼດ', '{{uploadedByName}}'],
      ['ວັນທີອັບໂຫຼດ', '{{uploadedDate}}'],
    ], 'ເງິນກູ້ຖືກບັນທຶກໄປຕາມວັນທີຜ່ອນກູ້ແລ້ວ, ເອກະສານນີ້ເປັນຫຼັກຖານການຈ່າຍເງິນເທົ່ານັ້ນ.'),
    variables: [
      'recipientName',
      'loanCode',
      'customerName',
      'channel',
      'accountNumberMasked',
      'fileName',
      'uploadedByName',
      'uploadedDate',
    ],
  },
];

/** Every placeholder key a template uses, so the admin UI can list them. */
function extractKeys(body: string): string[] {
  return [...body.matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g)].map((m) => m[1]);
}

/** Idempotent seed: inserts only the codes that are not configured yet. */
export async function seedEmailTemplates(em: EntityManager): Promise<number> {
  const existing = await em.find(EmailTemplate, { where: { locale: TEMPLATE_LOCALE } });
  const configured = new Set(existing.map((t) => t.code));
  let inserted = 0;
  for (const seed of DEFAULT_TEMPLATES) {
    if (configured.has(seed.code)) continue;
    await em.save(
      em.create(EmailTemplate, {
        ...seed,
        locale: TEMPLATE_LOCALE,
        isActive: true,
        updatedBy: null,
      }),
    );
    inserted += 1;
  }
  return inserted;
}

/** Requested locale first, then the fallback locale, then any active row for the code. */
export async function findActiveTemplate(
  em: EntityManager,
  code: NotificationEventType,
  locale: string,
): Promise<EmailTemplate | null> {
  const exact = await em.findOne(EmailTemplate, { where: { code, locale, isActive: true } });
  if (exact) return exact;
  const fallback = await em.findOne(EmailTemplate, {
    where: { code, locale: FALLBACK_TEMPLATE_LOCALE, isActive: true },
  });
  if (fallback) return fallback;
  return em.findOne(EmailTemplate, { where: { code, isActive: true } });
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ((
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
      )[char]),
  );
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Replaces `{{key}}` placeholders. HTML output is escaped so payload text can't inject markup. */
export function renderEmail(template: EmailTemplate, payload: Record<string, unknown>): RenderedEmail {
  const fill = (raw: string, sanitize: (value: string) => string): string =>
    raw.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_match, key: string) =>
      sanitize(asText(payload[key])),
    );

  return {
    subject: fill(template.subject, (value) => value),
    html: fill(template.bodyHtml, escapeHtml),
    text: fill(template.bodyText, (value) => value),
  };
}

/** Admins edit markup, but never scripts or event handlers. */
export function assertTemplateMarkupSafe(bodyHtml: string): void {
  const forbidden = [/<\s*script/i, /<\s*iframe/i, /\son[a-z]+\s*=/i, /javascript\s*:/i];
  if (forbidden.some((pattern) => pattern.test(bodyHtml))) {
    throw unprocessable('Email markup may not contain scripts, iframes or event handlers');
  }
}

/** Placeholders referenced in the body must be declared, so the UI stays honest. */
export function declaredVariablesOf(template: Pick<EmailTemplate, 'subject' | 'bodyHtml' | 'bodyText'>): string[] {
  return [...new Set([
    ...extractKeys(template.subject),
    ...extractKeys(template.bodyHtml),
    ...extractKeys(template.bodyText),
  ])].sort();
}
