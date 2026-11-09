import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
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
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, unwrap } from '../api/client';
import {
  RESTRUCTURE_STATUSES,
  RestructureStatus,
  formatLak,
  type RestructureRequest,
  type RestructureState,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { OPERATOR_ROLES } from '../auth/roles';
import CustomPagination from '../components/CustomPagination';
import EmptyState from '../components/EmptyState';
import PageHeader from '../components/PageHeader';
import StatusChip from '../components/StatusChip';
import TableSkeleton from '../components/TableSkeleton';

const INITIAL_ROWS_PER_PAGE = 10;
const ALL_STATUSES = '';

interface RestructuresResponse {
  data: RestructureRequest[];
  pagination: { page: number; limit: number; total: number };
}

function fmtDateTime(value: string | null, locale: string): string {
  return value ? new Date(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

/**
 * The hardship book across every loan: which addendums are waiting, which are approved and waiting to be
 * put into force, and what each one re-prices. Approval happens on the Approvals page; applying an
 * approved addendum happens here or on the loan itself, by an operator rather than the approver.
 */
export default function RestructuresPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(INITIAL_ROWS_PER_PAGE);
  const [status, setStatus] = useState<string>(ALL_STATUSES);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const canWrite = Boolean(user && OPERATOR_ROLES.includes(user.role));
  const locale = i18n.resolvedLanguage?.startsWith('lo') ? 'lo-LA' : 'en-GB';

  const requestsQuery = useQuery({
    queryKey: ['restructures', page, rowsPerPage, status],
    placeholderData: keepPreviousData,
    queryFn: () =>
      api
        .get<RestructuresResponse>('/restructures', {
          params: {
            page: page + 1,
            limit: rowsPerPage,
            status: status || undefined,
          },
        })
        .then((response) => response.data),
  });

  const applyMutation = useMutation({
    mutationFn: (id: string) => api.post(`/restructures/${id}/apply`, {}).then(unwrap<RestructureState>),
    onSuccess: async (state) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['restructures'] }),
        queryClient.invalidateQueries({ queryKey: ['loan'] }),
        queryClient.invalidateQueries({ queryKey: ['loans'] }),
        queryClient.invalidateQueries({ queryKey: ['transactions'] }),
        queryClient.invalidateQueries({ queryKey: ['approvals'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
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

  const rows = requestsQuery.data?.data ?? [];
  const total = requestsQuery.data?.pagination.total ?? 0;

  return (
    <Stack spacing={2}>
      <PageHeader title="Hardship Addendums" />
      <Alert severity="info">{t('hardship.restructure.bookInfo')}</Alert>
      {note && (
        <Alert severity="success" onClose={() => setNote(null)}>
          {note}
        </Alert>
      )}
      {error && <Alert severity="error">{error}</Alert>}

      <Card>
        <CardContent>
          <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap', alignItems: 'center' }}>
            <TextField
              select
              size="small"
              label={t('common.status')}
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(0);
              }}
              sx={{ minWidth: 200 }}
            >
              <MenuItem value={ALL_STATUSES}>{t('loans.all')}</MenuItem>
              {RESTRUCTURE_STATUSES.map((item) => (
                <MenuItem key={item} value={item}>
                  {t(`status.${item}`)}
                </MenuItem>
              ))}
            </TextField>
            <Typography variant="body2" color="text.secondary">
              {t('hardship.restructure.countLabel', { total })}
            </Typography>
          </Stack>

          {requestsQuery.isLoading ? (
            <TableSkeleton columns={7} label={t('common.loading')} />
          ) : (
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t('hardship.restructure.requestNo')}</TableCell>
                    <TableCell>{t('common.loan')}</TableCell>
                    <TableCell>{t('hardship.restructure.changes')}</TableCell>
                    <TableCell align="right">{t('hardship.restructure.repriced')}</TableCell>
                    <TableCell>{t('common.status')}</TableCell>
                    <TableCell>{t('hardship.restructure.created')}</TableCell>
                    <TableCell align="right">{t('common.actions')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((item) => (
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
                        <Link to={`/loans/${item.loanId}`}>{t('hardship.restructure.openLoan')}</Link>
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
                        {canWrite && item.status === RestructureStatus.APPROVED ? (
                          <Button
                            size="small"
                            variant="contained"
                            disabled={applyMutation.isPending}
                            onClick={() => applyMutation.mutate(item.id)}
                          >
                            {t('hardship.restructure.apply')}
                          </Button>
                        ) : (
                          <Typography variant="caption" color="text.secondary">
                            {item.status === RestructureStatus.PENDING_APPROVAL
                              ? t('hardship.restructure.awaitingApproval')
                              : '—'}
                          </Typography>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {rows.length === 0 && <EmptyState colSpan={7} message={t('hardship.restructure.noRows')} />}
                </TableBody>
              </Table>
            </Box>
          )}
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
    </Stack>
  );
}
