import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import DeleteIcon from '@mui/icons-material/Delete';
import ErrorIcon from '@mui/icons-material/Error';
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser';
import VisibilityIcon from '@mui/icons-material/Visibility';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { api, unwrap } from '../api/client';
import { KycDocumentType, KycStatus, type KycDocument, type KycState } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { OPERATOR_ROLES, canApprove, isAdmin } from '../auth/roles';
import BlobImageView from '../components/BlobImageView';
import CustomerBankAccountsPanel from '../components/CustomerBankAccountsPanel';
import KycUploadForm from '../components/KycUploadForm';
import PageHeader from '../components/PageHeader';
import StatusChip from '../components/StatusChip';
import { LoadingPanel } from '../components/LoadingOverlay';

type ReviewAction = 'verify' | 'reject' | 'reopen';

export default function CustomerKycPage() {
  const { t, i18n } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [viewing, setViewing] = useState<KycDocument | null>(null);
  const [deleting, setDeleting] = useState<KycDocument | null>(null);
  const [review, setReview] = useState<ReviewAction | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  const locale = i18n.resolvedLanguage?.startsWith('lo') ? 'lo-LA' : 'en-GB';
  const fmtDateTime = (value: string | null) =>
    value ? new Date(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const fmtDate = (value: string | null) =>
    value ? new Date(value).toLocaleDateString(locale, { dateStyle: 'medium' }) : '—';
  const typeLabel = (type: KycDocumentType | 'IDENTITY_DOCUMENT') => t(`kyc.type.${type}`);

  const kycQuery = useQuery({
    queryKey: ['kyc', id],
    queryFn: () => api.get(`/customers/${id}/kyc/documents`).then(unwrap<KycState>),
    enabled: Boolean(id),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['kyc', id] });
    void queryClient.invalidateQueries({ queryKey: ['customers'] });
  };

  const actionMutation = useMutation({
    mutationFn: ({ path, body }: { path: 'submit' | ReviewAction; body?: Record<string, string | undefined> }) =>
      api.post(`/customers/${id}/kyc/${path}`, body ?? {}),
    onSuccess: () => {
      setReview(null);
      setReason('');
      setNote('');
      refresh();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (documentId: string) => api.delete(`/customers/${id}/kyc/documents/${documentId}`),
    onSuccess: () => {
      setDeleting(null);
      refresh();
    },
  });

  if (!id) return null;
  if (kycQuery.isLoading) return <LoadingPanel label={t('common.loading')} />;
  if (kycQuery.isError) return <Alert severity="error">{(kycQuery.error as Error).message}</Alert>;
  if (!kycQuery.data) return null;

  const { customer, documents, policy, checklist } = kycQuery.data;
  const isOperator = Boolean(user && OPERATOR_ROLES.includes(user.role));
  const uploadedByMe = documents.some((document) => document.uploadedBy === user?.id);
  const submittedByMe = customer.kycSubmittedBy === user?.id;
  const separationIssue = submittedByMe ? t('kyc.youSubmitted') : uploadedByMe ? t('kyc.youUploaded') : null;
  const canVerify =
    canApprove(user?.role) && customer.kycStatus === KycStatus.PENDING && separationIssue === null;
  const storedKb = Math.round(documents.reduce((sum, document) => sum + document.sizeBytes, 0) / 1024);

  const requirements = [
    {
      label: typeLabel('IDENTITY_DOCUMENT'),
      hint: t('kyc.identityTypes', { types: policy.requiredIdentityTypes.map(typeLabel).join(', ') }),
      ok: !checklist.missing.includes('IDENTITY_DOCUMENT'),
    },
    ...(policy.requireSelfieWithId
      ? [{ label: typeLabel(KycDocumentType.SELFIE_WITH_ID), hint: '', ok: !checklist.missing.includes(KycDocumentType.SELFIE_WITH_ID) }]
      : []),
    ...(policy.requireSignature
      ? [{ label: typeLabel(KycDocumentType.SIGNATURE), hint: '', ok: !checklist.missing.includes(KycDocumentType.SIGNATURE) }]
      : []),
    ...(policy.requireFamilyBook
      ? [{ label: typeLabel(KycDocumentType.FAMILY_BOOK), hint: '', ok: !checklist.missing.includes(KycDocumentType.FAMILY_BOOK) }]
      : []),
  ];

  const reviewLabel = review ? t(`kyc.${review}`) : '';

  return (
    <Stack spacing={2}>
      <PageHeader title={t('pages.kyc')} actions={<StatusChip status={customer.kycStatus} size="medium" />} />

      {customer.kycStatus === KycStatus.REJECTED && customer.kycRejectionReason && (
        <Alert severity="error">{t('kyc.rejectedReason', { reason: customer.kycRejectionReason })}</Alert>
      )}

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 6 }}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                {customer.customerNumber} — {customer.fullName}
              </Typography>
              <Stack divider={<Divider flexItem />} spacing={1}>
                <Row label={t('customers.nationalId')} value={customer.nationalId ?? '—'} />
                <Row label={t('kyc.statusLabel')} value={<StatusChip status={customer.kycStatus} />} />
                <Row label={t('kyc.documents')} value={t('kyc.documentsCount', { count: documents.length })} />
                <Row label={t('kyc.submittedLabel')} value={fmtDateTime(customer.kycSubmittedAt)} />
                <Row label={t('kyc.verifiedLabel')} value={fmtDateTime(customer.kycReviewedAt)} />
                <Row
                  label={t('kyc.storageLabel')}
                  value={t('kyc.storageUsed', {
                    used: storedKb,
                    quota: Math.round(policy.maxTotalBytesPerCustomer / 1024),
                  })}
                />
              </Stack>
              {customer.kycStatus === KycStatus.VERIFIED && customer.kycAppliedPolicy && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  {t('kyc.policySnapshot', {
                    details: `${customer.kycAppliedPolicy.maxFileSizeKb} KB · ${customer.kycAppliedPolicy.allowedMimeTypes.join(', ')}`,
                  })}
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                {t('kyc.checklist')}
              </Typography>
              <Stack spacing={1}>
                {requirements.map((item) => (
                  <Stack key={item.label} direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                    {item.ok ? (
                      <CheckCircleIcon fontSize="small" color="success" />
                    ) : (
                      <ErrorIcon fontSize="small" color="error" />
                    )}
                    <Stack spacing={0}>
                      <Typography variant="body2">{item.label}</Typography>
                      {item.hint && (
                        <Typography variant="caption" color="text.secondary">
                          {item.hint}
                        </Typography>
                      )}
                    </Stack>
                  </Stack>
                ))}

                {checklist.expired.length > 0 && (
                  <Alert severity="error">
                    {t('kyc.expired', { items: checklist.expired.map(typeLabel).join(', ') })}
                  </Alert>
                )}
                {checklist.expiringSoon.length > 0 && (
                  <Alert severity="warning">
                    {t('kyc.expiringSoon', {
                      days: policy.expiryWarningDays,
                      items: [...new Set(checklist.expiringSoon)].map(typeLabel).join(', '),
                    })}
                  </Alert>
                )}
                <Alert severity={checklist.satisfied ? 'success' : 'info'}>
                  {checklist.satisfied
                    ? t('kyc.checklistSatisfied')
                    : t('kyc.missing', { items: checklist.missing.map(typeLabel).join(', ') })}
                </Alert>
                <Typography variant="body2" color="text.secondary">
                  {policy.blockDisbursementUntilVerified
                    ? customer.kycStatus === KycStatus.VERIFIED
                      ? t('kyc.gateOpen')
                      : t('kyc.gateBlocked')
                    : t('kyc.gateDisabled')}
                </Typography>
              </Stack>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            {t('kyc.documents')}
          </Typography>
          {documents.length === 0 ? (
            <Typography color="text.secondary">{t('kyc.noDocuments')}</Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('kyc.documentType')}</TableCell>
                  <TableCell>{t('kyc.side')}</TableCell>
                  <TableCell>{t('kyc.fileName')}</TableCell>
                  <TableCell align="right">{t('kyc.size')}</TableCell>
                  <TableCell>{t('kyc.issuedAt')}</TableCell>
                  <TableCell>{t('kyc.expiresAt')}</TableCell>
                  <TableCell>{t('kyc.uploadedAt')}</TableCell>
                  <TableCell align="right">{t('common.actions')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {documents.map((document) => (
                  <TableRow key={document.id} hover>
                    <TableCell sx={{ fontWeight: 600 }}>{typeLabel(document.documentType)}</TableCell>
                    <TableCell>{t(`kyc.variant.${document.variant}`)}</TableCell>
                    <TableCell>{document.fileName}</TableCell>
                    <TableCell align="right">{Math.round(document.sizeBytes / 1024)} KB</TableCell>
                    <TableCell>{fmtDate(document.issuedAt)}</TableCell>
                    <TableCell>{fmtDate(document.expiresAt)}</TableCell>
                    <TableCell>{fmtDateTime(document.createdAt)}</TableCell>
                    <TableCell align="right">
                      <Button size="small" startIcon={<VisibilityIcon />} onClick={() => setViewing(document)}>
                        {t('kyc.viewImage')}
                      </Button>
                      {isOperator && (document.uploadedBy === user?.id || isAdmin(user?.role)) && (
                        <Button
                          size="small"
                          color="error"
                          startIcon={<DeleteIcon />}
                          onClick={() => setDeleting(document)}
                        >
                          {t('kyc.delete')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {isOperator && (
        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              {t('kyc.uploadTitle')}
            </Typography>
            <KycUploadForm customerId={id} policy={policy} onUploaded={refresh} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
            {isOperator &&
              (customer.kycStatus === KycStatus.NOT_VERIFIED || customer.kycStatus === KycStatus.REJECTED) && (
                <Button
                  variant="contained"
                  startIcon={<VerifiedUserIcon />}
                  disabled={actionMutation.isPending}
                  onClick={() => actionMutation.mutate({ path: 'submit' })}
                >
                  {t('kyc.submit')}
                </Button>
              )}
            {canApprove(user?.role) && customer.kycStatus === KycStatus.PENDING && (
              <>
                <Tooltip title={separationIssue ?? t('kyc.verifyInfo')}>
                  <span>
                    <Button
                      variant="contained"
                      color="success"
                      startIcon={<VerifiedUserIcon />}
                      disabled={!canVerify}
                      onClick={() => setReview('verify')}
                    >
                      {t('kyc.verify')}
                    </Button>
                  </span>
                </Tooltip>
                <Button variant="outlined" color="error" onClick={() => setReview('reject')}>
                  {t('kyc.reject')}
                </Button>
              </>
            )}
            {isAdmin(user?.role) && customer.kycStatus === KycStatus.VERIFIED && (
              <Button variant="outlined" onClick={() => setReview('reopen')}>
                {t('kyc.reopen')}
              </Button>
            )}
            {customer.kycStatus === KycStatus.PENDING && (
              <Typography variant="body2" color="text.secondary">
                {t('kyc.makerChecker')}
              </Typography>
            )}
            {isOperator &&
              (customer.kycStatus === KycStatus.NOT_VERIFIED || customer.kycStatus === KycStatus.REJECTED) && (
                <Typography variant="body2" color="text.secondary">
                  {t('kyc.submitInfo')}
                </Typography>
              )}
            {actionMutation.isError && <Alert severity="error">{(actionMutation.error as Error).message}</Alert>}
          </Stack>
        </CardContent>
      </Card>

      <CustomerBankAccountsPanel customerId={id} />

      <Dialog open={Boolean(viewing)} onClose={() => setViewing(null)} fullWidth maxWidth="sm">
        <DialogTitle>
          {viewing ? `${typeLabel(viewing.documentType)} — ${viewing.fileName}` : t('kyc.viewImage')}
        </DialogTitle>
        <DialogContent>
          {viewing && (
            <BlobImageView
              path={`/customers/${id}/kyc/documents/${viewing.id}/content`}
              alt={viewing.fileName}
              loadingLabel={t('kyc.imageLoading')}
              errorLabel={t('kyc.imageError')}
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setViewing(null)}>{t('common.close')}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(deleting)} onClose={() => setDeleting(null)} fullWidth maxWidth="sm">
        <DialogTitle>{t('kyc.deleteTitle')}</DialogTitle>
        <DialogContent>
          <Typography>
            {deleting
              ? t('kyc.deleteConfirm', { type: typeLabel(deleting.documentType), file: deleting.fileName })
              : ''}
          </Typography>
          {deleteMutation.isError && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {(deleteMutation.error as Error).message}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
          <Button
            color="error"
            variant="contained"
            disabled={!deleting || deleteMutation.isPending}
            onClick={() => deleting && deleteMutation.mutate(deleting.id)}
          >
            {t('kyc.delete')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={review !== null} onClose={() => setReview(null)} fullWidth maxWidth="sm">
        <DialogTitle>{reviewLabel}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              {review === 'verify'
                ? t('kyc.verifyInfo')
                : review === 'reject'
                  ? t('kyc.rejectInfo')
                  : t('kyc.reopenInfo')}
            </Typography>
            {review === 'verify' ? (
              <TextField
                label={t('kyc.verifyNote')}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                multiline
                minRows={2}
                fullWidth
              />
            ) : (
              <TextField
                label={t('kyc.rejectReason')}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                error={review !== null && reason.trim().length === 0}
                multiline
                minRows={2}
                required
                fullWidth
              />
            )}
            {actionMutation.isError && <Alert severity="error">{(actionMutation.error as Error).message}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReview(null)}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            color={review === 'reject' ? 'error' : 'primary'}
            disabled={(review !== 'verify' && reason.trim().length === 0) || actionMutation.isPending}
            onClick={() =>
              review &&
              actionMutation.mutate({
                path: review,
                body: review === 'verify' ? { note: note || undefined } : { reason },
              })
            }
          >
            {reviewLabel}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
      <Typography color="text.secondary">{label}</Typography>
      <Typography sx={{ textAlign: 'right' }}>{value}</Typography>
    </Stack>
  );
}
