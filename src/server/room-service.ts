import { and, asc, count, desc, eq, inArray, isNull, max, or, sql } from 'drizzle-orm';
import type pg from 'pg';
import { resolveDeck } from '../shared/decks';
import {
  CreateRoomSchema,
  JoinRoomSchema,
  LIMITS,
  type CreateRoomInput,
  type JoinResponse,
  type JoinRoomInput,
  type PermissionKey,
  type ParsedAction,
  type RoomPreview,
} from '../shared/protocol';
import { permissionsFor } from '../shared/permissions';
import { computeStats } from '../shared/stats';
import { hashPassword, hashToken, newRoomCode, newToken, normalizeCode, verifyPassword } from './auth';
import { connOn, type Db, type DbOrTx, type Tx } from './db/client';
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
  return {
    code: room.code,
    name: room.name,
    hasPassword: !!room.passwordHash,
    requireApproval: room.settings.requireApproval,
    deckName: room.deck.name,
    participantCount: n,
  };
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
    // With approval on, a would-be voter joins as an observer with a pending request.
    const pending = data.role === 'voter' && room.settings.requireApproval;
    const [p] = await tx
      .insert(participants)
      .values({ roomId: room.id, nickname: data.nickname, role: pending ? 'observer' : data.role, voteRequested: pending, tokenHash: hashToken(token) })
      .returning();
    return { code: room.code, token, participantId: p.id, pending };
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
  await Promise.all([
    db.update(participants).set({ lastSeenAt: new Date() }).where(eq(participants.id, participantId)),
    db
      .update(rooms)
      .set({ expiresAt: sql`now() + case when ${rooms.persistent} then interval '90 days' else interval '1 day' end` })
      .where(eq(rooms.id, roomId)),
  ]);
}

export async function getActiveParticipant(db: DbOrTx, roomId: string, participantId: string) {
  const [p] = await db
    .select()
    .from(participants)
    .where(and(eq(participants.id, participantId), eq(participants.roomId, roomId), isNull(participants.removedAt)));
  return p ?? null;
}

/**
 * A room row locked for the current transaction, plus a cache of the latest
 * round of its current item so one action never reads it twice.
 */
export type LockedRoom = RoomRow & { $round?: RoundRow | null; $roundFor?: string | null };

export type LockContext = { actor: ParticipantRow | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidLiteral(id: string | null) {
  if (id === null) return 'null';
  if (!UUID.test(id)) throw new Error(`Invalid uuid: ${id}`);
  return `'${id}'`;
}

const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
function camelize<T>(row: Record<string, unknown> | undefined): T | null {
  return row ? (Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v])) as T) : null;
}

/**
 * Runs a mutation with the room row locked (SELECT ... FOR UPDATE, so it is
 * serialized across every server instance) and bumps the room's sequence number.
 *
 * Built for a distant database: BEGIN, the lock, the actor and the current round
 * travel in one round trip, and the final update travels with COMMIT. Only ids
 * already validated as UUIDs are inlined, since multi-statement queries take no parameters.
 */
export async function withRoomLock<T>(
  db: Db,
  roomId: string,
  fn: (tx: Tx, room: LockedRoom, ctx: LockContext) => Promise<T>,
  opts: { actorId?: string } = {},
): Promise<T> {
  const room = uuidLiteral(roomId);
  const statements = [
    'begin',
    `select * from rooms where id = ${room} for update`,
    `select * from rounds where item_id = (select current_item_id from rooms where id = ${room}) order by number desc limit 1`,
  ];
  if (opts.actorId) {
    statements.push(`select * from participants where id = ${uuidLiteral(opts.actorId)} and room_id = ${room} and removed_at is null`);
  }

  const client = await db.$client.connect();
  let broken = false;
  try {
    const results = (await client.query(statements.join(';\n'))) as unknown as pg.QueryResult[];
    const locked = camelize<LockedRoom>(results[1].rows[0]);
    if (!locked) throw new ActionError('Sala não encontrada', 404);
    locked.$round = camelize<RoundRow>(results[2].rows[0]);
    locked.$roundFor = locked.currentItemId;
    const actor = opts.actorId ? camelize<ParticipantRow>(results[3].rows[0]) : null;

    const result = await fn(connOn(client), locked, { actor });

    const interval = locked.persistent ? '90 days' : '1 day';
    await client.query(
      `update rooms set seq = seq + 1, current_item_id = ${uuidLiteral(locked.currentItemId)}, expires_at = now() + interval '${interval}' where id = ${room};\ncommit`,
    );
    return result;
  } catch (e) {
    try {
      await client.query('rollback');
    } catch {
      broken = true;
    }
    throw e;
  } finally {
    client.release(broken);
  }
}

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

