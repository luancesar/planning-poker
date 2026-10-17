import path from 'node:path';
import { drizzle, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>['db'];
/** Any drizzle handle: the pool, a transaction, or a single checked-out client. */
export type Conn = PgDatabase<NodePgQueryResultHKT, typeof schema>;
export type Tx = Conn;
export type DbOrTx = Conn;

export const connOn = (client: pg.PoolClient): Conn => drizzle(client, { schema });

export function createDb(url: string) {
  const needsSsl = /sslmode=require/.test(url) || /neon\.tech|supabase\.co/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    // Free tiers cap connections; 10 covers parallel snapshot reads plus mutations.
    max: Number(process.env.DB_POOL_SIZE ?? 10),
    // Snapshots run several queries in parallel; keep warm connections during a session
    // (a new TLS connection to a distant database costs several round trips).
    idleTimeoutMillis: 60_000,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
}
