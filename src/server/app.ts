import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from 'socket.io';
import { createDb, runMigrations } from './db/client';
import { createApiHandler } from './http';
import { setupRealtime } from './realtime';
import { startSweeper } from './sweeper';

type Options = {
  databaseUrl: string;
  /** Only needed when running more than one instance. */
  redisUrl?: string;
  /** Handles every non-API request (the Next.js app in production). */
  fallback?: (req: IncomingMessage, res: ServerResponse) => unknown;
};

export async function createAppServer({ databaseUrl, redisUrl, fallback }: Options) {
  const { db, pool } = createDb(databaseUrl);
  await runMigrations(db);

  const handleApi = createApiHandler(db);
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/')) return void handleApi(req, res);
    if (fallback) return void fallback(req, res);
    res.statusCode = 404;
    res.end();
  });

  // destroyUpgrade=false leaves other WebSocket upgrades (Next.js HMR in dev) alone.
  const io = new Server(server, { serveClient: false, maxHttpBufferSize: 256_000, destroyUpgrade: false });

  let redisClients: { quit: () => Promise<unknown> }[] = [];
  if (redisUrl) {
    const [{ createClient }, { createAdapter }] = await Promise.all([import('redis'), import('@socket.io/redis-adapter')]);
    const pub = createClient({ url: redisUrl });
    const sub = pub.duplicate();
    await Promise.all([pub.connect(), sub.connect()]);
    io.adapter(createAdapter(pub, sub));
    redisClients = [pub, sub];
  }

  const broadcaster = setupRealtime(io, db);
  const sweeper = startSweeper(db, broadcaster, () => io.engine.clientsCount > 0);

  return {
    server,
    io,
    db,
    async close() {
      sweeper.stop();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await Promise.all(redisClients.map((c) => c.quit()));
      await pool.end();
    },
  };
}
