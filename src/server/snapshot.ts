import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { permissionsFor } from '../shared/permissions';
import type { CommentView, ItemView, RoomState } from '../shared/protocol';
import type { DbOrTx } from './db/client';
import { comments, items, participants, reactions, rooms, rounds, votes } from './db/schema';

/** Everything needed to render a room, loaded once and then tailored per viewer. */
export type RoomBase = NonNullable<Awaited<ReturnType<typeof loadRoomBase>>>;

export async function loadRoomBase(db: DbOrTx, roomId: string) {
  // Every query is independent (the current round is found through a subquery),
  // so they run in parallel: one round trip to the database instead of seven.
  const currentRound = db
    .select({ id: rounds.id })
    .from(rounds)
    .where(eq(rounds.itemId, sql`(select ${rooms.currentItemId} from ${rooms} where ${rooms.id} = ${roomId})`))
    .orderBy(desc(rounds.number))
    .limit(1);
  const roundCounts = db
    .select({ itemId: rounds.itemId, n: count().as('n') })
    .from(rounds)
    .innerJoin(items, eq(items.id, rounds.itemId))
    .where(eq(items.roomId, roomId))
    .groupBy(rounds.itemId)
    .as('round_counts');

  const [[room], people, itemRows, [round], roundVotes, commentRows, reactionRows] = await Promise.all([
    db.select().from(rooms).where(eq(rooms.id, roomId)),
    db.select().from(participants).where(eq(participants.roomId, roomId)).orderBy(asc(participants.createdAt)),
    db
      .select({ item: items, roundCount: roundCounts.n })
      .from(items)
      .leftJoin(roundCounts, eq(roundCounts.itemId, items.id))
      .where(eq(items.roomId, roomId))
      .orderBy(asc(items.position)),
    db.select().from(rounds).where(inArray(rounds.id, currentRound)),
    db
      .select({ participantId: votes.participantId, label: votes.cardLabel })
      .from(votes)
      .where(inArray(votes.roundId, currentRound))
      .orderBy(asc(votes.createdAt)),
    db
      .select({ comment: comments })
      .from(comments)
      .innerJoin(items, eq(items.id, comments.itemId))
      .where(and(eq(items.roomId, roomId), isNull(comments.deletedAt)))
      .orderBy(asc(comments.createdAt))
      .then((rows) => rows.map((r) => r.comment)),
    db
      .select({ reaction: reactions })
      .from(reactions)
      .innerJoin(comments, eq(comments.id, reactions.commentId))
      .innerJoin(items, eq(items.id, comments.itemId))
      .where(and(eq(items.roomId, roomId), isNull(comments.deletedAt)))
      .then((rows) => rows.map((r) => r.reaction)),
  ]);
  if (!room) return null;

  return { room, people, itemRows, round: round ?? null, roundVotes, commentRows, reactionRows };
}

export function viewFor(base: RoomBase, participantId: string, online: Set<string>): RoomState | null {
  const { room, people, round, roundVotes } = base;
  const me = people.find((p) => p.id === participantId && !p.removedAt);
  if (!me) return null;

  const names = new Map(people.map((p) => [p.id, p.nickname]));
  const voted = new Set(roundVotes.map((v) => v.participantId));
  const revealed = !!round?.revealedAt;

  const items: ItemView[] = base.itemRows.map(({ item, roundCount }) => ({
    id: item.id,
    title: item.title,
    description: item.description,
    link: item.link,
    status: item.status,
    finalEstimate: item.finalEstimate,
    roundCount: roundCount ?? 0,
  }));

  const comments: CommentView[] = base.commentRows.map((c) => {
    const byEmoji = new Map<string, { count: number; mine: boolean }>();
    for (const r of base.reactionRows) {
      if (r.commentId !== c.id) continue;
      const entry = byEmoji.get(r.emoji) ?? { count: 0, mine: false };
      entry.count++;
      entry.mine ||= r.participantId === participantId;
      byEmoji.set(r.emoji, entry);
    }
    return {
      id: c.id,
      itemId: c.itemId,
      participantId: c.participantId,
      authorName: names.get(c.participantId) ?? '—',
      body: c.body,
      voteLabel: c.voteLabel,
      pinned: c.pinned,
      parentId: c.parentId,
      createdAt: c.createdAt.getTime(),
      editedAt: c.editedAt?.getTime() ?? null,
      reactions: [...byEmoji].map(([emoji, v]) => ({ emoji, ...v })),
    };
  });

  return {
    seq: room.seq,
    serverTime: Date.now(),
    room: {
      id: room.id,
      code: room.code,
      name: room.name,
      deck: room.deck,
      settings: room.settings,
      hasPassword: !!room.passwordHash,
      persistent: room.persistent,
      currentItemId: room.currentItemId,
    },
    me: {
      participantId: me.id,
      nickname: me.nickname,
      role: me.role,
      voteRequested: me.voteRequested,
      can: permissionsFor(me, room.settings),
    },
    participants: people
      .filter((p) => !p.removedAt)
      .map((p) => ({
        id: p.id,
        nickname: p.nickname,
        role: p.role,
        online: online.has(p.id),
        hasVoted: voted.has(p.id),
        canReveal: p.canReveal,
        voteRequested: p.voteRequested,
      })),
    items,
    round: round
      ? {
          id: round.id,
          itemId: round.itemId,
          number: round.number,
          startedAt: round.startedAt.getTime(),
          endsAt: round.endsAt?.getTime() ?? null,
          revealedAt: round.revealedAt?.getTime() ?? null,
          // Vote values never leave the server before the reveal, except the viewer's own.
          votes: roundVotes.map((v) => ({
            participantId: v.participantId,
            label: revealed || v.participantId === participantId ? v.label : null,
          })),
          myVote: roundVotes.find((v) => v.participantId === participantId)?.label ?? null,
          stats: revealed ? round.stats : null,
        }
      : null,
    comments,
  };
}
