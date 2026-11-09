import Checkbox from '@mui/material/Checkbox';
import EmptyState from '../components/EmptyState';
import TableSkeleton from '../components/TableSkeleton';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
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
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, unwrap } from '../api/client';
import {
  formatLak,
  type ApprovalPendingItem,
  type BulkDecisionResult,
  type DueInterestList,
  type InterestAccrualResult,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { OPERATOR_ROLES } from '../auth/roles';
import PageHeader from '../components/PageHeader';
import CustomPagination from '../components/CustomPagination';

const INITIAL_ROWS_PER_PAGE = 10;

interface ApprovalPageData {
  data: ApprovalPendingItem[];
  pagination: { total: number };
}

type DialogState = { kind: 'single'; item: ApprovalPendingItem } | { kind: 'bulk' } | null;

export default function ApprovalsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(INITIAL_ROWS_PER_PAGE);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [bulkResult, setBulkResult] = useState<BulkDecisionResult | null>(null);
  const [accrualNote, setAccrualNote] = useState<string | null>(null);

  const approvalsQuery = useQuery({
    queryKey: ['approvals', 'pending', page, rowsPerPage],
    queryFn: () => api.get<ApprovalPageData>('/approvals/pending', {
      params: { page: page + 1, limit: rowsPerPage },
    }).then((r) => r.data),
  });

  const items = approvalsQuery.data?.data ?? [];
  const pending = items.filter((item) => item.canDecide);
  const selectedIds = pending.filter((item) => checked[item.stepId]).map((item) => item.stepId);
  const allChecked = pending.length > 0 && selectedIds.length === pending.length;

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['approvals'] }),
      queryClient.invalidateQueries({ queryKey: ['transactions'] }),
      queryClient.invalidateQueries({ queryKey: ['settlements'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    ]);

  const decisionMutation = useMutation({
    mutationFn: () => {
      if (dialog?.kind !== 'single') throw new Error('Select an approval first');
      return api.post(`/approvals/steps/${dialog.item.stepId}/decision`, {
        decision,
        reason: reason || undefined,
      });
    },
    onSuccess: async () => {
      await invalidate();
      closeDialog();
      setPage(0);
    },
    onError: (cause: Error) => setError(cause.message),
  });

  /** One click for a whole month of interest charges; each item still passes the same rules. */
  const bulkMutation = useMutation({
    mutationFn: () =>
      api
        .post('/approvals/steps/bulk-decision', {
          stepIds: selectedIds,
          decision,
          reason: decision === 'REJECT' ? reason : reason || undefined,
        })
        .then(unwrap<BulkDecisionResult>),
    onSuccess: async (result) => {
      await invalidate();
      closeDialog();
      setChecked({});
      setBulkResult(result);
      setPage(0);
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const closeDialog = () => {
    setDialog(null);
    setReason('');
    setError(null);
  };

  const openDecision = (item: ApprovalPendingItem, next: 'APPROVE' | 'REJECT') => {
    setDialog({ kind: 'single', item });
    setDecision(next);
    setReason('');
    setError(null);
  };

  const openBulk = (next: 'APPROVE' | 'REJECT') => {
    setDialog({ kind: 'bulk' });
    setDecision(next);
    setReason('');
    setError(null);
    setBulkResult(null);
  };

  const toggleAll = () => {
    const next: Record<string, boolean> = {};
    if (!allChecked) pending.forEach((item) => (next[item.stepId] = true));
    setChecked(next);
  };

  return (
    <Stack spacing={2}>
      <PageHeader title="Approvals" />
      <Alert severity="info">{t('approvals.approvalInfo')}</Alert>
      {approvalsQuery.isError && <Alert severity="error">{(approvalsQuery.error as Error).message}</Alert>}
      <InterestRunCard
        canOperate={Boolean(user && OPERATOR_ROLES.includes(user.role))}
        onAccrued={(note) => {
          setAccrualNote(note);
          queryClient.invalidateQueries({ queryKey: ['approvals'] });
        }}
        note={accrualNote}
        clearNote={() => setAccrualNote(null)}
      />
      {bulkResult && (
        <Alert
          severity={bulkResult.declined === 0 ? 'success' : 'warning'}
          onClose={() => setBulkResult(null)}
        >
          {t('approvals.bulkDone', { decided: bulkResult.decided, declined: bulkResult.declined })}
          {bulkResult.results.some((r) => !r.ok) && (
            <Stack component="ul" sx={{ pl: 2, m: 0 }}>
              {bulkResult.results
                .filter((r) => !r.ok)
                .map((r) => (
                  <li key={r.stepId}>
                    <Typography variant="caption">{r.error}</Typography>
                  </li>
                ))}
            </Stack>
          )}
        </Alert>
      )}
      <Card>
        <CardContent>
          <Stack direction="row" spacing={1} useFlexGap sx={{ mb: 2, alignItems: 'center' }}>
            <Button size="small" variant="outlined" disabled={selectedIds.length === 0} onClick={() => openBulk('APPROVE')}>
              {t('approvals.bulkApprove', { count: selectedIds.length })}
            </Button>
            <Button size="small" variant="outlined" color="error" disabled={selectedIds.length === 0} onClick={() => openBulk('REJECT')}>
              {t('approvals.bulkReject', { count: selectedIds.length })}
            </Button>
            {selectedIds.length > 0 && (
              <Button size="small" onClick={() => setChecked({})}>
                {t('approvals.clearSelection')}
              </Button>
            )}
          </Stack>
          {approvalsQuery.isLoading ? (
            <TableSkeleton columns={6} label={t('common.loading')} />
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox">
                    <Checkbox
                      checked={allChecked}
                      indeterminate={selectedIds.length > 0 && !allChecked}
                      onChange={toggleAll}
                      disabled={pending.length === 0}
                      slotProps={{ input: { 'aria-label': t('approvals.selectAll') } }}
                    />
                  </TableCell>
                  <TableCell>{t('approvals.subject')}</TableCell>
                  <TableCell>{t('common.amount')}</TableCell>
                  <TableCell>{t('approvals.currentApproval')}</TableCell>
                  <TableCell>{t('approvals.remainingSteps')}</TableCell>
                  <TableCell>{t('approvals.decision')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((item) => {
                  const title =
                    item.subject?.kind === 'TRANSACTION'
                      ? `${item.subject.transaction.referenceNo} · ${t(`status.${item.subject.transaction.transactionType}`, { defaultValue: item.subject.transaction.transactionType.replace(/_/g, ' ') })}`
                      : item.subject?.kind === 'SETTLEMENT_AGREEMENT'
                        ? `${item.subject.agreement.agreementNo} · ${t('navigation.settlements')}`
                        : item.subject?.kind === 'RESTRUCTURE_REQUEST'
                          ? `${item.subject.request.requestNo} · ${item.subject.request.changeTypes
                              .map((change) => t(`status.${change}`))
                              .join(' + ')}`
                          : item.subjectId;
                  return (
                    <TableRow key={item.stepId} hover>
                      <TableCell padding="checkbox">
                        <Checkbox
                          checked={Boolean(checked[item.stepId])}
                          disabled={!item.canDecide}
                          onChange={(event) =>
                            setChecked((current) => ({ ...current, [item.stepId]: event.target.checked }))
                          }
                          slotProps={{ input: { 'aria-label': title } }}                        />
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>{title}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {item.blockedForUser ? t('approvals.makerBlocked') : item.subjectId}
                        </Typography>
                      </TableCell>
                      <TableCell>{formatLak(item.amount)}</TableCell>
                      <TableCell>{t(`status.${item.currentLevel}`, { defaultValue: item.currentLevel })}</TableCell>
                      <TableCell>{item.remainingLevels.map((level) => t(`status.${level}`, { defaultValue: level })).join(' → ')}</TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={1}>
                          <Button
                            size="small"
                            disabled={!item.canDecide}
                            onClick={() => openDecision(item, 'APPROVE')}
                          >
                            {t('transactions.approve')}
                          </Button>
                          <Button
                            size="small"
                            color="error"
                            disabled={!item.canDecide}
                            onClick={() => openDecision(item, 'REJECT')}
                          >
                            {t('payments.reject')}
                          </Button>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {items.length === 0 && (
                  <EmptyState colSpan={6} message={t('approvals.noPending')} />
                )}
              </TableBody>
            </Table>
          )}
          <CustomPagination
            page={page}
            rowsPerPage={rowsPerPage}
            totalItems={approvalsQuery.data?.pagination.total ?? 0}
            onPageChange={(value) => {
              setPage(value);
              setChecked({});
            }}
            onRowsPerPageChange={(value) => {
              setRowsPerPage(value);
              setPage(0);
              setChecked({});
            }}
          />
        </CardContent>
      </Card>

      <Dialog open={Boolean(dialog)} onClose={closeDialog} fullWidth maxWidth="sm">
        <DialogTitle>
          {dialog?.kind === 'bulk'
            ? decision === 'APPROVE'
              ? t('approvals.bulkApprove', { count: selectedIds.length })
              : t('approvals.bulkReject', { count: selectedIds.length })
            : decision === 'APPROVE'
              ? t('approvals.approveStep')
              : t('approvals.rejectWorkflow')}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2">
              {dialog?.kind === 'bulk'
                ? t('approvals.bulkInfo')
                : `${
                    dialog ? t(`status.${dialog.item.currentLevel}`, { defaultValue: dialog.item.currentLevel }) : ''
                  } · ${formatLak(dialog?.kind === 'single' ? dialog.item.amount : 0)}`}
            </Typography>
            <TextField
              label={decision === 'REJECT' ? t('payments.rejectionRequired') : t('common.reason')}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required={decision === 'REJECT'}
              multiline
            />
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            color={decision === 'REJECT' ? 'error' : 'primary'}
            disabled={
              decisionMutation.isPending ||
              bulkMutation.isPending ||
              (decision === 'REJECT' && !reason.trim()) ||
              (dialog?.kind === 'bulk' && selectedIds.length === 0)
            }
            onClick={() => (dialog?.kind === 'bulk' ? bulkMutation.mutate() : decisionMutation.mutate())}
          >
            {decision === 'APPROVE' ? t('approvals.confirmApproval') : t('approvals.confirmRejection')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

/**
 * The monthly interest run: what declining-balance loans are waiting to be billed, priced by the
 * server, charged through the same maker-checker flow as everything else on this page.
 */
function InterestRunCard({
  canOperate,
  note,
  clearNote,
  onAccrued,
}: {
  canOperate: boolean;
  note: string | null;
  clearNote: () => void;
  onAccrued: (note: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const dueQuery = useQuery({
    queryKey: ['interest', 'due'],
    queryFn: () => api.get('/transactions/interest/due').then(unwrap<DueInterestList>),
  });

  const accrueMutation = useMutation({
    mutationFn: (body: { loanIds?: string[] }) =>
      api.post('/transactions/interest/accrue', body).then(unwrap<InterestAccrualResult>),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['interest', 'due'] });
      queryClient.invalidateQueries({ queryKey: ['loan'] });
      queryClient.invalidateQueries({ queryKey: ['loans'] });
      setError(null);
      onAccrued(
        result.created.length > 0
          ? t('approvals.interestAccrued', { count: result.created.length, amount: formatLak(result.totals.amount) })
          : t('schedule.interestAccrueNone'),
      );
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const due = dueQuery.data;
  if (!canOperate || !due || due.items.length === 0) return null;

  return (
    <Card>
      <CardContent>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center', mb: 1, flexWrap: 'wrap' }}>
          <Typography variant="h6">{t('approvals.interestRun')}</Typography>
          <Typography variant="body2" color="text.secondary">
            {t('approvals.interestRunTotals', { loans: due.totals.loans, amount: formatLak(due.totals.amount) })}
          </Typography>
          <Button
            size="small"
            variant="contained"
            disabled={accrueMutation.isPending}
            onClick={() => accrueMutation.mutate({})}
          >
            {t('approvals.interestRunChargeAll')}
          </Button>
        </Stack>
        <Typography variant="caption" color="text.secondary">
          {t('approvals.interestRunInfo')}
        </Typography>
        <Box sx={{ overflowX: 'auto', mt: 1 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('common.loan')}</TableCell>
                <TableCell>{t('common.customer')}</TableCell>
                <TableCell align="right">{t('schedule.interestPeriod')}</TableCell>
                <TableCell align="right">{t('schedule.interestBase')}</TableCell>
                <TableCell align="right">{t('common.amount')}</TableCell>
                <TableCell align="right">{t('common.actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {due.items.map((item) => (
                <TableRow key={`${item.loanId}-${item.periodIndex}`} hover>
                  <TableCell>{item.loanNumber}</TableCell>
                  <TableCell>{item.customerName ?? item.customerId}</TableCell>
                  <TableCell align="right">
                    {t('schedule.interestPeriodValue', { current: item.periodIndex, total: item.termPeriods })}
                  </TableCell>
                  <TableCell align="right">{formatLak(item.baseOutstandingPrincipal)}</TableCell>
                  <TableCell align="right">{formatLak(item.amount)}</TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      disabled={accrueMutation.isPending}
                      onClick={() => accrueMutation.mutate({ loanIds: [item.loanId] })}
                    >
                      {t('schedule.interestAccrueOne')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
        {note && (
          <Alert severity="success" sx={{ mt: 1 }} onClose={clearNote}>
            {note}
          </Alert>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 1 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
