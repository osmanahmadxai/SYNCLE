'use client';

/**
 * Settings › Alerts: the places Syncle tells when a bridge needs someone.
 * one list, one form; what the form may and may not send lives in alert-form.ts.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Pencil, Plus, Send, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  ALERT_EVENT_TYPES,
  type AlertChannel,
  type AlertChannelKind,
  type AlertEventType,
} from '@syncle/core';
import { ApiError } from '@/lib/api';
import {
  useAlertChannels,
  useDeleteAlertChannel,
  useSaveAlertChannel,
  useTestAlertChannel,
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  ALERT_KINDS,
  alertFormOf,
  alertFormProblems,
  blankAlertForm,
  validAlertInput,
  type AlertForm,
  type AlertFormField,
} from './alert-form';

export function AlertsTab() {
  const t = useTranslations('alertsTab');
  const { data: channels, isLoading } = useAlertChannels();
  /** null = the list; 'new' or a channel = the form */
  const [editing, setEditing] = useState<AlertChannel | 'new' | null>(null);

  if (editing) {
    return (
      <ChannelForm
        key={editing === 'new' ? 'new' : editing.id}
        channel={editing === 'new' ? null : editing}
        onDone={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">{t('intro')}</p>
      {isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        </div>
      ) : (channels ?? []).length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed p-4 text-center text-xs">
          {t('none')}
        </p>
      ) : (
        <ul className="grid gap-2">
          {(channels ?? []).map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              onEdit={() => setEditing(channel)}
            />
          ))}
        </ul>
      )}
      <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        {t('add')}
      </Button>
    </div>
  );
}

