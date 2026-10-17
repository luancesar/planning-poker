import { boolean, doublePrecision, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import type { Deck } from '../../shared/decks';
import type { RoomSettings } from '../../shared/protocol';
import type { RoundStats } from '../../shared/stats';

export const roleEnum = pgEnum('participant_role', ['facilitator', 'voter', 'observer']);
export const itemStatusEnum = pgEnum('item_status', ['pending', 'voting', 'estimated', 'skipped']);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const rooms = pgTable(
  'rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 6 }).notNull(),
    name: text('name').notNull(),
    deck: jsonb('deck').$type<Deck>().notNull(),
    settings: jsonb('settings').$type<RoomSettings>().notNull(),
    passwordHash: text('password_hash'),
    persistent: boolean('persistent').notNull().default(true),
    currentItemId: uuid('current_item_id'),
    /** Bumped on every mutation; clients drop snapshots older than the one they hold. */
    seq: integer('seq').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('rooms_code_idx').on(t.code), index('rooms_expires_idx').on(t.expiresAt)],
);

export const participants = pgTable(
  'participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
    nickname: text('nickname').notNull(),
    role: roleEnum('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** Granted by a facilitator: may reveal votes regardless of the room's reveal setting. */
    canReveal: boolean('can_reveal').notNull().default(false),
    /** Observer asking to vote; waits for a facilitator's approval. */
    voteRequested: boolean('vote_requested').notNull().default(false),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('participants_token_idx').on(t.tokenHash), index('participants_room_idx').on(t.roomId)],
);

export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    link: text('link').notNull().default(''),
    position: integer('position').notNull(),
    status: itemStatusEnum('status').notNull().default('pending'),
    finalEstimate: text('final_estimate'),
    createdAt: createdAt(),
  },
  (t) => [index('items_room_idx').on(t.roomId, t.position)],
);

export const rounds = pgTable(
  'rounds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemId: uuid('item_id').notNull().references(() => items.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    revealedAt: timestamp('revealed_at', { withTimezone: true }),
    stats: jsonb('stats').$type<RoundStats>(),
  },
  (t) => [uniqueIndex('rounds_item_number_idx').on(t.itemId, t.number), index('rounds_open_timer_idx').on(t.endsAt)],
);

export const votes = pgTable(
  'votes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roundId: uuid('round_id').notNull().references(() => rounds.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id').notNull().references(() => participants.id, { onDelete: 'cascade' }),
    cardLabel: text('card_label').notNull(),
    numericValue: doublePrecision('numeric_value'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('votes_round_participant_idx').on(t.roundId, t.participantId)],
);

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemId: uuid('item_id').notNull().references(() => items.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id').notNull().references(() => participants.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    body: text('body').notNull(),
    /** Card the author had picked when commenting ("why I voted 13"). */
    voteLabel: text('vote_label'),
    pinned: boolean('pinned').notNull().default(false),
    createdAt: createdAt(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('comments_item_idx').on(t.itemId)],
);

export const reactions = pgTable(
  'reactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    commentId: uuid('comment_id').notNull().references(() => comments.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id').notNull().references(() => participants.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
  },
  (t) => [uniqueIndex('reactions_unique_idx').on(t.commentId, t.participantId, t.emoji)],
);
