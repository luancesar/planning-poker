'use client';

import { useEffect, useState } from 'react';
import type { Action, ParticipantView, Role, RoomState } from '@/shared/protocol';
import type { RoundStats } from '@/shared/stats';
import { Badge, Button, Menu, Panel, Select, cx } from './ui';

type Run = (action: Action) => Promise<boolean>;

const ROLE_LABEL: Record<Role, string> = { facilitator: 'Facilitador', voter: 'Votante', observer: 'Observador' };

/** Seconds left on the round timer (server clock), ticking; null without a timer. */
function useSecondsLeft(endsAt: number | null | undefined, clockOffset: number) {
  const [now, setNow] = useState(() => Date.now() + clockOffset);
  useEffect(() => {
    if (!endsAt) return;
    setNow(Date.now() + clockOffset);
    const t = setInterval(() => setNow(Date.now() + clockOffset), 250);
    return () => clearInterval(t);
  }, [endsAt, clockOffset]);
  return endsAt ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : null;
}

function Countdown({ left }: { left: number }) {
  if (left === 0) return <Badge tone="bad">⏱ Tempo esgotado</Badge>;
  return (
    <Badge tone={left <= 10 ? 'bad' : 'accent'} className="font-mono tabular-nums">
      ⏱ {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
    </Badge>
  );
}

/** Facilitators see who is waiting to vote and approve them in one click. */
function ApprovalRequests({ state, run }: { state: RoomState; run: Run }) {
  const pending = state.participants.filter((p) => p.voteRequested);
  if (!state.me.can.manageRoom || pending.length === 0) return null;
  const ids = pending.map((p) => p.id);
  return (
    <Panel className="flex flex-col gap-3 border-warn/40 bg-warn-soft/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {pending.length === 1 ? '1 pessoa pediu para votar' : `${pending.length} pessoas pediram para votar`}
        </h3>
        {pending.length > 1 && (
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={() => run({ type: 'participant.reviewVote', participantIds: ids, approve: true })}>
              Aprovar todos
            </Button>
            <Button size="sm" variant="ghost" onClick={() => run({ type: 'participant.reviewVote', participantIds: ids, approve: false })}>
              Recusar todos
            </Button>
          </div>
        )}
      </div>
      <ul className="flex flex-col gap-2">
        {pending.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span className={cx('size-1.5 shrink-0 rounded-full', p.online ? 'bg-good' : 'bg-muted')} />
              <span className="truncate">{p.nickname}</span>
            </span>
            <span className="flex shrink-0 gap-1">
              <Button size="sm" onClick={() => run({ type: 'participant.reviewVote', participantIds: [p.id], approve: true })}>
                Aprovar
              </Button>
              <Button size="sm" variant="ghost" onClick={() => run({ type: 'participant.reviewVote', participantIds: [p.id], approve: false })}>
                Recusar
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Seat({ person, state, run }: { person: ParticipantView; state: RoomState; run: Run }) {
  const { round, me } = state;
  const vote = round?.votes.find((v) => v.participantId === person.id);
  const revealed = !!round?.revealedAt;
  const isMe = person.id === me.participantId;
  const note = person.voteRequested ? 'aguardando' : person.canReveal && person.role !== 'facilitator' ? 'pode revelar' : null;

  let card;
  if (person.role === 'observer') {
    card = <div className="grid h-16 w-11 place-items-center rounded-lg border border-dashed border-line text-xs text-muted">👀</div>;
  } else if (vote && (revealed || vote.label)) {
    card = (
      <div
        className={cx(
          'grid h-16 w-11 place-items-center rounded-lg border-2 text-lg font-bold',
          revealed ? 'border-accent bg-surface text-ink' : 'border-accent/60 bg-accent-soft text-accent-strong',
        )}
      >
        {vote.label}
      </div>
    );
  } else if (vote) {
    card = (
      <div
        className="h-16 w-11 rounded-lg border-2 border-accent bg-accent"
        style={{ backgroundImage: 'repeating-linear-gradient(45deg, transparent 0 6px, rgba(255,255,255,.18) 6px 12px)' }}
        aria-label="Votou"
      />
    );
  } else {
    card = <div className="h-16 w-11 rounded-lg border-2 border-dashed border-line" aria-label={round && !revealed ? 'Ainda não votou' : 'Sem voto'} />;
  }

  return (
    <li className={cx('flex w-20 flex-col items-center gap-1.5', !person.online && 'opacity-50')}>
      {card}
      <div className="flex max-w-full items-center gap-1 text-xs">
        <span className={cx('size-1.5 shrink-0 rounded-full', person.online ? 'bg-good' : 'bg-muted')} aria-label={person.online ? 'online' : 'offline'} />
        <span className={cx('truncate', isMe && 'font-semibold')} title={`${person.nickname} · ${ROLE_LABEL[person.role]}`}>
          {person.role === 'facilitator' && '★ '}
          {person.nickname}
        </span>
      </div>
      {note && <span className={cx('-mt-1 text-[11px]', person.voteRequested ? 'text-warn' : 'text-muted')}>{note}</span>}
      {me.can.manageRoom && !isMe && (
        <div className="-mt-1">
          <Menu
            label={`Opções de ${person.nickname}`}
            align="left"
            items={[
              { label: 'Aprovar voto', hidden: !person.voteRequested, onSelect: () => run({ type: 'participant.reviewVote', participantIds: [person.id], approve: true }) },
              { label: 'Recusar pedido', hidden: !person.voteRequested, onSelect: () => run({ type: 'participant.reviewVote', participantIds: [person.id], approve: false }) },
              {
                label: person.canReveal ? 'Remover permissão de revelar' : 'Permitir revelar votos',
                hidden: person.role === 'facilitator',
                onSelect: () => run({ type: 'participant.setCanReveal', participantId: person.id, canReveal: !person.canReveal }),
              },
              { label: 'Tornar facilitador', hidden: person.role === 'facilitator', onSelect: () => run({ type: 'participant.setRole', participantId: person.id, role: 'facilitator' }) },
              { label: 'Tornar votante', hidden: person.role === 'voter', onSelect: () => run({ type: 'participant.setRole', participantId: person.id, role: 'voter' }) },
              { label: 'Tornar observador', hidden: person.role === 'observer', onSelect: () => run({ type: 'participant.setRole', participantId: person.id, role: 'observer' }) },
              {
                label: 'Remover da sala',
                danger: true,
                onSelect: () => confirm(`Remover ${person.nickname} da sala?`) && run({ type: 'participant.remove', participantId: person.id }),
              },
            ]}
          />
        </div>
      )}
    </li>
  );
}

const CONSENSUS: Record<RoundStats['consensus'], { tone: 'good' | 'warn' | 'bad' | 'neutral'; text: string }> = {
  full: { tone: 'good', text: 'Consenso total' },
  near: { tone: 'warn', text: 'Quase consenso' },
  low: { tone: 'bad', text: 'Divergência: ouçam os extremos' },
  none: { tone: 'neutral', text: 'Sem votos numéricos' },
};

function Results({ state }: { state: RoomState }) {
  const { round, room, participants } = state;
  const stats = round?.stats;
  if (!round || !stats) return null;
  const names = new Map(participants.map((p) => [p.id, p.nickname]));
  const byLabel = (label: string) => round.votes.filter((v) => v.label === label).map((v) => names.get(v.participantId) ?? '—');
  const maxCount = Math.max(1, ...stats.distribution.map((d) => d.count));

  // The highest and lowest voters should explain their reasoning first.
  const valued = room.deck.cards.filter((c) => c.value !== null).map((c) => c.label);
  const votedLabels = stats.distribution.map((d) => d.label).filter((l) => valued.includes(l));
  const lowest = votedLabels[0];
  const highest = votedLabels.at(-1);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={CONSENSUS[stats.consensus].tone}>{CONSENSUS[stats.consensus].text}</Badge>
        {room.deck.numeric && stats.average !== null && (
          <span className="text-sm text-muted">
            Média <strong className="text-ink">{stats.average.toLocaleString('pt-BR')}</strong> · Mediana{' '}
            <strong className="text-ink">{stats.median?.toLocaleString('pt-BR')}</strong>
          </span>
        )}
        <span className="text-sm text-muted">
          {stats.total} {stats.total === 1 ? 'voto' : 'votos'}
        </span>
      </div>
      {stats.distribution.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {stats.distribution.map((d) => (
            <li key={d.label} className="grid grid-cols-[2.5rem_1fr] items-center gap-3">
              <span className="text-right text-base font-bold">{d.label}</span>
              <div className="flex min-w-0 items-center gap-2">
                <div
                  className={cx('h-6 shrink-0 rounded', stats.modes.includes(d.label) ? 'bg-accent' : 'bg-accent/35')}
                  style={{ width: `${Math.max(6, (d.count / maxCount) * 60)}%` }}
                />
                <span className="truncate text-xs text-muted">
                  {d.count} · {byLabel(d.label).join(', ')}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Ninguém votou nesta rodada.</p>
      )}
      {stats.consensus === 'low' && lowest && highest && (
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm">
          Sugestão: <strong>{byLabel(highest).join(', ')}</strong> ({highest}) e <strong>{byLabel(lowest).join(', ')}</strong> ({lowest}) explicam o raciocínio, depois revotem.
        </p>
      )}
    </div>
  );
}

function FinalizeControls({ state, run, itemId }: { state: RoomState; run: Run; itemId: string }) {
  const { room, round } = state;
  const options = room.deck.cards.filter((c) => c.value !== null || !['?', '☕'].includes(c.label));
  const item = state.items.find((i) => i.id === itemId);
  const [estimate, setEstimate] = useState(item?.finalEstimate ?? round?.stats?.suggestion ?? options[0]?.label ?? '');
  useEffect(() => {
    setEstimate(item?.finalEstimate ?? round?.stats?.suggestion ?? options[0]?.label ?? '');
    // Reset the pick whenever a new round is revealed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round?.id, round?.revealedAt]);

  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">Estimativa final</span>
        <Select value={estimate} onChange={(e) => setEstimate(e.target.value)} className="w-28">
          {options.map((c) => (
            <option key={c.label} value={c.label}>
              {c.label}
            </option>
          ))}
        </Select>
      </label>
      <Button variant="primary" onClick={() => run({ type: 'item.finalize', itemId, estimate, advance: true })}>
        Salvar e próximo
      </Button>
      <Button onClick={() => run({ type: 'item.finalize', itemId, estimate, advance: false })}>Salvar</Button>
      <Button variant="ghost" onClick={() => run({ type: 'round.reset' })}>
        Revotar
      </Button>
    </div>
  );
}

function CardDeck({ state, run, timeUp }: { state: RoomState; run: Run; timeUp: boolean }) {
  const { round, room, me } = state;
  if (!me.can.vote) {
    if (me.role !== 'observer') return <p className="text-center text-sm text-muted">O facilitador não vota nesta sala.</p>;
    if (me.voteRequested) {
      return <p className="text-center text-sm text-warn">Pedido enviado. Aguardando um facilitador liberar seu voto.</p>;
    }
    return (
      <div className="flex flex-col items-center gap-2 text-center text-sm text-muted">
        <span>Você está como observador.</span>
        <Button size="sm" onClick={() => run({ type: 'participant.requestVote' })}>
          {room.settings.requireApproval ? 'Pedir para votar' : 'Quero votar'}
        </Button>
      </div>
    );
  }
  const open = !!round && !round.revealedAt && !timeUp;
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex flex-wrap justify-center gap-2" role="group" aria-label="Seu voto">
        {room.deck.cards.map((c) => {
          const selected = round?.myVote === c.label;
          return (
            <button
              key={c.label}
              type="button"
              disabled={!open}
              aria-pressed={selected}
              onClick={() => run(selected ? { type: 'vote.retract' } : { type: 'vote.cast', label: c.label })}
              className={cx(
                'grid h-20 w-14 place-items-center rounded-xl border-2 text-xl font-bold transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:h-24 sm:w-16',
                selected ? '-translate-y-2 border-accent bg-accent text-on-accent shadow-lg' : 'border-line bg-surface hover:-translate-y-1 hover:border-accent',
                !open && 'cursor-not-allowed opacity-50 hover:translate-y-0',
              )}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted">
        {open
          ? round?.myVote
            ? 'Clique no mesmo card para retirar o voto. Você pode trocar até a revelação.'
            : 'Escolha um card.'
          : round && !round.revealedAt
            ? 'Tempo esgotado. Os votos aparecem quando alguém com permissão revelar.'
            : 'Aguardando a próxima rodada.'}
      </p>
    </div>
  );
}

export function VotingArea({ state, run, clockOffset }: { state: RoomState; run: Run; clockOffset: number }) {
  const { room, round, items, participants, me } = state;
  const item = items.find((i) => i.id === room.currentItemId);
  const { can } = me;
  const hidden = !!round && !round.revealedAt;
  const secondsLeft = useSecondsLeft(hidden ? round?.endsAt : null, clockOffset);
  const timeUp = secondsLeft === 0;
  const open = hidden && !timeUp;
  const voters = participants.filter((p) => p.role !== 'observer' && (p.role !== 'facilitator' || room.settings.facilitatorVotes));
  const votedCount = voters.filter((p) => p.hasVoted).length;
  const ordered = [...participants].sort((a, b) => Number(a.role === 'observer') - Number(b.role === 'observer'));

  return (
    <div className="flex flex-col gap-4">
      <ApprovalRequests state={state} run={run} />
      <Panel className="p-5">
        {!item ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <h2 className="text-lg font-semibold">
              {items.length && items.every((i) => i.status === 'estimated' || i.status === 'skipped') ? 'Todos os itens foram estimados 🎉' : 'Nenhum item em votação'}
            </h2>
            <p className="max-w-sm text-sm text-muted">
              {can.rounds ? 'Adicione itens na lista e clique em “Votar” para abrir uma rodada.' : 'Aguardando o facilitador escolher o próximo item.'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>
                Item {items.indexOf(item) + 1} de {items.length}
              </span>
              {round && <Badge>Rodada {round.number}</Badge>}
              {item.finalEstimate && <Badge tone="good">Estimativa final: {item.finalEstimate}</Badge>}
              {secondsLeft !== null && <Countdown left={secondsLeft} />}
            </div>
            <h2 className="text-xl font-semibold leading-snug break-words">{item.title}</h2>
            {item.description && <p className="max-h-40 overflow-y-auto text-sm whitespace-pre-wrap text-muted">{item.description}</p>}
            {item.link && (
              <a href={item.link} target="_blank" rel="noreferrer noopener" className="self-start text-sm font-medium break-all text-accent hover:underline">
                Abrir link ↗
              </a>
            )}
          </div>
        )}
      </Panel>

      <Panel className="flex flex-col gap-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            {hidden
              ? `${timeUp ? 'Votação encerrada · ' : ''}Votaram ${votedCount} de ${voters.length}`
              : round?.revealedAt
                ? 'Votos revelados'
                : 'Participantes'}
          </h3>
          {item && (can.reveal || can.rounds) && (
            <div className="flex flex-wrap gap-2">
              {hidden && can.reveal && (
                <Button variant="primary" size="sm" onClick={() => run({ type: 'round.reveal' })}>
                  Revelar votos
                </Button>
              )}
              {hidden && can.rounds && (
                <Button size="sm" onClick={() => run({ type: 'round.reset' })}>
                  Reiniciar
                </Button>
              )}
              {!round && can.rounds && (
                <Button variant="primary" size="sm" onClick={() => run({ type: 'round.start', itemId: item.id })}>
                  Iniciar votação
                </Button>
              )}
              {can.rounds && (
                <Button variant="ghost" size="sm" onClick={() => run({ type: 'item.skip', itemId: item.id })}>
                  Pular item
                </Button>
              )}
            </div>
          )}
        </div>
        <ul className="flex flex-wrap justify-center gap-x-3 gap-y-4">
          {ordered.map((p) => (
            <Seat key={p.id} person={p} state={state} run={run} />
          ))}
        </ul>
        {round?.revealedAt && <Results state={state} />}
        {can.rounds && item && round?.revealedAt && <FinalizeControls state={state} run={run} itemId={item.id} />}
      </Panel>

      {(item || me.role === 'observer') && (
        // Observers always see their status (e.g. waiting for approval), even before the first round.
        // On phones the deck sticks to the bottom only while a round is open, so results stay readable afterwards.
        <div
          className={cx(
            open && 'sticky bottom-0 z-10 -mx-4 border-t border-line bg-bg/90 px-4 py-4 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none',
          )}
        >
          <CardDeck state={state} run={run} timeUp={timeUp} />
        </div>
      )}
    </div>
  );
}
