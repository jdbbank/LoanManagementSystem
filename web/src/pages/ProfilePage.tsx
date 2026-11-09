import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, unwrap } from '../api/client';
import type { AvatarConfig, ManagedUser, PasswordExpiryInfo, PasswordPolicy, SelfProfileResponse } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import PageHeader from '../components/PageHeader';
import StatusChip from '../components/StatusChip';
import { LoadingPanel } from '../components/LoadingOverlay';
import { passwordRuleHints } from '../utils/password-rules';
import { AvatarUploader, UserAvatar } from './UsersPage';

const none = '—';

const shown = (iso: string | null, fallback = none) => (iso ? new Date(iso).toLocaleString() : fallback);

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontWeight: 600, textAlign: 'right' }}>
        {value}
      </Typography>
    </Stack>
  );
}

/** Read-only account facts: who this operator is, when they last signed in, how old the password is. */
function AccountDetailsCard({ profile, expiry }: { profile: ManagedUser; expiry: PasswordExpiryInfo }) {
  const { t } = useTranslation();

  return (
    <Card sx={{ height: '100%' }}>
      <CardContent>
        <Typography variant="subtitle1" sx={{ fontWeight: 750, mb: 2 }}>
          {t('profile.details')}
        </Typography>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 2 }}>
          <UserAvatar user={profile} size={44} />
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle2" noWrap>
              {profile.fullName}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {profile.username}
            </Typography>
          </Box>
        </Stack>
        <Divider sx={{ mb: 2 }} />
        <Stack spacing={1.25}>
          <DetailRow
            label={t('users.email')}
            value={
              profile.email ? (
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'flex-end' }}>
                  <span>{profile.email}</span>
                  <StatusChip status={profile.isEmailVerified ? 'VERIFIED' : 'NOT_VERIFIED'} />
                </Stack>
              ) : (
                t('users.emailMissing')
              )
            }
          />
          <DetailRow label={t('users.role')} value={t(`roles.${profile.role}`)} />
          <DetailRow
            label={t('users.status')}
            value={<StatusChip status={profile.isActive ? 'ACTIVE' : 'INACTIVE'} />}
          />
          <DetailRow label={t('users.lastLogin')} value={shown(profile.lastLoginAt, t('users.never'))} />
          <DetailRow label={t('profile.passwordChanged')} value={shown(profile.passwordChangedAt)} />
          {expiry.applies && (
            <DetailRow label={t('profile.passwordExpiresOn')} value={shown(expiry.expiresAt)} />
          )}
          <DetailRow label={t('profile.memberSince')} value={shown(profile.createdAt)} />
        </Stack>
      </CardContent>
    </Card>
  );
}

/** Name, email and photo of the signed-in account. Role and account status stay ADMIN-only. */
function ProfileDetailsCard({ profile, policy }: { profile: ManagedUser; policy: AvatarConfig | undefined }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { refresh } = useAuth();
  const [fullName, setFullName] = useState(profile.fullName);
  const [email, setEmail] = useState(profile.email ?? '');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => queryClient.invalidateQueries({ queryKey: ['users', 'me'] }).then(() => refresh());

  const saveMutation = useMutation({
    mutationFn: () => api.patch('/users/me', { fullName: fullName.trim(), email: email.trim() || null }),
    onSuccess: async () => {
      setError(null);
      setNotice(t('profile.saved'));
      await reload();
    },
    onError: (err: Error) => {
      setNotice(null);
      setError(err.message);
    },
  });

  const removeAvatarMutation = useMutation({
    mutationFn: () => api.delete(`/users/${profile.id}/avatar`),
    onSuccess: reload,
    onError: (err: Error) => setError(err.message),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    saveMutation.mutate();
  };

  return (
    <Card>
      <CardContent>
        <Typography variant="subtitle1" sx={{ fontWeight: 750, mb: 2 }}>
          {t('profile.editTitle')}
        </Typography>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start', mb: 2 }}>
          <UserAvatar user={profile} size={56} />
          <Stack spacing={0.75} sx={{ flexGrow: 1 }}>
            <Typography variant="subtitle2">{t('users.avatar')}</Typography>
            <AvatarUploader userId={profile.id} policy={policy?.policy} onUploaded={() => void reload()} />
            {profile.hasAvatar && (
              <Button
                size="small"
                color="error"
                disabled={removeAvatarMutation.isPending}
                onClick={() => removeAvatarMutation.mutate()}
                sx={{ alignSelf: 'flex-start' }}
              >
                {t('users.avatarRemove')}
              </Button>
            )}
          </Stack>
        </Stack>
        <Box component="form" onSubmit={submit}>
          <Stack spacing={2}>
            <TextField
              label={t('users.fullName')}
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              fullWidth
              required
            />
            <TextField
              label={t('users.email')}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              fullWidth
              helperText={t('profile.emailHelper')}
            />
            {notice && <Alert severity="success">{notice}</Alert>}
            {error && <Alert severity="error">{error}</Alert>}
            <Box>
              <Button type="submit" variant="contained" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? t('common.processing') : t('common.save')}
              </Button>
            </Box>
          </Stack>
        </Box>
      </CardContent>
    </Card>
  );
}

