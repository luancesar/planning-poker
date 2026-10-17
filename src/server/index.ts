import next from 'next';
import { createAppServer } from './app';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);
const databaseUrl = process.env.DATABASE_URL ?? (dev ? 'postgres://postgres:postgres@localhost:5432/poker' : '');
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const nextApp = next({ dev, dir: process.cwd() });
await nextApp.prepare();
const handle = nextApp.getRequestHandler();

const app = await createAppServer({
  databaseUrl,
  redisUrl: process.env.REDIS_URL,
  fallback: (req, res) => handle(req, res),
});

if (dev) {
  const upgrade = nextApp.getUpgradeHandler();
  app.server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/socket.io/')) upgrade(req, socket, head);
  });
}

app.server.listen(port, '0.0.0.0', () => {
  console.log(`> Planning Poker pronto em http://localhost:${port} (${dev ? 'dev' : 'produção'})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
