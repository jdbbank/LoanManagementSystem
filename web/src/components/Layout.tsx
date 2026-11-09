import AccountBalanceIcon from '@mui/icons-material/AccountBalance';
import ApprovalIcon from '@mui/icons-material/Approval';
import AssessmentsIcon from '@mui/icons-material/Assessment';
import BadgeIcon from '@mui/icons-material/Badge';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import DescriptionIcon from '@mui/icons-material/Description';
import GroupIcon from '@mui/icons-material/Group';
import HandymanIcon from '@mui/icons-material/Handyman';
import HelpIcon from '@mui/icons-material/Help';
import LightModeIcon from '@mui/icons-material/LightMode';
import LogoutIcon from '@mui/icons-material/Logout';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import MenuIcon from '@mui/icons-material/Menu';
import PeopleIcon from '@mui/icons-material/People';
import PaymentsIcon from '@mui/icons-material/Payments';
import PersonIcon from '@mui/icons-material/Person';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import SearchIcon from '@mui/icons-material/Search';
import ReconcileIcon from '@mui/icons-material/SyncAlt';
import SavingsIcon from '@mui/icons-material/Savings';
import SettingsIcon from '@mui/icons-material/Settings';
import SummarizeIcon from '@mui/icons-material/Summarize';
import AppBar from '@mui/material/AppBar';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import FormControl from '@mui/material/FormControl';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import i18n from '../i18n';
import { UserRole } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { canApprove, canCreate, canSeeReports, isAdmin } from '../auth/roles';
import HomeScreenBanner from './HomeScreenBanner';
import QuickOpen from './QuickOpen';
import { NAV_RAIL, motion, transition } from '../theme';
import { useThemeMode } from '../theme-mode';
import { useHotkey } from '../utils/hotkeys';

const DRAWER_WIDTH = 248;
const RAIL_WIDTH = 76;
const RAIL_STORAGE_KEY = 'loanms.nav';
const QUICK_SEARCH_COMBO = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) ? '\u2318K' : 'Ctrl+K';

type NavSection = 'groupLending' | 'groupCashFlow' | 'groupOversight' | 'groupAdministration' | 'groupHelp';

interface NavItem {
  to: string;
  labelKey: string;
  icon: ReactNode;
  section: NavSection;
  visible: (role: UserRole) => boolean;
}

/** Order here is the order the rail renders, and a section with no permitted item disappears. */
const NAV_SECTIONS: NavSection[] = ['groupLending', 'groupCashFlow', 'groupOversight', 'groupAdministration', 'groupHelp'];

