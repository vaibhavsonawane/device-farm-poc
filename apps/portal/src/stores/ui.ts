import type { PaletteMode } from '@mui/material';
import { create } from 'zustand';

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

interface UiState {
  mode: PaletteMode;
  navCollapsed: boolean;
  /** Global project filter from the top-bar switcher (null = all projects). */
  projectId: string | null;
  deviceView: 'grid' | 'table';
  toggleMode(): void;
  toggleNav(): void;
  setProject(id: string | null): void;
  setDeviceView(v: 'grid' | 'table'): void;
}

const prefersDark =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;

export const useUi = create<UiState>((set, get) => ({
  mode: load<PaletteMode>('devicelab.mode', prefersDark ? 'dark' : 'light'),
  navCollapsed: load('devicelab.nav', false),
  projectId: load<string | null>('devicelab.project', null),
  deviceView: load<'grid' | 'table'>('devicelab.deviceView', 'grid'),
  toggleMode: () => {
    const mode = get().mode === 'dark' ? 'light' : 'dark';
    save('devicelab.mode', mode);
    set({ mode });
  },
  toggleNav: () => {
    const navCollapsed = !get().navCollapsed;
    save('devicelab.nav', navCollapsed);
    set({ navCollapsed });
  },
  setProject: (projectId) => {
    save('devicelab.project', projectId);
    set({ projectId });
  },
  setDeviceView: (deviceView) => {
    save('devicelab.deviceView', deviceView);
    set({ deviceView });
  },
}));
