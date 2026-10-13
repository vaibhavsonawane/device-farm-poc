import SimCardIcon from '@mui/icons-material/SimCard';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import {
  Box,
  Card,
  CardActions,
  CardContent,
  Chip,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import type { DeviceDto } from '@devicelab/shared-types';
import type { ReactNode } from 'react';
import { Battery } from './Battery';
import { PlatformIcon } from './PlatformIcon';
import { StatusChip } from './StatusChip';

export interface DeviceCardProps {
  device: DeviceDto;
  /** Primary action area (Use now / Open / Watch). */
  actions?: ReactNode;
  /** Kebab menu for admin actions. */
  menu?: ReactNode;
}

export function DeviceCard({ device: d, actions, menu }: DeviceCardProps) {
  const title = d.name ?? d.model;
  return (
    <Card
      variant="outlined"
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        opacity: d.status === 'OFFLINE' ? 0.72 : 1,
      }}
      data-testid={`device-card-${d.udid}`}
    >
      <CardContent sx={{ pb: 1, flex: 1 }}>
        <Stack direction="row" alignItems="flex-start" spacing={1.5}>
          <Box
            sx={{
              width: 44,
              height: 44,
              borderRadius: 2,
              display: 'grid',
              placeItems: 'center',
              bgcolor: 'action.hover',
              flexShrink: 0,
            }}
          >
            <PlatformIcon platform={d.platform} />
          </Box>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="subtitle1" noWrap title={title}>
              {title}
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              {d.manufacturer} · {d.platform === 'ANDROID' ? 'Android' : 'iOS'} {d.osVersion}
            </Typography>
          </Box>
          {menu}
        </Stack>

        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{ mt: 1.5 }}
          flexWrap="wrap"
          useFlexGap
        >
          <StatusChip status={d.status} automation={d.currentReservation?.kind === 'AUTOMATION'} />
          <Battery level={d.batteryLevel} />
          {d.health && d.health.level !== 'info' && (
            <Tooltip title={d.health.message}>
              <WarningAmberIcon
                fontSize="small"
                color={d.health.level === 'error' ? 'error' : 'warning'}
              />
            </Tooltip>
          )}
        </Stack>

        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }} noWrap>
          {d.hostName}
          {d.projectName ? ` · ${d.projectName}` : ''}
          {d.screenW ? ` · ${d.screenW}×${d.screenH}` : ''}
        </Typography>
        {d.currentReservation && (
          <Typography variant="caption" color="warning.main" component="div" noWrap>
            {d.currentReservation.userName} until{' '}
            {new Date(d.currentReservation.endAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Typography>
        )}
        {(d.tags.length > 0 || d.simNumber) && (
          <Stack direction="row" spacing={0.5} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
            {d.simNumber && (
              <Chip size="small" icon={<SimCardIcon />} label={d.simNumber} variant="outlined" />
            )}
            {d.tags.map((t) => (
              <Chip key={t} size="small" label={t} variant="outlined" />
            ))}
          </Stack>
        )}
      </CardContent>
      {actions && <CardActions sx={{ px: 2, pb: 2, pt: 0 }}>{actions}</CardActions>}
    </Card>
  );
}
