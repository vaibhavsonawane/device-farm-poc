import AndroidIcon from '@mui/icons-material/Android';
import AppleIcon from '@mui/icons-material/Apple';
import { type SvgIconProps } from '@mui/material';
import type { Platform } from '@devicelab/shared-types';

export function PlatformIcon({ platform, ...props }: { platform: Platform } & SvgIconProps) {
  return platform === 'ANDROID' ? (
    <AndroidIcon titleAccess="Android" sx={{ color: '#3ddc84', ...props.sx }} {...props} />
  ) : (
    <AppleIcon titleAccess="iOS" sx={{ color: 'text.primary', ...props.sx }} {...props} />
  );
}
