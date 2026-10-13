import AddAPhotoIcon from '@mui/icons-material/AddAPhoto';
import AddIcon from '@mui/icons-material/Add';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import LinkIcon from '@mui/icons-material/Link';
import RestoreIcon from '@mui/icons-material/Restore';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, unwrap } from '../api/client';
import {
  UserRole,
  type AvatarConfig,
  type AvatarPolicy,
  type ManagedUser,
  type PasswordConfig,
} from '../api/types';
import PageHeader from '../components/PageHeader';
import StatusChip from '../components/StatusChip';
import { passwordRuleHints } from '../utils/password-rules';

const ROLE_OPTIONS = Object.values(UserRole);

interface UserForm {
  username: string;
  fullName: string;
  email: string;
  role: UserRole;
  password: string;
  isActive: boolean;
}

const EMPTY: UserForm = {
  username: '',
  fullName: '',
  email: '',
  role: UserRole.MAKER,
  password: '',
  isActive: true,
};

const toForm = (user: ManagedUser): UserForm => ({
  username: user.username,
  fullName: user.fullName,
  email: user.email ?? '',
  role: user.role,
  password: '',
  isActive: user.isActive,
});

export default function UsersPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [form, setForm] = useState<UserForm>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [showDeleted, setShowDeleted] = useState(false);
  const [avatarVersion, setAvatarVersion] = useState(0);

  const usersQuery = useQuery({
    queryKey: ['users', showDeleted],
    queryFn: () =>
      api
        .get<{ users: ManagedUser[] }>('/users', { params: showDeleted ? { includeDeleted: 'true' } : {} })
        .then((response) => response.data.users),
  });
  const passwordQuery = useQuery({
    queryKey: ['config', 'password'],
    queryFn: () => api.get('/config/password').then(unwrap<PasswordConfig>),
  });
  const avatarQuery = useQuery({
    queryKey: ['config', 'avatar'],
    queryFn: () => api.get('/config/avatar').then(unwrap<AvatarConfig>),
  });

  const users = usersQuery.data ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const saveMutation = useMutation({
    mutationFn: (): Promise<unknown> => {
      const payload: Record<string, unknown> = {
        fullName: form.fullName,
        email: form.email.trim() || null,
        role: form.role,
        isActive: form.isActive,
      };
      if (form.password) payload.password = form.password;
      if (editing) return api.patch(`/users/${editing.id}`, payload);
      return api.post('/users', { ...payload, username: form.username });
    },
    onSuccess: async () => {
      setNotice(editing ? t('users.updated') : t('users.created'));
      setOpen(false);
      setError(null);
      await refresh();
    },
    onError: (err: Error) => setError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (user: ManagedUser) => api.delete(`/users/${user.id}`),
    onSuccess: async () => {
      setNotice(t('users.deleted'));
      await refresh();
    },
    onError: (err: Error) => setError(err.message),
  });

  const restoreMutation = useMutation({
    mutationFn: (user: ManagedUser) => api.post(`/users/${user.id}/restore`, { reactivate: true }),
    onSuccess: async () => {
      setNotice(t('users.restored'));
      await refresh();
    },
    onError: (err: Error) => setError(err.message),
  });

  const resetMutation = useMutation({
    mutationFn: (user: ManagedUser) => api.post(`/users/${user.id}/send-reset-link`),
    onSuccess: async () => {
      setNotice(t('users.resetSent'));
      await refresh();
    },
    onError: (err: Error) => setError(err.message),
  });

  const removeAvatarMutation = useMutation({
    mutationFn: (userId: string) => api.delete(`/users/${userId}/avatar`),
    onSuccess: async () => {
      setNotice(t('users.avatarRemoved'));
      setAvatarVersion((version) => version + 1);
      await refresh();
    },
    onError: (err: Error) => setError(err.message),
  });

  const bulkResetMutation = useMutation({    mutationFn: (ids: string[]) => api.post('/users/send-reset-links', { ids }),
    onSuccess: async (response) => {
      const result = response.data as { sent: string[]; skipped: Array<{ reason: string }> };
      setNotice(
        t('users.resetBatch', { sent: result.sent.length, skipped: result.skipped.length }) +
          (result.skipped.length > 0 ? ` ${result.skipped.map((s) => s.reason).join(' · ')}` : ''),
      );
      setSelected([]);
      await refresh();
    },
    onError: (err: Error) => setError(err.message),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    saveMutation.mutate();
  };

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY);
    setError(null);
    setOpen(true);
  };

  const openEdit = (user: ManagedUser) => {
    setEditing(user);
    setForm(toForm(user));
    setError(null);
    setOpen(true);
  };

  const toggleSelected = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((v) => v !== id) : [...current, id]));

  /** The dialog must show the freshly fetched row, so an upload updates the preview. */
  const dialogUser = editing ? (users.find((user) => user.id === editing.id) ?? editing) : null;

  if (usersQuery.isLoading) return <CircularProgress />;

  return (
    <Stack spacing={2}>
      <PageHeader
        title="Users"
        actions={
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
            {t('users.new')}
          </Button>
        }
      />
      <Alert severity="info">{t('users.info')}</Alert>
      {notice && <Alert severity="success">{notice}</Alert>}
      {error && <Alert severity="error">{error}</Alert>}

      {selected.length > 0 && (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="body2">{t('users.selected', { count: selected.length })}</Typography>
          <Button
            size="small"
            startIcon={<LinkIcon />}
            disabled={bulkResetMutation.isPending}
            onClick={() => bulkResetMutation.mutate(selected)}
          >
            {t('users.sendResetBulk')}
          </Button>
        </Stack>
      )}

      <Card>
        <CardContent>
          <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
            <Switch checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} size="small" />
            <Typography variant="body2">{t('users.showDeleted')}</Typography>
          </Stack>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 44 }} />
                <TableCell>{t('users.username')}</TableCell>
                <TableCell>{t('users.fullName')}</TableCell>
                <TableCell>{t('users.email')}</TableCell>
                <TableCell>{t('users.role')}</TableCell>
                <TableCell>{t('users.status')}</TableCell>
                <TableCell>{t('users.lastLogin')}</TableCell>
                <TableCell align="right">{t('users.actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id} hover>
                  <TableCell padding="checkbox">
                    <Checkbox
                      size="small"
                      checked={selected.includes(user.id)}
                      onChange={() => toggleSelected(user.id)}
                      disabled={!user.email || Boolean(user.deletedAt)}
                    />
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <UserAvatar user={user} size={28} />
                      <span>{user.username}</span>
                    </Stack>
                  </TableCell>
                  <TableCell>{user.fullName}</TableCell>
                  <TableCell>
                    {user.email ? (
                      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                        <span>{user.email}</span>
                        {user.isEmailVerified && (
                          <Tooltip title={t('users.emailVerified')}>
                            <CheckCircleIcon fontSize="inherit" color="success" />
                          </Tooltip>
                        )}
                      </Stack>
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        {t('users.emailMissing')}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>{t(`roles.${user.role}`)}</TableCell>
                  <TableCell>
                    <StatusChip
                      status={user.deletedAt ? 'DELETED' : user.isActive ? 'ACTIVE' : 'INACTIVE'}
                    />
                  </TableCell>
                  <TableCell>
                    {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : t('users.never')}
                  </TableCell>
                  <TableCell align="right">
                    {user.deletedAt ? (
                      <Tooltip title={t('users.restore')}>
                        <span>
                          <IconButton
                            size="small"
                            disabled={restoreMutation.isPending}
                            onClick={() => restoreMutation.mutate(user)}
                          >
                            <RestoreIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    ) : (
                      <>
                        <Tooltip title={t('users.edit')}>
                          <IconButton size="small" onClick={() => openEdit(user)}>
                            <EditIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title={t('users.sendReset')}>
                          <span>
                            <IconButton
                              size="small"
                              disabled={!user.email || resetMutation.isPending}
                              onClick={() => resetMutation.mutate(user)}
                            >
                              <LinkIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title={t('users.delete')}>
                          <span>
                            <IconButton
                              size="small"
                              color="error"
                              disabled={deleteMutation.isPending}
                              onClick={() => {
                                if (window.confirm(t('users.confirmDelete', { username: user.username }))) {
                                  deleteMutation.mutate(user);
                                }
                              }}
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
        <form onSubmit={submit}>
          <DialogTitle>{editing ? t('users.editTitle') : t('users.new')}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              {dialogUser && (
                <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                  <UserAvatar
                    key={avatarVersion}
                    user={dialogUser}
                    size={56}
                    version={avatarVersion}
                  />
                  <Stack spacing={0.75} sx={{ flexGrow: 1 }}>
                    <Typography variant="subtitle2">{t('users.avatar')}</Typography>
                    <AvatarUploader
                      userId={dialogUser.id}
                      policy={avatarQuery.data?.policy}
                      onUploaded={() => {
                        setAvatarVersion((version) => version + 1);
                        return refresh();
                      }}
                    />
                    {dialogUser.hasAvatar && (
                      <Button
                        size="small"
                        color="error"
                        startIcon={<DeleteIcon />}
                        disabled={removeAvatarMutation.isPending}
                        onClick={() => removeAvatarMutation.mutate(dialogUser.id)}
                        sx={{ alignSelf: 'flex-start' }}
                      >
                        {t('users.avatarRemove')}
                      </Button>
                    )}
                  </Stack>
                </Stack>
              )}
              {!editing && (
                <TextField
                  label={t('users.username')}
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  required
                  fullWidth
                />
              )}
              <TextField
                label={t('users.fullName')}
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                required
                fullWidth
              />
              <TextField
                label={t('users.email')}
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                fullWidth
                helperText={t('users.emailHelper')}
              />
              <TextField
                select
                label={t('users.role')}
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}
                fullWidth
              >
                {ROLE_OPTIONS.map((role) => (
                  <MenuItem key={role} value={role}>
                    {t(`roles.${role}`)}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                label={editing ? t('users.passwordNew') : t('users.password')}
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                fullWidth
                helperText={passwordRuleHints(passwordQuery.data?.policy, t)}
              />
              <Stack direction="row" sx={{ alignItems: 'center' }}>
                <Switch
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  disabled={!editing}
                />
                <Typography variant="body2">{t('users.active')}</Typography>
              </Stack>
              {saveMutation.isError && (
                <Alert severity="error">{(saveMutation.error as Error).message}</Alert>
              )}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" variant="contained" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? t('common.processing') : t('common.save')}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Stack>
  );
}

/** Avatars are authenticated BLOBs, so the picture is fetched into an object URL. */
export function UserAvatar({
  user,
  size = 36,
  version = 0,
}: {
  user: Pick<ManagedUser, 'id' | 'username' | 'fullName' | 'hasAvatar'>;
  size?: number;
  version?: number;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const requestKey = useRef<string | null>(null);

  useEffect(() => {
    if (!user.hasAvatar) return;
    let objectUrl: string | null = null;
    requestKey.current = user.id;

    api
      .get(`/users/${user.id}/avatar`, { responseType: 'blob', params: { v: version } })
      .then((response) => {
        if (requestKey.current !== user.id) return;
        objectUrl = URL.createObjectURL(response.data as Blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (requestKey.current === user.id) setUrl(null);
      });

    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [user.hasAvatar, user.id, version]);

  return (
    <Avatar
      src={user.hasAvatar ? (url ?? undefined) : undefined}
      alt={t('users.avatar')}
      sx={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        fontWeight: 800,
        bgcolor: 'secondary.light',
        color: 'primary.dark',
      }}
    >
      {user.fullName.trim().charAt(0).toUpperCase()}
    </Avatar>
  );
}

/** File picker + upload used by the dialog and the account menu. */
export function AvatarUploader({
  userId,
  policy,
  onUploaded,
}: {
  userId: string;
  policy: AvatarPolicy | undefined;
  onUploaded: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const uploadMutation = useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.append('file', file);
      return api.put(`/users/${userId}/avatar`, body);
    },
    onSuccess: async () => {
      setError(null);
      await onUploaded();
    },
    onError: (err: Error) => setError(err.message),
  });

  if (policy && !policy.enabled) return null;

  return (
    <Stack spacing={0.5}>
      <Box>
        <Button
          size="small"
          startIcon={<AddAPhotoIcon />}
          disabled={uploadMutation.isPending}
          onClick={() => inputRef.current?.click()}
        >
          {t('users.avatarUpload')}
        </Button>
        <input
          ref={inputRef}
          type="file"
          hidden
          accept={(policy?.allowedMimeTypes ?? ['image/jpeg', 'image/png', 'image/webp']).join(',')}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) uploadMutation.mutate(file);
            event.target.value = '';
          }}
        />
      </Box>
      <Typography variant="caption" color="text.secondary">
        {t('users.avatarImageOnly', { size: policy?.maxFileSizeKb ?? 512 })}
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  );
}
