import DownloadIcon from '@mui/icons-material/Download';
import {
  Box,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Table,
  TableBody,
  TableCell,
  TableRow,
  Typography,
} from '@mui/material';
import type { DeviceDto } from '@devicelab/shared-types';
import { downloadFile } from '../../api/client';
import { useArtifacts, useDevice } from '../../api/hooks';
import { errorMessage, toast } from '../../stores/toast';

interface Details {
  temperatureC?: number | null;
  network?: string | null;
  storageFreeMb?: number | null;
  storageTotalMb?: number | null;
}

export function InfoPanel({ device, sessionId }: { device: DeviceDto; sessionId: string | null }) {
  const full = useDevice(device.id);
  const artifacts = useArtifacts(sessionId ?? undefined);
  const d = (full.data?.details ?? {}) as Details;
  const rows: [string, string][] = [
    ['Model', `${device.manufacturer} ${device.model}`],
    ['OS', `${device.platform === 'ANDROID' ? 'Android' : 'iOS'} ${device.osVersion}`],
    ['Resolution', device.screenW ? `${device.screenW} × ${device.screenH}` : '—'],
    [
      'Battery',
      device.batteryLevel === null
        ? '—'
        : `${device.batteryLevel}%${d.temperatureC ? ` · ${d.temperatureC} °C` : ''}`,
    ],
    ['Network', d.network ?? '—'],
    [
      'Storage',
      d.storageTotalMb
        ? `${(d.storageFreeMb! / 1024).toFixed(1)} GB free of ${(d.storageTotalMb / 1024).toFixed(0)} GB`
        : '—',
    ],
    ['Serial / UDID', device.udid],
    ['Host', device.hostName],
    ['Project', device.projectName ?? '—'],
    ['Test SIM', device.simNumber ?? '—'],
  ];
  return (
    <Box sx={{ p: 1.5, overflow: 'auto', height: '100%' }}>
      <Table size="small">
        <TableBody>
          {rows.map(([k, v]) => (
            <TableRow key={k}>
              <TableCell sx={{ color: 'text.secondary', width: 120, borderBottom: 0, py: 0.5 }}>
                {k}
              </TableCell>
              <TableCell sx={{ borderBottom: 0, py: 0.5, wordBreak: 'break-all' }}>{v}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {device.notes && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1, px: 2 }}>
          {device.notes}
        </Typography>
      )}
      <Divider sx={{ my: 1.5 }} />
      <Typography variant="subtitle2" sx={{ px: 1 }}>
        Session artifacts
      </Typography>
      <List dense>
        {(artifacts.data ?? []).length === 0 && (
          <ListItem>
            <ListItemText secondary="Screenshots you take appear here." />
          </ListItem>
        )}
        {(artifacts.data ?? []).map((a) => (
          <ListItem
            key={a.id}
            secondaryAction={
              <IconButton
                edge="end"
                size="small"
                aria-label={`Download ${a.fileName}`}
                onClick={() =>
                  downloadFile(`/artifacts/${a.id}/download`, a.fileName).catch((e: unknown) =>
                    toast.error(errorMessage(e)),
                  )
                }
              >
                <DownloadIcon fontSize="small" />
              </IconButton>
            }
          >
            <ListItemText
              primary={a.fileName}
              secondary={`${a.type.toLowerCase()} · ${(a.sizeBytes / 1024).toFixed(0)} KB`}
              primaryTypographyProps={{ noWrap: true, fontSize: 13 }}
            />
          </ListItem>
        ))}
      </List>
    </Box>
  );
}
