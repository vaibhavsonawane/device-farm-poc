import { Chip, type ChipProps } from '@mui/material';
import type { DeviceStatus } from '@devicelab/shared-types';

const MAP: Record<DeviceStatus, { label: string; color: ChipProps['color'] }> = {
  AVAILABLE: { label: 'Available', color: 'success' },
  IN_USE: { label: 'In use', color: 'warning' },
  OFFLINE: { label: 'Offline', color: 'default' },
  MAINTENANCE: { label: 'Maintenance', color: 'error' },
};

export function StatusChip({
  status,
  automation,
  size = 'small',
}: {
  status: DeviceStatus;
  automation?: boolean;
  size?: ChipProps['size'];
}) {
  const m = MAP[status];
  return (
    <Chip
      size={size}
      color={m.color}
      variant={status === 'OFFLINE' ? 'outlined' : 'filled'}
      label={automation && status === 'IN_USE' ? 'In use (automation)' : m.label}
      data-testid="device-status"
    />
  );
}
