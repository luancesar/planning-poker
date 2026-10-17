import { and, asc, count, desc, eq, isNull, max, sql } from 'drizzle-orm';
import { resolveDeck } from '../shared/decks';
import {
  CreateRoomSchema,
  JoinRoomSchema,
  LIMITS,
  type CreateRoomInput,
  type JoinResponse,
  type JoinRoomInput,
  type ParsedAction,
  type RoomPreview,
} from '../shared/protocol';
import { computeStats } from '../shared/stats';
import { hashPassword, hashToken, newRoomCode, newToken, normalizeCode, verifyPassword } from './auth';
import type { Db, DbOrTx, Tx } from './db/client';
import { comments, items, participants, reactions, rooms, rounds, votes } from './db/schema';
import { ActionError } from './errors';

export type RoomRow = typeof rooms.$inferSelect;
export type ParticipantRow = typeof participants.$inferSelect;
type RoundRow = typeof rounds.$inferSelect;

const DAY = 24 * 60 * 60 * 1000;
/** Ephemeral rooms expire after 24 h without activity; persistent ones after 90 days. */
export const expiryFor = (persistent: boolean) => new Date(Date.now() + (persistent ? 90 : 1) * DAY);

// ---------------------------------------------------------------------------
// Rooms and participants
// ---------------------------------------------------------------------------

export async function createRoom(db: Db, input: CreateRoomInput): Promise<JoinResponse> {
  const data = CreateRoomSchema.parse(input);
  let deck;
  try {
    deck = resolveDeck(data.deckId, data.customCards);
  } catch (e) {
    throw new ActionError((e as Error).message);
  }
  const passwordHash = data.password ? await hashPassword(data.password) : null;
  const token = newToken();

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newRoomCode();
    try {
      return await db.transaction(async (tx) => {
        const [room] = await tx
          .insert(rooms)
          .values({ code, name: data.name, deck, settings: data.settings, passwordHash, persistent: data.persistent, expiresAt: expiryFor(data.persistent) })
          .returning();
        const [p] = await tx
          .insert(participants)
          .values({ roomId: room.id, nickname: data.nickname, role: 'facilitator', tokenHash: hashToken(token) })
          .returning();
        return { code, token, participantId: p.id };
      });
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e; // retry only on a code collision
    }
  }
  throw new Error('Could not allocate a room code');
}

export async function findRoomByCode(db: DbOrTx, code: string) {
  const [room] = await db.select().from(rooms).where(eq(rooms.code, normalizeCode(code)));
  return room ?? null;
}

export async function getRoomPreview(db: Db, code: string): Promise<RoomPreview> {
  const room = await findRoomByCode(db, code);
  if (!room) throw new ActionError('Sala não encontrada', 404);
  const [{ n }] = await db
    .select({ n: count() })
    .from(participants)
    .where(and(eq(participants.roomId, room.id), isNull(participants.removedAt)));
  return { code: room.code, name: room.name, hasPassword: !!room.passwordHash, deckName: room.deck.name, participantCount: n };
}

export async function joinRoom(db: Db, code: string, input: JoinRoomInput): Promise<JoinResponse> {
  const data = JoinRoomSchema.parse(input);
  const room = await findRoomByCode(db, code);
  if (!room) throw new ActionError('Sala não encontrada', 404);
  if (room.passwordHash && !(data.password && (await verifyPassword(data.password, room.passwordHash)))) {
    throw new ActionError('Senha incorreta', 403);
  }
  const token = newToken();
  return withRoomLock(db, room.id, async (tx) => {
    const [{ n }] = await tx
      .select({ n: count() })
      .from(participants)
      .where(and(eq(participants.roomId, room.id), isNull(participants.removedAt)));
    if (n >= LIMITS.participantsPerRoom) throw new ActionError(`A sala atingiu o limite de ${LIMITS.participantsPerRoom} participantes`, 403);
    const [p] = await tx
      .insert(participants)
      .values({ roomId: room.id, nickname: data.nickname, role: data.role, tokenHash: hashToken(token) })
      .returning();
    return { code: room.code, token, participantId: p.id };
  });
}

