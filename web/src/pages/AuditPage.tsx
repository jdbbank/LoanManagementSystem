import EmptyState from '../components/EmptyState';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import DownloadIcon from '@mui/icons-material/Download';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { api } from '../api/client';
import { formatLak, type AuditLog } from '../api/types';
import PageHeader from '../components/PageHeader';
import CustomPagination from '../components/CustomPagination';
import { downloadCsv, toCsv } from '../utils/csv';

const INITIAL_ROWS_PER_PAGE = 10;

interface AuditResponse {
  total: number;
  logs: AuditLog[];
}

export default function AuditPage() {
  const { t } = useTranslation();
  const [filters, setFilters] = useState({ loanId: '', transactionId: '', customerId: '', action: '' });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(INITIAL_ROWS_PER_PAGE);
  const auditQuery = useQuery({
    queryKey: ['audit', appliedFilters, page, rowsPerPage],
    queryFn: () =>
      api.get<AuditResponse>('/audit', {
        params: {
          ...Object.fromEntries(Object.entries(appliedFilters).filter(([, value]) => value.trim())),
          limit: rowsPerPage,
          offset: page * rowsPerPage,
        },
      }).then((response) => response.data),
  });

  const setFilter = (name: keyof typeof filters, value: string) => {
    setFilters((current) => ({ ...current, [name]: value }));
  };

  const exportCsv = () => {
    const headers = [
      t('common.date'),
      t('audit.actionContains'),
      t('audit.actor'),
      t('audit.transactionId'),
      t('audit.loanId'),
      t('audit.statusTransition'),
      t('common.amount'),
      t('common.currency'),
      t('common.reason'),
    ];
    const body = (auditQuery.data?.logs ?? []).map((log) => [
      new Date(log.createdAt).toISOString(),
      log.action,
      log.actor?.fullName ?? log.userId ?? t('audit.system'),
      log.transactionId ?? '',
      log.loanId ?? '',
      log.previousStatus || log.newStatus ? `${log.previousStatus ?? ''} -> ${log.newStatus ?? ''}` : '',
      log.amount ?? '',
      log.currency ?? '',
      log.reason ?? '',
    ]);
    downloadCsv(`audit-page-${page + 1}.csv`, toCsv(headers, body));
  };

  return (
    <Stack spacing={2}>
      <PageHeader
        title="Audit Trail"
        actions={
          <Button
            disabled={(auditQuery.data?.logs.length ?? 0) === 0}
            onClick={exportCsv}
            size="small"
            startIcon={<DownloadIcon />}
            variant="outlined"
          >
            {t('common.exportCsv')}
          </Button>
        }
      />
      <Card>
        <CardContent>
          <Stack spacing={2}>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
              <TextField size="small" label={t('audit.loanId')} value={filters.loanId} onChange={(event) => setFilter('loanId', event.target.value)} />
              <TextField size="small" label={t('audit.transactionId')} value={filters.transactionId} onChange={(event) => setFilter('transactionId', event.target.value)} />
              <TextField size="small" label={t('audit.customerId')} value={filters.customerId} onChange={(event) => setFilter('customerId', event.target.value)} />
              <TextField size="small" label={t('audit.actionContains')} value={filters.action} onChange={(event) => setFilter('action', event.target.value)} />
              <Button variant="contained" onClick={() => { setAppliedFilters(filters); setPage(0); }}>{t('common.search')}</Button>
            </Stack>
            {auditQuery.isError && <Alert severity="error">{(auditQuery.error as Error).message}</Alert>}
            <Typography variant="body2" color="text.secondary">
              {auditQuery.data
                ? t('audit.matching', { count: auditQuery.data.total })
                : t('common.loading')}
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('common.date')}</TableCell>
                  <TableCell>{t('audit.actionContains')}</TableCell>
                  <TableCell>{t('audit.actor')}</TableCell>
                  <TableCell>{t('audit.transactionLoan')}</TableCell>
                  <TableCell>{t('audit.statusTransition')}</TableCell>
                  <TableCell>{t('common.amount')}</TableCell>
                  <TableCell>{t('common.reason')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(auditQuery.data?.logs ?? []).map((log) => (
                  <TableRow key={log.id} hover>
                    <TableCell>{new Date(log.createdAt).toLocaleString()}</TableCell>
                    <TableCell>{log.action}</TableCell>
                    <TableCell>{log.actor?.fullName ?? log.userId ?? (t('audit.system'))}</TableCell>
                    <TableCell>
                      {log.transactionId ?? '—'}
                      <Typography variant="caption" sx={{ display: 'block' }} color="text.secondary">{log.loanId ?? '—'}</Typography>
                    </TableCell>
                    <TableCell>{log.previousStatus || log.newStatus ? `${log.previousStatus ?? '—'} → ${log.newStatus ?? '—'}` : '—'}</TableCell>
                    <TableCell>{log.amount === null ? '—' : formatLak(log.amount, log.currency ?? 'LAK')}</TableCell>
                    <TableCell>{log.reason ?? '—'}</TableCell>
                  </TableRow>
                ))}
                {auditQuery.data?.logs.length === 0 && <EmptyState colSpan={7} message={t('audit.none')} />}
              </TableBody>
            </Table>
            <CustomPagination
              page={page}
              rowsPerPage={rowsPerPage}
              totalItems={auditQuery.data?.total ?? 0}
              onPageChange={setPage}
              onRowsPerPageChange={(value) => {
                setRowsPerPage(value);
                setPage(0);
              }}
            />
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
