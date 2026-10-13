import { Box, Paper, Tab, Tabs, Typography } from '@mui/material';
import { Permission } from '@devicelab/shared-types';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { usePermission } from '../../hooks/usePermission';
import { AuditTab } from './AuditTab';
import { HostsTab } from './HostsTab';
import { UsersTab } from './UsersTab';

export function AdminPage() {
  const canUsers = usePermission(Permission.USER_ADMIN);
  const canHosts = usePermission(Permission.HOST_ADMIN);
  const canAudit = usePermission(Permission.AUDIT_READ);
  const location = useLocation();
  const navigate = useNavigate();
  const tabs = [
    canUsers && { path: 'users', label: 'Users' },
    canHosts && { path: 'hosts', label: 'Hosts' },
    canAudit && { path: 'audit', label: 'Audit log' },
  ].filter(Boolean) as { path: string; label: string }[];
  const current = tabs.findIndex((t) => location.pathname.endsWith(`/${t.path}`));

  if (!tabs.length) return <Navigate to="/devices" replace />;
  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 2 }}>
        Administration
      </Typography>
      <Paper sx={{ mb: 2 }}>
        <Tabs
          value={current === -1 ? 0 : current}
          onChange={(_e, i: number) => navigate(`/admin/${tabs[i]!.path}`)}
          sx={{ px: 1 }}
        >
          {tabs.map((t) => (
            <Tab key={t.path} label={t.label} />
          ))}
        </Tabs>
      </Paper>
      <Routes>
        <Route index element={<Navigate to={tabs[0]!.path} replace />} />
        {canUsers && <Route path="users" element={<UsersTab />} />}
        {canHosts && <Route path="hosts" element={<HostsTab />} />}
        {canAudit && <Route path="audit" element={<AuditTab />} />}
        <Route path="*" element={<Navigate to={tabs[0]!.path} replace />} />
      </Routes>
    </Box>
  );
}
