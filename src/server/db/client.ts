import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>['db'];
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export function createDb(url: string) {
  const needsSsl = /sslmode=require/.test(url) || /neon\.tech|supabase\.co/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    // Free tiers cap connections; keep the pool small.
    max: Number(process.env.DB_POOL_SIZE ?? 5),
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
}
