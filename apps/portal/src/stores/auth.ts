import type { AuthTokensDto, UserDto } from '@devicelab/shared-types';
import { create } from 'zustand';

const REFRESH_KEY = 'devicelab.refresh';

function readRefresh(): string | null {
  try {
    // sessionStorage: survives reloads, cleared when the tab closes. Never localStorage.
    return sessionStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

interface AuthState {
  user: UserDto | null;
  accessToken: string | null;
  refreshToken: string | null;
  setSession(tokens: AuthTokensDto): void;
  clear(): void;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  refreshToken: readRefresh(),
  setSession: (t) => {
    try {
      sessionStorage.setItem(REFRESH_KEY, t.refreshToken);
    } catch {
      /* storage unavailable */
    }
    set({ user: t.user, accessToken: t.accessToken, refreshToken: t.refreshToken });
  },
  clear: () => {
    try {
      sessionStorage.removeItem(REFRESH_KEY);
    } catch {
      /* storage unavailable */
    }
    set({ user: null, accessToken: null, refreshToken: null });
  },
}));
