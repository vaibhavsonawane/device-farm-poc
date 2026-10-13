import SmartToyIcon from '@mui/icons-material/SmartToy';
import { Box, Paper, Typography } from '@mui/material';
import { EmptyState } from '@devicelab/ui';

export function AutomationPage() {
  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 2 }}>
        Automation
      </Typography>
      <Paper>
        <EmptyState
          icon={<SmartToyIcon />}
          title="Appium automation arrives in Phase 3"
          description="Each host agent will run Appium 2 (UiAutomator2 + XCUITest). This page will show per-device connection details and capabilities, and CI pipelines will reserve devices through API tokens."
        />
      </Paper>
    </Box>
  );
}
