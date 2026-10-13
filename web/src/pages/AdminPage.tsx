import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, unwrap } from '../api/client';
import {
  KycDocumentType,
  formatLak,
  type AvatarConfig,
  type AvatarPolicy,
  type KycConfig,
  type KycPolicy,
  type PasswordConfig,
  type PasswordPolicy,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { isAdmin } from '../auth/roles';
import PageHeader from '../components/PageHeader';
import MoneyTextField from '../components/MoneyTextField';

const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const BYTES_PER_MB = 1024 * 1024;

interface ApprovalThresholds {
  checkerThreshold: number;
  headThreshold: number;
}

export default function AdminPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const thresholdsQuery = useQuery({
    queryKey: ['config', 'thresholds'],
    queryFn: () => api.get<ApprovalThresholds>('/config/thresholds').then((response) => response.data),
  });
  const [checkerOverride, setCheckerOverride] = useState<string | null>(null);
  const [headOverride, setHeadOverride] = useState<string | null>(null);
  const checkerThreshold = checkerOverride ?? (thresholdsQuery.data ? String(thresholdsQuery.data.checkerThreshold) : '');
  const headThreshold = headOverride ?? (thresholdsQuery.data ? String(thresholdsQuery.data.headThreshold) : '');
  const [saved, setSaved] = useState(false);

  const updateMutation = useMutation({
    mutationFn: () =>
      api.put<ApprovalThresholds>('/config/thresholds', {
        checkerThreshold: Number(checkerThreshold),
        headThreshold: Number(headThreshold),
      }),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['config', 'thresholds'] });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    updateMutation.mutate();
  };

  return (
    <Stack spacing={2}>
      <PageHeader title="System Configuration" />
      <Alert severity="warning">{t('admin.info')}</Alert>
      {thresholdsQuery.isError && <Alert severity="error">{(thresholdsQuery.error as Error).message}</Alert>}
      <Card>
        <CardContent>
          {thresholdsQuery.isLoading ? <CircularProgress /> : (
            <form onSubmit={submit}>
              <Stack spacing={2} sx={{ maxWidth: 520 }}>
                <Typography variant="body2" color="text.secondary">
                  {t('admin.upTo', {
                    amount: formatLak(Number(checkerThreshold)),
                    headAmount: formatLak(Number(headThreshold)),
                  })}
                </Typography>
                <MoneyTextField
                  label={t('admin.checkerThreshold')}
                  minValue={0.01}
                  value={checkerThreshold}
                  onChange={setCheckerOverride}
                  required
                />
                <MoneyTextField
                  label={t('admin.headThreshold')}
                  minValue={0.01}
                  value={headThreshold}
                  onChange={setHeadOverride}
                  required
                />
                {updateMutation.isError && <Alert severity="error">{(updateMutation.error as Error).message}</Alert>}
                {saved && <Alert severity="success">{t('admin.saved')}</Alert>}
                <Button
                  type="submit"
                  variant="contained"
                  disabled={updateMutation.isPending || Number(headThreshold) < Number(checkerThreshold)}
                >
                  {t('admin.save')}
                </Button>
              </Stack>
            </form>
          )}
        </CardContent>
      </Card>
      <KycPolicyCard />
      <PasswordPolicyCard />
      <AvatarPolicyCard />
    </Stack>
  );
}