export function ChannelRow({
  channel,
  onEdit,
}: {
  channel: AlertChannel;
  onEdit: () => void;
}) {
  const t = useTranslations('alertsTab');
  const confirm = useConfirm();
  const test = useTestAlertChannel();
  const del = useDeleteAlertChannel();

  async function handleTest() {
    try {
      const result = await test.mutateAsync(channel.id);
      if (result.ok)
        toast.success(t('testSent'), { description: result.detail });
      else toast.error(t('testFailed'), { description: result.detail });
    } catch (err) {
      toast.error(t('testFailed'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: t('deleteTitle', { name: channel.name }),
      description: t('deleteDescription'),
      confirmText: t('delete'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await del.mutateAsync(channel.id);
      toast.success(t('deleted'));
    } catch (err) {
      toast.error(t('couldNotDelete'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  return (
    <li className="flex items-center gap-2 rounded-md border p-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{channel.name}</span>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {t(`kind.${channel.kind}`)}
          </Badge>
          {!channel.enabled && (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {t('off')}
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground truncate text-[11px]">
          {t('eventsCount', {
            count: channel.events.length,
            total: ALERT_EVENT_TYPES.length,
          })}
          <span className="mx-1.5 opacity-40">·</span>
          {channel.lastStatus === null ? (
            t('neverSent')
          ) : channel.lastStatus === 'ok' ? (
            <span className="text-emerald-600 dark:text-emerald-500">
              {t('lastOk')}
            </span>
          ) : (
            <span
              className="text-destructive"
              title={channel.lastError ?? undefined}
            >
              {t('lastFailed', { error: channel.lastError ?? '' })}
            </span>
          )}
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="h-8 shrink-0"
        disabled={test.isPending}
        onClick={() => void handleTest()}
      >
        {test.isPending ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Send className="mr-1.5 h-3.5 w-3.5" />
        )}
        {t('test')}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 shrink-0"
        aria-label={t('edit')}
        onClick={onEdit}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 shrink-0"
        aria-label={t('delete')}
        disabled={del.isPending}
        onClick={() => void handleDelete()}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

export function ChannelForm({
  channel,
  onDone,
  initialKind,
}: {
  channel: AlertChannel | null;
  onDone: () => void;
  /** the kind a NEW channel's form opens on */
  initialKind?: AlertChannelKind;
}) {
  const t = useTranslations('alertsTab');
  const tc = useTranslations('common');
  const save = useSaveAlertChannel();
  const [form, setForm] = useState<AlertForm>(() =>
    channel ? alertFormOf(channel) : blankAlertForm(initialKind),
  );
  /** problems are shown once Save has been tried: an empty new form is not a wall of red */
  const [tried, setTried] = useState(false);
  const problems = alertFormProblems(form, { editing: channel !== null });
  const bad = (field: AlertFormField) => tried && problems.has(field);
  const set = (patch: Partial<AlertForm>) =>
    setForm((f) => ({ ...f, ...patch }));

  async function handleSave() {
    setTried(true);
    const input = validAlertInput(form, { editing: channel !== null });
    if (!input) return;
    try {
      await save.mutateAsync({ id: channel?.id ?? null, input });
      toast.success(channel ? t('saved') : t('created'));
      onDone();
    } catch (err) {
      toast.error(t('couldNotSave'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  function toggleEvent(type: AlertEventType, on: boolean) {
    set({
      events: on
        ? [...new Set([...form.events, type])]
        : form.events.filter((e) => e !== type),
    });
  }

  return (
    <div className="grid max-h-[60vh] gap-3 overflow-y-auto pr-1">
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1.5">
          <Label className="text-xs">{t('kindLabel')}</Label>
          <Select
            value={form.kind}
            // a channel's kind decides what its secrets ARE: it is chosen once
            disabled={channel !== null}
            onValueChange={(kind) => set({ kind: kind as AlertChannelKind })}
          >
            <SelectTrigger className="h-8" aria-label={t('kindLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ALERT_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {t(`kind.${k}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Field label={t('name')} bad={bad('name')} hint={t('nameProblem')}>
          <Input
            className="h-8"
            value={form.name}
            placeholder={t('namePlaceholder')}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
      </div>

      {form.kind !== 'email' && (
        <Field
          label={form.kind === 'slack' ? t('slackUrl') : t('webhookUrl')}
          bad={bad('url')}
          hint={t('urlProblem')}
          help={form.kind === 'slack' ? t('slackUrlHelp') : t('webhookUrlHelp')}
        >
          <Input
            className="h-8 font-mono text-xs"
            value={form.url}
            placeholder={
              form.kind === 'slack'
                ? 'https://hooks.slack.com/services/…'
                : 'https://example.com/syncle-alerts'
            }
            onChange={(e) => set({ url: e.target.value })}
          />
        </Field>
      )}

      {form.kind === 'webhook' && (
        <>
          <Field label={t('secret')} help={t('secretHelp')}>
            <Input
              className="h-8 font-mono text-xs"
              type="password"
              autoComplete="off"
              value={form.secret}
              onChange={(e) => set({ secret: e.target.value })}
            />
          </Field>
          <div className="grid gap-1.5">
            <Label className="text-xs">{t('headers')}</Label>
            {form.headers.map((h, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  className="h-8 flex-1 font-mono text-xs"
                  value={h.key}
                  placeholder="X-Api-Key"
                  aria-label={t('headerName')}
                  onChange={(e) =>
                    set({
                      headers: form.headers.map((x, j) =>
                        j === i ? { ...x, key: e.target.value } : x,
                      ),
                    })
                  }
                />
                <Input
                  className="h-8 flex-1 font-mono text-xs"
                  value={h.value}
                  aria-label={t('headerValue')}
                  onChange={(e) =>
                    set({
                      headers: form.headers.map((x, j) =>
                        j === i ? { ...x, value: e.target.value } : x,
                      ),
                    })
                  }
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0"
                  aria-label={t('removeHeader')}
                  onClick={() =>
                    set({ headers: form.headers.filter((_, j) => j !== i) })
                  }
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              className="h-7 w-fit"
              onClick={() =>
                set({ headers: [...form.headers, { key: '', value: '' }] })
              }
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('addHeader')}
            </Button>
          </div>
        </>
      )}

      {form.kind === 'email' && (
        <>
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <Field
              label={t('smtpHost')}
              bad={bad('smtpHost')}
              hint={t('smtpHostProblem')}
            >
              <Input
                className="h-8"
                value={form.smtpHost}
                placeholder="smtp.example.com"
                onChange={(e) => set({ smtpHost: e.target.value })}
              />
            </Field>
            <Field
              label={t('smtpPort')}
              bad={bad('smtpPort')}
              hint={t('smtpPortProblem')}
            >
              <Input
                className="h-8"
                inputMode="numeric"
                value={form.smtpPort}
                onChange={(e) => set({ smtpPort: e.target.value })}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={form.smtpSecure}
              onCheckedChange={(smtpSecure) => set({ smtpSecure })}
            />
            {t('smtpSecure')}
          </label>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('smtpUser')}>
              <Input
                className="h-8"
                autoComplete="off"
                value={form.smtpUser}
                onChange={(e) => set({ smtpUser: e.target.value })}
              />
            </Field>
            <Field label={t('smtpPassword')}>
              <Input
                className="h-8"
                type="password"
                autoComplete="new-password"
                value={form.smtpPassword}
                onChange={(e) => set({ smtpPassword: e.target.value })}
              />
            </Field>
          </div>
          <Field label={t('from')} bad={bad('from')} hint={t('addressProblem')}>
            <Input
              className="h-8"
              value={form.from}
              placeholder="syncle@example.com"
              onChange={(e) => set({ from: e.target.value })}
            />
          </Field>
          <Field
            label={t('to')}
            bad={bad('to')}
            hint={t('addressProblem')}
            help={t('toHelp')}
          >
            <Textarea
              className="min-h-[52px] text-xs"
              value={form.to}
              placeholder="ops@example.com, oncall@example.com"
              onChange={(e) => set({ to: e.target.value })}
            />
          </Field>
        </>
      )}

      <div className="grid gap-1.5">
        <Label className="text-xs">{t('events')}</Label>
        <div className="grid gap-1.5">
          {ALERT_EVENT_TYPES.map((type) => (
            <label key={type} className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="accent-primary mt-0.5 h-3.5 w-3.5"
                checked={form.events.includes(type)}
                onChange={(e) => toggleEvent(type, e.target.checked)}
              />
              <span>
                <span className="font-medium">
                  {t(`event.${eventKey(type)}.title`)}
                </span>
                <span className="text-muted-foreground block text-[11px]">
                  {t(`event.${eventKey(type)}.help`)}
                </span>
              </span>
            </label>
          ))}
        </div>
        {bad('events') && (
          <p className="text-destructive text-[11px]">{t('eventsProblem')}</p>
        )}
      </div>

      <label className="flex items-center gap-2 text-xs">
        <Switch
          checked={form.enabled}
          onCheckedChange={(enabled) => set({ enabled })}
        />
        {t('enabled')}
      </label>

      <div className="flex justify-end gap-2 border-t pt-3">
        <Button variant="ghost" size="sm" onClick={onDone}>
          {tc('cancel')}
        </Button>
        <Button
          size="sm"
          disabled={save.isPending}
          onClick={() => void handleSave()}
        >
          {save.isPending && (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          )}
          {channel ? t('save') : t('create')}
        </Button>
      </div>
    </div>
  );
}

/** message keys cannot hold a dot: `bridge.failed` is looked up as `bridge_failed` */
const eventKey = (type: AlertEventType): string => type.replace('.', '_');

function Field({
  label,
  bad,
  hint,
  help,
  children,
}: {
  label: string;
  bad?: boolean;
  /** shown when `bad` */
  hint?: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {bad && hint ? (
        <p className="text-destructive text-[11px]">{hint}</p>
      ) : help ? (
        <p className="text-muted-foreground text-[11px]">{help}</p>
      ) : null}
    </div>
  );
}
