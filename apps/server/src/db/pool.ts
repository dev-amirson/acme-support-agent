import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { AppConfig } from '../config';
import { schema } from './schema';

export type Database = NodePgDatabase<typeof schema>;
/** A transaction handle — repositories accept either so callers can compose atomic units. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Tx;

export interface DatabaseHandle {
  pool: pg.Pool;
  db: Database;
}

/**
 * Private-network hosts don't get TLS in `auto` mode: localhost, Docker service names and
 * host.docker.internal, Render internal hostnames (no dots), *.internal / *.local, RFC 1918 IPs.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || !h.includes('.')) return true;
  if (/\.(internal|local|localdomain)$/.test(h)) return true;
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
}

function sslFor(config: AppConfig): pg.PoolConfig['ssl'] {
  const { DATABASE_URL, DATABASE_SSL } = config.env;
  if (DATABASE_SSL === 'disable') return false;
  if (DATABASE_SSL === 'require') return { rejectUnauthorized: true };
  const url = new URL(DATABASE_URL);
  // Let pg honour an explicit sslmode in the URL (Neon / Supabase include one).
  if (url.searchParams.has('sslmode')) return undefined;
  return isPrivateHost(url.hostname) ? false : { rejectUnauthorized: true };
}

export function createDatabase(config: AppConfig): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: config.env.DATABASE_URL,
    ssl: sslFor(config),
    // Free-tier Postgres allows few connections; keep the pool small and fail fast.
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    application_name: 'acme-support-agent',
  });
  // An idle client erroring (e.g. DB restart) must not crash the process.
  pool.on('error', () => undefined);
  return { pool, db: drizzle(pool, { schema }) };
}
