import Alert from '@mui/material/Alert';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Grid from '@mui/material/Grid';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, unwrap } from '../api/client';
import { formatLak, type MonthlyReport, type ReportGrowth } from '../api/types';
import PageHeader from '../components/PageHeader';

const MONTH_WINDOWS = [6, 12, 24];
const DEFAULT_MONTH_WINDOW = 12;

export default function ReportsPage() {
  const { t } = useTranslation();
  const [months, setMonths] = useState(DEFAULT_MONTH_WINDOW);
  const reportQuery = useQuery({
    queryKey: ['reports', 'monthly', months],
    queryFn: () =>
      api.get('/reports/monthly', { params: { months } }).then(unwrap<MonthlyReport>),
  });

  const report = reportQuery.data;
  const currency = report?.currency;
  const growth = (value: ReportGrowth): string =>
    value.percent === null ? t('reports.noGrowth') : `${value.percent > 0 ? '+' : ''}${value.percent.toFixed(2)}%`;

  const summary = report
    ? [
        { label: t('reports.openingOutstanding'), value: formatLak(report.openingOutstanding, currency) },
        { label: t('reports.closingOutstanding'), value: formatLak(report.closingOutstanding, currency) },
        { label: t('reports.disbursed'), value: formatLak(report.totals.disbursed, currency) },
        { label: t('reports.collected'), value: formatLak(report.totals.collected, currency) },
        { label: t('reports.interestPaid'), value: formatLak(report.totals.interestPaid, currency) },
        { label: t('reports.penaltyPaid'), value: formatLak(report.totals.penaltyPaid, currency) },
      ]
    : [];

  return (
    <Stack spacing={2}>
      <PageHeader
        title="Reports"
        actions={
          <Select
            size="small"
            value={months}
            onChange={(event) => setMonths(Number(event.target.value))}
            inputProps={{ 'aria-label': t('reports.window') }}
          >
            {MONTH_WINDOWS.map((option) => (
              <MenuItem key={option} value={option}>
                {t('reports.monthsOption', { months: option })}
              </MenuItem>
            ))}
          </Select>
        }
      />
      <Alert severity="info">{t('reports.info')}</Alert>
      {reportQuery.isError && <Alert severity="error">{(reportQuery.error as Error).message}</Alert>}
      {report && (
        <Card>
          <CardContent>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              {t('reports.windowRange', { from: report.from, to: report.to })}
            </Typography>
            <Grid container spacing={2} sx={{ mt: 0.5 }}>
              {summary.map((item) => (
                <Grid key={item.label} size={{ xs: 6, sm: 4, md: 2 }}>
                  <Typography variant="body2" color="text.secondary">
                    {item.label}
                  </Typography>
                  <Typography variant="h6" sx={{ fontWeight: 700 }}>
                    {item.value}
                  </Typography>
                </Grid>
              ))}
            </Grid>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
              {t('reports.outstandingCheck', {
                ledger: formatLak(report.closingOutstanding, currency),
                loanBook: formatLak(report.loanBookOutstanding, currency),
                loansOpened: report.totals.loansOpened,
              })}
            </Typography>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardContent>
          {reportQuery.isLoading ? (
            <Stack sx={{ alignItems: 'center', py: 4 }}><CircularProgress /></Stack>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('reports.month')}</TableCell>
                  <TableCell align="right">{t('reports.disbursed')}</TableCell>
                  <TableCell align="right">{t('reports.collected')}</TableCell>
                  <TableCell align="right">{t('reports.interestPaid')}</TableCell>
                  <TableCell align="right">{t('reports.penaltyPaid')}</TableCell>
                  <TableCell align="right">{t('reports.closingOutstanding')}</TableCell>
                  <TableCell align="right">{t('reports.transactions')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(report?.rows ?? []).map((row) => (
                  <TableRow key={row.month} hover>
                    <TableCell>{row.month}</TableCell>
                    <TableCell align="right">
                      {formatLak(row.disbursed, currency)}
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {t('reports.growth', { mom: growth(row.mom.disbursed), yoy: growth(row.yoy.disbursed) })}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      {formatLak(row.collected, currency)}
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {t('reports.growth', { mom: growth(row.mom.collected), yoy: growth(row.yoy.collected) })}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">{formatLak(row.interestPaid, currency)}</TableCell>
                    <TableCell align="right">{formatLak(row.penaltyPaid, currency)}</TableCell>
                    <TableCell align="right">
                      {formatLak(row.closingOutstanding, currency)}
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {t('reports.growth', {
                          mom: growth(row.mom.outstanding),
                          yoy: growth(row.yoy.outstanding),
                        })}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">{row.transactions}</TableCell>
                  </TableRow>
                ))}
                {report?.rows.length === 0 && (
                  <TableRow><TableCell colSpan={7} align="center">{t('reports.noData')}</TableCell></TableRow>
                )}
                {report && report.rows.length > 0 && (
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>{t('reports.totals')}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{formatLak(report.totals.disbursed, currency)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{formatLak(report.totals.collected, currency)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{formatLak(report.totals.interestPaid, currency)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{formatLak(report.totals.penaltyPaid, currency)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{formatLak(report.closingOutstanding, currency)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>
                      {report.rows.reduce((sum, row) => sum + row.transactions, 0)}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </Stack>
  );
}
