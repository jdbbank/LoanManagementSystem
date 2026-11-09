import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';
import { api } from '../api/client';

/**
 * Both KYC scans and financial evidence are authenticated BLOBs, so neither can be shown with a plain
 * <img src>: the bytes only come back with the bearer header. One fetch-to-object-URL path for both.
 */
export default function BlobImageView({
  path,
  loadingLabel,
  errorLabel,
  alt = '',
  maxHeight = 420,
}: {
  path: string;
  loadingLabel: string;
  errorLabel: string;
  alt?: string;
  maxHeight?: number;
}) {
  const [result, setResult] = useState<{ key: string; url: string } | { key: string; failed: true } | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;

    api
      .get(path, { responseType: 'blob' })
      .then((response) => {
        objectUrl = URL.createObjectURL(response.data as Blob);
        setResult({ key: path, url: objectUrl });
      })
      .catch(() => setResult({ key: path, failed: true }));

    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  const failed = result !== null && 'failed' in result && result.key === path;
  const url = result !== null && 'url' in result && result.key === path ? result.url : null;

  if (failed) return <Typography color="error.main">{errorLabel}</Typography>;
  if (!url) {
    return (
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <CircularProgress size={22} />
        <Typography color="text.secondary">{loadingLabel}</Typography>
      </Stack>
    );
  }

  return (
    <Box
      component="img"
      src={url}
      alt={alt}
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
