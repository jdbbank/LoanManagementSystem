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
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { formatLak, type ApprovalPendingItem } from '../api/types';
import PageHeader from '../components/PageHeader';
import CustomPagination from '../components/CustomPagination';

const INITIAL_ROWS_PER_PAGE = 10;

interface ApprovalPageData {
  data: ApprovalPendingItem[];
  pagination: { total: number };
}

export default function ApprovalsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ApprovalPendingItem | null>(null);
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(INITIAL_ROWS_PER_PAGE);

  const approvalsQuery = useQuery({
    queryKey: ['approvals', 'pending', page, rowsPerPage],
    queryFn: () => api.get<ApprovalPageData>('/approvals/pending', {
      params: { page: page + 1, limit: rowsPerPage },
    }).then((r) => r.data),
  });

  const decisionMutation = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('Select an approval first');
      return api.post(`/approvals/steps/${selected.stepId}/decision`, { decision, reason: reason || undefined });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['approvals'] }),
        queryClient.invalidateQueries({ queryKey: ['transactions'] }),
        queryClient.invalidateQueries({ queryKey: ['settlements'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
      setSelected(null);
      setReason('');
      setError(null);
      setPage(0);
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const openDecision = (item: ApprovalPendingItem, next: 'APPROVE' | 'REJECT') => {
    setSelected(item);
    setDecision(next);
    setReason('');
    setError(null);
  };

  return (
    <Stack spacing={2}>
      <PageHeader title="Approvals" />
      <Alert severity="info">{t('approvals.approvalInfo')}</Alert>
      {approvalsQuery.isError && <Alert severity="error">{(approvalsQuery.error as Error).message}</Alert>}
      <Card>
        <CardContent>
          {approvalsQuery.isLoading ? (
            <Stack sx={{ alignItems: 'center', py: 4 }}><CircularProgress /></Stack>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('approvals.subject')}</TableCell>
                  <TableCell>{t('common.amount')}</TableCell>
                  <TableCell>{t('approvals.currentApproval')}</TableCell>
                  <TableCell>{t('approvals.remainingSteps')}</TableCell>
                  <TableCell>{t('approvals.decision')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(approvalsQuery.data?.data ?? []).map((item) => {
                  const title =
                    item.subject?.kind === 'TRANSACTION'
                      ? `${item.subject.transaction.referenceNo} · ${t(`status.${item.subject.transaction.transactionType}`, { defaultValue: item.subject.transaction.transactionType.replace(/_/g, ' ') })}`
                      : item.subject?.kind === 'SETTLEMENT_AGREEMENT'
                        ? `${item.subject.agreement.agreementNo} · ${t('navigation.settlements')}`
                        : item.subjectId;
                  return (
                    <TableRow key={item.stepId} hover>
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
                {approvalsQuery.data?.data.length === 0 && (
                  <TableRow><TableCell colSpan={5} align="center">{t('approvals.noPending')}</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          )}
          <CustomPagination
            page={page}
            rowsPerPage={rowsPerPage}
            totalItems={approvalsQuery.data?.pagination.total ?? 0}
            onPageChange={setPage}
            onRowsPerPageChange={(value) => {
              setRowsPerPage(value);
              setPage(0);
            }}
          />
        </CardContent>
      </Card>

      <Dialog open={Boolean(selected)} onClose={() => setSelected(null)} fullWidth maxWidth="sm">
        <DialogTitle>{decision === 'APPROVE' ? t('approvals.approveStep') : t('approvals.rejectWorkflow')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2">
              {selected ? t(`status.${selected.currentLevel}`, { defaultValue: selected.currentLevel }) : ''} · {formatLak(selected?.amount ?? 0)}
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
          <Button onClick={() => setSelected(null)}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            color={decision === 'REJECT' ? 'error' : 'primary'}
            disabled={decisionMutation.isPending || (decision === 'REJECT' && !reason.trim())}
            onClick={() => decisionMutation.mutate()}
          >
            {decision === 'APPROVE' ? t('approvals.confirmApproval') : t('approvals.confirmRejection')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
