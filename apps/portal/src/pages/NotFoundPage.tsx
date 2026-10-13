import { Button } from '@mui/material';
import { EmptyState } from '@devicelab/ui';
import { useNavigate } from 'react-router-dom';

export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <EmptyState
      title="Page not found"
      description="The page you opened does not exist or you no longer have access to it."
      action={
        <Button variant="contained" onClick={() => navigate('/devices')}>
          Go to devices
        </Button>
      }
    />
  );
}
