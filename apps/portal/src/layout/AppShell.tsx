import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import AppsIcon from '@mui/icons-material/Apps';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import DashboardIcon from '@mui/icons-material/Dashboard';
import HistoryIcon from '@mui/icons-material/History';
import LightModeIcon from '@mui/icons-material/LightMode';
import LogoutIcon from '@mui/icons-material/Logout';
import MenuIcon from '@mui/icons-material/Menu';
import NotificationsIcon from '@mui/icons-material/Notifications';
import PhoneAndroidIcon from '@mui/icons-material/PhoneAndroid';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import {
  AppBar,
  Avatar,
  Badge,
  Box,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import { Permission } from '@devicelab/shared-types';
import { Footer } from '@devicelab/ui';
import { type ReactNode, useState } from 'react';
import { Link as RouterLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useProjects, useReservations } from '../api/hooks';
import { usePermission } from '../hooks/usePermission';
import { useRealtime } from '../realtime/useRealtime';
import { disconnectSocket } from '../realtime/socket';
import { useAuth } from '../stores/auth';
import { useUi } from '../stores/ui';

const NAV_W = 232;
const NAV_W_COLLAPSED = 64;

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  show: boolean;
}

function Logo({ collapsed }: { collapsed: boolean }) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        px: collapsed ? 0 : 1,
        justifyContent: collapsed ? 'center' : 'flex-start',
      }}
    >
      <Box
        sx={{
          width: 32,
          height: 32,
          borderRadius: 2,
          bgcolor: 'primary.main',
          color: 'primary.contrastText',
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
        }}
      >
        <PhoneAndroidIcon fontSize="small" />
      </Box>
      {!collapsed && (
        <Typography variant="h6" sx={{ fontWeight: 700, letterSpacing: '-0.02em' }}>
          DeviceLab
        </Typography>
      )}
    </Box>
  );
}

