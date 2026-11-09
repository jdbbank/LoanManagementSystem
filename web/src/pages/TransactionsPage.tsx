import EmptyState from '../components/EmptyState';
import TableSkeleton from '../components/TableSkeleton';
import AddIcon from '@mui/icons-material/Add';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
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
  TransactionStatus,
  TransactionType,
  formatLak,
  type ComponentAmounts,
  type FinancialTransaction,
  type Loan,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { canCreate } from '../auth/roles';
import PageHeader from '../components/PageHeader';
import StatusChip from '../components/StatusChip';
import CustomPagination from '../components/CustomPagination';
import MoneyTextField from '../components/MoneyTextField';

const INITIAL_ROWS_PER_PAGE = 10;

interface TransactionPageData {
  data: FinancialTransaction[];
  pagination: { total: number };
}

interface LoanResponse {
  data: Loan[];
}

type Operation =
  | { kind: 'PAYMENT_REVERSAL' | 'WRITE_OFF_REVERSAL'; transaction: FinancialTransaction }
  | { kind: 'PENALTY' | 'WAIVER' | 'WRITE_OFF' | 'ADJUSTMENT' };

type ComponentAmountInputs = Record<keyof ComponentAmounts, string>;

const zeroComponents: ComponentAmountInputs = {
  PENALTY: '0',
  PAST_INTEREST: '0',
  PAST_PRINCIPAL: '0',
};

