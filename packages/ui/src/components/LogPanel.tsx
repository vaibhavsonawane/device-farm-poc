import ClearAllIcon from '@mui/icons-material/ClearAll';
import DownloadIcon from '@mui/icons-material/Download';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { Box, IconButton, MenuItem, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { LOG_LEVEL_ORDER, type LogLevel, type LogLine } from '@devicelab/shared-types';
import { useEffect, useMemo, useRef, useState } from 'react';

const LEVEL_COLOR: Record<LogLevel, string> = {
  V: 'text.disabled',
  D: 'info.main',
  I: 'success.main',
  W: 'warning.main',
  E: 'error.main',
  F: 'error.main',
};

const MAX_RENDERED = 600;

export interface LogPanelProps {
  lines: LogLine[];
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  onClear: () => void;
  /** File name stem for downloads, e.g. "logcat-Pixel8". */
  downloadName: string;
  emptyText?: string;
}

function fmt(l: LogLine): string {
  const t = new Date(l.ts);
  const time = `${t.toLocaleTimeString([], { hour12: false })}.${String(t.getMilliseconds()).padStart(3, '0')}`;
  return `${time} ${String(l.pid ?? '').padStart(5)} ${l.level} ${l.tag}: ${l.message}`;
}

/** Live logcat/syslog with level + tag/pid filter, search, pause and download. */
export function LogPanel({
  lines,
  paused,
  onPausedChange,
  onClear,
  downloadName,
  emptyText,
}: LogPanelProps) {
  const [minLevel, setMinLevel] = useState<LogLevel>('V');
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const filtered = useMemo(() => {
    const min = LOG_LEVEL_ORDER.indexOf(minLevel);
    const f = filter.trim().toLowerCase();
    const s = search.trim().toLowerCase();
    return lines.filter((l) => {
      if (LOG_LEVEL_ORDER.indexOf(l.level) < min) return false;
      if (f && !l.tag.toLowerCase().includes(f) && String(l.pid) !== f) return false;
      if (s && !l.message.toLowerCase().includes(s) && !l.tag.toLowerCase().includes(s))
        return false;
      return true;
    });
  }, [lines, minLevel, filter, search]);

  const visible = filtered.slice(-MAX_RENDERED);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [visible.length, lines]);

  const download = () => {
    const blob = new Blob([filtered.map(fmt).join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${downloadName}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Stack direction="row" spacing={1} sx={{ p: 1 }} alignItems="center">
        <TextField
          select
          size="small"
          label="Level"
          value={minLevel}
          onChange={(e) => setMinLevel(e.target.value as LogLevel)}
          sx={{ width: 84 }}
        >
          {LOG_LEVEL_ORDER.map((l) => (
            <MenuItem key={l} value={l}>
              {l}+
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          label="Tag / PID"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          sx={{ flex: 1 }}
        />
        <TextField
          size="small"
          label="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ flex: 1 }}
        />
      </Stack>
      <Stack direction="row" spacing={0.5} sx={{ px: 1 }} alignItems="center">
        <Tooltip title={paused ? 'Resume' : 'Pause'}>
          <IconButton
            size="small"
            onClick={() => onPausedChange(!paused)}
            aria-label={paused ? 'Resume logs' : 'Pause logs'}
          >
            {paused ? <PlayArrowIcon fontSize="small" /> : <PauseIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <Tooltip title="Clear">
          <IconButton size="small" onClick={onClear} aria-label="Clear logs">
            <ClearAllIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Download filtered lines">
          <span>
            <IconButton
              size="small"
              onClick={download}
              disabled={!filtered.length}
              aria-label="Download logs"
            >
              <DownloadIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
          {filtered.length.toLocaleString()} / {lines.length.toLocaleString()} lines
          {paused ? ' · paused' : ''}
        </Typography>
      </Stack>
      <Box
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        data-testid="log-lines"
        sx={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          m: 1,
          p: 1,
          borderRadius: 1,
          bgcolor: (t) => (t.palette.mode === 'dark' ? '#070b14' : '#0f172a'),
          color: '#cbd5e1',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 11.5,
          lineHeight: 1.45,
        }}
      >
        {visible.length === 0 ? (
          <Typography variant="caption" sx={{ color: '#64748b' }}>
            {emptyText ?? 'No log lines yet.'}
          </Typography>
        ) : (
          visible.map((l, i) => (
            <Box key={`${l.ts}-${i}`} sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              <Box component="span" sx={{ color: '#64748b' }}>
                {fmt(l).slice(0, 19)}
              </Box>
              <Box component="span" sx={{ color: LEVEL_COLOR[l.level], fontWeight: 700 }}>
                {l.level}
              </Box>{' '}
              <Box component="span" sx={{ color: '#93c5fd' }}>
                {l.tag}
              </Box>
              : {l.message}
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
