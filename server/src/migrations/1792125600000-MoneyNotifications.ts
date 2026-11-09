import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Collection and ledger events: a payment request now announces itself at every step a person takes
 * (submitted, verified, rejected), money landed as customer credit gets its own receipt, the
 * auto-debit job announces the instalment it settled, and PENALTY / WAIVER / WRITE_OFF post under a
 * notice of their own instead of staying silent.
 *
 * `NotificationEventType` only ever gains members, and it appends them, so every existing enum column
 * value keeps its position. That is why each widening is `MODIFY`, not the `DROP`/`ADD` TypeORM emits
 * when a migration is generated: dropping `email_templates.code` would shorten its UNIQUE (code,
 * locale) index to locale alone, which every existing template row violates, and dropping
 * `notification_outbox.type` would rewrite the whole send history to the first enum member.
 */
export class MoneyNotifications1792125600000 implements MigrationInterface {
    name = 'MoneyNotifications1792125600000'

    private static readonly WIDENED = `'LOAN_APPLICATION_SUBMITTED', 'LOAN_APPROVED', 'LOAN_REJECTED', 'PAYMENT_POSTED', 'SETTLEMENT_REQUESTED', 'SETTLEMENT_DECIDED', 'PARTY_REGISTERED', 'PARTY_RELEASED', 'RESTRUCTURE_REQUESTED', 'RESTRUCTURE_DECIDED', 'RESTRUCTURE_APPLIED', 'USER_CREATED', 'PASSWORD_RESET_OTP', 'PASSWORD_RESET_LINK', 'PAYMENT_REQUEST_SUBMITTED', 'PAYMENT_REQUEST_APPROVED', 'PAYMENT_REQUEST_REJECTED', 'CREDIT_DEPOSITED', 'AUTO_DEBIT_POSTED', 'PENALTY_POSTED', 'WAIVER_POSTED', 'WRITE_OFF_POSTED'`;

    // Exactly the members HardshipRestructure left behind — what a revert narrows back to.
    private static readonly PREVIOUS = `'LOAN_APPLICATION_SUBMITTED', 'LOAN_APPROVED', 'LOAN_REJECTED', 'PAYMENT_POSTED', 'SETTLEMENT_REQUESTED', 'SETTLEMENT_DECIDED', 'PARTY_REGISTERED', 'PARTY_RELEASED', 'RESTRUCTURE_REQUESTED', 'RESTRUCTURE_DECIDED', 'RESTRUCTURE_APPLIED', 'USER_CREATED', 'PASSWORD_RESET_OTP', 'PASSWORD_RESET_LINK'`;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`email_templates\` MODIFY \`code\` enum (${MoneyNotifications1792125600000.WIDENED}) NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`notification_outbox\` MODIFY \`type\` enum (${MoneyNotifications1792125600000.WIDENED}) NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Narrowing is safe only while no row carries a new member; a row that does makes MySQL refuse
        // the ALTER in strict mode, so a reverted database either looks exactly like it did before or
        // the revert fails and says why.
        await queryRunner.query(`ALTER TABLE \`notification_outbox\` MODIFY \`type\` enum (${MoneyNotifications1792125600000.PREVIOUS}) NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`email_templates\` MODIFY \`code\` enum (${MoneyNotifications1792125600000.PREVIOUS}) NOT NULL`);
    }

}
