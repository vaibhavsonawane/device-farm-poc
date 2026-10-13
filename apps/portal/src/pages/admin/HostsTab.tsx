import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { type HostDto, type HostTokenDto, createHostSchema } from '@devicelab/shared-types';
import { useState } from 'react';
import { useCreateHost, useHostAction, useHosts } from '../../api/hooks';
import { errorMessage, toast } from '../../stores/toast';

function TokenDialog({ result, onClose }: { result: HostTokenDto | null; onClose: () => void }) {
  if (!result) return null;
  const config = JSON.stringify(
    {
      serverUrl: window.location.origin,
      agentToken: result.agentToken,
      hostName: result.host.name,
      adbPath: 'adb',
      allowedSerials: [],
    },
    null,
    2,
  );
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Agent token for {result.host.name}</DialogTitle>
      <DialogContent>
        <Alert severity="warning" sx={{ mb: 2 }}>
          Copy it now — it is shown only once and stored as a hash. Rotate it if it leaks.
        </Alert>
        <Typography variant="body2" sx={{ mb: 1 }}>
          Save as <code>agent.config.json</code> on the host, then start the agent:
        </Typography>
        <Box
          component="pre"
          sx={{ p: 1.5, bgcolor: 'action.hover', borderRadius: 1, fontSize: 12, overflow: 'auto' }}
          data-testid="agent-config"
        >
          {config}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button
          startIcon={<ContentCopyIcon />}
          onClick={() =>
            navigator.clipboard.writeText(config).then(
              () => toast.success('Copied'),
              () => toast.error('Copy failed — select the text manually'),
            )
          }
        >
          Copy config
        </Button>
        <Button variant="contained" onClick={onClose}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function HostMenu({ host, onToken }: { host: HostDto; onToken: (t: HostTokenDto) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const action = useHostAction();
  const run = async (a: 'revoke' | 'rotate-token' | 'resync') => {
    setAnchor(null);
    if (
      a === 'revoke' &&
      !window.confirm(
        `Revoke ${host.name}? Its agent is disconnected immediately and its devices go offline.`,
      )
    )
      return;
    try {
      const res = await action.mutateAsync({ id: host.id, action: a });
      if (a === 'rotate-token') onToken(res as HostTokenDto);
      else toast.success(a === 'resync' ? 'Re-sync requested' : 'Host revoked');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <>
      <IconButton
        size="small"
        onClick={(e) => setAnchor(e.currentTarget)}
        aria-label={`Actions for ${host.name}`}
      >
        <MoreVertIcon fontSize="small" />
      </IconButton>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        <MenuItem disabled={host.status !== 'ONLINE'} onClick={() => void run('resync')}>
          Re-sync devices
        </MenuItem>
        <MenuItem onClick={() => void run('rotate-token')}>Rotate token</MenuItem>
        <MenuItem
          disabled={host.status === 'REVOKED'}
          onClick={() => void run('revoke')}
          sx={{ color: 'error.main' }}
        >
          Revoke
        </MenuItem>
      </Menu>
    </>
  );
}

export function HostsTab() {
  const hosts = useHosts();
  const create = useCreateHost();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [token, setToken] = useState<HostTokenDto | null>(null);

  const submit = async () => {
    const parsed = createHostSchema.safeParse({ name });
    if (!parsed.success) return setNameError(parsed.error.issues[0]?.message ?? 'Invalid name');
    try {
      setToken(await create.mutateAsync(parsed.data));
      setOpen(false);
      setName('');
      setNameError(null);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <Stack direction="row" justifyContent="flex-end" sx={{ mb: 1.5 }}>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setOpen(true)}>
          Register host
        </Button>
      </Stack>
      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Host</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>OS</TableCell>
              <TableCell>Agent</TableCell>
              <TableCell>Devices</TableCell>
              <TableCell>Last heartbeat</TableCell>
              <TableCell>IP</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {(hosts.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={8}>
                  <Typography variant="body2" color="text.secondary">
                    No hosts registered yet.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {(hosts.data ?? []).map((h) => (
              <TableRow key={h.id} hover>
                <TableCell>
                  {h.name}
                  {h.capabilities?.mock && <Chip size="small" label="mock" sx={{ ml: 1 }} />}
                </TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    color={
                      h.status === 'ONLINE'
                        ? 'success'
                        : h.status === 'REVOKED'
                          ? 'error'
                          : 'default'
                    }
                    label={h.status.toLowerCase()}
                  />
                </TableCell>
                <TableCell>{h.os}</TableCell>
                <TableCell>{h.agentVersion ?? '—'}</TableCell>
                <TableCell>{h.deviceCount}</TableCell>
                <TableCell>
                  {h.lastSeenAt ? new Date(h.lastSeenAt).toLocaleTimeString() : 'never'}
                </TableCell>
                <TableCell>{h.ip ?? '—'}</TableCell>
                <TableCell align="right">
                  <HostMenu host={h} onToken={setToken} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Register a device host</DialogTitle>
        <DialogContent>
          <TextField
            label="Host name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={!!nameError}
            helperText={nameError ?? 'e.g. qa-android-rack-01 (iOS hosts must be macOS)'}
            fullWidth
            autoFocus
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => void submit()}>
            Create token
          </Button>
        </DialogActions>
      </Dialog>
      <TokenDialog result={token} onClose={() => setToken(null)} />
    </>
  );
}
