'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { saveLastNickname } from '@/lib/session';
import { useRoom } from '@/lib/useRoom';
import type { Action, JoinResponse, PermissionKey, PermissionLevel, RoomState } from '@/shared/protocol';
import { CommentsPanel } from './CommentsPanel';
import { ItemsPanel } from './ItemsPanel';
import { Button, Field, Input, Menu, Modal, Select, Toggle, cx } from './ui';
import { VotingArea } from './VotingArea';

type Run = (action: Action) => Promise<boolean>;

const LEVELS: [PermissionLevel, string][] = [
  ['facilitators', 'Só facilitadores'],
  ['voters', 'Facilitadores e votantes'],
];

const PERMISSION_FIELDS: [PermissionKey, string, string][] = [
  ['reveal', 'Revelar votos', 'Você também pode liberar pessoas específicas no menu de cada participante.'],
  ['rounds', 'Controlar rodadas', 'Iniciar, reiniciar e pular votação, e definir a estimativa final.'],
  ['items', 'Gerenciar itens', 'Adicionar, editar, excluir, reordenar e reabrir itens.'],
];

function SettingsModal({ open, onClose, state, run }: { open: boolean; onClose: () => void; state: RoomState; run: Run }) {
  const [name, setName] = useState(state.room.name);
  const [settings, setSettings] = useState(state.room.settings);
  useEffect(() => {
    if (open) {
      setName(state.room.name);
      setSettings(state.room.settings);
    }
    // Only reload the form when it opens, so remote updates do not wipe edits in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const pending = state.participants.filter((p) => p.voteRequested).length;
  return (
    <Modal open={open} onClose={onClose} title="Configurações da sala">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run({ type: 'room.update', name, settings })) onClose();
        }}
      >
        <Field label="Nome da sala">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
        </Field>
        <Toggle
          checked={settings.requireApproval}
          onChange={(requireApproval) => setSettings({ ...settings, requireApproval })}
          label="Aprovar quem vota"
          hint={
            !settings.requireApproval && pending > 0 && state.room.settings.requireApproval
              ? `Ao salvar, ${pending} ${pending === 1 ? 'pedido pendente será aprovado' : 'pedidos pendentes serão aprovados'}.`
              : 'Quem entra fica como observador até um facilitador liberar o voto.'
          }
        />
        <Toggle checked={settings.facilitatorVotes} onChange={(facilitatorVotes) => setSettings({ ...settings, facilitatorVotes })} label="Facilitador também vota" />
        <Field label="Timer por rodada" hint="Quando o tempo acaba a votação fecha; os votos só aparecem quando alguém revelar.">
          <Select
            value={settings.timerSeconds ?? ''}
            onChange={(e) => setSettings({ ...settings, timerSeconds: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">Sem timer</option>
            <option value="30">30 segundos</option>
            <option value="60">1 minuto</option>
            <option value="120">2 minutos</option>
            <option value="180">3 minutos</option>
            <option value="300">5 minutos</option>
          </Select>
        </Field>
        <fieldset className="flex flex-col gap-3 border-t border-line pt-4">
          <legend className="pt-4 text-sm font-semibold">Permissões</legend>
          {PERMISSION_FIELDS.map(([key, label, hint]) => (
            <Field key={key} label={label} hint={hint}>
              <Select
                value={settings.permissions[key]}
                onChange={(e) => setSettings({ ...settings, permissions: { ...settings.permissions, [key]: e.target.value as PermissionLevel } })}
              >
                {LEVELS.map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
          <p className="text-xs text-muted">Gerenciar participantes, aprovar votos e estas configurações continuam restritos a facilitadores.</p>
        </fieldset>
        <Button type="submit" variant="primary">
          Salvar
        </Button>
      </form>
    </Modal>
  );
}

function RenameModal({ open, onClose, state, run }: { open: boolean; onClose: () => void; state: RoomState; run: Run }) {
  const [nickname, setNickname] = useState(state.me.nickname);
  useEffect(() => {
    if (open) setNickname(state.me.nickname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} title="Alterar apelido">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run({ type: 'participant.rename', nickname })) {
            saveLastNickname(nickname);
            onClose();
          }
        }}
      >
        <Input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={32} required autoFocus aria-label="Apelido" />
        <Button type="submit" variant="primary">
          Salvar
        </Button>
      </form>
    </Modal>
  );
}

type Tab = 'vote' | 'items' | 'comments';

export function RoomView({ session, onSessionLost }: { session: JoinResponse; onSessionLost: (reason: 'removed' | 'unauthorized' | 'left') => void }) {
  const { state, status, send, clockOffset } = useRoom(session.code, session.token);
  const [toast, setToast] = useState('');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('vote');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (status === 'removed' || status === 'unauthorized') onSessionLost(status);
  }, [status, onSessionLost]);

  // Follow the item being voted until the user picks another one.
  const currentItemId = state?.room.currentItemId ?? null;
  useEffect(() => setSelectedItemId(null), [currentItemId]);

  useEffect(() => {
    if (state) document.title = `${state.room.name} · Planning Poker`;
  }, [state?.room.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const showError = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 4000);
  }, []);

  const run: Run = useCallback(
    async (action) => {
      const ack = await send(action);
      if (!ack.ok) showError(ack.error);
      return ack.ok;
    },
    [send, showError],
  );

  if (!state) {
    return (
      <main className="grid min-h-dvh place-items-center text-sm text-muted">
        {status === 'offline' ? 'Não foi possível conectar. Tentando novamente…' : 'Conectando à sala…'}
      </main>
    );
  }

  const viewItemId = selectedItemId ?? currentItemId ?? state.items[0]?.id ?? null;
  const online = state.participants.filter((p) => p.online).length;
  const commentCount = state.comments.filter((c) => c.itemId === viewItemId).length;

  async function copyInvite() {
    const url = `${location.origin}/r/${state!.room.code}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      prompt('Copie o link da sala:', url);
    }
  }

  const tabs: [Tab, string][] = [
    ['vote', 'Votação'],
    ['items', `Itens (${state.items.length})`],
    ['comments', `Comentários (${commentCount})`],
  ];

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-[90rem] items-center gap-3 px-4 py-2.5">
          <Link href="/" aria-label="Início" className="grid size-8 shrink-0 place-items-center rounded-md bg-accent text-on-accent">
            ♠
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-semibold">{state.room.name}</h1>
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className={cx('size-1.5 rounded-full', status === 'online' ? 'bg-good' : 'animate-pulse bg-warn')} />
              <span>{status === 'online' ? `${online} online` : 'Reconectando…'}</span>
              <span className="hidden sm:inline">· {state.room.deck.name}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={copyInvite}
            className="hidden items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-surface-2 sm:flex"
            title="Copiar link de convite"
          >
            <span className="font-mono font-semibold tracking-[0.2em]">{state.room.code}</span>
            <span className="text-muted">{copied ? 'Link copiado ✓' : 'Convidar'}</span>
          </button>
          <Button size="sm" className="sm:hidden" onClick={copyInvite}>
            {copied ? '✓' : 'Convidar'}
          </Button>
          <Menu
            label="Menu da sala"
            trigger={<span className="max-w-28 truncate text-sm text-ink">{state.me.nickname} ▾</span>}
            items={[
              { label: 'Configurações da sala', hidden: !state.me.can.manageRoom, onSelect: () => setSettingsOpen(true) },
              { label: 'Resumo da sessão / PDF', onSelect: () => window.open(`/r/${state.room.code}/resumo`, '_blank') },
              { label: 'Exportar CSV', onSelect: () => api.downloadCsv(state.room.code, session.token).catch((e: Error) => showError(e.message)) },
              { label: 'Alterar apelido', onSelect: () => setRenameOpen(true) },
              {
                label: 'Sair da sala',
                danger: true,
                onSelect: () => {
                  if (confirm('Sair desta sala neste navegador? Você poderá entrar de novo pelo link.')) onSessionLost('left');
                },
              },
            ]}
          />
        </div>
        <nav className="flex border-t border-line lg:hidden" aria-label="Seções">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cx('flex-1 py-2 text-sm', tab === key ? 'border-b-2 border-accent font-semibold text-ink' : 'text-muted')}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto grid w-full max-w-[90rem] flex-1 gap-4 px-4 py-4 lg:grid-cols-[19rem_minmax(0,1fr)_22rem] lg:items-start">
        <div className={cx('lg:sticky lg:top-20 lg:flex lg:max-h-[calc(100dvh-6rem)] lg:flex-col', tab === 'items' ? 'flex flex-col' : 'hidden')}>
          <ItemsPanel
            state={state}
            run={run}
            selectedItemId={viewItemId}
            onSelect={(id) => {
              setSelectedItemId(id);
              setTab('comments');
            }}
          />
        </div>
        <div className={cx('lg:block', tab === 'vote' ? 'block' : 'hidden')}>
          <VotingArea state={state} run={run} clockOffset={clockOffset} />
        </div>
        <div className={cx('lg:sticky lg:top-20 lg:flex lg:h-[calc(100dvh-6rem)] lg:flex-col', tab === 'comments' ? 'flex h-[calc(100dvh-8rem)] flex-col' : 'hidden')}>
          <CommentsPanel state={state} run={run} itemId={viewItemId} />
        </div>
      </main>

      {toast && (
        <div role="alert" className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-md rounded-lg bg-ink px-4 py-3 text-center text-sm text-bg shadow-xl">
          {toast}
        </div>
      )}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} state={state} run={run} />
      <RenameModal open={renameOpen} onClose={() => setRenameOpen(false)} state={state} run={run} />
    </div>
  );
}
