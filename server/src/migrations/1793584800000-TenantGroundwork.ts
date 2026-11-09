import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The organisation table, and the column every account hangs off it.
 *
 * This is groundwork, not multi-tenancy: the deployment still answers for one organisation, and the
 * code says so in one place (`services/tenant.service.ts`). What changes here is what the database
 * guarantees. A username used to be unique across the whole installation, so the day a second
 * organisation arrived, its staff could not be given ordinary names like `maker1` — and every existing
 * account would have to be assigned to an organisation by hand, with nothing in the data saying which
 * is right. Making the constraint per organisation before the second one exists is the whole reason
 * for doing it now.
 *
 * The column is added nullable, filled, then made NOT NULL, rather than added with a database default.
 * A default would have to stay in the schema forever to keep the insert legal, and it would quietly
 * file a new account under whatever organisation happened to be seeded first — a wrong value that
 * looks correct is the one nobody audits.
 *
 * The seeded row keeps the code `default` that `DEFAULT_TENANT_CODE` names. They are two places one
 * value lives, so the 503 the service answers with names the code it looked for; pointing the
 * environment at a different organisation means renaming this row, not editing this file.
 *
 * Index names are the ones the entities declare, so `npm run db:schema:diff` stays silent, and the two
 * global uniques from BaselineSchema are dropped by their original generated names — MySQL keeps an
 * old name when an index is rebuilt, so this is the only place they can be released.
 */
export class TenantGroundwork1793584800000 implements MigrationInterface {
    name = 'TenantGroundwork1793584800000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`tenants\` (\`id\` varchar(36) NOT NULL, \`code\` varchar(32) NOT NULL, \`name\` varchar(191) NOT NULL, \`isActive\` tinyint NOT NULL DEFAULT 1, \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), UNIQUE INDEX \`UQ_tenants_code\` (\`code\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`INSERT INTO \`tenants\` (\`id\`, \`code\`, \`name\`, \`isActive\`) VALUES ('00000000-0000-0000-0000-000000000001', 'default', 'Default organisation', 1)`);

        await queryRunner.query(`ALTER TABLE \`users\` ADD \`tenantId\` varchar(36) NULL`);
        await queryRunner.query(`UPDATE \`users\` SET \`tenantId\` = '00000000-0000-0000-0000-000000000001' WHERE \`tenantId\` IS NULL`);
        await queryRunner.query(`ALTER TABLE \`users\` MODIFY \`tenantId\` varchar(36) NOT NULL`);

        await queryRunner.query(`DROP INDEX \`IDX_fe0bb3f6520ee0469504521e71\` ON \`users\``);
        await queryRunner.query(`DROP INDEX \`IDX_97672ac88f789774dd47f7c8be\` ON \`users\``);
        await queryRunner.query(`CREATE UNIQUE INDEX \`UQ_users_tenantId_username\` ON \`users\` (\`tenantId\`, \`username\`)`);
        await queryRunner.query(`CREATE UNIQUE INDEX \`UQ_users_tenantId_email\` ON \`users\` (\`tenantId\`, \`email\`)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX \`UQ_users_tenantId_email\` ON \`users\``);
        await queryRunner.query(`DROP INDEX \`UQ_users_tenantId_username\` ON \`users\``);
        await queryRunner.query(`CREATE UNIQUE INDEX \`IDX_97672ac88f789774dd47f7c8be\` ON \`users\` (\`email\`)`);
        await queryRunner.query(`CREATE UNIQUE INDEX \`IDX_fe0bb3f6520ee0469504521e71\` ON \`users\` (\`username\`)`);

        await queryRunner.query(`ALTER TABLE \`users\` DROP COLUMN \`tenantId\``);
        // Reverting forgets which organisation the accounts belonged to, so the seeded row goes with it.
        await queryRunner.query(`DELETE FROM \`tenants\` WHERE \`code\` = 'default'`);
        await queryRunner.query(`DROP TABLE \`tenants\``);
    }
}
