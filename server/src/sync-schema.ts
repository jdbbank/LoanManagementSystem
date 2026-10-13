import 'reflect-metadata';
import { initDataSource } from './datasource';

async function syncSchema(): Promise<void> {
  const dataSource = await initDataSource();
  await dataSource.destroy();
  console.log('[db] schema synchronized');
}

syncSchema().catch((error: unknown) => {
  console.error('[db] schema synchronization failed:', error);
  process.exitCode = 1;
});
