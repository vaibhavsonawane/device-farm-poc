import type { AlertColor } from '@mui/material';
import { create } from 'zustand';

export interface Toast {
  id: string;
  message: string;
  severity: AlertColor;
  /** 0–100 for progress toasts (installs, uploads). */
  progress?: number;
  /** Auto-hide after ms; undefined = sticky until updated/dismissed. */
  autoHideMs?: number;
}

interface ToastState {
  toasts: Toast[];
  push(t: Omit<Toast, 'id'> & { id?: string }): string;
  update(id: string, patch: Partial<Toast>): void;
  dismiss(id: string): void;
}

let n = 0;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = t.id ?? `t${++n}`;
    set((s) => ({
      toasts: [...s.toasts.filter((x) => x.id !== id), { autoHideMs: 4000, ...t, id }].slice(-5),
    }));
    return id;
  },
  update: (id, patch) =>
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  success: (message: string) => useToasts.getState().push({ message, severity: 'success' }),
  error: (message: string) =>
    useToasts.getState().push({ message, severity: 'error', autoHideMs: 7000 }),
  info: (message: string) => useToasts.getState().push({ message, severity: 'info' }),
  warning: (message: string) =>
    useToasts.getState().push({ message, severity: 'warning', autoHideMs: 7000 }),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
