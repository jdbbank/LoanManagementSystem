import Box from '@mui/material/Box';
import TablePagination from '@mui/material/TablePagination';
import { useTranslation } from 'react-i18next';

type CustomPaginationProps = {
  page: number;
  rowsPerPage: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onRowsPerPageChange: (rowsPerPage: number) => void;
  rowsPerPageOptions?: number[];
};

export default function CustomPagination({
  page,
  rowsPerPage,
  totalItems,
  onPageChange,
  onRowsPerPageChange,
  rowsPerPageOptions = [10, 12, 25, 50],
}: CustomPaginationProps) {
  const { t } = useTranslation();

  if (totalItems <= 0) return null;

  return (
    <Box sx={{ borderTop: 1, borderColor: 'divider' }}>
      <TablePagination
        component="div"
        count={totalItems}
        page={page}
        rowsPerPage={rowsPerPage}
        rowsPerPageOptions={rowsPerPageOptions}
        onPageChange={(_, nextPage) => onPageChange(nextPage)}
        onRowsPerPageChange={(event) => onRowsPerPageChange(Number(event.target.value))}
        labelRowsPerPage={t('pagination.rowsPerPage')}
        labelDisplayedRows={({ from, to, count }) =>
          t('pagination.displayedRows', {
            from,
            to,
            itemCount: count === -1 ? t('pagination.moreThan', { to }) : count,
          })
        }
      />
    </Box>
  );
}
