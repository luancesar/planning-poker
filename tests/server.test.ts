import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppServer } from '@/server/app';
import { rounds } from '@/server/db/schema';
import { SOCKET_EVENTS, type Action, type ActionAck, type JoinResponse, type RoomState } from '@/shared/protocol';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/poker_test';

let app: Awaited<ReturnType<typeof createAppServer>>;
let base = '';
const sockets: Socket[] = [];

async function api<T>(path: string, init?: RequestInit & { json?: unknown }) {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
    body: init?.json ? JSON.stringify(init.json) : undefined,
  });
  return { status: res.status, body: (res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()) as T };
}

/** A connected participant that records every snapshot it receives. */
async function client(join: JoinResponse) {
  const socket = connect(base, { auth: { token: join.token, roomCode: join.code }, transports: ['websocket'], forceNew: true });
  sockets.push(socket);
  let state: RoomState | null = null;
  const waiters: { pred: (s: RoomState) => boolean; resolve: (s: RoomState) => void }[] = [];
  socket.on(SOCKET_EVENTS.snapshot, (s: RoomState) => {
    state = s;
    for (const w of [...waiters]) if (w.pred(s)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(s));
  });
  const until = (pred: (s: RoomState) => boolean, ms = 4000) =>
    new Promise<RoomState>((resolve, reject) => {
      if (state && pred(state)) return resolve(state);
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error('timed out waiting for snapshot; last: ' + JSON.stringify(state)?.slice(0, 400))), ms);
    });
  const send = (action: Action) => new Promise<ActionAck>((resolve) => socket.emit(SOCKET_EVENTS.action, action, resolve));
  await until(() => true);
  return { socket, send, until, get state() { return state!; } };
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;');
  await admin.end();
  app = await createAppServer({ databaseUrl: DB_URL });
  await new Promise<void>((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  sockets.forEach((s) => s.close());
  await app?.close();
});

