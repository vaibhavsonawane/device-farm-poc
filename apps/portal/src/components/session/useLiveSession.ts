import type { SessionJoinDto, StreamStatus } from '@devicelab/shared-types';
import { type StreamTransport, WsRelayTransport, streamUrl } from '@devicelab/ui';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { getSocket, request } from '../../realtime/socket';

export type LinkState =
  'joining' | 'connecting' | 'live' | 'reconnecting' | 'ended' | 'error' | 'taken-over';

export interface LiveSession {
  join: SessionJoinDto | null;
  transport: StreamTransport | null;
  state: LinkState;
  error: string | null;
  streamStatus: StreamStatus | null;
}

/**
 * Join a session (via `start`), open the binary stream socket and keep it
 * alive: on an unexpected close, fetch a fresh ticket and reconnect with backoff.
 */
export function useLiveSession(
  start: (() => Promise<SessionJoinDto>) | null,
  key: string,
): LiveSession {
  const [join, setJoin] = useState<SessionJoinDto | null>(null);
  const [transport, setTransport] = useState<StreamTransport | null>(null);
  const [state, setState] = useState<LinkState>('joining');
  const [error, setError] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus | null>(null);
  const startRef = useRef(start);
  startRef.current = start;

  useEffect(() => {
    if (!startRef.current) return;
    let cancelled = false;
    let current: StreamTransport | null = null;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let sessionId: string | null = null;

    const open = async (j: SessionJoinDto): Promise<void> => {
      const t = new WsRelayTransport(streamUrl(j.streamPath, j.streamTicket));
      current = t;
      t.onClose((code) => {
        if (cancelled || current !== t) return;
        setTransport(null);
        if (code === 4000) return setState('ended');
        if (code === 4009) return setState('taken-over');
        if (attempts >= 8) {
          setState('error');
          setError('Lost the stream connection.');
          return;
        }
        setState('reconnecting');
        retryTimer = setTimeout(() => void reconnect(), Math.min(8000, 500 * 2 ** attempts++));
      });
      setState('connecting');
      await t.connect();
      if (cancelled) {
        t.close();
        return;
      }
      attempts = 0;
      setTransport(t);
      setState('live');
    };

    const reconnect = async (): Promise<void> => {
      if (!sessionId) return;
      try {
        const j = await api<SessionJoinDto>(`/sessions/${sessionId}/ticket`, { method: 'POST' });
        if (cancelled) return;
        setJoin(j);
        await open(j);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (/ended|not found/i.test(msg)) {
          setState('ended');
          return;
        }
        setState('reconnecting');
        retryTimer = setTimeout(() => void reconnect(), Math.min(8000, 500 * 2 ** attempts++));
      }
    };

    void (async () => {
      try {
        setState('joining');
        const j = await startRef.current!();
        if (cancelled) return;
        sessionId = j.session.id;
        setJoin(j);
        await request('session:subscribe', { sessionId }).catch(() => undefined);
        await open(j);
      } catch (err) {
        if (cancelled) return;
        setState('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    const s = getSocket();
    const onStatus = (st: StreamStatus) => {
      if (st.sessionId === sessionId) setStreamStatus(st);
    };
    const onReconnect = () => {
      if (sessionId) void request('session:subscribe', { sessionId }).catch(() => undefined);
    };
    s.on('session:stream-status', onStatus);
    s.on('connect', onReconnect);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      current?.close();
      s.off('session:stream-status', onStatus);
      s.off('connect', onReconnect);
      if (sessionId) void request('session:unsubscribe', { sessionId }).catch(() => undefined);
    };
  }, [key]);

  return { join, transport, state, error, streamStatus };
}
