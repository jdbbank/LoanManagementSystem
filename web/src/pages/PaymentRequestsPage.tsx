import EmptyState from '../components/EmptyState';
import TableSkeleton from '../components/TableSkeleton';
import { LoadingPanel } from '../components/LoadingOverlay';
import AddIcon from '@mui/icons-material/Add';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
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
import { api, unwrap } from '../api/client';
import {
  COMPONENT_ORDER,
  LoanStatus,
  PaymentRequestPurpose,
  PaymentRequestStatus,
  formatLak,
  type ComponentAmounts,
  type Loan,
  type PayableNow,
  type Pagination,
  type PaymentRequest,
  type PaymentRequestDetail,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { canApprove, canCreate } from '../auth/roles';
import PageHeader from '../components/PageHeader';
import StatusChip from '../components/StatusChip';
import CustomPagination from '../components/CustomPagination';
import MoneyTextField from '../components/MoneyTextField';

const INITIAL_ROWS_PER_PAGE = 10;

interface RequestPageData {
  data: PaymentRequest[];
  pagination: Pagination;
}

interface LoanPageData {
  data: Loan[];
  pagination: Pagination;
}

const emptyComponents: ComponentAmounts = {
  PENALTY: 0,
  PAST_INTEREST: 0,
  PAST_PRINCIPAL: 0,
};

type ComponentAmountInputs = Record<keyof ComponentAmounts, string>;

export default function PaymentRequestsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [loanId, setLoanId] = useState('');
  const [purpose, setPurpose] = useState<PaymentRequestPurpose>(PaymentRequestPurpose.PAY_DEBT);
  const [cashAmount, setCashAmount] = useState('');
  const [creditToApply, setCreditToApply] = useState('0');
  const [note, setNote] = useState('');
  const [activeRequest, setActiveRequest] = useState<string | null>(null);
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT' | null>(null);
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState<ComponentAmountInputs | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(INITIAL_ROWS_PER_PAGE);

  const requestsQuery = useQuery({
    queryKey: ['payment-requests', page, rowsPerPage],
    queryFn: () => api.get<RequestPageData>('/payment-requests', {
      params: { page: page + 1, limit: rowsPerPage },
    }).then((r) => r.data),
  });
  const loansQuery = useQuery({
    queryKey: ['loans', 'active-payment-form'],
    queryFn: () =>
      api
        .get<LoanPageData>('/loans', { params: { status: LoanStatus.ACTIVE, limit: 100 } })
        .then((r) => r.data),
    enabled: createOpen,
  });
  const detailQuery = useQuery({
    queryKey: ['payment-request', activeRequest],
    queryFn: () =>
      api.get(`/payment-requests/${activeRequest}`).then(unwrap<PaymentRequestDetail>),
    enabled: Boolean(activeRequest),
  });
  /** The collection ceiling for the loan picked in the dialog: only arrived instalments may be paid. */
  const payableQuery = useQuery({
    queryKey: ['loan-payable-now', loanId],
    queryFn: () => api.get(`/loans/${loanId}/payable-now`).then(unwrap<PayableNow>),
    enabled: createOpen && Boolean(loanId) && purpose === PaymentRequestPurpose.PAY_DEBT,
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['payment-requests'] }),
      queryClient.invalidateQueries({ queryKey: ['payment-request'] }),
      queryClient.invalidateQueries({ queryKey: ['loans'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: () =>
      api.post('/payment-requests', {
        loanId,
        cashAmount: Number(cashAmount),
        creditToApply: Number(creditToApply),
        purpose,
        note: note || undefined,
      }),
    onSuccess: async () => {
      await refresh();
      setCreateOpen(false);
      setLoanId('');
      setPurpose(PaymentRequestPurpose.PAY_DEBT);
      setCashAmount('');
      setCreditToApply('0');
      setNote('');
      setFormError(null);
      setPage(0);
    },
    onError: (error: Error) => setFormError(error.message),
  });

  const decisionMutation = useMutation({
    mutationFn: async (): Promise<void> => {
      if (!activeRequest || !decision) throw new Error('Select a payment request and decision first');
      const endpoint = `/payment-requests/${activeRequest}/${decision === 'APPROVE' ? 'approve' : 'reject'}`;
      if (decision === 'REJECT') {
        await api.post(endpoint, { reason });
        return;
      }

      const detail = detailQuery.data;
      if (!detail) throw new Error('Payment request details are not available');
      const proposed = { ...emptyComponents };
      for (const item of detail.allocations) proposed[item.component] = Number(item.proposedAmount);
      const changed =
        override !== null &&
        COMPONENT_ORDER.some((component) => Number(override[component]) !== proposed[component]);
      await api.post(endpoint, {
        overrideAllocation: changed
          ? {
              PENALTY: Number(override.PENALTY),
              PAST_INTEREST: Number(override.PAST_INTEREST),
              PAST_PRINCIPAL: Number(override.PAST_PRINCIPAL),
            }
          : undefined,
        reason: reason || undefined,
      });
    },
    onSuccess: async () => {
      await refresh();
      setDecision(null);
      setActiveRequest(null);
      setReason('');
      setFormError(null);
      setPage(0);
    },
    onError: (error: Error) => setFormError(error.message),
  });

  const resubmitMutation = useMutation({
    mutationFn: (id: string) => api.post(`/payment-requests/${id}/resubmit`),
    onSuccess: async () => {
      await refresh();
      setPage(0);
    },
    onError: (error: Error) => setFormError(error.message),
  });

  const openDecision = (request: PaymentRequest, nextDecision: 'APPROVE' | 'REJECT') => {
    setActiveRequest(request.id);
    setDecision(nextDecision);
    setReason('');
    setFormError(null);
    setOverride(null);
  };

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    createMutation.mutate();
  };

  const request = detailQuery.data?.request;
  const payable = payableQuery.data;
  const isDeposit = purpose === PaymentRequestPurpose.DEPOSIT_TO_CREDIT;
  const requestedTotal = Number(cashAmount || 0) + Number(creditToApply || 0);
  const overPayable = !isDeposit && payable !== undefined && requestedTotal > payable.maxPayable + 0.004;
  const proposedAllocation = { ...emptyComponents };
  for (const item of detailQuery.data?.allocations ?? []) {
    proposedAllocation[item.component] = Number(item.proposedAmount);
  }

  return (
    <Stack spacing={2}>
      <PageHeader
        title="Payment Requests"
        actions={
          canCreate(user?.role) ? (
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
              {t('payments.new')}
            </Button>
          ) : null
        }
      />
      {formError && <Alert severity="error" onClose={() => setFormError(null)}>{formError}</Alert>}
      {requestsQuery.isError && <Alert severity="error">{(requestsQuery.error as Error).message}</Alert>}
      <Card>
        <CardContent>
          {requestsQuery.isLoading ? (
            <TableSkeleton columns={8} label={t('common.loading')} />
          ) : (
            <>
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t('payments.request')}</TableCell>
                    <TableCell>{t('payments.loan')}</TableCell>
                    <TableCell>{t('payments.purpose')}</TableCell>
                    <TableCell>{t('payments.cash')}</TableCell>
                    <TableCell>{t('payments.credit')}</TableCell>
                    <TableCell>{t('payments.status')}</TableCell>
                    <TableCell>{t('payments.rejectionReason')}</TableCell>
                    <TableCell>{t('common.actions')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(requestsQuery.data?.data ?? []).map((item) => (
                    <TableRow key={item.id} hover>
                      <TableCell>{item.requestNo}</TableCell>
                      <TableCell>{item.loanId}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          variant="outlined"
                          color={item.purpose === PaymentRequestPurpose.DEPOSIT_TO_CREDIT ? 'secondary' : 'default'}
                          label={
                            item.purpose === PaymentRequestPurpose.DEPOSIT_TO_CREDIT
                              ? t('payments.purposeDeposit')
                              : t('payments.purposePayDebt')
                          }
                        />
                      </TableCell>
                      <TableCell>{formatLak(item.cashAmount, item.currency)}</TableCell>
                      <TableCell>{formatLak(item.creditApplied, item.currency)}</TableCell>
                      <TableCell><StatusChip status={item.status} /></TableCell>
                      <TableCell>{item.rejectionReason ?? '—'}</TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={1}>
                          {item.status === PaymentRequestStatus.PENDING && canApprove(user?.role) && (
                            <>
                              <Button size="small" onClick={() => openDecision(item, 'APPROVE')}>{t('payments.review')}</Button>
                              <Button size="small" color="error" onClick={() => openDecision(item, 'REJECT')}>{t('payments.reject')}</Button>
                            </>
                          )}
                          {item.status === PaymentRequestStatus.REJECTED && canCreate(user?.role) && (
                            <Button
                              size="small"
                              disabled={resubmitMutation.isPending}
                              onClick={() => resubmitMutation.mutate(item.id)}
                            >
                              {t('payments.newResubmit')}
                            </Button>
                          )}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))}
                  {requestsQuery.data?.data.length === 0 && (
                    <EmptyState colSpan={8} message={t('payments.none')} />
                  )}
                </TableBody>
              </Table>
            </Box>
            <CustomPagination
              page={page}
              rowsPerPage={rowsPerPage}
              totalItems={requestsQuery.data?.pagination.total ?? 0}
              onPageChange={setPage}
              onRowsPerPageChange={(value) => {
                setRowsPerPage(value);
                setPage(0);
              }}
            />
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <form onSubmit={submitCreate}>
          <DialogTitle>{t('payments.newDialog')}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              <TextField
                select
                label={t('payments.activeLoan')}
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
              <TextField
                select
                label={t('payments.purpose')}
                value={purpose}
                onChange={(event) => setPurpose(event.target.value as PaymentRequestPurpose)}
              >
                <MenuItem value={PaymentRequestPurpose.PAY_DEBT}>{t('payments.purposePayDebt')}</MenuItem>
                <MenuItem value={PaymentRequestPurpose.DEPOSIT_TO_CREDIT}>{t('payments.purposeDeposit')}</MenuItem>
              </TextField>
              {isDeposit && (
                <Typography variant="caption" color="text.secondary">
                  {t('payments.depositHint')}
                </Typography>
              )}
              {payable && (
                <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
                  <Typography variant="body2">
                    {t('payments.maxPayableToday')}: {formatLak(payable.maxPayable)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {t('payments.arrivedPeriods', { n: payable.duePeriods.length, total: formatLak(payable.dueToPay) })}
                    {payable.nextPendingPeriod
                      ? ` · ${t('payments.nextPeriodDate', {
                          index: payable.nextPendingPeriod.index,
                          date: new Date(payable.nextPendingPeriod.dueDate).toLocaleDateString(),
                        })}`
                      : ''}
                  </Typography>
                  {payable.creditBalance > 0 && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      {t('payments.creditBalance', { amount: formatLak(payable.creditBalance) })}
                    </Typography>
                  )}
                </Box>
              )}
              <MoneyTextField
                label={t('payments.cashReceived')}
                minValue={0}
                value={cashAmount}
                onChange={setCashAmount}
                required
              />
              {!isDeposit && (
                <MoneyTextField
                  label={t('payments.creditToApply')}
                  minValue={0}
                  value={creditToApply}
                  onChange={setCreditToApply}
                />
              )}
              <TextField label={t('payments.note')} value={note} onChange={(event) => setNote(event.target.value)} multiline />
              {overPayable && (
                <Alert severity="warning">
                  {t('payments.overMaxPayable', {
                    requested: formatLak(requestedTotal),
                    max: formatLak(payable?.maxPayable ?? 0),
                  })}
                </Alert>
              )}
              <Typography variant="caption" color="text.secondary">
                {t('payments.pendingHint')}
              </Typography>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setCreateOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" variant="contained" disabled={createMutation.isPending || !loanId}>
              {t('payments.submit')}
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      <Dialog
        open={Boolean(activeRequest && decision)}
        onClose={() => { setDecision(null); setActiveRequest(null); }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{decision === 'APPROVE' ? t('payments.verify') : t('payments.rejectDialog')}</DialogTitle>
        <DialogContent>
          {detailQuery.isLoading ? <LoadingPanel label={t('common.loading')} /> : request && (
            <Stack spacing={2} sx={{ pt: 1 }}>
              <Typography variant="body2">{request.requestNo} · {formatLak(Number(request.cashAmount) + Number(request.creditApplied), request.currency)}</Typography>
              {decision === 'APPROVE' && (
                <>
                  <Typography variant="subtitle2">{t('payments.proposedAllocation')}</Typography>
                  {COMPONENT_ORDER.map((component) => (
                    <MoneyTextField
                      key={component}
                      label={`${t(`loanDetail.${component === 'PENALTY' ? 'penalty' : component === 'PAST_INTEREST' ? 'interest' : 'principal'}`)} (LAK)`}
                      minValue={0}
                      value={override?.[component] ?? String(proposedAllocation[component])}
                      onChange={(value) => setOverride((current) => ({
                        ...(current ?? {
                          PENALTY: String(proposedAllocation.PENALTY),
                          PAST_INTEREST: String(proposedAllocation.PAST_INTEREST),
                          PAST_PRINCIPAL: String(proposedAllocation.PAST_PRINCIPAL),
                        }),
                        [component]: value,
                      }))}
                    />
                  ))}
                </>
              )}
              <TextField
                label={decision === 'REJECT' ? t('payments.rejectionRequired') : t('common.reason')}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                required={decision === 'REJECT'}
                multiline
              />
              {formError && <Alert severity="error">{formError}</Alert>}
            </Stack>
          )}
          {detailQuery.isError && <Alert severity="error">{(detailQuery.error as Error).message}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setDecision(null); setActiveRequest(null); }}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            color={decision === 'REJECT' ? 'error' : 'primary'}
            disabled={decisionMutation.isPending || detailQuery.isLoading || (decision === 'REJECT' && !reason.trim())}
            onClick={() => decisionMutation.mutate()}
          >
            {decision === 'APPROVE' ? t('payments.approve') : t('payments.reject')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
