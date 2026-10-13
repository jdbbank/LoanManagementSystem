import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Grid from '@mui/material/Grid';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, unwrap } from '../api/client';
import { formatLak, type DashboardStats, type FinancialTransaction } from '../api/types';
import StatusChip from '../components/StatusChip';

const useDashboardStats = () =>
  useQuery({
    queryKey: ['dashboard', 'stats'],
    queryFn: () => api.get('/dashboard/stats').then(unwrap<DashboardStats>),
  });

const useRecentActivity = () =>
  useQuery({
    queryKey: ['dashboard', 'recent-activity'],
    queryFn: () => api.get('/dashboard/recent-activity').then(unwrap<FinancialTransaction[]>),
  });

function StatCard({ title, value, hint }: { title: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent>
        <Typography variant="body2" color="text.secondary">
          {title}
        </Typography>
        <Typography variant="h5" sx={{ fontWeight: 700, mt: 0.5 }}>
          {value}
        </Typography>
        {hint && (
          <Typography variant="caption" color="text.secondary">
            {hint}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const { t: translate } = useTranslation();
  const { data, isLoading } = useDashboardStats();
  const { data: recent } = useRecentActivity();

  if (isLoading || !data) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  const statusEntries = Object.entries(data.loansByStatus) as [string, number][];
  const statusTotal = statusEntries.reduce((acc, [, count]) => acc + count, 0);
  const translateStatus = (status: string) =>
    translate(`status.${status}`, { defaultValue: status.replace(/_/g, ' ') });

  return (
    <Stack spacing={3}>
      <Typography variant="h5" sx={{ fontWeight: 700 }}>
        {translate('pages.dashboard')}
      </Typography>
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard title={translate('dashboard.customers')} value={String(data.customers)} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard title={translate('dashboard.loans')} value={String(data.loans)} hint={translate('dashboard.postedTransactions', { count: data.postedTransactions })} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard title={translate('dashboard.totalOutstanding')} value={formatLak(data.totalOutstanding)} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard title={translate('dashboard.customerCredit')} value={formatLak(data.totalCustomerCredit)} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard title={translate('dashboard.pendingPayments')} value={String(data.pendingPaymentRequests)} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard title={translate('dashboard.pendingApprovals')} value={String(data.pendingApprovals)} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard title={translate('dashboard.activeOutstanding')} value={formatLak(data.activeOutstanding)} />
        </Grid>
      </Grid>
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            {translate('dashboard.loansByStatus')}
          </Typography>
          <Stack spacing={2}>
            {statusEntries.map(([status, count]) => {
              const pct = statusTotal === 0 ? 0 : Math.round((count / statusTotal) * 100);
              return (
                <Box key={status}>
                  <Stack direction="row" sx={{ mb: 0.5, justifyContent: 'space-between' }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {translateStatus(status)} ({count})
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {pct}%
                    </Typography>
                  </Stack>
                  <LinearProgress
                    variant="determinate"
                    value={pct}
                    color={status === 'ACTIVE' ? 'primary' : status === 'CLOSED' ? 'success' : 'secondary'}
                    sx={{ height: 8, borderRadius: 4 }}
                  />
                </Box>
              );
            })}
          </Stack>
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            {translate('dashboard.recentTransactions')}
          </Typography>
          <Stack spacing={0}>
            {(recent ?? []).slice(0, 8).map((t) => (
              <Stack
                key={t.id}
                direction="row"
                sx={{ py: 1, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}
              >
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <StatusChip status={t.status} />
                  <Typography variant="body2">
                    <strong>{t.referenceNo}</strong> {translate(`status.${t.transactionType}`, { defaultValue: t.transactionType.replace(/_/g, ' ') })}
                  </Typography>
                </Stack>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Typography variant="body2">{formatLak(t.amount, t.currency)}</Typography>
                  <Link to="/transactions" style={{ fontSize: 12 }}>
                    {translate('dashboard.view')}
                  </Link>
                </Stack>
              </Stack>
            ))}
            {recent && recent.length === 0 && (
              <Typography variant="body2" color="text.secondary">{translate('dashboard.none')}</Typography>
            )}
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
