import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { RoundStats } from '../shared/stats';
import type { Db } from './db/client';
import { comments, items, participants, rooms, rounds, votes } from './db/schema';

export type SessionSummary = {
  room: { name: string; code: string; deckName: string };
  exportedAt: string;
  items: {
    position: number;
    title: string;
    description: string;
    link: string;
    status: string;
    finalEstimate: string | null;
    /** Only revealed rounds: hidden votes are never exported. */
    rounds: { number: number; votes: { name: string; label: string }[]; stats: RoundStats | null }[];
    comments: { author: string; body: string; voteLabel: string | null; pinned: boolean; createdAt: string }[];
  }[];
};

export async function loadSummary(db: Db, roomId: string): Promise<SessionSummary | null> {
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));
  if (!room) return null;
  const people = await db.select({ id: participants.id, nickname: participants.nickname }).from(participants).where(eq(participants.roomId, roomId));
  const names = new Map(people.map((p) => [p.id, p.nickname]));
  const itemRows = await db.select().from(items).where(eq(items.roomId, roomId)).orderBy(asc(items.position));
  const ids = itemRows.map((i) => i.id);

  const roundRows = ids.length ? await db.select().from(rounds).where(inArray(rounds.itemId, ids)).orderBy(asc(rounds.number)) : [];
  const revealedIds = roundRows.filter((r) => r.revealedAt).map((r) => r.id);
  const voteRows = revealedIds.length ? await db.select().from(votes).where(inArray(votes.roundId, revealedIds)).orderBy(asc(votes.createdAt)) : [];
  const commentRows = ids.length
    ? await db.select().from(comments).where(and(inArray(comments.itemId, ids), isNull(comments.deletedAt))).orderBy(asc(comments.createdAt))
    : [];

  return {
    room: { name: room.name, code: room.code, deckName: room.deck.name },
    exportedAt: new Date().toISOString(),
    items: itemRows.map((item, index) => ({
      position: index + 1,
      title: item.title,
      description: item.description,
      link: item.link,
      status: item.status,
      finalEstimate: item.finalEstimate,
      rounds: roundRows
        .filter((r) => r.itemId === item.id && r.revealedAt)
        .map((r) => ({
          number: r.number,
          stats: r.stats,
          votes: voteRows.filter((v) => v.roundId === r.id).map((v) => ({ name: names.get(v.participantId) ?? '—', label: v.cardLabel })),
        })),
      comments: commentRows
        .filter((c) => c.itemId === item.id)
        .map((c) => ({
          author: names.get(c.participantId) ?? '—',
          body: c.body,
          voteLabel: c.voteLabel,
          pinned: c.pinned,
          createdAt: c.createdAt.toISOString(),
        })),
    })),
  };
}

const STATUS_PT: Record<string, string> = { pending: 'Pendente', voting: 'Em votação', estimated: 'Estimado', skipped: 'Pulado' };

function csvCell(value: string | number | null | undefined) {
  const s = value === null || value === undefined ? '' : String(value);
  // Prefix formula-like values so spreadsheets do not execute them.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function summaryToCsv(summary: SessionSummary) {
  const header = ['#', 'Item', 'Status', 'Estimativa final', 'Rodadas', 'Votos (última rodada)', 'Média', 'Mediana', 'Comentários', 'Link', 'Descrição'];
  const rows = summary.items.map((item) => {
    const last = item.rounds.at(-1);
    return [
      item.position,
      item.title,
      STATUS_PT[item.status] ?? item.status,
      item.finalEstimate,
      item.rounds.length,
      last?.votes.map((v) => `${v.name}: ${v.label}`).join('; '),
      last?.stats?.average,
      last?.stats?.median,
      item.comments.map((c) => `${c.author}${c.voteLabel ? ` (${c.voteLabel})` : ''}: ${c.body}`).join(' | '),
      item.link,
      item.description,
    ];
  });
  // BOM so Excel opens the file as UTF-8.
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
