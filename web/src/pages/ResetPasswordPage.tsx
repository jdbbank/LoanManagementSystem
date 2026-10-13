import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, unwrap } from '../api/client';
import type { PasswordPolicy } from '../api/types';
import { passwordRuleHints } from '../utils/password-rules';

/** Landing page of the emailed reset link: /reset-password?token=… */
export default function ResetPasswordPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const policyQuery = useQuery({
    queryKey: ['auth', 'password-policy'],
    queryFn: () =>
      api
        .get('/auth/password-policy')
        .then(unwrap<{ policy: PasswordPolicy }>),
    enabled: !done,
  });

  const resetMutation = useMutation({
    mutationFn: () => api.post('/auth/reset-password', { token, password }),
    onSuccess: () => setDone(true),
    onError: (err: Error) => setError(err.message),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError(t('auth.passwordMismatch'));
      return;
    }
    resetMutation.mutate();
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background:
          'radial-gradient(circle at 15% 15%, rgba(53, 195, 174, 0.28), transparent 30%), radial-gradient(circle at 90% 85%, rgba(57, 124, 165, 0.28), transparent 32%), linear-gradient(135deg, #102B40 0%, #173B57 58%, #0C756F 130%)',
        p: 2,
      }}
    >
      <Card sx={{ width: 440, maxWidth: '100%', p: 1, borderRadius: 4, boxShadow: '0 28px 90px rgba(4, 20, 32, 0.3)' }}>
        <CardContent>
          <Typography variant="overline" color="secondary.main" sx={{ fontSize: 10 }}>
            {t('auth.secureWorkspace')}
          </Typography>
          <Typography variant="h5" sx={{ fontWeight: 800, mt: 0.5 }} gutterBottom>
            {t('auth.resetTitle')}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            {t('auth.resetInfo')}
          </Typography>

          {done ? (
            <Stack spacing={2}>
              <Alert severity="success">{t('auth.resetDone')}</Alert>
              <Button variant="contained" onClick={() => navigate('/login', { replace: true })}>
                {t('auth.signIn')}
              </Button>
            </Stack>
          ) : !token ? (
            <Alert severity="error">{t('auth.resetNoToken')}</Alert>
          ) : (
            <Box component="form" onSubmit={submit}>
              <Stack spacing={2}>
                <TextField
                  label={t('auth.newPassword')}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  fullWidth
                  required
                  helperText={
                    policyQuery.data
                      ? passwordRuleHints(policyQuery.data.policy, t)
                      : t('common.loading')
                  }
                />
                <TextField
                  label={t('auth.confirmPassword')}
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  fullWidth
                  required
                />
                {error && <Alert severity="error">{error}</Alert>}
                <Button type="submit" variant="contained" size="large" disabled={resetMutation.isPending}>
                  {resetMutation.isPending ? t('common.processing') : t('auth.resetSubmit')}
                </Button>
                <Button onClick={() => navigate('/login', { replace: true })}>{t('auth.backToLogin')}</Button>
              </Stack>
            </Box>
          )}
          {policyQuery.isLoading && !done && token && (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 1.5 }}>
              <CircularProgress size={14} />
              <Typography variant="caption" color="text.secondary">
                {t('common.loading')}
              </Typography>
            </Stack>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
