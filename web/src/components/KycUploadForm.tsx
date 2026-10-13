import ClearIcon from '@mui/icons-material/Clear';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import { useTheme } from '@mui/material/styles';
import Typography from '@mui/material/Typography';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { KycDocumentType, KycDocumentVariant, type KycPolicy } from '../api/types';

const CANVAS_WIDTH = 600;
const CANVAS_HEIGHT = 180;

/**
 * One upload form for every KYC evidence type. Size and format limits are read from the
 * live policy — the server re-validates them, this form only explains them early.
 */
export default function KycUploadForm({
  customerId,
  policy,
  onUploaded,
}: {
  customerId: string;
  policy: KycPolicy;
  onUploaded: () => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const fileInput = useRef<HTMLInputElement>(null);
  const previewRef = useRef<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [documentType, setDocumentType] = useState<KycDocumentType>(policy.allowedDocumentTypes[0] ?? KycDocumentType.NATIONAL_ID);
  const [variant, setVariant] = useState<KycDocumentVariant>(KycDocumentVariant.MAIN);
  const [issuedAt, setIssuedAt] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [signatureDrawn, setSignatureDrawn] = useState(false);

  const isSignature = documentType === KycDocumentType.SIGNATURE;

  const chooseFile = (next: File | null) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = next ? URL.createObjectURL(next) : null;
    setPreviewUrl(previewRef.current);
    setFile(next);
  };

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  const mutation = useMutation({
    mutationFn: (body: FormData) => api.post(`/customers/${customerId}/kyc/documents`, body),
    onSuccess: () => {
      chooseFile(null);
      setNote('');
      clearSignature();
      onUploaded();
    },
  });

  const clearSignature = () => {
    const ctx = canvas.current?.getContext('2d');
    if (ctx && canvas.current) ctx.clearRect(0, 0, canvas.current.width, canvas.current.height);
    setSignatureDrawn(false);
  };

  const pointOf = (event: PointerEvent<HTMLCanvasElement>) => {
    const element = canvas.current!;
    const rect = element.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * element.width) / rect.width,
      y: ((event.clientY - rect.top) * element.height) / rect.height,
    };
  };

  const startStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    drawing.current = true;
    const { x, y } = pointOf(event);
    ctx.beginPath();
    ctx.moveTo(x, y);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const drawStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = pointOf(event);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1B2B38';
    ctx.lineTo(x, y);
    ctx.stroke();
    setSignatureDrawn(true);
  };

  const endStroke = () => {
    drawing.current = false;
  };

  const canvasToPng = (): Promise<Blob | null> =>
    new Promise((resolve) => canvas.current?.toBlob((blob) => resolve(blob), 'image/png'));

  const submit = async () => {
    const body = new FormData();
    body.append('documentType', documentType);
    body.append('variant', variant);
    if (issuedAt) body.append('issuedAt', issuedAt);
    if (expiresAt) body.append('expiresAt', expiresAt);
    if (note) body.append('note', note);

    if (file) {
      body.append('file', file, file.name);
    } else if (isSignature && signatureDrawn) {
      const blob = await canvasToPng();
      if (!blob) return;
      body.append('file', blob, 'signature.png');
    } else {
      return;
    }
    mutation.mutate(body);
  };

  const canSubmit = Boolean(file) || (isSignature && signatureDrawn);
  const maxSizeKbReached = file ? file.size > policy.maxFileSizeKb * 1024 : false;

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {t('kyc.fileHint', {
          types: policy.allowedMimeTypes.join(', '),
          size: policy.maxFileSizeKb,
          files: policy.maxFilesPerRequest,
        })}
      </Typography>

      <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', gap: 1 }}>
        <TextField
          select
          label={t('kyc.documentType')}
          value={documentType}
          onChange={(e) => setDocumentType(e.target.value as KycDocumentType)}
          sx={{ minWidth: 240 }}
        >
          {policy.allowedDocumentTypes.map((type) => (
            <MenuItem key={type} value={type}>
              {t(`kyc.type.${type}`)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          label={t('kyc.side')}
          value={variant}
          onChange={(e) => setVariant(e.target.value as KycDocumentVariant)}
          sx={{ minWidth: 140 }}
        >
          {Object.values(KycDocumentVariant).map((v) => (
            <MenuItem key={v} value={v}>
              {t(`kyc.variant.${v}`)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          label={t('kyc.issuedAt')}
          type="date"
          value={issuedAt}
          onChange={(e) => setIssuedAt(e.target.value)}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <TextField
          label={t('kyc.expiresAt')}
          type="date"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          slotProps={{ inputLabel: { shrink: true } }}
        />
      </Stack>

      <TextField
        label={t('kyc.note')}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        multiline
        minRows={2}
        fullWidth
      />

      <input
        ref={fileInput}
        type="file"
        hidden
        accept={policy.allowedMimeTypes.join(',')}
        onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
      />
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
        <Button variant="outlined" startIcon={<UploadFileIcon />} onClick={() => fileInput.current?.click()}>
          {t('kyc.chooseFile')}
        </Button>
        <Typography variant="body2" color={file ? 'text.primary' : 'text.secondary'}>
          {file ? `${file.name} (${Math.round(file.size / 1024)} KB)` : t('kyc.noFileSelected')}
        </Typography>
      </Stack>

      {maxSizeKbReached && (
        <Alert severity="warning">{t('kyc.fileTooLarge', { size: policy.maxFileSizeKb })}</Alert>
      )}

      {previewUrl && (
        <Box
          component="img"
          src={previewUrl}
          alt={t('kyc.preview')}
          sx={{ maxHeight: 180, maxWidth: '100%', borderRadius: 2, border: '1px solid', borderColor: 'divider' }}
        />
      )}

      {isSignature && (
        <Stack spacing={1}>
          <Typography variant="body2" color="text.secondary">
            {t('kyc.draw')}
          </Typography>
          <canvas
            ref={canvas}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            onPointerDown={startStroke}
            onPointerMove={drawStroke}
            onPointerUp={endStroke}
            onPointerLeave={endStroke}
            style={{
              width: '100%',
              maxWidth: CANVAS_WIDTH,
              height: CANVAS_HEIGHT,
              border: `1px solid ${theme.palette.divider}`,
              borderRadius: theme.shape.borderRadius,
              backgroundColor: theme.palette.background.default,
              touchAction: 'none',
              cursor: 'crosshair',
            }}
          />
          <Button size="small" startIcon={<ClearIcon />} onClick={clearSignature} sx={{ alignSelf: 'flex-start' }}>
            {t('kyc.clear')}
          </Button>
        </Stack>
      )}

      {mutation.isError && <Alert severity="error">{(mutation.error as Error).message}</Alert>}

      <Button
        variant="contained"
        startIcon={<UploadFileIcon />}
        onClick={submit}
        disabled={!canSubmit || mutation.isPending}
        sx={{ alignSelf: 'flex-start' }}
      >
        {mutation.isPending ? t('common.processing') : t('kyc.upload')}
      </Button>
    </Stack>
  );
}
