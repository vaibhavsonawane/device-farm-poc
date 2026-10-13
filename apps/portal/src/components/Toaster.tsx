import { Alert, Box, LinearProgress, Stack } from '@mui/material';
import { useEffect } from 'react';
import { type Toast, useToasts } from '../stores/toast';

function ToastItem({ t }: { t: Toast }) {
  const dismiss = useToasts((s) => s.dismiss);
  useEffect(() => {
    if (!t.autoHideMs) return;
    const timer = setTimeout(() => dismiss(t.id), t.autoHideMs);
    return () => clearTimeout(timer);
  }, [t.id, t.autoHideMs, t.message, dismiss]);
  return (
    <Alert
      severity={t.severity}
      variant="filled"
      onClose={() => dismiss(t.id)}
      sx={{ minWidth: 320, boxShadow: 6 }}
      role="status"
    >
      {t.message}
      {t.progress !== undefined && (
        <Box sx={{ mt: 1 }}>
          <LinearProgress
            variant="determinate"
            value={t.progress}
            color="inherit"
            sx={{ height: 6, borderRadius: 3 }}
          />
        </Box>
      )}
    </Alert>
  );
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <Stack
      spacing={1}
      sx={{ position: 'fixed', right: 16, bottom: 40, zIndex: (t) => t.zIndex.snackbar }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </Stack>
  );
}
