import Chip from '@mui/material/Chip';
import { useTranslation } from 'react-i18next';
import { statusColor } from '../theme';

export default function StatusChip({ status, size = 'small' }: { status: string; size?: 'small' | 'medium' }) {
  const { t, i18n } = useTranslation();
  const translationKey = `status.${status}`;
  const label = i18n.exists(translationKey) ? t(translationKey) : status.replace(/_/g, ' ');
  return <Chip label={label} color={statusColor[status] ?? 'default'} size={size} variant="outlined" />;
}
