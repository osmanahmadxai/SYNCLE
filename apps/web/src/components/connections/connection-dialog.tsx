'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, PlugZap } from 'lucide-react';
import { toast } from 'sonner';
import type { ConnectionConfig, ConnectionInputDTO, DatabaseEngine } from '@syncle/core';

type ConnectionEnvironment = NonNullable<ConnectionConfig['environment']>;
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

type TlsMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

const TLS_HINT: Record<TlsMode, string> = {
  disable: 'tlsDisableHint',
  require: 'tlsRequireHint',
  'verify-ca': 'tlsVerifyCaHint',
  'verify-full': 'tlsVerifyFullHint',
};

/**
 * what the old on/off switch meant, per engine (mirrors `effectiveTls` on the
 * server): encrypted-but-unverified everywhere except Redis, which verified.
 */
function legacyTlsMode(
  engine: DatabaseEngine,
  ssl: boolean,
  options?: Record<string, unknown>,
): TlsMode {
  if (!ssl) return 'disable';
  if (engine === 'redis') return 'verify-full';
  if (engine === 'postgres' && options?.sslVerify === true) return 'verify-full';
  return 'require';
}

export function ConnectionDialog() {
  const t = useTranslations('connections');
  const tc = useTranslations('common');
  const { dialog, closeConnectionDialog } = useStudio();
  const { data: drivers } = useDrivers();
  const create = useCreateConnection();
  const update = useUpdateConnection();

  const [engine, setEngine] = useState<DatabaseEngine>('postgres');
  const [form, setForm] = useState<FormState>({ name: '' });
  const [tlsMode, setTlsMode] = useState<TlsMode>('disable');
  const [sshEnabled, setSshEnabled] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [environment, setEnvironment] = useState<ConnectionEnvironment | 'none'>('none');
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
    setTlsMode('disable');
    setSshEnabled(false);
    setSshAuthMethod('password');
    setReadOnly(false);
    setEnvironment('none');
    if (!editing) return;
    void api.getConnection(editing).then(
      (c) => {
        setEngine(c.engine);
        // a connection saved under the old on/off switch has no `tls` block.
        // show what that switch actually did on its engine, so saving again
        // changes nothing the user did not choose to change
        setTlsMode(c.tls?.mode ?? legacyTlsMode(c.engine, !!c.ssl, c.options));
        setSshEnabled(!!c.ssh?.enabled);
        setSshAuthMethod(c.ssh?.authMethod ?? 'password');
        setReadOnly(c.readOnly === true);
        setEnvironment(c.environment ?? 'none');
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
          sshHostKey: c.ssh?.hostKey ?? '',
          tlsCa: c.tls?.ca ?? '',
          tlsCert: c.tls?.cert ?? '',
          // redacted, like every secret; sent back unchanged it keeps the stored key
          tlsKey: c.tls?.key ?? '',
          tlsServername: c.tls?.servername ?? '',
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
      ssl: tlsMode !== 'disable',
      readOnly,
      ...(environment !== 'none' ? { environment } : {}),
    };
    if (engine !== 'sqlite') {
      const verifies = tlsMode === 'verify-ca' || tlsMode === 'verify-full';
      payload.tls = {
        mode: tlsMode,
        ...(verifies && form.tlsCa?.trim() ? { ca: form.tlsCa } : {}),
        ...(tlsMode !== 'disable' && form.tlsCert?.trim()
          ? { cert: form.tlsCert, key: form.tlsKey || undefined }
          : {}),
        ...(tlsMode === 'verify-full' && form.tlsServername?.trim()
          ? { servername: form.tlsServername.trim() }
          : {}),
      };
    }
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
        ...(form.sshHostKey?.trim() ? { hostKey: form.sshHostKey.trim() } : {}),
      };
    }
    return payload;
  }

  async function handleTest() {
    setTesting(true);
    try {
      const result = await api.testConnection(buildPayload(), editing ?? undefined);
      // first contact with this jump host: show its key, and keep it, so the
      // next connection is checked against it instead of trusting whoever answers
      const seen = result.sshHostKey;
      if (seen && !form.sshHostKey?.trim()) {
        setForm((f) => ({ ...f, sshHostKey: seen }));
        toast.success(t('successful'), {
          description: t('sshHostKeySeen', { fingerprint: seen }),
        });
      } else {
        toast.success(t('successful'));
      }
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
              {field.key === 'connectionString' &&
                sshEnabled &&
                !!form.connectionString?.trim() && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    {t('connectionStringWithSsh')}
                  </p>
                )}
            </div>
          ))}

          {engine !== 'sqlite' && (
            <div className="rounded-md border">
              <div className="grid gap-2 p-3">
                <Label htmlFor="tlsMode">{t('tls')}</Label>
                <Select
                  value={tlsMode}
                  onValueChange={(v) => setTlsMode(v as TlsMode)}
                >
                  <SelectTrigger id="tlsMode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="disable">{t('tlsDisable')}</SelectItem>
                    <SelectItem value="require">{t('tlsRequire')}</SelectItem>
                    <SelectItem value="verify-ca">{t('tlsVerifyCa')}</SelectItem>
                    <SelectItem value="verify-full">
                      {t('tlsVerifyFull')}
                    </SelectItem>
                  </SelectContent>
                </Select>
                {/* say what the chosen mode does NOT protect against: "TLS on"
                    reads as "safe", and two of these three are not */}
                <p
                  className={
                    tlsMode === 'require'
                      ? 'text-xs text-amber-600 dark:text-amber-400'
                      : 'text-xs text-muted-foreground'
                  }
                >
                  {t(TLS_HINT[tlsMode])}
                </p>
              </div>

              {tlsMode !== 'disable' && (
                <div className="grid gap-4 border-t p-3">
                  {(tlsMode === 'verify-ca' || tlsMode === 'verify-full') && (
                    <div className="grid gap-2">
                      <Label htmlFor="tlsCa">{t('tlsCa')}</Label>
                      <Textarea
                        id="tlsCa"
                        rows={3}
                        className="font-mono text-xs"
                        value={form.tlsCa ?? ''}
                        placeholder="-----BEGIN CERTIFICATE-----"
                        onChange={(e) =>
                          setForm((f) => ({ ...f, tlsCa: e.target.value }))
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('tlsCaHint')}
                      </p>
                    </div>
                  )}
                  {tlsMode === 'verify-full' && (
                    <div className="grid gap-2">
                      <Label htmlFor="tlsServername">
                        {t('tlsServername')}
                      </Label>
                      <Input
                        id="tlsServername"
                        value={form.tlsServername ?? ''}
                        placeholder={form.host || 'db.example.com'}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            tlsServername: e.target.value,
                          }))
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('tlsServernameHint')}
                      </p>
                    </div>
                  )}
                  <div className="grid gap-2">
                    <Label htmlFor="tlsCert">{t('tlsClientCert')}</Label>
                    <Textarea
                      id="tlsCert"
                      rows={3}
                      className="font-mono text-xs"
                      value={form.tlsCert ?? ''}
                      placeholder="-----BEGIN CERTIFICATE-----"
                      onChange={(e) =>
                        setForm((f) => ({ ...f, tlsCert: e.target.value }))
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('tlsClientCertHint')}
                    </p>
                  </div>
                  {form.tlsCert?.trim() && (
                    <div className="grid gap-2">
                      <Label htmlFor="tlsKey">{t('tlsClientKey')}</Label>
                      <Textarea
                        id="tlsKey"
                        rows={3}
                        className="font-mono text-xs"
                        value={form.tlsKey ?? ''}
                        placeholder="-----BEGIN PRIVATE KEY-----"
                        onChange={(e) =>
                          setForm((f) => ({ ...f, tlsKey: e.target.value }))
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('tlsClientKeyHint')}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="grid gap-3 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label htmlFor="conn-environment">{t('environment')}</Label>
                <p className="text-xs text-muted-foreground">{t('environmentHint')}</p>
              </div>
              <Select
                value={environment}
                onValueChange={(v) => setEnvironment(v as ConnectionEnvironment | 'none')}
              >
                <SelectTrigger id="conn-environment" className="h-8 w-40 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('environmentNone')}</SelectItem>
                  <SelectItem value="production">{t('environmentProduction')}</SelectItem>
                  <SelectItem value="staging">{t('environmentStaging')}</SelectItem>
                  <SelectItem value="development">{t('environmentDevelopment')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label htmlFor="conn-readonly">{t('readOnly')}</Label>
                <p className="text-xs text-muted-foreground">{t('readOnlyHint')}</p>
              </div>
              <Switch id="conn-readonly" checked={readOnly} onCheckedChange={setReadOnly} />
            </div>
          </div>

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
                  <div className="grid gap-2">
                    <Label htmlFor="sshHostKey">{t('sshHostKey')}</Label>
                    <Input
                      id="sshHostKey"
                      className="font-mono text-xs"
                      value={form.sshHostKey ?? ''}
                      placeholder="SHA256:…"
                      onChange={(e) =>
                        setForm((f) => ({ ...f, sshHostKey: e.target.value }))
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('sshHostKeyHint')}
                    </p>
                  </div>
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
