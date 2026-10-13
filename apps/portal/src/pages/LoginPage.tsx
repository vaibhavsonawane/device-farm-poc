import PhoneAndroidIcon from '@mui/icons-material/PhoneAndroid';
import { Alert, Box, Button, Card, CardContent, Stack, TextField, Typography } from '@mui/material';
import { type AuthTokensDto, loginRequestSchema } from '@devicelab/shared-types';
import { Footer } from '@devicelab/ui';
import { type FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../stores/auth';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuth((s) => s.user);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const from = (location.state as { from?: string } | null)?.from ?? '/devices';

  if (user) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = loginRequestSchema.safeParse({ email, password });
    if (!parsed.success) {
      setError('Enter a valid email and password.');
      return;
    }
    setBusy(true);
    try {
      const tokens = await api<AuthTokensDto>('/auth/login', { body: parsed.data });
      useAuth.getState().setSession(tokens);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
        backgroundImage: (t) =>
          `radial-gradient(1200px 600px at 10% -10%, ${t.palette.primary.main}22, transparent), radial-gradient(900px 500px at 110% 110%, ${t.palette.secondary.main}1f, transparent)`,
      }}
    >
      <Box sx={{ flex: 1, display: 'grid', placeItems: 'center', p: 2 }}>
        <Card sx={{ width: '100%', maxWidth: 400 }}>
          <CardContent sx={{ p: 4 }}>
            <Stack spacing={1} alignItems="center" sx={{ mb: 3 }}>
              <Box
                sx={{
                  width: 48,
                  height: 48,
                  borderRadius: 3,
                  bgcolor: 'primary.main',
                  color: 'primary.contrastText',
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                <PhoneAndroidIcon />
              </Box>
              <Typography variant="h5">DeviceLab</Typography>
              <Typography variant="body2" color="text.secondary" textAlign="center">
                Sign in to reserve and control lab devices
              </Typography>
            </Stack>
            <form onSubmit={(e) => void submit(e)} noValidate>
              <Stack spacing={2}>
                {error && (
                  <Alert severity="error" role="alert">
                    {error}
                  </Alert>
                )}
                <TextField
                  label="Email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                  required
                  fullWidth
                />
                <TextField
                  label="Password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  fullWidth
                />
                <Button type="submit" variant="contained" size="large" disabled={busy}>
                  {busy ? 'Signing in…' : 'Sign in'}
                </Button>
                <Typography variant="caption" color="text.secondary" textAlign="center">
                  Lab use only — test data, never production customer data.
                </Typography>
              </Stack>
            </form>
          </CardContent>
        </Card>
      </Box>
      <Footer />
    </Box>
  );
}
