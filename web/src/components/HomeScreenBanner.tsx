import CloseIcon from '@mui/icons-material/Close';
import InstallMobileIcon from '@mui/icons-material/InstallMobile';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { riseIn } from '../theme';
import HomeScreenGuide from './HomeScreenGuide';

/**
 * Chrome never installs by itself: it hands the page a `beforeinstallprompt` event and waits. The
 * event has to be kept, because it is the only way to show the real install dialog later.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'loanms.homeScreen';
/** "Not now" is a reminder setting, not a permanent opt-out, so the hint returns after a month. */
const REMINDER_DAYS = 30;

type Platform = 'ios' | 'android' | 'other';
type Guide = Exclude<Platform, 'other'>;

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  // iPadOS Safari reports a desktop Macintosh user agent, so the touch count is what separates them.
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

function runningAsApp(): boolean {
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  // iOS Safari exposes its own flag instead of the display-mode query.
  return standalone || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function dismissedRecently(): boolean {
  const stored = localStorage.getItem(DISMISS_KEY);
  if (!stored) return false;
  const at = Date.parse(stored);
  if (Number.isNaN(at)) return true;
  return Date.now() - at < REMINDER_DAYS * 86_400_000;
}

export default function HomeScreenBanner() {
  const { t } = useTranslation();
  const theme = useTheme();
  const phoneLayout = useMediaQuery(theme.breakpoints.down('md'));
  const platform = useMemo(() => detectPlatform(), []);
  const [deferredPrompt, setDeferredPrompt] = useState<InstallPromptEvent | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [asApp, setAsApp] = useState(runningAsApp);
  const [dismissed, setDismissed] = useState(dismissedRecently);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => setAsApp(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!phoneLayout || asApp || dismissed || platform === 'other') return null;

  const guide: Guide = platform === 'ios' ? 'ios' : 'android';

  const start = async () => {
    if (!deferredPrompt) {
      setGuideOpen(true);
      return;
    }
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
  };

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, new Date().toISOString());
    setDismissed(true);
  };

  return (
    <>
      <Card variant="outlined" sx={{ ...riseIn(), mb: 2 }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', p: 1.5 }}>
          <Avatar variant="rounded" src="/icons/pwa-192x192.png" alt="" sx={{ width: 44, height: 44 }} />
          <Box sx={{ minWidth: 0, flexGrow: 1 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {t('homeScreen.title', { appName: t('navigation.appTitle') })}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {t('homeScreen.subtitle')}
            </Typography>
          </Box>
          <Button
            size="small"
            variant="contained"
            startIcon={<InstallMobileIcon />}
            onClick={() => void start()}
            sx={{ flexShrink: 0 }}
          >
            {t(deferredPrompt ? 'homeScreen.install' : 'homeScreen.how')}
          </Button>
          <IconButton size="small" aria-label={t('homeScreen.dismiss')} onClick={dismiss}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>
      </Card>
      {guideOpen && <HomeScreenGuide guide={guide} onClose={() => setGuideOpen(false)} />}
    </>
  );
}
