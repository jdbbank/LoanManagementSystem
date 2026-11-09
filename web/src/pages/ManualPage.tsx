import CloseIcon from '@mui/icons-material/Close';
import PrintIcon from '@mui/icons-material/Print';
import SearchIcon from '@mui/icons-material/Search';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import FormControl from '@mui/material/FormControl';
import GlobalStyles from '@mui/material/GlobalStyles';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import manualEnglish from '../../../USER-MANUAL-EN.md?raw';
import manualThai from '../../../USER-MANUAL-TH.md?raw';
import Markdown, { ANCHOR_SCROLL_MARGIN } from '../components/Markdown';
import FlowDiagram from '../components/manual/FlowDiagram';
import { FLOWS, type ManualEdition } from '../components/manual/flows';
import PageHeader from '../components/PageHeader';
import { riseIn } from '../theme';
import { useDebounced } from '../utils/debounce';
import { blockText, parseMarkdown } from '../utils/markdown';

/**
 * The manual is read straight from the two files at the repo root — `USER-MANUAL-EN.md` and
 * `USER-MANUAL-TH.md` — so the documents stay the single source of truth: editing a file changes this
 * page, and this page never edits the file. Both editions carry the same chapter numbers, so the flow
 * sheets are keyed by edition and chapter number together. The text lands in this lazy route's chunk,
 * so operators who never open the manual do not download it.
 */

const MANUAL_SOURCES: Record<ManualEdition, string> = { en: manualEnglish, th: manualThai };
const MANUAL_EDITION_KEY = 'loanms.manual.edition';

/** The interface has no Thai, so Lao branches keep reading the Thai edition and English branches the English one. */
const storedEdition = (): ManualEdition => {
  const stored = window.localStorage.getItem(MANUAL_EDITION_KEY);
  if (stored === 'en' || stored === 'th') return stored;
  return i18n.resolvedLanguage?.startsWith('lo') ? 'th' : 'en';
};

/** The printed manual is a document: the shell, the controls and the dark palette all step aside. */
const PRINT_STYLES = {
  '@media print': {
    '[data-print-hide]': { display: 'none !important' },
    '.MuiAppBar-root, .MuiDrawer-root': { display: 'none !important' },
    '#main-content': { width: '100% !important', padding: '0 !important' },
    'body': { backgroundColor: '#FFFFFF !important' },
    '.MuiPaper-root': { backgroundColor: '#FFFFFF !important', boxShadow: 'none !important', backgroundImage: 'none !important' },
    '[data-manual] .MuiTypography-root': { color: '#12202B !important' },
    'a': { color: 'inherit !important', textDecoration: 'none !important' },
    'h2, h3': { breakAfter: 'avoid' },
    'tr, svg, pre': { breakInside: 'avoid' },
  },
};

const chapterLabel = (number: string, title: string) => (number ? `${number}. ${title}` : title);

