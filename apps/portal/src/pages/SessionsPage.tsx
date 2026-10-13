import HistoryIcon from '@mui/icons-material/History';
import {
  Box,
  Button,
  Chip,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { Permission, type ReservationDto } from '@devicelab/shared-types';
import { EmptyState } from '@devicelab/ui';
import { useNavigate } from 'react-router-dom';
import { useActiveSessions, useRelease, useReservations } from '../api/hooks';
import { usePermission } from '../hooks/usePermission';
import { errorMessage, toast } from '../stores/toast';

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—';

function StatusLabel({ r }: { r: ReservationDto }) {
  if (r.status === 'ACTIVE') return <Chip size="small" color="warning" label="Active" />;
  return (
    <Chip
      size="small"
      variant="outlined"
      label={`${r.status.toLowerCase()}${r.releaseReason ? ` · ${r.releaseReason.toLowerCase()}` : ''}`}
    />
  );
}

export function SessionsPage() {
  const mine = useReservations('mine');
  const canAll = usePermission(Permission.RESERVATION_READ_ALL);
  const canObserve = usePermission(Permission.DEVICE_OBSERVE);
  const all = useReservations('active-all', canAll);
  const live = useActiveSessions(canObserve);
  const release = useRelease();
  const navigate = useNavigate();

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 2 }}>
        Sessions
      </Typography>

      <Typography variant="subtitle1" sx={{ mb: 1 }}>
        My reservations (last 7 days)
      </Typography>
      {mine.isLoading ? (
        <Skeleton variant="rounded" height={120} />
      ) : (mine.data ?? []).length === 0 ? (
        <Paper>
          <EmptyState
            icon={<HistoryIcon />}
            title="No reservations yet"
            description="Reserve a device from the Devices page with “Use now”."
          />
        </Paper>
      ) : (
        <TableContainer component={Paper} sx={{ mb: 3 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Device</TableCell>
                <TableCell>Started</TableCell>
                <TableCell>Ends / ended</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {(mine.data ?? []).map((r) => (
                <TableRow key={r.id} hover>
                  <TableCell>{r.deviceModel}</TableCell>
                  <TableCell>{fmt(r.startAt)}</TableCell>
                  <TableCell>{fmt(r.releasedAt ?? r.endAt)}</TableCell>
                  <TableCell>
                    <StatusLabel r={r} />
                  </TableCell>
                  <TableCell align="right">
                    {r.status === 'ACTIVE' && (
                      <Button
                        size="small"
                        variant="contained"
                        onClick={() => navigate(`/session/${r.id}`)}
                      >
                        Open
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {canAll && (
        <>
          <Typography variant="subtitle1" sx={{ mb: 1, mt: 3 }}>
            All active reservations
          </Typography>
          <TableContainer component={Paper}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Device</TableCell>
                  <TableCell>User</TableCell>
                  <TableCell>Kind</TableCell>
                  <TableCell>Ends</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(all.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5}>
                      <Typography variant="body2" color="text.secondary">
                        Nobody is holding a device right now.
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
                {(all.data ?? []).map((r) => {
                  const sessionId =
                    r.activeSessionId ?? live.data?.find((s) => s.reservationId === r.id)?.id;
                  return (
                    <TableRow key={r.id} hover>
                      <TableCell>{r.deviceModel}</TableCell>
                      <TableCell>{r.userName}</TableCell>
                      <TableCell>{r.kind.toLowerCase()}</TableCell>
                      <TableCell>{fmt(r.endAt)}</TableCell>
                      <TableCell align="right">
                        <Stack direction="row" spacing={1} justifyContent="flex-end">
                          {sessionId && canObserve && (
                            <Button size="small" onClick={() => navigate(`/observe/${sessionId}`)}>
                              Watch
                            </Button>
                          )}
                          <Button
                            size="small"
                            color="error"
                            onClick={async () => {
                              if (
                                !window.confirm(
                                  `Force-release ${r.deviceModel} held by ${r.userName}?`,
                                )
                              )
                                return;
                              try {
                                await release.mutateAsync(r.id);
                                toast.success('Released');
                              } catch (err) {
                                toast.error(errorMessage(err));
                              }
                            }}
                          >
                            Force release
                          </Button>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}
    </Box>
  );
}