/** Password change for the signed-in account: proving the current password is mandatory. */
function PasswordCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const policyQuery = useQuery({
    queryKey: ['auth', 'password-policy'],
    queryFn: () => api.get('/auth/password-policy').then(unwrap<{ policy: PasswordPolicy }>),
  });

  const changeMutation = useMutation({
    mutationFn: () => api.post('/users/me/password', { currentPassword, newPassword }),
    onSuccess: () => {
      setError(null);
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
      setDone(true);
    },
    onError: (err: Error) => setError(err.message),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (newPassword !== confirm) {
      setError(t('auth.passwordMismatch'));
      return;
    }
    changeMutation.mutate();
  };

  return (
    <Card>
      <CardContent>
        <Typography variant="subtitle1" sx={{ fontWeight: 750, mb: 1 }}>
          {t('profile.passwordTitle')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('profile.passwordInfo')}
        </Typography>
        {done ? (
          <Stack spacing={2}>
            <Alert severity="success">{t('profile.passwordDone')}</Alert>
            <Button
              variant="contained"
              onClick={() => {
                logout();
                navigate('/login', { replace: true });
              }}
            >
              {t('profile.signInAgain')}
            </Button>
          </Stack>
        ) : (
          <Box component="form" onSubmit={submit}>
            <Stack spacing={2}>
              <TextField
                label={t('profile.currentPassword')}
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                fullWidth
                required
                autoComplete="current-password"
              />
              <TextField
                label={t('auth.newPassword')}
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                fullWidth
                required
                autoComplete="new-password"
                helperText={policyQuery.data ? passwordRuleHints(policyQuery.data.policy, t) : t('common.loading')}
              />
              <TextField
                label={t('auth.confirmPassword')}
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                fullWidth
                required
                autoComplete="new-password"
              />
              {error && <Alert severity="error">{error}</Alert>}
              <Box>
                <Button type="submit" variant="contained" disabled={changeMutation.isPending}>
                  {changeMutation.isPending ? t('common.processing') : t('profile.changePassword')}
                </Button>
              </Box>
            </Stack>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

export default function ProfilePage() {
  const { t } = useTranslation();

  const profileQuery = useQuery({
    queryKey: ['users', 'me'],
    queryFn: () => api.get('/users/me').then((response) => response.data as SelfProfileResponse),
  });
  const avatarQuery = useQuery({
    queryKey: ['config', 'avatar'],
    queryFn: () => api.get('/config/avatar').then(unwrap<AvatarConfig>),
  });

  const self = profileQuery.data;
  const profile = self?.user;
  if (profileQuery.isLoading) return <LoadingPanel label={t('common.loading')} />;

  // A password can age past its limit while the person is already signed in; the gate then closes
  // on their next sign-in, so say so here rather than letting it surprise them at the login form.
  const expiry = self?.passwordExpiry;
  const expiryNotice: { severity: 'error' | 'warning'; text: string } | null =
    expiry && expiry.warn
      ? {
          severity: expiry.expired ? 'error' : 'warning',
          text: expiry.expired
            ? t('profile.passwordExpired')
            : t('profile.passwordExpiringSoon', { days: expiry.daysLeft ?? 0 }),
        }
      : null;

  return (
    <Stack spacing={2}>
      <PageHeader title="Profile" />
      <Alert severity="info">{t('profile.info')}</Alert>
      {expiryNotice && (
        <Alert severity={expiryNotice.severity}>
          <Stack spacing={0.5}>
            <Typography variant="body2">{expiryNotice.text}</Typography>
            <Typography variant="caption">{t('profile.passwordHistoryHint')}</Typography>
          </Stack>
        </Alert>
      )}

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 6 }}>
          {profile && expiry ? (
            <AccountDetailsCard profile={profile} expiry={expiry} />
          ) : (
            <CircularProgress size={20} />
          )}
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <Stack spacing={2}>
            {profile && (
              <ProfileDetailsCard key={profile.id} profile={profile} policy={avatarQuery.data} />
            )}
            <PasswordCard />
          </Stack>
        </Grid>
      </Grid>
    </Stack>
  );
}