export default function ManualPage() {
  const { t } = useTranslation();
  const [edition, setEdition] = useState<ManualEdition>(storedEdition);
  const [term, setTerm] = useState('');
  const [activeId, setActiveId] = useState('');
  const query = useDebounced(term.trim().toLowerCase(), 200);

  const doc = useMemo(() => parseMarkdown(MANUAL_SOURCES[edition]), [edition]);
  /** Search covers the whole chapter body, not just its title, because operators look for a symptom. */
  const haystack = useMemo(
    () => new Map(doc.sections.map((section) => [section.id, `${section.title} ${section.blocks.map(blockText).join(' ')}`.toLowerCase()])),
    [doc],
  );
  const visible = useMemo(
    () => (query ? doc.sections.filter((section) => haystack.get(section.id)?.includes(query)) : doc.sections),
    [doc, haystack, query],
  );

  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    /** The chapter list renders in one pass, so the anchor exists after the first paint. */
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
  }, []);

  /** The sidebar follows the scroll, otherwise a 1,000-line document gives no sense of place. */
  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        let current = visible[0]?.id ?? '';
        for (const section of visible) {
          const el = document.getElementById(section.id);
          if (!el) continue;
          if (el.getBoundingClientRect().top > ANCHOR_SCROLL_MARGIN + 8) break;
          current = section.id;
        }
        setActiveId(current);
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [visible]);

  const goTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.history.replaceState(null, '', `#${id}`);
    setActiveId(id);
  };

  /** A Thai search term cannot match English prose, so switching editions starts a clean search. */
  const changeEdition = (next: ManualEdition) => {
    setEdition(next);
    setTerm('');
    window.localStorage.setItem(MANUAL_EDITION_KEY, next);
  };

  return (
    <Box data-manual>
      <GlobalStyles styles={PRINT_STYLES} />
      <PageHeader
        title="User Manual"
        actions={
          <Stack direction="row" spacing={1} data-print-hide>
            <FormControl size="small">
              <Select
                value={edition}
                onChange={(event) => changeEdition(event.target.value as ManualEdition)}
                inputProps={{ 'aria-label': t('manual.editionLabel') }}
                sx={{ height: 36, borderRadius: 2.5, fontSize: 13 }}
              >
                <MenuItem value="en">{t('manual.editionEn')}</MenuItem>
                <MenuItem value="th">{t('manual.editionTh')}</MenuItem>
              </Select>
            </FormControl>
            <Button startIcon={<PrintIcon />} variant="outlined" onClick={() => window.print()}>
              {t('manual.print')}
            </Button>
          </Stack>
        }
      />

      <Grid container spacing={2.5} sx={{ alignItems: 'flex-start' }}>
        <Grid size={{ xs: 12, md: 4, lg: 3 }} component="aside">
          <Box sx={{ position: { md: 'sticky' }, top: { md: ANCHOR_SCROLL_MARGIN } }} data-print-hide>
            <Card sx={riseIn()}>
              <CardContent>
                <TextField
                  autoComplete="off"
                  aria-label={t('manual.searchPlaceholder')}
                  fullWidth
                  onChange={(event) => setTerm(event.target.value)}
                  placeholder={t('manual.searchPlaceholder')}
                  slotProps={{
                    input: {
                      startAdornment: (
                        <InputAdornment position="start">
                          <SearchIcon fontSize="small" />
                        </InputAdornment>
                      ),
                      endAdornment: term ? (
                        <InputAdornment position="end">
                          <IconButton aria-label={t('common.close')} size="small" onClick={() => setTerm('')}>
                            <CloseIcon fontSize="small" />
                          </IconButton>
                        </InputAdornment>
                      ) : null,
                    },
                  }}
                  sx={{ mb: 1.5 }}
                  value={term}
                />
                <Typography variant="overline" sx={{ color: 'text.secondary', fontSize: 10 }}>
                  {t('manual.contents')}
                </Typography>
                {query && (
                  <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                    {t('manual.matches', { shown: visible.length, total: doc.sections.length })}
                  </Typography>
                )}
                <List dense sx={{ maxHeight: { md: 'calc(100vh - 260px)' }, overflowY: 'auto', mt: 0.5 }}>
                  {visible.map((section) => (
                    <ListItemButton
                      key={section.id}
                      onClick={() => goTo(section.id)}
                      selected={section.id === activeId}
                      sx={{
                        borderRadius: 2,
                        py: 0.5,
                        alignItems: 'flex-start',
                        '&.Mui-selected': { bgcolor: 'action.selected', '&:hover': { bgcolor: 'action.hover' } },
                      }}
                    >
                      <ListItemText
                        primary={chapterLabel(section.number, section.title)}
                        slotProps={{ primary: { variant: 'body2', sx: { lineHeight: 1.45 } } }}
                      />
                    </ListItemButton>
                  ))}
                  {visible.length === 0 && (
                    <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 1 }}>
                      {t('manual.noMatches')}
                    </Typography>
                  )}
                </List>
              </CardContent>
            </Card>
          </Box>
        </Grid>

        <Grid size={{ xs: 12, md: 8, lg: 9 }}>
          <Card sx={riseIn(60)}>
            <CardContent sx={{ maxWidth: 900 }}>
              <Alert severity="info" sx={{ mb: 2 }} data-print-hide>
                {t('manual.languageNote')}
              </Alert>

              <Markdown blocks={doc.front} />

              {visible.map((section) => {
                const flow = FLOWS[edition][section.number];
                return (
                  <Box key={section.id}>
                    <Markdown blocks={section.blocks} />
                    {flow && <FlowDiagram spec={flow} />}
                  </Box>
                );
              })}
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
