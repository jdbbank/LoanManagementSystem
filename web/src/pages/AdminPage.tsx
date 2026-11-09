import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
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
  type AccountSecurityConfig,
  type AccountSecurityPolicy,
  type AutoDebitRun,
  type AvatarConfig,
  type AvatarPolicy,
  type CollateralConfig,
  type CollateralPolicy,
  type EvidenceConfig,
  type EvidencePolicy,
  type KycConfig,
  type KycPolicy,
  type PasswordConfig,
  type PasswordPolicy,
  type PaymentConfig,
  type PaymentPolicy,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { isAdmin } from '../auth/roles';
import PageHeader from '../components/PageHeader';
import MoneyTextField from '../components/MoneyTextField';
import { LoadingPanel } from '../components/LoadingOverlay';

const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const BYTES_PER_MB = 1024 * 1024;
/** Same ceiling the server enforces on `payment.autoDebitLeadDays`. */
const MAX_LEAD_DAYS = 90;
/** Same ceilings the server enforces on the collateral coverage floor and appraisal age. */
const MAX_COVERAGE_PERCENT = 1000;
const MAX_VALUATION_AGE_DAYS = 3650;
/** Same ceilings the server enforces on the evidence upload policy. */
const MAX_EVIDENCE_FILE_SIZE_KB = 102_400;
const MAX_EVIDENCE_FILES_PER_REQUEST = 10;
/** Same ceilings the server enforces on the account-security policy. */
const MAX_FAILED_ATTEMPTS = 100;
const MAX_IDLE_LOCK_DAYS = 3650;
const MAX_IDLE_LOCK_POLL_HOURS = 168;
const MAX_PASSWORD_AGE_DAYS = 3650;
const MAX_PASSWORD_HISTORY_COUNT = 24;

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
          {thresholdsQuery.isLoading ? <LoadingPanel label={t('common.loading')} /> : (
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
      <AccountSecurityPolicyCard />
      <AvatarPolicyCard />
      <PaymentPolicyCard />
      <CollateralPolicyCard />
      <EvidencePolicyCard />
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
          <LoadingPanel label={t('common.loading')} />
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

/**
 * When an account locks itself and when its password expires: consecutive wrong passwords, days
 * without a sign-in, days a password stays valid, and how many old passwords a new one may not
 * repeat. A 0 switches that rule off rather than meaning "unset", so an ADMIN can turn one guard off
 * without touching the others. Unlocking a locked account stays an ADMIN action in Users management.
 */
function AccountSecurityPolicyCard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = isAdmin(user?.role);
  const configQuery = useQuery({
    queryKey: ['config', 'security'],
    queryFn: () => api.get('/config/security').then(unwrap<AccountSecurityConfig>),
  });
  const [draft, setDraft] = useState<AccountSecurityPolicy | null>(null);
  const [saved, setSaved] = useState(false);
  const policy = draft ?? configQuery.data?.policy ?? null;

  const updateMutation = useMutation({
    mutationFn: () => api.put('/config/security', policy),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['config', 'security'] });
      setDraft(null);
    },
  });

  if (configQuery.isLoading || !policy) {
    return (
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            {t('admin.security.title')}
          </Typography>
          <LoadingPanel label={t('common.loading')} />
        </CardContent>
      </Card>
    );
  }

  const patch = (changes: Partial<AccountSecurityPolicy>) => {
    setSaved(false);
    setDraft({ ...policy, ...changes });
  };

  const broken = (value: number, min: number, max: number) =>
    !Number.isInteger(value) || value < min || value > max;
  const attemptsBroken = broken(policy.maxFailedAttempts, 0, MAX_FAILED_ATTEMPTS);
  const idleBroken = broken(policy.idleLockDays, 0, MAX_IDLE_LOCK_DAYS);
  const pollBroken = broken(policy.idleLockPollHours, 1, MAX_IDLE_LOCK_POLL_HOURS);
  const ageBroken = broken(policy.passwordMaxAgeDays, 0, MAX_PASSWORD_AGE_DAYS);
  const warnBroken = broken(policy.passwordExpiryWarnDays, 0, MAX_PASSWORD_AGE_DAYS);
  const historyBroken = broken(policy.passwordHistoryCount, 0, MAX_PASSWORD_HISTORY_COUNT);
  // A warning dated after the expiry would never be seen, so the pair is checked together.
  const warnAfterAge = policy.passwordMaxAgeDays > 0 && policy.passwordExpiryWarnDays > policy.passwordMaxAgeDays;
  const defaults = configQuery.data?.defaults;

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          {t('admin.security.title')}
        </Typography>
        <Alert severity="info" sx={{ mb: 2 }}>
          {t('admin.security.info')}
        </Alert>
        {!canWrite && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {t('admin.security.readOnly')}
          </Alert>
        )}

        <Stack spacing={2} sx={{ maxWidth: 720 }}>
          <Stack spacing={0.5}>
            <TextField
              label={t('admin.security.maxFailedAttempts')}
              type="number"
              value={policy.maxFailedAttempts}
              onChange={(e) => patch({ maxFailedAttempts: Math.trunc(Number(e.target.value)) })}
              disabled={!canWrite}
              slotProps={{ htmlInput: { step: '1', min: '0', max: String(MAX_FAILED_ATTEMPTS) } }}
              sx={{ maxWidth: 280 }}
            />
            <Typography variant="caption" color="text.secondary">
              {t('admin.security.maxFailedHelper')}
            </Typography>
            {attemptsBroken && (
              <Alert severity="error">{t('admin.security.range', { field: t('admin.security.maxFailedAttempts'), min: 0, max: MAX_FAILED_ATTEMPTS })}</Alert>
            )}
          </Stack>

          <Stack spacing={0.5}>
            <TextField
              label={t('admin.security.idleLockDays')}
              type="number"
              value={policy.idleLockDays}
              onChange={(e) => patch({ idleLockDays: Math.trunc(Number(e.target.value)) })}
              disabled={!canWrite}
              slotProps={{ htmlInput: { step: '1', min: '0', max: String(MAX_IDLE_LOCK_DAYS) } }}
              sx={{ maxWidth: 280 }}
            />
            <Typography variant="caption" color="text.secondary">
              {t('admin.security.idleLockHelper')}
            </Typography>
            {idleBroken && (
              <Alert severity="error">{t('admin.security.range', { field: t('admin.security.idleLockDays'), min: 0, max: MAX_IDLE_LOCK_DAYS })}</Alert>
            )}
          </Stack>

          <FormControlLabel
            control={
              <Switch
                checked={policy.idleLockJobEnabled}
                disabled={!canWrite}
                onChange={(e) => patch({ idleLockJobEnabled: e.target.checked })}
              />
            }
            label={t('admin.security.idleLockJob')}
          />
          <Typography variant="caption" color="text.secondary">
            {t('admin.security.idleLockJobHelper')}
          </Typography>

          <TextField
            label={t('admin.security.idleLockPollHours')}
            type="number"
            value={policy.idleLockPollHours}
            onChange={(e) => patch({ idleLockPollHours: Math.trunc(Number(e.target.value)) })}
            disabled={!canWrite}
            slotProps={{ htmlInput: { step: '1', min: '1', max: String(MAX_IDLE_LOCK_POLL_HOURS) } }}
            sx={{ maxWidth: 280 }}
          />
          {pollBroken && (
            <Alert severity="error">{t('admin.security.range', { field: t('admin.security.idleLockPollHours'), min: 1, max: MAX_IDLE_LOCK_POLL_HOURS })}</Alert>
          )}

          <Stack spacing={0.5}>
            <TextField
              label={t('admin.security.passwordMaxAgeDays')}
              type="number"
              value={policy.passwordMaxAgeDays}
              onChange={(e) => patch({ passwordMaxAgeDays: Math.trunc(Number(e.target.value)) })}
              disabled={!canWrite}
              slotProps={{ htmlInput: { step: '1', min: '0', max: String(MAX_PASSWORD_AGE_DAYS) } }}
              sx={{ maxWidth: 280 }}
            />
            <Typography variant="caption" color="text.secondary">
              {t('admin.security.passwordMaxAgeHelper')}
            </Typography>
            {ageBroken && (
              <Alert severity="error">{t('admin.security.range', { field: t('admin.security.passwordMaxAgeDays'), min: 0, max: MAX_PASSWORD_AGE_DAYS })}</Alert>
            )}
          </Stack>

          <TextField
            label={t('admin.security.passwordExpiryWarnDays')}
            type="number"
            value={policy.passwordExpiryWarnDays}
            onChange={(e) => patch({ passwordExpiryWarnDays: Math.trunc(Number(e.target.value)) })}
            disabled={!canWrite}
            slotProps={{ htmlInput: { step: '1', min: '0', max: String(MAX_PASSWORD_AGE_DAYS) } }}
            sx={{ maxWidth: 280 }}
          />
          {warnBroken && (
            <Alert severity="error">{t('admin.security.range', { field: t('admin.security.passwordExpiryWarnDays'), min: 0, max: MAX_PASSWORD_AGE_DAYS })}</Alert>
          )}
          {warnAfterAge && !warnBroken && <Alert severity="error">{t('admin.security.warnAfterAge')}</Alert>}

          <Stack spacing={0.5}>
            <TextField
              label={t('admin.security.passwordHistoryCount')}
              type="number"
              value={policy.passwordHistoryCount}
              onChange={(e) => patch({ passwordHistoryCount: Math.trunc(Number(e.target.value)) })}
              disabled={!canWrite}
              slotProps={{ htmlInput: { step: '1', min: '0', max: String(MAX_PASSWORD_HISTORY_COUNT) } }}
              sx={{ maxWidth: 280 }}
            />
            <Typography variant="caption" color="text.secondary">
              {t('admin.security.passwordHistoryHelper')}
            </Typography>
            {historyBroken && (
              <Alert severity="error">{t('admin.security.range', { field: t('admin.security.passwordHistoryCount'), min: 0, max: MAX_PASSWORD_HISTORY_COUNT })}</Alert>
            )}
          </Stack>

          <FormControlLabel
            control={
              <Switch
                checked={policy.applyToAdminAccounts}
                disabled={!canWrite}
                onChange={(e) => patch({ applyToAdminAccounts: e.target.checked })}
              />
            }
            label={t('admin.security.applyToAdmin')}
          />
          <Typography variant="caption" color="text.secondary">
            {t('admin.security.applyToAdminHelper')}
          </Typography>

          <Typography variant="body2" color="text.secondary">
            {t('admin.security.checksum', { checksum: configQuery.data?.checksum ?? '—' })}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t('admin.security.defaults', {
              details: `${defaults?.maxFailedAttempts ?? '—'} ${t('admin.security.timesUnit')} · ${
                defaults?.idleLockDays ?? '—'
              } ${t('admin.security.daysUnit')} · ${
                defaults?.passwordMaxAgeDays ?? '—'
              } ${t('admin.security.daysUnit')} · ${defaults?.passwordHistoryCount ?? '—'} ${t(
                'admin.security.timesUnit',
              )}`,
            })}
          </Typography>

          {updateMutation.isError && <Alert severity="error">{(updateMutation.error as Error).message}</Alert>}
          {saved && <Alert severity="success">{t('admin.security.saved')}</Alert>}
          <Button
            variant="contained"
            disabled={
              !canWrite ||
              updateMutation.isPending ||
              attemptsBroken ||
              idleBroken ||
              pollBroken ||
              ageBroken ||
              warnBroken ||
              historyBroken ||
              warnAfterAge
            }
            onClick={() => updateMutation.mutate()}
            sx={{ alignSelf: 'flex-start' }}
          >
            {updateMutation.isPending ? t('common.processing') : t('admin.security.save')}
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
          <LoadingPanel label={t('common.loading')} />
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
          <LoadingPanel label={t('common.loading')} />
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