const NAV_ITEMS: NavItem[] = [
  { to: '/', labelKey: 'navigation.dashboard', icon: <AssessmentsIcon />, section: 'groupLending', visible: () => true },
  { to: '/customers', labelKey: 'navigation.customers', icon: <GroupIcon />, section: 'groupLending', visible: () => true },
  { to: '/products', labelKey: 'navigation.products', icon: <MenuBookIcon />, section: 'groupLending', visible: () => true },
  { to: '/loans', labelKey: 'navigation.loans', icon: <AccountBalanceIcon />, section: 'groupLending', visible: () => true },
  {
    to: '/restructures',
    labelKey: 'navigation.restructures',
    icon: <HandymanIcon />,
    section: 'groupLending',
    visible: (r) => canCreate(r) || canApprove(r),
  },
  {
    to: '/payment-requests',
    labelKey: 'navigation.payments',
    icon: <PaymentsIcon />,
    section: 'groupCashFlow',
    visible: (r) => canCreate(r) || canApprove(r),
  },
  { to: '/transactions', labelKey: 'navigation.transactions', icon: <ReceiptLongIcon />, section: 'groupCashFlow', visible: () => true },
  {
    to: '/settlements',
    labelKey: 'navigation.settlements',
    icon: <DescriptionIcon />,
    section: 'groupCashFlow',
    visible: (r) => canCreate(r) || canApprove(r),
  },
  { to: '/credits', labelKey: 'navigation.credits', icon: <SavingsIcon />, section: 'groupCashFlow', visible: () => true },
  {
    to: '/approvals',
    labelKey: 'navigation.approvals',
    icon: <ApprovalIcon />,
    section: 'groupOversight',
    visible: (r) => canApprove(r),
  },
  {
    to: '/reconciliation',
    labelKey: 'navigation.reconciliation',
    icon: <ReconcileIcon />,
    section: 'groupOversight',
    visible: (r) => isAdmin(r) || canApprove(r),
  },
  {
    to: '/reports',
    labelKey: 'navigation.reports',
    icon: <SummarizeIcon />,
    section: 'groupOversight',
    visible: (r) => canSeeReports(r),
  },
  { to: '/audit', labelKey: 'navigation.audit', icon: <BadgeIcon />, section: 'groupOversight', visible: () => true },
  { to: '/users', labelKey: 'navigation.users', icon: <PeopleIcon />, section: 'groupAdministration', visible: (r) => isAdmin(r) },
  { to: '/admin', labelKey: 'navigation.admin', icon: <SettingsIcon />, section: 'groupAdministration', visible: (r) => isAdmin(r) },
  { to: '/manual', labelKey: 'navigation.manual', icon: <HelpIcon />, section: 'groupHelp', visible: () => true },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const { t } = useTranslation();
  const { mode, toggleMode } = useThemeMode();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountAnchor, setAccountAnchor] = useState<HTMLElement | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(() => localStorage.getItem(RAIL_STORAGE_KEY) === 'rail');
  const [quickOpen, setQuickOpen] = useState(false);

  const rail = NAV_RAIL[mode];
  const railWidth = railCollapsed ? RAIL_WIDTH : DRAWER_WIDTH;

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const toggleRail = () => {
    setRailCollapsed((current) => {
      const next = !current;
      localStorage.setItem(RAIL_STORAGE_KEY, next ? 'rail' : 'full');
      return next;
    });
  };

  useHotkey('[', toggleRail);
  useHotkey('k', () => setQuickOpen(true), { requireCombo: true });

  const visibleItems = NAV_ITEMS.filter((item) => (user ? item.visible(user.role) : false));
  const sections = NAV_SECTIONS.map((key) => ({ key, items: visibleItems.filter((item) => item.section === key) })).filter(
    (section) => section.items.length > 0
  );

  const renderNav = (collapsed: boolean) => (
    <Box component="nav" aria-label={t('navigation.menuLabel')} sx={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <Toolbar
        sx={{
          px: collapsed ? 1 : 2.5,
          minHeight: { xs: '76px !important', md: '64px !important' },
          gap: 1.5,
          justifyContent: collapsed ? 'center' : 'flex-start',
        }}
      >
        <Box
          sx={{
            width: 40,
            height: 40,
            flexShrink: 0,
            borderRadius: 2.5,
            display: 'grid',
            placeItems: 'center',
            color: '#E9FFFA',
            bgcolor: 'rgba(53, 195, 174, 0.17)',
            border: '1px solid rgba(116, 230, 211, 0.25)',
          }}
        >
          <AccountBalanceIcon />
        </Box>
        {!collapsed && (
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" noWrap sx={{ fontWeight: 800, lineHeight: 1.15, color: '#FFFFFF' }}>
              {t('navigation.appTitle')}
            </Typography>
            <Typography variant="caption" noWrap sx={{ display: 'block', color: 'rgba(231, 242, 246, 0.62)' }}>
              {t('navigation.tagline')}
            </Typography>
          </Box>
        )}
      </Toolbar>
      <Divider sx={{ borderColor: rail.hairline, mx: 2 }} />
      <Box sx={{ flexGrow: 1 }}>
        {sections.map((section) => (
          <Box key={section.key}>
            {collapsed ? (
              <Divider sx={{ borderColor: rail.hairline, mx: 2, my: 1 }} />
            ) : (
              <Typography variant="overline" sx={{ display: 'block', px: 3, pt: 2.5, pb: 1, color: rail.muted, fontSize: 10 }}>
                {t(`navigation.${section.key}`)}
              </Typography>
            )}
            <List sx={{ px: 1.5, pt: 0 }}>
              {section.items.map((item) => {
                const link = (
                  <ListItemButton
                    key={item.to}
                    component={NavLink}
                    to={item.to}
                    end={item.to === '/'}
                    aria-label={collapsed ? t(item.labelKey) : undefined}
                    onClick={() => setMobileOpen(false)}
                    sx={{
                      minHeight: 44,
                      mb: 0.5,
                      px: collapsed ? 0.75 : 1.5,
                      borderRadius: 2.5,
                      justifyContent: collapsed ? 'center' : 'flex-start',
                      color: rail.soft,
                      transition: `${transition('background-color', motion.quick)}, ${transition('color', motion.quick)}, ${transition('padding', motion.quick)}`,
                      '&:hover': { bgcolor: rail.hover, color: '#FFFFFF' },
                      '&.active': {
                        bgcolor: rail.activeBg,
                        color: '#FFFFFF',
                        boxShadow: `inset 3px 0 ${rail.accent}`,
                      },
                      '&.active .MuiListItemIcon-root': { color: rail.accentText },
                      '&.active .MuiListItemText-primary': { fontWeight: 700 },
                      '& .MuiListItemIcon-root': {
                        minWidth: collapsed ? 0 : 38,
                        color: rail.faint,
                        transition: transition('color', motion.quick),
                      },
                    }}
                  >
                    <ListItemIcon>{item.icon}</ListItemIcon>
                    {!collapsed && (
                      <ListItemText primary={t(item.labelKey)} slotProps={{ primary: { sx: { fontSize: 14 } } }} />
                    )}
                  </ListItemButton>
                );
                return collapsed ? (
                  <Tooltip key={item.to} title={t(item.labelKey)} placement="right">
                    {link}
                  </Tooltip>
                ) : (
                  link
                );
              })}
            </List>
          </Box>
        ))}
      </Box>
      {!collapsed && (
        <Box sx={{ mx: 2, mb: 2, p: 1.5, borderRadius: 2.5, bgcolor: rail.panelBg }}>
          <Typography variant="caption" sx={{ display: 'block', color: rail.muted }}>
            {t('navigation.secure')}
          </Typography>
          <Typography variant="body2" sx={{ color: rail.text, fontWeight: 600, mt: 0.25 }}>
            {t('navigation.makerChecker')}
          </Typography>
        </Box>
      )}
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <Box
        component="a"
        href="#main-content"
        sx={{
          position: 'fixed',
          top: 8,
          left: 8,
          zIndex: (theme) => theme.zIndex.drawer + 2,
          px: 2,
          py: 1,
          borderRadius: 2,
          bgcolor: 'primary.main',
          color: 'primary.contrastText',
          fontWeight: 600,
          textDecoration: 'none',
          transform: 'translateY(-200%)',
          transition: transition('transform', motion.quick),
          '&:focus-visible': { transform: 'none' },
        }}
      >
        {t('common.skipToContent')}
      </Box>
      <AppBar
        position="fixed"
        color="inherit"
        sx={{
          zIndex: (theme) => theme.zIndex.drawer + 1,
          width: { md: `calc(100% - ${railWidth}px)` },
          ml: { md: `${railWidth}px` },
          transition: `${transition('width')}, ${transition('margin-left')}`,
        }}
      >
        <Toolbar>
          <IconButton
            edge="start"
            aria-label={t('navigation.openMenu')}
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(true)}
            sx={{ mr: 2, display: { md: 'none' } }}
          >
            <MenuIcon />
          </IconButton>
          <IconButton
            edge="start"
            aria-label={t(railCollapsed ? 'navigation.expand' : 'navigation.collapse')}
            aria-expanded={!railCollapsed}
            onClick={toggleRail}
            sx={{ mr: 2, display: { xs: 'none', md: 'inline-flex' } }}
          >
            {railCollapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
          </IconButton>
          <Box sx={{ flexGrow: 1 }} />
          <Tooltip title={`${t('quickOpen.label')} (${QUICK_SEARCH_COMBO})`}>
            <IconButton
              aria-label={t('quickOpen.label')}
              onClick={() => setQuickOpen(true)}
              sx={{ mr: 1, border: 1, borderColor: 'divider', color: 'text.secondary' }}
            >
              <SearchIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <FormControl size="small" sx={{ minWidth: 102, mr: 1 }}>
            <Select
              value={i18n.resolvedLanguage?.startsWith('lo') ? 'lo' : 'en'}
              onChange={(event) => { void i18n.changeLanguage(event.target.value); }}
              inputProps={{ 'aria-label': t('common.language') }}
              sx={{ height: 36, borderRadius: 2.5, fontSize: 13 }}
            >
              <MenuItem value="en">{t('languageNames.en')}</MenuItem>
              <MenuItem value="lo">{t('languageNames.lo')}</MenuItem>
            </Select>
          </FormControl>
          <Tooltip title={t(mode === 'light' ? 'common.dark' : 'common.light')}>
            <IconButton
              aria-label={t('common.theme')}
              onClick={toggleMode}
              sx={{ mr: 1, border: 1, borderColor: 'divider', color: 'text.secondary' }}
            >
              {mode === 'light' ? <DarkModeIcon fontSize="small" /> : <LightModeIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
          {user && (
            <>
              <Typography
                variant="caption"
                sx={{ color: 'text.secondary', mr: 2, display: { xs: 'none', sm: 'block' } }}
              >
                {t('navigation.loanOperations')}
              </Typography>
              <Box
                role="button"
                tabIndex={0}
                aria-label={t('navigation.profile')}
                aria-expanded={Boolean(accountAnchor)}
                onClick={(event) => setAccountAnchor(event.currentTarget)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') setAccountAnchor(event.currentTarget);
                }}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.25,
                  cursor: 'pointer',
                  borderRadius: 2.5,
                  px: 0.75,
                  py: 0.5,
                  '&:hover': { bgcolor: 'action.hover' },
                }}
              >
                <Avatar
                  sx={{
                    width: 36,
                    height: 36,
                    bgcolor: 'secondary.light',
                    color: 'primary.dark',
                    fontSize: 14,
                    fontWeight: 800,
                  }}
                >
                  {user.fullName.trim().charAt(0).toUpperCase()}
                </Avatar>
                <Box sx={{ textAlign: 'right', display: { xs: 'none', sm: 'block' } }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {user.fullName}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {user.username}
                  </Typography>
                </Box>
                <Chip
                  label={t(`roles.${user.role}`)}
                  color="primary"
                  size="small"
                  sx={{ bgcolor: 'action.selected', border: 0 }}
                />
              </Box>
              <Menu
                anchorEl={accountAnchor}
                open={Boolean(accountAnchor)}
                onClose={() => setAccountAnchor(null)}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                transformOrigin={{ vertical: 'top', horizontal: 'right' }}
              >
                <MenuItem
                  onClick={() => {
                    setAccountAnchor(null);
                    navigate('/profile');
                  }}
                >
                  <ListItemIcon>
                    <PersonIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>{t('navigation.profile')}</ListItemText>
                </MenuItem>
                <Divider />
                <MenuItem
                  onClick={() => {
                    setAccountAnchor(null);
                    handleLogout();
                  }}
                >
                  <ListItemIcon>
                    <LogoutIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>{t('navigation.logout')}</ListItemText>
                </MenuItem>
              </Menu>
            </>
          )}
        </Toolbar>
      </AppBar>
      <Drawer
        variant="temporary"
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        ModalProps={{ keepMounted: true }}
        sx={{
          display: { xs: 'block', md: 'none' },
          '& .MuiDrawer-paper': { boxSizing: 'border-box', width: DRAWER_WIDTH },
        }}
      >
        {renderNav(false)}
      </Drawer>
      <Drawer
        variant="permanent"
        sx={{
          display: { xs: 'none', md: 'block' },
          width: railWidth,
          flexShrink: 0,
          transition: transition('width'),
          '& .MuiDrawer-paper': { boxSizing: 'border-box', width: railWidth },
        }}
      >
        {renderNav(railCollapsed)}
      </Drawer>
      <Box
        id="main-content"
        component="main"
        sx={{
          flexGrow: 1,
          p: { xs: 2, md: 3.5 },
          pt: { xs: 2, md: 3 },
          width: { md: `calc(100% - ${railWidth}px)` },
          minWidth: 0,
          transition: transition('width'),
        }}
      >
        <Toolbar />
        <HomeScreenBanner />
        <Outlet />
      </Box>
      <QuickOpen onClose={() => setQuickOpen(false)} open={quickOpen} />
    </Box>
  );
}
