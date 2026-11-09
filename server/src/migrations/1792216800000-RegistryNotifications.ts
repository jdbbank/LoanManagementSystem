import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Registration events that happen before any loan exists: a customer record is opened, and an ADMIN
 * publishes a new loan product. Both used to be audit-only, so the people who must act next — the
 * approver who reviews the documents, the staff whose products change — heard nothing.
 *
 * Same widening rule as MoneyNotifications: `NotificationEventType` only gains members at the end, so
 * every stored value keeps its position and each change is `MODIFY`. A generated `DROP`/`ADD` pair
 * would shorten the UNIQUE (code, locale) index on `email_templates` to locale alone — which the
 * existing template rows violate — and would rewrite `notification_outbox.type` history.
 */
export class RegistryNotifications1792216800000 implements MigrationInterface {
    name = 'RegistryNotifications1792216800000'

    private static readonly WIDENED = `'LOAN_APPLICATION_SUBMITTED', 'LOAN_APPROVED', 'LOAN_REJECTED', 'PAYMENT_POSTED', 'SETTLEMENT_REQUESTED', 'SETTLEMENT_DECIDED', 'PARTY_REGISTERED', 'PARTY_RELEASED', 'RESTRUCTURE_REQUESTED', 'RESTRUCTURE_DECIDED', 'RESTRUCTURE_APPLIED', 'USER_CREATED', 'PASSWORD_RESET_OTP', 'PASSWORD_RESET_LINK', 'PAYMENT_REQUEST_SUBMITTED', 'PAYMENT_REQUEST_APPROVED', 'PAYMENT_REQUEST_REJECTED', 'CREDIT_DEPOSITED', 'AUTO_DEBIT_POSTED', 'PENALTY_POSTED', 'WAIVER_POSTED', 'WRITE_OFF_POSTED', 'CUSTOMER_REGISTERED', 'LOAN_PRODUCT_CREATED'`;

    // Exactly the members MoneyNotifications left behind — what a revert narrows back to.
    private static readonly PREVIOUS = `'LOAN_APPLICATION_SUBMITTED', 'LOAN_APPROVED', 'LOAN_REJECTED', 'PAYMENT_POSTED', 'SETTLEMENT_REQUESTED', 'SETTLEMENT_DECIDED', 'PARTY_REGISTERED', 'PARTY_RELEASED', 'RESTRUCTURE_REQUESTED', 'RESTRUCTURE_DECIDED', 'RESTRUCTURE_APPLIED', 'USER_CREATED', 'PASSWORD_RESET_OTP', 'PASSWORD_RESET_LINK', 'PAYMENT_REQUEST_SUBMITTED', 'PAYMENT_REQUEST_APPROVED', 'PAYMENT_REQUEST_REJECTED', 'CREDIT_DEPOSITED', 'AUTO_DEBIT_POSTED', 'PENALTY_POSTED', 'WAIVER_POSTED', 'WRITE_OFF_POSTED'`;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`email_templates\` MODIFY \`code\` enum (${RegistryNotifications1792216800000.WIDENED}) NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`notification_outbox\` MODIFY \`type\` enum (${RegistryNotifications1792216800000.WIDENED}) NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`notification_outbox\` MODIFY \`type\` enum (${RegistryNotifications1792216800000.PREVIOUS}) NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`email_templates\` MODIFY \`code\` enum (${RegistryNotifications1792216800000.PREVIOUS}) NOT NULL`);
    }
}
