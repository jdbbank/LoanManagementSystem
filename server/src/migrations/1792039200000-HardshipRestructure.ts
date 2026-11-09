import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Hardship lending support: the people standing behind a loan (guarantors, a replacement payer), the
 * property pledged against it, and the addendum that rewrites its terms when the borrower can no longer
 * pay.
 *
 * All three tables are new, so no existing row needs a value. The three widened enums only ever gain
 * members: a MySQL enum column accepts what it accepted before, so existing workflows, outbox rows and
 * templates are untouched and nothing is rewritten.
 *
 * That is why each widening is `MODIFY`, not the `DROP`/`ADD` TypeORM emits when a migration is
 * generated: dropping `email_templates.code` would shorten its UNIQUE (code, locale) index to locale
 * alone, which every existing template row violates, and dropping `approval_workflows.subjectType`
 * would reset the whole history to the first enum member.
 *
 * Index names are the ones TypeORM derives from `sha1(table + "_" + sorted columns)` — written here by
 * hand so `npm run db:schema:diff` reports the database as up to date instead of offering to rename them.
 */
export class HardshipRestructure1792039200000 implements MigrationInterface {
    name = 'HardshipRestructure1792039200000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`loan_parties\` (\`id\` varchar(36) NOT NULL, \`loanId\` varchar(255) NOT NULL, \`customerId\` varchar(255) NOT NULL, \`role\` enum ('GUARANTOR', 'PAYER') NOT NULL, \`status\` enum ('ACTIVE', 'RELEASED') NOT NULL DEFAULT 'ACTIVE', \`engagedAt\` datetime NOT NULL, \`relationship\` varchar(64) NULL, \`note\` text NULL, \`createdBy\` varchar(255) NOT NULL, \`releasedAt\` datetime NULL, \`releaseReason\` text NULL, \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`IDX_12b4c8d609e6feee37bf147d62\` (\`loanId\`), INDEX \`IDX_a93cd41d48581e280f689c8274\` (\`customerId\`), UNIQUE INDEX \`IDX_a38ed1192e6d5c617e1ce3d64d\` (\`loanId\`, \`customerId\`, \`role\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`loan_collaterals\` (\`id\` varchar(36) NOT NULL, \`loanId\` varchar(255) NOT NULL, \`ownerCustomerId\` varchar(255) NULL, \`type\` enum ('LAND', 'BUILDING', 'VEHICLE', 'DEPOSIT', 'EQUIPMENT', 'GOLD', 'OTHER') NOT NULL, \`status\` enum ('PLEDGED', 'RELEASED') NOT NULL DEFAULT 'PLEDGED', \`description\` varchar(255) NOT NULL, \`certificateNo\` varchar(64) NULL, \`appraisedValue\` decimal(18,2) NOT NULL DEFAULT '0.00', \`valuedAt\` date NOT NULL, \`note\` text NULL, \`createdBy\` varchar(255) NOT NULL, \`releasedAt\` datetime NULL, \`releaseReason\` text NULL, \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`IDX_35ceb768ef6aac28c24c39617d\` (\`loanId\`), INDEX \`IDX_c52700c5fb215cda321521b08a\` (\`loanId\`, \`status\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`restructure_requests\` (\`id\` varchar(36) NOT NULL, \`requestNo\` varchar(32) NOT NULL, \`loanId\` varchar(255) NOT NULL, \`customerId\` varchar(255) NOT NULL, \`status\` enum ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'APPLIED') NOT NULL DEFAULT 'PENDING_APPROVAL', \`hardshipReason\` text NOT NULL, \`changeTypes\` text NOT NULL, \`newInterestRate\` decimal(18,6) NULL DEFAULT '0.000000', \`newTermMonths\` int NULL, \`newPayerCustomerId\` varchar(255) NULL, \`interestReliefAmount\` decimal(18,2) NOT NULL DEFAULT '0.00', \`repricingAmount\` decimal(18,2) NOT NULL DEFAULT '0.00', \`currency\` varchar(3) NOT NULL DEFAULT 'LAK', \`beforeTerms\` text NOT NULL, \`afterTerms\` text NOT NULL, \`collateralSnapshot\` text NULL, \`waiverTransactionId\` varchar(255) NULL, \`createdBy\` varchar(255) NOT NULL, \`decidedBy\` varchar(255) NULL, \`decidedAt\` datetime NULL, \`decisionReason\` text NULL, \`appliedBy\` varchar(255) NULL, \`appliedAt\` datetime NULL, \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX \`IDX_ae012f76fa85ae5502bf07b855\` (\`requestNo\`), INDEX \`IDX_a0ec3cbcc27b8d95c19c112fee\` (\`loanId\`), INDEX \`IDX_49c8a63c27ff67a518610237f0\` (\`status\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);