describe('planning poker room', () => {
  let fac: Awaited<ReturnType<typeof client>>;
  let ana: Awaited<ReturnType<typeof client>>;
  let bia: Awaited<ReturnType<typeof client>>;
  let obs: Awaited<ReturnType<typeof client>>;
  let code = '';

  it('creates a room and lets people join', async () => {
    const created = await api<JoinResponse>('/api/rooms', {
      method: 'POST',
      json: { name: 'Sprint 42', nickname: 'Fac', deckId: 'fibonacci', password: 'segredo' },
    });
    expect(created.status).toBe(201);
    code = created.body.code;
    expect(code).toMatch(/^[A-Z2-9]{6}$/);

    const preview = await api<{ hasPassword: boolean; name: string }>(`/api/rooms/${code}`);
    expect(preview.body).toMatchObject({ name: 'Sprint 42', hasPassword: true });

    const wrong = await api(`/api/rooms/${code}/join`, { method: 'POST', json: { nickname: 'X', password: 'errada' } });
    expect(wrong.status).toBe(403);

    const join = (nickname: string, role = 'voter') =>
      api<JoinResponse>(`/api/rooms/${code.toLowerCase()}/join`, { method: 'POST', json: { nickname, role, password: 'segredo' } }).then((r) => r.body);

    fac = await client(created.body);
    ana = await client(await join('Ana'));
    bia = await client(await join('Bia'));
    obs = await client(await join('Olga', 'observer'));
    const s = await fac.until((s) => s.participants.filter((p) => p.online).length === 4);
    expect(s.me.role).toBe('facilitator');
  });

  it('rejects sockets with a bad token', async () => {
    const bad = connect(base, { auth: { token: 'nope', roomCode: code }, transports: ['websocket'], forceNew: true });
    sockets.push(bad);
    const err = await new Promise<Error>((r) => bad.on('connect_error', r));
    expect(err.message).toBe('unauthorized');
  });

  it('only facilitators manage items', async () => {
    expect(await ana.send({ type: 'item.add', items: [{ title: 'Hack' }] })).toMatchObject({ ok: false });
    expect(await fac.send({ type: 'item.add', items: [{ title: 'Login' }, { title: 'Checkout', link: 'https://x.dev/1' }, { title: 'Busca' }] })).toEqual({ ok: true });
    const s = await ana.until((s) => s.items.length === 3);
    expect(s.items.map((i) => i.title)).toEqual(['Login', 'Checkout', 'Busca']);
  });

  it('hides votes until every voter has voted, then auto-reveals', async () => {
    const [login] = fac.state.items;
    expect(await fac.send({ type: 'round.start', itemId: login.id })).toEqual({ ok: true });
    await ana.until((s) => s.round?.itemId === login.id);

    expect(await ana.send({ type: 'vote.cast', label: '5' })).toEqual({ ok: true });
    expect(await ana.send({ type: 'vote.cast', label: '42' })).toMatchObject({ ok: false });
    expect(await obs.send({ type: 'vote.cast', label: '5' })).toMatchObject({ ok: false, error: expect.stringContaining('papel') });

    const seenByBia = await bia.until((s) => s.participants.some((p) => p.nickname === 'Ana' && p.hasVoted));
    expect(seenByBia.round!.votes).toEqual([{ participantId: ana.state.me.participantId, label: null }]);
    expect(seenByBia.round!.stats).toBeNull();
    expect((await ana.until((s) => s.round?.myVote === '5')).round!.votes[0].label).toBe('5');

    await bia.send({ type: 'vote.cast', label: '8' });
    expect(fac.state.round?.revealedAt).toBeFalsy();
    await fac.send({ type: 'vote.cast', label: '5' });

    const revealed = await obs.until((s) => !!s.round?.revealedAt);
    expect(revealed.round!.votes.map((v) => v.label).sort()).toEqual(['5', '5', '8']);
    expect(revealed.round!.stats).toMatchObject({ average: 6, median: 5, modes: ['5'], suggestion: '5', consensus: 'near' });
    expect(await ana.send({ type: 'vote.cast', label: '3' })).toMatchObject({ ok: false });
  });

  it('stores comments with the author vote, reactions and pins', async () => {
    const itemId = fac.state.items[0].id;
    expect(await bia.send({ type: 'comment.create', itemId, body: 'Tem integração com SSO', attachVote: true })).toEqual({ ok: true });
    const withComment = await ana.until((s) => s.comments.length === 1);
    const comment = withComment.comments[0];
    expect(comment).toMatchObject({ authorName: 'Bia', voteLabel: '8', pinned: false });

    await obs.send({ type: 'comment.create', itemId, body: 'Concordo', attachVote: false, parentId: comment.id });
    await ana.send({ type: 'comment.react', commentId: comment.id, emoji: '👍' });
    expect(await ana.send({ type: 'comment.update', commentId: comment.id, body: 'editado' })).toMatchObject({ ok: false });
    expect(await ana.send({ type: 'comment.pin', commentId: comment.id, pinned: true })).toMatchObject({ ok: false });
    await fac.send({ type: 'comment.pin', commentId: comment.id, pinned: true });

    const s = await ana.until((s) => s.comments.length === 2 && s.comments[0].pinned);
    expect(s.comments[0].reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    expect(s.comments[1].parentId).toBe(comment.id);
  });

  it('revotes, finalizes and advances to the next item', async () => {
    const [login, checkout] = fac.state.items;
    await fac.send({ type: 'round.reset' });
    let s = await ana.until((s) => s.round?.number === 2 && !s.round.revealedAt);
    expect(s.round!.myVote).toBeNull();

    await fac.send({ type: 'round.reveal' });
    await fac.send({ type: 'item.finalize', itemId: login.id, estimate: '5', advance: true });
    s = await ana.until((s) => s.round?.itemId === checkout.id);
    expect(s.items[0]).toMatchObject({ status: 'estimated', finalEstimate: '5', roundCount: 2 });
    expect(s.items[1].status).toBe('voting');
  });

  it('reveals rounds whose timer ran out', async () => {
    const roundId = fac.state.round!.id;
    await ana.send({ type: 'vote.cast', label: '3' });
    const { eq } = await import('drizzle-orm');
    await app.db.update(rounds).set({ endsAt: new Date(Date.now() - 1000) }).where(eq(rounds.id, roundId));
    const s = await bia.until((s) => s.round?.id === roundId && !!s.round.revealedAt, 5000);
    expect(s.round!.stats?.counted).toBe(1);
  });

  it('reorders items and keeps at least one facilitator', async () => {
    const busca = fac.state.items[2];
    await fac.send({ type: 'item.move', itemId: busca.id, toIndex: 0 });
    expect((await ana.until((s) => s.items[0].id === busca.id)).items.map((i) => i.title)).toEqual(['Busca', 'Login', 'Checkout']);
    expect(await fac.send({ type: 'participant.setRole', participantId: fac.state.me.participantId, role: 'voter' })).toMatchObject({ ok: false });
  });

  it('removes a participant and invalidates their token', async () => {
    const removed = new Promise<void>((r) => obs.socket.once(SOCKET_EVENTS.removed, () => r()));
    await fac.send({ type: 'participant.remove', participantId: obs.state.me.participantId });
    await removed;
    const s = await fac.until((s) => s.participants.length === 3);
    expect(s.participants.map((p) => p.nickname)).not.toContain('Olga');
  });

  it('exports the session as CSV without hidden votes', async () => {
    const unauth = await api(`/api/rooms/${code}/summary.csv`);
    expect(unauth.status).toBe(401);
    const res = await fetch(`${base}/api/rooms/${code}/summary.csv`, { headers: { authorization: `Bearer ${(fac.socket.auth as { token: string }).token}` } });
    const csv = await res.text();
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(csv).toContain('Login,Estimado,5,2');
    expect(csv).toContain('Bia (8): Tem integração com SSO');
  });
});
