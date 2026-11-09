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
import Divider from '@mui/material/Divider';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, unwrap } from '../api/client';
import {
  formatLak,
  PERIOD_UNITS,
  DISBURSEMENT_CHANNELS,
  DisbursementChannel,
  InterestMethod,
  KycStatus,
  PeriodUnit,
  type CustomerBankAccountsView,
  type CustomerRow,
  type KycConfig,
  type Loan,
  type LoanListAggregates,
  type LoanProduct,
  type Pagination as Pag,
} from '../api/types';
import { interestMethodName } from '../utils/interest';
import { decliningInterestPreview, flatInterestTotal } from '../utils/period';
import { useAuth } from '../auth/AuthContext';
import { OPERATOR_ROLES } from '../auth/roles';
import EmptyState from '../components/EmptyState';
import PageHeader from '../components/PageHeader';
import StatusChip from '../components/StatusChip';
import CustomPagination from '../components/CustomPagination';
import MoneyTextField from '../components/MoneyTextField';

const INITIAL_ROWS_PER_PAGE = 10;

export default function LoansPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(INITIAL_ROWS_PER_PAGE);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState('');
  const [productId, setProductId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [termValue, setTermValue] = useState('');
  const [termUnit, setTermUnit] = useState<PeriodUnit>(PeriodUnit.MONTH);
  const [note, setNote] = useState('');
  const [channel, setChannel] = useState<'' | DisbursementChannel>('');
  const [bankAccountId, setBankAccountId] = useState('');
  const [reference, setReference] = useState('');

  const canCreate = user ? OPERATOR_ROLES.includes(user.role) : false;

  const { data, isLoading } = useQuery({
    queryKey: ['loans', page, status, debouncedQ],
    placeholderData: keepPreviousData,
    queryFn: () =>
      api
        .get<{ data: Loan[]; pagination: Pag; aggregates: LoanListAggregates }>('/loans', {
          params: { page: page + 1, limit: rowsPerPage, status: status || undefined, q: debouncedQ || undefined },
        })
        .then((r) => r.data),
  });

  const { data: customers } = useQuery({
    queryKey: ['customers', ''],
    queryFn: () => api.get<{ customers: CustomerRow[] }>('/customers').then((r) => r.data.customers),
    enabled: canCreate,
  });

  const { data: kycConfig } = useQuery({
    queryKey: ['config', 'kyc'],
    queryFn: () => api.get('/config/kyc').then(unwrap<KycConfig>),
    enabled: canCreate,
  });

  const kycGateOn = kycConfig?.policy.blockDisbursementUntilVerified ?? false;

  const { data: products } = useQuery({
    queryKey: ['products'],
    queryFn: () => api.get<{ products: LoanProduct[] }>('/loan-products').then((r) => r.data.products),
    enabled: canCreate,
  });

  /** Only the accounts this customer can still receive money through — a closed one is history, not a target. */
  const { data: bankAccounts } = useQuery({
    queryKey: ['customers', customerId, 'bank-accounts', 'ACTIVE'],
    queryFn: () =>
      api
        .get(`/customers/${customerId}/bank-accounts`, { params: { status: 'ACTIVE' } })
        .then(unwrap<CustomerBankAccountsView>),
    enabled: canCreate && channel === DisbursementChannel.BANK && Boolean(customerId),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.post('/loans', {
        customerId,
        productId,
        principalAmount: Number(principal),
        termValue: termValue ? Number(termValue) : undefined,
        termUnit: termValue ? termUnit : undefined,
        note: note || undefined,
        disbursementChannel: channel || undefined,
        disbursementBankAccountId: channel === DisbursementChannel.BANK ? bankAccountId : undefined,
        disbursementReference: reference || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['loans'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setOpen(false);
      setCustomerId('');
      setProductId('');
      setPrincipal('');
      setTermValue('');
      setNote('');
      setChannel('');
      setBankAccountId('');
      setReference('');
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const onSearch = (value: string) => {
    setQ(value);
    window.setTimeout(() => setDebouncedQ(value), 350);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    createMutation.mutate();
  };

  const selectedProduct = products?.find((p) => p.id === productId);
  const total = data?.pagination.total ?? 0;
  const aggregates = data?.aggregates;

  // An empty term box means "use the product's own term", in the product's own unit.
  const effectiveTerm = selectedProduct
    ? {
        value: termValue ? Number(termValue) : selectedProduct.termValue,
        unit: termValue ? termUnit : selectedProduct.termUnit,
      }
    : null;
  const declining = selectedProduct?.interestMethod === InterestMethod.DECLINING;
  const preview =
    selectedProduct && effectiveTerm && Number(principal) > 0
      ? {
          flat: flatInterestTotal({
            principal: Number(principal),
            ratePercent: selectedProduct.interestRate,
            rateUnit: selectedProduct.interestRatePeriod,
            termValue: effectiveTerm.value,
            termUnit: effectiveTerm.unit,
          }),
          declining: decliningInterestPreview({
            principal: Number(principal),
            ratePercent: selectedProduct.interestRate,
            rateUnit: selectedProduct.interestRatePeriod,
            termValue: effectiveTerm.value,
            termUnit: effectiveTerm.unit,
          }),
        }
      : null;
  const previewInterest = preview ? (declining ? preview.declining.total : preview.flat) : 0;

  return (
    <Stack spacing={2}>
      <PageHeader
        title="Loans"
        actions={
          canCreate ? (
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setOpen(true)}>
              {t('loans.new')}
            </Button>
          ) : null
        }
      />
      <Card>
        <CardContent>
          <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap' }}>
            <TextField
              select
              size="small"
              label={t('common.status')}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(0);
              }}
              sx={{ minWidth: 160 }}
            >
              <MenuItem value="">{t('loans.all')}</MenuItem>
              <MenuItem value="ACTIVE">{t('status.ACTIVE')}</MenuItem>
              <MenuItem value="CLOSED">{t('status.CLOSED')}</MenuItem>
              <MenuItem value="WRITTEN_OFF">{t('status.WRITTEN_OFF')}</MenuItem>
            </TextField>
            <TextField
              size="small"
              placeholder={t('loans.search')}
              value={q}
              onChange={(e) => onSearch(e.target.value)}
              sx={{ width: 340 }}
            />
            <Typography variant="body2" color="text.secondary" sx={{ alignSelf: 'center' }}>
              {total} {t('navigation.loans')}
            </Typography>
          </Stack>
          {aggregates && total > 0 && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {t('loans.aggregates', {
                principal: formatLak(aggregates.outstandingPrincipal),
                interest: formatLak(aggregates.outstandingInterest),
                penalty: formatLak(aggregates.outstandingPenalty),
                total: formatLak(aggregates.outstandingTotal),
              })}
            </Alert>
          )}
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('loans.number')}</TableCell>
                  <TableCell>{t('common.customer')}</TableCell>
                  <TableCell>{t('loans.product')}</TableCell>
                  <TableCell align="right">{t('loans.principal')}</TableCell>
                  <TableCell align="right">{t('loans.rate')}</TableCell>
                  <TableCell align="right">{t('loans.outstanding')}</TableCell>
                  <TableCell>{t('common.status')}</TableCell>
                  <TableCell align="right">{t('common.actions')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {isLoading && (
                  <TableRow>
                    <TableCell colSpan={8} align="center">
                      {t('common.loading')}
                    </TableCell>
                  </TableRow>
                )}
                {(data?.data ?? []).map((loan) => (
                  <TableRow key={loan.id} hover>
                    <TableCell>
                      <Link to={`/loans/${loan.id}`} style={{ fontWeight: 600 }}>
                        {loan.loanNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{loan.customer?.fullName ?? loan.customerId}</TableCell>
                    <TableCell>{loan.product?.code ?? loan.productId}</TableCell>
                    <TableCell align="right">{formatLak(loan.principalAmount, loan.currency)}</TableCell>
                    <TableCell align="right">
                      {t('products.rateDisplay', { rate: loan.interestRate, unit: t(`units.${loan.interestRatePeriod}`) })}
                    </TableCell>
                    <TableCell align="right">
                      {formatLak(loan.outstanding?.total ?? loan.currentOutstanding, loan.currency)}
                    </TableCell>
                    <TableCell>
                      <StatusChip status={loan.status} />
                    </TableCell>
                    <TableCell align="right">
                      <Button component={Link} to={`/loans/${loan.id}`} size="small">
                        {t('loans.openLoan')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {data && data.data.length === 0 && (
                  <EmptyState colSpan={8} message={t('loans.noLoans')} />
                )}
              </TableBody>
            </Table>
          </Box>
          <CustomPagination
            page={page}
            rowsPerPage={rowsPerPage}
            totalItems={total}
            onPageChange={setPage}
            onRowsPerPageChange={(value) => {
              setRowsPerPage(value);
              setPage(0);
            }}
          />
        </CardContent>
      </Card>

      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
        <form onSubmit={submit}>
          <DialogTitle>{t('loans.newDialog')}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              <TextField
                select
                label={`${t('loans.customer')} *`}
                value={customerId}
                onChange={(e) => {
                  setCustomerId(e.target.value);
                  setBankAccountId('');
                }}
                required
                fullWidth
              >
                {(customers ?? []).map((c) => {
                  const blocked = kycGateOn && c.kycStatus !== KycStatus.VERIFIED;
                  return (
                    <MenuItem key={c.id} value={c.id} disabled={blocked}>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                        <span>
                          {c.customerNumber} — {c.fullName}
                        </span>
                        <Typography variant="caption" color={blocked ? 'error.main' : 'text.secondary'}>
                          {t('loans.customerKyc', { status: t(`status.${c.kycStatus}`) })}
                        </Typography>
                      </Stack>
                    </MenuItem>
                  );
                })}
              </TextField>
              {kycGateOn && <Alert severity="info">{t('loans.kycGate')}</Alert>}
              <TextField
                select
                label={`${t('loans.product')} *`}
                value={productId}
                onChange={(e) => {
                  setProductId(e.target.value);
                  const picked = products?.find((p) => p.id === e.target.value);
                  if (picked) setTermUnit(picked.termUnit);
                }}
                required
                fullWidth
              >
                {(products ?? [])
                  .filter((p) => p.isActive)
                  .map((p) => (
                    <MenuItem key={p.id} value={p.id}>
                      {p.code} — {p.name} (
                      {t('products.rateDisplay', { rate: p.interestRate, unit: t(`units.${p.interestRatePeriod}`) })},{' '}
                      {interestMethodName(t, p.interestMethod)},{' '}
                      {t('products.termDisplay', { value: p.termValue, unit: t(`units.${p.termUnit}`) })})
                    </MenuItem>
                  ))}
              </TextField>
              <Stack direction="row" spacing={2}>
                <MoneyTextField
                  label={`${t('loans.principalAmount')} *`}
                  minValue={0.01}
                  value={principal}
                  onChange={setPrincipal}
                  required
                  fullWidth
                />
                <TextField
                  label={t('loans.termOverride')}
                  type="number"
                  slotProps={{ htmlInput: { step: '1', min: '1' } }}
                  value={termValue}
                  onChange={(e) => setTermValue(e.target.value)}
                  fullWidth
                />
                <TextField
                  select
                  label={t('products.termUnit')}
                  value={termUnit}
                  onChange={(e) => setTermUnit(e.target.value as PeriodUnit)}
                  disabled={!termValue}
                  sx={{ minWidth: 130 }}
                >
                  {PERIOD_UNITS.map((u) => (
                    <MenuItem key={u} value={u}>
                      {t(`units.${u}`)}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>
              {selectedProduct && preview && (
                <Alert severity="info">
                  {declining ? (
                    <>
                      {t('loans.interestPreviewDeclining', {
                        interest: formatLak(previewInterest, selectedProduct.currency),
                        count: preview.declining.periods,
                      })}{' '}
                      —{' '}
                      {t('loans.decliningAtDisbursement', {
                        first: formatLak(preview.declining.firstPeriod, selectedProduct.currency),
                        total: formatLak(Number(principal) + preview.declining.firstPeriod, selectedProduct.currency),
                      })}
                    </>
                  ) : (
                    <>
                      {t('loans.interestPreview', { interest: formatLak(previewInterest, selectedProduct.currency) })}{' '}
                      —{' '}
                      {t('loans.totalAtDisbursement', {
                        total: formatLak(Number(principal) + previewInterest, selectedProduct.currency),
                      })}
                    </>
                  )}
                </Alert>
              )}
              <Divider />
              <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', gap: 1 }}>
                <TextField
                  select
                  label={t('disbursement.channel')}
                  value={channel}
                  onChange={(e) => {
                    setChannel(e.target.value as '' | DisbursementChannel);
                    setBankAccountId('');
                  }}
                  sx={{ minWidth: 200 }}
                >
                  <MenuItem value="">
                    {t('disbursement.notRecorded')}
                  </MenuItem>
                  {DISBURSEMENT_CHANNELS.map((item) => (
                    <MenuItem key={item} value={item}>
                      {t(`status.${item}`)}
                    </MenuItem>
                  ))}
                </TextField>
                {channel === DisbursementChannel.BANK && (
                  <TextField
                    select
                    label={`${t('disbursement.bankAccount')} *`}
                    value={bankAccountId}
                    onChange={(e) => setBankAccountId(e.target.value)}
                    sx={{ minWidth: 320 }}
                  >
                    {(bankAccounts?.accounts ?? []).map((account) => (
                      <MenuItem key={account.id} value={account.id}>
                        {account.bankName} — {account.accountNumber} · {account.accountHolderName}
                      </MenuItem>
                    ))}
                  </TextField>
                )}
                <TextField
                  label={t('disbursement.reference')}
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  slotProps={{ htmlInput: { maxLength: 64 } }}
                  sx={{ minWidth: 220 }}
                />
              </Stack>
              <Typography variant="caption" color="text.secondary">
                {channel === DisbursementChannel.BANK
                  ? t('disbursement.bankInfo', { count: bankAccounts?.accounts.length ?? 0 })
                  : channel === DisbursementChannel.CASH
                    ? t('disbursement.cashInfo')
                    : t('disbursement.channelInfo')}
              </Typography>
              <TextField
                label={t('loans.note')}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                fullWidth
              />
              {error && <Alert severity="error">{error}</Alert>}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button
              type="submit"
              variant="contained"
              disabled={createMutation.isPending || (channel === DisbursementChannel.BANK && !bankAccountId)}
            >
              {createMutation.isPending ? t('common.loading') : t('loans.new')}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Stack>
  );
}
