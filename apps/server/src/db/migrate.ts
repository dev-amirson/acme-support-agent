import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import type { AppConfig } from '../config';
import type { Logger } from '../lib/logger';

/** Arbitrary constant; serialises concurrent boots (e.g. zero-downtime deploys) on one DB. */
const MIGRATION_LOCK_ID = 727_274_001;

/**
 * Applies drizzle-kit generated migrations on boot. Free hosting tiers have no release-phase job,
 * so the app migrates itself — under a Postgres advisory lock so two instances never race.
 */
export async function migrate(pool: pg.Pool, config: AppConfig, log: Logger): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    // Extensions aren't managed by drizzle-kit; pgvector must exist before the first migration.
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await drizzleMigrate(drizzle(client), { migrationsFolder: config.env.MIGRATIONS_DIR });
    log.info({ dir: config.env.MIGRATIONS_DIR }, 'database migrations up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
