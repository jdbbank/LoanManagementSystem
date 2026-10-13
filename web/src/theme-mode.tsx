import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { CssBaseline, ThemeProvider } from '@mui/material';
import type { PaletteMode } from '@mui/material/styles';
import { createAppTheme } from './theme';

const THEME_STORAGE_KEY = 'loanms.theme';

interface ThemeModeValue {
  mode: PaletteMode;
  toggleMode: () => void;
}

const ThemeModeContext = createContext<ThemeModeValue | null>(null);

function getInitialMode(): PaletteMode {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  return saved === 'dark' || saved === 'light' ? saved : 'light';
}

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<PaletteMode>(getInitialMode);
  const theme = useMemo(() => createAppTheme(mode), [mode]);

  const toggleMode = () => {
    setMode((current) => {
      const next = current === 'light' ? 'dark' : 'light';
      localStorage.setItem(THEME_STORAGE_KEY, next);
      return next;
    });
  };

  const value = useMemo(() => ({ mode, toggleMode }), [mode]);

  return (
    <ThemeModeContext.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ThemeModeContext.Provider>
  );
}

export function useThemeMode(): ThemeModeValue {
  const context = useContext(ThemeModeContext);
  if (!context) throw new Error('useThemeMode must be used inside ThemeModeProvider');
  return context;
}