/** Mirrors KycPolicyCard: env defaults stay visible so a live override is never mistaken for the default. */
function PasswordPolicyCard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = isAdmin(user?.role);
  const configQuery = useQuery({
    queryKey: ['config', 'password'],
    queryFn: () => api.get('/config/password').then(unwrap<PasswordConfig>),
  });
  const [draft, setDraft] = useState<PasswordPolicy | null>(null);
  const [saved, setSaved] = useState(false);
  const policy = draft ?? configQuery.data?.policy ?? null;

  const updateMutation = useMutation({
    mutationFn: () => api.put('/config/password', policy),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['config', 'password'] });
      setDraft(null);
    },
  });

  if (configQuery.isLoading || !policy) {
    return (
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            {t('admin.password.title')}
          </Typography>
          <CircularProgress />
        </CardContent>
      </Card>
    );
  }

  const patch = (changes: Partial<PasswordPolicy>) => {
    setSaved(false);
    setDraft({ ...policy, ...changes });
  };

  const lengthBroken = policy.minLength > policy.maxLength;
  const flags = ['requireDigit', 'requireUppercase', 'requireLowercase', 'requireSymbol'] as const;
  const rulesBroken = flags.every((field) => !policy[field]);

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          {t('admin.password.title')}
        </Typography>
        <Alert severity="info" sx={{ mb: 2 }}>
          {t('admin.password.info')}
        </Alert>
        {!canWrite && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {t('admin.password.readOnly')}
          </Alert>
        )}

        <Stack spacing={2} sx={{ maxWidth: 720 }}>
          <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', gap: 1 }}>
            <TextField
              label={t('admin.password.minLength')}
              type="number"
              value={policy.minLength}
              onChange={(e) => patch({ minLength: Number(e.target.value) })}
              disabled={!canWrite}
              slotProps={{ htmlInput: { step: '1', min: '4', max: '64' } }}
            />
            <TextField
              label={t('admin.password.maxLength')}
              type="number"
              value={policy.maxLength}
              onChange={(e) => patch({ maxLength: Number(e.target.value) })}
              disabled={!canWrite}
              slotProps={{ htmlInput: { step: '1', min: '4', max: '128' } }}
            />
          </Stack>
          {(lengthBroken || rulesBroken) && (
            <Alert severity="error">{lengthBroken ? t('admin.password.order') : t('admin.password.rules')}</Alert>
          )}

          <Stack spacing={0}>
            {flags.map((field) => (
              <FormControlLabel
                key={field}
                control={
                  <Switch
                    checked={policy[field]}
                    disabled={!canWrite}
                    onChange={(e) => patch({ [field]: e.target.checked } as Partial<PasswordPolicy>)}
                  />
                }
                label={t(`admin.password.${field}`)}
              />
            ))}
          </Stack>

          <Typography variant="body2" color="text.secondary">
            {t('admin.password.checksum', { checksum: configQuery.data?.checksum ?? '—' })}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t('admin.password.defaults', {
              details: `${configQuery.data?.defaults.minLength ?? '—'}-${configQuery.data?.defaults.maxLength ?? '—'}`,
            })}
          </Typography>

          {updateMutation.isError && <Alert severity="error">{(updateMutation.error as Error).message}</Alert>}
          {saved && <Alert severity="success">{t('admin.password.saved')}</Alert>}
          <Button
            variant="contained"
            disabled={!canWrite || updateMutation.isPending || lengthBroken || rulesBroken}
            onClick={() => updateMutation.mutate()}
            sx={{ alignSelf: 'flex-start' }}
          >
            {updateMutation.isPending ? t('common.processing') : t('admin.password.save')}
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}

function AvatarPolicyCard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = isAdmin(user?.role);
  const configQuery = useQuery({
    queryKey: ['config', 'avatar'],
    queryFn: () => api.get('/config/avatar').then(unwrap<AvatarConfig>),
  });
  const [draft, setDraft] = useState<AvatarPolicy | null>(null);
  const [saved, setSaved] = useState(false);
  const policy = draft ?? configQuery.data?.policy ?? null;

  const updateMutation = useMutation({
    mutationFn: () => api.put('/config/avatar', policy),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['config', 'avatar'] });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      setDraft(null);
    },
  });

  if (configQuery.isLoading || !policy) {
    return (
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            {t('admin.avatar.title')}
          </Typography>
          <CircularProgress />
        </CardContent>
      </Card>
    );
  }

  const patch = (changes: Partial<AvatarPolicy>) => {
    setSaved(false);
    setDraft({ ...policy, ...changes });
  };

  const toggleValue = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  const mimeBroken = policy.allowedMimeTypes.length === 0;

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          {t('admin.avatar.title')}
        </Typography>
        <Alert severity="info" sx={{ mb: 2 }}>
          {t('admin.avatar.info')}
        </Alert>
        {!canWrite && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {t('admin.avatar.readOnly')}
          </Alert>
        )}

        <Stack spacing={2} sx={{ maxWidth: 720 }}>
          <FormControlLabel
            control={
              <Switch
                checked={policy.enabled}
                disabled={!canWrite}
                onChange={(e) => patch({ enabled: e.target.checked })}
              />
            }
            label={t('admin.avatar.enabled')}
          />
          <TextField
            label={t('admin.avatar.maxFileSizeKb')}
            type="number"
            value={policy.maxFileSizeKb}
            onChange={(e) => patch({ maxFileSizeKb: Number(e.target.value) })}
            disabled={!canWrite}
            slotProps={{ htmlInput: { step: '1', min: '1', max: '10240' } }}
            sx={{ maxWidth: 240 }}
          />
          {mimeBroken && <Alert severity="error">{t('admin.avatar.mimeRequired')}</Alert>}

          <Stack spacing={0.5}>
            <Typography variant="subtitle2">{t('admin.avatar.allowedMimeTypes')}</Typography>
            <Typography variant="caption" color="text.secondary">
              {t('admin.avatar.imageOnly')}
            </Typography>
            <Stack direction="row" sx={{ flexWrap: 'wrap' }}>
              {IMAGE_MIME_TYPES.map((mime) => (
                <FormControlLabel
                  key={mime}
                  control={
                    <Checkbox
                      size="small"
                      checked={policy.allowedMimeTypes.includes(mime)}
                      disabled={!canWrite}
                      onChange={() => patch({ allowedMimeTypes: toggleValue(policy.allowedMimeTypes, mime) })}
                    />
                  }
                  label={mime}
                />
              ))}
            </Stack>
          </Stack>

          <Typography variant="caption" color="text.secondary">
            {t('admin.avatar.defaults', {
              details: `${configQuery.data?.defaults.maxFileSizeKb ?? '—'} KB · ${configQuery.data?.defaults.allowedMimeTypes.join(', ') ?? '—'}`,
            })}
          </Typography>

          {updateMutation.isError && <Alert severity="error">{(updateMutation.error as Error).message}</Alert>}
          {saved && <Alert severity="success">{t('admin.avatar.saved')}</Alert>}
          <Button
            variant="contained"
            disabled={!canWrite || updateMutation.isPending || mimeBroken}
            onClick={() => updateMutation.mutate()}
            sx={{ alignSelf: 'flex-start' }}
          >
            {updateMutation.isPending ? t('common.processing') : t('admin.avatar.save')}
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}

