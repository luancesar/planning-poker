'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { getLastNickname, saveLastNickname, saveSession } from '@/lib/session';
import { PRESET_DECKS, parseCustomDeck } from '@/shared/decks';
import { DEFAULT_SETTINGS } from '@/shared/protocol';
import { Button, ErrorText, Field, Input, Select, Toggle } from './ui';

export function CreateRoomForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [nickname, setNickname] = useState('');
  const [deckId, setDeckId] = useState('fibonacci');
  const [customCards, setCustomCards] = useState('1, 2, 3, 5, 8, ?');
  const [autoReveal, setAutoReveal] = useState(DEFAULT_SETTINGS.autoReveal);
  const [facilitatorVotes, setFacilitatorVotes] = useState(DEFAULT_SETTINGS.facilitatorVotes);
  const [timer, setTimer] = useState('');
  const [persistent, setPersistent] = useState(true);
  const [password, setPassword] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => setNickname(getLastNickname()), []);

  let preview: string[] = PRESET_DECKS.find((d) => d.id === deckId)?.cards.map((c) => c.label) ?? [];
  let deckError = '';
  if (deckId === 'custom') {
    try {
      preview = parseCustomDeck(customCards).cards.map((c) => c.label);
    } catch (e) {
      preview = [];
      deckError = (e as Error).message;
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (deckError) return setError(deckError);
    setBusy(true);
    setError('');
    try {
      const session = await api.createRoom({
        name,
        nickname,
        deckId,
        customCards: deckId === 'custom' ? customCards : undefined,
        settings: { autoReveal, facilitatorVotes, timerSeconds: timer ? Number(timer) : null },
        persistent,
        password: password || undefined,
      });
      saveSession(session);
      saveLastNickname(nickname);
      router.push(`/r/${session.code}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field label="Nome da sala">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Refinamento Sprint 42" maxLength={80} required />
      </Field>
      <Field label="Seu apelido">
        <Input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="Como o time vai te ver" maxLength={32} required />
      </Field>
      <Field label="Deck de cards">
        <Select value={deckId} onChange={(e) => setDeckId(e.target.value)}>
          {PRESET_DECKS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
          <option value="custom">Personalizado</option>
        </Select>
      </Field>
      {deckId === 'custom' && (
        <Field label="Cards (separados por vírgula)" hint="Até 20 cards. Use ? e ☕ para dúvida e pausa.">
          <Input value={customCards} onChange={(e) => setCustomCards(e.target.value)} />
        </Field>
      )}
      <div className="flex flex-wrap gap-1.5" aria-label="Prévia do deck">
        {preview.map((label) => (
          <span key={label} className="inline-flex h-9 min-w-7 items-center justify-center rounded-md border border-line bg-surface-2 px-1.5 text-sm font-semibold">
            {label}
          </span>
        ))}
      </div>

      <button type="button" className="self-start text-sm font-medium text-accent hover:underline" onClick={() => setShowAdvanced((v) => !v)}>
        {showAdvanced ? 'Ocultar opções' : 'Mais opções'}
      </button>
      {showAdvanced && (
        <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface-2/50 p-4">
          <Toggle checked={autoReveal} onChange={setAutoReveal} label="Revelar automaticamente" hint="Quando todos os votantes online tiverem votado" />
          <Toggle checked={facilitatorVotes} onChange={setFacilitatorVotes} label="Facilitador também vota" />
          <Toggle checked={persistent} onChange={setPersistent} label="Sala persistente" hint="Reutilize o mesmo link em todas as sprints. Desligado: expira em 24 h sem uso." />
          <Field label="Timer por rodada">
            <Select value={timer} onChange={(e) => setTimer(e.target.value)}>
              <option value="">Sem timer</option>
              <option value="30">30 segundos</option>
              <option value="60">1 minuto</option>
              <option value="120">2 minutos</option>
              <option value="180">3 minutos</option>
              <option value="300">5 minutos</option>
            </Select>
          </Field>
          <Field label="Senha da sala (opcional)">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" maxLength={100} />
          </Field>
        </div>
      )}

      <ErrorText>{error}</ErrorText>
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? 'Criando…' : 'Criar sala'}
      </Button>
    </form>
  );
}
