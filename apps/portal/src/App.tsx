import { Box, CircularProgress, CssBaseline, ThemeProvider } from '@mui/material';
import { createAppTheme } from '@devicelab/ui';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, refreshSession } from './api/client';
import { Toaster } from './components/Toaster';
import { AppShell } from './layout/AppShell';
import { AdminPage } from './pages/admin/AdminPage';
import { AutomationPage } from './pages/AutomationPage';
import { BuildsPage } from './pages/BuildsPage';
import { DashboardPage } from './pages/DashboardPage';
import { DevicesPage } from './pages/DevicesPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ObservePage, SessionPage } from './pages/SessionPage';
import { SessionsPage } from './pages/SessionsPage';
import { useAuth } from './stores/auth';
import { useUi } from './stores/ui';
import type { UserDto } from '@devicelab/shared-types';

function useBootstrapAuth(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void (async () => {
      const { refreshToken, accessToken } = useAuth.getState();
      if (!accessToken && refreshToken) await refreshSession();
      if (useAuth.getState().accessToken && !useAuth.getState().user) {
        try {
          const user = await api<UserDto>('/auth/me');
          useAuth.setState({ user });
        } catch {
          useAuth.getState().clear();
        }
      }
      setReady(true);
    })();
  }, []);
  return ready;
}

function RequireAuth({ children }: { children: ReactNode }) {
  const user = useAuth((s) => s.user);
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

export function App() {
  const mode = useUi((s) => s.mode);
  const theme = useMemo(() => createAppTheme(mode), [mode]);
  const ready = useBootstrapAuth();

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline enableColorScheme />
      {!ready ? (
        <Box sx={{ height: '100vh', display: 'grid', placeItems: 'center' }}>
          <CircularProgress aria-label="Loading" />
        </Box>
      ) : (
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route index element={<Navigate to="/devices" replace />} />
            <Route path="/devices" element={<DevicesPage />} />
            <Route path="/session/:reservationId" element={<SessionPage />} />
            <Route path="/observe/:sessionId" element={<ObservePage />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/builds" element={<BuildsPage />} />
            <Route path="/automation" element={<AutomationPage />} />
            <Route path="/admin/*" element={<AdminPage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      )}
      <Toaster />
    </ThemeProvider>
  );
}
