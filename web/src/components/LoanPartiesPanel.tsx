import AddIcon from '@mui/icons-material/Add';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
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
import { Link } from 'react-router-dom';
import { api, unwrap } from '../api/client';
import {
  LoanPartyRole,
  LoanPartyStatus,
  type CustomerRow,
  type LoanPartyView,
  type LoanPartiesView,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { OPERATOR_ROLES, canRelease } from '../auth/roles';
import EmptyState from './EmptyState';
import StatusChip from './StatusChip';
import TableSkeleton from './TableSkeleton';

const PARTY_ROLES: LoanPartyRole[] = [LoanPartyRole.GUARANTOR, LoanPartyRole.PAYER];

function fmtDay(value: string | null, locale: string): string {
  return value ? new Date(value).toLocaleDateString(locale, { dateStyle: 'medium' }) : '—';
}

/**
 * The people standing behind a loan — guarantors and any replacement payer — each judged on the KYC of
 * THAT engagement, because being verified for another loan years ago proves nothing here. Naming someone
 * is a maker's act; releasing them weakens the loan, so it needs a head approver or an admin.
 */
export default function LoanPartiesPanel({ loanId }: { loanId: string }) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [role, setRole] = useState<LoanPartyRole>(LoanPartyRole.GUARANTOR);
  const [relationship, setRelationship] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<LoanPartyView | null>(null);
  const [reason, setReason] = useState('');
  const [releaseError, setReleaseError] = useState<string | null>(null);

  const canWrite = Boolean(user && OPERATOR_ROLES.includes(user.role));
  const mayRelease = canRelease(user?.role);
  const locale = i18n.resolvedLanguage?.startsWith('lo') ? 'lo-LA' : 'en-GB';

  const partiesQuery = useQuery({
    queryKey: ['loan', loanId, 'parties'],
    queryFn: () => api.get(`/loans/${loanId}/parties`).then(unwrap<LoanPartiesView>),
  });

  const customersQuery = useQuery({
    queryKey: ['customers', ''],
    queryFn: () => api.get<{ customers: CustomerRow[] }>('/customers').then((response) => response.data.customers),
    enabled: canWrite && open,
  });

  const registerMutation = useMutation({
    mutationFn: () =>
      api.post(`/loans/${loanId}/parties`, {
        customerId,
        role,
        relationship: relationship || undefined,
        note: note || undefined,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['loan', loanId, 'parties'] });
      await queryClient.invalidateQueries({ queryKey: ['loan', loanId, 'restructures'] });
      setOpen(false);
      setCustomerId('');
      setRelationship('');
      setNote('');
      setError(null);
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const releaseMutation = useMutation({
    mutationFn: () =>
      api.post(`/loans/${loanId}/parties/${releaseTarget?.party.id}/release`, {
        reason,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['loan', loanId, 'parties'] });
      await queryClient.invalidateQueries({ queryKey: ['loan', loanId, 'restructures'] });
      setReleaseTarget(null);
      setReason('');
      setReleaseError(null);
    },
    onError: (cause: Error) => setReleaseError(cause.message),
  });

  const parties = partiesQuery.data?.parties ?? [];
  const borrowerId = partiesQuery.data?.loan.customerId;

  const closeRegister = () => {
    setOpen(false);
    setError(null);
  };

  const closeRelease = () => {
    setReleaseTarget(null);
    setReason('');
    setReleaseError(null);
  };

  return (
    <Stack spacing={2}>
      <Alert severity="info">{t('hardship.parties.info')}</Alert>
      {canWrite && (
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => {
            setRole(LoanPartyRole.GUARANTOR);
            setOpen(true);
          }}
          sx={{ alignSelf: 'flex-start' }}
        >
          {t('hardship.parties.add')}
        </Button>
      )}
      {partiesQuery.isError && <Alert severity="error">{(partiesQuery.error as Error).message}</Alert>}

      {partiesQuery.isLoading ? (
        <TableSkeleton columns={6} label={t('common.loading')} />
      ) : (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('common.customer')}</TableCell>
                <TableCell>{t('hardship.parties.role')}</TableCell>
                <TableCell>{t('hardship.parties.engagedFrom')}</TableCell>
                <TableCell>{t('hardship.parties.kyc')}</TableCell>
                <TableCell>{t('common.status')}</TableCell>
                <TableCell align="right">{t('common.actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {parties.map((row) => (
                <TableRow key={row.party.id} hover>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {row.customer?.fullName ?? row.party.customerId}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {row.customer?.customerNumber ?? '—'}
                      {row.party.relationship ? ` · ${row.party.relationship}` : ''}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip size="small" variant="outlined" label={t(`status.${row.party.role}`)} />
                  </TableCell>
                  <TableCell>{fmtDay(row.party.engagedAt, locale)}</TableCell>
                  <TableCell>
                    {row.kyc ? (
                      <Stack spacing={0.5}>
                        <Chip
                          size="small"
                          color={row.kyc.effective ? 'success' : 'warning'}
                          variant="outlined"
                          label={row.kyc.effective ? t('hardship.parties.effective') : t(`hardship.kycAction.${row.kyc.nextAction}`)}
                        />
                        <Typography variant="caption" color="text.secondary">
                          {row.kyc.hint}
                        </Typography>
                      </Stack>
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        {t('hardship.parties.noCustomer')}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Stack spacing={0.5}>
                      <StatusChip status={row.party.status} />
                      {row.party.status === LoanPartyStatus.RELEASED && (
                        <Typography variant="caption" color="text.secondary">
                          {fmtDay(row.party.releasedAt, locale)}
                          {row.party.releaseReason ? ` · ${row.party.releaseReason}` : ''}
                        </Typography>
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
                      <Button component={Link} size="small" to={`/customers/${row.party.customerId}`}>
                        {t('hardship.parties.openKyc')}
                      </Button>
                      {mayRelease && row.party.status === LoanPartyStatus.ACTIVE && (
                        <Button
                          size="small"
                          color="error"
                          onClick={() => {
                            setReleaseTarget(row);
                            setReason('');
                            setReleaseError(null);
                          }}
                        >
                          {t('hardship.parties.release')}
                        </Button>
                      )}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
              {parties.length === 0 && <EmptyState colSpan={6} message={t('hardship.parties.none')} />}
            </TableBody>
          </Table>
        </Box>
      )}

      <Dialog open={open} onClose={closeRegister} fullWidth maxWidth="sm">
        <DialogTitle>{t('hardship.parties.addDialog')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="caption" color="text.secondary">
              {t('hardship.parties.kycRule')}
            </Typography>
            <TextField
              select
              label={`${t('hardship.parties.person')} *`}
              value={customerId}
              onChange={(event) => setCustomerId(event.target.value)}
              required
              fullWidth
            >
              {(customersQuery.data ?? []).map((customer) => {
                const taken = parties.some(
                  (row) =>
                    row.party.status === LoanPartyStatus.ACTIVE &&
                    row.party.customerId === customer.id &&
                    row.party.role === role,
                );
                const isBorrower = customer.id === borrowerId;
                const blocked = taken || (role === LoanPartyRole.PAYER && isBorrower);
                return (
                  <MenuItem key={customer.id} value={customer.id} disabled={blocked}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                      <span>
                        {customer.customerNumber} — {customer.fullName}
                      </span>
                      {taken && (
                        <Typography variant="caption" color="error.main">
                          {t('hardship.parties.alreadyEngaged')}
                        </Typography>
                      )}
                      {role === LoanPartyRole.PAYER && isBorrower && (
                        <Typography variant="caption" color="error.main">
                          {t('hardship.parties.isBorrower')}
                        </Typography>
                      )}
                    </Stack>
                  </MenuItem>
                );
              })}
            </TextField>
            <TextField
              select
              label={t('hardship.parties.role')}
              value={role}
              onChange={(event) => setRole(event.target.value as LoanPartyRole)}
              fullWidth
            >
              {PARTY_ROLES.map((item) => (
                <MenuItem key={item} value={item}>
                  {t(`status.${item}`)}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label={t('hardship.parties.relationship')}
              value={relationship}
              onChange={(event) => setRelationship(event.target.value)}
              slotProps={{ htmlInput: { maxLength: 64 } }}
              fullWidth
            />
            <TextField
              label={t('hardship.parties.note')}
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
          <Button onClick={closeRegister}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            disabled={!customerId || registerMutation.isPending}
            onClick={() => registerMutation.mutate()}
          >
            {registerMutation.isPending ? t('common.processing') : t('hardship.parties.add')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(releaseTarget)} onClose={closeRelease} fullWidth maxWidth="sm">
        <DialogTitle>{t('hardship.parties.releaseDialog')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2">
              {releaseTarget?.customer?.fullName ?? releaseTarget?.party.customerId} ·{' '}
              {t(`status.${releaseTarget?.party.role}`)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t('hardship.parties.releaseInfo')}
            </Typography>
            <TextField
              label={t('hardship.parties.releaseReason')}
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
          <Button onClick={closeRelease}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            color="error"
            disabled={!reason.trim() || releaseMutation.isPending}
            onClick={() => releaseMutation.mutate()}
          >
            {releaseMutation.isPending ? t('common.processing') : t('hardship.parties.release')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
