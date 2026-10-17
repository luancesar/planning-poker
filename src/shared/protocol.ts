import { z } from 'zod';
import type { Deck } from './decks';
import type { RoundStats } from './stats';

export const LIMITS = {
  nickname: 32,
  roomName: 80,
  itemTitle: 200,
  itemDescription: 4000,
  link: 500,
  comment: 2000,
  itemsPerRoom: 500,
  itemsPerBatch: 200,
  participantsPerRoom: 50,
  password: 100,
} as const;

export const REACTIONS = ['👍', '👎', '🎉', '🤔', '❤️'] as const;

export const RoleSchema = z.enum(['facilitator', 'voter', 'observer']);
export type Role = z.infer<typeof RoleSchema>;

export const ItemStatusSchema = z.enum(['pending', 'voting', 'estimated', 'skipped']);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

/** Who may perform a group of actions; facilitators can always do everything. */
export const PermissionLevelSchema = z.enum(['facilitators', 'voters']);
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;

export const PermissionsSchema = z.object({
  /** Reveal the votes of a round (people can also be granted this one by one). */
  reveal: PermissionLevelSchema,
  /** Start, restart and skip rounds, and set the final estimate. */
  rounds: PermissionLevelSchema,
  /** Add, edit, delete, reorder and reopen items. */
  items: PermissionLevelSchema,
});
export type Permissions = z.infer<typeof PermissionsSchema>;
export type PermissionKey = keyof Permissions;

export const RoomSettingsSchema = z.object({
  /** Seconds per round; null disables the timer. When it runs out voting closes, but votes stay hidden. */
  timerSeconds: z.number().int().min(30).max(300).nullable(),
  facilitatorVotes: z.boolean(),
  /** New voters join as observers until a facilitator approves them. */
  requireApproval: z.boolean(),
  permissions: PermissionsSchema,
});
export type RoomSettings = z.infer<typeof RoomSettingsSchema>;

export const DEFAULT_SETTINGS: RoomSettings = {
  timerSeconds: null,
  facilitatorVotes: true,
  requireApproval: true,
  permissions: { reveal: 'facilitators', rounds: 'facilitators', items: 'facilitators' },
};

export const RoomSettingsPatchSchema = RoomSettingsSchema.omit({ permissions: true })
  .partial()
  .extend({ permissions: PermissionsSchema.partial().optional() });

const nickname = z.string().trim().min(1, 'Informe um apelido').max(LIMITS.nickname);
const id = z.string().uuid();
const optionalText = (max: number) => z.string().trim().max(max).optional();
const link = z
  .string()
  .trim()
  .max(LIMITS.link)
  .refine((v) => v === '' || /^https?:\/\//i.test(v), 'O link deve começar com http:// ou https://')
  .optional();

export const NewItemSchema = z.object({
  title: z.string().trim().min(1, 'Informe o título').max(LIMITS.itemTitle),
  description: optionalText(LIMITS.itemDescription),
  link,
});
export type NewItem = z.infer<typeof NewItemSchema>;

// ---- REST ----

export const CreateRoomSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome da sala').max(LIMITS.roomName),
  nickname,
  deckId: z.string(),
  customCards: z.string().max(400).optional(),
  settings: RoomSettingsSchema.default(DEFAULT_SETTINGS),
  persistent: z.boolean().default(true),
  password: z.string().max(LIMITS.password).optional(),
});
export type CreateRoomInput = z.input<typeof CreateRoomSchema>;

export const JoinRoomSchema = z.object({
  nickname,
  role: z.enum(['voter', 'observer']).default('voter'),
  password: z.string().max(LIMITS.password).optional(),
});
export type JoinRoomInput = z.input<typeof JoinRoomSchema>;

export type RoomPreview = { code: string; name: string; hasPassword: boolean; requireApproval: boolean; deckName: string; participantCount: number };

/** `pending` = asked to vote and waits for a facilitator's approval (joined as observer). */
export type JoinResponse = { code: string; token: string; participantId: string; pending?: boolean };

