import MoreVertIcon from '@mui/icons-material/MoreVert';
import { Button, IconButton, ListItemText, Menu, MenuItem } from '@mui/material';
import { type DeviceDto, Permission } from '@devicelab/shared-types';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useDeviceCommand, useRelease, useReserve } from '../api/hooks';
import { usePermission } from '../hooks/usePermission';
import { useAuth } from '../stores/auth';
import { errorMessage, toast } from '../stores/toast';

/** Primary action for a device card/row: Use now · Open session · Watch. */
export function DevicePrimaryAction({
  device,
  size = 'small',
}: {
  device: DeviceDto;
  size?: 'small' | 'medium';
}) {
  const userId = useAuth((s) => s.user?.id);
  const canUse = usePermission(Permission.DEVICE_USE);
  const canObserve = usePermission(Permission.DEVICE_OBSERVE);
  const reserve = useReserve();
  const navigate = useNavigate();
  const mine = device.currentReservation?.userId === userId;

  if (mine && device.currentReservation) {
    return (
      <Button
        size={size}
        variant="contained"
        color="warning"
        onClick={() => navigate(`/session/${device.currentReservation!.id}`)}
      >
        Open session
      </Button>
    );
  }
  if (device.status === 'IN_USE' && canObserve && device.currentReservation) {
    return (
      <Button
        size={size}
        variant="outlined"
        onClick={async () => {
          try {
            const r = await api<{ activeSessionId: string | null }>(
              `/reservations/${device.currentReservation!.id}`,
            );
            if (!r.activeSessionId) toast.info('No live session to watch right now.');
            else navigate(`/observe/${r.activeSessionId}`);
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      >
        Watch
      </Button>
    );
  }
  return (
    <Button
      size={size}
      variant="contained"
      disabled={!canUse || device.status !== 'AVAILABLE' || reserve.isPending}
      data-testid={`use-${device.udid}`}
      onClick={async () => {
        try {
          const r = await reserve.mutateAsync({ deviceId: device.id });
          navigate(`/session/${r.id}`);
        } catch (err) {
          toast.error(errorMessage(err));
        }
      }}
    >
      Use now
    </Button>
  );
}

/** Kebab menu with admin / lead actions. */
export function DeviceAdminMenu({
  device,
  onEdit,
}: {
  device: DeviceDto;
  onEdit: (d: DeviceDto) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const isAdmin = usePermission(Permission.DEVICE_ADMIN);
  const canForce = usePermission(Permission.RESERVATION_FORCE_RELEASE);
  const cmd = useDeviceCommand();
  const release = useRelease();
  if (!isAdmin && !canForce) return null;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setAnchor(null);
    try {
      await fn();
      toast.success(ok);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <IconButton
        size="small"
        onClick={(e) => setAnchor(e.currentTarget)}
        aria-label={`Actions for ${device.model}`}
      >
        <MoreVertIcon fontSize="small" />
      </IconButton>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        {isAdmin && (
          <MenuItem
            onClick={() => {
              setAnchor(null);
              onEdit(device);
            }}
          >
            <ListItemText
              primary="Edit details"
              secondary="Name, tags, project, SIM, maintenance"
            />
          </MenuItem>
        )}
        {canForce && device.currentReservation && (
          <MenuItem
            onClick={() =>
              void run(
                () => release.mutateAsync(device.currentReservation!.id),
                'Device force-released',
              )
            }
          >
            <ListItemText
              primary="Force release"
              secondary={`Held by ${device.currentReservation.userName}`}
            />
          </MenuItem>
        )}
        {isAdmin && (
          <MenuItem
            disabled={device.status === 'OFFLINE'}
            onClick={() =>
              void run(
                () => cmd.mutateAsync({ id: device.id, action: 'reboot' }),
                'Reboot requested',
              )
            }
          >
            Reboot device
          </MenuItem>
        )}
        {isAdmin && (
          <MenuItem
            disabled={Boolean(device.currentReservation)}
            onClick={() => {
              if (
                window.confirm(
                  `Remove ${device.model} from the inventory? It reappears if the agent reports it again.`,
                )
              ) {
                void run(
                  () => cmd.mutateAsync({ id: device.id, action: 'remove' }),
                  'Device removed',
                );
              } else setAnchor(null);
            }}
            sx={{ color: 'error.main' }}
          >
            Remove from inventory
          </MenuItem>
        )}
      </Menu>
    </>
  );
}
