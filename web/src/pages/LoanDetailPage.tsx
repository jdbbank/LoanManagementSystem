import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { api, unwrap } from '../api/client';
import {
  COMPONENT_ORDER,
  formatLak,
  InterestMethod,
  LoanStatus,
  PenaltyMode,
  type AllocationPreview,
  type CreditLedgerEntry,
  type EarlySettlementFeePreview,
  type FinancialTransaction,
  type InterestAccrualResult,
  type LoanDetail,
  type LoanSchedule,
  type PayableNow,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { OPERATOR_ROLES } from '../auth/roles';
import EmptyState from '../components/EmptyState';
import PageHeader from '../components/PageHeader';
import StatusChip from '../components/StatusChip';
import CustomPagination from '../components/CustomPagination';
import MoneyTextField from '../components/MoneyTextField';
import LoanCollateralsPanel from '../components/LoanCollateralsPanel';
import LoanDisbursementPanel from '../components/LoanDisbursementPanel';
import LoanPartiesPanel from '../components/LoanPartiesPanel';
import LoanRestructuresPanel from '../components/LoanRestructuresPanel';
import { describeInterest } from '../utils/interest';
import { describePenalty } from '../utils/penalty';

const INITIAL_ROWS_PER_PAGE = 10;
const TAB_KEYS = [
  'schedule.tabSummary',
  'schedule.tabPeriods',
  'schedule.tabPayments',
  'schedule.tabCredit',
  'hardship.tabParties',
  'hardship.tabSecurity',
  'hardship.tabAddendums',
  'loans.tabDisbursement',
] as const;

interface LedgerResponse {
  ledger: CreditLedgerEntry[];
  currentBalance: number;
}

interface AccrualResponse {
  transaction: FinancialTransaction;
  schedule: LoanSchedule;
}

function fmtDate(v: string | null, locale: string): string {
  return v ? new Date(v).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

function fmtDay(v: string | null, locale: string): string {
  return v ? new Date(v).toLocaleDateString(locale, { dateStyle: 'medium' }) : '—';
}

function SummaryRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
      <Typography color="text.secondary" sx={{ fontWeight: strong ? 700 : 400 }}>
        {label}
      </Typography>
      <Typography sx={{ fontWeight: strong ? 700 : 600 }}>{value}</Typography>
    </Stack>
  );
}

