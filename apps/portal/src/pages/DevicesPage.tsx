import GridViewIcon from '@mui/icons-material/GridView';
import PhonelinkOffIcon from '@mui/icons-material/PhonelinkOff';
import SearchIcon from '@mui/icons-material/Search';
import TableRowsIcon from '@mui/icons-material/TableRows';
import {
  Alert,
  Box,
  Grid2 as Grid,
  InputAdornment,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import type { DeviceDto, DeviceStatus, Platform } from '@devicelab/shared-types';
import { Battery, DeviceCard, EmptyState, PlatformIcon, StatusChip } from '@devicelab/ui';
import { useMemo, useState } from 'react';
import { useDevices } from '../api/hooks';
import { DeviceAdminMenu, DevicePrimaryAction } from '../components/DeviceActions';
import { DeviceEditDialog } from '../components/DeviceEditDialog';
import { useUi } from '../stores/ui';

const majorVersion = (v: string): number => Number.parseFloat(v) || 0;

export function DevicesPage() {
  const devices = useDevices();
  const { deviceView, setDeviceView, projectId } = useUi();
  const [q, setQ] = useState('');
  const [platform, setPlatform] = useState<Platform | 'ALL'>('ALL');
  const [status, setStatus] = useState<DeviceStatus | 'ALL'>('ALL');
  const [manufacturer, setManufacturer] = useState('ALL');
  const [tag, setTag] = useState('ALL');
  const [osMin, setOsMin] = useState('');
  const [osMax, setOsMax] = useState('');
  const [editing, setEditing] = useState<DeviceDto | null>(null);

  const all = useMemo(() => devices.data ?? [], [devices.data]);
  const manufacturers = useMemo(() => [...new Set(all.map((d) => d.manufacturer))].sort(), [all]);
  const tags = useMemo(() => [...new Set(all.flatMap((d) => d.tags))].sort(), [all]);

  const filtered = useMemo(() => {
    const text = q.trim().toLowerCase();
    return all.filter((d) => {
      if (projectId && d.projectId !== projectId) return false;
      if (platform !== 'ALL' && d.platform !== platform) return false;
      if (status !== 'ALL' && d.status !== status) return false;
      if (manufacturer !== 'ALL' && d.manufacturer !== manufacturer) return false;
      if (tag !== 'ALL' && !d.tags.includes(tag)) return false;
      if (osMin && majorVersion(d.osVersion) < Number(osMin)) return false;
      if (osMax && majorVersion(d.osVersion) > Number(osMax)) return false;
      if (text) {
        const hay =
          `${d.name ?? ''} ${d.model} ${d.manufacturer} ${d.osVersion} ${d.udid} ${d.hostName} ${d.tags.join(' ')} ${d.projectName ?? ''}`.toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    });
  }, [all, q, platform, status, manufacturer, tag, osMin, osMax, projectId]);

  const counts = useMemo(
    () => ({
      available: all.filter((d) => d.status === 'AVAILABLE').length,
      inUse: all.filter((d) => d.status === 'IN_USE').length,
      offline: all.filter((d) => d.status === 'OFFLINE').length,
    }),
    [all],
  );

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        justifyContent="space-between"
        alignItems={{ md: 'flex-end' }}
        sx={{ mb: 2 }}
        spacing={1}
      >
        <Box>
          <Typography variant="h5">Devices</Typography>
          <Typography variant="body2" color="text.secondary">
            {counts.available} available · {counts.inUse} in use · {counts.offline} offline —
            updates live
          </Typography>
        </Box>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={deviceView}
          onChange={(_e, v: 'grid' | 'table' | null) => v && setDeviceView(v)}
          aria-label="View"
        >
          <ToggleButton value="grid" aria-label="Grid view">
            <GridViewIcon fontSize="small" />
          </ToggleButton>
          <ToggleButton value="table" aria-label="Table view">
            <TableRowsIcon fontSize="small" />
          </ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      <Paper sx={{ p: 1.5, mb: 2 }}>
        <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="center">
          <TextField
            size="small"
            placeholder="Search model, serial, tag…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            sx={{ minWidth: 240, flex: 1 }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
            inputProps={{ 'aria-label': 'Search devices' }}
          />
          <ToggleButtonGroup
            size="small"
            exclusive
            value={platform}
            onChange={(_e, v: Platform | 'ALL' | null) => v && setPlatform(v)}
          >
            <ToggleButton value="ALL">All</ToggleButton>
            <ToggleButton value="ANDROID">Android</ToggleButton>
            <ToggleButton value="IOS">iOS</ToggleButton>
          </ToggleButtonGroup>
          <TextField
            select
            size="small"
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as DeviceStatus | 'ALL')}
            sx={{ width: 150 }}
          >
            <MenuItem value="ALL">Any status</MenuItem>
            <MenuItem value="AVAILABLE">Available</MenuItem>
            <MenuItem value="IN_USE">In use</MenuItem>
            <MenuItem value="OFFLINE">Offline</MenuItem>
            <MenuItem value="MAINTENANCE">Maintenance</MenuItem>
          </TextField>
          <TextField
            select
            size="small"
            label="Manufacturer"
            value={manufacturer}
            onChange={(e) => setManufacturer(e.target.value)}
            sx={{ width: 160 }}
          >
            <MenuItem value="ALL">Any</MenuItem>
            {manufacturers.map((m) => (
              <MenuItem key={m} value={m}>
                {m}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="Tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            sx={{ width: 130 }}
          >
            <MenuItem value="ALL">Any</MenuItem>
            {tags.map((t) => (
              <MenuItem key={t} value={t}>
                {t}
              </MenuItem>
            ))}
          </TextField>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <TextField
              size="small"
              label="OS ≥"
              value={osMin}
              onChange={(e) => setOsMin(e.target.value.replace(/[^\d.]/g, ''))}
              sx={{ width: 76 }}
            />
            <TextField
              size="small"
              label="OS ≤"
              value={osMax}
              onChange={(e) => setOsMax(e.target.value.replace(/[^\d.]/g, ''))}
              sx={{ width: 76 }}
            />
          </Stack>
        </Stack>
      </Paper>

      {devices.isError && (
        <Alert severity="error">Could not load devices: {(devices.error as Error).message}</Alert>
      )}

      {devices.isLoading ? (
        <Grid container spacing={2}>
          {Array.from({ length: 8 }).map((_, i) => (
            <Grid key={i} size={{ xs: 12, sm: 6, md: 4, lg: 3 }}>
              <Skeleton variant="rounded" height={190} />
            </Grid>
          ))}
        </Grid>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<PhonelinkOffIcon />}
          title={all.length ? 'No devices match your filters' : 'No devices yet'}
          description={
            all.length
              ? 'Clear a filter or search for something else.'
              : 'Register a host under Admin → Hosts and start the host agent, or run `pnpm dev:mock-agent` for simulated devices.'
          }
        />
      ) : deviceView === 'grid' ? (
        <Grid container spacing={2}>
          {filtered.map((d) => (
            <Grid key={d.id} size={{ xs: 12, sm: 6, md: 4, lg: 3 }}>
              <DeviceCard
                device={d}
                actions={<DevicePrimaryAction device={d} />}
                menu={<DeviceAdminMenu device={d} onEdit={setEditing} />}
              />
            </Grid>
          ))}
        </Grid>
      ) : (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Device</TableCell>
                <TableCell>OS</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Battery</TableCell>
                <TableCell>Host</TableCell>
                <TableCell>Project / tags</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map((d) => (
                <TableRow key={d.id} hover data-testid={`device-row-${d.udid}`}>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <PlatformIcon platform={d.platform} fontSize="small" />
                      <Box>
                        <Typography variant="body2" fontWeight={600}>
                          {d.name ?? d.model}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {d.manufacturer} · {d.udid}
                        </Typography>
                      </Box>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    {d.platform === 'ANDROID' ? 'Android' : 'iOS'} {d.osVersion}
                  </TableCell>
                  <TableCell>
                    <StatusChip
                      status={d.status}
                      automation={d.currentReservation?.kind === 'AUTOMATION'}
                    />
                    {d.currentReservation && (
                      <Typography variant="caption" display="block" color="text.secondary">
                        {d.currentReservation.userName}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Battery level={d.batteryLevel} />
                  </TableCell>
                  <TableCell>{d.hostName}</TableCell>
                  <TableCell>
                    <Typography variant="caption">
                      {[d.projectName, ...d.tags].filter(Boolean).join(' · ') || '—'}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Stack
                      direction="row"
                      spacing={1}
                      justifyContent="flex-end"
                      alignItems="center"
                    >
                      <DevicePrimaryAction device={d} />
                      <DeviceAdminMenu device={d} onEdit={setEditing} />
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <DeviceEditDialog device={editing} onClose={() => setEditing(null)} />
    </Box>
  );
}