export function AppShell() {
  useRealtime();
  const { navCollapsed, toggleNav, mode, toggleMode, projectId, setProject } = useUi();
  const user = useAuth((s) => s.user)!;
  const navigate = useNavigate();
  const location = useLocation();
  const projects = useProjects();
  const reservations = useReservations('mine');
  const [userMenu, setUserMenu] = useState<HTMLElement | null>(null);
  const [notifMenu, setNotifMenu] = useState<HTMLElement | null>(null);
  const canUserAdmin = usePermission(Permission.USER_ADMIN);
  const canHostAdmin = usePermission(Permission.HOST_ADMIN);
  const canAdmin = canUserAdmin || canHostAdmin;
  const canAudit = usePermission(Permission.AUDIT_READ);

  const active = (reservations.data ?? []).filter((r) => r.status === 'ACTIVE');
  const width = navCollapsed ? NAV_W_COLLAPSED : NAV_W;
  const isSession =
    location.pathname.startsWith('/session/') || location.pathname.startsWith('/observe/');

  const nav: NavItem[] = [
    { to: '/devices', label: 'Devices', icon: <PhoneAndroidIcon />, show: true },
    { to: '/sessions', label: 'Sessions', icon: <HistoryIcon />, show: true },
    { to: '/builds', label: 'Builds', icon: <AppsIcon />, show: true },
    { to: '/automation', label: 'Automation', icon: <SmartToyIcon />, show: true },
    { to: '/admin', label: 'Admin', icon: <AdminPanelSettingsIcon />, show: canAdmin || canAudit },
    { to: '/dashboard', label: 'Dashboard', icon: <DashboardIcon />, show: true },
  ];

  const logout = async () => {
    try {
      await api('/auth/logout', {
        body: { refreshToken: useAuth.getState().refreshToken ?? undefined },
      });
    } catch {
      /* best effort */
    }
    disconnectSocket();
    useAuth.getState().clear();
    navigate('/login');
  };

  return (
    <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Drawer
        variant="permanent"
        sx={{
          width,
          flexShrink: 0,
          '& .MuiDrawer-paper': {
            width,
            boxSizing: 'border-box',
            transition: 'width 150ms',
            overflowX: 'hidden',
          },
        }}
      >
        <Toolbar sx={{ px: 1.5 }}>
          <Logo collapsed={navCollapsed} />
        </Toolbar>
        <List sx={{ px: 1 }} component="nav" aria-label="Main navigation">
          {nav
            .filter((n) => n.show)
            .map((n) => {
              const selected = location.pathname.startsWith(n.to);
              const btn = (
                <ListItemButton
                  key={n.to}
                  component={RouterLink}
                  to={n.to}
                  selected={selected}
                  sx={{
                    mb: 0.5,
                    justifyContent: navCollapsed ? 'center' : 'flex-start',
                    px: navCollapsed ? 1 : 1.5,
                  }}
                >
                  <ListItemIcon
                    sx={{
                      minWidth: navCollapsed ? 0 : 36,
                      color: selected ? 'primary.main' : 'inherit',
                    }}
                  >
                    {n.icon}
                  </ListItemIcon>
                  {!navCollapsed && (
                    <ListItemText
                      primary={n.label}
                      primaryTypographyProps={{ fontWeight: selected ? 600 : 500 }}
                    />
                  )}
                </ListItemButton>
              );
              return navCollapsed ? (
                <Tooltip key={n.to} title={n.label} placement="right">
                  {btn}
                </Tooltip>
              ) : (
                btn
              );
            })}
        </List>
      </Drawer>

      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <AppBar position="static">
          <Toolbar sx={{ gap: 1 }} variant="dense">
            <IconButton edge="start" onClick={toggleNav} aria-label="Toggle navigation">
              <MenuIcon />
            </IconButton>
            <TextField
              select
              size="small"
              value={projectId ?? ''}
              onChange={(e) => setProject(e.target.value || null)}
              sx={{ minWidth: 220, ml: 1 }}
              SelectProps={{ displayEmpty: true }}
              inputProps={{ 'aria-label': 'Project' }}
            >
              <MenuItem value="">All projects</MenuItem>
              {(projects.data ?? []).map((p) => (
                <MenuItem key={p.id} value={p.id}>
                  {p.name}
                </MenuItem>
              ))}
            </TextField>
            <Box sx={{ flex: 1 }} />
            <Tooltip title={mode === 'dark' ? 'Light mode' : 'Dark mode'}>
              <IconButton onClick={toggleMode} aria-label="Toggle colour mode">
                {mode === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
              </IconButton>
            </Tooltip>
            <Tooltip title="Your active devices">
              <IconButton
                onClick={(e) => setNotifMenu(e.currentTarget)}
                aria-label="Active reservations"
              >
                <Badge badgeContent={active.length} color="warning">
                  <NotificationsIcon />
                </Badge>
              </IconButton>
            </Tooltip>
            <Menu anchorEl={notifMenu} open={Boolean(notifMenu)} onClose={() => setNotifMenu(null)}>
              {active.length === 0 && <MenuItem disabled>No active reservations</MenuItem>}
              {active.map((r) => (
                <MenuItem
                  key={r.id}
                  onClick={() => {
                    setNotifMenu(null);
                    navigate(`/session/${r.id}`);
                  }}
                >
                  <ListItemText
                    primary={r.deviceModel}
                    secondary={`until ${new Date(r.endAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                  />
                </MenuItem>
              ))}
            </Menu>
            <IconButton
              onClick={(e) => setUserMenu(e.currentTarget)}
              aria-label="User menu"
              data-testid="user-menu"
            >
              <Avatar sx={{ width: 32, height: 32, bgcolor: 'primary.main', fontSize: 14 }}>
                {user.name
                  .split(' ')
                  .map((p) => p[0])
                  .join('')
                  .slice(0, 2)
                  .toUpperCase()}
              </Avatar>
            </IconButton>
            <Menu anchorEl={userMenu} open={Boolean(userMenu)} onClose={() => setUserMenu(null)}>
              <Box sx={{ px: 2, py: 1 }}>
                <Typography variant="subtitle2">{user.name}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {user.email} · {user.role}
                </Typography>
              </Box>
              <Divider />
              <MenuItem onClick={() => void logout()}>
                <ListItemIcon>
                  <LogoutIcon fontSize="small" />
                </ListItemIcon>
                Sign out
              </MenuItem>
            </Menu>
          </Toolbar>
        </AppBar>
        <Box
          component="main"
          sx={{
            flex: 1,
            minHeight: 0,
            overflow: isSession ? 'hidden' : 'auto',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              p: isSession ? 1.5 : 3,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <Outlet />
          </Box>
          <Footer />
        </Box>
      </Box>
    </Box>
  );
}
