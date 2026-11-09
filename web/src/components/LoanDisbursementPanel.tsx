import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, unwrap } from '../api/client';
import {
  DISBURSEMENT_CHANNELS,
  DisbursementChannel,
  EvidenceKind,
  type CustomerBankAccountsView,
  type EvidenceDocumentView,
  type EvidenceList,
  type Loan,
  type LoanDisbursement,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { OPERATOR_ROLES, isAdmin } from '../auth/roles';
import BlobImageView from './BlobImageView';
import EmptyState from './EmptyState';
import EvidenceUploadForm from './EvidenceUploadForm';
import StatusChip from './StatusChip';
import TableSkeleton from './TableSkeleton';

function fmtDay(value: string | null, locale: string): string {
  return value ? new Date(value).toLocaleDateString(locale, { dateStyle: 'medium' }) : '—';
}

/**
 * How the loan money reached the customer. The disbursement itself is booked when the loan is created;
 * this panel records the channel it went through and files the transfer slip or cash receipt afterwards,
 * so the paper proof sits next to the ledger entry instead of replacing it.
 */
export default function LoanDisbursementPanel({ loan, disbursement }: { loan: Loan; disbursement: LoanDisbursement }) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const locale = i18n.resolvedLanguage?.startsWith('lo') ? 'lo-LA' : 'en-GB';

  const [channel, setChannel] = useState<DisbursementChannel>(disbursement.channel ?? DisbursementChannel.BANK);
  const [bankAccountId, setBankAccountId] = useState(disbursement.bankAccountId ?? '');
  const [reference, setReference] = useState(disbursement.reference ?? '');
  const [viewing, setViewing] = useState<EvidenceDocumentView | null>(null);
  const [deleting, setDeleting] = useState<EvidenceDocumentView | null>(null);

  const canWrite = Boolean(user && OPERATOR_ROLES.includes(user.role));

  const accountsQuery = useQuery({
    queryKey: ['customers', loan.customerId, 'bank-accounts', 'ACTIVE'],
    queryFn: () =>
      api
        .get(`/customers/${loan.customerId}/bank-accounts`, { params: { status: 'ACTIVE' } })
        .then(unwrap<CustomerBankAccountsView>),
    enabled: canWrite,
  });

  const slipsQuery = useQuery({
    queryKey: ['loan', loan.id, 'evidence', EvidenceKind.DISBURSEMENT_SLIP],
    queryFn: () =>
      api
        .get(`/loans/${loan.id}/evidence`, { params: { kind: EvidenceKind.DISBURSEMENT_SLIP } })
        .then(unwrap<EvidenceList>),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['loan', loan.id] });
    void queryClient.invalidateQueries({ queryKey: ['loans'] });
  };

  const channelMutation = useMutation({
    mutationFn: () =>
      api.patch(`/loans/${loan.id}/disbursement`, {
        channel,
        bankAccountId: channel === DisbursementChannel.BANK ? bankAccountId : undefined,
        reference: reference || undefined,
      }),
    onSuccess: refresh,
  });

  const deleteMutation = useMutation({
    mutationFn: (documentId: string) => api.delete(`/loans/${loan.id}/evidence/${documentId}`),
    onSuccess: () => {
      setDeleting(null);
      refresh();
    },
  });

  const accounts = accountsQuery.data?.accounts ?? [];
  const slips = slipsQuery.data?.documents ?? [];
  const isBank = channel === DisbursementChannel.BANK;
  const bankMissing = isBank && !bankAccountId;
  const unchanged =
    disbursement.channel === channel &&
    (disbursement.bankAccountId ?? '') === (isBank ? bankAccountId : '') &&
    (disbursement.reference ?? '') === reference;

  return (
    <Stack spacing={2}>
      <Alert severity="info">{t('disbursement.info')}</Alert>

      <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="subtitle2">{t('disbursement.current')}</Typography>
        {disbursement.channel ? (
          <StatusChip status={disbursement.channel} />
        ) : (
          <Typography variant="body2" color="text.secondary">
            {t('disbursement.notRecorded')}
          </Typography>
        )}
        {disbursement.bankName && (
          <Typography variant="body2">
            {disbursement.bankName} — {disbursement.accountNumber}
          </Typography>
        )}
        {disbursement.reference && (
          <Typography variant="body2" color="text.secondary">
            {t('disbursement.reference')}: {disbursement.reference}
          </Typography>
        )}
      </Stack>

      {canWrite && (
        <Box>
          <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 1 }}>
            <TextField
              select
              label={t('disbursement.channel')}
              value={channel}
              onChange={(event) => setChannel(event.target.value as DisbursementChannel)}
              sx={{ minWidth: 200 }}
            >
              {DISBURSEMENT_CHANNELS.map((item) => (
                <MenuItem key={item} value={item}>
                  {t(`status.${item}`)}
                </MenuItem>
              ))}
            </TextField>
            {isBank && (
              <TextField
                select
                label={`${t('disbursement.bankAccount')} *`}
                value={bankAccountId}
                onChange={(event) => setBankAccountId(event.target.value)}
                sx={{ minWidth: 320 }}
              >
                {accounts.map((account) => (
                  <MenuItem key={account.id} value={account.id}>
                    {account.bankName} — {account.accountNumber} · {account.accountHolderName}
                  </MenuItem>
                ))}
              </TextField>
            )}
            <TextField
              label={t('disbursement.reference')}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              slotProps={{ htmlInput: { maxLength: 64 } }}
              sx={{ minWidth: 220 }}
            />
            <Button
              variant="contained"
              disabled={channelMutation.isPending || unchanged || bankMissing}
              onClick={() => channelMutation.mutate()}
            >
              {channelMutation.isPending ? t('common.processing') : t('disbursement.save')}
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            {isBank ? t('disbursement.bankInfo', { count: accounts.length }) : t('disbursement.cashInfo')}
          </Typography>
          {bankMissing && <Alert severity="warning">{t('disbursement.pickAccount')}</Alert>}
          {channelMutation.isError && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {(channelMutation.error as Error).message}
            </Alert>
          )}
        </Box>
      )}

      <Divider />

      <Box>
        <Typography variant="h6" gutterBottom>
          {t('evidence.slipsTitle')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('disbursement.slipInfo')}
        </Typography>

        {slipsQuery.isLoading ? (
          <TableSkeleton columns={6} label={t('common.loading')} />
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('evidence.fileName')}</TableCell>
                  <TableCell>{t('disbursement.channel')}</TableCell>
                  <TableCell>{t('bank.account')}</TableCell>
                  <TableCell align="right">{t('evidence.size')}</TableCell>
                  <TableCell>{t('evidence.uploadedAt')}</TableCell>
                  <TableCell align="right">{t('common.actions')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {slips.map((document) => (
                  <TableRow key={document.id} hover>
                    <TableCell>
                      <Typography variant="body2">{document.fileName}</Typography>
                      {document.note && (
                        <Typography variant="caption" color="text.secondary">
                          {document.note}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      {disbursement.channel ? <StatusChip status={disbursement.channel} /> : t('disbursement.notRecorded')}
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{document.accountNumber ?? '—'}</TableCell>
                    <TableCell align="right">{Math.round(document.sizeBytes / 1024)} KB</TableCell>
                    <TableCell>{fmtDay(document.createdAt, locale)}</TableCell>
                    <TableCell align="right">
                      <Button size="small" onClick={() => setViewing(document)}>
                        {t('evidence.view')}
                      </Button>
                      {canWrite && (document.uploadedBy === user?.id || isAdmin(user?.role)) && (
                        <Button size="small" color="error" onClick={() => setDeleting(document)}>
                          {t('evidence.delete')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {slips.length === 0 && <EmptyState colSpan={6} message={t('evidence.none')} />}
              </TableBody>
            </Table>
          </Box>
        )}

        {deleteMutation.isError && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {(deleteMutation.error as Error).message}
          </Alert>
        )}

        {canWrite && slipsQuery.data && (
          <Box sx={{ mt: 2 }}>
            <EvidenceUploadForm
              basePath={`/loans/${loan.id}`}
              kind={EvidenceKind.DISBURSEMENT_SLIP}
              policy={slipsQuery.data.policy}
              onUploaded={refresh}
            />
          </Box>
        )}
      </Box>

      <Dialog open={Boolean(viewing)} onClose={() => setViewing(null)} fullWidth maxWidth="sm">
        <DialogTitle>{viewing?.fileName ?? t('evidence.view')}</DialogTitle>
        <DialogContent>
          {viewing && (
            <BlobImageView
              path={`/loans/${loan.id}/evidence/${viewing.id}/content`}
              alt={viewing.fileName}
              loadingLabel={t('evidence.imageLoading')}
              errorLabel={t('evidence.imageError')}
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setViewing(null)}>{t('common.close')}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(deleting)} onClose={() => setDeleting(null)} fullWidth maxWidth="sm">
        <DialogTitle>{t('evidence.deleteTitle')}</DialogTitle>
        <DialogContent>
          <Typography>{deleting ? t('evidence.deleteConfirm', { file: deleting.fileName }) : ''}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            color="error"
            disabled={!deleting || deleteMutation.isPending}
            onClick={() => deleting && deleteMutation.mutate(deleting.id)}
          >
            {t('evidence.delete')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
