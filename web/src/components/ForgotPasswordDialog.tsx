import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';

type Step = 'email' | 'code';

/**
 * Steps 1 and 2 of the reset flow. Verifying the code hands back a single-use link token,
 * which the standalone /reset-password page consumes — the password itself is never typed here.
 */
export default function ForgotPasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<string | null>(null);

  const close = () => {
    setStep('email');
    setCode('');
    setError(null);
    setAcknowledged(null);
    onClose();
  };

  const requestMutation = useMutation({
    mutationFn: () => api.post('/auth/forgot-password', { email }),
    onSuccess: (response) => {
      setError(null);
      setAcknowledged((response.data as { message: string }).message);
      setStep('code');
    },
    onError: (err: Error) => setError(err.message),
  });

  const verifyMutation = useMutation({
    mutationFn: () => api.post('/auth/verify-otp', { email, otp: code }),
    onSuccess: (response) => {
      const { resetUrl } = response.data as { resetUrl: string };
      close();
      navigate(resetUrl);
    },
    onError: (err: Error) => setError(err.message),
  });

  const submitEmail = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    requestMutation.mutate();
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    verifyMutation.mutate();
  };

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="xs">
      <DialogTitle>{t(step === 'email' ? 'auth.forgotTitle' : 'auth.codeTitle')}</DialogTitle>
      <DialogContent>
        <Stack component="form" spacing={2} sx={{ pt: 0.5 }} onSubmit={step === 'email' ? submitEmail : submitCode}>
          <Typography variant="body2" color="text.secondary">
            {t(step === 'email' ? 'auth.forgotInfo' : 'auth.codeInfo')}
          </Typography>
          {step === 'email' ? (
            <TextField
              label={t('auth.email')}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              fullWidth
              required
            />
          ) : (
            <TextField
              label={t('auth.code')}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              autoFocus
              fullWidth
              required
              inputMode="numeric"
              helperText={t('auth.codeHelper')}
            />
          )}
          {acknowledged && step === 'code' && <Alert severity="info">{acknowledged}</Alert>}
          {error && <Alert severity="error">{error}</Alert>}
          <Button
            type="submit"
            variant="contained"
            disabled={requestMutation.isPending || verifyMutation.isPending}
          >
            {t(
              step === 'email'
                ? requestMutation.isPending
                  ? 'auth.sending'
                  : 'auth.sendCode'
                : verifyMutation.isPending
                  ? 'auth.verifying'
                  : 'auth.verify',
            )}
          </Button>
          <Button onClick={close}>{t('common.cancel')}</Button>
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