export default function LoanDetailPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const [amount, setAmount] = useState('');
  const [tab, setTab] = useState(0);
  const [transactionPage, setTransactionPage] = useState(0);
  const [transactionsPerPage, setTransactionsPerPage] = useState(INITIAL_ROWS_PER_PAGE);
  const [ledgerPage, setLedgerPage] = useState(0);
  const [ledgerRowsPerPage, setLedgerRowsPerPage] = useState(INITIAL_ROWS_PER_PAGE);
  const [charged, setCharged] = useState<string | null>(null);
  const [accrueError, setAccrueError] = useState<string | null>(null);
  const [interestNote, setInterestNote] = useState<{ severity: 'success' | 'info' | 'error'; text: string } | null>(
    null,
  );

  const { data } = useQuery({
    queryKey: ['loan', id, transactionPage, transactionsPerPage],
    queryFn: () => api.get(`/loans/${id}`, {
      params: { page: transactionPage + 1, limit: transactionsPerPage },
    }).then(unwrap<LoanDetail>),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
  });

  const { data: schedule } = useQuery({
    queryKey: ['loan', id, 'schedule'],
    queryFn: () => api.get(`/loans/${id}/schedule`).then(unwrap<LoanSchedule>),
    enabled: Boolean(id),
  });

  const numericAmount = Number(amount);
  const { data: preview } = useQuery({
    queryKey: ['loan', id, 'allocation-preview', numericAmount],
    queryFn: () =>
      api
        .get(`/loans/${id}/allocation-preview`, { params: { amount: numericAmount } })
        .then(unwrap<AllocationPreview>),
    enabled: Boolean(id) && numericAmount > 0,
  });

  /** What the payment gate would accept for this loan today — only instalments that have arrived. */
  const { data: payable } = useQuery({
    queryKey: ['loan', id, 'payable-now'],
    queryFn: () => api.get(`/loans/${id}/payable-now`).then(unwrap<PayableNow>),
    enabled: Boolean(id),
  });

  /** What closing the loan today would cost, including the early-settlement fee. Read-only quote. */
  const { data: payoffFee } = useQuery({
    queryKey: ['loan', id, 'early-settlement-fee'],
    queryFn: () =>
      api.get(`/settlements/early-settlement-fee/${id}`).then(unwrap<EarlySettlementFeePreview>),
    enabled: Boolean(id),
  });

  const customerId = data?.loan.customerId;
  const { data: ledger } = useQuery({
    queryKey: ['credits', 'ledger', customerId, ledgerPage, ledgerRowsPerPage],
    queryFn: () =>
      api
        .get<{ data: LedgerResponse; pagination: { total: number } }>('/credits/ledger', {
          params: { customerId, page: ledgerPage + 1, limit: ledgerRowsPerPage },
        })
        .then((r) => r.data),
    enabled: Boolean(customerId) && tab === 3,
  });

  const accrueMutation = useMutation({
    mutationFn: () =>
      api.post('/transactions/penalties/accrue', { loanId: id }).then(unwrap<AccrualResponse>),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['loan', id] });
      queryClient.invalidateQueries({ queryKey: ['loans'] });
      queryClient.invalidateQueries({ queryKey: ['approvals'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setCharged(formatLak(result.transaction.amount, result.transaction.currency));
      setAccrueError(null);
    },
    onError: (e: Error) => {
      setCharged(null);
      setAccrueError(e.message);
    },
  });

  /** The same maker-checker charge as the penalty accrual, priced on the principal still owed. */
  const interestMutation = useMutation({
    mutationFn: () =>
      api.post('/transactions/interest/accrue', { loanIds: [id] }).then(unwrap<InterestAccrualResult>),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['loan', id] });
      queryClient.invalidateQueries({ queryKey: ['loans'] });
      queryClient.invalidateQueries({ queryKey: ['approvals'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      const created = result.created[0];
      setInterestNote(
        created
          ? { severity: 'success', text: t('schedule.interestAccrueDone', { amount: formatLak(created.amount) }) }
          : { severity: 'info', text: t('schedule.interestAccrueNone') },
      );
    },
    onError: (e: Error) => setInterestNote({ severity: 'error', text: e.message }),
  });

  if (!data) {
    return <Typography>{t('common.loading')}</Typography>;
  }
  const { loan, transactions, settlements, disbursement } = data;
  const locale = i18n.resolvedLanguage?.startsWith('lo') ? 'lo-LA' : 'en-GB';
  const translateStatus = (status: string) => t(`status.${status}`, { defaultValue: status });
  const outstanding = {
    PENALTY: loan.outstandingPenalty,
    PAST_INTEREST: loan.outstandingPastInterest,
    PAST_PRINCIPAL: loan.outstandingPastPrincipal,
  };
  const componentLabelKey = {
    PENALTY: 'loanDetail.penalty',
    PAST_INTEREST: 'loanDetail.interest',
    PAST_PRINCIPAL: 'loanDetail.principal',
  } as const;

  const policyOn = Boolean(schedule) && schedule!.penaltyPolicy.mode !== PenaltyMode.NONE;
  const canAccrue = Boolean(user && OPERATOR_ROLES.includes(user.role)) && loan.status === LoanStatus.ACTIVE;
  const nothingToCharge = !schedule || schedule.totals.penaltySuggested <= 0;
  const accrueCaption = !policyOn
    ? t('schedule.accrueDisabled')
    : nothingToCharge
      ? t('schedule.accrueNone')
      : t('schedule.accrueInfo');

  const declining = schedule?.interestMethod === InterestMethod.DECLINING;
  const interestDue = schedule?.totals.interestSuggested ?? 0;
  const interestCaption = !declining
    ? t('schedule.interestAccrueDisabled')
    : interestDue <= 0
      ? t('schedule.interestAccrueNone')
      : t('schedule.interestAccrueInfo');

  return (
    <Stack spacing={2}>
      <PageHeader title={`Loan ${loan.loanNumber}`} actions={<StatusChip status={loan.status} size="medium" />} />

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 6 }}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                {t('loanDetail.details')}
              </Typography>
              <Stack divider={<Divider flexItem />} spacing={1}>
                <SummaryRow
                  label={t('common.customer')}
                  value={loan.customer ? `${loan.customer.customerNumber} — ${loan.customer.fullName}` : loan.customerId}
                />
                <SummaryRow
                  label={t('loanDetail.product')}
                  value={loan.product ? `${loan.product.code} — ${loan.product.name}` : loan.productId}
                />
                <SummaryRow
                  label={t('loanDetail.principalRateTerm')}
                  value={
                    `${formatLak(loan.principalAmount, loan.currency)} · ` +
                    `${t('products.rateDisplay', { rate: loan.interestRate, unit: t(`units.${loan.interestRatePeriod}`) })} · ` +
                    `${t('products.termDisplay', { value: loan.termValue, unit: t(`units.${loan.termUnit}`) })}`
                  }
                />
                <SummaryRow
                  label={t('products.interestMethod')}
                  value={describeInterest(t, schedule?.interestMethod ?? loan.interestMethod)}
                />
                <SummaryRow label={t('loanDetail.disbursedAt')} value={fmtDate(loan.disbursedAt, locale)} />                <SummaryRow label={t('loanDetail.created')} value={fmtDate(loan.createdAt, locale)} />
              </Stack>
            </CardContent>
          </Card>
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                {t('loanDetail.outstandingBalance')}
              </Typography>
              <Stack divider={<Divider flexItem />} spacing={1}>
                {COMPONENT_ORDER.map((key) => (
                  <SummaryRow
                    key={key}
                    label={t(componentLabelKey[key])}
                    value={formatLak(outstanding[key], loan.currency)}
                  />
                ))}
                <SummaryRow
                  strong
                  label={t('loanDetail.totalOutstanding')}
                  value={formatLak(loan.outstanding?.total ?? loan.currentOutstanding, loan.currency)}
                />
              </Stack>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Card>
        <CardContent sx={{ pt: 0 }}>
          <Tabs value={tab} onChange={(_, value) => setTab(value)} variant="scrollable" scrollButtons="auto">
            {TAB_KEYS.map((key) => (
              <Tab key={key} label={t(key)} />
            ))}
          </Tabs>

          {tab === 0 && (
            <Stack spacing={2} sx={{ pt: 2 }}>
              <Card variant="outlined">
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    {t('schedule.tabSummary')}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
                    {schedule
                      ? `${t('schedule.info')} · ${t('schedule.asOf', { date: fmtDay(schedule.asOf, locale) })}`
                      : t('common.loading')}
                  </Typography>
                  {schedule && (
                    <Grid container spacing={2}>
                      <Grid size={{ xs: 12, md: 6 }}>
                        <Stack divider={<Divider flexItem />} spacing={1}>
                          <SummaryRow
                            label={t('schedule.principalCharged')}
                            value={formatLak(schedule.totals.principalCharged, loan.currency)}
                          />
                          <SummaryRow
                            label={t('schedule.interestCharged')}
                            value={formatLak(schedule.totals.interestCharged, loan.currency)}
                          />
                          <SummaryRow
                            label={t('schedule.penaltyCharged')}
                            value={formatLak(schedule.totals.penaltyCharged, loan.currency)}
                          />
                          <SummaryRow
                            label={t('schedule.penaltyAccrued')}
                            value={formatLak(schedule.totals.penaltyAccrued, loan.currency)}
                          />
                          <SummaryRow
                            label={t('schedule.totalCharged')}
                            value={formatLak(schedule.totals.totalCharged, loan.currency)}
                          />
                        </Stack>
                      </Grid>
                      <Grid size={{ xs: 12, md: 6 }}>
                        <Stack divider={<Divider flexItem />} spacing={1}>
                          <SummaryRow
                            label={t('schedule.totalOutstanding')}
                            value={formatLak(schedule.totals.totalOutstanding, loan.currency)}
                          />
                          <SummaryRow
                            label={t('schedule.paidLabel')}
                            value={formatLak(
                              schedule.totals.paid.PENALTY +
                                schedule.totals.paid.PAST_INTEREST +
                                schedule.totals.paid.PAST_PRINCIPAL,
                              loan.currency,
                            )}
                          />
                          <SummaryRow
                            label={t('schedule.relievedLabel')}
                            value={formatLak(
                              schedule.totals.relieved.PENALTY +
                                schedule.totals.relieved.PAST_INTEREST +
                                schedule.totals.relieved.PAST_PRINCIPAL,
                              loan.currency,
                            )}
                          />
                          {declining && (
                            <SummaryRow
                              label={t('schedule.interestSuggested')}
                              value={formatLak(schedule.totals.interestSuggested, loan.currency)}
                            />
                          )}
                          <SummaryRow
                            label={t('schedule.penaltySuggested')}
                            value={formatLak(schedule.totals.penaltySuggested, loan.currency)}
                          />
                          <SummaryRow
                            label={t('schedule.creditBalance')}
                            value={formatLak(schedule.totals.creditBalance, loan.currency)}
                          />
                          <SummaryRow
                            label={t('schedule.maturityDate')}
                            value={fmtDay(schedule.aging.maturityDate, locale)}
                          />
                        </Stack>
                      </Grid>
                      <Grid size={{ xs: 12 }}>
                        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                          {schedule.aging.overduePeriods > 0 ? (
                            <>
                              <Chip
                                color="error"
                                variant="outlined"
                                size="small"
                                label={t('schedule.overduePeriods', { count: schedule.aging.overduePeriods })}
                              />
                              <Chip
                                size="small"
                                variant="outlined"
                                label={t('schedule.maxOverdueDays', { days: schedule.aging.maxOverdueDays })}
                              />
                            </>
                          ) : (
                            <Chip color="success" variant="outlined" size="small" label={t('schedule.noOverdue')} />
                          )}
                          {schedule.aging.nextDueDate && (
                            <Chip
                              size="small"
                              variant="outlined"
                              label={`${t('schedule.nextDueDate')}: ${fmtDay(schedule.aging.nextDueDate, locale)}`}
                            />
                          )}
                          <Chip
                            size="small"
                            variant="outlined"
                            label={t('schedule.periodsCount', { count: schedule.periodCount })}
                          />
                        </Stack>
                      </Grid>
                      <Grid size={{ xs: 12 }}>
                        <Typography variant="body2" color="text.secondary">
                          {policyOn
                            ? t('schedule.penaltyRule', { details: describePenalty(t, schedule.penaltyPolicy) })
                            : t('schedule.noPenalty')}
                        </Typography>
                      </Grid>
                      {payoffFee && (
                        <Grid size={{ xs: 12 }}>
                          <Typography variant="body2" color="text.secondary">
                            {payoffFee.feePercent <= 0
                              ? t('settlements.feeRuleNone')
                              : payoffFee.settledBeforeTermEnd
                                ? t('settlements.feeRuleEarly', {
                                    percent: payoffFee.feePercent,
                                    fee: formatLak(payoffFee.fee, loan.currency),
                                    total: formatLak(payoffFee.totalDue, loan.currency),
                                  })
                                : t('settlements.feeRuleAtTermEnd')}
                          </Typography>
                        </Grid>
                      )}
                      {canAccrue && (
                        <Grid size={{ xs: 12 }}>
                          <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                            <Button
                              variant="outlined"
                              onClick={() => accrueMutation.mutate()}
                              disabled={!policyOn || nothingToCharge || accrueMutation.isPending}
                            >
                              {accrueMutation.isPending ? t('common.loading') : t('schedule.accrue')}
                            </Button>
                            <Typography variant="caption" color="text.secondary">
                              {accrueCaption}
                            </Typography>
                          </Stack>
                        </Grid>
                      )}
                      {canAccrue && declining && (
                        <Grid size={{ xs: 12 }}>
                          <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                            <Button
                              variant="outlined"
                              onClick={() => {
                                setInterestNote(null);
                                interestMutation.mutate();
                              }}
                              disabled={interestDue <= 0 || interestMutation.isPending}
                            >
                              {interestMutation.isPending
                                ? t('common.loading')
                                : t('schedule.interestAccrue', {
                                    amount: formatLak(interestDue, loan.currency),
                                  })}
                            </Button>
                            <Typography variant="caption" color="text.secondary">
                              {interestCaption}
                            </Typography>
                          </Stack>
                          {interestNote && (
                            <Alert
                              severity={interestNote.severity}
                              sx={{ mt: 1 }}
                              onClose={() => setInterestNote(null)}
                            >
                              {interestNote.text}
                            </Alert>
                          )}
                        </Grid>
                      )}
                      {charged && (
                        <Grid size={{ xs: 12 }}>
                          <Alert severity="success" onClose={() => setCharged(null)}>
                            {t('schedule.accrueDone', { amount: charged })}
                          </Alert>
                        </Grid>
                      )}
                      {accrueError && (
                        <Grid size={{ xs: 12 }}>
                          <Alert severity="error" onClose={() => setAccrueError(null)}>
                            {accrueError}
                          </Alert>
                        </Grid>
                      )}
                    </Grid>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    {t('loanDetail.allocationPreview')}
                  </Typography>
                  <MoneyTextField
                    size="small"
                    label={t('loanDetail.hypotheticalAmount')}
                    minValue={0.01}
                    value={amount}
                    onChange={setAmount}
                    sx={{ width: 300, mb: 2 }}
                  />
                  {payable && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: -1, mb: 2 }}>
                      {t('payments.maxPayableToday')}: {formatLak(payable.maxPayable, loan.currency)}
                      {payable.nextPendingPeriod
                        ? ` · ${t('payments.nextPeriodDate', {
                            index: payable.nextPendingPeriod.index,
                            date: fmtDay(payable.nextPendingPeriod.dueDate, locale),
                          })}`
                        : ''}
                    </Typography>
                  )}
                  {preview && (
                    <Stack spacing={1}>
                      <Grid container spacing={1}>
                        {COMPONENT_ORDER.map((key) => (
                          <Grid key={key} size={{ xs: 12, sm: 4 }}>
                            <Card variant="outlined">
                              <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                                <Typography variant="caption" color="text.secondary">
                                  {t('loanDetail.appliedTo', { component: t(componentLabelKey[key]) })}
                                </Typography>
                                <Typography sx={{ fontWeight: 700 }}>
                                  {formatLak(preview.allocation[key], loan.currency)}
                                </Typography>
                              </CardContent>
                            </Card>
                          </Grid>
                        ))}
                      </Grid>
                      {preview.excess > 0 && (
                        <Alert severity="info">
                          {t('loanDetail.overpayment', { amount: formatLak(preview.excess, loan.currency) })}
                        </Alert>
                      )}
                      {payable && numericAmount > payable.maxPayable + 0.004 && (
                        <Alert severity="warning">
                          {t('payments.overMaxPayable', {
                            requested: formatLak(numericAmount, loan.currency),
                            max: formatLak(payable.maxPayable, loan.currency),
                          })}
                        </Alert>
                      )}
                    </Stack>
                  )}
                </CardContent>
              </Card>

              {settlements.length > 0 && (
                <Card>
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      {t('loanDetail.settlementAgreements')}
                    </Typography>
                    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                      {settlements.map((s) => (
                        <Chip
                          key={s.id}
                          label={`${s.agreementNo} · ${formatLak(s.agreedAmount, s.currency)} · ${translateStatus(s.status)}`}
                          variant="outlined"
                        />
                      ))}
                    </Stack>
                  </CardContent>
                </Card>
              )}
            </Stack>
          )}

          {tab === 1 && (
            <Box sx={{ pt: 2 }}>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {schedule
                  ? `${t('schedule.periodsCount', { count: schedule.periodCount })} · ${t('schedule.fifoNote')}${
                      declining ? ` · ${t('schedule.interestPerPeriodNote')}` : ''
                    }`
                  : t('common.loading')}
              </Typography>
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>{t('schedule.period.index')}</TableCell>
                      <TableCell>{t('schedule.period.periodStart')}</TableCell>
                      <TableCell>{t('schedule.period.dueDate')}</TableCell>
                      <TableCell align="right">{t('schedule.period.principalDue')}</TableCell>
                      <TableCell align="right">{t('schedule.period.interestDue')}</TableCell>
                      <TableCell align="right">{t('schedule.period.principalPaid')}</TableCell>
                      <TableCell align="right">{t('schedule.period.interestPaid')}</TableCell>
                      <TableCell align="right">{t('schedule.period.relieved')}</TableCell>
                      <TableCell align="right">{t('schedule.period.penaltyAccrued')}</TableCell>
                      <TableCell align="right">{t('schedule.period.penaltyBilled')}</TableCell>
                      <TableCell align="right">{t('schedule.period.outstanding')}</TableCell>
                      <TableCell>{t('loanDetail.status')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {(schedule?.periods ?? []).map((p) => (
                      <TableRow key={p.index} hover>
                        <TableCell>{p.index}</TableCell>
                        <TableCell>{fmtDay(p.periodStart, locale)}</TableCell>
                        <TableCell>{fmtDay(p.dueDate, locale)}</TableCell>
                        <TableCell align="right">{formatLak(p.principalDue, '')}</TableCell>
                        <TableCell align="right">{formatLak(p.interestDue, '')}</TableCell>
                        <TableCell align="right">{formatLak(p.principalPaid, '')}</TableCell>
                        <TableCell align="right">{formatLak(p.interestPaid, '')}</TableCell>
                        <TableCell align="right">{formatLak(p.relieved, '')}</TableCell>
                        <TableCell align="right">{formatLak(p.penaltyAccrued, '')}</TableCell>
                        <TableCell align="right">{formatLak(p.penaltyBilled, '')}</TableCell>
                        <TableCell align="right">{formatLak(p.outstanding, loan.currency)}</TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center' }}>
                            <StatusChip status={p.status} />
                            {p.overdueDays > 0 && (
                              <Typography variant="caption" color="error.main">
                                {t('schedule.period.overdueDays', { days: p.overdueDays })}
                              </Typography>
                            )}
                          </Stack>
                        </TableCell>
                      </TableRow>
                    ))}
                    {schedule && schedule.periods.length === 0 && (
                      <EmptyState colSpan={12} message={t('schedule.noPeriods')} />
                    )}
                  </TableBody>
                </Table>
              </Box>
            </Box>
          )}

          {tab === 2 && (
            <Box sx={{ pt: 2 }}>
              <Typography variant="h6" gutterBottom>
                {t('loanDetail.transactions', { count: data.transactionPagination.total })}
              </Typography>
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>{t('loanDetail.reference')}</TableCell>
                      <TableCell>{t('loanDetail.type')}</TableCell>
                      <TableCell align="right">{t('loanDetail.amount')}</TableCell>
                      <TableCell>{t('loanDetail.allocation')}</TableCell>
                      <TableCell>{t('loanDetail.status')}</TableCell>
                      <TableCell>{t('loanDetail.reason')}</TableCell>
                      <TableCell>{t('loanDetail.createdAt')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {transactions.map((tx) => (
                      <TableRow key={tx.id} hover>
                        <TableCell>
                          <Link to="/transactions">{tx.referenceNo}</Link>
                        </TableCell>
                        <TableCell>{translateStatus(tx.transactionType)}</TableCell>
                        <TableCell align="right">{formatLak(tx.amount, tx.currency)}</TableCell>
                        <TableCell>
                          {tx.componentAmounts
                            ? `${formatLak(tx.componentAmounts.PENALTY, '')} / ${formatLak(tx.componentAmounts.PAST_INTEREST, '')} / ${formatLak(tx.componentAmounts.PAST_PRINCIPAL, '')}`
                            : '—'}
                        </TableCell>
                        <TableCell>
                          <StatusChip status={tx.status} />
                        </TableCell>
                        <TableCell>{tx.reason ?? '—'}</TableCell>
                        <TableCell>{fmtDate(tx.createdAt, locale)}</TableCell>
                      </TableRow>
                    ))}
                    {transactions.length === 0 && (
                      <EmptyState colSpan={7} message={t('schedule.noPayments')} />
                    )}
                  </TableBody>
                </Table>
              </Box>
              <CustomPagination
                page={transactionPage}
                rowsPerPage={transactionsPerPage}
                totalItems={data.transactionPagination.total}
                onPageChange={setTransactionPage}
                onRowsPerPageChange={(value) => {
                  setTransactionsPerPage(value);
                  setTransactionPage(0);
                }}
              />
            </Box>
          )}

          {tab === 3 && (
            <Stack spacing={2} sx={{ pt: 2 }}>
              {!data.credit ? (
                <Alert severity="info">{t('schedule.noCredit')}</Alert>
              ) : (
                <Card variant="outlined">
                  <CardContent>
                    <SummaryRow
                      label={t('credits.available')}
                      value={formatLak(data.credit.balance, data.credit.currency)}
                      strong
                    />
                    <SummaryRow
                      label={t('credits.updated')}
                      value={fmtDate(data.credit.updatedAt, locale)}
                    />
                  </CardContent>
                </Card>
              )}
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>{t('credits.type')}</TableCell>
                      <TableCell align="right">{t('credits.amount')}</TableCell>
                      <TableCell align="right">{t('credits.balanceAfter')}</TableCell>
                      <TableCell>{t('loanDetail.createdAt')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {(ledger?.data.ledger ?? []).map((entry) => (
                      <TableRow key={entry.id} hover>
                        <TableCell>{translateStatus(entry.type)}</TableCell>
                        <TableCell align="right">{formatLak(entry.amount, loan.currency)}</TableCell>
                        <TableCell align="right">{formatLak(entry.balanceAfter, loan.currency)}</TableCell>
                        <TableCell>{fmtDate(entry.createdAt, locale)}</TableCell>
                      </TableRow>
                    ))}
                    {ledger && ledger.data.ledger.length === 0 && (
                      <EmptyState colSpan={4} message={t('credits.noEntries')} />
                    )}
                  </TableBody>
                </Table>
              </Box>
              <CustomPagination
                page={ledgerPage}
                rowsPerPage={ledgerRowsPerPage}
                totalItems={ledger?.pagination.total ?? 0}
                onPageChange={setLedgerPage}
                onRowsPerPageChange={(value) => {
                  setLedgerRowsPerPage(value);
                  setLedgerPage(0);
                }}
              />
            </Stack>
          )}

          {tab === 4 && (
            <Box sx={{ pt: 2 }}>
              <LoanPartiesPanel loanId={loan.id} />
            </Box>
          )}

          {tab === 5 && (
            <Box sx={{ pt: 2 }}>
              <LoanCollateralsPanel loanId={loan.id} />
            </Box>
          )}

          {tab === 6 && (
            <Box sx={{ pt: 2 }}>
              <LoanRestructuresPanel loanId={loan.id} />
            </Box>
          )}

          {tab === 7 && (
            <Box sx={{ pt: 2 }}>
              <LoanDisbursementPanel loan={loan} disbursement={disbursement} />
            </Box>
          )}
        </CardContent>
      </Card>
    </Stack>
  );
}
