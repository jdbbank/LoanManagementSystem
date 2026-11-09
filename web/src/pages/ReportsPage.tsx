import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
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
import EmptyState from '../components/EmptyState';
import PageHeader from '../components/PageHeader';
import ShareDonut, { type DonutSlice } from '../components/ShareDonut';
import StatCard from '../components/StatCard';
import TableSkeleton from '../components/TableSkeleton';
import TrendChart, { type TrendSeries } from '../components/TrendChart';
import { riseIn } from '../theme';
import { downloadCsv, toCsv } from '../utils/csv';
import { compactAmount } from '../utils/format';

const MONTH_WINDOWS = [6, 12, 24];
const DEFAULT_MONTH_WINDOW = 12;

type SummaryTile = { label: string; value: string; delta?: { percent: number | null }; positiveIsGood?: boolean };
type MoneyField = 'principalPaid' | 'interestPaid' | 'penaltyPaid';

export default function ReportsPage() {
  const { t } = useTranslation();
  const [months, setMonths] = useState(DEFAULT_MONTH_WINDOW);
  const [focusMonth, setFocusMonth] = useState<string | null>(null);
  const reportQuery = useQuery({
    queryKey: ['reports', 'monthly', months],
    queryFn: () =>
      api.get('/reports/monthly', { params: { months } }).then(unwrap<MonthlyReport>),
  });

  const report = reportQuery.data;
  const currency = report?.currency;
  const rows = report?.rows ?? [];
  const categories = rows.map((row) => row.month);
  /** Focus is a month key, not an index, so it survives a window change without pointing at the wrong bar. */
  const focusedAt = focusMonth === null ? -1 : categories.indexOf(focusMonth);
  const chartIndex = focusedAt < 0 ? null : focusedAt;
  const selectMonth = (index: number | null) => setFocusMonth(index === null ? null : (categories[index] ?? null));
  const visibleRows = focusMonth === null ? rows : rows.filter((row) => row.month === focusMonth);

  /** The newest month carries the movement shown on the tiles; the table repeats it per row. */
  const latest = report?.rows.at(-1);
  const growth = (value: ReportGrowth): string =>
    value.percent === null ? t('reports.noGrowth') : `${value.percent > 0 ? '+' : ''}${value.percent.toFixed(2)}%`;

  const trendSeries: TrendSeries[] = [
    { id: 'disbursed', label: t('reports.disbursed'), color: 'primary', points: rows.map((row) => row.disbursed) },
    { id: 'collected', label: t('reports.collected'), color: 'warning', points: rows.map((row) => row.collected), dash: '6 4' },
  ];
  const outstandingSeries: TrendSeries[] = [
    { id: 'outstanding', label: t('reports.closingOutstanding'), color: 'secondary', points: rows.map((row) => row.closingOutstanding) },
  ];
  const componentTotal = (field: MoneyField): number =>
    rows.reduce((sum, row) => sum + row[field], 0);
  const mixSlices: DonutSlice[] = [
    { id: 'principal', label: t('reports.principalPaid'), color: 'primary', value: componentTotal('principalPaid') },
    { id: 'interest', label: t('reports.interestPaid'), color: 'secondary', value: componentTotal('interestPaid') },
    { id: 'penalty', label: t('reports.penaltyPaid'), color: 'warning', value: componentTotal('penaltyPaid') },
  ];
  const mixTotal = mixSlices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);

  const exportCsv = () => {
    const headers = [
      t('reports.month'),
      t('reports.disbursed'),
      t('reports.collected'),
      t('reports.principalPaid'),
      t('reports.interestPaid'),
      t('reports.penaltyPaid'),
      t('reports.closingOutstanding'),
      t('reports.transactions'),
    ];
    const body = visibleRows.map((row) => [
      row.month,
      row.disbursed,
      row.collected,
      row.principalPaid,
      row.interestPaid,
      row.penaltyPaid,
      row.closingOutstanding,
      row.transactions,
    ]);
    downloadCsv(`monthly-report-${report?.from ?? 'export'}-${report?.to ?? ''}.csv`, toCsv(headers, body));
  };

  const summary: SummaryTile[] = report
    ? [
        { label: t('reports.openingOutstanding'), value: formatLak(report.openingOutstanding, currency) },
        {
          label: t('reports.closingOutstanding'),
          value: formatLak(report.closingOutstanding, currency),
          delta: latest ? { percent: latest.mom.outstanding.percent } : undefined,
          positiveIsGood: false,
        },
        {
          label: t('reports.disbursed'),
          value: formatLak(report.totals.disbursed, currency),
          delta: latest ? { percent: latest.mom.disbursed.percent } : undefined,
        },
        {
          label: t('reports.collected'),
          value: formatLak(report.totals.collected, currency),
          delta: latest ? { percent: latest.mom.collected.percent } : undefined,
        },
        { label: t('reports.interestPaid'), value: formatLak(report.totals.interestPaid, currency) },
        { label: t('reports.penaltyPaid'), value: formatLak(report.totals.penaltyPaid, currency) },
      ]
    : [];

  return (
    <Stack spacing={2}>
      <PageHeader
        title="Reports"
        actions={
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Button
              disabled={rows.length === 0}
              onClick={exportCsv}
              size="small"
              startIcon={<DownloadIcon />}
              variant="outlined"
            >
              {t('common.exportCsv')}
            </Button>
            <Select
              size="small"
              value={months}
              onChange={(event) => {
                setMonths(Number(event.target.value));
                setFocusMonth(null);
              }}
              inputProps={{ 'aria-label': t('reports.window') }}
            >
              {MONTH_WINDOWS.map((option) => (
                <MenuItem key={option} value={option}>
                  {t('reports.monthsOption', { months: option })}
                </MenuItem>
              ))}
            </Select>
          </Stack>
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
                <Grid key={item.label} size={{ xs: 12, sm: 6, md: 4, lg: 2 }}>
                  <StatCard title={item.label} value={item.value} delta={item.delta} positiveIsGood={item.positiveIsGood} />
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
      {report && rows.length > 0 && (
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, lg: 8 }}>
            <Card sx={riseIn()}>
              <CardContent>
                <Typography variant="subtitle2" gutterBottom>
                  {t('reports.trendTitle')}
                </Typography>
                <TrendChart
                  categories={categories}
                  series={trendSeries}
                  activeIndex={chartIndex}
                  onSelect={selectMonth}
                />
              </CardContent>
            </Card>
          </Grid>
          <Grid size={{ xs: 12, lg: 4 }}>
            <Card sx={riseIn(60)}>
              <CardContent>
                <Typography variant="subtitle2" gutterBottom>
                  {t('reports.mixTitle')}
                </Typography>
                <ShareDonut
                  slices={mixSlices}
                  centerLabel={t('reports.mixCenter')}
                  centerValue={compactAmount(mixTotal)}
                />
              </CardContent>
            </Card>
          </Grid>
          <Grid size={{ xs: 12 }}>
            <Card sx={riseIn(120)}>
              <CardContent>
                <Typography variant="subtitle2" gutterBottom>
                  {t('reports.outstandingTitle')}
                </Typography>
                <TrendChart
                  categories={categories}
                  series={outstandingSeries}
                  height={170}
                  activeIndex={chartIndex}
                  onSelect={selectMonth}
                />
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      )}
      <Card>
        <CardContent>
          <Stack direction="row" sx={{ mb: 1.5, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
            {focusMonth === null ? (
              <Typography variant="caption" color="text.secondary">
                {t('reports.clickMonth')}
              </Typography>
            ) : (
              <Chip
                color="primary"
                size="small"
                label={t('reports.focusMonth', { month: focusMonth })}
                onDelete={() => setFocusMonth(null)}
                deleteIcon={<CloseIcon />}
              />
            )}
          </Stack>
          {reportQuery.isLoading ? (
            <TableSkeleton columns={8} label={t('common.loading')} />
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('reports.month')}</TableCell>
                  <TableCell align="right">{t('reports.disbursed')}</TableCell>
                  <TableCell align="right">{t('reports.collected')}</TableCell>
                  <TableCell align="right">{t('reports.principalPaid')}</TableCell>
                  <TableCell align="right">{t('reports.interestPaid')}</TableCell>
                  <TableCell align="right">{t('reports.penaltyPaid')}</TableCell>
                  <TableCell align="right">{t('reports.closingOutstanding')}</TableCell>
                  <TableCell align="right">{t('reports.transactions')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {visibleRows.map((row) => (
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
                    <TableCell align="right">{formatLak(row.principalPaid, currency)}</TableCell>
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
                {report?.rows.length === 0 && <EmptyState colSpan={8} message={t('reports.noData')} />}
                {report && focusMonth === null && report.rows.length > 0 && (
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>{t('reports.totals')}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{formatLak(report.totals.disbursed, currency)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{formatLak(report.totals.collected, currency)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{formatLak(componentTotal('principalPaid'), currency)}</TableCell>
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
