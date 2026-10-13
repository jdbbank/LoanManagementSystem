import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';

/** KYC images are stored as authenticated BLOBs, so they are fetched into a local object URL. */
export default function KycImageView({
  customerId,
  documentId,
  maxHeight = 420,
}: {
  customerId: string;
  documentId: string;
  maxHeight?: number;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<{ key: string; url: string } | { key: string; failed: true } | null>(null);
  const key = `${customerId}/${documentId}`;

  useEffect(() => {
    let objectUrl: string | null = null;

    api
      .get(`/customers/${customerId}/kyc/documents/${documentId}/content`, { responseType: 'blob' })
      .then((response) => {
        objectUrl = URL.createObjectURL(response.data as Blob);
        setResult({ key, url: objectUrl });
      })
      .catch(() => setResult({ key, failed: true }));

    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [customerId, documentId, key]);

  const failed = result !== null && 'failed' in result && result.key === key;
  const url = result !== null && 'url' in result && result.key === key ? result.url : null;

  if (failed) return <Typography color="error.main">{t('kyc.imageError')}</Typography>;
  if (!url) {
    return (
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <CircularProgress size={22} />
        <Typography color="text.secondary">{t('kyc.imageLoading')}</Typography>
      </Stack>
    );
  }

  return (
    <Box
      component="img"
      src={url}
      alt={t('kyc.viewImage')}
      sx={{
        maxWidth: '100%',
        maxHeight,
        display: 'block',
        borderRadius: 2,
        border: '1px solid',
        borderColor: 'divider',
      }}
    />
  );
}
