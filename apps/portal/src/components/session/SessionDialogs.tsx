import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import type { StreamQuality } from '@devicelab/shared-types';
import { useEffect, useState } from 'react';

export const SHORTCUTS: [string, string][] = [
  ['Ctrl + H', 'Home'],
  ['Ctrl + B', 'Back'],
  ['Ctrl + S', 'Screenshot'],
  ['Ctrl + R', 'Rotate'],
  ['Ctrl + V', 'Paste your clipboard into the device'],
  ['Alt + drag', 'Pinch / zoom gesture'],
  ['Scroll wheel', 'Scroll'],
  ['Click & hold', 'Long press'],
  ['Esc', 'Back'],
  ['?', 'Show this help'],
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Keyboard shortcuts</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Click the screen first; then typing goes straight to the device.
        </Typography>
        <Table size="small">
          <TableBody>
            {SHORTCUTS.map(([k, v]) => (
              <TableRow key={k}>
                <TableCell sx={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{k}</TableCell>
                <TableCell>{v}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

export function IdleDialog({
  releaseInSec,
  onStay,
}: {
  releaseInSec: number | null;
  onStay: () => void;
}) {
  const [left, setLeft] = useState(releaseInSec ?? 0);
  useEffect(() => {
    if (releaseInSec === null) return;
    setLeft(releaseInSec);
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [releaseInSec]);
  return (
    <Dialog open={releaseInSec !== null} onClose={onStay}>
      <DialogTitle>Still there?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          You have been inactive for a while. The device will be released in{' '}
          <b>
            {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
          </b>{' '}
          and installed builds will be removed.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={onStay} autoFocus>
          I&apos;m still here
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function CustomQualityDialog({
  open,
  initial,
  onClose,
  onApply,
}: {
  open: boolean;
  initial: StreamQuality;
  onClose: () => void;
  onApply: (q: StreamQuality) => void;
}) {
  const [maxSize, setMaxSize] = useState(String(initial.maxSize));
  const [mbps, setMbps] = useState(String(initial.bitRate / 1_000_000));
  const [fps, setFps] = useState(String(initial.maxFps));
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Custom stream quality</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Max size (px, longest side; 0 = native)"
            type="number"
            value={maxSize}
            onChange={(e) => setMaxSize(e.target.value)}
          />
          <TextField
            label="Bit rate (Mbps)"
            type="number"
            value={mbps}
            onChange={(e) => setMbps(e.target.value)}
            inputProps={{ step: 0.5, min: 0.25, max: 32 }}
          />
          <TextField
            label="Max FPS"
            type="number"
            value={fps}
            onChange={(e) => setFps(e.target.value)}
            inputProps={{ min: 1, max: 60 }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() =>
            onApply({
              maxSize: Math.max(0, Math.min(4096, Math.round(Number(maxSize) || 0))),
              bitRate: Math.max(
                250_000,
                Math.min(32_000_000, Math.round((Number(mbps) || 4) * 1_000_000)),
              ),
              maxFps: Math.max(1, Math.min(60, Math.round(Number(fps) || 30))),
            })
          }
        >
          Apply
        </Button>
      </DialogActions>
    </Dialog>
  );
}