export default function TransactionsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [operation, setOperation] = useState<Operation | null>(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loanId, setLoanId] = useState('');
  const [amount, setAmount] = useState('');
  const [components, setComponents] = useState<ComponentAmountInputs>(zeroComponents);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(INITIAL_ROWS_PER_PAGE);

  const transactionsQuery = useQuery({
    queryKey: ['transactions', typeFilter, statusFilter, page, rowsPerPage],
    queryFn: () =>
      api
        .get<TransactionPageData>('/transactions', {
          params: {
            page: page + 1,
            limit: rowsPerPage,
            type: typeFilter || undefined,
            status: statusFilter || undefined,
          },
        })
        .then((r) => r.data),
  });
  const loansQuery = useQuery({
    queryKey: ['loans', 'transaction-form'],
    queryFn: () =>
      api.get<LoanResponse>('/loans', { params: { status: LoanStatus.ACTIVE, limit: 100 } }).then((r) => r.data),
    enabled: Boolean(operation && !('transaction' in operation)),
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['transactions'] }),
      queryClient.invalidateQueries({ queryKey: ['loans'] }),
      queryClient.invalidateQueries({ queryKey: ['approvals'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    ]);
  };

  const postMutation = useMutation({
    mutationFn: (id: string) =>
      api.post(`/transactions/${id}/post`).then(unwrap<unknown>),
    onSuccess: refresh,
    onError: (cause: Error) => setError(cause.message),
  });

  const createMutation = useMutation({
    mutationFn: async (): Promise<void> => {
      if (!operation) throw new Error('Select a transaction operation first');
      const explanation = reason.trim();
      if (!explanation) throw new Error('A reason is required');
      if ('transaction' in operation) {
        const endpoint = operation.kind === 'PAYMENT_REVERSAL' ? '/transactions/reversals' : '/transactions/write-off-reversals';
        await api.post(endpoint, {
          referenceTransactionId: operation.transaction.id,
          amount: Number(amount),
          reason: explanation,
        });
        return;
      }
      const paths = {
        PENALTY: '/transactions/penalties',
        WAIVER: '/transactions/waivers',
        WRITE_OFF: '/transactions/write-offs',
        ADJUSTMENT: '/transactions/adjustments',
      } as const;
      if (!loanId) throw new Error('Select a loan');
      if (operation.kind === 'PENALTY') {
        await api.post(paths.PENALTY, { loanId, amount: Number(amount), reason: explanation });
        return;
      }
      await api.post(paths[operation.kind], {
        loanId,
        componentAmounts: {
          PENALTY: Number(components.PENALTY),
          PAST_INTEREST: Number(components.PAST_INTEREST),
          PAST_PRINCIPAL: Number(components.PAST_PRINCIPAL),
        },
        reason: explanation,
      });
    },
    onSuccess: async () => {
      await refresh();
      setOperation(null);
      setError(null);
      setAmount('');
      setReason('');
      setComponents(zeroComponents);
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const openOperation = (next: Operation) => {
    setOperation(next);
    setLoanId('');
    setAmount('');
    setReason('');
    setComponents(zeroComponents);
    setError(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    createMutation.mutate();
  };

  const detail = operation && 'transaction' in operation ? operation.transaction : null;
  const isComponentOperation = operation && !('transaction' in operation) && ['WAIVER', 'WRITE_OFF', 'ADJUSTMENT'].includes(operation.kind);

  return (
    <Stack spacing={2}>
      <PageHeader
        title="Financial Transactions"
        actions={canCreate(user?.role) ? (
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Button startIcon={<AddIcon />} onClick={() => openOperation({ kind: 'PENALTY' })}>{t('transactions.penalty')}</Button>
            <Button onClick={() => openOperation({ kind: 'WAIVER' })}>{t('transactions.waiver')}</Button>
            <Button onClick={() => openOperation({ kind: 'WRITE_OFF' })}>{t('transactions.writeOff')}</Button>
            <Button onClick={() => openOperation({ kind: 'ADJUSTMENT' })}>{t('transactions.adjustment')}</Button>
          </Stack>
        ) : null}
      />
      <Alert severity="info">
        {t('transactions.info')}
      </Alert>
      {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
      {transactionsQuery.isError && <Alert severity="error">{(transactionsQuery.error as Error).message}</Alert>}
      <Card>
        <CardContent>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 2 }}>
            <TextField
              select
              size="small"
              label={t('transactions.filterType')}
              value={typeFilter}
              onChange={(event) => {
                setTypeFilter(event.target.value);
                setPage(0);
              }}
              sx={{ minWidth: 220 }}
            >
              <MenuItem value="">{t('transactions.allTypes')}</MenuItem>
              {Object.values(TransactionType).map((type) => (
                <MenuItem key={type} value={type}>{t(`status.${type}`, { defaultValue: type.replace(/_/g, ' ') })}</MenuItem>
              ))}
            </TextField>
            <TextField
              select
              size="small"
              label={t('common.status')}
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value);
                setPage(0);
              }}
              sx={{ minWidth: 180 }}
            >
              <MenuItem value="">{t('transactions.allStatuses')}</MenuItem>
              {Object.values(TransactionStatus).map((status) => (
                <MenuItem key={status} value={status}>{t(`status.${status}`, { defaultValue: status.replace(/_/g, ' ') })}</MenuItem>
              ))}
            </TextField>
          </Stack>
          {transactionsQuery.isLoading ? (
            <TableSkeleton columns={7} label={t('common.loading')} />
          ) : (
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t('transactions.reference')}</TableCell>
                    <TableCell>{t('common.type')}</TableCell>
                    <TableCell>{t('common.loan')}</TableCell>
                    <TableCell>{t('common.amount')}</TableCell>
                    <TableCell>{t('common.status')}</TableCell>
                    <TableCell>{t('common.reason')}</TableCell>
                    <TableCell>{t('common.actions')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(transactionsQuery.data?.data ?? []).map((tx) => (
                    <TableRow key={tx.id} hover>
                      <TableCell>{tx.referenceNo}</TableCell>
                      <TableCell>{t(`status.${tx.transactionType}`, { defaultValue: tx.transactionType.replace(/_/g, ' ') })}</TableCell>
                      <TableCell>{tx.loanId}</TableCell>
                      <TableCell>{formatLak(tx.amount, tx.currency)}</TableCell>
                      <TableCell><StatusChip status={tx.status} /></TableCell>
                      <TableCell>{tx.reason ?? '—'}</TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={1}>
                          {tx.status === TransactionStatus.APPROVED && (
                            <Button
                              size="small"
                              disabled={postMutation.isPending}
                              onClick={() => postMutation.mutate(tx.id)}
                            >
                              {t('transactions.post')}
                            </Button>
                          )}
                          {canCreate(user?.role) && tx.status === TransactionStatus.POSTED &&
                            (tx.transactionType === TransactionType.PAYMENT ||
                              tx.transactionType === TransactionType.SETTLEMENT_PAYMENT) && (
                              <Button size="small" onClick={() => openOperation({ kind: 'PAYMENT_REVERSAL', transaction: tx })}>
                                {t('transactions.reverse')}
                              </Button>
                            )}
                          {canCreate(user?.role) && tx.status === TransactionStatus.POSTED &&
                            tx.transactionType === TransactionType.WRITE_OFF && (
                              <Button size="small" onClick={() => openOperation({ kind: 'WRITE_OFF_REVERSAL', transaction: tx })}>
                                {t('transactions.reverseWriteOff')}
                              </Button>
                            )}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))}
                  {transactionsQuery.data?.data.length === 0 && (
                    <EmptyState colSpan={7} message={t('transactions.noTransactions')} />
                  )}
                </TableBody>
              </Table>
            </Box>
          )}
          <CustomPagination
            page={page}
            rowsPerPage={rowsPerPage}
            totalItems={transactionsQuery.data?.pagination.total ?? 0}
            onPageChange={setPage}
            onRowsPerPageChange={(value) => {
              setRowsPerPage(value);
              setPage(0);
            }}
          />
        </CardContent>
      </Card>

      <Dialog open={Boolean(operation)} onClose={() => setOperation(null)} fullWidth maxWidth="sm">
        <form onSubmit={submit}>
          <DialogTitle>{operation ? t(`transactions.${operation.kind === 'PAYMENT_REVERSAL' ? 'reverse' : operation.kind === 'WRITE_OFF_REVERSAL' ? 'reverseWriteOff' : operation.kind === 'PENALTY' ? 'penalty' : operation.kind === 'WAIVER' ? 'waiver' : operation.kind === 'WRITE_OFF' ? 'writeOff' : 'adjustment'}`) : t('transactions.create')}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              {detail ? (
                <Typography variant="body2">
                  {detail.referenceNo} · {detail.transactionType.replace(/_/g, ' ')} · {formatLak(detail.amount, detail.currency)}
                </Typography>
              ) : (
                <TextField
                  select
                  label={t('transactions.activeLoan')}
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
              )}
              {(!operation || 'transaction' in operation || operation.kind === 'PENALTY') && (
                <MoneyTextField
                  label={t('transactions.amountLak')}
                  minValue={0.01}
                  value={amount}
                  onChange={setAmount}
                  required
                />
              )}
              {detail && (
                <Alert severity="info">
                  {t('transactions.reversalInfo')}
                </Alert>
              )}
              {isComponentOperation && COMPONENT_ORDER.map((component) => (
                <MoneyTextField
                  key={component}
                  label={`${t(`loanDetail.${component === 'PENALTY' ? 'penalty' : component === 'PAST_INTEREST' ? 'interest' : 'principal'}`)} (LAK)`}
                  value={components[component]}
                  allowNegative={operation?.kind === 'ADJUSTMENT'}
                  minValue={operation?.kind === 'ADJUSTMENT' ? undefined : 0}
                  onChange={(value) => setComponents((current) => ({
                    ...current,
                    [component]: value,
                  }))}
                />
              ))}
              <TextField
                label={t('transactions.reasonRequired')}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                required
                multiline
              />
              {error && <Alert severity="error">{error}</Alert>}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setOperation(null)}>{t('common.cancel')}</Button>
            <Button type="submit" variant="contained" disabled={createMutation.isPending}>
              {t('transactions.submitApproval')}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Stack>
  );
}
