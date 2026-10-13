import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { formatLak, type CreditLedgerEntry, type CustomerCredit } from '../api/types';
import PageHeader from '../components/PageHeader';
import CustomPagination from '../components/CustomPagination';

interface LedgerResponse {
  ledger: CreditLedgerEntry[];
  currentBalance: number;
}

interface CreditPageData {
  data: CustomerCredit[];
  pagination: { total: number };
}

interface LedgerPageData {
  data: LedgerResponse;
  pagination: { total: number };
}

const INITIAL_ROWS_PER_PAGE = 10;

export default function CreditsPage() {
  const { t, i18n } = useTranslation();
  const [selected, setSelected] = useState<CustomerCredit | null>(null);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(INITIAL_ROWS_PER_PAGE);
  const [ledgerPage, setLedgerPage] = useState(0);
  const [ledgerRowsPerPage, setLedgerRowsPerPage] = useState(INITIAL_ROWS_PER_PAGE);
  const creditsQuery = useQuery({
    queryKey: ['credits', page, rowsPerPage],
    queryFn: () => api.get<CreditPageData>('/credits', {
      params: { page: page + 1, limit: rowsPerPage },
    }).then((r) => r.data),
  });
  const ledgerQuery = useQuery({
    queryKey: ['credits', 'ledger', selected?.customerId, ledgerPage, ledgerRowsPerPage],
    queryFn: () =>
      api.get<LedgerPageData>('/credits/ledger', {
        params: { customerId: selected?.customerId, page: ledgerPage + 1, limit: ledgerRowsPerPage },
      }).then((r) => r.data),
    enabled: Boolean(selected),
  });

  return (
    <Stack spacing={2}>
      <PageHeader title="Customer Credit" />
      <Alert severity="info">{t('credits.info')}</Alert>
      {creditsQuery.isError && <Alert severity="error">{(creditsQuery.error as Error).message}</Alert>}
      <Card>
        <CardContent>
          {creditsQuery.isLoading ? (
            <Stack sx={{ alignItems: 'center', py: 4 }}><CircularProgress /></Stack>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('common.customer')}</TableCell>
                  <TableCell>{t('credits.customerNumber')}</TableCell>
                  <TableCell>{t('credits.currency')}</TableCell>
                  <TableCell align="right">{t('credits.available')}</TableCell>
                  <TableCell>{t('credits.updated')}</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {(creditsQuery.data?.data ?? []).map((credit) => (
                  <TableRow key={credit.id} hover>
                    <TableCell>{credit.customer?.fullName ?? credit.customerId}</TableCell>
                    <TableCell>{credit.customer?.customerNumber ?? '—'}</TableCell>
                    <TableCell>{credit.currency}</TableCell>
                    <TableCell align="right">{formatLak(credit.balance, credit.currency)}</TableCell>
                    <TableCell>{new Date(credit.updatedAt).toLocaleString(i18n.resolvedLanguage?.startsWith('lo') ? 'lo-LA' : 'en-GB')}</TableCell>
                    <TableCell><Button size="small" onClick={() => { setSelected(credit); setLedgerPage(0); }}>{t('credits.ledger')}</Button></TableCell>
                  </TableRow>
                ))}
                {creditsQuery.data?.data.length === 0 && <TableRow><TableCell colSpan={6} align="center">{t('credits.noCredits')}</TableCell></TableRow>}
              </TableBody>
            </Table>
          )}
          <CustomPagination
            page={page}
            rowsPerPage={rowsPerPage}
            totalItems={creditsQuery.data?.pagination.total ?? 0}
            onPageChange={setPage}
            onRowsPerPageChange={(value) => {
              setRowsPerPage(value);
              setPage(0);
            }}
          />
        </CardContent>
      </Card>
      <Dialog open={Boolean(selected)} onClose={() => setSelected(null)} fullWidth maxWidth="md">
        <DialogTitle>{t('credits.ledgerTitle', { customer: selected?.customer?.fullName ?? selected?.customerId })}</DialogTitle>
        <DialogContent>
          {ledgerQuery.isError && <Alert severity="error">{(ledgerQuery.error as Error).message}</Alert>}
          {ledgerQuery.isLoading ? <CircularProgress /> : (
            <Stack spacing={1}>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                {t('credits.currentBalance')} {formatLak(ledgerQuery.data?.data.currentBalance ?? 0, selected?.currency)}
              </Typography>
              <Table size="small">
                <TableHead><TableRow><TableCell>{t('common.date')}</TableCell><TableCell>{t('credits.type')}</TableCell><TableCell>{t('credits.transaction')}</TableCell><TableCell align="right">{t('credits.amount')}</TableCell><TableCell align="right">{t('credits.balanceAfter')}</TableCell></TableRow></TableHead>
                <TableBody>
                  {(ledgerQuery.data?.data.ledger ?? []).map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell>{new Date(entry.createdAt).toLocaleString(i18n.resolvedLanguage?.startsWith('lo') ? 'lo-LA' : 'en-GB')}</TableCell>
                      <TableCell>{t(`status.${entry.type}`)}</TableCell>
                      <TableCell>{entry.transactionId ?? '—'}</TableCell>
                      <TableCell align="right">{formatLak(entry.amount, selected?.currency)}</TableCell>
                      <TableCell align="right">{formatLak(entry.balanceAfter, selected?.currency)}</TableCell>
                    </TableRow>
                  ))}
                  {ledgerQuery.data?.data.ledger.length === 0 && <TableRow><TableCell colSpan={5} align="center">{t('credits.noEntries')}</TableCell></TableRow>}
                </TableBody>
              </Table>
              <CustomPagination
                page={ledgerPage}
                rowsPerPage={ledgerRowsPerPage}
                totalItems={ledgerQuery.data?.pagination.total ?? 0}
                onPageChange={setLedgerPage}
                onRowsPerPageChange={(value) => {
                  setLedgerRowsPerPage(value);
                  setLedgerPage(0);
                }}
              />
            </Stack>
          )}
        </DialogContent>
        <DialogActions><Button onClick={() => { setSelected(null); setLedgerPage(0); }}>{t('common.close')}</Button></DialogActions>
      </Dialog>
    </Stack>
  );
}
