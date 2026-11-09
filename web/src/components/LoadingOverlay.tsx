import Backdrop from '@mui/material/Backdrop';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

interface LoadingOverlayProps {
  label: string;
  open: boolean;
}

export default function LoadingOverlay({ label, open }: LoadingOverlayProps) {
  return (
    <Backdrop
      open={open}
      sx={(theme) => ({
        zIndex: theme.zIndex.modal + 1,
        color: 'text.primary',
        bgcolor: 'rgba(12, 24, 35, 0.48)',
      })}
    >
      <Paper elevation={8} sx={{ minWidth: 180, px: 4, py: 3, borderRadius: 3 }}>
        <Stack sx={{ alignItems: 'center', gap: 1.5 }}>
          <CircularProgress aria-label={label} />
          <Typography role="status" aria-live="polite" variant="body2" sx={{ fontWeight: 600 }}>
            {label}
          </Typography>
        </Stack>
      </Paper>
    </Backdrop>
  );
}

/** The centred spinner pages used to hand-roll, kept in the same file as the overlay primitive. */
export function LoadingPanel({ label }: { label?: string }) {
  return (
    <Stack sx={{ alignItems: 'center', gap: 1.5, py: 6 }} role="status" aria-live="polite" aria-label={label}>
      <CircularProgress />
      {label && (
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
      )}
    </Stack>
  );
}
