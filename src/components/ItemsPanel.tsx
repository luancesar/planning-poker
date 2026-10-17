'use client';

import { useState } from 'react';
import type { Action, ItemStatus, ItemView, NewItem, RoomState } from '@/shared/protocol';
import { Badge, Button, ErrorText, Field, Input, Menu, Modal, Panel, Textarea, cx } from './ui';

type Run = (action: Action) => Promise<boolean>;

const STATUS: Record<ItemStatus, { label: string; tone: 'neutral' | 'accent' | 'good' | 'warn' }> = {
  pending: { label: 'Pendente', tone: 'neutral' },
  voting: { label: 'Em votação', tone: 'accent' },
  estimated: { label: 'Estimado', tone: 'good' },
  skipped: { label: 'Pulado', tone: 'warn' },
};

/** Minimal CSV parser (quotes, commas or semicolons); columns: title, description, link. */
export function parseItemsCsv(text: string): NewItem[] {
  const delimiter = (text.split('\n')[0].match(/;/g)?.length ?? 0) > (text.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);

  const isHeader = /^(t[ií]tulo|title|summary|resumo|item)$/i.test(rows[0]?.[0]?.trim() ?? '');
  return rows
    .slice(isHeader ? 1 : 0)
    .map(([title = '', description = '', link = '']) => ({ title: title.trim().slice(0, 200), description: description.trim(), link: /^https?:\/\//i.test(link.trim()) ? link.trim() : '' }))
    .filter((it) => it.title);
}

function BulkAddModal({ open, onClose, run }: { open: boolean; onClose: () => void; run: Run }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  async function add(items: NewItem[]) {
    if (items.length === 0) return setError('Nenhum item encontrado');
    if (items.length > 200) return setError('Adicione no máximo 200 itens por vez');
    if (await run({ type: 'item.add', items })) {
      setText('');
      setError('');
      onClose();
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Adicionar vários itens">
      <div className="flex flex-col gap-4">
        <Field label="Cole a lista" hint="Um item por linha.">
          <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Login com Google\nTela de checkout\nBusca por filtros'} />
        </Field>
        <Button variant="primary" disabled={lines.length === 0} onClick={() => add(lines.map((title) => ({ title: title.slice(0, 200) })))}>
          Adicionar {lines.length || ''} {lines.length === 1 ? 'item' : 'itens'}
        </Button>
        <div className="flex flex-col gap-1.5 border-t border-line pt-4">
          <span className="text-sm font-medium">Ou importe um CSV</span>
          <span className="text-xs text-muted">Colunas: título, descrição, link. Funciona com exportações do Jira e planilhas.</span>
          <input
            type="file"
            accept=".csv,text/csv"
            className="text-sm file:mr-3 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) await add(parseItemsCsv(await file.text()));
              e.target.value = '';
            }}
          />
        </div>
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}

function EditItemModal({ item, onClose, run }: { item: ItemView | null; onClose: () => void; run: Run }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [link, setLink] = useState('');
  const [loadedId, setLoadedId] = useState<string | null>(null);
  if (item && item.id !== loadedId) {
    setLoadedId(item.id);
    setTitle(item.title);
    setDescription(item.description);
    setLink(item.link);
  }
  return (
    <Modal open={!!item} onClose={onClose} title="Editar item">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (item && (await run({ type: 'item.update', itemId: item.id, title, description, link }))) onClose();
        }}
      >
        <Field label="Título">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
        </Field>
        <Field label="Descrição">
          <Textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} />
        </Field>
        <Field label="Link (Jira, Azure DevOps, doc…)">
          <Input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" maxLength={500} />
        </Field>
        <Button type="submit" variant="primary">
          Salvar
        </Button>
      </form>
    </Modal>
  );
}

