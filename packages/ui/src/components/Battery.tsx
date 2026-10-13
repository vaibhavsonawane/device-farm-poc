import Battery20Icon from '@mui/icons-material/Battery20';
import Battery50Icon from '@mui/icons-material/Battery50';
import Battery80Icon from '@mui/icons-material/Battery80';
import BatteryFullIcon from '@mui/icons-material/BatteryFull';
import BatteryUnknownIcon from '@mui/icons-material/BatteryUnknown';
import { Box, Typography } from '@mui/material';

export function Battery({ level }: { level: number | null }) {
  const Icon =
    level === null
      ? BatteryUnknownIcon
      : level > 85
        ? BatteryFullIcon
        : level > 55
          ? Battery80Icon
          : level > 25
            ? Battery50Icon
            : Battery20Icon;
  const color = level === null ? 'text.disabled' : level <= 15 ? 'error.main' : 'text.secondary';
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25, color }} title="Battery">
      <Icon fontSize="small" sx={{ transform: 'rotate(90deg)' }} />
      <Typography variant="caption" sx={{ color: 'inherit', fontVariantNumeric: 'tabular-nums' }}>
        {level === null ? '—' : `${level}%`}
      </Typography>
    </Box>
  );
}
