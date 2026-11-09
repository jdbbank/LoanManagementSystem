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
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
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
  BankAccountStatus,
  EvidenceKind,
  type CustomerBankAccountView,
  type CustomerBankAccountsView,
  type EvidenceDocumentView,
  type EvidenceList,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { OPERATOR_ROLES, canRelease, isAdmin } from '../auth/roles';
import BlobImageView from './BlobImageView';
import EmptyState from './EmptyState';
import EvidenceUploadForm from './EvidenceUploadForm';
import StatusChip from './StatusChip';
import TableSkeleton from './TableSkeleton';

interface NewAccount {
  bankName: string;
  accountNumber: string;
  accountHolderName: string;
  branch: string;
  isPrimary: boolean;
  note: string;
}

const EMPTY: NewAccount = {
  bankName: '',
  accountNumber: '',
  accountHolderName: '',
  branch: '',
  isPrimary: false,
  note: '',
};

function fmtDay(value: string | null, locale: string): string {
  return value ? new Date(value).toLocaleDateString(locale, { dateStyle: 'medium' }) : '—';
}

/**
 * Where this customer's money actually travels: the accounts on file plus the scanned proof that each
 * one really belongs to them. Registering is maker work, closing needs the approving tier because it
 * stops money that a live loan may still point at, and the number is only ever shown masked.
 */
