'use client';

/**
 * Settings › Security › Accounts: who can sign in, and as what. an admin's
 * view. what cannot be done — demoting the last admin, deleting yourself —
 * the API refuses with a reason, which is shown as it came.
 */
import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  Ban,
  KeyRound,
  Loader2,
  LogOut,
  Plus,
  Trash2,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import type { UserInfo, UserRole } from '@syncle/core';
import { ApiError } from '@/lib/api';
import {
  useAuthStatus,
  useCreateUser,
  useDeleteUser,
  useEndUserSessions,
  useUpdateUser,
  useUsers,
} from '@/lib/queries';
import { useConfirm } from '@/components/confirm';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export const ROLES: UserRole[] = ['admin', 'operator', 'viewer'];

export function UsersSection() {
  const t = useTranslations('users');
  const { data: status } = useAuthStatus();
  const { data: users, isLoading } = useUsers();
  const create = useCreateUser();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('operator');

  async function handleCreate() {
    try {
      await create.mutateAsync({ username: name.trim(), password, role });
      setName('');
      setPassword('');
      toast.success(t('created', { name: name.trim() }));
    } catch (err) {
      toast.error(t('couldNotCreate'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  return (
    <section className="grid gap-3 border-t pt-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Users className="h-3.5 w-3.5" />
          {t('title')}
        </h3>
        <p className="text-muted-foreground text-xs">{t('intro')}</p>
      </div>

      {isLoading && (
        <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
      )}
      <ul className="grid gap-2">
        {users?.map((user) => (
          <UserRow
            key={user.id}
            user={user}
            self={user.id === status?.user?.id}
          />
        ))}
      </ul>

      <form
        className="grid gap-2 rounded-md border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void handleCreate();
        }}
      >
        <p className="text-xs font-medium">{t('add')}</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="grid gap-1">
            <Label htmlFor="new-user-name" className="text-xs">
              {t('name')}
            </Label>
            <Input
              id="new-user-name"
              className="h-8"
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="new-user-password" className="text-xs">
              {t('password')}
            </Label>
            <Input
              id="new-user-password"
              className="h-8"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">{t('role')}</Label>
            <RoleSelect value={role} onChange={setRole} label={t('role')} />
          </div>
        </div>
        <p className="text-muted-foreground text-[11px]">
          {t(`roleHint.${role}`)}
        </p>
        <div>
          <Button
            type="submit"
            size="sm"
            className="h-7"
            disabled={
              create.isPending || name.trim().length < 3 || password.length < 8
            }
          >
            {create.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="mr-1 h-3.5 w-3.5" />
            )}
            {t('create')}
          </Button>
        </div>
      </form>
    </section>
  );
}

function RoleSelect({
  value,
  onChange,
  label,
  disabled,
}: {
  value: UserRole;
  onChange: (r: UserRole) => void;
  label: string;
  disabled?: boolean;
}) {
  const t = useTranslations('users');
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v as UserRole)}
      disabled={disabled}
    >
      <SelectTrigger className="h-8" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ROLES.map((r) => (
          <SelectItem key={r} value={r}>
            {t(`roles.${r}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function UserRow({ user, self }: { user: UserInfo; self: boolean }) {
  const t = useTranslations('users');
  const format = useFormatter();
  const update = useUpdateUser();
  const remove = useDeleteUser();
  const endSessions = useEndUserSessions();
  const confirm = useConfirm();
  const [setting, setSetting] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const busy = update.isPending || remove.isPending || endSessions.isPending;

  const failed = (title: string) => (err: unknown) =>
    toast.error(title, {
      description: err instanceof ApiError ? err.message : String(err),
    });

  const change = (
    input: Parameters<typeof update.mutateAsync>[0]['input'],
    done?: () => void,
  ) =>
    update
      .mutateAsync({ id: user.id, input })
      .then(() => done?.())
      .catch(failed(t('couldNotChange', { name: user.username })));

  return (
    <li className="grid gap-2 rounded-md border p-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{user.username}</span>
        {self && <Badge variant="outline">{t('you')}</Badge>}
        {user.disabledAt && (
          <Badge variant="destructive">{t('disabled')}</Badge>
        )}
        <span className="text-muted-foreground ml-auto text-[11px]">
          {user.lastLoginAt
            ? t('lastLogin', {
                when: format.dateTime(new Date(user.lastLoginAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
              })
            : t('neverSignedIn')}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-36">
          <RoleSelect
            value={user.role}
            label={t('roleOf', { name: user.username })}
            disabled={busy}
            onChange={(role) => void change({ role })}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={busy}
          onClick={() => void change({ disabled: !user.disabledAt })}
        >
          <Ban className="mr-1 h-3.5 w-3.5" />
          {user.disabledAt ? t('enable') : t('disable')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={busy}
          onClick={() => setSetting((s) => !s)}
        >
          <KeyRound className="mr-1 h-3.5 w-3.5" />
          {t('setPassword')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={busy}
          onClick={() =>
            endSessions
              .mutateAsync(user.id)
              .then(() =>
                toast.success(t('sessionsEnded', { name: user.username })),
              )
              .catch(failed(t('couldNotChange', { name: user.username })))
          }
        >
          <LogOut className="mr-1 h-3.5 w-3.5" />
          {t('endSessions')}
        </Button>
        {!self && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive h-7"
            disabled={busy}
            onClick={async () => {
              if (
                !(await confirm({
                  title: t('confirmDelete', { name: user.username }),
                  description: t('confirmDeleteHint'),
                  confirmText: t('delete'),
                  destructive: true,
                }))
              )
                return;
              remove
                .mutateAsync(user.id)
                .catch(failed(t('couldNotChange', { name: user.username })));
            }}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            {t('delete')}
          </Button>
        )}
      </div>
      {setting && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void change({ newPassword }, () => {
              setNewPassword('');
              setSetting(false);
              toast.success(t('passwordSet', { name: user.username }));
            });
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor={`password-${user.id}`} className="text-xs">
              {t('newPassword')}
            </Label>
            <Input
              id={`password-${user.id}`}
              className="h-8 w-56"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <Button
            type="submit"
            size="sm"
            className="h-8"
            disabled={busy || newPassword.length < 8}
          >
            {t('save')}
          </Button>
          <p className="text-muted-foreground w-full text-[11px]">
            {t('setPasswordHint')}
          </p>
        </form>
      )}
    </li>
  );
}