        await queryRunner.query(`ALTER TABLE \`approval_workflows\` MODIFY \`subjectType\` enum ('FINANCIAL_TRANSACTION', 'SETTLEMENT_AGREEMENT', 'RESTRUCTURE_REQUEST') NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`email_templates\` MODIFY \`code\` enum ('LOAN_APPLICATION_SUBMITTED', 'LOAN_APPROVED', 'LOAN_REJECTED', 'PAYMENT_POSTED', 'SETTLEMENT_REQUESTED', 'SETTLEMENT_DECIDED', 'PARTY_REGISTERED', 'PARTY_RELEASED', 'RESTRUCTURE_REQUESTED', 'RESTRUCTURE_DECIDED', 'RESTRUCTURE_APPLIED', 'USER_CREATED', 'PASSWORD_RESET_OTP', 'PASSWORD_RESET_LINK') NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`notification_outbox\` MODIFY \`type\` enum ('LOAN_APPLICATION_SUBMITTED', 'LOAN_APPROVED', 'LOAN_REJECTED', 'PAYMENT_POSTED', 'SETTLEMENT_REQUESTED', 'SETTLEMENT_DECIDED', 'PARTY_REGISTERED', 'PARTY_RELEASED', 'RESTRUCTURE_REQUESTED', 'RESTRUCTURE_DECIDED', 'RESTRUCTURE_APPLIED', 'USER_CREATED', 'PASSWORD_RESET_OTP', 'PASSWORD_RESET_LINK') NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Narrowing these enums is safe only while no row carries a new member; a row that does makes
        // MySQL refuse the ALTER in strict mode, so a reverted database either looks exactly like it did
        // or the revert fails and says why. The tables below are created and dropped together with them.
        await queryRunner.query(`ALTER TABLE \`notification_outbox\` MODIFY \`type\` enum ('LOAN_APPLICATION_SUBMITTED', 'LOAN_APPROVED', 'LOAN_REJECTED', 'PAYMENT_POSTED', 'SETTLEMENT_REQUESTED', 'SETTLEMENT_DECIDED', 'USER_CREATED', 'PASSWORD_RESET_OTP', 'PASSWORD_RESET_LINK') NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`email_templates\` MODIFY \`code\` enum ('LOAN_APPLICATION_SUBMITTED', 'LOAN_APPROVED', 'LOAN_REJECTED', 'PAYMENT_POSTED', 'SETTLEMENT_REQUESTED', 'SETTLEMENT_DECIDED', 'USER_CREATED', 'PASSWORD_RESET_OTP', 'PASSWORD_RESET_LINK') NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`approval_workflows\` MODIFY \`subjectType\` enum ('FINANCIAL_TRANSACTION', 'SETTLEMENT_AGREEMENT') NOT NULL`);

        await queryRunner.query(`DROP TABLE \`restructure_requests\``);
        await queryRunner.query(`DROP TABLE \`loan_collaterals\``);
        await queryRunner.query(`DROP TABLE \`loan_parties\``);
    }

}
