import {
  PORTAL_NAMESPACE,
  type PortalToServerEvents,
  type ServerToPortalEvents,
} from '@devicelab/shared-types';
import { type Socket, io } from 'socket.io-client';
import { refreshSession } from '../api/client';
import { useAuth } from '../stores/auth';

export type PortalSocket = Socket<ServerToPortalEvents, PortalToServerEvents>;

let socket: PortalSocket | null = null;

/** The single portal control socket (inventory, reservations, logs, install progress). */
export function getSocket(): PortalSocket {
  if (socket) return socket;
  const s: PortalSocket = io(PORTAL_NAMESPACE, {
    // Evaluated on every (re)connect so a refreshed token is picked up.
    auth: (cb) => cb({ token: useAuth.getState().accessToken }),
    transports: ['websocket'],
    autoConnect: false,
    reconnectionDelayMax: 10_000,
  });
  s.on('connect_error', (err) => {
    if (err.message === 'unauthorized') {
      void refreshSession().then((ok) => {
        if (ok) s.connect();
      });
    }
  });
  socket = s;
  return s;
}

export function connectSocket(): void {
  const s = getSocket();
  if (!s.connected) s.connect();
}

export function disconnectSocket(): void {
  socket?.disconnect();
}

/** Emit with ack and turn `{ ok:false }` into a rejection. */
export function request<E extends keyof PortalToServerEvents>(
  event: E,
  payload: Parameters<PortalToServerEvents[E]>[0],
): Promise<void> {
  const s = getSocket();
  return new Promise((resolve, reject) => {
    // A generic event name defeats Socket.IO's ack typing; payload/ack types come from PortalToServerEvents.
    const timed = s.timeout(15_000);
    const emit = timed.emit.bind(timed) as unknown as (
      ev: E,
      p: typeof payload,
      cb: (err: Error | null, res: { ok: boolean; error?: string }) => void,
    ) => void;
    emit(event, payload, (err, res) => {
      if (err) reject(err);
      else if (!res.ok) reject(new Error(res.error ?? 'request failed'));
      else resolve();
    });
  });
}