function KycPolicyCard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = isAdmin(user?.role);
  const kycQuery = useQuery({
    queryKey: ['config', 'kyc'],
    queryFn: () => api.get('/config/kyc').then(unwrap<KycConfig>),
  });
  const [draft, setDraft] = useState<KycPolicy | null>(null);
  const [saved, setSaved] = useState(false);
  const policy = draft ?? kycQuery.data?.policy ?? null;

  const updateMutation = useMutation({
    mutationFn: () => api.put('/config/kyc', policy),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['config', 'kyc'] });
      await queryClient.invalidateQueries({ queryKey: ['kyc'] });
      setDraft(null);
    },
  });

  if (kycQuery.isLoading || !policy) {
    return (
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            {t('admin.kyc.title')}
          </Typography>
          <CircularProgress />
        </CardContent>
      </Card>
    );
  }

  const patch = (changes: Partial<KycPolicy>) => {
    setSaved(false);
    setDraft({ ...policy, ...changes });
  };

  const toggleValue = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  const identitySubsetBroken = policy.requiredIdentityTypes.some(
    (type) => !policy.allowedDocumentTypes.includes(type),
  );

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          {t('admin.kyc.title')}
        </Typography>
        <Alert severity="info" sx={{ mb: 2 }}>
          {t('admin.kyc.info')}
        </Alert>
        {!canWrite && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {t('admin.kyc.readOnly')}
          </Alert>
        )}

        <Stack spacing={2} sx={{ maxWidth: 720 }}>
          <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', gap: 1 }}>
            <TextField
              label={t('admin.kyc.maxFileSizeKb')}
              type="number"
              value={policy.maxFileSizeKb}
              onChange={(e) => patch({ maxFileSizeKb: Number(e.target.value) })}
              disabled={!canWrite}
              slotProps={{ htmlInput: { step: '1', min: '1', max: '102400' } }}
            />
            <TextField
              label={t('admin.kyc.maxFilesPerRequest')}
              type="number"
              value={policy.maxFilesPerRequest}
              onChange={(e) => patch({ maxFilesPerRequest: Number(e.target.value) })}
              disabled={!canWrite}
              slotProps={{ htmlInput: { step: '1', min: '1', max: '10' } }}
            />
            <TextField
              label={t('admin.kyc.expiryWarningDays')}
              type="number"
              value={policy.expiryWarningDays}
              onChange={(e) => patch({ expiryWarningDays: Number(e.target.value) })}
              disabled={!canWrite}
              slotProps={{ htmlInput: { step: '1', min: '0', max: '3650' } }}
            />
            <TextField
              label={t('admin.kyc.maxTotalBytesPerCustomer')}
              type="number"
              value={Number((policy.maxTotalBytesPerCustomer / BYTES_PER_MB).toFixed(2))}
              onChange={(e) => patch({ maxTotalBytesPerCustomer: Math.round(Number(e.target.value) * BYTES_PER_MB) })}
              disabled={!canWrite}
              slotProps={{ htmlInput: { step: '0.1', min: '0.1' } }}
            />
          </Stack>

          <Stack spacing={0.5}>
            <Typography variant="subtitle2">{t('admin.kyc.allowedMimeTypes')}</Typography>
            <Typography variant="caption" color="text.secondary">
              {t('admin.kyc.imageOnly')}
            </Typography>
            <Stack direction="row" sx={{ flexWrap: 'wrap' }}>
              {IMAGE_MIME_TYPES.map((mime) => (
                <FormControlLabel
                  key={mime}
                  control={
                    <Checkbox
                      size="small"
                      checked={policy.allowedMimeTypes.includes(mime)}
                      disabled={!canWrite}
                      onChange={() => patch({ allowedMimeTypes: toggleValue(policy.allowedMimeTypes, mime) })}
                    />
                  }
                  label={mime}
                />
              ))}
            </Stack>
          </Stack>

          <Stack spacing={0.5}>
            <Typography variant="subtitle2">{t('admin.kyc.allowedDocumentTypes')}</Typography>
            <Stack direction="row" sx={{ flexWrap: 'wrap' }}>
              {Object.values(KycDocumentType).map((type) => (
                <FormControlLabel
                  key={type}
                  control={
                    <Checkbox
                      size="small"
                      checked={policy.allowedDocumentTypes.includes(type)}
                      disabled={!canWrite}
                      onChange={() => patch({ allowedDocumentTypes: toggleValue(policy.allowedDocumentTypes, type) })}
                    />
                  }
                  label={t(`kyc.type.${type}`)}
                />
              ))}
            </Stack>
          </Stack>

          <Stack spacing={0.5}>
            <Typography variant="subtitle2">{t('admin.kyc.requiredIdentityTypes')}</Typography>
            {identitySubsetBroken && (
              <Typography variant="caption" color="error.main">
                {t('admin.kyc.identitySubset')}
              </Typography>
            )}
            <Stack direction="row" sx={{ flexWrap: 'wrap' }}>
              {Object.values(KycDocumentType).map((type) => (
                <FormControlLabel
                  key={type}
                  control={
                    <Checkbox
                      size="small"
                      checked={policy.requiredIdentityTypes.includes(type)}
                      disabled={!canWrite}
                      onChange={() =>
                        patch({ requiredIdentityTypes: toggleValue(policy.requiredIdentityTypes, type) })
                      }
                    />
                  }
                  label={t(`kyc.type.${type}`)}
                />
              ))}
            </Stack>
          </Stack>

          <Stack spacing={0}>
            {(
              [
                'requireSelfieWithId',
                'requireSignature',
                'requireFamilyBook',
                'acceptExpiredDocuments',
                'blockDisbursementUntilVerified',
                'reverifyOnDocumentChange',
              ] as const
            ).map((field) => (
              <FormControlLabel
                key={field}
                control={
                  <Switch
                    checked={Boolean(policy[field])}
                    disabled={!canWrite}
                    onChange={(e) => patch({ [field]: e.target.checked } as Partial<KycPolicy>)}
                  />
                }
                label={t(`admin.kyc.${field}`)}
              />
            ))}
          </Stack>

          <Typography variant="body2" color="text.secondary">
            {t('admin.kyc.checksum', { checksum: kycQuery.data?.checksum ?? '—' })}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t('admin.kyc.defaults', {
              details: `${kycQuery.data?.defaults.maxFileSizeKb ?? '—'} KB · ${kycQuery.data?.defaults.allowedMimeTypes.join(', ') ?? '—'}`,
            })}
          </Typography>

          {updateMutation.isError && <Alert severity="error">{(updateMutation.error as Error).message}</Alert>}
          {saved && <Alert severity="success">{t('admin.kyc.saved')}</Alert>}
          <Button
            variant="contained"
            disabled={!canWrite || updateMutation.isPending || identitySubsetBroken}
            onClick={() => updateMutation.mutate()}
            sx={{ alignSelf: 'flex-start' }}
          >
            {updateMutation.isPending ? t('common.processing') : t('admin.kyc.save')}
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}
