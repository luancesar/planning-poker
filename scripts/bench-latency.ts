// Measures how long a vote or comment takes to reach another participant.
// Usage: DATABASE_URL=... npx tsx scripts/bench-latency.ts
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { createAppServer } from '../src/server/app';
import { SOCKET_EVENTS, type Action, type JoinResponse, type RoomState } from '../src/shared/protocol';

const app = await createAppServer({ databaseUrl: process.env.DATABASE_URL! });
await new Promise<void>((r) => app.server.listen(0, r));
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

const post = async (path: string, json: unknown) =>
  (await (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) })).json()) as JoinResponse;

type Client = { socket: Socket; state: RoomState | null; send: (a: Action) => Promise<unknown>; until: (p: (s: RoomState) => boolean) => Promise<void> };
async function client(join: JoinResponse): Promise<Client> {
  const socket = connect(base, { auth: { token: join.token, roomCode: join.code }, transports: ['websocket'], forceNew: true });
  const c: Client = {
    socket,
    state: null,
    send: (a) => new Promise((r) => socket.emit(SOCKET_EVENTS.action, a, r)),
    until: (p) =>
      new Promise((resolve) => {
        const check = (s: RoomState) => p(s) && (socket.off(SOCKET_EVENTS.snapshot, check), resolve());
        if (c.state && p(c.state)) return resolve();
        socket.on(SOCKET_EVENTS.snapshot, check);
      }),
  };
  socket.on(SOCKET_EVENTS.snapshot, (s: RoomState) => (c.state = s));
  await c.until(() => true);
  return c;
}

const fac = await client(await post('/api/rooms', { name: 'Bench', nickname: 'Fac', deckId: 'fibonacci' }));
const code = fac.state!.room.code;
const voters: Client[] = [];
for (let i = 0; i < 6; i++) voters.push(await client(await post(`/api/rooms/${code}/join`, { nickname: `V${i}` })));
await fac.send({ type: 'item.add', items: [{ title: 'Item A' }, { title: 'Item B' }] });
await fac.until((s) => s.items.length === 2);

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const voteTimes: number[] = [];
const commentTimes: number[] = [];
const ackTimes: number[] = [];

for (let round = 0; round < 3; round++) {
  await fac.send({ type: 'round.start', itemId: fac.state!.items[round % 2].id });
  await fac.until((s) => !!s.round && !s.round.revealedAt && s.round.votes.length === 0);
  for (const v of voters.slice(0, 5)) {
    const me = v.state!.me.participantId;
    const t = performance.now();
    const ack = v.send({ type: 'vote.cast', label: '5' }).then(() => ackTimes.push(performance.now() - t));
    await fac.until((s) => !!s.participants.find((p) => p.id === me)?.hasVoted);
    voteTimes.push(performance.now() - t);
    await ack;
  }
  const itemId = fac.state!.room.currentItemId!;
  const before = fac.state!.comments.length;
  const t = performance.now();
  await voters[0].send({ type: 'comment.create', itemId, body: `comentário ${round}`, attachVote: true });
  await fac.until((s) => s.comments.length > before);
  commentTimes.push(performance.now() - t);
}

console.log(`vote ack (median):        ${median(ackTimes).toFixed(0)} ms`);
console.log(`vote visible to others:   ${median(voteTimes).toFixed(0)} ms (median of ${voteTimes.length})`);
console.log(`comment visible to others: ${median(commentTimes).toFixed(0)} ms (median of ${commentTimes.length})`);
[fac, ...voters].forEach((c) => c.socket.close());
await app.close();
process.exit(0);
