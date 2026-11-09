import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The columns the three account-security rules need to exist outside a request: the counter a wrong
 * password bumps, the lock itself, and the hash history a reuse check reads.
 *
 * Nothing existing needs a value. `failedLoginAttempts` defaults to 0, which is also the state after a
 * successful login and after an ADMIN unlock, and the two lock columns are nullable because "not
 * locked" is the absence of a row value rather than a flag to set. Accounts that predate this release
 * simply start their history at their current password — the first rotation after it cannot compare
 * against hashes from before it, which is honest, and `users.passwordHash` still blocks reuse of the
 * password a person is holding.
 *
 * The lock is not `isActive`. Disabling an account is ADMIN intent; this is a rule firing, and only
 * ADMIN may clear it, so the two states need separate columns or an unlock would re-enable accounts
 * ADMIN had closed on purpose.
 *
 * No enum is widened here — `AccountLockReason` is a brand-new column, so `email_templates.code` and
 * `notification_outbox.type` keep their DDL and the `MODIFY COLUMN` rule from PaymentEvidence does
 * not apply. That rule comes back in the release that adds the lock notification events.
 *
 * Index name is TypeORM's own: `IDX_` + the first 26 characters of sha1 over
 * `user_password_history_createdAt_userId` (its columns sorted alphabetically; the DDL lists them in
 * declared order). Written by hand so `npm run db:schema:diff` reports the database as up to date
 * instead of offering to rename it.
 */
export class AccountSecurity1792389600000 implements MigrationInterface {
    name = 'AccountSecurity1792389600000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`user_password_history\` (\`id\` varchar(36) NOT NULL, \`userId\` varchar(255) NOT NULL, \`passwordHash\` varchar(128) NOT NULL, \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX \`IDX_5f882957a407ead74c07152b3c\` (\`userId\`, \`createdAt\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);

        await queryRunner.query(`ALTER TABLE \`users\` ADD \`failedLoginAttempts\` int NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE \`users\` ADD \`lockedAt\` datetime NULL`);
        await queryRunner.query(`ALTER TABLE \`users\` ADD \`lockReason\` enum ('FAILED_ATTEMPTS', 'IDLE') NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`users\` DROP COLUMN \`lockReason\``);
        await queryRunner.query(`ALTER TABLE \`users\` DROP COLUMN \`lockedAt\``);
        await queryRunner.query(`ALTER TABLE \`users\` DROP COLUMN \`failedLoginAttempts\``);

        // Reverting unlocks every locked account and forgets every stored hash, so it belongs to a
        // database that has not enforced these rules yet — not to one an operator is recovering.
        await queryRunner.query(`DROP TABLE \`user_password_history\``);
    }
}