// ---- Realtime actions (client -> server) ----

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('vote.cast'), label: z.string().max(16) }),
  z.object({ type: z.literal('vote.retract') }),
  z.object({ type: z.literal('round.start'), itemId: id }),
  z.object({ type: z.literal('round.reveal') }),
  z.object({ type: z.literal('round.reset') }),
  z.object({ type: z.literal('item.finalize'), itemId: id, estimate: z.string().trim().min(1).max(16), advance: z.boolean() }),
  z.object({ type: z.literal('item.skip'), itemId: id }),
  z.object({ type: z.literal('item.reopen'), itemId: id }),
  z.object({ type: z.literal('item.add'), items: z.array(NewItemSchema).min(1).max(LIMITS.itemsPerBatch) }),
  z.object({
    type: z.literal('item.update'),
    itemId: id,
    title: NewItemSchema.shape.title.optional(),
    description: NewItemSchema.shape.description,
    link: NewItemSchema.shape.link,
  }),
  z.object({ type: z.literal('item.delete'), itemId: id }),
  z.object({ type: z.literal('item.move'), itemId: id, toIndex: z.number().int().min(0) }),
  z.object({
    type: z.literal('comment.create'),
    itemId: id,
    body: z.string().trim().min(1, 'Comentário vazio').max(LIMITS.comment),
    attachVote: z.boolean().default(false),
    parentId: id.optional(),
  }),
  z.object({ type: z.literal('comment.update'), commentId: id, body: z.string().trim().min(1).max(LIMITS.comment) }),
  z.object({ type: z.literal('comment.delete'), commentId: id }),
  z.object({ type: z.literal('comment.pin'), commentId: id, pinned: z.boolean() }),
  z.object({ type: z.literal('comment.react'), commentId: id, emoji: z.enum(REACTIONS) }),
  z.object({ type: z.literal('participant.setRole'), participantId: id, role: RoleSchema }),
  z.object({ type: z.literal('participant.remove'), participantId: id }),
  z.object({ type: z.literal('participant.rename'), nickname }),
  z.object({ type: z.literal('participant.setCanReveal'), participantId: id, canReveal: z.boolean() }),
  z.object({ type: z.literal('participant.requestVote') }),
  z.object({ type: z.literal('participant.reviewVote'), participantIds: z.array(id).min(1).max(LIMITS.participantsPerRoom), approve: z.boolean() }),
  z.object({
    type: z.literal('room.update'),
    name: z.string().trim().min(1).max(LIMITS.roomName).optional(),
    settings: RoomSettingsPatchSchema.optional(),
  }),
]);
export type Action = z.input<typeof ActionSchema>;
export type ParsedAction = z.infer<typeof ActionSchema>;

export type ActionAck = { ok: true } | { ok: false; error: string };

// ---- Realtime state (server -> client) ----

export type ParticipantView = {
  id: string;
  nickname: string;
  role: Role;
  online: boolean;
  hasVoted: boolean;
  /** Granted the right to reveal votes one by one (facilitators always can). */
  canReveal: boolean;
  /** Observer waiting for approval to vote. */
  voteRequested: boolean;
};

export type ItemView = {
  id: string;
  title: string;
  description: string;
  link: string;
  status: ItemStatus;
  finalEstimate: string | null;
  roundCount: number;
};

export type RoundView = {
  id: string;
  itemId: string;
  number: number;
  startedAt: number;
  endsAt: number | null;
  revealedAt: number | null;
  /** Before reveal, label is null for everyone except the viewer. */
  votes: { participantId: string; label: string | null }[];
  myVote: string | null;
  stats: RoundStats | null;
};

export type CommentView = {
  id: string;
  itemId: string;
  participantId: string;
  authorName: string;
  body: string;
  voteLabel: string | null;
  pinned: boolean;
  parentId: string | null;
  createdAt: number;
  editedAt: number | null;
  reactions: { emoji: string; count: number; mine: boolean }[];
};

export type RoomState = {
  seq: number;
  serverTime: number;
  room: {
    id: string;
    code: string;
    name: string;
    deck: Deck;
    settings: RoomSettings;
    hasPassword: boolean;
    persistent: boolean;
    currentItemId: string | null;
  };
  me: {
    participantId: string;
    nickname: string;
    role: Role;
    voteRequested: boolean;
    /** What the viewer may do, resolved on the server from role, grants and room settings. */
    can: Record<PermissionKey, boolean> & { vote: boolean; manageRoom: boolean };
  };
  participants: ParticipantView[];
  items: ItemView[];
  round: RoundView | null;
  comments: CommentView[];
};

export const SOCKET_EVENTS = {
  action: 'action',
  snapshot: 'room.snapshot',
  removed: 'room.removed',
} as const;