export default function CustomerBankAccountsPanel({ customerId }: { customerId: string }) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const locale = i18n.resolvedLanguage?.startsWith('lo') ? 'lo-LA' : 'en-GB';

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<NewAccount>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<CustomerBankAccountView | null>(null);
  const [closeReason, setCloseReason] = useState('');
  const [closeError, setCloseError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<EvidenceDocumentView | null>(null);
  const [deleting, setDeleting] = useState<EvidenceDocumentView | null>(null);

  const canWrite = Boolean(user && OPERATOR_ROLES.includes(user.role));
  const mayClose = canRelease(user?.role);

  const accountsQuery = useQuery({
    queryKey: ['customers', customerId, 'bank-accounts'],
    queryFn: () => api.get(`/customers/${customerId}/bank-accounts`).then(unwrap<CustomerBankAccountsView>),
  });

  const proofsQuery = useQuery({
    queryKey: ['customers', customerId, 'evidence', EvidenceKind.BANK_ACCOUNT_PROOF],
    queryFn: () =>
      api
        .get(`/customers/${customerId}/evidence`, { params: { kind: EvidenceKind.BANK_ACCOUNT_PROOF } })
        .then(unwrap<EvidenceList>),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['customers', customerId, 'bank-accounts'] });
    void queryClient.invalidateQueries({ queryKey: ['customers', customerId, 'evidence'] });
    void queryClient.invalidateQueries({ queryKey: ['loans'] });
  };

  const registerMutation = useMutation({
    mutationFn: () =>
      api.post(`/customers/${customerId}/bank-accounts`, {
        bankName: form.bankName,
        accountNumber: form.accountNumber,
        accountHolderName: form.accountHolderName,
        branch: form.branch || undefined,
        isPrimary: form.isPrimary,
        note: form.note || undefined,
      }),
    onSuccess: () => {
      setOpen(false);
      setForm(EMPTY);
      setError(null);
      refresh();
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const closeMutation = useMutation({
    mutationFn: () => api.post(`/customers/${customerId}/bank-accounts/${closing?.id}/close`, { reason: closeReason }),
    onSuccess: () => {
      setClosing(null);
      setCloseReason('');
      setCloseError(null);
      refresh();
    },
    onError: (cause: Error) => setCloseError(cause.message),
  });

  const primaryMutation = useMutation({
    mutationFn: (accountId: string) => api.post(`/customers/${customerId}/bank-accounts/${accountId}/primary`),
    onSuccess: refresh,
  });

  const deleteMutation = useMutation({
    mutationFn: (documentId: string) => api.delete(`/customers/${customerId}/evidence/${documentId}`),
    onSuccess: () => {
      setDeleting(null);
      refresh();
    },
  });

  const accounts = accountsQuery.data?.accounts ?? [];
  const proofs = proofsQuery.data?.documents ?? [];
  const activeAccounts = accounts.filter((account) => account.status === BankAccountStatus.ACTIVE);

  const canDeleteProof = (document: EvidenceDocumentView) =>
    document.uploadedBy === user?.id || isAdmin(user?.role);

  return (
    <>
      <Card>
        <CardContent>
          <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 1, gap: 1 }}>
            <Typography variant="h6">{t('bank.title')}</Typography>
            {canWrite && (
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={() => {
                  setForm(EMPTY);
                  setError(null);
                  setOpen(true);
                }}
              >
                {t('bank.register')}
              </Button>
            )}
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t('bank.info')}
          </Typography>
          {primaryMutation.isError && (
            <Alert severity="error" sx={{ mb: 1 }}>
              {(primaryMutation.error as Error).message}
            </Alert>
          )}

          {accountsQuery.isLoading ? (
            <TableSkeleton columns={6} label={t('common.loading')} />
          ) : (
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t('bank.bank')}</TableCell>
                    <TableCell>{t('bank.account')}</TableCell>
                    <TableCell>{t('bank.holder')}</TableCell>
                    <TableCell>{t('bank.proofs')}</TableCell>
                    <TableCell>{t('common.status')}</TableCell>
                    <TableCell align="right">{t('common.actions')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {accounts.map((account) => (
                    <TableRow key={account.id} hover>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {account.bankName}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {account.branch || '—'} · {fmtDay(account.createdAt, locale)}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>{account.accountNumber}</TableCell>
                      <TableCell>{account.accountHolderName}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          variant="outlined"
                          color={account.proofCount > 0 ? 'success' : 'warning'}
                          label={t('bank.proofCount', { count: account.proofCount })}
                        />
                      </TableCell>
                      <TableCell>
                        <Stack spacing={0.5}>
                          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                            <StatusChip status={account.status} />
                            {account.isPrimary && (
                              <Typography variant="caption" sx={{ fontWeight: 700 }}>
                                {t('bank.primary')}
                              </Typography>
                            )}
                          </Stack>
                          {account.status === BankAccountStatus.CLOSED && (
                            <Typography variant="caption" color="text.secondary">
                              {fmtDay(account.closedAt, locale)}
                              {account.closeReason ? ` · ${account.closeReason}` : ''}
                            </Typography>
                          )}
                        </Stack>
                      </TableCell>
                      <TableCell align="right">
                        <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
                          {canWrite && account.status === BankAccountStatus.ACTIVE && !account.isPrimary && (
                            <Button
                              size="small"
                              disabled={primaryMutation.isPending}
                              onClick={() => primaryMutation.mutate(account.id)}
                            >
                              {t('bank.makePrimary')}
                            </Button>
                          )}
                          {mayClose && account.status === BankAccountStatus.ACTIVE && (
                            <Button
                              size="small"
                              color="error"
                              onClick={() => {
                                setClosing(account);
                                setCloseReason('');
                                setCloseError(null);
                              }}
                            >
                              {t('bank.close')}
                            </Button>
                          )}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))}
                  {accounts.length === 0 && <EmptyState colSpan={6} message={t('bank.none')} />}
                </TableBody>
              </Table>
            </Box>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            {t('evidence.proofsTitle')}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t('bank.proofInfo')}
          </Typography>

          {proofsQuery.isLoading ? (
            <TableSkeleton columns={6} label={t('common.loading')} />
          ) : (
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t('bank.bank')}</TableCell>
                    <TableCell>{t('bank.account')}</TableCell>
                    <TableCell>{t('evidence.fileName')}</TableCell>
                    <TableCell align="right">{t('evidence.size')}</TableCell>
                    <TableCell>{t('evidence.uploadedAt')}</TableCell>
                    <TableCell align="right">{t('common.actions')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {proofs.map((document) => (
                    <TableRow key={document.id} hover>
                      <TableCell>{document.bankName ?? '—'}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>{document.accountNumber ?? '—'}</TableCell>
                      <TableCell>
                        <Typography variant="body2">{document.fileName}</Typography>
                        {document.note && (
                          <Typography variant="caption" color="text.secondary">
                            {document.note}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell align="right">{Math.round(document.sizeBytes / 1024)} KB</TableCell>
                      <TableCell>{fmtDay(document.createdAt, locale)}</TableCell>
                      <TableCell align="right">
                        <Button size="small" onClick={() => setViewing(document)}>
                          {t('evidence.view')}
                        </Button>
                        {canWrite && canDeleteProof(document) && (
                          <Button size="small" color="error" onClick={() => setDeleting(document)}>
                            {t('evidence.delete')}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {proofs.length === 0 && <EmptyState colSpan={6} message={t('evidence.none')} />}
                </TableBody>
              </Table>
            </Box>
          )}

          {deleteMutation.isError && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {(deleteMutation.error as Error).message}
            </Alert>
          )}

          {canWrite && proofsQuery.data && activeAccounts.length > 0 && (
            <Box sx={{ mt: 2 }}>
              <EvidenceUploadForm
                basePath={`/customers/${customerId}`}
                kind={EvidenceKind.BANK_ACCOUNT_PROOF}
                policy={proofsQuery.data.policy}
                accounts={activeAccounts}
                onUploaded={refresh}
              />
            </Box>
          )}
          {canWrite && activeAccounts.length === 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
              {t('bank.needAccountFirst')}
            </Typography>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{t('bank.registerDialog')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="caption" color="text.secondary">
              {t('bank.maskInfo')}
            </Typography>
            <TextField
              label={`${t('bank.bank')} *`}
              value={form.bankName}
              onChange={(e) => setForm({ ...form, bankName: e.target.value })}
              required
              fullWidth
            />
            <TextField
              label={`${t('bank.accountNumber')} *`}
              value={form.accountNumber}
              onChange={(e) => setForm({ ...form, accountNumber: e.target.value })}
              slotProps={{ htmlInput: { maxLength: 64 } }}
              required
              fullWidth
              sx={{ '& input': { fontFamily: 'monospace' } }}
            />
            <TextField
              label={`${t('bank.holder')} *`}
              value={form.accountHolderName}
              onChange={(e) => setForm({ ...form, accountHolderName: e.target.value })}
              required
              fullWidth
            />
            <TextField
              label={t('bank.branch')}
              value={form.branch}
              onChange={(e) => setForm({ ...form, branch: e.target.value })}
              slotProps={{ htmlInput: { maxLength: 128 } }}
              fullWidth
            />
            <FormControlLabel
              control={
                <Switch
                  checked={form.isPrimary}
                  onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })}
                />
              }
              label={t('bank.makePrimary')}
            />
            <TextField
              label={t('bank.note')}
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
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
            disabled={!form.bankName || !form.accountNumber || !form.accountHolderName || registerMutation.isPending}
            onClick={() => registerMutation.mutate()}
          >
            {registerMutation.isPending ? t('common.processing') : t('bank.register')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(closing)} onClose={() => setClosing(null)} fullWidth maxWidth="sm">
        <DialogTitle>{t('bank.closeDialog')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2">
              {closing?.bankName} — {closing?.accountNumber}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t('bank.closeInfo')}
            </Typography>
            <TextField
              label={`${t('bank.closeReason')} *`}
              value={closeReason}
              onChange={(e) => setCloseReason(e.target.value)}
              error={closeError !== null && closeReason.trim().length === 0}
              multiline
              minRows={2}
              required
              fullWidth
            />
            {closeError && <Alert severity="error">{closeError}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setClosing(null)}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            color="error"
            disabled={closeReason.trim().length === 0 || closeMutation.isPending}
            onClick={() => closeMutation.mutate()}
          >
            {closeMutation.isPending ? t('common.processing') : t('bank.close')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(viewing)} onClose={() => setViewing(null)} fullWidth maxWidth="sm">
        <DialogTitle>
          {viewing ? `${viewing.bankName ?? ''} ${viewing.accountNumber ?? ''} — ${viewing.fileName}` : t('evidence.view')}
        </DialogTitle>
        <DialogContent>
          {viewing && (
            <BlobImageView
              path={`/customers/${customerId}/evidence/${viewing.id}/content`}
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
          <Typography>
            {deleting ? t('evidence.deleteConfirm', { file: deleting.fileName }) : ''}
          </Typography>
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
    </>
  );
}
