import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import {
  PENALTY_MODES,
  PERIOD_UNITS,
  PenaltyMode,
  PeriodUnit,
  type LoanProduct,
  type PenaltyPolicy,
} from '../api/types';
import { describePenalty } from '../utils/penalty';
import { useAuth } from '../auth/AuthContext';
import { isAdmin } from '../auth/roles';
import PageHeader from '../components/PageHeader';
import StatusChip from '../components/StatusChip';
import CustomPagination from '../components/CustomPagination';

interface ProductForm {
  code: string;
  name: string;
  interestRate: string;
  interestRatePeriod: PeriodUnit;
  termValue: string;
  termUnit: PeriodUnit;
  description: string;
  penaltyMode: PenaltyMode;
  penaltyRate: string;
  penaltyAmount: string;
  penaltyPeriod: PeriodUnit;
  graceDays: string;
  penaltyCap: string;
}

interface ProductPageData {
  products: LoanProduct[];
  pagination: { total: number };
}

const INITIAL_ROWS_PER_PAGE = 10;
const EMPTY: ProductForm = {
  code: '',
  name: '',
  interestRate: '',
  interestRatePeriod: PeriodUnit.YEAR,
  termValue: '12',
  termUnit: PeriodUnit.MONTH,
  description: '',
  penaltyMode: PenaltyMode.NONE,
  penaltyRate: '',
  penaltyAmount: '',
  penaltyPeriod: PeriodUnit.MONTH,
  graceDays: '0',
  penaltyCap: '0',
};

const productToForm = (p: LoanProduct): ProductForm => ({
  code: p.code,
  name: p.name,
  interestRate: String(p.interestRate),
  interestRatePeriod: p.interestRatePeriod,
  termValue: String(p.termValue),
  termUnit: p.termUnit,
  description: p.description ?? '',
  penaltyMode: p.penaltyPolicy?.mode ?? PenaltyMode.NONE,
  penaltyRate: p.penaltyPolicy?.ratePercent ? String(p.penaltyPolicy.ratePercent) : '',
  penaltyAmount: p.penaltyPolicy?.amount ? String(p.penaltyPolicy.amount) : '',
  penaltyPeriod: p.penaltyPolicy?.period ?? PeriodUnit.MONTH,
  graceDays: String(p.penaltyPolicy?.graceDays ?? 0),
  penaltyCap: String(p.penaltyPolicy?.maxPercentOfPrincipal ?? 0),
});

/** Same shape the server expects for both create and patch. */
const toPayload = (form: ProductForm) => ({
  name: form.name,
  interestRate: Number(form.interestRate),
  interestRatePeriod: form.interestRatePeriod,
  termValue: Number(form.termValue),
  termUnit: form.termUnit,
  description: form.description || undefined,
  penaltyPolicy: {
    mode: form.penaltyMode,
    ratePercent: Number(form.penaltyRate || 0),
    amount: Number(form.penaltyAmount || 0),
    period: form.penaltyPeriod,
    graceDays: Number(form.graceDays || 0),
    maxPercentOfPrincipal: Number(form.penaltyCap || 0),
  } satisfies PenaltyPolicy,
});

