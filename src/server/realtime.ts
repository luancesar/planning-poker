import type { Server, Socket } from 'socket.io';
import { ActionSchema, SOCKET_EVENTS, type ActionAck } from '../shared/protocol';
import type { Db } from './db/client';
import { ActionError } from './errors';
import { applyAction, authenticate, maybeAutoReveal, touchPresence, withRoomLock } from './room-service';
import { loadRoomBase, viewFor } from './snapshot';

type SocketData = { participantId: string; roomId: string };

export type Broadcaster = ReturnType<typeof createBroadcaster>;

async function onlineIds(io: Server, roomId: string) {
  const sockets = await io.in(roomId).fetchSockets();
  return new Set(sockets.map((s) => (s.data as SocketData).participantId));
}

/**
 * Pushes a fresh snapshot to everyone in a room. Calls made while a push is
 * running are coalesced into one follow-up push, so bursts stay cheap.
 */
function createBroadcaster(io: Server, db: Db) {
  const state = new Map<string, 'scheduled' | 'running' | 'rerun'>();

  async function run(roomId: string) {
    const sockets = await io.in(roomId).fetchSockets();
    if (sockets.length === 0) return;
    const base = await loadRoomBase(db, roomId);
    if (!base) return;
    const online = new Set(sockets.map((s) => (s.data as SocketData).participantId));
    for (const s of sockets) {
      const view = viewFor(base, (s.data as SocketData).participantId, online);
      if (view) s.emit(SOCKET_EVENTS.snapshot, view);
    }
  }

  function schedule(roomId: string) {
    const current = state.get(roomId);
    if (current === 'scheduled' || current === 'rerun') return;
    if (current === 'running') {
      state.set(roomId, 'rerun');
      return;
    }
    state.set(roomId, 'scheduled');
    setImmediate(async () => {
      state.set(roomId, 'running');
      try {
        await run(roomId);
      } catch (e) {
        console.error('[broadcast]', e);
      }
      const again = state.get(roomId) === 'rerun';
      state.delete(roomId);
      if (again) schedule(roomId);
    });
  }

  return { schedule };
}

export function setupRealtime(io: Server, db: Db) {
  const broadcaster = createBroadcaster(io, db);

  io.use(async (socket, next) => {
    try {
      const { token, roomCode } = (socket.handshake.auth ?? {}) as { token?: unknown; roomCode?: unknown };
      if (typeof token !== 'string' || typeof roomCode !== 'string') return next(new Error('unauthorized'));
      const auth = await authenticate(db, token);
      if (!auth || auth.roomCode !== roomCode.toUpperCase()) return next(new Error('unauthorized'));
      socket.data = { participantId: auth.participant.id, roomId: auth.participant.roomId } satisfies SocketData;
      next();
    } catch (e) {
      console.error('[socket auth]', e);
      next(new Error('server_error'));
    }
  });

  io.on('connection', async (socket: Socket) => {
    const { roomId, participantId } = socket.data as SocketData;
    await socket.join(roomId);

    socket.on(SOCKET_EVENTS.action, async (raw: unknown, ack?: (r: ActionAck) => void) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const parsed = ActionSchema.safeParse(raw);
      if (!parsed.success) return reply({ ok: false, error: parsed.error.issues[0]?.message ?? 'Ação inválida' });
      try {
        const online = await onlineIds(io, roomId);
        const result = await withRoomLock(
          db,
          roomId,
          (tx, room, { actor }) => {
            if (!actor) throw new ActionError('Você não está mais nesta sala', 403);
            return applyAction(tx, room, actor, parsed.data, { online });
          },
          { actorId: participantId },
        );
        reply({ ok: true });
        if (result.removedParticipantId) await kick(io, roomId, result.removedParticipantId);
      } catch (e) {
        if (!(e instanceof ActionError)) console.error('[action]', parsed.data.type, e);
        reply({ ok: false, error: e instanceof ActionError ? e.message : 'Erro inesperado, tente novamente' });
      }
      broadcaster.schedule(roomId);
    });

    socket.on('disconnect', async () => {
      try {
        // Someone who had not voted may have left, which can complete the round.
        const online = await onlineIds(io, roomId);
        await withRoomLock(db, roomId, (tx, room) => maybeAutoReveal(tx, room, online));
      } catch (e) {
        if (!(e instanceof ActionError)) console.error('[disconnect]', e);
      }
      broadcaster.schedule(roomId);
    });

    try {
      await touchPresence(db, participantId, roomId);
    } catch (e) {
      console.error('[presence]', e);
    }
    broadcaster.schedule(roomId);
  });

  return broadcaster;
}

async function kick(io: Server, roomId: string, participantId: string) {
  const sockets = await io.in(roomId).fetchSockets();
  for (const s of sockets) {
    if ((s.data as SocketData).participantId === participantId) {
      s.emit(SOCKET_EVENTS.removed);
      s.disconnect(true);
    }
  }
}
