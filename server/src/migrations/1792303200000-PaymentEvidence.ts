import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Money evidence: the account a customer receives money through, the document that proves the account
 * is theirs, and the transfer slip or cash receipt that proves disbursed money actually arrived.
 *
 * The three tables are new and the three loan columns are nullable, so nothing existing needs a value:
 * a loan that predates this release simply has no recorded channel, which is honest — "we assume it was
 * a transfer" is exactly what the slip exists to prove.
 *
 * The two notification enums only gain members at the end, same widening rule as RegistryNotifications,
 * so every stored value keeps its position. A generated `DROP`/`ADD` pair would shorten the UNIQUE
 * (code, locale) index on `email_templates` to locale alone — which the existing template rows violate —
 * and would rewrite `notification_outbox.type` history.
 *
 * Index names are TypeORM's own: `IDX_` + the first 26 characters of sha1 over `<table>_<columns>` with
 * the column names sorted alphabetically (the DDL lists them in declared order). Written by hand so
 * `npm run db:schema:diff` reports the database as up to date instead of offering to rename them.
 */
export class PaymentEvidence1792303200000 implements MigrationInterface {
    name = 'PaymentEvidence1792303200000'

    private static readonly WIDENED = `'LOAN_APPLICATION_SUBMITTED', 'LOAN_APPROVED', 'LOAN_REJECTED', 'PAYMENT_POSTED', 'SETTLEMENT_REQUESTED', 'SETTLEMENT_DECIDED', 'PARTY_REGISTERED', 'PARTY_RELEASED', 'RESTRUCTURE_REQUESTED', 'RESTRUCTURE_DECIDED', 'RESTRUCTURE_APPLIED', 'USER_CREATED', 'PASSWORD_RESET_OTP', 'PASSWORD_RESET_LINK', 'PAYMENT_REQUEST_SUBMITTED', 'PAYMENT_REQUEST_APPROVED', 'PAYMENT_REQUEST_REJECTED', 'CREDIT_DEPOSITED', 'AUTO_DEBIT_POSTED', 'PENALTY_POSTED', 'WAIVER_POSTED', 'WRITE_OFF_POSTED', 'CUSTOMER_REGISTERED', 'LOAN_PRODUCT_CREATED', 'CUSTOMER_BANK_ACCOUNT_REGISTERED', 'LOAN_DISBURSEMENT_EVIDENCE_UPLOADED'`;

    // Exactly the members RegistryNotifications left behind — what a revert narrows back to.
    private static readonly PREVIOUS = `'LOAN_APPLICATION_SUBMITTED', 'LOAN_APPROVED', 'LOAN_REJECTED', 'PAYMENT_POSTED', 'SETTLEMENT_REQUESTED', 'SETTLEMENT_DECIDED', 'PARTY_REGISTERED', 'PARTY_RELEASED', 'RESTRUCTURE_REQUESTED', 'RESTRUCTURE_DECIDED', 'RESTRUCTURE_APPLIED', 'USER_CREATED', 'PASSWORD_RESET_OTP', 'PASSWORD_RESET_LINK', 'PAYMENT_REQUEST_SUBMITTED', 'PAYMENT_REQUEST_APPROVED', 'PAYMENT_REQUEST_REJECTED', 'CREDIT_DEPOSITED', 'AUTO_DEBIT_POSTED', 'PENALTY_POSTED', 'WAIVER_POSTED', 'WRITE_OFF_POSTED', 'CUSTOMER_REGISTERED', 'LOAN_PRODUCT_CREATED'`;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`customer_bank_accounts\` (\`id\` varchar(36) NOT NULL, \`customerId\` varchar(255) NOT NULL, \`bankName\` varchar(128) NOT NULL, \`accountNumber\` varchar(64) NOT NULL, \`accountHolderName\` varchar(191) NOT NULL, \`branch\` varchar(128) NULL, \`isPrimary\` tinyint NOT NULL DEFAULT 0, \`status\` enum ('ACTIVE', 'CLOSED') NOT NULL DEFAULT 'ACTIVE', \`note\` text NULL, \`createdBy\` varchar(255) NOT NULL, \`closedAt\` datetime NULL, \`closeReason\` text NULL, \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`IDX_06b2c2eb1bf1b4efaf4d508ec7\` (\`customerId\`), UNIQUE INDEX \`IDX_53e11a02a142e4967b3b389031\` (\`customerId\`, \`accountNumber\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`evidence_documents\` (\`id\` varchar(36) NOT NULL, \`ownerType\` enum ('CUSTOMER', 'LOAN') NOT NULL, \`ownerId\` varchar(255) NOT NULL, \`kind\` enum ('BANK_ACCOUNT_PROOF', 'DISBURSEMENT_SLIP') NOT NULL, \`bankAccountId\` varchar(255) NULL, \`fileName\` varchar(255) NOT NULL, \`mimeType\` varchar(100) NOT NULL, \`sizeBytes\` int NOT NULL, \`checksum\` varchar(64) NOT NULL, \`note\` text NULL, \`uploadedBy\` varchar(255) NOT NULL, \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX \`IDX_e26c36db6250fe5e25d18e0617\` (\`bankAccountId\`), INDEX \`IDX_5de8d583f5d498866affe98e2c\` (\`kind\`), INDEX \`IDX_d3351a0a805f66793d14a36f57\` (\`ownerType\`, \`ownerId\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`evidence_document_contents\` (\`documentId\` varchar(255) NOT NULL, \`data\` longblob NOT NULL, \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (\`documentId\`)) ENGINE=InnoDB`);

        await queryRunner.query(`ALTER TABLE \`loans\` ADD \`disbursementChannel\` enum ('BANK', 'CASH') NULL`);
        await queryRunner.query(`ALTER TABLE \`loans\` ADD \`disbursementBankAccountId\` varchar(255) NULL`);
        await queryRunner.query(`ALTER TABLE \`loans\` ADD \`disbursementReference\` varchar(64) NULL`);

        await queryRunner.query(`ALTER TABLE \`email_templates\` MODIFY \`code\` enum (${PaymentEvidence1792303200000.WIDENED}) NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`notification_outbox\` MODIFY \`type\` enum (${PaymentEvidence1792303200000.WIDENED}) NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Narrowing these enums is safe only while no row carries a new member; a row that does makes
        // MySQL refuse the ALTER in strict mode, so a reverted database either looks exactly like it did
        // or the revert fails and says why.
        await queryRunner.query(`ALTER TABLE \`notification_outbox\` MODIFY \`type\` enum (${PaymentEvidence1792303200000.PREVIOUS}) NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`email_templates\` MODIFY \`code\` enum (${PaymentEvidence1792303200000.PREVIOUS}) NOT NULL`);

        await queryRunner.query(`ALTER TABLE \`loans\` DROP COLUMN \`disbursementReference\``);
        await queryRunner.query(`ALTER TABLE \`loans\` DROP COLUMN \`disbursementBankAccountId\``);
        await queryRunner.query(`ALTER TABLE \`loans\` DROP COLUMN \`disbursementChannel\``);

        await queryRunner.query(`DROP TABLE \`evidence_document_contents\``);
        await queryRunner.query(`DROP TABLE \`evidence_documents\``);
        await queryRunner.query(`DROP TABLE \`customer_bank_accounts\``);
    }
}
