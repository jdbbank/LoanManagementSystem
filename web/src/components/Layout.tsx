import AccountBalanceIcon from '@mui/icons-material/AccountBalance';
import ApprovalIcon from '@mui/icons-material/Approval';
import AssessmentsIcon from '@mui/icons-material/Assessment';
import BadgeIcon from '@mui/icons-material/Badge';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import DescriptionIcon from '@mui/icons-material/Description';
import GroupIcon from '@mui/icons-material/Group';
import LightModeIcon from '@mui/icons-material/LightMode';
import LogoutIcon from '@mui/icons-material/Logout';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import MenuIcon from '@mui/icons-material/Menu';
import PeopleIcon from '@mui/icons-material/People';
import PaymentsIcon from '@mui/icons-material/Payments';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
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
import { useThemeMode } from '../theme-mode';

const DRAWER_WIDTH = 248;

interface NavItem {
  to: string;
  labelKey: string;
  icon: ReactNode;
  visible: (role: UserRole) => boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', labelKey: 'navigation.dashboard', icon: <AssessmentsIcon />, visible: () => true },
  { to: '/customers', labelKey: 'navigation.customers', icon: <GroupIcon />, visible: () => true },
  { to: '/products', labelKey: 'navigation.products', icon: <MenuBookIcon />, visible: () => true },
  { to: '/loans', labelKey: 'navigation.loans', icon: <AccountBalanceIcon />, visible: () => true },
  {
    to: '/payment-requests',
    labelKey: 'navigation.payments',
    icon: <PaymentsIcon />,
    visible: (r) => canCreate(r) || canApprove(r),
  },
  { to: '/transactions', labelKey: 'navigation.transactions', icon: <ReceiptLongIcon />, visible: () => true },
  { to: '/approvals', labelKey: 'navigation.approvals', icon: <ApprovalIcon />, visible: (r) => canApprove(r) },
  {
    to: '/settlements',
    labelKey: 'navigation.settlements',
    icon: <DescriptionIcon />,
    visible: (r) => canCreate(r) || canApprove(r),
  },
  { to: '/credits', labelKey: 'navigation.credits', icon: <SavingsIcon />, visible: () => true },
  {
    to: '/reconciliation',
    labelKey: 'navigation.reconciliation',
    icon: <ReconcileIcon />,
    visible: (r) => isAdmin(r) || canApprove(r),
  },
  {
    to: '/reports',
    labelKey: 'navigation.reports',
    icon: <SummarizeIcon />,
    visible: (r) => canSeeReports(r),
  },
  { to: '/audit', labelKey: 'navigation.audit', icon: <BadgeIcon />, visible: () => true },
  { to: '/users', labelKey: 'navigation.users', icon: <PeopleIcon />, visible: (r) => isAdmin(r) },
  { to: '/admin', labelKey: 'navigation.admin', icon: <SettingsIcon />, visible: (r) => isAdmin(r) },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const { t } = useTranslation();
  const { mode, toggleMode } = useThemeMode();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const drawer = (
    <Box sx={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <Toolbar sx={{ px: 2.5, minHeight: '76px !important', gap: 1.5 }}>
        <Box
          sx={{
            width: 40,
            height: 40,
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
        <Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 800, lineHeight: 1.15, color: '#FFFFFF' }}>
            {t('navigation.appTitle')}
          </Typography>
          <Typography variant="caption" sx={{ color: 'rgba(231, 242, 246, 0.62)' }}>
            {t('navigation.tagline')}
          </Typography>
        </Box>
      </Toolbar>
      <Divider sx={{ borderColor: 'rgba(231, 242, 246, 0.12)', mx: 2 }} />
      <Typography
        variant="overline"
        sx={{ px: 3, pt: 2.5, pb: 1, color: 'rgba(231, 242, 246, 0.48)', fontSize: 10 }}
      >
        {t('navigation.workspace')}
      </Typography>
      <List sx={{ px: 1.5, pt: 0, flexGrow: 1 }}>
        {NAV_ITEMS.filter((item) => (user ? item.visible(user.role) : false)).map((item) => (
          <ListItemButton
            key={item.to}
            component={NavLink}
            to={item.to}
            end={item.to === '/'}
            onClick={() => setMobileOpen(false)}
            sx={{
              minHeight: 44,
              mb: 0.5,
              px: 1.5,
              borderRadius: 2.5,
              color: 'rgba(231, 242, 246, 0.76)',
              transition: 'background-color 140ms ease, color 140ms ease',
              '&:hover': {
                bgcolor: 'rgba(255, 255, 255, 0.075)',
                color: '#FFFFFF',
              },
              '&.active': {
                bgcolor: 'rgba(53, 195, 174, 0.16)',
                color: '#FFFFFF',
                boxShadow: 'inset 3px 0 #35C3AE',
              },
              '&.active .MuiListItemIcon-root': { color: '#71E0CB' },
              '& .MuiListItemIcon-root': {
                minWidth: 38,
                color: 'rgba(231, 242, 246, 0.58)',
                transition: 'color 140ms ease',
              },
            }}
          >
            <ListItemIcon>{item.icon}</ListItemIcon>
            <ListItemText primary={t(item.labelKey)} slotProps={{ primary: { sx: { fontSize: 14 } } }} />
          </ListItemButton>
        ))}
      </List>
      <Box sx={{ mx: 2, mb: 2, p: 1.5, borderRadius: 2.5, bgcolor: 'rgba(255, 255, 255, 0.055)' }}>
        <Typography variant="caption" sx={{ display: 'block', color: 'rgba(231, 242, 246, 0.52)' }}>
          {t('navigation.secure')}
        </Typography>
        <Typography variant="body2" sx={{ color: '#E7F2F6', fontWeight: 600, mt: 0.25 }}>
          {t('navigation.makerChecker')}
        </Typography>
      </Box>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <AppBar
        position="fixed"
        color="inherit"
        sx={{ zIndex: (t) => t.zIndex.drawer + 1 }}
      >
        <Toolbar>
          <IconButton
            edge="start"
            onClick={() => setMobileOpen(true)}
            sx={{ mr: 2, display: { md: 'none' } }}
          >
            <MenuIcon />
          </IconButton>
          <Box sx={{ flexGrow: 1 }} />
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
              <Avatar
                sx={{
                  width: 36,
                  height: 36,
                  mr: 1.25,
                  bgcolor: 'secondary.light',
                  color: 'primary.dark',
                  fontSize: 14,
                  fontWeight: 800,
                }}
              >
                {user.fullName.trim().charAt(0).toUpperCase()}
              </Avatar>
              <Box sx={{ textAlign: 'right', mr: 1.5 }}>
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
              <Tooltip title={t('navigation.logout')}>
                <IconButton onClick={handleLogout} sx={{ ml: 1 }}>
                  <LogoutIcon />
                </IconButton>
              </Tooltip>
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
        {drawer}
      </Drawer>
      <Drawer
        variant="permanent"
        sx={{
          display: { xs: 'none', md: 'block' },
          width: DRAWER_WIDTH,
          flexShrink: 0,
          '& .MuiDrawer-paper': { boxSizing: 'border-box', width: DRAWER_WIDTH },
        }}
      >
        {drawer}
      </Drawer>
      <Box
        component="main"
        sx={{
          flexGrow: 1,
          p: { xs: 2, md: 3.5 },
          pt: { xs: 2, md: 3 },
          width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
          minWidth: 0,
        }}
      >
        <Toolbar />
        <Outlet />
      </Box>
    </Box>
  );
}
