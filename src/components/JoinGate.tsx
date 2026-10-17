'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { getLastNickname, saveLastNickname, saveSession } from '@/lib/session';
import type { JoinResponse, RoomPreview } from '@/shared/protocol';
import { Button, ErrorText, Field, Input, Panel } from './ui';

export function JoinGate({ code, notice, onJoined }: { code: string; notice?: string; onJoined: (s: JoinResponse) => void }) {
  const [preview, setPreview] = useState<RoomPreview | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [nickname, setNickname] = useState('');
  const [role, setRole] = useState<'voter' | 'observer'>('voter');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setNickname(getLastNickname());
    api
      .preview(code)
      .then(setPreview)
      .catch((e: Error & { status?: number }) => (e.status === 404 ? setNotFound(true) : setError(e.message)));
  }, [code]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const session = await api.join(code, { nickname, role, password: password || undefined });
      saveSession(session);
      saveLastNickname(nickname);
      onJoined(session);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <Panel className="w-full max-w-sm p-6">
        {notFound ? (
          <div className="flex flex-col gap-4 text-center">
            <h1 className="text-xl font-semibold">Sala não encontrada</h1>
            <p className="text-sm text-muted">
              Confira o código <span className="font-mono font-semibold">{code}</span>. Salas temporárias expiram após 24 h sem uso.
            </p>
            <Link href="/" className="text-sm font-medium text-accent hover:underline">
              Criar uma nova sala
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <span className="font-mono text-xs tracking-[0.3em] text-muted">{code}</span>
              <h1 className="text-xl font-semibold">{preview ? preview.name : 'Carregando sala…'}</h1>
              {preview && (
                <p className="text-sm text-muted">
                  {preview.deckName} · {preview.participantCount} {preview.participantCount === 1 ? 'participante' : 'participantes'}
                </p>
              )}
            </div>
            {notice && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{notice}</p>}
            <Field label="Seu apelido">
              <Input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={32} required autoFocus />
            </Field>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1.5 text-sm font-medium">Entrar como</legend>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ['voter', 'Votante', 'Vota e comenta'],
                    ['observer', 'Observador', 'Só acompanha e comenta'],
                  ] as const
                ).map(([value, label, hint]) => (
                  <label
                    key={value}
                    className={`flex cursor-pointer flex-col rounded-lg border p-3 text-sm ${role === value ? 'border-accent bg-accent-soft' : 'border-line'}`}
                  >
                    <input type="radio" name="role" value={value} checked={role === value} onChange={() => setRole(value)} className="sr-only" />
                    <span className="font-medium">{label}</span>
                    <span className="text-xs text-muted">{hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {preview?.hasPassword && (
              <Field label="Senha da sala">
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </Field>
            )}
            <ErrorText>{error}</ErrorText>
            <Button type="submit" variant="primary" disabled={busy || !preview}>
              {busy ? 'Entrando…' : 'Entrar na sala'}
            </Button>
          </form>
        )}
      </Panel>
    </main>
  );
}
