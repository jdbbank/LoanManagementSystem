import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
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
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, unwrap } from '../api/client';
import {
  RESTRUCTURE_CHANGE_TYPES,
  RestructureChangeType,
  RestructureStatus,
  LoanPartyStatus,
  formatLak,
  type LoanPartiesView,
  type LoanTermSnapshot,
  type RestructureContext,
  type RestructureRequest,
  type RestructureState,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { OPERATOR_ROLES } from '../auth/roles';
import EmptyState from './EmptyState';
import MoneyTextField from './MoneyTextField';
import StatusChip from './StatusChip';
import TableSkeleton from './TableSkeleton';

/** Same ceiling the server enforces on a restructured term. */
const MAX_RESTRUCTURED_TERM_MONTHS = 600;

function fmtDateTime(value: string | null, locale: string): string {
  return value ? new Date(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

/**
 * The hardship desk for one loan: a borrower who can no longer pay as contracted gets a written
 * addendum — a lower rate, a longer term, a replacement payer, relief of the interest that piled up, or
 * any mix of them — and that paper goes through the same maker-checker engine as everything else here.
 * Approval alone changes nothing; an operator applies it, and relief only reaches the ledger as a waiver
 * that is approved and posted in its own right.
 */
export default function LoanRestructuresPanel({ loanId }: { loanId: string }) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [changes, setChanges] = useState<RestructureChangeType[]>([]);
  const [rate, setRate] = useState('');
  const [termMonths, setTermMonths] = useState('');
  const [payerCustomerId, setPayerCustomerId] = useState('');
  const [relief, setRelief] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const canWrite = Boolean(user && OPERATOR_ROLES.includes(user.role));
  const locale = i18n.resolvedLanguage?.startsWith('lo') ? 'lo-LA' : 'en-GB';

  const requestsQuery = useQuery({
    queryKey: ['loan', loanId, 'restructures'],
    queryFn: () =>
      api
        .get<{ data: RestructureRequest[] }>('/restructures', { params: { loanId, limit: 50 } })
        .then((response) => response.data.data),
  });

  /** What the loan looks like to a hardship decision right now, including the payer being proposed. */
  const contextQuery = useQuery({
    queryKey: ['loan', loanId, 'restructure-context', payerCustomerId],
    queryFn: () =>
      api
        .get(`/restructures/context/${loanId}`, {
          params: payerCustomerId ? { payerCustomerId } : undefined,
        })
        .then(unwrap<RestructureContext>),
    enabled: open,
  });

  const detailQuery = useQuery({
    queryKey: ['restructure', detailId],
    queryFn: () => api.get(`/restructures/${detailId}`).then(unwrap<RestructureState>),
    enabled: Boolean(detailId),
  });

  const partiesQuery = useQuery({
    queryKey: ['loan', loanId, 'parties'],
    queryFn: () => api.get(`/loans/${loanId}/parties`).then(unwrap<LoanPartiesView>),
    enabled: open,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.post('/restructures', {
        loanId,
        hardshipReason: reason,
        changeTypes: changes,
        newInterestRate: changes.includes(RestructureChangeType.INTEREST_RATE_REDUCTION) ? Number(rate) : null,
        newTermMonths: changes.includes(RestructureChangeType.TERM_EXTENSION) ? Number(termMonths) : null,
        newPayerCustomerId: changes.includes(RestructureChangeType.PAYER_CHANGE) ? payerCustomerId : null,
        interestReliefAmount: changes.includes(RestructureChangeType.INTEREST_RELIEF) ? Number(relief) : 0,
      }),
    onSuccess: async (response) => {
      const request = (response.data as { data: RestructureRequest }).data;
      await queryClient.invalidateQueries({ queryKey: ['loan', loanId, 'restructures'] });
      setOpen(false);
      setReason('');
      setChanges([]);
      setRate('');
      setTermMonths('');
      setPayerCustomerId('');
      setRelief('');
      setError(null);
      setNote(t('hardship.restructure.createdNote', { requestNo: request.requestNo }));
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const applyMutation = useMutation({
    mutationFn: (id: string) => api.post(`/restructures/${id}/apply`, {}).then(unwrap<RestructureState>),
    onSuccess: async (state) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['loan', loanId] }),
        queryClient.invalidateQueries({ queryKey: ['loans'] }),
        queryClient.invalidateQueries({ queryKey: ['approvals'] }),
        queryClient.invalidateQueries({ queryKey: ['transactions'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
      setDetailId(null);
      setError(null);
      setNote(
        state.waiver
          ? t('hardship.restructure.appliedWithRelief', {
              requestNo: state.request.requestNo,
              waiver: state.waiver.referenceNo,
            })
          : t('hardship.restructure.applied', { requestNo: state.request.requestNo }),
      );
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const context = contextQuery.data;
  const asked = new Set(changes);
  const proposedPayer = context?.proposedPayer ?? null;

  const problems: string[] = [];
  if (reason.trim().length < 10) problems.push(t('hardship.restructure.needReason'));
  if (changes.length === 0) problems.push(t('hardship.restructure.needChanges'));
  if (asked.has(RestructureChangeType.INTEREST_RATE_REDUCTION)) {
    const value = Number(rate);
    if (!rate || !Number.isFinite(value) || value <= 0) problems.push(t('hardship.restructure.needRate'));
    else if (context && value >= context.before.interestRate) problems.push(t('hardship.restructure.rateNotLower'));
  }
  if (asked.has(RestructureChangeType.TERM_EXTENSION)) {
    const value = Number(termMonths);
    if (!termMonths || !Number.isInteger(value) || value <= 0) problems.push(t('hardship.restructure.needTerm'));
    else if (context && value <= context.before.termMonths) problems.push(t('hardship.restructure.termNotLonger'));
    else if (value > MAX_RESTRUCTURED_TERM_MONTHS)
      problems.push(t('hardship.restructure.termTooLong', { max: MAX_RESTRUCTURED_TERM_MONTHS }));
  }
  if (asked.has(RestructureChangeType.PAYER_CHANGE)) {
    if (!payerCustomerId) problems.push(t('hardship.restructure.needPayer'));
    else if (proposedPayer && !proposedPayer.kyc.effective) problems.push(t('hardship.restructure.payerKyc'));
  }
  if (asked.has(RestructureChangeType.INTEREST_RELIEF)) {
    const value = Number(relief);
    if (!relief || value <= 0) problems.push(t('hardship.restructure.needRelief'));
    else if (context && value > context.accruedInterest) problems.push(t('hardship.restructure.reliefTooBig'));
  }

  const toggleChange = (change: RestructureChangeType, checked: boolean) => {
    setNote(null);
    setChanges((current) => {
      if (checked) return current.includes(change) ? current : [...current, change];
      return current.filter((item) => item !== change);
    });
  };

  const activeParties = (partiesQuery.data?.parties ?? []).filter(
    (row) => row.party.status === LoanPartyStatus.ACTIVE && row.party.customerId !== context?.loan.customerId,
  );

  const requests = requestsQuery.data ?? [];
  const currency = context?.loan.currency ?? requests[0]?.currency ?? 'LAK';

  return (
    <Stack spacing={2}>
      <Alert severity="info">{t('hardship.restructure.info')}</Alert>
      {note && (
        <Alert severity="success" onClose={() => setNote(null)}>
          {note}
        </Alert>
      )}
      {error && <Alert severity="error">{error}</Alert>}

      {canWrite && (
        <Button
          variant="contained"
          onClick={() => {
            setOpen(true);
            setNote(null);
            setError(null);
          }}
          sx={{ alignSelf: 'flex-start' }}
        >
          {t('hardship.restructure.new')}
        </Button>
      )}

      {requestsQuery.isLoading ? (
        <TableSkeleton columns={6} label={t('common.loading')} />
      ) : (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('hardship.restructure.requestNo')}</TableCell>
                <TableCell>{t('hardship.restructure.changes')}</TableCell>
                <TableCell align="right">{t('hardship.restructure.repriced')}</TableCell>
                <TableCell>{t('common.status')}</TableCell>
                <TableCell>{t('hardship.restructure.created')}</TableCell>
                <TableCell align="right">{t('common.actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {requests.map((item) => (
                <TableRow key={item.id} hover>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {item.requestNo}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {item.hardshipReason}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                      {item.changeTypes.map((change) => (
                        <Chip key={change} size="small" variant="outlined" label={t(`status.${change}`)} />
                      ))}
                    </Stack>
                  </TableCell>
                  <TableCell align="right">{formatLak(item.repricingAmount, item.currency)}</TableCell>
                  <TableCell>
                    <Stack spacing={0.5}>
                      <StatusChip status={item.status} />
                      {item.status === RestructureStatus.REJECTED && item.decisionReason && (
                        <Typography variant="caption" color="error.main">
                          {item.decisionReason}
                        </Typography>
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell>{fmtDateTime(item.createdAt, locale)}</TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
                      <Button size="small" onClick={() => setDetailId(item.id)}>
                        {t('hardship.restructure.open')}
                      </Button>
                      {canWrite && item.status === RestructureStatus.APPROVED && (
                        <Button
                          size="small"
                          variant="contained"
                          disabled={applyMutation.isPending}
                          onClick={() => applyMutation.mutate(item.id)}
                        >
                          {t('hardship.restructure.apply')}
                        </Button>
                      )}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
              {requests.length === 0 && <EmptyState colSpan={6} message={t('hardship.restructure.none')} />}
            </TableBody>
          </Table>
        </Box>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>{t('hardship.restructure.newDialog')}</DialogTitle>
        <DialogContent>
          {!context ? (
            <Typography sx={{ py: 3 }}>{t('common.loading')}</Typography>
          ) : (
            <Stack spacing={2} sx={{ pt: 1 }}>
              <Stack divider={<Divider flexItem />} spacing={1}>
                <Typography variant="body2">
                  {t('hardship.restructure.outstanding', {
                    amount: formatLak(context.outstanding, currency),
                  })}
                </Typography>
                <Typography variant="body2">
                  {t('hardship.restructure.interestOwed', {
                    amount: formatLak(context.accruedInterest, currency),
                  })}
                </Typography>
                <Typography variant="body2">
                  {t('hardship.restructure.currentTerms', {
                    rate: t('products.rateDisplay', {
                      rate: context.before.interestRate,
                      unit: t(`units.${context.before.interestRatePeriod}`),
                    }),
                    months: context.before.termMonths,
                    payer: context.before.payerCustomerId
                      ? (activeParties.find((row) => row.party.customerId === context.before.payerCustomerId)?.customer
                          ?.fullName ?? context.before.payerCustomerId)
                      : t('hardship.restructure.payerIsBorrower'),
                  })}
                </Typography>
                <Typography variant="caption" color={context.coverage.passed ? 'text.secondary' : 'error.main'}>
                  {context.coverage.passed
                    ? t('hardship.restructure.coverageOk', { percent: context.coverage.coveragePercent })
                    : `${t('hardship.restructure.coverageBroken')}: ${context.coverage.reasons.join('; ')}`}
                </Typography>
                {context.coverage.warnings.length > 0 && (
                  <Typography variant="caption" color="warning.main">
                    {context.coverage.warnings.join(' · ')}
                  </Typography>
                )}
              </Stack>
              <Typography variant="caption" color="text.secondary">
                {t('hardship.restructure.approvalFloor')}
              </Typography>

              <TextField
                label={`${t('hardship.restructure.reason')} *`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={t('hardship.restructure.reasonHelper')}
                multiline
                minRows={3}
                slotProps={{ htmlInput: { maxLength: 2000 } }}
                fullWidth
              />

              <Typography variant="subtitle2">{t('hardship.restructure.changes')}</Typography>
              <Stack spacing={0.5}>
                {RESTRUCTURE_CHANGE_TYPES.map((change) => (
                  <FormControlLabel
                    key={change}
                    control={
                      <Checkbox
                        checked={asked.has(change)}
                        onChange={(event) => toggleChange(change, event.target.checked)}
                      />
                    }
                    label={t(`status.${change}`)}
                  />
                ))}
              </Stack>

              {asked.has(RestructureChangeType.INTEREST_RATE_REDUCTION) && (
                <TextField
                  label={`${t('hardship.restructure.rate')} *`}
                  type="number"
                  slotProps={{ htmlInput: { step: '0.000001', min: '0' } }}
                  value={rate}
                  onChange={(event) => setRate(event.target.value)}
                  helperText={t('hardship.restructure.rateHelper', {
                    rate: context.before.interestRate,
                    unit: t(`units.${context.before.interestRatePeriod}`),
                  })}
                  fullWidth
                  sx={{ maxWidth: 320 }}
                />
              )}

              {asked.has(RestructureChangeType.TERM_EXTENSION) && (
                <TextField
                  label={`${t('hardship.restructure.term')} *`}
                  type="number"
                  slotProps={{ htmlInput: { step: '1', min: '1', max: String(MAX_RESTRUCTURED_TERM_MONTHS) } }}
                  value={termMonths}
                  onChange={(event) => setTermMonths(event.target.value)}
                  helperText={t('hardship.restructure.termHelper', {
                    months: context.before.termMonths,
                    max: MAX_RESTRUCTURED_TERM_MONTHS,
                  })}
                  fullWidth
                  sx={{ maxWidth: 320 }}
                />
              )}

              {asked.has(RestructureChangeType.PAYER_CHANGE) && (
                <Stack spacing={1}>
                  <TextField
                    select
                    label={`${t('hardship.restructure.payer')} *`}
                    value={payerCustomerId}
                    onChange={(event) => setPayerCustomerId(event.target.value)}
                    fullWidth
                    sx={{ maxWidth: 420 }}
                  >
                    {activeParties.map((row) => (
                      <MenuItem key={row.party.customerId} value={row.party.customerId}>
                        {row.customer?.fullName ?? row.party.customerId} · {t(`status.${row.party.role}`)}
                      </MenuItem>
                    ))}
                  </TextField>
                  {activeParties.length === 0 && (
                    <Alert severity="warning">{t('hardship.restructure.noPayerCandidates')}</Alert>
                  )}
                  {proposedPayer && (
                    <Alert severity={proposedPayer.kyc.effective ? 'success' : 'warning'}>
                      {proposedPayer.fullName} ·{' '}
                      {proposedPayer.kyc.effective
                        ? t('hardship.parties.effective')
                        : `${t(`hardship.kycAction.${proposedPayer.kyc.nextAction}`)} — ${proposedPayer.kyc.hint}`}
                    </Alert>
                  )}
                </Stack>
              )}

              {asked.has(RestructureChangeType.INTEREST_RELIEF) && (
                <MoneyTextField
                  label={`${t('hardship.restructure.relief')} *`}
                  minValue={0.01}
                  value={relief}
                  onChange={setRelief}
                  helperText={t('hardship.restructure.reliefHelper', {
                    amount: formatLak(context.accruedInterest, currency),
                  })}
                  fullWidth
                  sx={{ maxWidth: 320 }}
                />
              )}

              {problems.length > 0 && (
                <Alert severity="warning">
                  <Stack component="ul" sx={{ pl: 2, m: 0 }}>
                    {problems.map((line) => (
                      <li key={line}>
                        <Typography variant="body2">{line}</Typography>
                      </li>
                    ))}
                  </Stack>
                </Alert>
              )}
              {contextQuery.isError && (
                <Alert severity="error">{(contextQuery.error as Error).message}</Alert>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            disabled={problems.length > 0 || createMutation.isPending || !context}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? t('common.processing') : t('hardship.restructure.submit')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(detailId)} onClose={() => setDetailId(null)} fullWidth maxWidth="md">
        <DialogTitle>{t('hardship.restructure.detail')}</DialogTitle>
        <DialogContent>
          {!detailQuery.data ? (
            <Typography sx={{ py: 3 }}>{t('common.loading')}</Typography>
          ) : (
            <RestructureDetail state={detailQuery.data} locale={locale} />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDetailId(null)}>{t('common.close')}</Button>
          {canWrite && detailQuery.data?.request.status === RestructureStatus.APPROVED && (
            <Button
              variant="contained"
              disabled={applyMutation.isPending}
              onClick={() => applyMutation.mutate(detailQuery.data!.request.id)}
            >
              {t('hardship.restructure.apply')}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

/** The paper as an approver or auditor needs it: what was asked, what the security looked like, what came of it. */
function RestructureDetail({ state, locale }: { state: RestructureState; locale: string }) {
  const { t } = useTranslation();
  const { request, loan, waiver } = state;
  const line = (label: string, value: string) => (
    <Stack direction="row" sx={{ justifyContent: 'space-between' }} spacing={2}>
      <Typography color="text.secondary">{label}</Typography>
      <Typography sx={{ fontWeight: 600, textAlign: 'right' }}>{value}</Typography>
    </Stack>
  );
  const terms = (snapshot: LoanTermSnapshot) =>
    t('hardship.restructure.termsValue', {
      rate: t('products.rateDisplay', { rate: snapshot.interestRate, unit: t(`units.${snapshot.interestRatePeriod}`) }),
      months: snapshot.termMonths,
    });

  return (
    <Stack spacing={2} sx={{ pt: 1 }}>
      <Stack spacing={0.5}>
        <Typography variant="h6">{request.requestNo}</Typography>
        <Typography variant="body2" color="text.secondary">
          {request.hardshipReason}
        </Typography>
      </Stack>
      <Stack divider={<Divider flexItem />} spacing={1}>
        {line(t('common.loan'), loan.loanNumber)}
        {line(t('common.status'), t(`status.${request.status}`))}
        {line(t('hardship.restructure.changes'), request.changeTypes.map((change) => t(`status.${change}`)).join(' · '))}
        {line(t('hardship.restructure.termsBefore'), terms(request.beforeTerms))}
        {line(t('hardship.restructure.termsAfter'), terms(request.afterTerms))}
        {line(
          t('hardship.restructure.repriced'),
          formatLak(request.repricingAmount, request.currency),
        )}
        {request.interestReliefAmount > 0 &&
          line(
            t('hardship.restructure.relief'),
            formatLak(request.interestReliefAmount, request.currency),
          )}
        {line(
          t('hardship.restructure.nowOutstanding'),
          formatLak(loan.outstanding, request.currency),
        )}
        {line(t('hardship.restructure.created'), fmtDateTime(request.createdAt, locale))}
        {request.decidedAt && line(t('hardship.restructure.decided'), fmtDateTime(request.decidedAt, locale))}
        {request.decisionReason && line(t('common.reason'), request.decisionReason)}
        {request.appliedAt && line(t('hardship.restructure.appliedAt'), fmtDateTime(request.appliedAt, locale))}
      </Stack>

      {request.collateralSnapshot && (
        <Alert severity={request.collateralSnapshot.passed ? 'success' : 'error'}>
          {t('hardship.restructure.coverageAtSubmission', {
            percent: request.collateralSnapshot.coveragePercent,
            required: request.collateralSnapshot.requiredCoveragePercent,
          })}
          {request.collateralSnapshot.reasons.length > 0 && (
            <Typography sx={{ display: 'block' }}>{request.collateralSnapshot.reasons.join('; ')}</Typography>
          )}
          {request.collateralSnapshot.warnings.length > 0 && (
            <Typography sx={{ display: 'block' }}>{request.collateralSnapshot.warnings.join(' · ')}</Typography>
          )}
        </Alert>
      )}

      {waiver && (
        <Alert severity="info">
          {t('hardship.restructure.waiverRow', {
            reference: waiver.referenceNo,
            amount: formatLak(waiver.amount, waiver.currency),
            status: t(`status.${waiver.status}`),
          })}{' '}
          <Link to="/transactions">{t('hardship.restructure.waiverLink')}</Link>
        </Alert>
      )}
    </Stack>
  );
}
