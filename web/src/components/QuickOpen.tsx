import CloseIcon from '@mui/icons-material/Close';
import Alert from '@mui/material/Alert';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import SearchIcon from '@mui/icons-material/Search';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Customer, Loan } from '../api/types';
import { LoadingPanel } from './LoadingOverlay';
import { useDebounced } from '../utils/debounce';

const MIN_QUERY = 2;
const GROUP_LIMIT = 5;

interface QuickOpenProps {
  onClose: () => void;
  open: boolean;
}

/** The list endpoints already search by customer name, customer number and loan number, so this is a thin layer over them. */
export default function QuickOpen({ onClose, open }: QuickOpenProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const query = useDebounced(term.trim(), 250);
  const active = query.length >= MIN_QUERY;

  const customersQuery = useQuery({
    queryKey: ['quick-open', 'customers', query],
    queryFn: () =>
      api
        .get<{ customers: Customer[] }>('/customers', { params: { search: query, limit: GROUP_LIMIT } })
        .then((response) => response.data.customers.slice(0, GROUP_LIMIT)),
    enabled: open && active,
  });
  const loansQuery = useQuery({
    queryKey: ['quick-open', 'loans', query],
    queryFn: () =>
      api
        .get<{ data: Loan[] }>('/loans', { params: { q: query, limit: GROUP_LIMIT } })
        .then((response) => response.data.data.slice(0, GROUP_LIMIT)),
    enabled: open && active,
  });

  const customers = customersQuery.data ?? [];
  const loans = loansQuery.data ?? [];
  const loading = active && (customersQuery.isFetching || loansQuery.isFetching);
  const error = customersQuery.error ?? loansQuery.error;
  const noResults = active && !loading && !error && customers.length === 0 && loans.length === 0;

  const close = () => {
    setTerm('');
    onClose();
  };

  const goTo = (path: string) => {
    setTerm('');
    onClose();
    navigate(path);
  };

  return (
    <Dialog fullWidth maxWidth="sm" onClose={close} open={open}>
      <DialogTitle id="quick-open-title" sx={{ clip: 'rect(0 0 0 0)', height: 1, overflow: 'hidden', position: 'absolute', whiteSpace: 'nowrap', width: 1 }}>
        {t('quickOpen.label')}
      </DialogTitle>
      <DialogContent sx={{ px: 0, pt: 1 }}>
        <TextField
          autoComplete="off"
          aria-label={t('quickOpen.label')}
          autoFocus
          fullWidth
          onChange={(event) => setTerm(event.target.value)}
          placeholder={t('quickOpen.placeholder')}
          size="small"
          slotProps={{
            input: {
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton aria-label={t('common.close')} size="small" onClick={close}>
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ),
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
          sx={{ px: 2 }}
          variant="standard"
        />
        {active && !loading && (
          <List dense sx={{ maxHeight: 380, overflowY: 'auto' }}>
            {customers.length > 0 && <ListSubheader disableSticky>{t('navigation.customers')}</ListSubheader>}
            {customers.map((customer) => (
              <ListItemButton key={customer.id} onClick={() => goTo(`/customers/${customer.id}`)}>
                <ListItemText
                  primary={customer.fullName}
                  secondary={customer.customerNumber}
                  slotProps={{ secondary: { variant: 'caption' } }}
                />
              </ListItemButton>
            ))}
            {loans.length > 0 && <ListSubheader disableSticky>{t('navigation.loans')}</ListSubheader>}
            {loans.map((loan) => (
              <ListItemButton key={loan.id} onClick={() => goTo(`/loans/${loan.id}`)}>
                <ListItemText
                  primary={loan.loanNumber}
                  secondary={loan.customer?.fullName ?? loan.customerId}
                  slotProps={{ secondary: { variant: 'caption' } }}
                />
              </ListItemButton>
            ))}
          </List>
        )}
        {loading && <LoadingPanel label={t('common.loading')} />}
        {active && !loading && error && (
          <Alert severity="error" sx={{ mx: 2, my: 1 }}>
            {error.message}
          </Alert>
        )}
        {(noResults || !active) && (
          <Typography color="text.secondary" sx={{ px: 2, py: 2 }} variant="body2">
            {noResults ? t('quickOpen.empty') : t('quickOpen.tooShort', { min: MIN_QUERY })}
          </Typography>
        )}
      </DialogContent>
    </Dialog>
  );
}
