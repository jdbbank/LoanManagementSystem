import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The table the request ceilings count in, and one cleanup the reset secrets need.
 *
 * A counter has to live where every replica of the API can see it, so the fixed-window buckets are
 * database rows rather than process state: with an in-memory map, the ceiling an attacker meets
 * depends on which container answers, and a gateway that spreads a burst across three of them triples
 * the budget. `bucketKey` carries the window index inside the row key, which is why nothing here ever
 * needs resetting — the first request of a new window opens a new row and the closed one waits for the
 * prune job.
 *
 * The key is unique rather than indexed-and-checked-in-code because the whole write is one
 * `INSERT … ON DUPLICATE KEY UPDATE`. Two requests that both read-then-write the same count would
 * lose one of them, which is exactly the mistake that let a burned OTP keep working (F-CONC-4).
 *
 * Index names are the ones the entity declares, not TypeORM's generated hash, so
 * `npm run db:schema:diff` reports this database as up to date instead of offering to rename them.
 * `scope` is a varchar rather than an enum column on purpose: guarding another endpoint should be a
 * code change, not a `MODIFY COLUMN` against a table every signed-in attempt writes to.
 *
 * The last statement retires outstanding reset secrets. Their stored digest changed from plain SHA-256
 * to a keyed one, so those rows can never match again; marking them used says so in the data instead of
 * leaving rows that look valid to every reader. Anyone mid-reset simply asks for a new code, which is
 * what the throttle and the cooldown already expect of them.
 */
export class SecurityRateBuckets1793577600000 implements MigrationInterface {
    name = 'SecurityRateBuckets1793577600000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`security_rate_buckets\` (\`id\` varchar(36) NOT NULL, \`bucketKey\` varchar(191) NOT NULL, \`scope\` varchar(64) NOT NULL, \`identity\` varchar(191) NOT NULL, \`hits\` int NOT NULL DEFAULT 0, \`expiresAt\` datetime(3) NOT NULL, \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX \`UQ_security_rate_buckets_bucketKey\` (\`bucketKey\`), INDEX \`IDX_security_rate_buckets_expiresAt\` (\`expiresAt\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);

        await queryRunner.query(`UPDATE \`password_reset_tokens\` SET \`usedAt\` = CURRENT_TIMESTAMP(6) WHERE \`usedAt\` IS NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX \`IDX_security_rate_buckets_expiresAt\` ON \`security_rate_buckets\``);
        await queryRunner.query(`DROP INDEX \`UQ_security_rate_buckets_bucketKey\` ON \`security_rate_buckets\``);
        await queryRunner.query(`DROP TABLE \`security_rate_buckets\``);
    }
}
