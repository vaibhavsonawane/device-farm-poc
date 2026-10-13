import { type PaletteMode, alpha, createTheme, type Theme } from '@mui/material/styles';

/** Enterprise theme: deep blue primary, Inter, 8px grid, light + dark. */
export function createAppTheme(mode: PaletteMode): Theme {
  const dark = mode === 'dark';
  const primary = dark ? '#7aa7ff' : '#0b3d91';
  return createTheme({
    spacing: 8,
    palette: {
      mode,
      primary: { main: primary, contrastText: dark ? '#0b1220' : '#ffffff' },
      secondary: { main: dark ? '#5eead4' : '#0f766e' },
      success: { main: dark ? '#4ade80' : '#15803d' },
      warning: { main: dark ? '#fbbf24' : '#b45309' },
      error: { main: dark ? '#f87171' : '#b91c1c' },
      background: dark
        ? { default: '#0b1220', paper: '#111a2e' }
        : { default: '#f4f6fb', paper: '#ffffff' },
      text: dark
        ? { primary: '#e5e9f2', secondary: '#9aa6bf' }
        : { primary: '#0f172a', secondary: '#526077' },
      divider: dark ? 'rgba(148,163,184,0.16)' : 'rgba(15,23,42,0.10)',
    },
    shape: { borderRadius: 10 },
    typography: {
      fontFamily: '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      h4: { fontWeight: 700, letterSpacing: '-0.02em' },
      h5: { fontWeight: 700, letterSpacing: '-0.01em' },
      h6: { fontWeight: 600 },
      subtitle1: { fontWeight: 600 },
      button: { textTransform: 'none', fontWeight: 600 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: { fontFeatureSettings: '"cv11", "ss01"' },
        },
      },
      MuiButton: { defaultProps: { disableElevation: true } },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: ({ theme }) => ({
            backgroundImage: 'none',
            border: `1px solid ${theme.palette.divider}`,
          }),
        },
      },
      MuiAppBar: {
        defaultProps: { elevation: 0, color: 'inherit' },
        styleOverrides: {
          root: ({ theme }) => ({
            borderWidth: 0,
            borderBottomWidth: 1,
            backgroundColor: theme.palette.background.paper,
          }),
        },
      },
      MuiDrawer: { styleOverrides: { paper: { borderTop: 0, borderBottom: 0, borderLeft: 0 } } },
      MuiTableCell: { styleOverrides: { head: { fontWeight: 600 } } },
      MuiChip: { styleOverrides: { root: { fontWeight: 600 } } },
      MuiTooltip: { defaultProps: { arrow: true } },
      MuiListItemButton: {
        styleOverrides: {
          root: ({ theme }) => ({
            borderRadius: 8,
            '&.Mui-selected': {
              backgroundColor: alpha(theme.palette.primary.main, dark ? 0.18 : 0.1),
            },
          }),
        },
      },
    },
  });
}
