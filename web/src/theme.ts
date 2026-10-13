import { createTheme, type PaletteMode } from '@mui/material/styles';

export function createAppTheme(mode: PaletteMode) {
  const isDark = mode === 'dark';
  const colors = isDark
    ? {
        background: '#111B22',
        paper: '#19262F',
        text: '#E7EFF3',
        secondaryText: '#A5B4BD',
        divider: '#2A3A45',
        border: '#2B3B46',
        tableHead: '#202F39',
        hover: 'rgba(53, 195, 174, 0.075)',
      }
    : {
        background: '#F3F6F8',
        paper: '#FFFFFF',
        text: '#1B2B38',
        secondaryText: '#667784',
        divider: '#E5EBEF',
        border: '#E5EBEF',
        tableHead: '#F3F7F8',
        hover: 'rgba(12, 155, 138, 0.035)',
      };

  return createTheme({
    palette: {
      mode,
      primary: {
        main: isDark ? '#62B6D0' : '#173B57',
        light: isDark ? '#93D5E6' : '#315C78',
        dark: isDark ? '#3189A7' : '#102B40',
        contrastText: isDark ? '#10232B' : '#FFFFFF',
      },
      secondary: {
        main: isDark ? '#43C6AE' : '#0C9B8A',
        light: isDark ? '#72E0CA' : '#35C3AE',
        dark: isDark ? '#24A58F' : '#087667',
        contrastText: isDark ? '#0D2928' : '#FFFFFF',
      },
      success: { main: isDark ? '#4DC5A3' : '#16856D' },
      warning: { main: isDark ? '#F0B95D' : '#C47A16' },
      error: { main: isDark ? '#F07878' : '#C3484B' },
      info: { main: isDark ? '#73B8DD' : '#397CA5' },
      background: { default: colors.background, paper: colors.paper },
      text: { primary: colors.text, secondary: colors.secondaryText },
      divider: colors.divider,
    },
    shape: { borderRadius: 12 },
    typography: {
      fontFamily: '"Noto Sans Lao", "Segoe UI", Tahoma, Arial, sans-serif',
      h4: { fontWeight: 750, letterSpacing: '-0.035em' },
      h5: { fontWeight: 750, letterSpacing: '-0.025em' },
      h6: { fontWeight: 700, letterSpacing: '-0.015em' },
      button: { textTransform: 'none', fontWeight: 650, letterSpacing: '0.01em' },
      overline: { fontWeight: 700, letterSpacing: isDark ? '0.07em' : '0.12em' },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            backgroundImage: isDark
              ? 'radial-gradient(ellipse at 92% 0%, rgba(67, 198, 174, 0.075), transparent 34%), linear-gradient(180deg, #15232C 0%, #111B22 100%)'
              : 'radial-gradient(ellipse at 92% 0%, rgba(12, 155, 138, 0.045), transparent 34%), linear-gradient(180deg, #F7F9FA 0%, #F1F5F7 100%)',
            minHeight: '100vh',
          },
          '::selection': {
            backgroundColor: isDark ? 'rgba(67, 198, 174, 0.32)' : 'rgba(12, 155, 138, 0.2)',
          },
        },
      },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: { root: { backgroundImage: 'none' } },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            border: `1px solid ${colors.border}`,
            borderRadius: 16,
            backgroundImage: isDark
              ? 'linear-gradient(145deg, rgba(255,255,255,0.018), transparent 55%)'
              : 'none',
            boxShadow: isDark
              ? '0 8px 28px rgba(0, 0, 0, 0.14)'
              : '0 3px 14px rgba(23, 59, 87, 0.035)',
            transition: 'box-shadow 160ms ease, transform 160ms ease',
          },
        },
      },
      MuiCardContent: {
        styleOverrides: { root: { padding: 22, '&:last-child': { paddingBottom: 22 } } },
      },
      MuiAppBar: {
        styleOverrides: {
          root: {
            backgroundColor: isDark ? 'rgba(25, 38, 47, 0.9)' : 'rgba(255, 255, 255, 0.9)',
            color: colors.text,
            backdropFilter: 'blur(16px)',
            borderBottom: `1px solid ${colors.border}`,
            boxShadow: isDark
              ? '0 4px 20px rgba(0, 0, 0, 0.16)'
              : '0 4px 20px rgba(23, 59, 87, 0.035)',
          },
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: {
            backgroundColor: '#102B40',
            color: '#F4F8FA',
            border: 0,
            backgroundImage: 'linear-gradient(180deg, #153A55 0%, #102B40 58%, #0D2638 100%)',
          },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: {
            minHeight: 38,
            borderRadius: 10,
            paddingInline: 15,
            transition: 'transform 140ms ease, box-shadow 140ms ease, background-color 140ms ease',
            '&.MuiButton-containedPrimary': {
              boxShadow: isDark
                ? '0 5px 14px rgba(98, 182, 208, 0.18)'
                : '0 5px 14px rgba(23, 59, 87, 0.16)',
            },
            '&.MuiButton-containedPrimary:hover': {
              boxShadow: isDark
                ? '0 7px 18px rgba(98, 182, 208, 0.26)'
                : '0 7px 18px rgba(23, 59, 87, 0.22)',
              transform: 'translateY(-1px)',
            },
            '&.MuiButton-containedSecondary': {
              boxShadow: '0 5px 14px rgba(12, 155, 138, 0.16)',
            },
            '&.MuiButton-containedSecondary:hover': {
              boxShadow: '0 7px 18px rgba(12, 155, 138, 0.22)',
              transform: 'translateY(-1px)',
            },
          },
        },
      },
      MuiIconButton: { styleOverrides: { root: { borderRadius: 10 } } },
      MuiTextField: { defaultProps: { size: 'small' } },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: 10,
            backgroundColor: colors.paper,
            '&:hover .MuiOutlinedInput-notchedOutline': {
              borderColor: isDark ? '#66808E' : '#9BB0BC',
            },
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderWidth: 1.5 },
          },
        },
      },
      MuiTableContainer: {
        styleOverrides: { root: { borderRadius: 12, border: `1px solid ${colors.border}` } },
      },
      MuiTableCell: {
        styleOverrides: {
          head: {
            fontWeight: 700,
            fontSize: '0.75rem',
            color: isDark ? '#BDCCD4' : '#506574',
            backgroundColor: colors.tableHead,
            borderBottom: `1px solid ${colors.divider}`,
            whiteSpace: 'nowrap',
          },
          body: { borderColor: colors.divider },
        },
      },
      MuiTableRow: {
        styleOverrides: {
          root: {
            '&:last-child td': { borderBottom: 0 },
            '&:hover': { backgroundColor: colors.hover },
          },
        },
      },
      MuiChip: { styleOverrides: { root: { borderRadius: 8, fontWeight: 650 } } },
      MuiDialog: {
        styleOverrides: {
          paper: {
            borderRadius: 18,
            boxShadow: isDark
              ? '0 24px 70px rgba(0, 0, 0, 0.4)'
              : '0 24px 70px rgba(16, 43, 64, 0.2)',
          },
        },
      },
      MuiAlert: { styleOverrides: { root: { borderRadius: 12 } } },
      MuiTooltip: { styleOverrides: { tooltip: { borderRadius: 8, fontSize: '0.75rem' } } },
    },
  });
}

export const statusColor: Record<string, 'success' | 'warning' | 'error' | 'default' | 'info' | 'secondary'> = {
  ACTIVE: 'success',
  CLOSED: 'info',
  WRITTEN_OFF: 'secondary',
  POSTED: 'success',
  APPROVED: 'info',
  PENDING_APPROVAL: 'warning',
  PENDING: 'warning',
  REJECTED: 'error',
  DRAFT: 'default',
  MATCHED: 'success',
  MISMATCHED: 'error',
  ACCRUED: 'success',
  USED: 'info',
  NOT_VERIFIED: 'default',
  VERIFIED: 'success',
  DUE: 'info',
  OVERDUE: 'error',
  PARTIAL: 'warning',
  PAID: 'success',
};
