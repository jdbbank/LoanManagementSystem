import { describe, expect, it } from 'vitest';
import { NotificationOutbox } from '../entities/notification-outbox.entity';
import { NotificationEventType, NotificationStatus } from '../entities/types';
import { seal, sealJson } from '../utils/seal';
import { SECRET_EVENT_TYPES, toNotificationEvent } from './notification.service';

const row = (type: NotificationEventType, subject: string): NotificationOutbox =>
  ({
    id: '00000000-0000-0000-0000-000000000001',
    type,
    recipientEmail: 'maker1@bank.la',
    recipientName: 'Maker One',
    locale: 'lo',
    subject,
    bodyHtml: seal('<p>body</p>'),
    bodyText: seal('body'),
    payload: sealJson({ otp: '482913' }),
    status: NotificationStatus.PENDING,
    attempts: 0,
    lastError: null,
    nextRetryAt: null,
    sentAt: null,
    customerId: null,
    loanId: null,
    userId: null,
    createdAt: new Date('2026-10-14T04:00:00.000Z'),
    updatedAt: new Date('2026-10-14T04:00:00.000Z'),
  }) as NotificationOutbox;

describe('notification outbox subject at rest', () => {
  it('treats the two reset event types as the ones carrying a secret', () => {
    expect([...SECRET_EVENT_TYPES].sort()).toEqual(['PASSWORD_RESET_LINK', 'PASSWORD_RESET_OTP']);
  });

  it('opens a sealed subject so the mailer still sends the real code', () => {
    const plain = 'ເລກຢືນຢັນ 482913 ສຳລັບການຕັ້ງລະຫັດຜ່ານໃໝ່';
    const event = toNotificationEvent(row(NotificationEventType.PASSWORD_RESET_OTP, seal(plain)));
    expect(event.subject).toBe(plain);
  });

  it('leaves an ordinary email subject readable', () => {
    const event = toNotificationEvent(row(NotificationEventType.LOAN_APPROVED, 'ຜ່ານການອະນຸມັດແລ້ວ'));
    expect(event.subject).toBe('ຜ່ານການອະນຸມັດແລ້ວ');
  });

  it('still reads rows written before subject sealing existed', () => {
    const legacy = row(NotificationEventType.PASSWORD_RESET_OTP, 'ເລກຢືນຢັນ 123456');
    expect(toNotificationEvent(legacy).subject).toBe('ເລກຢືນຢັນ 123456');
  });
});
