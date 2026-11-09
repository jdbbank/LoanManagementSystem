import UploadFileIcon from '@mui/icons-material/UploadFile';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import {
  EvidenceKind,
  type CustomerBankAccountView,
  type EvidenceDocumentView,
  type EvidencePolicy,
} from '../api/types';

/**
 * One image per request, filed against a customer or a loan. A bank proof has to name the account it
 * documents, so the account picker only appears when the caller passes the customer's accounts in.
 */
export default function EvidenceUploadForm({
  basePath,
  kind,
  policy,
  accounts,
  onUploaded,
}: {
  basePath: string;
  kind: EvidenceKind;
  policy: EvidencePolicy;
  accounts?: CustomerBankAccountView[];
  onUploaded: () => void;
}) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const previewRef = useRef<string | null>(null);
  const [bankAccountId, setBankAccountId] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

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
    mutationFn: (body: FormData) => api.post(`${basePath}/evidence`, body).then((r) => r.data.data as EvidenceDocumentView),
    onSuccess: () => {
      chooseFile(null);
      setNote('');
      setBankAccountId('');
      onUploaded();
    },
  });

  const needsAccount = kind === EvidenceKind.BANK_ACCOUNT_PROOF;
  const tooLarge = file ? file.size > policy.maxFileSizeKb * 1024 : false;
  const canSubmit = Boolean(file) && !tooLarge && (!needsAccount || Boolean(bankAccountId));

  const submit = () => {
    if (!file) return;
    const body = new FormData();
    body.append('kind', kind);
    if (needsAccount && bankAccountId) body.append('bankAccountId', bankAccountId);
    if (note) body.append('note', note);
    body.append('file', file, file.name);
    mutation.mutate(body);
  };

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {t('evidence.fileHint', {
          types: policy.allowedMimeTypes.join(', '),
          size: policy.maxFileSizeKb,
          files: policy.maxFilesPerRequest,
        })}
      </Typography>

      {accounts && needsAccount && (
        <TextField
          select
          label={`${t('evidence.account')} *`}
          value={bankAccountId}
          onChange={(e) => setBankAccountId(e.target.value)}
          sx={{ minWidth: 320 }}
        >
          {accounts.map((account) => (
            <MenuItem key={account.id} value={account.id}>
              {account.bankName} — {account.accountNumber}
            </MenuItem>
          ))}
        </TextField>
      )}

      <TextField
        label={t('evidence.note')}
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
          {t('evidence.chooseFile')}
        </Button>
        <Typography variant="body2" color={file ? 'text.primary' : 'text.secondary'}>
          {file ? `${file.name} (${Math.round(file.size / 1024)} KB)` : t('evidence.noFileSelected')}
        </Typography>
      </Stack>

      {tooLarge && <Alert severity="warning">{t('evidence.fileTooLarge', { size: policy.maxFileSizeKb })}</Alert>}

      {previewUrl && (
        <Box
          component="img"
          src={previewUrl}
          alt={t('evidence.preview')}
          sx={{ maxHeight: 180, maxWidth: '100%', borderRadius: 2, border: '1px solid', borderColor: 'divider' }}
        />
      )}

      {mutation.isError && <Alert severity="error">{(mutation.error as Error).message}</Alert>}

      <Button
        variant="contained"
        startIcon={<UploadFileIcon />}
        onClick={submit}
        disabled={!canSubmit || mutation.isPending}
        sx={{ alignSelf: 'flex-start' }}
      >
        {mutation.isPending ? t('common.processing') : t(`evidence.upload.${kind}`)}
      </Button>
    </Stack>
  );
}
