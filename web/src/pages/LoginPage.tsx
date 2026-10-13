import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import FormControl from '@mui/material/FormControl';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import i18n from '../i18n';
import { useAuth } from '../auth/AuthContext';
import ForgotPasswordDialog from '../components/ForgotPasswordDialog';
import { useThemeMode } from '../theme-mode';

const DEMO_ACCOUNTS = [
  { username: 'admin', password: 'Admin@123', label: 'Admin' },
  { username: 'head', password: 'Head@123', label: 'Head Approver' },
  { username: 'checker', password: 'Checker@123', label: 'Checker' },
  { username: 'maker', password: 'Maker@123', label: 'Maker' },
  { username: 'viewer', password: 'Viewer@123', label: 'Viewer' },
];

export default function LoginPage() {
  const { t } = useTranslation();
  const { mode, toggleMode } = useThemeMode();
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
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
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 1, mb: 1 }}>
            <FormControl size="small" sx={{ minWidth: 100 }}>
              <Select
                value={i18n.resolvedLanguage?.startsWith('lo') ? 'lo' : 'en'}
                onChange={(event) => { void i18n.changeLanguage(event.target.value); }}
                inputProps={{ 'aria-label': t('common.language') }}
                sx={{ height: 34, borderRadius: 2.5, fontSize: 13 }}
              >
                <MenuItem value="en">{t('languageNames.en')}</MenuItem>
                <MenuItem value="lo">{t('languageNames.lo')}</MenuItem>
              </Select>
            </FormControl>
            <Tooltip title={t(mode === 'light' ? 'common.dark' : 'common.light')}>
              <IconButton
                aria-label={t('common.theme')}
                onClick={toggleMode}
                sx={{ border: 1, borderColor: 'divider', color: 'text.secondary' }}
              >
                {mode === 'light' ? <DarkModeIcon fontSize="small" /> : <LightModeIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          </Box>
          <Box sx={{ mb: 3.5 }}>
            <Typography variant="overline" color="secondary.main" sx={{ fontSize: 10 }}>
              {t('auth.secureWorkspace')}
            </Typography>
            <Typography variant="h5" sx={{ fontWeight: 800, mt: 0.5 }} gutterBottom>
              {t('auth.title')}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t('auth.subtitle')}
            </Typography>
          </Box>
          <Box component="form" onSubmit={submit}>
            <Stack spacing={2}>
              <TextField
                label={t('auth.username')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                fullWidth
                required
              />
              <TextField
                label={t('auth.password')}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                fullWidth
                required
              />
              {error && <Alert severity="error">{error}</Alert>}
              <Button type="submit" variant="contained" size="large" disabled={submitting}>
                {submitting ? t('auth.signingIn') : t('auth.signIn')}
              </Button>
              <Button onClick={() => setForgotOpen(true)} size="small" sx={{ alignSelf: 'center' }}>
                {t('auth.forgot')}
              </Button>
            </Stack>
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 3, mb: 1 }}>
            {t('auth.demoAccounts')}
          </Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {DEMO_ACCOUNTS.map((acc) => (
              <Button
                key={acc.username}
                size="small"
                variant="outlined"
                onClick={() => {
                  setUsername(acc.username);
                  setPassword(acc.password);
                }}
              >
                {t(`roles.${acc.username === 'head' ? 'HEAD_APPROVER' : acc.username.toUpperCase()}`)}
              </Button>
            ))}
          </Stack>
        </CardContent>
      </Card>
      <ForgotPasswordDialog open={forgotOpen} onClose={() => setForgotOpen(false)} />
    </Box>
  );
}
