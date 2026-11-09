import Box from '@mui/material/Box';
import Skeleton from '@mui/material/Skeleton';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';

interface TableSkeletonProps {
  columns: number;
  rows?: number;
  /** Passed by the page so the region is announced while the real rows are still arriving. */
  label?: string;
}

const range = (length: number): number[] => {
  const out: number[] = [];
  for (let index = 0; index < length; index++) out.push(index);
  return out;
};

/** Uneven widths keep the placeholder from reading as a grid of identical bars. */
const widthAt = (row: number, column: number) => `${55 + ((row * 13 + column * 29) % 42)}%`;

export default function TableSkeleton({ columns, rows = 6, label }: TableSkeletonProps) {
  return (
    <Box role="status" aria-label={label}>
      <Table size="small">
        <TableHead>
          <TableRow>
            {range(columns).map((column) => (
              <TableCell key={column}>
                <Skeleton variant="text" width={widthAt(0, column)} />
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {range(rows).map((row) => (
            <TableRow key={row}>
              {range(columns).map((column) => (
                <TableCell key={column}>
                  <Skeleton variant="text" width={widthAt(row + 1, column)} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}