/** Resolves a participant token; null when unknown or removed from the room. */
export async function authenticate(db: DbOrTx, token: string) {
  const [row] = await db
    .select({ participant: participants, roomCode: rooms.code })
    .from(participants)
    .innerJoin(rooms, eq(rooms.id, participants.roomId))
    .where(and(eq(participants.tokenHash, hashToken(token)), isNull(participants.removedAt)));
  return row ?? null;
}

export async function touchPresence(db: Db, participantId: string, roomId: string) {
  await db.update(participants).set({ lastSeenAt: new Date() }).where(eq(participants.id, participantId));
  await db
    .update(rooms)
    .set({ expiresAt: sql`now() + case when ${rooms.persistent} then interval '90 days' else interval '1 day' end` })
    .where(eq(rooms.id, roomId));
}

export async function getActiveParticipant(db: DbOrTx, roomId: string, participantId: string) {
  const [p] = await db
    .select()
    .from(participants)
    .where(and(eq(participants.id, participantId), eq(participants.roomId, roomId), isNull(participants.removedAt)));
  return p ?? null;
}

/**
 * Runs a mutation with the room serialized across every server instance
 * (Postgres advisory lock) and bumps the room's sequence number.
 */
export async function withRoomLock<T>(db: Db, roomId: string, fn: (tx: Tx, room: RoomRow) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${roomId}))`);
    const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId));
    if (!room) throw new ActionError('Sala não encontrada', 404);
    const result = await fn(tx, room);
    await tx
      .update(rooms)
      .set({ seq: sql`${rooms.seq} + 1`, currentItemId: room.currentItemId, expiresAt: expiryFor(room.persistent) })
      .where(eq(rooms.id, roomId));
    return result;
  });
}

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

async function latestRound(tx: DbOrTx, itemId: string): Promise<RoundRow | null> {
  const [r] = await tx.select().from(rounds).where(eq(rounds.itemId, itemId)).orderBy(desc(rounds.number)).limit(1);
  return r ?? null;
}

async function openRound(tx: DbOrTx, room: RoomRow) {
  if (!room.currentItemId) return null;
  const r = await latestRound(tx, room.currentItemId);
  return r && !r.revealedAt ? r : null;
}

async function startRound(tx: Tx, room: RoomRow, itemId: string) {
  if (room.currentItemId && room.currentItemId !== itemId) {
    await tx
      .update(items)
      .set({ status: 'pending' })
      .where(and(eq(items.id, room.currentItemId), eq(items.status, 'voting')));
  }
  const [{ last }] = await tx.select({ last: max(rounds.number) }).from(rounds).where(eq(rounds.itemId, itemId));
  const timer = room.settings.timerSeconds;
  await tx.insert(rounds).values({
    itemId,
    number: (last ?? 0) + 1,
    endsAt: timer ? new Date(Date.now() + timer * 1000) : null,
  });
  await tx.update(items).set({ status: 'voting' }).where(eq(items.id, itemId));
  room.currentItemId = itemId;
}

export async function revealRound(tx: Tx, room: RoomRow, round: RoundRow) {
  const roundVotes = await tx.select({ cardLabel: votes.cardLabel }).from(votes).where(eq(votes.roundId, round.id));
  await tx
    .update(rounds)
    .set({ revealedAt: new Date(), stats: computeStats(room.deck, roundVotes) })
    .where(eq(rounds.id, round.id));
}

const canVote = (p: ParticipantRow, room: RoomRow) =>
  p.role === 'voter' || (p.role === 'facilitator' && room.settings.facilitatorVotes);

/** Reveals the open round once every online voter has voted (if the room enables it). */
export async function maybeAutoReveal(tx: Tx, room: RoomRow, online: Set<string>) {
  if (!room.settings.autoReveal) return;
  const round = await openRound(tx, room);
  if (!round) return;
  const active = await tx
    .select()
    .from(participants)
    .where(and(eq(participants.roomId, room.id), isNull(participants.removedAt)));
  const eligible = active.filter((p) => online.has(p.id) && canVote(p, room));
  if (eligible.length === 0) return;
  const voted = new Set(
    (await tx.select({ id: votes.participantId }).from(votes).where(eq(votes.roundId, round.id))).map((v) => v.id),
  );
  if (eligible.every((p) => voted.has(p.id))) await revealRound(tx, room, round);
}

/** Moves to the first pending item after `afterPosition` (wrapping around); clears the current item when none is left. */
async function advance(tx: Tx, room: RoomRow, afterPosition: number) {
  const pending = await tx
    .select({ id: items.id, position: items.position })
    .from(items)
    .where(and(eq(items.roomId, room.id), eq(items.status, 'pending')))
    .orderBy(asc(items.position));
  const next = pending.find((i) => i.position > afterPosition) ?? pending[0];
  if (next) await startRound(tx, room, next.id);
  else room.currentItemId = null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type ActionContext = { online: Set<string> };
export type ActionResult = { removedParticipantId?: string };

function requireFacilitator(actor: ParticipantRow) {
  if (actor.role !== 'facilitator') throw new ActionError('Apenas o facilitador pode fazer isso', 403);
}

async function getItem(tx: Tx, room: RoomRow, itemId: string) {
  const [item] = await tx.select().from(items).where(and(eq(items.id, itemId), eq(items.roomId, room.id)));
  if (!item) throw new ActionError('Item não encontrado', 404);
  return item;
}

async function getComment(tx: Tx, room: RoomRow, commentId: string) {
  const [row] = await tx
    .select({ comment: comments })
    .from(comments)
    .innerJoin(items, eq(items.id, comments.itemId))
    .where(and(eq(comments.id, commentId), eq(items.roomId, room.id), isNull(comments.deletedAt)));
  if (!row) throw new ActionError('Comentário não encontrado', 404);
  return row.comment;
}

async function getTarget(tx: Tx, room: RoomRow, participantId: string) {
  const p = await getActiveParticipant(tx, room.id, participantId);
  if (!p) throw new ActionError('Participante não encontrado', 404);
  return p;
}

export async function applyAction(
  tx: Tx,
  room: RoomRow,
  actor: ParticipantRow,
  action: ParsedAction,
  ctx: ActionContext,
): Promise<ActionResult> {
  const result: ActionResult = {};

  switch (action.type) {
    case 'vote.cast': {
      if (!canVote(actor, room)) throw new ActionError('Seu papel nesta sala não permite votar', 403);
      const round = await openRound(tx, room);
      if (!round) throw new ActionError('Não há votação aberta');
      const card = room.deck.cards.find((c) => c.label === action.label);
      if (!card) throw new ActionError('Card inválido');
      await tx
        .insert(votes)
        .values({ roundId: round.id, participantId: actor.id, cardLabel: card.label, numericValue: card.value })
        .onConflictDoUpdate({
          target: [votes.roundId, votes.participantId],
          set: { cardLabel: card.label, numericValue: card.value, updatedAt: new Date() },
        });
      break;
    }

    case 'vote.retract': {
      const round = await openRound(tx, room);
      if (!round) throw new ActionError('Não há votação aberta');
      await tx.delete(votes).where(and(eq(votes.roundId, round.id), eq(votes.participantId, actor.id)));
      break;
    }

    case 'round.start': {
      requireFacilitator(actor);
      const item = await getItem(tx, room, action.itemId);
      await startRound(tx, room, item.id);
      break;
    }

    case 'round.reveal': {
      requireFacilitator(actor);
      const round = await openRound(tx, room);
      if (!round) throw new ActionError('Não há votação aberta');
      await revealRound(tx, room, round);
      break;
    }

    case 'round.reset': {
      requireFacilitator(actor);
      if (!room.currentItemId) throw new ActionError('Selecione um item primeiro');
      await startRound(tx, room, room.currentItemId);
      break;
    }

    case 'item.finalize': {
      requireFacilitator(actor);
      const item = await getItem(tx, room, action.itemId);
      if (!room.deck.cards.some((c) => c.label === action.estimate)) throw new ActionError('Estimativa precisa ser um card do deck');
      if (room.currentItemId === item.id) {
        const round = await openRound(tx, room);
        if (round) await revealRound(tx, room, round);
      }
      await tx.update(items).set({ status: 'estimated', finalEstimate: action.estimate }).where(eq(items.id, item.id));
      if (action.advance) await advance(tx, room, item.position);
      break;
    }

    case 'item.skip': {
      requireFacilitator(actor);
      const item = await getItem(tx, room, action.itemId);
      await tx.update(items).set({ status: 'skipped' }).where(eq(items.id, item.id));
      if (room.currentItemId === item.id) await advance(tx, room, item.position);
      break;
    }

    case 'item.reopen': {
      requireFacilitator(actor);
      const item = await getItem(tx, room, action.itemId);
      await tx.update(items).set({ status: 'pending', finalEstimate: null }).where(eq(items.id, item.id));
      if (room.currentItemId === item.id) await startRound(tx, room, item.id);
      break;
    }

    case 'item.add': {
      requireFacilitator(actor);
      const [{ n, last }] = await tx
        .select({ n: count(), last: max(items.position) })
        .from(items)
        .where(eq(items.roomId, room.id));
      if (n + action.items.length > LIMITS.itemsPerRoom) throw new ActionError(`A sala aceita no máximo ${LIMITS.itemsPerRoom} itens`);
      const start = (last ?? -1) + 1;
      await tx.insert(items).values(
        action.items.map((it, i) => ({
          roomId: room.id,
          title: it.title,
          description: it.description ?? '',
          link: it.link ?? '',
          position: start + i,
        })),
      );
      break;
    }

    case 'item.update': {
      requireFacilitator(actor);
      await getItem(tx, room, action.itemId);
      const patch: Partial<typeof items.$inferInsert> = {};
      if (action.title !== undefined) patch.title = action.title;
      if (action.description !== undefined) patch.description = action.description;
      if (action.link !== undefined) patch.link = action.link;
      if (Object.keys(patch).length) await tx.update(items).set(patch).where(eq(items.id, action.itemId));
      break;
    }

    case 'item.delete': {
      requireFacilitator(actor);
      await getItem(tx, room, action.itemId);
      if (room.currentItemId === action.itemId) room.currentItemId = null;
      await tx.delete(items).where(eq(items.id, action.itemId));
      break;
    }

    case 'item.move': {
      requireFacilitator(actor);
      const ordered = await tx
        .select({ id: items.id, position: items.position })
        .from(items)
        .where(eq(items.roomId, room.id))
        .orderBy(asc(items.position));
      const from = ordered.findIndex((i) => i.id === action.itemId);
      if (from < 0) throw new ActionError('Item não encontrado', 404);
      const [moved] = ordered.splice(from, 1);
      ordered.splice(Math.min(action.toIndex, ordered.length), 0, moved);
      for (const [index, it] of ordered.entries()) {
        if (it.position !== index) await tx.update(items).set({ position: index }).where(eq(items.id, it.id));
      }
      break;
    }

    case 'comment.create': {
      const item = await getItem(tx, room, action.itemId);
      let parentId: string | null = null;
      if (action.parentId) {
        const parent = await getComment(tx, room, action.parentId);
        if (parent.itemId !== item.id) throw new ActionError('Comentário de outro item');
        parentId = parent.parentId ?? parent.id; // threads are one level deep
      }
      let voteLabel: string | null = null;
      if (action.attachVote) {
        const round = await latestRound(tx, item.id);
        if (round) {
          const [v] = await tx
            .select({ label: votes.cardLabel })
            .from(votes)
            .where(and(eq(votes.roundId, round.id), eq(votes.participantId, actor.id)));
          voteLabel = v?.label ?? null;
        }
      }
      await tx.insert(comments).values({ itemId: item.id, participantId: actor.id, parentId, body: action.body, voteLabel });
      break;
    }

    case 'comment.update': {
      const comment = await getComment(tx, room, action.commentId);
      if (comment.participantId !== actor.id) throw new ActionError('Você só pode editar seus comentários', 403);
      await tx.update(comments).set({ body: action.body, editedAt: new Date() }).where(eq(comments.id, comment.id));
      break;
    }

    case 'comment.delete': {
      const comment = await getComment(tx, room, action.commentId);
      if (comment.participantId !== actor.id && actor.role !== 'facilitator') {
        throw new ActionError('Você só pode remover seus comentários', 403);
      }
      await tx.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, comment.id));
      break;
    }

    case 'comment.pin': {
      requireFacilitator(actor);
      const comment = await getComment(tx, room, action.commentId);
      await tx.update(comments).set({ pinned: action.pinned }).where(eq(comments.id, comment.id));
      break;
    }

    case 'comment.react': {
      const comment = await getComment(tx, room, action.commentId);
      const removed = await tx
        .delete(reactions)
        .where(and(eq(reactions.commentId, comment.id), eq(reactions.participantId, actor.id), eq(reactions.emoji, action.emoji)))
        .returning({ id: reactions.id });
      if (removed.length === 0) {
        await tx.insert(reactions).values({ commentId: comment.id, participantId: actor.id, emoji: action.emoji });
      }
      break;
    }

    case 'participant.setRole': {
      requireFacilitator(actor);
      const target = await getTarget(tx, room, action.participantId);
      if (target.role === 'facilitator' && action.role !== 'facilitator') {
        const [{ n }] = await tx
          .select({ n: count() })
          .from(participants)
          .where(and(eq(participants.roomId, room.id), eq(participants.role, 'facilitator'), isNull(participants.removedAt)));
        if (n <= 1) throw new ActionError('A sala precisa de pelo menos um facilitador');
      }
      await tx.update(participants).set({ role: action.role }).where(eq(participants.id, target.id));
      if (action.role === 'observer') {
        const round = await openRound(tx, room);
        if (round) await tx.delete(votes).where(and(eq(votes.roundId, round.id), eq(votes.participantId, target.id)));
      }
      break;
    }

    case 'participant.remove': {
      requireFacilitator(actor);
      if (action.participantId === actor.id) throw new ActionError('Você não pode remover a si mesmo');
      const target = await getTarget(tx, room, action.participantId);
      await tx.update(participants).set({ removedAt: new Date() }).where(eq(participants.id, target.id));
      const round = await openRound(tx, room);
      if (round) await tx.delete(votes).where(and(eq(votes.roundId, round.id), eq(votes.participantId, target.id)));
      result.removedParticipantId = target.id;
      ctx.online.delete(target.id);
      break;
    }

    case 'participant.rename': {
      await tx.update(participants).set({ nickname: action.nickname }).where(eq(participants.id, actor.id));
      break;
    }

    case 'room.update': {
      requireFacilitator(actor);
      const patch: Partial<typeof rooms.$inferInsert> = {};
      if (action.name) patch.name = action.name;
      if (action.settings) {
        room.settings = { ...room.settings, ...action.settings };
        patch.settings = room.settings;
      }
      if (Object.keys(patch).length) await tx.update(rooms).set(patch).where(eq(rooms.id, room.id));
      break;
    }
  }

  await maybeAutoReveal(tx, room, ctx.online);
  return result;
}

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------

/** Rounds whose timer ran out but are still hidden. */
export async function expiredRounds(db: Db) {
  return db
    .select({ roundId: rounds.id, roomId: items.roomId })
    .from(rounds)
    .innerJoin(items, eq(items.id, rounds.itemId))
    .where(and(isNull(rounds.revealedAt), sql`${rounds.endsAt} <= now()`));
}

export async function revealExpired(db: Db, roomId: string, roundId: string) {
  await withRoomLock(db, roomId, async (tx, room) => {
    const [round] = await tx.select().from(rounds).where(and(eq(rounds.id, roundId), isNull(rounds.revealedAt)));
    if (round) await revealRound(tx, room, round);
  });
}

export async function deleteExpiredRooms(db: Db) {
  const deleted = await db.delete(rooms).where(sql`${rooms.expiresAt} < now()`).returning({ id: rooms.id });
  return deleted.length;
}
