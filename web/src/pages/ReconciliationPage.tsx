import EmptyState from '../components/EmptyState';
import TableSkeleton from '../components/TableSkeleton';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, unwrap } from '../api/client';
import { COMPONENT_ORDER, formatLak, type ComponentAmounts } from '../api/types';
import PageHeader from '../components/PageHeader';
import CustomPagination from '../components/CustomPagination';

interface ReconciliationRecord {
  id: string;
  loanId: string | null;
  status: 'MATCHED' | 'MISMATCHED';
  operationalOutstanding: ComponentAmounts;
  computedFromHistory: ComponentAmounts;
  difference: ComponentAmounts;
  runBy: string;
  createdAt: string;
}

interface ReconciliationRun {
  total: number;
  matched: number;
  mismatched: number;
  records: ReconciliationRecord[];
}

interface ReconciliationPageData {
  data: ReconciliationRecord[];
  pagination: { total: number };
}

const INITIAL_ROWS_PER_PAGE = 10;

export default function ReconciliationPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [loanId, setLoanId] = useState('');
  const [result, setResult] = useState<ReconciliationRun | null>(null);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(INITIAL_ROWS_PER_PAGE);
  const recordsQuery = useQuery({
    queryKey: ['reconciliation', 'records', page, rowsPerPage],
    queryFn: () => api.get<ReconciliationPageData>('/reconciliation/records', {
      params: { page: page + 1, limit: rowsPerPage },
    }).then((r) => r.data),
  });
  const runMutation = useMutation({
    mutationFn: () =>
      api.post('/reconciliation/run', undefined, { params: loanId ? { loanId } : undefined }).then(unwrap<ReconciliationRun>),
    onSuccess: async (run) => {
      setResult(run);
      setPage(0);
      await queryClient.invalidateQueries({ queryKey: ['reconciliation'] });
    },
  });

  return (
    <Stack spacing={2}>
      <PageHeader title="Reconciliation" />
      <Alert severity="warning">{t('reconciliation.info')}</Alert>
      <Card>
        <CardContent>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { sm: 'center' } }}>
            <TextField
              size="small"
              label={t('reconciliation.loanOptional')}
              value={loanId}
              onChange={(event) => setLoanId(event.target.value)}
              sx={{ minWidth: 320 }}
            />
            <Button variant="contained" disabled={runMutation.isPending} onClick={() => runMutation.mutate()}>
              {runMutation.isPending ? t('reconciliation.running') : t('reconciliation.run')}
            </Button>
          </Stack>
          {runMutation.isError && <Alert sx={{ mt: 2 }} severity="error">{(runMutation.error as Error).message}</Alert>}
          {result && (
            <Typography sx={{ mt: 2 }}>
              {t('reconciliation.result', {
                total: result.total,
                matched: result.matched,
                mismatched: result.mismatched,
              })}
            </Typography>
          )}
        </CardContent>
      </Card>
      {recordsQuery.isError && <Alert severity="error">{(recordsQuery.error as Error).message}</Alert>}
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>{t('reconciliation.recent')}</Typography>
          {recordsQuery.isLoading ? <TableSkeleton columns={6} label={t('common.loading')} /> : (
            <Table size="small">
              <TableHead><TableRow><TableCell>{t('reconciliation.runDate')}</TableCell><TableCell>{t('common.loan')}</TableCell><TableCell>{t('common.status')}</TableCell><TableCell>{t('reconciliation.operationalTotal')}</TableCell><TableCell>{t('reconciliation.historyTotal')}</TableCell><TableCell>{t('reconciliation.difference')}</TableCell></TableRow></TableHead>
              <TableBody>
                {(recordsQuery.data?.data ?? []).map((record) => (
                  <TableRow key={record.id} hover>
                    <TableCell>{new Date(record.createdAt).toLocaleString(i18n.resolvedLanguage?.startsWith('lo') ? 'lo-LA' : 'en-GB')}</TableCell>
                    <TableCell>{record.loanId ?? '—'}</TableCell>
                    <TableCell>
                      <Typography sx={{ color: record.status === 'MISMATCHED' ? 'error.main' : 'success.main', fontWeight: 700 }}>
                        {t(`status.${record.status}`)}
                      </Typography>
                    </TableCell>
                    <TableCell>{formatLak(COMPONENT_ORDER.reduce((sum, item) => sum + Number(record.operationalOutstanding[item]), 0))}</TableCell>
                    <TableCell>{formatLak(COMPONENT_ORDER.reduce((sum, item) => sum + Number(record.computedFromHistory[item]), 0))}</TableCell>
                    <TableCell>
                      {COMPONENT_ORDER.map((component) => `${t(`loanDetail.${component === 'PENALTY' ? 'penalty' : component === 'PAST_INTEREST' ? 'interest' : 'principal'}`)}: ${formatLak(record.difference[component])}`).join(' · ')}
                    </TableCell>
                  </TableRow>
                ))}
                {recordsQuery.data?.data.length === 0 && <EmptyState colSpan={6} message={t('reconciliation.noRuns')} />}
              </TableBody>
            </Table>
          )}
          <CustomPagination
            page={page}
            rowsPerPage={rowsPerPage}
            totalItems={recordsQuery.data?.pagination.total ?? 0}
            onPageChange={setPage}
            onRowsPerPageChange={(value) => {
              setRowsPerPage(value);
              setPage(0);
            }}
          />
        </CardContent>
      </Card>
    </Stack>
  );
}
