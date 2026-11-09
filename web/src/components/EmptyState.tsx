import TableCell from '@mui/material/TableCell';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';

interface EmptyStateProps {
  colSpan: number;
  message: string;
}

/** One place for the "no records" row so every list reads the same. */
export default function EmptyState({ colSpan, message }: EmptyStateProps) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} align="center" sx={{ py: 5 }}>
        <Typography variant="body2" color="text.secondary">
          {message}
        </Typography>
      </TableCell>
    </TableRow>
  );
}