export default function ProductsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<LoanProduct | null>(null);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(INITIAL_ROWS_PER_PAGE);
  const [form, setForm] = useState<ProductForm>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const admin = isAdmin(user?.role);

  const { data } = useQuery({
    queryKey: ['products', 'table', page, rowsPerPage],
    queryFn: () => api
      .get<ProductPageData>('/loan-products', { params: { page: page + 1, limit: rowsPerPage } })
      .then((r) => r.data),
  });

  const closeDialog = () => {
    setOpen(false);
    setEditing(null);
    setForm(EMPTY);
    setError(null);
  };

  const saveMutation = useMutation({
    mutationFn: (): Promise<unknown> => {
      const payload = toPayload(form);
      return editing
        ? api.patch(`/loan-products/${editing.id}`, payload)
        : api.post('/loan-products', { ...payload, code: form.code });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      if (editing) setSaved(t('products.saved'));
      closeDialog();
    },
    onError: (e: Error) => setError(e.message),
  });

  const toggleMutation = useMutation({
    mutationFn: (p: LoanProduct) => api.patch(`/loan-products/${p.id}`, { isActive: !p.isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['products'] }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(null);
    saveMutation.mutate();
  };

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY);
    setError(null);
    setOpen(true);
  };

  const openEdit = (product: LoanProduct) => {
    setEditing(product);
    setForm(productToForm(product));
    setError(null);
    setOpen(true);
  };

  const penaltyOn = form.penaltyMode !== PenaltyMode.NONE;
  const setField = <K extends keyof ProductForm>(key: K, value: ProductForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <Stack spacing={2}>
      <PageHeader
        title="Loan Products"
        actions={
          admin ? (
            <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
              {t('products.new')}
            </Button>
          ) : null
        }
      />
      <Card>
        <CardContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {t('products.interestInfo')}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
            {t('products.unitHint')}
          </Typography>
          {saved && (
            <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSaved(null)}>
              {saved}
            </Alert>
          )}
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('products.code')}</TableCell>
                  <TableCell>{t('products.name')}</TableCell>
                  <TableCell align="right">{t('products.rate')}</TableCell>
                  <TableCell align="right">{t('products.term')}</TableCell>
                  <TableCell>{t('loanDetail.penalty')}</TableCell>
                  <TableCell>{t('products.currency')}</TableCell>
                  <TableCell>{t('products.active')}</TableCell>
                  <TableCell align="right">{t('common.actions')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(data?.products ?? []).map((p) => (
                  <TableRow key={p.id} hover>
                    <TableCell sx={{ fontWeight: 600 }}>{p.code}</TableCell>
                    <TableCell>{p.name}</TableCell>
                    <TableCell align="right">
                      {t('products.rateDisplay', { rate: p.interestRate, unit: t(`units.${p.interestRatePeriod}`) })}
                    </TableCell>
                    <TableCell align="right">
                      {t('products.termDisplay', { value: p.termValue, unit: t(`units.${p.termUnit}`) })}
                    </TableCell>
                    <TableCell>{describePenalty(t, p.penaltyPolicy)}</TableCell>
                    <TableCell>{p.currency}</TableCell>
                    <TableCell>
                      {admin ? (
                        <Switch
                          checked={p.isActive}
                          onChange={() => toggleMutation.mutate(p)}
                          size="small"
                        />
                      ) : (
                        <StatusChip status={p.isActive ? 'ACTIVE' : 'CLOSED'} />
                      )}
                    </TableCell>
                    <TableCell align="right">
                      {admin ? (
                        <Button size="small" startIcon={<EditIcon />} onClick={() => openEdit(p)}>
                          {t('products.edit')}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
                {data && data.products.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} align="center">
                      {t('products.noProducts')}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Box>
          <CustomPagination
            page={page}
            rowsPerPage={rowsPerPage}
            totalItems={data?.pagination.total ?? 0}
            onPageChange={setPage}
            onRowsPerPageChange={(value) => {
              setRowsPerPage(value);
              setPage(0);
            }}
          />
        </CardContent>
      </Card>

      <Dialog open={open} onClose={closeDialog} fullWidth maxWidth="sm">
        <form onSubmit={submit}>
          <DialogTitle>{editing ? t('products.edit') : t('products.new')}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              <Stack direction="row" spacing={2}>
                <TextField
                  label={`${t('products.code')} *`}
                  value={form.code}
                  onChange={(e) => setField('code', e.target.value)}
                  required
                  disabled={Boolean(editing)}
                  fullWidth
                />
                <TextField
                  label={`${t('products.name')} *`}
                  value={form.name}
                  onChange={(e) => setField('name', e.target.value)}
                  required
                  fullWidth
                />
              </Stack>

              <Typography variant="overline">{t('products.pricing')}</Typography>
              <Stack direction="row" spacing={2}>
                <TextField
                  label={`${t('products.interestRate')} *`}
                  type="number"
                  slotProps={{ htmlInput: { step: '0.000001', min: '0' } }}
                  value={form.interestRate}
                  onChange={(e) => setField('interestRate', e.target.value)}
                  required
                  fullWidth
                />
                <TextField
                  select
                  label={t('products.interestRatePeriod')}
                  value={form.interestRatePeriod}
                  onChange={(e) => setField('interestRatePeriod', e.target.value as PeriodUnit)}
                  fullWidth
                >
                  {PERIOD_UNITS.map((u) => (
                    <MenuItem key={u} value={u}>
                      {t(`units.${u}`)}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>
              <Stack direction="row" spacing={2}>
                <TextField
                  label={`${t('products.termValue')} *`}
                  type="number"
                  slotProps={{ htmlInput: { step: '1', min: '1' } }}
                  value={form.termValue}
                  onChange={(e) => setField('termValue', e.target.value)}
                  required
                  fullWidth
                />
                <TextField
                  select
                  label={t('products.termUnit')}
                  value={form.termUnit}
                  onChange={(e) => setField('termUnit', e.target.value as PeriodUnit)}
                  fullWidth
                >
                  {PERIOD_UNITS.map((u) => (
                    <MenuItem key={u} value={u}>
                      {t(`units.${u}`)}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>

              <Divider />
              {editing && (
                <Typography variant="caption" color="text.secondary">
                  {t('products.updatedLoans')}
                </Typography>
              )}
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Switch checked={penaltyOn} onChange={(e) => setField('penaltyMode', e.target.checked ? PenaltyMode.PERCENT_OF_OVERDUE : PenaltyMode.NONE)} />
                <Typography variant="body2">{t('products.penaltyEnabled')}</Typography>
              </Stack>
              {penaltyOn && (
                <>
                  <TextField
                    select
                    label={t('products.penaltyMode')}
                    value={form.penaltyMode}
                    onChange={(e) => setField('penaltyMode', e.target.value as PenaltyMode)}
                    fullWidth
                  >
                    {PENALTY_MODES.filter((m) => m !== PenaltyMode.NONE).map((m) => (
                      <MenuItem key={m} value={m}>
                        {m === PenaltyMode.PERCENT_OF_OVERDUE
                          ? t('products.penaltyPercent')
                          : t('products.penaltyFixed')}
                      </MenuItem>
                    ))}
                  </TextField>
                  <Stack direction="row" spacing={2}>
                    {form.penaltyMode === PenaltyMode.PERCENT_OF_OVERDUE ? (
                      <TextField
                        label={`${t('products.penaltyRate')} *`}
                        type="number"
                        slotProps={{ htmlInput: { step: '0.000001', min: '0' } }}
                        value={form.penaltyRate}
                        onChange={(e) => setField('penaltyRate', e.target.value)}
                        required
                        fullWidth
                      />
                    ) : (
                      <TextField
                        label={`${t('products.penaltyAmount')} *`}
                        type="number"
                        slotProps={{ htmlInput: { step: '1', min: '0' } }}
                        value={form.penaltyAmount}
                        onChange={(e) => setField('penaltyAmount', e.target.value)}
                        required
                        fullWidth
                      />
                    )}
                    <TextField
                      select
                      label={t('products.penaltyPeriod')}
                      value={form.penaltyPeriod}
                      onChange={(e) => setField('penaltyPeriod', e.target.value as PeriodUnit)}
                      fullWidth
                    >
                      {PERIOD_UNITS.map((u) => (
                        <MenuItem key={u} value={u}>
                          {t(`units.${u}`)}
                        </MenuItem>
                      ))}
                    </TextField>
                  </Stack>
                  <Stack direction="row" spacing={2}>
                    <TextField
                      label={t('products.graceDays')}
                      type="number"
                      slotProps={{ htmlInput: { step: '1', min: '0', max: '3650' } }}
                      value={form.graceDays}
                      onChange={(e) => setField('graceDays', e.target.value)}
                      fullWidth
                    />
                    <TextField
                      label={t('products.penaltyCap')}
                      type="number"
                      slotProps={{ htmlInput: { step: '1', min: '0' } }}
                      value={form.penaltyCap}
                      onChange={(e) => setField('penaltyCap', e.target.value)}
                      helperText={t('products.penaltyCapNone')}
                      fullWidth
                    />
                  </Stack>
                </>
              )}

              <TextField
                label={t('products.description')}
                value={form.description}
                onChange={(e) => setField('description', e.target.value)}
                fullWidth
              />
              {error && <Alert severity="error">{error}</Alert>}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeDialog}>{t('common.cancel')}</Button>
            <Button type="submit" variant="contained" disabled={saveMutation.isPending}>
              {saveMutation.isPending
                ? t('common.loading')
                : editing
                  ? t('products.save')
                  : t('products.create')}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Stack>
  );
}
