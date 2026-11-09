import 'reflect-metadata';
import { buildMigrationDataSource } from './datasource';

/**
 * Entry point for the TypeORM CLI (`-d src/cli-datasource.ts`); the application never uses it.
 * The CLI requires this file to export exactly one DataSource instance, and dotenv reads server/.env
 * from the working directory, so every command runs from `server/`.
 */
export default buildMigrationDataSource();