async function latestRound(tx: DbOrTx, itemId: string): Promise<RoundRow | null> {
  const [r] = await tx.select().from(rounds).where(eq(rounds.itemId, itemId)).orderBy(desc(rounds.number)).limit(1);
  return r ?? null;
}

/** Latest round of the current item if it is still open; served from the lock's cache when possible. */
async function openRound(tx: DbOrTx, room: LockedRoom) {
  if (!room.currentItemId) return null;
  if (room.$round === undefined || room.$roundFor !== room.currentItemId) {
    room.$round = await latestRound(tx, room.currentItemId);
    room.$roundFor = room.currentItemId;
  }
  const r = room.$round;
  return r && !r.revealedAt ? r : null;
}

async function startRound(tx: Tx, room: LockedRoom, itemId: string) {
  const previous = room.currentItemId && room.currentItemId !== itemId ? room.currentItemId : null;
  // New item goes to "voting"; the item we leave goes back to "pending" if it was being voted.
  await tx
    .update(items)
    .set({ status: sql`case when ${items.id} = ${itemId} then 'voting'::item_status else 'pending'::item_status end` })
    .where(previous ? or(eq(items.id, itemId), and(eq(items.id, previous), eq(items.status, 'voting'))) : eq(items.id, itemId));
  const timer = room.settings.timerSeconds;
  const [round] = await tx
    .insert(rounds)
    .values({
      itemId,
      number: sql`(select coalesce(max(${rounds.number}), 0) + 1 from ${rounds} where ${rounds.itemId} = ${itemId})`,
      endsAt: timer ? new Date(Date.now() + timer * 1000) : null,
    })
    .returning();
  room.currentItemId = itemId;
  room.$round = round;
  room.$roundFor = itemId;
}

export async function revealRound(tx: Tx, room: LockedRoom, round: RoundRow, knownVotes?: { cardLabel: string }[]) {
  const roundVotes = knownVotes ?? (await tx.select({ cardLabel: votes.cardLabel }).from(votes).where(eq(votes.roundId, round.id)));
  const revealedAt = new Date();
  const stats = computeStats(room.deck, roundVotes);
  await tx.update(rounds).set({ revealedAt, stats }).where(eq(rounds.id, round.id));
  if (room.$round?.id === round.id) room.$round = { ...round, revealedAt, stats };
}

/** Voting closes when the round timer runs out; votes stay hidden until someone reveals them. */
const timeIsUp = (round: RoundRow) => !!round.endsAt && round.endsAt.getTime() <= Date.now();

