'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { SOCKET_EVENTS, type Action, type ActionAck, type RoomState } from '@/shared/protocol';

const HIDDEN_TAB_DISCONNECT_MS = 30 * 60 * 1000;

export type ConnectionStatus = 'connecting' | 'online' | 'offline' | 'unauthorized' | 'removed';

export function useRoom(code: string, token: string) {
  const [state, setState] = useState<RoomState | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  /** serverTime - Date.now(), so countdowns match the server clock. */
  const [clockOffset, setClockOffset] = useState(0);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io({ auth: { token, roomCode: code }, transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    socket.on('connect', () => setStatus('online'));
    socket.on('disconnect', () => setStatus((s) => (s === 'removed' ? s : 'offline')));
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') {
        setStatus('unauthorized');
        socket.close();
      } else {
        setStatus('offline');
      }
    });
    socket.on(SOCKET_EVENTS.removed, () => {
      setStatus('removed');
      socket.close();
    });
    socket.on(SOCKET_EVENTS.snapshot, (next: RoomState) => {
      setClockOffset(next.serverTime - Date.now());
      // Presence-only pushes keep the same seq; only drop strictly older snapshots.
      setState((prev) => (prev && next.seq < prev.seq ? prev : next));
    });

    // A forgotten background tab would keep a free-tier server and database awake forever.
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let idleDisconnected = false;
    const onVisibility = () => {
      clearTimeout(idleTimer);
      if (document.hidden) {
        idleTimer = setTimeout(() => {
          idleDisconnected = true;
          socket.disconnect();
        }, HIDDEN_TAB_DISCONNECT_MS);
      } else if (idleDisconnected) {
        idleDisconnected = false;
        socket.connect();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearTimeout(idleTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      socket.close();
      socketRef.current = null;
    };
  }, [code, token]);

  const send = useCallback(
    (action: Action) =>
      new Promise<ActionAck>((resolve) => {
        const socket = socketRef.current;
        if (!socket?.connected) return resolve({ ok: false, error: 'Sem conexão com o servidor' });
        socket.timeout(8000).emit(SOCKET_EVENTS.action, action, (err: Error | null, ack: ActionAck) =>
          resolve(err ? { ok: false, error: 'O servidor não respondeu, tente novamente' } : ack),
        );
      }),
    [],
  );

  return { state, status, send, clockOffset };
}
