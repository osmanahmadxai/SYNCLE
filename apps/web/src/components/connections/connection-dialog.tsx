'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, PlugZap } from 'lucide-react';
import { toast } from 'sonner';
import type { ConnectionInputDTO, DatabaseEngine } from '@syncle/core';
import { api, ApiError } from '@/lib/api';
import {
  useCreateConnection,
  useDrivers,
  useUpdateConnection,
} from '@/lib/queries';
import { useStudio } from '@/lib/store';
import { engineMeta } from '@/lib/engines';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type FormState = Record<string, string> & { name?: string; ssl?: string };

export function ConnectionDialog() {
  const t = useTranslations('connections');
  const tc = useTranslations('common');
  const { dialog, closeConnectionDialog } = useStudio();
  const { data: drivers } = useDrivers();
  const create = useCreateConnection();
  const update = useUpdateConnection();

  const [engine, setEngine] = useState<DatabaseEngine>('postgres');
  const [form, setForm] = useState<FormState>({ name: '' });
  const [ssl, setSsl] = useState(false);
  const [sshEnabled, setSshEnabled] = useState(false);
  const [sshAuthMethod, setSshAuthMethod] = useState<'password' | 'privateKey'>(
    'password',
  );
  const [testing, setTesting] = useState(false);

  const editing = dialog.editingId;

  // load existing connection when editing
  useEffect(() => {
    if (!dialog.open) return;
    // always start from a clean slate so a failed load can't leave the
    // previous connection's values behind
    setForm({ name: '' });
    setEngine('postgres');
    setSsl(false);
    setSshEnabled(false);
    setSshAuthMethod('password');
    if (!editing) return;
    void api.getConnection(editing).then(
      (c) => {
        setEngine(c.engine);
        setSsl(!!c.ssl);
        setSshEnabled(!!c.ssh?.enabled);
        setSshAuthMethod(c.ssh?.authMethod ?? 'password');
        setForm({
          name: c.name,
          host: c.host ?? '',
          port: c.port != null ? String(c.port) : '',
          user: c.user ?? '',
          password: c.password ?? '',
          database: c.database ?? '',
          connectionString: c.connectionString ?? '',
          sshHost: c.ssh?.host ?? '',
          sshPort: c.ssh?.port != null ? String(c.ssh.port) : '',
          sshUsername: c.ssh?.username ?? '',
          // secrets arrive redacted; sending them back unchanged keeps the
          // stored values, exactly like the database password
          sshPassword: c.ssh?.password ?? '',
          sshPrivateKey: c.ssh?.privateKey ?? '',
          sshPassphrase: c.ssh?.passphrase ?? '',
        });
      },
      (err) => {
        // don't silently show new-connection defaults for an edit
        toast.error(t('loadFailed'), {
          description: err instanceof ApiError ? err.message : String(err),
        });
        closeConnectionDialog();
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog.open, editing, closeConnectionDialog]);

  const driver = useMemo(
    () => drivers?.find((d) => d.engine === engine),
    [drivers, engine],
  );

  function buildPayload(): ConnectionInputDTO {
    const payload: ConnectionInputDTO = {
      name: form.name?.trim() || engineMeta(engine).label,
      engine,
      ssl,
    };
    for (const field of driver?.fields ?? []) {
      const raw = form[field.key]?.trim();
      if (!raw) continue;
      if (field.key === 'port') payload.port = Number(raw);
      else (payload as Record<string, unknown>)[field.key] = raw;
    }
    if (engine !== 'sqlite' && sshEnabled) {
      payload.ssh = {
        enabled: true,
        host: form.sshHost?.trim() ?? '',
        port: form.sshPort?.trim() ? Number(form.sshPort.trim()) : 22,
        username: form.sshUsername?.trim() ?? '',
        authMethod: sshAuthMethod,
        ...(sshAuthMethod === 'password'
          ? { password: form.sshPassword || undefined }
          : {
              privateKey: form.sshPrivateKey || undefined,
              passphrase: form.sshPassphrase || undefined,
            }),
      };
    }
    return payload;
  }

  async function handleTest() {
    setTesting(true);
    try {
      await api.testConnection(buildPayload());
      toast.success(t('successful'));
    } catch (err) {
      toast.error(t('failed'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    const payload = buildPayload();
    try {
      if (editing) {
        await update.mutateAsync({ id: editing, input: payload });
        toast.success(t('updated'));
      } else {
        await create.mutateAsync(payload);
        toast.success(t('created'));
      }
      closeConnectionDialog();
    } catch (err) {
      toast.error(t('saveFailed'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  const saving = create.isPending || update.isPending;

  return (
    <Dialog
      open={dialog.open}
      onOpenChange={(o) => !o && closeConnectionDialog()}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {editing ? t('edit') : t('new')}
          </DialogTitle>
          <DialogDescription>
            {t('description')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="name">{t('displayName')}</Label>
            <Input
              id="name"
              value={form.name ?? ''}
              placeholder={t('displayNamePlaceholder')}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>

          <div className="grid gap-2">
            <Label>{t('engine')}</Label>
            <Select
              value={engine}
              onValueChange={(v) => setEngine(v as DatabaseEngine)}
              disabled={!!editing}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {drivers?.map((d) => (
                  <SelectItem key={d.engine} value={d.engine}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {driver && (
              <p className="text-xs text-muted-foreground">
                {driver.description}
              </p>
            )}
          </div>

          {driver?.fields.map((field) => (
            <div key={field.key} className="grid gap-2">
              <Label htmlFor={field.key}>
                {field.label}
                {field.required && (
                  <span className="ml-1 text-destructive">*</span>
                )}
              </Label>
              <Input
                id={field.key}
                type={field.type === 'password' ? 'password' : 'text'}
                inputMode={field.type === 'number' ? 'numeric' : undefined}
                value={form[field.key] ?? ''}
                placeholder={field.placeholder}
                onChange={(e) =>
                  setForm((f) => ({ ...f, [field.key]: e.target.value }))
                }
              />
              {field.hint && (
                <p className="text-xs text-muted-foreground">{field.hint}</p>
              )}
            </div>
          ))}

          {engine !== 'sqlite' && (
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="ssl">{t('useTls')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('useTlsHint')}
                </p>
              </div>
              <Switch id="ssl" checked={ssl} onCheckedChange={setSsl} />
            </div>
          )}

          {engine !== 'sqlite' && (
            <div className="rounded-md border">
              <div className="flex items-center justify-between p-3">
                <div>
                  <Label htmlFor="ssh-enabled">{t('sshTunnel')}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t('sshTunnelHint')}
                  </p>
                </div>
                <Switch
                  id="ssh-enabled"
                  checked={sshEnabled}
                  onCheckedChange={setSshEnabled}
                />
              </div>

              {sshEnabled && (
                <div className="grid gap-4 border-t p-3">
                  <div className="grid grid-cols-[1fr_110px] gap-2">
                    <div className="grid gap-2">
                      <Label htmlFor="sshHost">
                        {t('sshHost')}
                        <span className="ml-1 text-destructive">*</span>
                      </Label>
                      <Input
                        id="sshHost"
                        value={form.sshHost ?? ''}
                        placeholder="bastion.example.com"
                        onChange={(e) =>
                          setForm((f) => ({ ...f, sshHost: e.target.value }))
                        }
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="sshPort">{t('sshPort')}</Label>
                      <Input
                        id="sshPort"
                        inputMode="numeric"
                        value={form.sshPort ?? ''}
                        placeholder="22"
                        onChange={(e) =>
                          setForm((f) => ({ ...f, sshPort: e.target.value }))
                        }
                      />
                    </div>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="sshUsername">
                      {t('sshUsername')}
                      <span className="ml-1 text-destructive">*</span>
                    </Label>
                    <Input
                      id="sshUsername"
                      value={form.sshUsername ?? ''}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, sshUsername: e.target.value }))
                      }
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label>{t('sshAuthMethod')}</Label>
                    <Select
                      value={sshAuthMethod}
                      onValueChange={(v) =>
                        setSshAuthMethod(v as 'password' | 'privateKey')
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="password">
                          {t('sshAuthPassword')}
                        </SelectItem>
                        <SelectItem value="privateKey">
                          {t('sshAuthPrivateKey')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {sshAuthMethod === 'password' ? (
                    <div className="grid gap-2">
                      <Label htmlFor="sshPassword">{t('sshPassword')}</Label>
                      <Input
                        id="sshPassword"
                        type="password"
                        value={form.sshPassword ?? ''}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, sshPassword: e.target.value }))
                        }
                      />
                    </div>
                  ) : (
                    <>
                      <div className="grid gap-2">
                        <Label htmlFor="sshPrivateKey">
                          {t('sshPrivateKey')}
                        </Label>
                        <Textarea
                          id="sshPrivateKey"
                          rows={4}
                          className="font-mono text-xs"
                          value={form.sshPrivateKey ?? ''}
                          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                          onChange={(e) =>
                            setForm((f) => ({
                              ...f,
                              sshPrivateKey: e.target.value,
                            }))
                          }
                        />
                        <p className="text-xs text-muted-foreground">
                          {t('sshPrivateKeyHint')}
                        </p>
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="sshPassphrase">
                          {t('sshPassphrase')}
                        </Label>
                        <Input
                          id="sshPassphrase"
                          type="password"
                          value={form.sshPassphrase ?? ''}
                          onChange={(e) =>
                            setForm((f) => ({
                              ...f,
                              sshPassphrase: e.target.value,
                            }))
                          }
                        />
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={handleTest} disabled={testing}>
            {testing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <PlugZap className="mr-2 h-4 w-4" />
            )}
            {tc('test')}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={closeConnectionDialog}>
              {tc('cancel')}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {editing ? tc('save') : tc('create')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
