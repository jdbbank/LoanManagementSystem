import { describe, expect, it } from 'vitest';
import { EmailTemplate } from '../entities/email-template.entity';
import { NotificationEventType } from '../entities/types';
import {
  assertTemplateMarkupSafe,
  declaredVariablesOf,
  DEFAULT_TEMPLATES,
  renderEmail,
} from './email-template.service';

const template = (overrides: Partial<EmailTemplate>): EmailTemplate =>
  ({
    subject: 'subject',
    bodyHtml: '<p>html</p>',
    bodyText: 'text',
    ...overrides,
  }) as EmailTemplate;

describe('email templates', () => {
  it('covers every notification event type exactly once', () => {
    const codes = DEFAULT_TEMPLATES.map((t) => t.code);
    for (const type of Object.values(NotificationEventType)) {
      expect(codes.filter((c) => c === type)).toHaveLength(1);
    }
    expect(codes).toHaveLength(Object.values(NotificationEventType).length);
  });

  it('declares only the placeholders its body really uses', () => {
    for (const seed of DEFAULT_TEMPLATES) {
      expect(declaredVariablesOf(seed)).toEqual([...seed.variables].sort());
    }
  });
});

describe('renderEmail', () => {
  it('substitutes every placeholder occurrence', () => {
    const rendered = renderEmail(
      template({ subject: 'LN {{loanCode}}', bodyText: '{{loanCode}} / {{loanCode}}', bodyHtml: '<b>{{amount}}</b>' }),
      { loanCode: 'LN-000001', amount: '1 000 LAK' },
    );
    expect(rendered.subject).toBe('LN LN-000001');
    expect(rendered.text).toBe('LN-000001 / LN-000001');
    expect(rendered.html).toBe('<b>1 000 LAK</b>');
  });

  it('escapes payload text in the HTML body but keeps the plain text intact', () => {
    const rendered = renderEmail(
      template({ bodyHtml: '<p>{{reason}}</p>', bodyText: '{{reason}}' }),
      { reason: '<script>alert(1)</script>' },
    );
    expect(rendered.html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(rendered.text).toBe('<script>alert(1)</script>');
  });

  it('turns missing and null values into empty strings', () => {
    const rendered = renderEmail(template({ bodyText: '[{{amount}}][{{note}}]' }), { note: null });
    expect(rendered.text).toBe('[][]');
  });
});

describe('assertTemplateMarkupSafe', () => {
  it.each([
    '<script>fetch()</script>',
    '<IFRAME src="x"></IFRAME>',
    '<a onclick="steal()">x</a>',
    '<a href="javascript:steal()">x</a>',
  ])('rejects %s', (markup) => {
    expect(() => assertTemplateMarkupSafe(markup)).toThrow();
  });

  it('accepts a normal styled table', () => {
    expect(() =>
      assertTemplateMarkupSafe('<table><tr><td style="padding:6px">x</td></tr></table>'),
    ).not.toThrow();
  });
});
