import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, unwrap } from '../api/client';
import type { PasswordPolicy } from '../api/types';
import { passwordRuleHints } from '../utils/password-rules';

/**
 * The forced change at the login rotation gate. The account has already proven its password — the
 * server refused the session because the password is older than the limit — so this form only asks
 * for the replacement and hands the new value back so sign-in can continue without retyping.
 */
export default function ExpiredPasswordDialog({
  open,
  username,
  currentPassword,
  reason,
  onClose,
  onChanged,
}: {
  open: boolean;
  username: string;
  currentPassword: string;
  reason: string;
  onClose: () => void;
  onChanged: (newPassword: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const policyQuery = useQuery({
    queryKey: ['auth', 'password-policy'],
    queryFn: () => api.get('/auth/password-policy').then(unwrap<{ policy: PasswordPolicy }>),
  });

  const changeMutation = useMutation({
    mutationFn: () => api.post('/auth/change-expired-password', { username, currentPassword, newPassword }),
    onSuccess: async () => {
      setError(null);
      setNewPassword('');
      setConfirm('');
      await onChanged(newPassword);
    },
    onError: (err: Error) => setError(err.message),
  });

  const close = () => {
    setError(null);
    setNewPassword('');
    setConfirm('');
    onClose();
  };

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
    <Dialog open={open} onClose={close} fullWidth maxWidth="xs">
      <DialogTitle>{t('auth.expiredTitle')}</DialogTitle>
      <DialogContent>
        <Stack component="form" spacing={2} sx={{ pt: 0.5 }} onSubmit={submit}>
          <Typography variant="body2" color="text.secondary">
            {t('auth.expiredInfo')}
          </Typography>
          <Alert severity="warning">{reason}</Alert>
          <TextField
            label={t('auth.newPassword')}
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoFocus
            fullWidth
            required
            autoComplete="new-password"
            helperText={policyQuery.data ? passwordRuleHints(policyQuery.data.policy, t) : t('common.loading')}
          />
          <TextField
            label={t('auth.confirmPassword')}
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            fullWidth
            required
            autoComplete="new-password"
          />
          {error && <Alert severity="error">{error}</Alert>}
          <Button type="submit" variant="contained" disabled={changeMutation.isPending}>
            {t(changeMutation.isPending ? 'auth.changing' : 'auth.expiredSubmit')}
          </Button>
          <Button onClick={close}>{t('common.cancel')}</Button>
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
