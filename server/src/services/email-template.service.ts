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
