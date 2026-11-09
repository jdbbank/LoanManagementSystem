import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * What a payment request is for (locked section 4 stays untouched): PAY_DEBT settles instalments that
 * have arrived, DEPOSIT_TO_CREDIT books cash against no debt. Existing rows are all ordinary payments,
 * which is exactly what the default says, so the column is additive and no backfill is needed.
 */
export class PaymentRequestPurpose1791989323928 implements MigrationInterface {
    name = 'PaymentRequestPurpose1791989323928'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`payment_requests\` ADD \`purpose\` enum ('PAY_DEBT', 'DEPOSIT_TO_CREDIT') NOT NULL DEFAULT 'PAY_DEBT'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`payment_requests\` DROP COLUMN \`purpose\``);
    }

}
