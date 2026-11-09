import AddIcon from '@mui/icons-material/Add';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { formatLak, type CustomerRow, type Loan } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { canCreate } from '../auth/roles';
import EmptyState from '../components/EmptyState';
import PageHeader from '../components/PageHeader';
import StatusChip from '../components/StatusChip';
import CustomPagination from '../components/CustomPagination';

const INITIAL_ROWS_PER_PAGE = 10;

interface NewCustomer {
  fullName: string;
  phone: string;
  email: string;
  nationalId: string;
  address: string;
}

const EMPTY: NewCustomer = { fullName: '', phone: '', email: '', nationalId: '', address: '' };

function fmtDay(value: string | null, locale: string): string {
  return value ? new Date(value).toLocaleDateString(locale, { dateStyle: 'medium' }) : '—';
}

export default function CustomersPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(INITIAL_ROWS_PER_PAGE);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search), 350);
    return () => window.clearTimeout(t);
  }, [search]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<NewCustomer>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [historyOf, setHistoryOf] = useState<CustomerRow | null>(null);

  const { data } = useQuery({
    queryKey: ['customers', 'table', debounced, page, rowsPerPage],
    queryFn: () =>
      api
        .get<{ customers: CustomerRow[]; pagination: { total: number } }>('/customers', {
          params: { search: debounced || undefined, page: page + 1, limit: rowsPerPage },
        })
        .then((r) => r.data),
  });

  const { data: historyLoans, isLoading: historyLoading } = useQuery({
    queryKey: ['loans', 'byCustomer', historyOf?.id],
    enabled: Boolean(historyOf),
    queryFn: () =>
      api
        .get<{ data: Loan[] }>('/loans', { params: { customerId: historyOf?.id, limit: 100 } })
        .then((r) => r.data.data),
  });

  const createMutation = useMutation({
    mutationFn: (body: NewCustomer) =>
      api.post('/customers', {
        fullName: body.fullName,
        phone: body.phone || undefined,
        email: body.email || undefined,
        nationalId: body.nationalId || undefined,
        address: body.address || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setPage(0);
      setOpen(false);
      setForm(EMPTY);
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const onSearch = (value: string) => {
    setSearch(value);
    setPage(0);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    createMutation.mutate(form);
  };

  return (
    <Stack spacing={2}>
      <PageHeader
        title="Customers"
        actions={
          canCreate(user?.role) ? (
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setOpen(true)}>
              {t('customers.new')}
            </Button>
          ) : null
        }
      />
      <Card>
        <CardContent>
          <Stack direction="row" sx={{ mb: 2, justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
            <Typography variant="body2" color="text.secondary">
              {data ? `${data.pagination.total} ${t('customers.loans')}` : t('common.loading')}
            </Typography>
            <TextField
              size="small"
              placeholder={t('customers.search')}
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              sx={{ width: 300 }}
            />
          </Stack>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('customers.number')}</TableCell>
                  <TableCell>{t('customers.fullName')}</TableCell>
                  <TableCell>{t('customers.phone')}</TableCell>
                  <TableCell>{t('customers.nationalId')}</TableCell>
                  <TableCell>{t('customers.products')}</TableCell>
                  <TableCell align="right">{t('customers.loans')}</TableCell>
                  <TableCell align="right">{t('customers.creditBalance')}</TableCell>
                  <TableCell>{t('customers.kyc')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(data?.customers ?? []).map((c: CustomerRow) => (
                  <TableRow key={c.id} hover>
                    <TableCell>
                      <Link to={`/customers/${c.id}`} style={{ fontWeight: 600 }}>
                        {c.customerNumber}
                      </Link>
                    </TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>{c.fullName}</TableCell>
                    <TableCell>{c.phone ?? '—'}</TableCell>
                    <TableCell>{c.nationalId ?? '—'}</TableCell>
                    <TableCell>
                      {c.borrowings.length === 0 ? (
                        '—'
                      ) : (
                        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                          {c.borrowings.map((b) => (
                            <Chip
                              key={b.productId}
                              size="small"
                              label={`${b.productName}${b.loanCount > 1 ? ` ×${b.loanCount}` : ''}`}
                              color={b.activeCount > 0 ? 'primary' : 'default'}
                              variant={b.activeCount > 0 ? 'filled' : 'outlined'}
                              title={t('customers.borrowingTooltip', {
                                active: b.activeCount,
                                total: b.loanCount,
                                outstanding: formatLak(b.outstanding),
                              })}
                              onClick={() => setHistoryOf(c)}
                            />
                          ))}
                        </Stack>
                      )}
                    </TableCell>
                    <TableCell align="right">{c.loanCount}</TableCell>
                    <TableCell align="right">{formatLak(c.creditBalance)}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <StatusChip status={c.kycStatus} />
                        <Link to={`/customers/${c.id}`}>{t('customers.openKyc')}</Link>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
                {data && data.customers.length === 0 && (
                  <EmptyState colSpan={8} message={t('customers.noCustomers')} />
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

      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
        <form onSubmit={submit}>
          <DialogTitle>{t('customers.new')}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              <TextField
                label={`${t('customers.fullName')} *`}
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                required
              />
              <Stack direction="row" spacing={2}>
                <TextField
                  label={t('customers.phone')}
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  fullWidth
                />
                <TextField
                  label={t('customers.nationalId')}
                  value={form.nationalId}
                  onChange={(e) => setForm({ ...form, nationalId: e.target.value })}
                  fullWidth
                />
              </Stack>
              <TextField
                label={t('customers.email')}
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                fullWidth
              />
              <TextField
                label={t('customers.address')}
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                fullWidth
              />
              {error && <Alert severity="error">{error}</Alert>}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" variant="contained" disabled={createMutation.isPending}>
              {createMutation.isPending ? t('common.loading') : t('products.create')}
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      <Dialog open={Boolean(historyOf)} onClose={() => setHistoryOf(null)} fullWidth maxWidth="md">
        <DialogTitle>{t('customers.loanHistory', { name: historyOf?.fullName ?? '' })}</DialogTitle>
        <DialogContent>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('loans.number')}</TableCell>
                  <TableCell>{t('loans.product')}</TableCell>
                  <TableCell>{t('common.status')}</TableCell>
                  <TableCell align="right">{t('loans.principal')}</TableCell>
                  <TableCell align="right">{t('loans.outstanding')}</TableCell>
                  <TableCell>{t('customers.disbursed')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(historyLoans ?? []).map((loan) => (
                  <TableRow key={loan.id} hover>
                    <TableCell>
                      <Link to={`/loans/${loan.id}`} style={{ fontWeight: 600 }}>
                        {loan.loanNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{loan.product?.name ?? '—'}</TableCell>
                    <TableCell>
                      <StatusChip status={loan.status} />
                    </TableCell>
                    <TableCell align="right">{formatLak(loan.principalAmount)}</TableCell>
                    <TableCell align="right">{formatLak(loan.currentOutstanding)}</TableCell>
                    <TableCell>{fmtDay(loan.disbursedAt, i18n.language)}</TableCell>
                  </TableRow>
                ))}
                {!historyLoading && (historyLoans?.length ?? 0) === 0 && (
                  <EmptyState colSpan={6} message={t('loans.noLoans')} />
                )}
              </TableBody>
            </Table>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setHistoryOf(null)}>{t('common.close')}</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
