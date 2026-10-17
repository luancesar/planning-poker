import type { JoinResponse } from '@/shared/protocol';

// Storage can throw (private mode, blocked cookies); the app then just asks to join again.
const key = (code: string) => `pp:session:${code.toUpperCase()}`;

export function getSession(code: string): JoinResponse | null {
  try {
    const raw = localStorage.getItem(key(code));
    return raw ? (JSON.parse(raw) as JoinResponse) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: JoinResponse) {
  try {
    localStorage.setItem(key(session.code), JSON.stringify(session));
  } catch {}
}

export function clearSession(code: string) {
  try {
    localStorage.removeItem(key(code));
  } catch {}
}

export function getLastNickname() {
  try {
    return localStorage.getItem('pp:nickname') ?? '';
  } catch {
    return '';
  }
}

export function saveLastNickname(nickname: string) {
  try {
    localStorage.setItem('pp:nickname', nickname);
  } catch {}
}
