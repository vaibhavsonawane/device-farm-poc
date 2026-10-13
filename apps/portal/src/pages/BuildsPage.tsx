import AppsIcon from '@mui/icons-material/Apps';
import DownloadIcon from '@mui/icons-material/Download';
import UploadIcon from '@mui/icons-material/Upload';
import {
  Alert,
  Box,
  Button,
  IconButton,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { type BuildDto, Permission } from '@devicelab/shared-types';
import { EmptyState, PlatformIcon } from '@devicelab/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { downloadFile, uploadWithProgress } from '../api/client';
import { qk, useBuilds, useProjects } from '../api/hooks';
import { usePermission } from '../hooks/usePermission';
import { errorMessage, toast, useToasts } from '../stores/toast';
import { useUi } from '../stores/ui';

const size = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(0)} KB`);

export function BuildsPage() {
  const builds = useBuilds();
  const projects = useProjects();
  const canUpload = usePermission(Permission.BUILD_UPLOAD);
  const projectId = useUi((s) => s.projectId);
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const projectName = (id: string | null) => projects.data?.find((p) => p.id === id)?.name ?? '—';
  const rows = (builds.data ?? []).filter((b) => !projectId || b.projectId === projectId);

  const upload = async (file: File) => {
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
        message: `Uploaded ${b.fileName}`,
        severity: 'success',
        progress: undefined,
        autoHideMs: 4000,
      });
      void qc.invalidateQueries({ queryKey: qk.builds });
    } catch (err) {
      update(id, {
        message: errorMessage(err),
        severity: 'error',
        progress: undefined,
        autoHideMs: 7000,
      });
    }
  };

  return (
    <Box>
      <Stack direction="row" alignItems="flex-end" sx={{ mb: 2 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5">Build library</Typography>
          <Typography variant="body2" color="text.secondary">
            APK / IPA uploads with SHA-256 checksums. Install them from a live session’s Apps tab.
          </Typography>
        </Box>
        {canUpload && (
          <>
            <Button
              variant="contained"
              startIcon={<UploadIcon />}
              onClick={() => fileRef.current?.click()}
            >
              Upload build
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".apk,.ipa"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                e.target.value = '';
              }}
            />
          </>
        )}
      </Stack>
      <Alert severity="info" sx={{ mb: 2 }}>
        Phase 3 adds automatic metadata parsing (package id, version, min SDK, icon), multi-device
        install and retention policies.
      </Alert>
      {builds.isLoading ? (
        <Skeleton variant="rounded" height={160} />
      ) : rows.length === 0 ? (
        <Paper>
          <EmptyState
            icon={<AppsIcon />}
            title="No builds yet"
            description="Upload a UAT build (FLAG_SECURE disabled) to install it on lab devices."
          />
        </Paper>
      ) : (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>File</TableCell>
                <TableCell>Project</TableCell>
                <TableCell>Size</TableCell>
                <TableCell>SHA-256</TableCell>
                <TableCell>Uploaded</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((b) => (
                <TableRow key={b.id} hover>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <PlatformIcon platform={b.platform} fontSize="small" />
                      <span>{b.fileName}</span>
                    </Stack>
                  </TableCell>
                  <TableCell>{projectName(b.projectId)}</TableCell>
                  <TableCell>{size(b.sizeBytes)}</TableCell>
                  <TableCell>
                    <Tooltip title={b.checksumSha256}>
                      <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                        {b.checksumSha256.slice(0, 16)}…
                      </Typography>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    {new Date(b.uploadedAt).toLocaleString([], {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}{' '}
                    · {b.uploadedByName}
                  </TableCell>
                  <TableCell align="right">
                    <IconButton
                      size="small"
                      aria-label={`Download ${b.fileName}`}
                      onClick={() =>
                        downloadFile(`/builds/${b.id}/download`, b.fileName).catch((e: unknown) =>
                          toast.error(errorMessage(e)),
                        )
                      }
                    >
                      <DownloadIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}
