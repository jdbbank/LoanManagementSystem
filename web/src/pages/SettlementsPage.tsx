import AddIcon from '@mui/icons-material/Add';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import {
  LoanStatus,
  SettlementStatus,
  formatLak,
  type Loan,
  type SettlementAgreement,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { canCreate } from '../auth/roles';
import PageHeader from '../components/PageHeader';
import StatusChip from '../components/StatusChip';
import CustomPagination from '../components/CustomPagination';
import MoneyTextField from '../components/MoneyTextField';

interface AgreementResponse {
  data: SettlementAgreement[];
  pagination: { total: number };
}

interface LoanResponse {
  data: Loan[];
}

type Action = 'CREATE' | 'PAY' | 'WAIVE';
const INITIAL_ROWS_PER_PAGE = 10;

export default function SettlementsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [action, setAction] = useState<Action | null>(null);
  const [selected, setSelected] = useState<SettlementAgreement | null>(null);
  const [loanId, setLoanId] = useState('');
  const [agreedAmount, setAgreedAmount] = useState('');
  const [cashAmount, setCashAmount] = useState('');
  const [creditToApply, setCreditToApply] = useState('0');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(INITIAL_ROWS_PER_PAGE);

  const agreementsQuery = useQuery({
    queryKey: ['settlements', page, rowsPerPage],
    queryFn: () => api.get<AgreementResponse>('/settlements', {
      params: { page: page + 1, limit: rowsPerPage },
    }).then((r) => r.data),
  });
  const loansQuery = useQuery({
    queryKey: ['loans', 'settlement-form'],
    queryFn: () =>
      api.get<LoanResponse>('/loans', { params: { status: LoanStatus.ACTIVE, limit: 100 } }).then((r) => r.data),
    enabled: action === 'CREATE',
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['settlements'] }),
      queryClient.invalidateQueries({ queryKey: ['payment-requests'] }),
      queryClient.invalidateQueries({ queryKey: ['transactions'] }),
      queryClient.invalidateQueries({ queryKey: ['approvals'] }),
      queryClient.invalidateQueries({ queryKey: ['loans'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    ]);
  };

  const mutation = useMutation({
    mutationFn: async (): Promise<void> => {
      if (!action) throw new Error('Choose a settlement action');
      if (action === 'CREATE') {
        if (!loanId) throw new Error('Select a loan');
        await api.post('/settlements', {
          loanId,
          agreedAmount: Number(agreedAmount),
          reason,
        });
        return;
      }
      if (!selected) throw new Error('Select a settlement agreement');
      if (action === 'PAY') {
        await api.post(`/settlements/${selected.id}/settlement-payment`, {
          cashAmount: Number(cashAmount),
          creditToApply: Number(creditToApply),
          note: reason || undefined,
        });
        return;
      }
      await api.post(`/settlements/${selected.id}/waive-shortfall`, { reason });
    },
    onSuccess: async () => {
      await refresh();
      setAction(null);
      setSelected(null);
      setError(null);
      setPage(0);
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const openAction = (next: Action, agreement?: SettlementAgreement) => {
    setAction(next);
    setSelected(agreement ?? null);
    setLoanId('');
    setAgreedAmount('');
    setCashAmount('');
    setCreditToApply('0');
    setReason('');
    setError(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate();
  };

  return (
    <Stack spacing={2}>
      <PageHeader
        title="Settlement Agreements"
        actions={canCreate(user?.role) ? (
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => openAction('CREATE')}>
            {t('settlements.new')}
          </Button>
        ) : null}
      />
      <Alert severity="info">
        {t('settlements.info')}
      </Alert>
      {agreementsQuery.isError && <Alert severity="error">{(agreementsQuery.error as Error).message}</Alert>}
      <Card>
        <CardContent>
          {agreementsQuery.isLoading ? (
            <Stack sx={{ alignItems: 'center', py: 4 }}><CircularProgress /></Stack>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('settlements.agreement')}</TableCell>
                  <TableCell>{t('common.loan')}</TableCell>
                  <TableCell>{t('settlements.agreedAmount')}</TableCell>
                  <TableCell>{t('common.status')}</TableCell>
                  <TableCell>{t('common.reason')}</TableCell>
                  <TableCell>{t('common.actions')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(agreementsQuery.data?.data ?? []).map((agreement) => (
                  <TableRow key={agreement.id} hover>
                    <TableCell>{agreement.agreementNo}</TableCell>
                    <TableCell>{agreement.loanId}</TableCell>
                    <TableCell>{formatLak(agreement.agreedAmount, agreement.currency)}</TableCell>
                    <TableCell><StatusChip status={agreement.status} /></TableCell>
                    <TableCell>{agreement.reason ?? '—'}</TableCell>
                    <TableCell>
                      {canCreate(user?.role) && agreement.status === SettlementStatus.APPROVED && (
                        <Stack direction="row" spacing={1}>
                          <Button size="small" onClick={() => openAction('PAY', agreement)}>{t('settlements.recordPayment')}</Button>
                          <Button size="small" onClick={() => openAction('WAIVE', agreement)}>{t('settlements.waiveShortfall')}</Button>
                        </Stack>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {agreementsQuery.data?.data.length === 0 && (
                  <TableRow><TableCell colSpan={6} align="center">{t('settlements.none')}</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          )}
          <CustomPagination
            page={page}
            rowsPerPage={rowsPerPage}
            totalItems={agreementsQuery.data?.pagination.total ?? 0}
            onPageChange={setPage}
            onRowsPerPageChange={(value) => {
              setRowsPerPage(value);
              setPage(0);
            }}
          />
        </CardContent>
      </Card>
      <Dialog open={Boolean(action)} onClose={() => setAction(null)} fullWidth maxWidth="sm">
        <form onSubmit={submit}>
          <DialogTitle>
            {action === 'CREATE' ? t('settlements.create') : action === 'PAY' ? t('settlements.payment') : t('settlements.waiver')}
          </DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              {action === 'WAIVE' && (
                <Alert severity="info">
                  {t('settlements.waiverInfo')}
                </Alert>
              )}
              {action === 'CREATE' && (
                <>
                  <TextField
                    select
                    label={t('settlements.activeLoan')}
                    value={loanId}
                    onChange={(event) => setLoanId(event.target.value)}
                    required
                  >
                    {(loansQuery.data?.data ?? []).map((loan) => (
                      <MenuItem key={loan.id} value={loan.id}>
                        {loan.loanNumber} — {loan.customer?.fullName ?? loan.customerId}
                      </MenuItem>
                    ))}
                  </TextField>
                  <MoneyTextField
                    label={t('settlements.agreedPayment')}
                    minValue={0.01}
                    value={agreedAmount}
                    onChange={setAgreedAmount}
                    required
                  />
                </>
              )}
              {action === 'PAY' && (
                <>
                  <Typography variant="body2">{selected?.agreementNo} · Agreed {formatLak(selected?.agreedAmount ?? 0)}</Typography>
                  <MoneyTextField
                    label={t('settlements.cashReceived')}
                    minValue={0}
                    value={cashAmount}
                    onChange={setCashAmount}
                    required
                  />
                  <MoneyTextField
                    label={t('settlements.creditToApply')}
                    minValue={0}
                    value={creditToApply}
                    onChange={setCreditToApply}
                  />
                </>
              )}
              <TextField
                label={action === 'CREATE' ? `${t('common.reason')} *` : action === 'WAIVE' ? t('settlements.waiverReason') : t('payments.note')}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                required={action !== 'PAY'}
                multiline
              />
              {error && <Alert severity="error">{error}</Alert>}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setAction(null)}>{t('common.cancel')}</Button>
            <Button type="submit" variant="contained" disabled={mutation.isPending}>
              {action === 'CREATE' ? t('settlements.submitAgreement') : action === 'PAY' ? t('settlements.submitPayment') : t('settlements.submitWaiver')}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Stack>
  );
}
