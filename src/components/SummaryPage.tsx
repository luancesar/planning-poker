'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { getSession } from '@/lib/session';
import type { SessionSummary } from '@/server/summary';
import { Badge, Button } from './ui';

const STATUS = { pending: 'Pendente', voting: 'Em votação', estimated: 'Estimado', skipped: 'Pulado' } as Record<string, string>;

export function SummaryPage({ code }: { code: string }) {
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [error, setError] = useState('');
  const [token, setToken] = useState('');

  useEffect(() => {
    const session = getSession(code);
    if (!session) return setError('Entre na sala para ver o resumo.');
    setToken(session.token);
    api.summary(code, session.token).then(setSummary, (e: Error) => setError(e.message));
  }, [code]);

  if (error) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10 text-sm">
        <p className="mb-3">{error}</p>
        <Link href={`/r/${code}`} className="font-medium text-accent hover:underline">
          Ir para a sala
        </Link>
      </main>
    );
  }
  if (!summary) return <main className="p-10 text-center text-sm text-muted">Carregando resumo…</main>;

  const estimated = summary.items.filter((i) => i.status === 'estimated');
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 print:max-w-none print:py-0">
      <div className="no-print flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => window.print()}>
          Imprimir / salvar PDF
        </Button>
        <Button onClick={() => api.downloadCsv(code, token)}>Baixar CSV</Button>
        <Link href={`/r/${code}`} className="inline-flex h-10 items-center px-3 text-sm text-accent hover:underline">
          Voltar para a sala
        </Link>
      </div>
      <header className="flex flex-col gap-1 border-b border-line pb-4">
        <p className="font-mono text-xs tracking-[0.3em] text-muted">{summary.room.code}</p>
        <h1 className="text-2xl font-bold">{summary.room.name}</h1>
        <p className="text-sm text-muted">
          {summary.room.deckName} · {estimated.length} de {summary.items.length} itens estimados · gerado em{' '}
          {new Date(summary.exportedAt).toLocaleString('pt-BR')}
        </p>
      </header>
      {summary.items.length === 0 && <p className="text-sm text-muted">Nenhum item nesta sala.</p>}
      {summary.items.map((item) => (
        <section key={item.position} className="flex break-inside-avoid flex-col gap-2 border-b border-line pb-5">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-lg font-semibold">
              {item.position}. {item.title}
            </h2>
            {item.finalEstimate ? <Badge tone="good">Estimativa: {item.finalEstimate}</Badge> : <Badge>{STATUS[item.status]}</Badge>}
          </div>
          {item.description && <p className="text-sm whitespace-pre-wrap text-muted">{item.description}</p>}
          {item.link && (
            <a href={item.link} className="text-sm break-all text-accent">
              {item.link}
            </a>
          )}
          {item.rounds.map((r) => (
            <p key={r.number} className="text-sm">
              <span className="font-medium">Rodada {r.number}:</span>{' '}
              {r.votes.length ? r.votes.map((v) => `${v.name} ${v.label}`).join(' · ') : 'sem votos'}
              {r.stats?.average != null && <span className="text-muted"> (média {r.stats.average.toLocaleString('pt-BR')})</span>}
            </p>
          ))}
          {item.comments.length > 0 && (
            <ul className="flex flex-col gap-1 border-l-2 border-line pl-3">
              {item.comments.map((c, i) => (
                <li key={i} className="text-sm">
                  {c.pinned && '📌 '}
                  <strong>{c.author}</strong>
                  {c.voteLabel && <span className="text-muted"> (votou {c.voteLabel})</span>}: {c.body}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </main>
  );
}
