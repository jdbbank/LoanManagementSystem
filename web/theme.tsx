import { createTheme, type PaletteMode, type Theme } from '@mui/material/styles';

/**
 * POS System Theme - Professional Blue Design
 * 
 * Design Philosophy:
 * - Clarity First: ข้อมูลต้องอ่านง่าย ชัดเจน
 * - Reduced Eye Strain: สีไม่ฉูดฉาด Contrast เหมาะสม
 * - Information Density: แสดงข้อมูลได้มากขึ้นแต่ไม่รกตา
 * - Speed & Efficiency: Animation เร็วขึ้น ลดการเคลื่อนไหวที่ไม่จำเป็น
 * - WCAG 2.1 AA Compliant: Contrast ratio ตามมาตรฐาน
 */

export const createPOSTheme = (mode: PaletteMode) => {
    const isDark = mode === 'dark';

    return createTheme({
        palette: {
            mode,

            // Primary: calm, high-contrast blue for actions and navigation.
            primary: {
                main: isDark ? '#336db3' : '#2459a6',
                light: isDark ? '#7ba7df' : '#4779c4',
                dark: isDark ? '#28558c' : '#183f7a',
                contrastText: '#ffffff',
            },

            // Secondary: Neutral (ใช้ Gray แทน Pink)
            secondary: {
                main: isDark ? '#65c9c0' : '#16847c',
                light: isDark ? '#90ddd5' : '#43a69d',
                dark: isDark ? '#309d94' : '#11655f',
                contrastText: '#ffffff',
            },

            // Success: สีเขียวสำหรับการขาย, กำไร
            success: {
                main: isDark ? '#66bb6a' : '#2e7d32',      // Green 400 / 800
                light: isDark ? '#81c784' : '#4caf50',     // Green 300 / 500
                dark: isDark ? '#388e3c' : '#1b5e20',      // Green 700 / 900
                contrastText: '#ffffff',
            },

            // Warning: สีส้มสำหรับสต็อกต่ำ
            warning: {
                main: isDark ? '#ffa726' : '#ed6c02',      // Orange 400 / 700
                light: isDark ? '#ffb74d' : '#ff9800',     // Orange 300 / 500
                dark: isDark ? '#f57c00' : '#e65100',      // Orange 700 / 900
                contrastText: isDark ? '#000000' : '#ffffff',
            },

            // Error: สีแดงสำหรับสต็อกหมด, ข้อผิดพลาด
            error: {
                main: isDark ? '#f44336' : '#d32f2f',      // Red 500 / 700
                light: isDark ? '#e57373' : '#ef5350',     // Red 300 / 400
                dark: isDark ? '#d32f2f' : '#c62828',      // Red 700 / 800
                contrastText: '#ffffff',
            },

            // Info: ข้อมูลทั่วไป
            info: {
                main: isDark ? '#29b6f6' : '#0288d1',      // Light Blue 400 / 700
                light: isDark ? '#4fc3f7' : '#03a9f4',     // Light Blue 300 / 500
                dark: isDark ? '#0277bd' : '#01579b',      // Light Blue 800 / 900
                contrastText: '#ffffff',
            },

            // Background
            background: {
                default: isDark ? '#101923' : '#f4f6f8',
                paper: isDark ? '#182431' : '#ffffff',
            },

            // Divider
            divider: isDark
                ? 'rgba(226, 235, 244, 0.12)'
                : '#e4e9ef',

            // Text
            text: {
                primary: isDark
                    ? '#edf2f7'
                    : '#1d2939',
                secondary: isDark
                    ? '#aebdcb'
                    : '#667085',
                disabled: isDark
                    ? 'rgba(255, 255, 255, 0.5)'
                    : 'rgba(0, 0, 0, 0.38)',
            },
        },

        typography: {
            fontFamily: '"Inter", "Noto Sans Lao",-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif',

            // Headings
            h1: {
                fontWeight: 700,
                fontSize: '2rem',
                letterSpacing: '-0.02em',
                lineHeight: 1.2,
            },
            h2: {
                fontWeight: 700,
                fontSize: '1.625rem',
                letterSpacing: '-0.015em',
                lineHeight: 1.3,
            },
            h3: {
                fontWeight: 600,
                fontSize: '1.375rem',
                letterSpacing: '-0.01em',
                lineHeight: 1.4,
            },
            h4: {
                fontWeight: 600,
                fontSize: '1.125rem',
                letterSpacing: 0,
                lineHeight: 1.4,
            },
            h5: {
                fontWeight: 600,
                fontSize: '1.125rem',      // 18px
                letterSpacing: 0,
                lineHeight: 1.5,
            },
            h6: {
                fontWeight: 600,
                fontSize: '1rem',
                letterSpacing: 0,
                lineHeight: 1.5,
            },

            // Subtitles
            subtitle1: {
                fontWeight: 500,
                fontSize: '1rem',
                lineHeight: 1.5,
                letterSpacing: '0.00938em',
            },
            subtitle2: {
                fontWeight: 500,
                fontSize: '0.875rem',
                lineHeight: 1.57,
                letterSpacing: '0.00714em',
            },

            // Body
            body1: {
                fontSize: '1rem',          // 16px
                lineHeight: 1.5,
                fontWeight: 400,
                letterSpacing: '0.00938em',
            },
            body2: {
                fontSize: '0.875rem',      // 14px
                lineHeight: 1.57,
                fontWeight: 400,
                letterSpacing: '0.01071em',
            },

            // Button
            button: {
                fontWeight: 600,
                letterSpacing: '0.02em',
                textTransform: 'none',
                fontSize: '0.875rem',
            },

            // Caption & Overline
            caption: {
                fontSize: '0.75rem',
                lineHeight: 1.66,
                fontWeight: 400,
                letterSpacing: '0.03333em',
            },
            overline: {
                fontSize: '0.75rem',
                fontWeight: 600,
                letterSpacing: '0.08333em',
                textTransform: 'uppercase',
                lineHeight: 2.66,
            },
        },

        shape: {
            borderRadius: 10,
        },

        shadows: [
            'none',
            // Elevation 1
            isDark
                ? '0 1px 3px rgba(0, 0, 0, 0.4), 0 1px 2px rgba(0, 0, 0, 0.24)'
                : '0 1px 3px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.08)',
            // Elevation 2
            isDark
                ? '0 2px 4px rgba(0, 0, 0, 0.4), 0 1px 3px rgba(0, 0, 0, 0.24)'
                : '0 2px 4px rgba(0, 0, 0, 0.14), 0 1px 3px rgba(0, 0, 0, 0.12)',
            // Elevation 3
            isDark
                ? '0 3px 6px rgba(0, 0, 0, 0.4), 0 2px 4px rgba(0, 0, 0, 0.24)'
                : '0 3px 6px rgba(0, 0, 0, 0.16), 0 2px 4px rgba(0, 0, 0, 0.12)',
            // Elevation 4
            isDark
                ? '0 4px 8px rgba(0, 0, 0, 0.4), 0 2px 4px rgba(0, 0, 0, 0.24)'
                : '0 4px 8px rgba(0, 0, 0, 0.16), 0 2px 4px rgba(0, 0, 0, 0.12)',
            // Rest of elevations (5-24)
            ...Array(20).fill(
                isDark
                    ? '0 8px 16px rgba(0, 0, 0, 0.4), 0 4px 8px rgba(0, 0, 0, 0.24)'
                    : '0 8px 16px rgba(0, 0, 0, 0.16), 0 4px 8px rgba(0, 0, 0, 0.12)'
            ),
        ] as Theme['shadows'],

        transitions: {
            duration: {
                shortest: 150,
                shorter: 200,
                short: 200,        // ลดลงจาก 250
                standard: 250,     // ลดลงจาก 300
                complex: 300,      // ลดลงจาก 375
                enteringScreen: 225,
                leavingScreen: 195,
            },
            easing: {
                easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
                easeOut: 'cubic-bezier(0.0, 0, 0.2, 1)',
                easeIn: 'cubic-bezier(0.4, 0, 1, 1)',
                sharp: 'cubic-bezier(0.4, 0, 0.6, 1)',
            },
        },

        components: {
            // Button
            MuiButton: {
                defaultProps: {
                    disableElevation: false,
                },
                styleOverrides: {
                    root: {
                        borderRadius: 9,
                        textTransform: 'none',
                        fontWeight: 600,
                        padding: '9px 18px',
                        fontSize: '0.875rem',
                        minHeight: 40,
                        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                        '&:focus-visible': {
                            outline: `2px solid ${isDark ? '#2196f3' : '#1976d2'}`,
                            outlineOffset: 2,
                        },
                    },
                    contained: {
                        boxShadow: 'none',
                        '&:hover': { boxShadow: 'none' },
                    },
                    outlined: {
                        borderWidth: '1.5px',
                        '&:hover': {
                            borderWidth: '1.5px',
                        },
                    },
                    sizeSmall: {
                        padding: '6px 16px',
                        fontSize: '0.8125rem',
                        minHeight: 32,
                    },
                    sizeLarge: {
                        padding: '12px 28px',
                        fontSize: '0.9375rem',
                        minHeight: 48,
                    },
                },
            },

            // Paper
            MuiPaper: {
                styleOverrides: {
                    root: {
                        backgroundImage: 'none',
                        border: `1px solid ${isDark ? '#2a3948' : '#e4e9ef'}`,
                    },
                },
            },

            // Card
            MuiCard: {
                styleOverrides: {
                    root: {
                        borderRadius: 12,
                        border: `1px solid ${isDark ? '#2a3948' : '#e4e9ef'}`,
                        boxShadow: isDark
                            ? '0 1px 2px rgba(0, 0, 0, 0.18)'
                            : '0 1px 2px rgba(16, 24, 40, 0.04)',
                    },
                },
            },

            // TextField
            MuiTextField: {
                defaultProps: {
                    variant: 'outlined',
                },
                styleOverrides: {
                    root: {
                        '& .MuiOutlinedInput-root': {
                            borderRadius: 9,
                            '& fieldset': {
                                borderColor: isDark
                                    ? 'rgba(255, 255, 255, 0.23)'
                                    : 'rgba(0, 0, 0, 0.23)',
                                transition: 'border-color 0.2s',
                            },
                            '&:hover fieldset': {
                                borderColor: isDark
                                    ? 'rgba(33, 150, 243, 0.5)'
                                    : 'rgba(25, 118, 210, 0.5)',
                            },
                            '&.Mui-focused fieldset': { borderWidth: '1.5px' },
                            '&.Mui-focused': {
                                '& fieldset': {
                                    borderColor: isDark ? '#2196f3' : '#1976d2',
                                },
                            },
                        },
                        '& .MuiInputBase-input': {
                            height: 'auto',
                        },
                    },
                },
            },

            // Table
            MuiTableContainer: {
                styleOverrides: {
                    root: {
                        overflowX: 'auto',
                    },
                },
            },
            MuiTableRow: {
                styleOverrides: {
                    root: {
                        transition: 'background-color 0.15s',
                        '&:hover': {
                            backgroundColor: isDark
                                    ? 'rgba(123, 167, 223, 0.08)'
                                : 'rgba(36, 89, 166, 0.035)',
                        },
                    },
                    head: {
                        backgroundColor: isDark ? '#202e3b' : '#f7f9fb',
                    },
                },
            },
            MuiTableCell: {
                styleOverrides: {
                    root: {
                        padding: '11px 16px',
                        borderColor: isDark
                            ? '#2a3948'
                            : '#edf0f3',
                    },
                    head: {
                        fontWeight: 600,
                        fontSize: '0.75rem',
                        letterSpacing: '0.025em',
                        color: isDark
                            ? '#c7d2df'
                            : '#475467',
                        whiteSpace: 'nowrap',
                    },
                    sizeSmall: {
                        padding: '8px 12px',
                    },
                },
            },

            // IconButton
            MuiIconButton: {
                styleOverrides: {
                    root: {
                        transition: 'all 0.2s',
                        '&:hover': {
                            backgroundColor: isDark
                                ? 'rgba(33, 150, 243, 0.12)'
                                : 'rgba(25, 118, 210, 0.08)',
                        },
                        '&:focus-visible': {
                            outline: `2px solid ${isDark ? '#2196f3' : '#1976d2'}`,
                            outlineOffset: 2,
                        },
                    },
                },
            },

            // Chip
            MuiChip: {
                styleOverrides: {
                    root: {
                        borderRadius: 6,
                        fontWeight: 500,
                        height: 28,
                    },
                    sizeSmall: {
                        height: 24,
                        fontSize: '0.75rem',
                    },
                },
            },
            MuiTablePagination: {
                styleOverrides: {
                    toolbar: {
                        minHeight: 52,
                        paddingLeft: 16,
                        paddingRight: 8,
                    },
                    selectLabel: {
                        fontSize: '0.8125rem',
                    },
                    displayedRows: {
                        fontSize: '0.8125rem',
                    },
                },
            },

            // Dialog
            MuiDialog: {
                defaultProps: {
                    fullWidth: true,
                    maxWidth: 'sm',
                },
                styleOverrides: {
                    paper: {
                        borderRadius: 14,
                        border: `1px solid ${isDark ? '#2a3948' : '#e4e9ef'}`,
                        boxShadow: isDark
                            ? '0 20px 48px rgba(0, 0, 0, 0.35)'
                            : '0 20px 48px rgba(16, 24, 40, 0.16)',
                        margin: 16,
                    },
                },
            },
            MuiDialogTitle: {
                styleOverrides: {
                    root: {
                        padding: '22px 24px 12px',
                        fontWeight: 650,
                    },
                },
            },
            MuiDialogContent: {
                styleOverrides: {
                    root: { padding: '12px 24px 20px' },
                },
            },
            MuiDialogActions: {
                styleOverrides: {
                    root: {
                        padding: '12px 24px 20px',
                        gap: 8,
                    },
                },
            },

            // AppBar
            MuiAppBar: {
                styleOverrides: {
                    root: {
                        backgroundImage: 'none',
                        backgroundColor: isDark ? '#182431' : '#ffffff',
                        color: isDark
                            ? '#edf2f7'
                            : '#1d2939',
                        borderBottom: isDark
                            ? '1px solid #2a3948'
                            : '1px solid #e4e9ef',
                        boxShadow: 'none',
                    },
                },
            },

            // Drawer
            MuiDrawer: {
                styleOverrides: {
                    paper: {
                        borderRight: `1px solid ${isDark ? '#2a3948' : '#e4e9ef'}`,
                        backgroundImage: 'none',
                    },
                },
            },
            MuiTooltip: {
                styleOverrides: {
                    tooltip: {
                        borderRadius: 7,
                        fontSize: '0.75rem',
                        padding: '6px 10px',
                    },
                },
            },
            MuiAlert: {
                styleOverrides: {
                    root: {
                        borderRadius: 10,
                        alignItems: 'center',
                    },
                    message: {
                        minWidth: 0,
                    },
                },
            },
        },
    });
};
