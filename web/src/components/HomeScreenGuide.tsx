import CloseIcon from '@mui/icons-material/Close';
import HomeIcon from '@mui/icons-material/Home';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import ShareIcon from '@mui/icons-material/Share';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Modal from '@mui/material/Modal';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pulse, riseIn } from '../theme';

type Guide = 'ios' | 'android';

const STEP_COUNT = 3;

/** Placeholder for OS chrome the app must not name: the phone writes its own labels. */
function Bar({ width = 96 }: { width?: number }) {
  return <Box sx={{ height: 7, width, borderRadius: 99, bgcolor: 'action.disabledBackground' }} />;
}

/** The page sitting behind a sheet or a dialog, so the mock never reads as an empty panel. */
function PageLines() {
  return (
    <Stack spacing={1} sx={{ p: 1.5 }}>
      <Bar width={120} />
      <Bar width={156} />
      <Bar width={92} />
    </Stack>
  );
}

function Target({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        ...pulse(),
        display: 'grid',
        placeItems: 'center',
        width: 34,
        height: 34,
        borderRadius: 99,
        border: '1.5px solid',
        borderColor: 'secondary.main',
        bgcolor: 'background.paper',
        color: 'secondary.main',
      }}
    >
      {children}
    </Box>
  );
}

/** Step one: where the button that opens the menu actually sits, which differs per browser. */
function BrowserMock({ guide }: { guide: Guide }) {
  const dockedAtBottom = guide === 'ios';
  return (
    <Box sx={{ position: 'absolute', inset: 0 }}>
      <PageLines />
      <Stack
        direction="row"
        spacing={1}
        sx={{
          position: 'absolute',
          left: 0,
          right: 0,
          height: 46,
          px: 1.5,
          alignItems: 'center',
          bgcolor: 'background.paper',
          borderColor: 'divider',
          [dockedAtBottom ? 'bottom' : 'top']: 0,
          [dockedAtBottom ? 'borderTop' : 'borderBottom']: '1px solid',
        }}
      >
        <Box sx={{ flexGrow: 1, display: 'flex', gap: 0.75 }}>
          {[0, 1, 2].map((key) => (
            <Box key={key} sx={{ width: 13, height: 13, borderRadius: 99, border: '1px solid', borderColor: 'divider' }} />
          ))}
        </Box>
        <Target>{dockedAtBottom ? <ShareIcon sx={{ fontSize: 18 }} /> : <MoreVertIcon sx={{ fontSize: 18 }} />}</Target>
      </Stack>
    </Box>
  );
}

/** Step two: the list the browser opens, with only the one row the user needs named. */
function SheetMock({ guide }: { guide: Guide }) {
  const { t } = useTranslation();
  return (
    <Box
      sx={{
        position: 'absolute',
        left: 12,
        right: 12,
        bottom: 0,
        pt: 1,
        px: 1,
        borderTopLeftRadius: 3,
        borderTopRightRadius: 3,
        border: '1px solid',
        borderColor: 'divider',
        borderBottom: 0,
        bgcolor: 'background.paper',
      }}
    >
      <Box sx={{ width: 34, height: 4, mx: 'auto', mb: 1, borderRadius: 99, bgcolor: 'action.disabledBackground' }} />
      <Stack spacing={1} sx={{ pb: 1 }}>
        <Bar width={104} />
        <Stack
          direction="row"
          spacing={1}
          sx={{
            ...pulse(),
            alignItems: 'center',
            p: 0.75,
            borderRadius: 1.5,
            border: '1.5px solid',
            borderColor: 'secondary.main',
            color: 'secondary.main',
          }}
        >
          {guide === 'ios' ? <HomeIcon sx={{ fontSize: 18 }} /> : <ShareIcon sx={{ fontSize: 18 }} />}
          <Typography variant="caption" sx={{ fontWeight: 700 }}>
            {t('homeScreen.osAddLabel')}
          </Typography>
        </Stack>
        <Bar width={82} />
      </Stack>
    </Box>
  );
}

/** Step three: the confirmation, where the only word that matters is the positive one. */
function ConfirmMock() {
  const { t } = useTranslation();
  return (
    <Box
      sx={{
        position: 'absolute',
        left: '50%',
        bottom: 14,
        transform: 'translateX(-50%)',
        width: 216,
        p: 1.25,
        borderRadius: 2,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
      }}
    >
      <Stack spacing={1}>
        <Bar width={140} />
        <Bar width={104} />
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end', pt: 0.5 }}>
          <Box sx={{ px: 1.25, py: 0.5, borderRadius: 99, border: '1px solid', borderColor: 'divider' }}>
            <Bar width={34} />
          </Box>
          <Target>
            <Typography variant="caption" sx={{ fontWeight: 700 }}>
              {t('homeScreen.osAddButton')}
            </Typography>
          </Target>
        </Stack>
      </Stack>
    </Box>
  );
}

export default function HomeScreenGuide({ guide, onClose }: { guide: Guide; onClose: () => void }) {
  const { t } = useTranslation();
  // The banner mounts this only while the guide is open, so the walk always starts at step one.
  const [step, setStep] = useState(0);
  const last = step === STEP_COUNT - 1;

  return (
    <Modal open onClose={onClose}>
      <Box
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        sx={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      >
        <Box
          role="dialog"
          aria-label={t(`homeScreen.${guide}Title`)}
          sx={{
            width: '100%',
            maxWidth: 440,
            p: 2.5,
            pb: 2,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            bgcolor: 'background.paper',
            boxShadow: '0 -12px 44px rgba(4, 20, 32, 0.28)',
          }}
        >
          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
            <Box sx={{ minWidth: 0, flexGrow: 1 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                {t(`homeScreen.${guide}Title`)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t('homeScreen.stepOf', { current: step + 1, total: STEP_COUNT })}
              </Typography>
            </Box>
            <IconButton size="small" aria-label={t('common.close')} onClick={onClose}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Stack>

          <Box
            key={step}
            sx={{
              ...riseIn(),
              position: 'relative',
              height: 168,
              mt: 2,
              overflow: 'hidden',
              borderRadius: 2,
              border: '1px solid',
              borderColor: 'divider',
              bgcolor: 'background.default',
            }}
          >
            {step === 0 ? (
              <BrowserMock guide={guide} />
            ) : (
              <>
                <PageLines />
                {step === 1 ? <SheetMock guide={guide} /> : <ConfirmMock />}
              </>
            )}
          </Box>

          <Typography variant="body2" sx={{ mt: 2 }}>
            {t(`homeScreen.${guide}Step${step + 1}`)}
          </Typography>
          {last && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              {t(`homeScreen.${guide}Note`)}
            </Typography>
          )}

          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mt: 2 }}>
            <Button size="small" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={step === 0}>
              {t('homeScreen.back')}
            </Button>
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
              {Array.from({ length: STEP_COUNT }, (_, index) => (
                <Box
                  key={index}
                  onClick={() => setStep(index)}
                  sx={{
                    width: index === step ? 18 : 7,
                    height: 7,
                    borderRadius: 99,
                    bgcolor: index === step ? 'secondary.main' : 'action.disabledBackground',
                    cursor: 'pointer',
                  }}
                />
              ))}
            </Stack>
            <Button
              size="small"
              variant="contained"
              onClick={() => (last ? onClose() : setStep((value) => value + 1))}
            >
              {last ? t('homeScreen.gotIt') : t('homeScreen.next')}
            </Button>
          </Stack>
        </Box>
      </Box>
    </Modal>
  );
}
