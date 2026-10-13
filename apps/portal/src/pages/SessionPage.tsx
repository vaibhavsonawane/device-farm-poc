import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CameraAltIcon from '@mui/icons-material/CameraAlt';
import CircleOutlinedIcon from '@mui/icons-material/CircleOutlined';
import CropSquareIcon from '@mui/icons-material/CropSquare';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import LogoutIcon from '@mui/icons-material/Logout';
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew';
import ScreenRotationIcon from '@mui/icons-material/ScreenRotation';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VolumeDownIcon from '@mui/icons-material/VolumeDown';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { DeviceKey } from '@devicelab/protocol';
import {
  type ArtifactDto,
  type DeviceDto,
  type LogLine,
  type ReservationDto,
  STREAM_QUALITY_PRESETS,
  type SessionJoinDto,
  type StreamQuality,
  type StreamQualityPreset,
} from '@devicelab/shared-types';
import {
  LogPanel,
  PlatformIcon,
  ScreenViewer,
  type ScreenViewerHandle,
  type ViewerStats,
} from '@devicelab/ui';
import { useQueryClient } from '@tanstack/react-query';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { qk, useDevices, useExtend, useRelease, useReservation } from '../api/hooks';
import { AppsPanel } from '../components/session/AppsPanel';
import { InfoPanel } from '../components/session/InfoPanel';
import {
  CustomQualityDialog,
  IdleDialog,
  ShortcutsDialog,
} from '../components/session/SessionDialogs';
import { type LinkState, useLiveSession } from '../components/session/useLiveSession';
import { getSocket, request } from '../realtime/socket';
import { errorMessage, toast } from '../stores/toast';

const MAX_LOG_LINES = 5000;

