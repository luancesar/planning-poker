import type { CreateRoomInput, JoinResponse, JoinRoomInput, RoomPreview } from '@/shared/protocol';
import type { SessionSummary } from '@/server/summary';

async function request<T>(path: string, init?: RequestInit & { json?: unknown; token?: string }): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.json !== undefined) headers['content-type'] = 'application/json';
  if (init?.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(path, { ...init, headers, body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(new Error(data.error ?? 'Não foi possível completar a ação'), { status: res.status });
  }
  return (await res.json()) as T;
}

export const api = {
  createRoom: (input: CreateRoomInput) => request<JoinResponse>('/api/rooms', { method: 'POST', json: input }),
  preview: (code: string) => request<RoomPreview>(`/api/rooms/${code}`),
  join: (code: string, input: JoinRoomInput) => request<JoinResponse>(`/api/rooms/${code}/join`, { method: 'POST', json: input }),
  summary: (code: string, token: string) => request<SessionSummary>(`/api/rooms/${code}/summary`, { token }),
  async downloadCsv(code: string, token: string) {
    const res = await fetch(`/api/rooms/${code}/summary.csv`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('Não foi possível exportar');
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: `planning-poker-${code}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  },
};
