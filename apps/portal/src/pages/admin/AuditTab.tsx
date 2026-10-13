import DownloadIcon from '@mui/icons-material/Download';
import {
  Button,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import { downloadFile } from '../../api/client';
import { useAudit } from '../../api/hooks';
import { errorMessage, toast } from '../../stores/toast';

export function AuditTab() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = 25;
  const params = new URLSearchParams({ page: String(page + 1), pageSize: String(pageSize) });
  if (action.trim()) params.set('action', action.trim());
  const audit = useAudit(params.toString());

  return (
    <>
      <Stack direction="row" spacing={1.5} sx={{ mb: 1.5 }}>
        <TextField
          size="small"
          label="Action prefix"
          placeholder="e.g. reservation. or auth.login"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setPage(0);
          }}
          sx={{ width: 280 }}
        />
        <Button
          startIcon={<DownloadIcon />}
          onClick={() => {
            const q = new URLSearchParams();
            if (action.trim()) q.set('action', action.trim());
            downloadFile(`/audit/export.csv?${q.toString()}`, 'devicelab-audit.csv').catch(
              (e: unknown) => toast.error(errorMessage(e)),
            );
          }}
        >
          Export CSV
        </Button>
      </Stack>
      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>When</TableCell>
              <TableCell>User</TableCell>
              <TableCell>Action</TableCell>
              <TableCell>Entity</TableCell>
              <TableCell>Details</TableCell>
              <TableCell>IP</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(audit.data?.items ?? []).map((a) => (
              <TableRow key={a.id} hover>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>
                  {new Date(a.createdAt).toLocaleString()}
                </TableCell>
                <TableCell>{a.userName ?? '—'}</TableCell>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{a.action}</TableCell>
                <TableCell>
                  {a.entityType ? `${a.entityType} ${a.entityId?.slice(0, 8) ?? ''}` : '—'}
                </TableCell>
                <TableCell>
                  <Typography
                    variant="caption"
                    sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
                  >
                    {a.metadata ? JSON.stringify(a.metadata).slice(0, 160) : ''}
                  </Typography>
                </TableCell>
                <TableCell>{a.ip ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <TablePagination
          component="div"
          count={audit.data?.total ?? 0}
          page={page}
          rowsPerPage={pageSize}
          rowsPerPageOptions={[pageSize]}
          onPageChange={(_e, p) => setPage(p)}
        />
      </TableContainer>
    </>
  );
}