function useCountdown(endAt: string | undefined): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!endAt) return '—';
  const s = Math.max(0, Math.floor((new Date(endAt).getTime() - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function ToolButton({
  title,
  onClick,
  children,
  disabled,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Tooltip title={title}>
      <span>
        <IconButton size="small" onClick={onClick} disabled={disabled} aria-label={title}>
          {children}
        </IconButton>
      </span>
    </Tooltip>
  );
}

const LINK_TEXT: Record<LinkState, string> = {
  joining: 'Starting session…',
  connecting: 'Connecting to device…',
  live: '',
  reconnecting: 'Reconnecting…',
  ended: 'Session ended',
  error: 'Connection failed',
  'taken-over': 'Session opened in another tab',
};

interface SessionViewProps {
  device: DeviceDto;
  join: SessionJoinDto | null;
  live: ReturnType<typeof useLiveSession>;
  reservation: ReservationDto | null;
}

function SessionView({ device, join, live, reservation }: SessionViewProps) {
  const viewer = useRef<ScreenViewerHandle>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const controller = join?.role === 'controller';
  const sessionId = join?.session.id ?? null;
  const [stats, setStats] = useState<ViewerStats | null>(null);
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit');
  const [tab, setTab] = useState(controller ? 0 : 1);
  const [quality, setQuality] = useState<StreamQualityPreset | 'CUSTOM'>('MEDIUM');
  const [customQ, setCustomQ] = useState<StreamQuality>(STREAM_QUALITY_PRESETS.MEDIUM);
  const [customOpen, setCustomOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [idleIn, setIdleIn] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [extendAnchor, setExtendAnchor] = useState<HTMLElement | null>(null);
  const [typeText, setTypeText] = useState('');
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const release = useRelease();
  const extend = useExtend();
  const remaining = useCountdown(reservation?.endAt);
  const lowTime = reservation
    ? new Date(reservation.endAt).getTime() - Date.now() < 5 * 60_000
    : false;

  // Idle warnings + log lines from the portal socket.
  useEffect(() => {
    const s = getSocket();
    const onIdle = (p: { reservationId: string; releaseInSec: number }) => {
      if (p.reservationId === reservation?.id) setIdleIn(p.releaseInSec);
    };
    const onLog = (b: { sessionId: string; lines: LogLine[] }) => {
      if (b.sessionId !== sessionId || pausedRef.current) return;
      setLogs((prev) => {
        const next = prev.concat(b.lines);
        return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
      });
    };
    s.on('reservation:idle-warning', onIdle);
    s.on('session:log', onLog);
    return () => {
      s.off('reservation:idle-warning', onIdle);
      s.off('session:log', onLog);
    };
  }, [reservation?.id, sessionId]);

  // Start logcat when the Logs tab is first opened; stop when leaving the page.
  const logsStarted = useRef(false);
  useEffect(() => {
    if (tab !== 1 || !sessionId || logsStarted.current) return;
    logsStarted.current = true;
    request('session:logs', { sessionId, action: 'start' }).catch((e: unknown) =>
      toast.warning(`Logs: ${errorMessage(e)}`),
    );
  }, [tab, sessionId]);
  useEffect(
    () => () => {
      if (sessionId && logsStarted.current)
        void request('session:logs', { sessionId, action: 'stop' }).catch(() => undefined);
    },
    [sessionId],
  );

  const screenshot = useCallback(async () => {
    if (!sessionId || !controller) return;
    try {
      const a = await api<ArtifactDto>(`/sessions/${sessionId}/screenshot`, { method: 'POST' });
      toast.success(`Screenshot saved: ${a.fileName}`);
      void qc.invalidateQueries({ queryKey: qk.artifacts(sessionId) });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, [sessionId, controller, qc]);

  const applyQuality = async (q: StreamQuality, label: StreamQualityPreset | 'CUSTOM') => {
    if (!sessionId) return;
    try {
      await api(`/sessions/${sessionId}/quality`, { body: q });
      setQuality(label);
      toast.info(
        `Stream quality: ${label.toLowerCase()} (${q.maxSize || 'native'} px, ${q.bitRate / 1e6} Mbps, ${q.maxFps} fps)`,
      );
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const doRelease = async () => {
    if (
      !reservation ||
      !window.confirm('Release this device? Builds installed in this session will be removed.')
    )
      return;
    try {
      await release.mutateAsync(reservation.id);
      toast.success('Device released — cleanup running on the device');
      navigate('/devices');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const keepalive = async () => {
    setIdleIn(null);
    if (reservation)
      await api(`/reservations/${reservation.id}/keepalive`, { method: 'POST' }).catch(
        () => undefined,
      );
  };

  /** Session shortcuts; returns true if handled. */
  const shortcut = useCallback(
    (e: { key: string; ctrlKey: boolean; metaKey: boolean; target: EventTarget | null }) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (!mod && e.key === '?') {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return false;
        setHelpOpen(true);
        return true;
      }
      if (!mod || !controller) return false;
      if (k === 'h') viewer.current?.key(DeviceKey.HOME);
      else if (k === 'b') viewer.current?.key(DeviceKey.BACK);
      else if (k === 's') void screenshot();
      else if (k === 'r') viewer.current?.rotate();
      else return false;
      return true;
    },
    [controller, screenshot],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (shortcut(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcut]);

  const secure = live.streamStatus?.secureContentSuspected;
  const overlay = useMemo(() => {
    if (secure) {
      return (
        <Alert
          severity="warning"
          sx={{ m: 2, maxWidth: 300, pointerEvents: 'auto' }}
          data-testid="secure-hint"
        >
          This app blocks screen capture. Use a UAT/debug build with FLAG_SECURE disabled for lab
          testing.
        </Alert>
      );
    }
    if (stats?.error) {
      return (
        <Alert severity="error" sx={{ m: 2, maxWidth: 300 }} data-testid="decoder-error">
          {stats.error}
        </Alert>
      );
    }
    if (live.state !== 'live' || !stats?.width) {
      const text = live.state === 'live' ? 'Waiting for first frame…' : LINK_TEXT[live.state];
      return (
        <Stack
          alignItems="center"
          spacing={1.5}
          sx={{ color: '#cbd5e1', textAlign: 'center', p: 2 }}
        >
          {['joining', 'connecting', 'reconnecting', 'live'].includes(live.state) && (
            <CircularProgress size={28} color="inherit" />
          )}
          <Typography variant="body2">{text}</Typography>
          {live.error && <Typography variant="caption">{live.error}</Typography>}
          {live.streamStatus?.state === 'error' && (
            <Typography variant="caption">{live.streamStatus.message}</Typography>
          )}
        </Stack>
      );
    }
    return null;
  }, [secure, live.state, live.error, live.streamStatus, stats?.width, stats?.error]);

  const android = device.platform === 'ANDROID';
  const k = (key: DeviceKey) => () => viewer.current?.key(key);

  return (
    <Box sx={{ display: 'flex', gap: 1.5, flex: 1, minHeight: 0 }}>
      {/* Screen column */}
      <Paper sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Stack
          direction="row"
          alignItems="center"
          spacing={0.5}
          sx={{ px: 1, py: 0.5, borderBottom: 1, borderColor: 'divider', flexWrap: 'wrap' }}
        >
          <PlatformIcon platform={device.platform} fontSize="small" />
          <Typography
            variant="subtitle2"
            noWrap
            sx={{ maxWidth: 180, mr: 0.5 }}
            data-testid="session-device"
          >
            {device.name ?? device.model}
          </Typography>
          {controller ? (
            <>
              <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
              <ToolButton title="Home (Ctrl+H)" onClick={k(DeviceKey.HOME)}>
                <CircleOutlinedIcon fontSize="small" />
              </ToolButton>
              <ToolButton title="Back (Ctrl+B)" onClick={k(DeviceKey.BACK)}>
                <ArrowBackIcon fontSize="small" />
              </ToolButton>
              {android && (
                <ToolButton title="Recents" onClick={k(DeviceKey.RECENTS)}>
                  <CropSquareIcon fontSize="small" />
                </ToolButton>
              )}
              <ToolButton title="Power" onClick={k(DeviceKey.POWER)}>
                <PowerSettingsNewIcon fontSize="small" />
              </ToolButton>
              <ToolButton title="Volume up" onClick={k(DeviceKey.VOLUME_UP)}>
                <VolumeUpIcon fontSize="small" />
              </ToolButton>
              <ToolButton title="Volume down" onClick={k(DeviceKey.VOLUME_DOWN)}>
                <VolumeDownIcon fontSize="small" />
              </ToolButton>
              <ToolButton title="Rotate (Ctrl+R)" onClick={() => viewer.current?.rotate()}>
                <ScreenRotationIcon fontSize="small" />
              </ToolButton>
              <ToolButton title="Screenshot (Ctrl+S)" onClick={() => void screenshot()}>
                <CameraAltIcon fontSize="small" />
              </ToolButton>
            </>
          ) : (
            <Chip
              size="small"
              icon={<VisibilityIcon />}
              label="View only"
              color="info"
              variant="outlined"
            />
          )}
          <ToolButton
            title={zoom === 'fit' ? 'Actual size (100%)' : 'Fit to window'}
            onClick={() => setZoom(zoom === 'fit' ? 'actual' : 'fit')}
          >
            {zoom === 'fit' ? <ZoomInIcon fontSize="small" /> : <FitScreenIcon fontSize="small" />}
          </ToolButton>
          <ToolButton title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)}>
            <KeyboardIcon fontSize="small" />
          </ToolButton>
          <Box sx={{ flex: 1 }} />
          {controller && (
            <TextField
              select
              size="small"
              value={quality}
              onChange={(e) => {
                const v = e.target.value as StreamQualityPreset | 'CUSTOM';
                if (v === 'CUSTOM') setCustomOpen(true);
                else void applyQuality(STREAM_QUALITY_PRESETS[v], v);
              }}
              sx={{ width: 118, '& .MuiInputBase-input': { py: 0.5 } }}
              inputProps={{ 'aria-label': 'Stream quality' }}
            >
              <MenuItem value="LOW">Low</MenuItem>
              <MenuItem value="MEDIUM">Medium</MenuItem>
              <MenuItem value="HIGH">High</MenuItem>
              <MenuItem value="CUSTOM">Custom…</MenuItem>
            </TextField>
          )}
          <Tooltip
            title={`Decoder: ${stats?.decoder ?? '—'} · ${stats?.width ?? 0}×${stats?.height ?? 0} · dropped ${stats?.dropped ?? 0}`}
          >
            <Chip
              size="small"
              variant="outlined"
              data-testid="stream-stats"
              color={
                stats?.rttMs !== null && stats?.rttMs !== undefined && stats.rttMs > 150
                  ? 'warning'
                  : 'default'
              }
              label={`${stats?.fps ?? 0} fps · ${stats?.rttMs ?? '—'} ms`}
              sx={{ fontVariantNumeric: 'tabular-nums' }}
            />
          </Tooltip>
        </Stack>
        <Box sx={{ flex: 1, minHeight: 0, display: 'flex', p: 1.5, bgcolor: 'background.default' }}>
          <ScreenViewer
            ref={viewer}
            transport={live.transport}
            interactive={controller}
            zoom={zoom}
            overlay={overlay}
            onStats={setStats}
            onShortcut={(e: ReactKeyboardEvent) => shortcut(e)}
          />
        </Box>
      </Paper>

      {/* Side panel */}
      <Paper
        sx={{ width: 360, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}
      >
        <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.5, py: 1 }}>
          {reservation && (
            <Box sx={{ flex: 1 }}>
              <Typography variant="caption" color="text.secondary" display="block">
                {controller ? 'Time remaining' : `Held by ${reservation.userName}`}
              </Typography>
              <Typography
                variant="h6"
                color={lowTime ? 'warning.main' : 'text.primary'}
                sx={{ fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}
                data-testid="countdown"
              >
                {remaining}
              </Typography>
            </Box>
          )}
          {controller && (
            <>
              <Button
                size="small"
                variant="outlined"
                onClick={(e) => setExtendAnchor(e.currentTarget)}
              >
                Extend
              </Button>
              <Menu
                anchorEl={extendAnchor}
                open={Boolean(extendAnchor)}
                onClose={() => setExtendAnchor(null)}
              >
                {[15, 30, 60].map((m) => (
                  <MenuItem
                    key={m}
                    onClick={async () => {
                      setExtendAnchor(null);
                      if (!reservation) return;
                      try {
                        await extend.mutateAsync({ id: reservation.id, minutes: m });
                        toast.success(`Extended by ${m} min`);
                      } catch (err) {
                        toast.error(errorMessage(err));
                      }
                    }}
                  >
                    +{m} min
                  </MenuItem>
                ))}
              </Menu>
              <Button
                size="small"
                variant="contained"
                color="error"
                startIcon={<LogoutIcon />}
                onClick={() => void doRelease()}
                data-testid="release"
              >
                Release
              </Button>
            </>
          )}
        </Stack>
        {controller && (
          <Box sx={{ px: 1.5, pb: 1 }}>
            <TextField
              size="small"
              fullWidth
              placeholder="Type text and press Enter to send"
              value={typeText}
              onChange={(e) => setTypeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && typeText) {
                  viewer.current?.paste(typeText);
                  setTypeText('');
                }
              }}
              inputProps={{ 'aria-label': 'Send text to device' }}
            />
          </Box>
        )}
        <Tabs
          value={tab}
          onChange={(_e, v: number) => setTab(v)}
          variant="fullWidth"
          sx={{
            borderBottom: 1,
            borderColor: 'divider',
            minHeight: 40,
            '& .MuiTab-root': { minHeight: 40 },
          }}
        >
          <Tab label="Apps" disabled={!controller} />
          <Tab label="Logs" />
          <Tab label="Device info" />
        </Tabs>
        <Box sx={{ flex: 1, minHeight: 0 }}>
          {tab === 0 && controller && <AppsPanel device={device} enabled={controller} />}
          {tab === 1 && (
            <LogPanel
              lines={logs}
              paused={paused}
              onPausedChange={setPaused}
              onClear={() => setLogs([])}
              downloadName={`${android ? 'logcat' : 'syslog'}-${device.model.replace(/\s+/g, '')}`}
              emptyText={`Waiting for ${android ? 'logcat' : 'syslog'}…`}
            />
          )}
          {tab === 2 && <InfoPanel device={device} sessionId={sessionId} />}
        </Box>
      </Paper>

      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      <IdleDialog releaseInSec={idleIn} onStay={() => void keepalive()} />
      <CustomQualityDialog
        open={customOpen}
        initial={customQ}
        onClose={() => setCustomOpen(false)}
        onApply={(q) => {
          setCustomOpen(false);
          setCustomQ(q);
          void applyQuality(q, 'CUSTOM');
        }}
      />
    </Box>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>{children}</Box>;
}

/** /session/:reservationId — the reservation holder's live session. */
export function SessionPage() {
  const { reservationId } = useParams<{ reservationId: string }>();
  const reservation = useReservation(reservationId);
  const devices = useDevices();
  const navigate = useNavigate();
  const active = reservation.data?.status === 'ACTIVE';
  const start = useMemo(
    () =>
      active && reservationId
        ? () => api<SessionJoinDto>('/sessions', { body: { reservationId } })
        : null,
    [active, reservationId],
  );
  const live = useLiveSession(start, active ? (reservationId ?? '') : '');
  const device = devices.data?.find((d) => d.id === reservation.data?.deviceId);

  if (reservation.isLoading || devices.isLoading)
    return (
      <Centered>
        <CircularProgress />
      </Centered>
    );
  if (reservation.isError)
    return (
      <Centered>
        <Alert severity="error">{(reservation.error as Error).message}</Alert>
      </Centered>
    );
  if (!active) {
    return (
      <Centered>
        <Stack spacing={2} alignItems="center">
          <Alert severity="info">
            This reservation has ended (
            {reservation.data?.releaseReason?.toLowerCase() ??
              reservation.data?.status.toLowerCase()}
            ).
          </Alert>
          <Button variant="contained" onClick={() => navigate('/devices')}>
            Back to devices
          </Button>
        </Stack>
      </Centered>
    );
  }
  if (!device)
    return (
      <Centered>
        <Alert severity="warning">Device not visible.</Alert>
      </Centered>
    );
  return (
    <SessionView
      device={device}
      join={live.join}
      live={live}
      reservation={reservation.data ?? null}
    />
  );
}

/** /observe/:sessionId — read-only view for leads/managers. */
export function ObservePage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const devices = useDevices();
  const start = useMemo(
    () =>
      sessionId
        ? () => api<SessionJoinDto>(`/sessions/${sessionId}/ticket`, { method: 'POST' })
        : null,
    [sessionId],
  );
  const live = useLiveSession(start, sessionId ?? '');
  const reservation = useReservation(live.join?.session.reservationId);
  const device = devices.data?.find((d) => d.id === live.join?.session.deviceId);

  if (live.state === 'error')
    return (
      <Centered>
        <Alert severity="error">{live.error}</Alert>
      </Centered>
    );
  if (!device || !live.join)
    return (
      <Centered>
        <CircularProgress />
      </Centered>
    );
  return (
    <SessionView
      device={device}
      join={live.join}
      live={live}
      reservation={reservation.data ?? null}
    />
  );
}
