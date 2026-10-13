import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import type { AppActionRequest, BuildDto, DeviceDto } from '@devicelab/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { type DragEvent, useRef, useState } from 'react';
import { api, uploadWithProgress } from '../../api/client';
import { qk, useApps, useBuilds } from '../../api/hooks';
import { errorMessage, toast, useToasts } from '../../stores/toast';
import { useUi } from '../../stores/ui';

const ACCEPT = '.apk,.ipa';

export function AppsPanel({ device, enabled }: { device: DeviceDto; enabled: boolean }) {
  const apps = useApps(device.id, enabled);
  const builds = useBuilds();
  const qc = useQueryClient();
  const projectId = useUi((s) => s.projectId);
  const [drag, setDrag] = useState(false);
  const [buildId, setBuildId] = useState('');
  const [menu, setMenu] = useState<{ el: HTMLElement; pkg: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ext = device.platform === 'ANDROID' ? '.apk' : '.ipa';
  const compatible = (builds.data ?? []).filter((b) => b.platform === device.platform);

  const install = async (b: BuildDto) => {
    try {
      await api('/builds/install', { body: { buildId: b.id, deviceIds: [device.id] } });
      // Progress arrives via the portal socket (install:progress) and refreshes the list when done.
      setTimeout(() => void qc.invalidateQueries({ queryKey: qk.apps(device.id) }), 2500);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const upload = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(ext)) {
      toast.error(
        file.name.toLowerCase().endsWith('.aab')
          ? 'AAB files are not installable — build a universal APK with bundletool.'
          : `Drop a ${ext} file for this ${device.platform === 'ANDROID' ? 'Android' : 'iOS'} device.`,
      );
      return;
    }
    const { push, update } = useToasts.getState();
    const id = push({
      message: `Uploading ${file.name}… 0%`,
      severity: 'info',
      progress: 0,
      autoHideMs: undefined,
    });
    try {
      const form = new FormData();
      form.append('file', file);
      if (projectId) form.append('projectId', projectId);
      const b = await uploadWithProgress<BuildDto>('/builds', form, (pct) =>
        update(id, { message: `Uploading ${file.name}… ${pct}%`, progress: pct }),
      );
      update(id, {
        message: `Uploaded ${file.name} (sha256 ${b.checksumSha256.slice(0, 10)}…)`,
        severity: 'success',
        progress: undefined,
        autoHideMs: 3000,
      });
      void qc.invalidateQueries({ queryKey: qk.builds });
      await install(b);
    } catch (err) {
      update(id, {
        message: errorMessage(err),
        severity: 'error',
        progress: undefined,
        autoHideMs: 7000,
      });
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files[0];
    if (f) void upload(f);
  };

  const act = async (pkg: string, action: AppActionRequest['action']) => {
    setMenu(null);
    if (action === 'uninstall' && !window.confirm(`Uninstall ${pkg}?`)) return;
    try {
      await api(`/devices/${device.id}/apps`, { body: { packageId: pkg, action } });
      toast.success(`${action[0]!.toUpperCase()}${action.slice(1)}: ${pkg}`);
      if (action === 'uninstall') void qc.invalidateQueries({ queryKey: qk.apps(device.id) });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Box
      sx={{
        p: 1.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        height: '100%',
        minHeight: 0,
      }}
    >
      <Box
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label={`Upload and install a ${ext} file`}
        data-testid="drop-zone"
        sx={{
          border: '2px dashed',
          borderColor: drag ? 'primary.main' : 'divider',
          bgcolor: drag ? 'action.hover' : 'transparent',
          borderRadius: 2,
          p: 2,
          textAlign: 'center',
          cursor: 'pointer',
          transition: 'all 120ms',
        }}
      >
        <CloudUploadIcon color={drag ? 'primary' : 'action'} />
        <Typography variant="body2">
          Drop an <b>{ext}</b> here or click to choose
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Uploaded to the build library, then installed (-r -g)
        </Typography>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = '';
          }}
        />
      </Box>

      <Stack direction="row" spacing={1}>
        <TextField
          select
          size="small"
          label="From build library"
          value={buildId}
          onChange={(e) => setBuildId(e.target.value)}
          sx={{ flex: 1 }}
        >
          {compatible.length === 0 && (
            <MenuItem value="" disabled>
              No {device.platform === 'ANDROID' ? 'APK' : 'IPA'} builds yet
            </MenuItem>
          )}
          {compatible.map((b) => (
            <MenuItem key={b.id} value={b.id}>
              {b.fileName} · {new Date(b.uploadedAt).toLocaleDateString()}
            </MenuItem>
          ))}
        </TextField>
        <Button
          variant="outlined"
          disabled={!buildId}
          onClick={() => {
            const b = compatible.find((x) => x.id === buildId);
            if (b) void install(b);
          }}
        >
          Install
        </Button>
      </Stack>

      <Divider />
      <Stack direction="row" alignItems="center">
        <Typography variant="subtitle2" sx={{ flex: 1 }}>
          Installed apps
        </Typography>
        <Tooltip title="Refresh">
          <IconButton size="small" onClick={() => void apps.refetch()} aria-label="Refresh apps">
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {apps.isLoading && <CircularProgress size={20} />}
        {apps.isError && <Alert severity="warning">{(apps.error as Error).message}</Alert>}
        {apps.data?.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No user-installed apps.
          </Typography>
        )}
        <List dense disablePadding>
          {(apps.data ?? []).map((a) => (
            <ListItem
              key={a.packageId}
              disableGutters
              secondaryAction={
                <IconButton
                  edge="end"
                  size="small"
                  onClick={(e) => setMenu({ el: e.currentTarget, pkg: a.packageId })}
                  aria-label={`Actions for ${a.packageId}`}
                >
                  <MoreVertIcon fontSize="small" />
                </IconButton>
              }
            >
              <ListItemText
                primary={a.label ?? a.packageId}
                secondary={a.label ? a.packageId : a.versionName}
                primaryTypographyProps={{ noWrap: true, fontSize: 13 }}
                secondaryTypographyProps={{ noWrap: true, fontSize: 11 }}
              />
            </ListItem>
          ))}
        </List>
      </Box>
      <Menu anchorEl={menu?.el} open={Boolean(menu)} onClose={() => setMenu(null)}>
        <MenuItem onClick={() => menu && void act(menu.pkg, 'launch')}>Launch</MenuItem>
        <MenuItem onClick={() => menu && void act(menu.pkg, 'stop')}>Force stop</MenuItem>
        {device.platform === 'ANDROID' && (
          <MenuItem onClick={() => menu && void act(menu.pkg, 'clear')}>Clear data</MenuItem>
        )}
        <MenuItem
          onClick={() => menu && void act(menu.pkg, 'uninstall')}
          sx={{ color: 'error.main' }}
        >
          Uninstall
        </MenuItem>
      </Menu>
    </Box>
  );
}
