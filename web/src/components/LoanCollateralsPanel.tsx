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
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, unwrap } from '../api/client';
import {
  COLLATERAL_TYPES,
  CollateralStatus,
  CollateralType,
  LoanPartyStatus,
  formatLak,
  type CollateralView,
  type LoanCollateral,
  type LoanPartiesView,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { OPERATOR_ROLES, canRelease } from '../auth/roles';
import EmptyState from './EmptyState';
import MoneyTextField from './MoneyTextField';
import StatusChip from './StatusChip';
import TableSkeleton from './TableSkeleton';

function fmtDay(value: string | null, locale: string): string {
  return value ? new Date(value).toLocaleDateString(locale, { dateStyle: 'medium' }) : '—';
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * What is pledged against the loan and whether it still covers the debt under the live collateral policy.
 * The coverage the server computes here is the same check a hardship addendum has to clear, so a branch
 * never learns about a shortfall from a rejected request.
 */
export default function LoanCollateralsPanel({ loanId }: { loanId: string }) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<CollateralType>(COLLATERAL_TYPES[0]);
  const [description, setDescription] = useState('');
  const [certificateNo, setCertificateNo] = useState('');
  const [appraisedValue, setAppraisedValue] = useState('');
  const [valuedAt, setValuedAt] = useState(today);
  const [ownerCustomerId, setOwnerCustomerId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<LoanCollateral | null>(null);
  const [reason, setReason] = useState('');
  const [releaseError, setReleaseError] = useState<string | null>(null);

  const canWrite = Boolean(user && OPERATOR_ROLES.includes(user.role));
  const mayRelease = canRelease(user?.role);
  const locale = i18n.resolvedLanguage?.startsWith('lo') ? 'lo-LA' : 'en-GB';

  const collateralQuery = useQuery({
    queryKey: ['loan', loanId, 'collaterals'],
    queryFn: () => api.get(`/loans/${loanId}/collaterals`).then(unwrap<CollateralView>),
  });

  /** Only the borrower or someone with an active role on this loan may own a pledge. */
  const partiesQuery = useQuery({
    queryKey: ['loan', loanId, 'parties'],
    queryFn: () => api.get(`/loans/${loanId}/parties`).then(unwrap<LoanPartiesView>),
  });

  const registerMutation = useMutation({
    mutationFn: () =>
      api.post(`/loans/${loanId}/collaterals`, {
        type,
        description,
        certificateNo: certificateNo || undefined,
        appraisedValue: Number(appraisedValue),
        valuedAt,
        ownerCustomerId: ownerCustomerId || undefined,
        note: note || undefined,
      }),
    onSuccess: async () => {
      await refresh();
      setOpen(false);
      setDescription('');
      setCertificateNo('');
      setAppraisedValue('');
      setValuedAt(today());
      setOwnerCustomerId('');
      setNote('');
      setError(null);
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const releaseMutation = useMutation({
    mutationFn: () =>
      api.post(`/loans/${loanId}/collaterals/${releaseTarget?.id}/release`, {
        reason,
      }),
    onSuccess: async () => {
      await refresh();
      setReleaseTarget(null);
      setReason('');
      setReleaseError(null);
    },
    onError: (cause: Error) => setReleaseError(cause.message),
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['loan', loanId, 'collaterals'] }),
      queryClient.invalidateQueries({ queryKey: ['loan', loanId, 'restructures'] }),
    ]);

  const view = collateralQuery.data;
  const coverage = view?.coverage;
  const ownerOptions: Array<{ id: string; label: string }> = partiesQuery.data
    ? [
        {
          id: partiesQuery.data.loan.customerId,
          label: `${partiesQuery.data.loan.customerName} · ${t('hardship.collateral.borrowerOwner')}`,
        },
        ...partiesQuery.data.parties
          .filter((row) => row.party.status === LoanPartyStatus.ACTIVE && row.customer)
          .map((row) => ({
            id: row.party.customerId,
            label: `${row.customer?.fullName ?? row.party.customerId} · ${t(`status.${row.party.role}`)}`,
          })),
      ]
    : [];
  const ownerLabel = (customerId: string | null): string =>
    customerId ? (ownerOptions.find((option) => option.id === customerId)?.label ?? customerId) : '—';

  return (
    <Stack spacing={2}>
      <Alert severity="info">{t('hardship.collateral.info')}</Alert>

      {coverage && (
        <Card variant="outlined">
          <CardContent>
            <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', mb: 1, flexWrap: 'wrap' }}>
              <Typography variant="h6">{t('hardship.collateral.coverageTitle')}</Typography>
              <Chip
                size="small"
                variant="outlined"
                color={coverage.passed ? 'success' : 'error'}
                label={t(coverage.passed ? 'hardship.collateral.covered' : 'hardship.collateral.uncovered')}
              />
            </Stack>
            <Stack spacing={0.5}>
              <Typography variant="body2">
                {t('hardship.collateral.coveragePercent', {
                  percent: coverage.coveragePercent,
                  required: coverage.requiredCoveragePercent,
                })}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t('hardship.collateral.coverageAmounts', {
                  pledged: coverage.pledgedCount,
                  counted: formatLak(coverage.appraisedTotal, view?.loan.currency),
                  outstanding: formatLak(coverage.outstanding, view?.loan.currency),
                })}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {coverage.valuationMaxAgeDays > 0
                  ? t('hardship.collateral.valuationAge', {
                      oldest: fmtDay(coverage.oldestValuedAt, locale),
                      max: coverage.valuationMaxAgeDays,
                    })
                  : t('hardship.collateral.valuationAgeNever', {
                      oldest: fmtDay(coverage.oldestValuedAt, locale),
                    })}
              </Typography>
            </Stack>
            {coverage.reasons.map((line) => (
              <Alert key={line} severity="error" sx={{ mt: 1 }}>
                {line}
              </Alert>
            ))}
            {coverage.warnings.map((line) => (
              <Alert key={line} severity="warning" sx={{ mt: 1 }}>
                {line}
              </Alert>
            ))}
          </CardContent>
        </Card>
      )}

      {canWrite && (
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => {
            setType(COLLATERAL_TYPES[0]);
            setValuedAt(today());
            setOpen(true);
          }}
          sx={{ alignSelf: 'flex-start' }}
        >
          {t('hardship.collateral.pledge')}
        </Button>
      )}
      {collateralQuery.isError && <Alert severity="error">{(collateralQuery.error as Error).message}</Alert>}

      {collateralQuery.isLoading ? (
        <TableSkeleton columns={7} label={t('common.loading')} />
      ) : (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('hardship.collateral.item')}</TableCell>
                <TableCell>{t('common.type')}</TableCell>
                <TableCell align="right">{t('hardship.collateral.appraised')}</TableCell>
                <TableCell>{t('hardship.collateral.valuedAt')}</TableCell>
                <TableCell>{t('hardship.collateral.owner')}</TableCell>
                <TableCell>{t('common.status')}</TableCell>
                <TableCell align="right">{t('common.actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(view?.collaterals ?? []).map((item) => (
                <TableRow key={item.id} hover>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {item.description}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {item.certificateNo ?? '—'}
                    </Typography>
                  </TableCell>
                  <TableCell>{t(`status.${item.type}`)}</TableCell>
                  <TableCell align="right">{formatLak(item.appraisedValue, view?.loan.currency)}</TableCell>
                  <TableCell>{fmtDay(item.valuedAt, locale)}</TableCell>
                  <TableCell>{ownerLabel(item.ownerCustomerId)}</TableCell>
                  <TableCell>
                    <Stack spacing={0.5}>
                      <StatusChip status={item.status} />
                      {item.status === CollateralStatus.RELEASED && (
                        <Typography variant="caption" color="text.secondary">
                          {fmtDay(item.releasedAt, locale)}
                          {item.releaseReason ? ` · ${item.releaseReason}` : ''}
                        </Typography>
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell align="right">
                    {mayRelease && item.status === CollateralStatus.PLEDGED && (
                      <Button
                        size="small"
                        color="error"
                        onClick={() => {
                          setReleaseTarget(item);
                          setReason('');
                          setReleaseError(null);
                        }}
                      >
                        {t('hardship.collateral.release')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {view && view.collaterals.length === 0 && (
                <EmptyState colSpan={7} message={t('hardship.collateral.none')} />
              )}
            </TableBody>
          </Table>
        </Box>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{t('hardship.collateral.pledgeDialog')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              select
              label={t('common.type')}
              value={type}
              onChange={(event) => setType(event.target.value as CollateralType)}
              fullWidth
            >
              {COLLATERAL_TYPES.map((item) => (
                <MenuItem key={item} value={item}>
                  {t(`status.${item}`)}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label={`${t('hardship.collateral.description')} *`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              required
              slotProps={{ htmlInput: { maxLength: 255 } }}
              fullWidth
            />
            <TextField
              label={t('hardship.collateral.certificateNo')}
              value={certificateNo}
              onChange={(event) => setCertificateNo(event.target.value)}
              slotProps={{ htmlInput: { maxLength: 64 } }}
              fullWidth
            />
            <MoneyTextField
              label={`${t('hardship.collateral.appraised')} *`}
              minValue={0.01}
              value={appraisedValue}
              onChange={setAppraisedValue}
              required
              fullWidth
            />
            <TextField
              label={t('hardship.collateral.valuedAt')}
              type="date"
              value={valuedAt}
              onChange={(event) => setValuedAt(event.target.value)}
              slotProps={{ inputLabel: { shrink: true }, htmlInput: { max: today() } }}
              fullWidth
            />
            <TextField
              select
              label={t('hardship.collateral.owner')}
              value={ownerCustomerId}
              onChange={(event) => setOwnerCustomerId(event.target.value)}
              fullWidth
            >
              <MenuItem value="">{t('hardship.collateral.ownerNone')}</MenuItem>
              {ownerOptions.map((option) => (
                <MenuItem key={option.id} value={option.id}>
                  {option.label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label={t('hardship.collateral.note')}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              multiline
              minRows={2}
              fullWidth
            />
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            disabled={description.trim().length < 3 || !appraisedValue || registerMutation.isPending}
            onClick={() => registerMutation.mutate()}
          >
            {registerMutation.isPending ? t('common.processing') : t('hardship.collateral.pledge')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(releaseTarget)} onClose={() => setReleaseTarget(null)} fullWidth maxWidth="sm">
        <DialogTitle>{t('hardship.collateral.releaseDialog')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2">
              {releaseTarget?.description} · {formatLak(releaseTarget?.appraisedValue ?? 0, view?.loan.currency)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t('hardship.collateral.releaseInfo')}
            </Typography>
            {coverage && !coverage.passed && (
              <Alert severity="warning">{t('hardship.collateral.releaseWouldBreak')}</Alert>
            )}
            <TextField
              label={t('hardship.collateral.releaseReason')}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              multiline
              minRows={2}
              fullWidth
            />
            {releaseError && <Alert severity="error">{releaseError}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReleaseTarget(null)}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            color="error"
            disabled={!reason.trim() || releaseMutation.isPending}
            onClick={() => releaseMutation.mutate()}
          >
            {releaseMutation.isPending ? t('common.processing') : t('hardship.collateral.release')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
