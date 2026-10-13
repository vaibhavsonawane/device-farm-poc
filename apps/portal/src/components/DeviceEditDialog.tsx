import {
  Autocomplete,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
} from '@mui/material';
import type { DeviceDto } from '@devicelab/shared-types';
import { useEffect, useState } from 'react';
import { useProjects, useUpdateDevice } from '../api/hooks';
import { errorMessage, toast } from '../stores/toast';

export function DeviceEditDialog({
  device,
  onClose,
}: {
  device: DeviceDto | null;
  onClose: () => void;
}) {
  const projects = useProjects();
  const update = useUpdateDevice();
  const [name, setName] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [projectId, setProjectId] = useState('');
  const [simNumber, setSimNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [maintenance, setMaintenance] = useState(false);

  useEffect(() => {
    if (!device) return;
    setName(device.name ?? '');
    setTags(device.tags);
    setProjectId(device.projectId ?? '');
    setSimNumber(device.simNumber ?? '');
    setNotes(device.notes ?? '');
    setMaintenance(device.status === 'MAINTENANCE');
  }, [device]);

  const save = async () => {
    if (!device) return;
    try {
      await update.mutateAsync({
        id: device.id,
        body: {
          name: name.trim() || null,
          tags,
          projectId: projectId || null,
          simNumber: simNumber.trim() || null,
          notes: notes.trim() || null,
          maintenance,
        },
      });
      toast.success('Device updated');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Dialog open={Boolean(device)} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Edit {device?.model}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Display name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={device?.model}
          />
          <Autocomplete
            multiple
            freeSolo
            options={['test-sim', 'rooted', 'low-end', 'tablet', 'biometric', 'nfc']}
            value={tags}
            onChange={(_e, v) => setTags(v.map((t) => t.trim()).filter(Boolean))}
            renderTags={(value, getTagProps) =>
              value.map((t, i) => (
                <Chip size="small" label={t} {...getTagProps({ index: i })} key={t} />
              ))
            }
            renderInput={(params) => (
              <TextField
                {...params}
                label="Tags"
                helperText="Press Enter to add. Tag 'test-sim' devices used for OTP flows."
              />
            )}
          />
          <TextField
            select
            label="Project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <MenuItem value="">Unassigned (visible to everyone)</MenuItem>
            {(projects.data ?? []).map((p) => (
              <MenuItem key={p.id} value={p.id}>
                {p.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Test SIM number"
            value={simNumber}
            onChange={(e) => setSimNumber(e.target.value)}
            placeholder="+91 9xxxx xxxxx"
          />
          <TextField
            label="Notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            multiline
            minRows={2}
          />
          <FormControlLabel
            control={
              <Switch checked={maintenance} onChange={(e) => setMaintenance(e.target.checked)} />
            }
            label="Maintenance mode (hidden from reservations)"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => void save()} disabled={update.isPending}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
