'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { REACTIONS, type Action, type CommentView, type RoomState } from '@/shared/protocol';
import { Badge, Button, Menu, Panel, Textarea, cx } from './ui';

type Run = (action: Action) => Promise<boolean>;

const time = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** Highlights @mentions of people in the room. */
function Body({ text, names }: { text: string; names: string[] }) {
  const lower = names.map((n) => n.toLowerCase());
  const parts = text.split(/(@[\p{L}\p{N}_.-]+)/u);
  return (
    <p className="text-sm whitespace-pre-wrap break-words">
      {parts.map((part, i) =>
        part.startsWith('@') && lower.some((n) => n.startsWith(part.slice(1).toLowerCase())) ? (
          <span key={i} className="rounded bg-accent-soft px-0.5 font-medium text-accent-strong">
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </p>
  );
}

function Comment({
  comment,
  state,
  run,
  names,
  onReply,
  reply = false,
}: {
  comment: CommentView;
  state: RoomState;
  run: Run;
  names: string[];
  onReply: (c: CommentView) => void;
  reply?: boolean;
}) {
  const mine = comment.participantId === state.me.participantId;
  const isFacilitator = state.me.role === 'facilitator';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [picker, setPicker] = useState(false);

  return (
    <article className={cx('group flex flex-col gap-1.5 rounded-lg p-2.5', comment.pinned ? 'bg-good-soft/60 ring-1 ring-good/30' : 'hover:bg-surface-2/60', reply && 'ml-6')}>
      <header className="flex items-center gap-1.5 text-xs">
        <span className="font-semibold text-ink">{comment.authorName}</span>
        {comment.voteLabel && <Badge tone="accent">votou {comment.voteLabel}</Badge>}
        {comment.pinned && <Badge tone="good">📌 Decisão</Badge>}
        <span className="text-muted">
          {time(comment.createdAt)}
          {comment.editedAt && ' · editado'}
        </span>
        <div className="ml-auto opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
          <Menu
            label="Ações do comentário"
            items={[
              { label: 'Responder', hidden: reply, onSelect: () => onReply(comment) },
              { label: 'Editar', hidden: !mine, onSelect: () => (setDraft(comment.body), setEditing(true)) },
              { label: comment.pinned ? 'Desafixar' : 'Fixar como decisão', hidden: !isFacilitator, onSelect: () => run({ type: 'comment.pin', commentId: comment.id, pinned: !comment.pinned }) },
              { label: 'Excluir', danger: true, hidden: !mine && !isFacilitator, onSelect: () => confirm('Excluir este comentário?') && run({ type: 'comment.delete', commentId: comment.id }) },
            ]}
          />
        </div>
      </header>
      {editing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run({ type: 'comment.update', commentId: comment.id, body: draft })) setEditing(false);
          }}
        >
          <Textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={2000} autoFocus />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" disabled={!draft.trim()}>
              Salvar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      ) : (
        <Body text={comment.body} names={names} />
      )}
      <div className="flex flex-wrap items-center gap-1">
        {comment.reactions.map((r) => (
          <button
            key={r.emoji}
            type="button"
            onClick={() => run({ type: 'comment.react', commentId: comment.id, emoji: r.emoji as (typeof REACTIONS)[number] })}
            className={cx('rounded-full border px-1.5 text-xs', r.mine ? 'border-accent bg-accent-soft' : 'border-line bg-surface')}
            aria-pressed={r.mine}
          >
            {r.emoji} {r.count}
          </button>
        ))}
        <div className="relative">
          <button type="button" className="rounded-full px-1.5 text-xs text-muted hover:bg-surface-2" onClick={() => setPicker((v) => !v)} aria-label="Reagir">
            ☺+
          </button>
          {picker && (
            <div className="absolute bottom-6 left-0 z-10 flex gap-1 rounded-full border border-line bg-surface p-1 shadow-lg">
              {REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="rounded-full px-1 hover:bg-surface-2"
                  onClick={() => {
                    setPicker(false);
                    run({ type: 'comment.react', commentId: comment.id, emoji });
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

export function CommentsPanel({ state, run, itemId }: { state: RoomState; run: Run; itemId: string | null }) {
  const item = state.items.find((i) => i.id === itemId);
  const all = state.comments.filter((c) => c.itemId === itemId);
  const top = all.filter((c) => !c.parentId);
  const ordered = [...top.filter((c) => c.pinned), ...top.filter((c) => !c.pinned)];
  const replies = (id: string) => all.filter((c) => c.parentId === id);
  const names = state.participants.map((p) => p.nickname);

  const [body, setBody] = useState('');
  const [attachVote, setAttachVote] = useState(true);
  const [replyTo, setReplyTo] = useState<CommentView | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const myVote = state.round?.itemId === itemId ? state.round?.myVote : null;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [all.length, itemId]);
  useEffect(() => setReplyTo(null), [itemId]);

  async function submit() {
    if (!itemId || !body.trim()) return;
    const ok = await run({ type: 'comment.create', itemId, body, attachVote: !!myVote && attachVote, parentId: replyTo?.id });
    if (ok) {
      setBody('');
      setReplyTo(null);
    }
  }

  return (
    <Panel className="flex min-h-0 flex-col">
      <div className="border-b border-line px-4 py-3">
        <h2 className="font-semibold">Comentários</h2>
        <p className="truncate text-xs text-muted" title={item?.title}>
          {item ? item.title : 'Selecione um item'}
        </p>
      </div>
      <div ref={listRef} className="flex min-h-40 flex-1 flex-col gap-1 overflow-y-auto p-2">
        {item && ordered.length === 0 && <p className="p-4 text-center text-sm text-muted">Sem comentários. Explique seu voto ou registre dúvidas sobre o item.</p>}
        {ordered.map((c) => (
          <Fragment key={c.id}>
            <Comment comment={c} state={state} run={run} names={names} onReply={setReplyTo} />
            {replies(c.id).map((r) => (
              <Comment key={r.id} comment={r} state={state} run={run} names={names} onReply={setReplyTo} reply />
            ))}
          </Fragment>
        ))}
      </div>
      {item && (
        <form
          className="flex flex-col gap-2 border-t border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {replyTo && (
            <div className="flex items-center justify-between rounded-md bg-surface-2 px-2 py-1 text-xs text-muted">
              <span className="truncate">
                Respondendo a <strong className="text-ink">{replyTo.authorName}</strong>
              </span>
              <button type="button" onClick={() => setReplyTo(null)} aria-label="Cancelar resposta">
                ✕
              </button>
            </div>
          )}
          <Textarea
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Escreva um comentário… use @ para mencionar"
            maxLength={2000}
            aria-label="Novo comentário"
          />
          <div className="flex items-center justify-between gap-2">
            {myVote ? (
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" checked={attachVote} onChange={(e) => setAttachVote(e.target.checked)} className="accent-[var(--app-accent)]" />
                Anexar meu voto ({myVote})
              </label>
            ) : (
              <span className="text-xs text-muted">Enter envia · Shift+Enter quebra linha</span>
            )}
            <Button type="submit" size="sm" variant="primary" disabled={!body.trim()}>
              Enviar
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}