/**
 * The repayment-collection policy: how many days before an instalment falls due the job settles it
 * from the customer's own credit, and the global switch that keeps it off until an admin says
 * otherwise. "Preview" is a dry run — it reports what the next pass would debit and changes nothing.
 */
function PaymentPolicyCard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = isAdmin(user?.role);
  const configQuery = useQuery({
    queryKey: ['config', 'payment'],
    queryFn: () => api.get('/config/payment').then(unwrap<PaymentConfig>),
  });
  const [draft, setDraft] = useState<PaymentPolicy | null>(null);
  const [saved, setSaved] = useState(false);
  const policy = draft ?? configQuery.data?.policy ?? null;

  const updateMutation = useMutation({
    mutationFn: () => api.put('/config/payment', policy),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['config', 'payment'] });
      setDraft(null);
    },
  });

  const previewMutation = useMutation({
    mutationFn: () =>
      api.post<AutoDebitRun>('/config/payment/auto-debit/run', { dryRun: true }).then((response) => response.data),
  });

  if (configQuery.isLoading || !policy) {
    return (
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            {t('admin.payment.title')}
          </Typography>
          <LoadingPanel label={t('common.loading')} />
        </CardContent>
      </Card>
    );
  }

  const patch = (changes: Partial<PaymentPolicy>) => {
    setSaved(false);
    setDraft({ ...policy, ...changes });
  };

  const leadDaysBroken =
    !Number.isInteger(policy.autoDebitLeadDays) ||
    policy.autoDebitLeadDays < 0 ||
    policy.autoDebitLeadDays > MAX_LEAD_DAYS;

  const run = previewMutation.data;
  const plannedTotal = (run?.planned ?? []).reduce((total, row) => total + (row.amount ?? 0), 0);

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          {t('admin.payment.title')}
        </Typography>
        <Alert severity="info" sx={{ mb: 2 }}>
          {t('admin.payment.info')}
        </Alert>
        {!canWrite && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {t('admin.payment.readOnly')}
          </Alert>
        )}

        <Stack spacing={2} sx={{ maxWidth: 720 }}>
          <FormControlLabel
            control={
              <Switch
                checked={policy.autoDebitEnabled}
                disabled={!canWrite}
                onChange={(e) => patch({ autoDebitEnabled: e.target.checked })}
              />
            }
            label={t('admin.payment.enabled')}
          />
          <TextField
            label={t('admin.payment.leadDays')}
            type="number"
            value={policy.autoDebitLeadDays}
            onChange={(e) => patch({ autoDebitLeadDays: Math.trunc(Number(e.target.value)) })}
            disabled={!canWrite}
            slotProps={{ htmlInput: { step: '1', min: '0', max: String(MAX_LEAD_DAYS) } }}
            sx={{ maxWidth: 280 }}
          />
          <Typography variant="caption" color="text.secondary">
            {t('admin.payment.leadDaysHelper')}
          </Typography>
          {leadDaysBroken && <Alert severity="error">{t('admin.payment.leadDaysRange', { max: MAX_LEAD_DAYS })}</Alert>}

          <Typography variant="body2" color="text.secondary">
            {t('admin.payment.checksum', { checksum: configQuery.data?.checksum ?? '—' })}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t('admin.payment.defaults', {
              details: `${configQuery.data?.defaults.autoDebitEnabled ? t('admin.payment.on') : t('admin.payment.off')} · ${configQuery.data?.defaults.autoDebitLeadDays ?? '—'} ${t('admin.payment.leadDaysUnit')}`,
            })}
          </Typography>

          {updateMutation.isError && <Alert severity="error">{(updateMutation.error as Error).message}</Alert>}
          {saved && <Alert severity="success">{t('admin.payment.saved')}</Alert>}
          <Button
            variant="contained"
            disabled={!canWrite || updateMutation.isPending || leadDaysBroken}
            onClick={() => updateMutation.mutate()}
            sx={{ alignSelf: 'flex-start' }}
          >
            {updateMutation.isPending ? t('common.processing') : t('admin.payment.save')}
          </Button>

          <Typography variant="subtitle2" sx={{ mt: 1 }}>
            {t('admin.payment.previewTitle')}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t('admin.payment.previewInfo')}
          </Typography>
          {previewMutation.isError && <Alert severity="error">{(previewMutation.error as Error).message}</Alert>}
          {run && (
            <Alert severity={run.planned.length > 0 ? 'warning' : 'success'}>
              {run.planned.length === 0
                ? t('admin.payment.previewNone', { scanned: run.scanned })
                : t('admin.payment.previewSummary', {
                    total: run.planned.length,
                    amount: formatLak(plannedTotal),
                    scanned: run.scanned,
                  })}
              {!run.enabled && <Typography sx={{ display: 'block' }}>{t('admin.payment.previewWhileOff')}</Typography>}
              <Stack spacing={0.5} sx={{ mt: 1 }}>
                {run.planned.map((row) => (
                  <Typography key={`${row.loanNumber}-${row.periodIndex}`} variant="body2">
                    {t('admin.payment.plannedRow', {
                      loan: row.loanNumber ?? '—',
                      period: row.periodIndex ?? '—',
                      amount: formatLak(row.amount ?? 0),
                      dueDate: row.dueDate ?? '—',
                    })}
                  </Typography>
                ))}
              </Stack>
            </Alert>
          )}
          <Button
            variant="outlined"
            disabled={!canWrite || previewMutation.isPending}
            onClick={() => previewMutation.mutate()}
            sx={{ alignSelf: 'flex-start' }}
          >
            {previewMutation.isPending ? t('common.processing') : t('admin.payment.preview')}
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}

