import type { DeviceDto, HostDto } from '@devicelab/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { qk } from '../api/hooks';
import { useAuth } from '../stores/auth';
import { toast, useToasts } from '../stores/toast';
import { connectSocket, disconnectSocket, getSocket } from './socket';

const REASON_TEXT: Record<string, string> = {
  USER: 'You released the device.',
  IDLE: 'Device released after inactivity.',
  EXPIRED: 'Your reservation expired.',
  FORCED: 'A lead released your device.',
  DEVICE_OFFLINE: 'The device went offline and was released.',
};

/** Keeps the React Query cache live from the portal socket (no polling). */
export function useRealtime(): void {
  const qc = useQueryClient();
  const token = useAuth((s) => s.accessToken);
  const navigate = useNavigate();

  useEffect(() => {
    if (!token) return;
    connectSocket();
    return () => undefined;
  }, [token]);

  useEffect(() => {
    const s = getSocket();
    const upsertDevice = (d: DeviceDto) => {
      qc.setQueryData<DeviceDto[]>(qk.devices, (list) => {
        if (!list) return list;
        const i = list.findIndex((x) => x.id === d.id);
        if (i === -1) return [...list, d];
        const next = list.slice();
        next[i] = d;
        return next;
      });
      qc.setQueryData(qk.device(d.id), (prev: (DeviceDto & { details?: unknown }) | undefined) =>
        prev ? { ...prev, ...d } : prev,
      );
    };
    const removeDevice = ({ id }: { id: string }) =>
      qc.setQueryData<DeviceDto[]>(qk.devices, (list) => list?.filter((x) => x.id !== id));
    const upsertHost = (h: HostDto) =>
      qc.setQueryData<HostDto[]>(qk.hosts, (list) =>
        list
          ? list.some((x) => x.id === h.id)
            ? list.map((x) => (x.id === h.id ? h : x))
            : [...list, h]
          : list,
      );
    const onReservation = () => void qc.invalidateQueries({ queryKey: ['reservations'] });
    const onReleased = ({ reservationId, reason }: { reservationId: string; reason: string }) => {
      void qc.invalidateQueries({ queryKey: qk.reservation(reservationId) });
      if (reason !== 'USER') toast.warning(REASON_TEXT[reason] ?? 'Reservation ended.');
      if (window.location.pathname.startsWith(`/session/${reservationId}`)) navigate('/devices');
    };
    const onInstall = (p: { jobId: string; percent: number; state: string; message?: string }) => {
      const { push, update } = useToasts.getState();
      const id = `install-${p.jobId}`;
      const exists = useToasts.getState().toasts.some((t) => t.id === id);
      const severity = p.state === 'error' ? 'error' : p.state === 'done' ? 'success' : 'info';
      const message =
        p.state === 'done'
          ? `Installed ${p.message ?? ''}`.trim()
          : p.state === 'error'
            ? `Install failed: ${p.message ?? ''}`
            : `${p.state === 'downloading' ? 'Preparing' : 'Installing'}… ${p.percent}%`;
      const patch = {
        message,
        severity,
        progress: p.state === 'done' || p.state === 'error' ? undefined : p.percent,
        autoHideMs: p.state === 'done' || p.state === 'error' ? 6000 : undefined,
      } as const;
      if (exists) update(id, patch);
      else push({ id, ...patch });
    };
    const onReconnect = () => {
      void qc.invalidateQueries({ queryKey: qk.devices });
      void qc.invalidateQueries({ queryKey: ['reservations'] });
    };
    s.on('device:updated', upsertDevice);
    s.on('device:removed', removeDevice);
    s.on('host:updated', upsertHost);
    s.on('reservation:updated', onReservation);
    s.on('reservation:released', onReleased);
    s.on('install:progress', onInstall);
    s.on('connect', onReconnect);
    return () => {
      s.off('device:updated', upsertDevice);
      s.off('device:removed', removeDevice);
      s.off('host:updated', upsertHost);
      s.off('reservation:updated', onReservation);
      s.off('reservation:released', onReleased);
      s.off('install:progress', onInstall);
      s.off('connect', onReconnect);
    };
  }, [qc, navigate]);

  useEffect(() => () => disconnectSocket(), []);
}