export function ItemsPanel({ state, run, selectedItemId, onSelect }: { state: RoomState; run: Run; selectedItemId: string | null; onSelect: (id: string) => void }) {
  const { items, room, me } = state;
  const canItems = me.can.items;
  const canRounds = me.can.rounds;
  const [title, setTitle] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [editing, setEditing] = useState<ItemView | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const estimated = items.filter((i) => i.status === 'estimated');
  const points = room.deck.numeric
    ? estimated.reduce((sum, i) => sum + (room.deck.cards.find((c) => c.label === i.finalEstimate)?.value ?? 0), 0)
    : null;

  return (
    <Panel className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h2 className="font-semibold">Itens</h2>
          <p className="text-xs text-muted">
            {estimated.length} de {items.length} estimados{points !== null && estimated.length > 0 && ` · ${points.toLocaleString('pt-BR')} pontos`}
          </p>
        </div>
        {canItems && (
          <Button size="sm" variant="ghost" onClick={() => setBulkOpen(true)}>
            + Vários
          </Button>
        )}
      </div>

      {canItems && (
        <form
          className="flex gap-2 border-b border-line p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (title.trim() && (await run({ type: 'item.add', items: [{ title }] }))) setTitle('');
          }}
        >
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nova história ou tarefa" maxLength={200} aria-label="Título do novo item" />
          <Button type="submit" disabled={!title.trim()}>
            Adicionar
          </Button>
        </form>
      )}

      {items.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted">{canItems ? 'Adicione o primeiro item para começar.' : 'O facilitador ainda não adicionou itens.'}</p>
      ) : (
        <ol className="flex-1 overflow-y-auto p-2" onDragLeave={() => setDropIndex(null)}>
          {items.map((item, index) => {
            const current = item.id === room.currentItemId;
            const commentCount = state.comments.filter((c) => c.itemId === item.id).length;
            return (
              <li
                key={item.id}
                draggable={canItems}
                onDragStart={(e) => {
                  setDragId(item.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  const after = e.clientY > e.currentTarget.getBoundingClientRect().top + e.currentTarget.offsetHeight / 2;
                  setDropIndex(index + (after ? 1 : 0));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = items.findIndex((i) => i.id === dragId);
                  if (dragId && dropIndex !== null && from >= 0) {
                    const to = dropIndex > from ? dropIndex - 1 : dropIndex;
                    if (to !== from) run({ type: 'item.move', itemId: dragId, toIndex: to });
                  }
                  setDragId(null);
                  setDropIndex(null);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropIndex(null);
                }}
                className={cx(
                  'group relative flex items-start gap-2 rounded-lg px-2 py-2',
                  current ? 'bg-accent-soft' : selectedItemId === item.id ? 'bg-surface-2' : 'hover:bg-surface-2',
                  dragId === item.id && 'opacity-40',
                  dropIndex === index && 'shadow-[inset_0_2px_0_var(--app-accent)]',
                  dropIndex === index + 1 && index === items.length - 1 && 'shadow-[inset_0_-2px_0_var(--app-accent)]',
                )}
              >
                {canItems && (
                  <span aria-hidden className="mt-0.5 cursor-grab text-muted opacity-40 group-hover:opacity-100">
                    ⠿
                  </span>
                )}
                <button type="button" className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left" onClick={() => onSelect(item.id)}>
                  <span className="text-sm leading-snug break-words">
                    <span className="mr-1 text-muted">{index + 1}.</span>
                    {item.title}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {item.finalEstimate ? <Badge tone="good">{item.finalEstimate}</Badge> : <Badge tone={STATUS[item.status].tone}>{STATUS[item.status].label}</Badge>}
                    {commentCount > 0 && <span className="text-xs text-muted">💬 {commentCount}</span>}
                  </span>
                </button>
                {(canItems || canRounds) && (
                  <div className="flex shrink-0 items-center">
                    {canRounds && !current && item.status !== 'estimated' && (
                      <Button size="sm" variant="ghost" className="text-accent" onClick={() => run({ type: 'round.start', itemId: item.id })}>
                        Votar
                      </Button>
                    )}
                    <Menu
                      label={`Ações para ${item.title}`}
                      items={[
                        { label: 'Votar novamente', hidden: !canRounds || item.status !== 'estimated', onSelect: () => run({ type: 'round.start', itemId: item.id }) },
                        { label: 'Editar', hidden: !canItems, onSelect: () => setEditing(item) },
                        { label: 'Reabrir', hidden: !canItems || (item.status !== 'estimated' && item.status !== 'skipped'), onSelect: () => run({ type: 'item.reopen', itemId: item.id }) },
                        { label: 'Pular', hidden: !canRounds || item.status === 'skipped' || item.status === 'estimated', onSelect: () => run({ type: 'item.skip', itemId: item.id }) },
                        {
                          label: 'Excluir',
                          danger: true,
                          hidden: !canItems,
                          onSelect: () => confirm(`Excluir "${item.title}" com votos e comentários?`) && run({ type: 'item.delete', itemId: item.id }),
                        },
                      ]}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <BulkAddModal open={bulkOpen} onClose={() => setBulkOpen(false)} run={run} />
      <EditItemModal item={editing} onClose={() => setEditing(null)} run={run} />
    </Panel>
  );
}
