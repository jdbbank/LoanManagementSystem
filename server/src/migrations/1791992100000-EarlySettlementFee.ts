import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Early-settlement fee (a percent of the principal still owed, taken when the whole debt is paid
 * before the last instalment falls due). Three additive columns, all defaulting to 0:
 * the product's setting, the same number frozen onto the loan at disbursement, and the amount the
 * agreement actually charged. Every existing product, loan and agreement is a no-fee one, which is
 * exactly what the default says, so nothing needs backfilling.
 */
export class EarlySettlementFee1791992100000 implements MigrationInterface {
    name = 'EarlySettlementFee1791992100000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`loan_products\` ADD \`earlySettlementFeePercent\` decimal(9,4) NOT NULL DEFAULT '0.0000'`);
        await queryRunner.query(`ALTER TABLE \`loans\` ADD \`earlySettlementFeePercent\` decimal(9,4) NOT NULL DEFAULT '0.0000'`);
        await queryRunner.query(`ALTER TABLE \`settlement_agreements\` ADD \`earlySettlementFee\` decimal(18,2) NOT NULL DEFAULT '0.00'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`settlement_agreements\` DROP COLUMN \`earlySettlementFee\``);
        await queryRunner.query(`ALTER TABLE \`loans\` DROP COLUMN \`earlySettlementFeePercent\``);
        await queryRunner.query(`ALTER TABLE \`loan_products\` DROP COLUMN \`earlySettlementFeePercent\``);
    }

}
