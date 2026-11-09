import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';

export default function PageHeader({
  title,
  actions,
}: {
  title: string;
  actions?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const pageKeys: Record<string, string> = {
    Dashboard: 'pages.dashboard',
    Customers: 'pages.customers',
    'Loan Products': 'pages.products',
    Loans: 'pages.loans',
    'Payment Requests': 'pages.payments',
    'Financial Transactions': 'pages.transactions',
    Approvals: 'pages.approvals',
    'Settlement Agreements': 'pages.settlements',
    'Customer Credit': 'pages.credits',
    Reconciliation: 'pages.reconciliation',
    Reports: 'pages.reports',
    'Audit Trail': 'pages.audit',
    Users: 'pages.users',
    Profile: 'pages.profile',
    'System Configuration': 'pages.admin',
    'User Manual': 'pages.manual',
  };
  const translatedTitle = pageKeys[title]
    ? t(pageKeys[title])
    : title.startsWith('Loan ')
      ? t('pages.loanDetail', { number: title.slice('Loan '.length) })
      : title;

  return (
    <Stack
      direction="row"
      sx={{
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 1.5,
        mb: 0.5,
      }}
    >
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
        <Box sx={{ width: 4, height: 34, borderRadius: 4, bgcolor: 'secondary.main' }} />
        <Box>
          <Typography variant="overline" sx={{ color: 'text.secondary', fontSize: 10, lineHeight: 1.2 }}>
            {t('navigation.operations')}
          </Typography>
          <Typography variant="h5" sx={{ fontWeight: 750, lineHeight: 1.2 }}>
            {translatedTitle}
          </Typography>
        </Box>
      </Stack>
      {actions}
    </Stack>
  );
}
