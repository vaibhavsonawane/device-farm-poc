import { Box, Typography } from '@mui/material';
import { ATTRIBUTION } from '@devicelab/shared-types';

/** The single attribution signature, rendered once in the app shell. */
export function Footer() {
  return (
    <Box component="footer" sx={{ py: 0.75, textAlign: 'center', flexShrink: 0 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ opacity: 0.8 }}
        data-testid="attribution"
      >
        {ATTRIBUTION}
      </Typography>
    </Box>
  );
}
