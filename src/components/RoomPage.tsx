'use client';

import { useEffect, useState } from 'react';
import { clearSession, getSession } from '@/lib/session';
import type { JoinResponse } from '@/shared/protocol';
import { JoinGate } from './JoinGate';
import { RoomView } from './RoomView';

export function RoomPage({ code }: { code: string }) {
  // undefined = not read from storage yet (avoids a hydration mismatch).
  const [session, setSession] = useState<JoinResponse | null | undefined>(undefined);
  const [notice, setNotice] = useState('');

  useEffect(() => setSession(getSession(code)), [code]);

  if (session === undefined) return null;
  if (!session) return <JoinGate code={code} notice={notice} onJoined={setSession} />;
  return (
    <RoomView
      key={session.token}
      session={session}
      onSessionLost={(reason) => {
        clearSession(code);
        if (reason === 'left') return void (location.href = '/');
        setNotice(reason === 'removed' ? 'Você foi removido da sala pelo facilitador.' : 'Sua sessão expirou. Entre novamente.');
        setSession(null);
      }}
    />
  );
}
