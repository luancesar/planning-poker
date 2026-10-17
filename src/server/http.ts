import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import { PRESET_DECKS } from '../shared/decks';
import type { Db } from './db/client';
import { ActionError } from './errors';
import { authenticate, createRoom, getRoomPreview, joinRoom } from './room-service';
import { loadSummary, summaryToCsv } from './summary';

const MAX_BODY = 64 * 1024;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ActionError('Requisição muito grande', 413);
    chunks.push(chunk);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw new ActionError('JSON inválido');
  }
}

/** Fixed-window limiter per client IP; enough to stop scripted room spam on a single instance. */
function createRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt < now) {
      if (hits.size > 10_000) hits.clear();
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= limit;
  };
}

const clientIp = (req: IncomingMessage) =>
  (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

async function requireParticipant(db: Db, req: IncomingMessage, code: string) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const auth = token ? await authenticate(db, token) : null;
  if (!auth || auth.roomCode !== code.toUpperCase()) throw new ActionError('Não autorizado', 401);
  return auth.participant;
}

export function createApiHandler(db: Db) {
  const limitWrites = createRateLimiter(30, 10 * 60 * 1000);

  return async function handleApi(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    let m: RegExpMatchArray | null;

    try {
      if (method === 'GET' && path === '/api/health') {
        return send(res, 200, { ok: true });
      }
      if (method === 'GET' && path === '/api/decks') {
        return send(res, 200, PRESET_DECKS);
      }
      if (method === 'POST' && path === '/api/rooms') {
        if (!limitWrites(clientIp(req))) throw new ActionError('Muitas tentativas, aguarde alguns minutos', 429);
        return send(res, 201, await createRoom(db, (await readJson(req)) as never));
      }
      if (method === 'GET' && (m = path.match(/^\/api\/rooms\/([A-Za-z0-9]{6})$/))) {
        return send(res, 200, await getRoomPreview(db, m[1]));
      }
      if (method === 'POST' && (m = path.match(/^\/api\/rooms\/([A-Za-z0-9]{6})\/join$/))) {
        if (!limitWrites(clientIp(req))) throw new ActionError('Muitas tentativas, aguarde alguns minutos', 429);
        return send(res, 201, await joinRoom(db, m[1], (await readJson(req)) as never));
      }
      if (method === 'GET' && (m = path.match(/^\/api\/rooms\/([A-Za-z0-9]{6})\/summary(\.csv)?$/))) {
        const participant = await requireParticipant(db, req, m[1]);
        const summary = await loadSummary(db, participant.roomId);
        if (!summary) throw new ActionError('Sala não encontrada', 404);
        if (!m[2]) return send(res, 200, summary);
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="planning-poker-${summary.room.code}.csv"`,
          'cache-control': 'no-store',
        });
        return res.end(summaryToCsv(summary));
      }
      return send(res, 404, { error: 'Rota não encontrada' });
    } catch (e) {
      if (e instanceof ActionError) return send(res, e.status, { error: e.message });
      if (e instanceof ZodError) return send(res, 400, { error: e.issues[0]?.message ?? 'Dados inválidos' });
      console.error('[api]', e);
      return send(res, 500, { error: 'Erro inesperado' });
    }
  };
}