/**
 * The security policy behind a hardship addendum: how much of what is still owed pledged property has
 * to cover, how old an appraisal may be before it stops counting, and whether a loan with no in-date
 * pledge may be restructured at all. An ADDENDUM always needs at least one pledge before it is accepted,
 * so raising the floor changes what the desk can offer without touching any recorded valuation.
 */
function CollateralPolicyCard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = isAdmin(user?.role);
  const configQuery = useQuery({
    queryKey: ['config', 'collateral'],
    queryFn: () => api.get('/config/collateral').then(unwrap<CollateralConfig>),
  });
  const [draft, setDraft] = useState<CollateralPolicy | null>(null);
  const [saved, setSaved] = useState(false);
  const policy = draft ?? configQuery.data?.policy ?? null;

  const updateMutation = useMutation({
    mutationFn: () => api.put('/config/collateral', policy),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['config', 'collateral'] });
      setDraft(null);
    },
  });

  if (configQuery.isLoading || !policy) {
    return (
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            {t('admin.collateral.title')}
          </Typography>
          <LoadingPanel label={t('common.loading')} />
        </CardContent>
      </Card>
    );
  }

  const patch = (changes: Partial<CollateralPolicy>) => {
    setSaved(false);
    setDraft({ ...policy, ...changes });
  };

  const coverageBroken =
    !Number.isFinite(policy.minCoveragePercent) ||
    policy.minCoveragePercent < 0 ||
    policy.minCoveragePercent > MAX_COVERAGE_PERCENT;
  const ageBroken =
    !Number.isInteger(policy.maxValuationAgeDays) ||
    policy.maxValuationAgeDays < 0 ||
    policy.maxValuationAgeDays > MAX_VALUATION_AGE_DAYS;
  const defaults = configQuery.data?.defaults;

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          {t('admin.collateral.title')}
        </Typography>
        <Alert severity="info" sx={{ mb: 2 }}>
          {t('admin.collateral.info')}
        </Alert>
        {!canWrite && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {t('admin.collateral.readOnly')}
          </Alert>
        )}

        <Stack spacing={2} sx={{ maxWidth: 720 }}>
          <TextField
            label={t('admin.collateral.minCoverage')}
            type="number"
            value={policy.minCoveragePercent}
            onChange={(e) => patch({ minCoveragePercent: Number(e.target.value) })}
            disabled={!canWrite}
            slotProps={{ htmlInput: { step: '1', min: '0', max: String(MAX_COVERAGE_PERCENT) } }}
            sx={{ maxWidth: 280 }}
          />
          <Typography variant="caption" color="text.secondary">
            {t('admin.collateral.minCoverageHelper')}
          </Typography>
          {coverageBroken && (
            <Alert severity="error">{t('admin.collateral.coverageRange', { max: MAX_COVERAGE_PERCENT })}</Alert>
          )}

          <TextField
            label={t('admin.collateral.valuationAge')}
            type="number"
            value={policy.maxValuationAgeDays}
            onChange={(e) => patch({ maxValuationAgeDays: Math.trunc(Number(e.target.value)) })}
            disabled={!canWrite}
            slotProps={{ htmlInput: { step: '1', min: '0', max: String(MAX_VALUATION_AGE_DAYS) } }}
            sx={{ maxWidth: 280 }}
          />
          <Typography variant="caption" color="text.secondary">
            {t('admin.collateral.valuationAgeHelper')}
          </Typography>
          {ageBroken && <Alert severity="error">{t('admin.collateral.valuationAgeRange', { max: MAX_VALUATION_AGE_DAYS })}</Alert>}

          <FormControlLabel
            control={
              <Switch
                checked={policy.requirePledgeForRestructure}
                disabled={!canWrite}
                onChange={(e) => patch({ requirePledgeForRestructure: e.target.checked })}
              />
            }
            label={t('admin.collateral.requirePledge')}
          />

          <Typography variant="body2" color="text.secondary">
            {t('admin.collateral.checksum', { checksum: configQuery.data?.checksum ?? '—' })}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t('admin.collateral.defaults', {
              details: `${defaults?.minCoveragePercent ?? '—'} ${t('admin.collateral.percentUnit')} · ${
                defaults?.maxValuationAgeDays ?? '—'
              } ${t('admin.collateral.daysUnit')} · ${
                defaults?.requirePledgeForRestructure ? t('admin.collateral.on') : t('admin.collateral.off')
              }`,
            })}
          </Typography>

          {updateMutation.isError && <Alert severity="error">{(updateMutation.error as Error).message}</Alert>}
          {saved && <Alert severity="success">{t('admin.collateral.saved')}</Alert>}
          <Button
            variant="contained"
            disabled={!canWrite || updateMutation.isPending || coverageBroken || ageBroken}
            onClick={() => updateMutation.mutate()}
            sx={{ alignSelf: 'flex-start' }}
          >
            {updateMutation.isPending ? t('common.processing') : t('admin.collateral.save')}
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}

