import PersonAddIcon from '@mui/icons-material/PersonAdd';
import {
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
} from '@mui/material';
import { Role, createUserSchema } from '@devicelab/shared-types';
import { useState } from 'react';
import { useCreateUser, useTeams, useUpdateUser, useUsers } from '../../api/hooks';
import { useAuth } from '../../stores/auth';
import { errorMessage, toast } from '../../stores/toast';

const ROLES = Object.values(Role);

function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const teams = useTeams();
  const create = useCreateUser();
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    role: 'TESTER' as Role,
    teamId: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });

  const submit = async () => {
    const parsed = createUserSchema.safeParse({ ...form, teamId: form.teamId || null });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    try {
      await create.mutateAsync(parsed.data);
      toast.success(`Created ${parsed.data.email}`);
      setForm({ name: '', email: '', password: '', role: 'TESTER', teamId: '' });
      setErrors({});
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>New user</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Name"
            value={form.name}
            onChange={set('name')}
            error={!!errors.name}
            helperText={errors.name}
          />
          <TextField
            label="Email"
            value={form.email}
            onChange={set('email')}
            error={!!errors.email}
            helperText={errors.email}
          />
          <TextField
            label="Initial password"
            type="password"
            value={form.password}
            onChange={set('password')}
            error={!!errors.password}
            helperText={errors.password ?? '10+ chars with upper, lower and a digit'}
          />
          <TextField select label="Role" value={form.role} onChange={set('role')}>
            {ROLES.map((r) => (
              <MenuItem key={r} value={r}>
                {r}
              </MenuItem>
            ))}
          </TextField>
          <TextField select label="Team" value={form.teamId} onChange={set('teamId')}>
            <MenuItem value="">No team</MenuItem>
            {(teams.data ?? []).map((t) => (
              <MenuItem key={t.id} value={t.id}>
                {t.name}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => void submit()} disabled={create.isPending}>
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function UsersTab() {
  const users = useUsers();
  const update = useUpdateUser();
  const me = useAuth((s) => s.user?.id);
  const [open, setOpen] = useState(false);

  const change = async (id: string, body: Parameters<typeof update.mutateAsync>[0]['body']) => {
    try {
      await update.mutateAsync({ id, body });
      toast.success('User updated');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <Stack direction="row" justifyContent="flex-end" sx={{ mb: 1.5 }}>
        <Button variant="contained" startIcon={<PersonAddIcon />} onClick={() => setOpen(true)}>
          New user
        </Button>
      </Stack>
      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Email</TableCell>
              <TableCell>Role</TableCell>
              <TableCell>Team</TableCell>
              <TableCell>Last login</TableCell>
              <TableCell>Active</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(users.data ?? []).map((u) => (
              <TableRow key={u.id} hover>
                <TableCell>
                  {u.name} {u.id === me && <Chip size="small" label="you" sx={{ ml: 1 }} />}
                </TableCell>
                <TableCell>{u.email}</TableCell>
                <TableCell>
                  <TextField
                    select
                    size="small"
                    value={u.role}
                    disabled={u.id === me}
                    onChange={(e) => void change(u.id, { role: e.target.value as Role })}
                    sx={{ minWidth: 120 }}
                    inputProps={{ 'aria-label': `Role for ${u.email}` }}
                  >
                    {ROLES.map((r) => (
                      <MenuItem key={r} value={r}>
                        {r}
                      </MenuItem>
                    ))}
                  </TextField>
                </TableCell>
                <TableCell>{u.teamName ?? '—'}</TableCell>
                <TableCell>
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}
                </TableCell>
                <TableCell>
                  <Switch
                    checked={u.isActive}
                    disabled={u.id === me}
                    onChange={(e) => void change(u.id, { isActive: e.target.checked })}
                    inputProps={{ 'aria-label': `Active ${u.email}` }}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <CreateUserDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