/** Moves to the first pending item after `afterPosition` (wrapping around); clears the current item when none is left. */
async function advance(tx: Tx, room: LockedRoom, afterPosition: number) {
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

const DENIED: Record<PermissionKey, string> = {
  reveal: 'Você não tem permissão para revelar os votos',
  rounds: 'Você não tem permissão para controlar as rodadas',
  items: 'Você não tem permissão para gerenciar os itens',
};

function requirePermission(actor: ParticipantRow, room: RoomRow, key: PermissionKey) {
  if (!permissionsFor(actor, room.settings)[key]) throw new ActionError(DENIED[key], 403);
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
  room: LockedRoom,
  actor: ParticipantRow,
  action: ParsedAction,
  ctx: ActionContext,
): Promise<ActionResult> {
  const result: ActionResult = {};

  switch (action.type) {
    case 'vote.cast': {
      if (!permissionsFor(actor, room.settings).vote) throw new ActionError('Seu papel nesta sala não permite votar', 403);
      const round = await openRound(tx, room);
      if (!round) throw new ActionError('Não há votação aberta');
      if (timeIsUp(round)) throw new ActionError('O tempo da rodada acabou');
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
      if (timeIsUp(round)) throw new ActionError('O tempo da rodada acabou');
      await tx.delete(votes).where(and(eq(votes.roundId, round.id), eq(votes.participantId, actor.id)));
      break;
    }

    case 'round.start': {
      requirePermission(actor, room, 'rounds');
      const item = await getItem(tx, room, action.itemId);
      await startRound(tx, room, item.id);
      break;
    }

    case 'round.reveal': {
      requirePermission(actor, room, 'reveal');
      const round = await openRound(tx, room);
      if (!round) throw new ActionError('Não há votação aberta');
      await revealRound(tx, room, round);
      break;
    }

    case 'round.reset': {
      requirePermission(actor, room, 'rounds');
      if (!room.currentItemId) throw new ActionError('Selecione um item primeiro');
      await startRound(tx, room, room.currentItemId);
      break;
    }

    case 'item.finalize': {
      requirePermission(actor, room, 'rounds');
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
      requirePermission(actor, room, 'rounds');
      const item = await getItem(tx, room, action.itemId);
      await tx.update(items).set({ status: 'skipped' }).where(eq(items.id, item.id));
      if (room.currentItemId === item.id) await advance(tx, room, item.position);
      break;
    }

    case 'item.reopen': {
      requirePermission(actor, room, 'items');
      const item = await getItem(tx, room, action.itemId);
      await tx.update(items).set({ status: 'pending', finalEstimate: null }).where(eq(items.id, item.id));
      if (room.currentItemId === item.id) await startRound(tx, room, item.id);
      break;
    }

    case 'item.add': {
      requirePermission(actor, room, 'items');
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
      requirePermission(actor, room, 'items');
      await getItem(tx, room, action.itemId);
      const patch: Partial<typeof items.$inferInsert> = {};
      if (action.title !== undefined) patch.title = action.title;
      if (action.description !== undefined) patch.description = action.description;
      if (action.link !== undefined) patch.link = action.link;
      if (Object.keys(patch).length) await tx.update(items).set(patch).where(eq(items.id, action.itemId));
      break;
    }

    case 'item.delete': {
      requirePermission(actor, room, 'items');
      await getItem(tx, room, action.itemId);
      if (room.currentItemId === action.itemId) room.currentItemId = null;
      await tx.delete(items).where(eq(items.id, action.itemId));
      break;
    }

    case 'item.move': {
      requirePermission(actor, room, 'items');
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
      let parentId: string | null = null;
      if (action.parentId) {
        const parent = await getComment(tx, room, action.parentId);
        if (parent.itemId !== action.itemId) throw new ActionError('Comentário de outro item');
        parentId = parent.parentId ?? parent.id; // threads are one level deep
      }
      // The item check and the author's vote in the latest round ride along with the insert.
      const voteLabel = action.attachVote
        ? sql`(select v.card_label from ${votes} v where v.participant_id = ${actor.id}::uuid
                 and v.round_id = (select r.id from ${rounds} r where r.item_id = i.id order by r.number desc limit 1))`
        : sql`null`;
      const inserted = await tx.execute(sql`
        insert into ${comments} (item_id, participant_id, parent_id, body, vote_label)
        select i.id, ${actor.id}::uuid, ${parentId}::uuid, ${action.body}::text, ${voteLabel}
        from ${items} i
        where i.id = ${action.itemId} and i.room_id = ${room.id}
        returning id`);
      if (inserted.rows.length === 0) throw new ActionError('Item não encontrado', 404);
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
      await tx.update(participants).set({ role: action.role, voteRequested: false }).where(eq(participants.id, target.id));
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

    case 'participant.setCanReveal': {
      requireFacilitator(actor);
      const target = await getTarget(tx, room, action.participantId);
      await tx.update(participants).set({ canReveal: action.canReveal }).where(eq(participants.id, target.id));
      break;
    }

    case 'participant.requestVote': {
      if (actor.role !== 'observer') throw new ActionError('Você já pode votar');
      if (!room.settings.requireApproval) {
        await tx.update(participants).set({ role: 'voter', voteRequested: false }).where(eq(participants.id, actor.id));
      } else {
        await tx.update(participants).set({ voteRequested: true }).where(eq(participants.id, actor.id));
      }
      break;
    }

    case 'participant.reviewVote': {
      requireFacilitator(actor);
      await tx
        .update(participants)
        .set(action.approve ? { role: 'voter', voteRequested: false } : { voteRequested: false })
        .where(
          and(
            eq(participants.roomId, room.id),
            inArray(participants.id, action.participantIds),
            eq(participants.voteRequested, true),
            isNull(participants.removedAt),
          ),
        );
      break;
    }

    case 'room.update': {
      requireFacilitator(actor);
      const patch: Partial<typeof rooms.$inferInsert> = {};
      if (action.name) patch.name = action.name;
      if (action.settings) {
        const { permissions, ...rest } = action.settings;
        room.settings = { ...room.settings, ...rest, permissions: { ...room.settings.permissions, ...permissions } };
        patch.settings = room.settings;
        // Turning approval off lets everyone who was waiting vote right away.
        if (rest.requireApproval === false) {
          await tx
            .update(participants)
            .set({ role: 'voter', voteRequested: false })
            .where(and(eq(participants.roomId, room.id), eq(participants.voteRequested, true), isNull(participants.removedAt)));
        }
      }
      if (Object.keys(patch).length) await tx.update(rooms).set(patch).where(eq(rooms.id, room.id));
      break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------

export async function deleteExpiredRooms(db: Db) {
  const deleted = await db.delete(rooms).where(sql`${rooms.expiresAt} < now()`).returning({ id: rooms.id });
  return deleted.length;
}