/**
 * The rules every evidence image is checked against: how large one scan may be, how many arrive per
 * request, which image types count, and how much storage one customer or one loan may hold in total.
 * These limits cover bank account proofs and disbursement slips only — identity paperwork is KYC's own.
 */
function EvidencePolicyCard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = isAdmin(user?.role);
  const configQuery = useQuery({
    queryKey: ['config', 'evidence'],
    queryFn: () => api.get('/config/evidence').then(unwrap<EvidenceConfig>),
  });
  const [draft, setDraft] = useState<EvidencePolicy | null>(null);
  const [saved, setSaved] = useState(false);
  const policy = draft ?? configQuery.data?.policy ?? null;

  const updateMutation = useMutation({
    mutationFn: () => api.put('/config/evidence', policy),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['config', 'evidence'] });
      setDraft(null);
    },
  });

  if (configQuery.isLoading || !policy) {
    return (
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            {t('admin.evidence.title')}
          </Typography>
          <LoadingPanel label={t('common.loading')} />
        </CardContent>
      </Card>
    );
  }

  const patch = (changes: Partial<EvidencePolicy>) => {
    setSaved(false);
    setDraft({ ...policy, ...changes });
  };

  const toggleValue = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  const sizeBroken =
    !Number.isInteger(policy.maxFileSizeKb) ||
    policy.maxFileSizeKb < 1 ||
    policy.maxFileSizeKb > MAX_EVIDENCE_FILE_SIZE_KB;
  const perRequestBroken =
    !Number.isInteger(policy.maxFilesPerRequest) ||
    policy.maxFilesPerRequest < 1 ||
    policy.maxFilesPerRequest > MAX_EVIDENCE_FILES_PER_REQUEST;
  const mimeBroken = policy.allowedMimeTypes.length === 0;
  const quotaBroken = policy.maxTotalBytesPerOwner < policy.maxFileSizeKb * 1024;
  const defaults = configQuery.data?.defaults;

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          {t('admin.evidence.title')}
        </Typography>
        <Alert severity="info" sx={{ mb: 2 }}>
          {t('admin.evidence.info')}
        </Alert>
        {!canWrite && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {t('admin.evidence.readOnly')}
          </Alert>
        )}

        <Stack spacing={2} sx={{ maxWidth: 720 }}>
          <TextField
            label={t('admin.evidence.maxFileSizeKb')}
            type="number"
            value={policy.maxFileSizeKb}
            onChange={(e) => patch({ maxFileSizeKb: Math.trunc(Number(e.target.value)) })}
            disabled={!canWrite}
            slotProps={{ htmlInput: { step: '1', min: '1', max: String(MAX_EVIDENCE_FILE_SIZE_KB) } }}
            sx={{ maxWidth: 280 }}
          />
          {sizeBroken && (
            <Alert severity="error">{t('admin.evidence.sizeRange', { max: MAX_EVIDENCE_FILE_SIZE_KB })}</Alert>
          )}

          <TextField
            label={t('admin.evidence.maxFilesPerRequest')}
            type="number"
            value={policy.maxFilesPerRequest}
            onChange={(e) => patch({ maxFilesPerRequest: Math.trunc(Number(e.target.value)) })}
            disabled={!canWrite}
            slotProps={{ htmlInput: { step: '1', min: '1', max: String(MAX_EVIDENCE_FILES_PER_REQUEST) } }}
            sx={{ maxWidth: 280 }}
          />
          {perRequestBroken && (
            <Alert severity="error">
              {t('admin.evidence.perRequestRange', { max: MAX_EVIDENCE_FILES_PER_REQUEST })}
            </Alert>
          )}

          <Stack spacing={0.5}>
            <Typography variant="subtitle2">{t('admin.evidence.allowedMimeTypes')}</Typography>
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
            {mimeBroken && <Alert severity="error">{t('admin.evidence.needMimeType')}</Alert>}
          </Stack>

          <Stack spacing={0.5}>
            <TextField
              label={t('admin.evidence.maxTotalBytesPerOwner')}
              type="number"
              value={Number((policy.maxTotalBytesPerOwner / BYTES_PER_MB).toFixed(2))}
              onChange={(e) => patch({ maxTotalBytesPerOwner: Math.round(Number(e.target.value) * BYTES_PER_MB) })}
              disabled={!canWrite}
              slotProps={{ htmlInput: { step: '0.1', min: '0.1' } }}
              sx={{ maxWidth: 280 }}
            />
            <Typography variant="caption" color="text.secondary">
              {t('admin.evidence.quotaHelper')}
            </Typography>
            {quotaBroken && <Alert severity="error">{t('admin.evidence.quotaTooSmall')}</Alert>}
          </Stack>

          <Typography variant="body2" color="text.secondary">
            {t('admin.evidence.checksum', { checksum: configQuery.data?.checksum ?? '—' })}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t('admin.evidence.defaults', {
              details: `${defaults?.maxFileSizeKb ?? '—'} KB · ${defaults?.allowedMimeTypes.join(', ') ?? '—'}`,
            })}
          </Typography>

          {updateMutation.isError && <Alert severity="error">{(updateMutation.error as Error).message}</Alert>}
          {saved && <Alert severity="success">{t('admin.evidence.saved')}</Alert>}
          <Button
            variant="contained"
            disabled={!canWrite || updateMutation.isPending || sizeBroken || perRequestBroken || mimeBroken || quotaBroken}
            onClick={() => updateMutation.mutate()}
            sx={{ alignSelf: 'flex-start' }}
          >
            {updateMutation.isPending ? t('common.processing') : t('admin.evidence.save')}
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}
