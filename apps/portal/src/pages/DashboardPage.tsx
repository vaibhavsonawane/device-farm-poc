import { Box, Grid2 as Grid, Paper, Typography } from '@mui/material';
import { useDevices, useHosts } from '../api/hooks';

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <Paper sx={{ p: 2.5 }}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h4" sx={{ mt: 0.5, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </Typography>
      {hint && (
        <Typography variant="caption" color="text.secondary">
          {hint}
        </Typography>
      )}
    </Paper>
  );
}

export function DashboardPage() {
  const devices = useDevices();
  const hosts = useHosts();
  const list = devices.data ?? [];
  const online = list.filter((d) => d.status !== 'OFFLINE').length;
  const inUse = list.filter((d) => d.status === 'IN_USE').length;
  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 2 }}>
        Dashboard
      </Typography>
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <Stat label="Devices" value={list.length} hint={`${online} online`} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <Stat
            label="In use now"
            value={inUse}
            hint={online ? `${Math.round((inUse / online) * 100)}% of online devices` : undefined}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <Stat
            label="Hosts online"
            value={(hosts.data ?? []).filter((h) => h.status === 'ONLINE').length}
            hint={`${hosts.data?.length ?? 0} registered`}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <Stat
            label="Platforms"
            value={`${list.filter((d) => d.platform === 'ANDROID').length} / ${list.filter((d) => d.platform === 'IOS').length}`}
            hint="Android / iOS"
          />
        </Grid>
      </Grid>
      <Paper sx={{ p: 3, mt: 2 }}>
        <Typography variant="subtitle1">Utilisation analytics — Phase 4</Typography>
        <Typography variant="body2" color="text.secondary">
          Daily utilisation %, top users, sessions per project and offline incidents (Recharts) will
          be computed from the audit log and reservation history.
        </Typography>
      </Paper>
    </Box>
  );
}
