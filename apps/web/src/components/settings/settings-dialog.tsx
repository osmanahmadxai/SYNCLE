'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { KeyRound, Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import type {
  AppSettings,
  AppSettingsDTO,
  AuthUser,
} from '@syncle/core';
import { ApiError } from '@/lib/api';
import {
  useAuthStatus,
  useChangePassword,
  useSettings,
  useVersion,
  useUpdateSettings,
} from '@/lib/queries';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertsTab } from './alerts-tab';
import { ApiKeysSection } from './api-keys-section';
import { EncryptionStatus } from './encryption-status';

type CdcOp = 'insert' | 'update' | 'delete';
const CDC_OPS: CdcOp[] = ['insert', 'update', 'delete'];

/** ranges mirror appSettingsSchema in @syncle/core */
const RANGES = {
  defaultPollIntervalMs: { min: 1000, max: 3_600_000 },
  defaultMaxPerPoll: { min: 1, max: 5000 },
  maxQueryRows: { min: 1, max: 1_000_000 },
  poolIdleMs: { min: 10_000, max: 86_400_000 },
  jobConcurrency: { min: 1, max: 100 },
  sessionTtlMinutes: { min: 15, max: 43_200 },
  deliveryRetentionDays: { min: 0, max: 3650 },
  deliveryMaxPerJob: { min: 0, max: 100_000_000 },
} as const;

export function SettingsDialog({
  open,
  onOpenChange,
  initialTab = 'account',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: string;
}) {
  const t = useTranslations('settingsDialog');
  const { data: status } = useAuthStatus();
  const { data: settings } = useSettings();
  const { data: version } = useVersion();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue={initialTab} className="w-full">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="account">{t('tabs.account')}</TabsTrigger>
            <TabsTrigger value="bridges">{t('tabs.bridges')}</TabsTrigger>
            <TabsTrigger value="engine">{t('tabs.engine')}</TabsTrigger>
            <TabsTrigger value="alerts">{t('tabs.alerts')}</TabsTrigger>
            <TabsTrigger value="security">{t('tabs.security')}</TabsTrigger>
          </TabsList>

          <TabsContent value="account" className="pt-2">
            <AccountTab user={status?.user ?? null} />
          </TabsContent>

          <TabsContent value="alerts" className="pt-2">
            <AlertsTab />
          </TabsContent>

          {settings ? (
            <>
              <TabsContent value="bridges" className="pt-2">
                <BridgesTab settings={settings} />
              </TabsContent>
              <TabsContent value="engine" className="pt-2">
                <EngineTab settings={settings} />
              </TabsContent>
              <TabsContent value="security" className="pt-2">
                <SecurityTab settings={settings} />
              </TabsContent>
            </>
          ) : (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          )}
        </Tabs>

        {/* the first thing a bug report gets asked, and nothing could answer it */}
        {version && (
          <p className="text-muted-foreground border-t pt-2 text-[11px]">
            {t('versionApp', { version: version.version })}
            <span className="mx-1.5 opacity-40">·</span>
            {t('versionNode', { version: version.node })}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Account — read-only username + change-password form                        */
/* -------------------------------------------------------------------------- */

function AccountTab({ user }: { user: AuthUser | null }) {
  const t = useTranslations('settingsDialog');
  const tc = useTranslations('common');
  const change = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleChange() {
    if (change.isPending) return;
    if (!current) {
      setError(t('errorCurrentRequired'));
      return;
    }
    if (next.length < 8) {
      setError(t('errorNewTooShort'));
      return;
    }
    if (next !== confirm) {
      setError(t('errorMismatch'));
      return;
    }
    setError(null);
    try {
      await change.mutateAsync({ currentPassword: current, newPassword: next });
      toast.success(t('passwordChanged'));
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : tc('somethingWrong');
      setError(message);
      toast.error(t('couldNotChangePassword'), { description: message });
    }
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label>{t('username')}</Label>
        <Input value={user?.username ?? ''} readOnly disabled />
      </div>

      <div className="rounded-md border p-3">
        <p className="mb-3 text-sm font-medium">{t('changePassword')}</p>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void handleChange();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="current-pw">{t('currentPassword')}</Label>
            <Input
              id="current-pw"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-pw">{t('newPassword')}</Label>
            <Input
              id="new-pw"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              {t('newPasswordHint')}
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="confirm-pw">{t('confirmPassword')}</Label>
            <Input
              id="confirm-pw"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <Button
            type="submit"
            className="justify-self-start"
            disabled={change.isPending}
          >
            {change.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <KeyRound className="mr-2 h-4 w-4" />
            )}
            {t('changePassword')}
          </Button>
        </form>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Settings tabs — share the save behaviour via a small hook                  */
/* -------------------------------------------------------------------------- */

/** local, editable copy of the saved settings + a save handler */
function useSettingsForm(settings: AppSettings) {
  const t = useTranslations('settingsDialog');
  const update = useUpdateSettings();
  const [form, setForm] = useState<AppSettings>(settings);

  // re-seed when the saved settings change (e.g. after a save reconciles)
  useEffect(() => setForm(settings), [settings]);

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    if (update.isPending) return;
    try {
      await update.mutateAsync(form as AppSettingsDTO);
      toast.success(t('settingsSaved'));
    } catch (err) {
      toast.error(t('couldNotSaveSettings'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  return { form, set, save, saving: update.isPending };
}

function SaveBar({ saving, onSave }: { saving: boolean; onSave: () => void }) {
  const t = useTranslations('settingsDialog');
  return (
    <DialogFooter className="mt-4">
      <Button onClick={onSave} disabled={saving}>
        {saving ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Save className="mr-2 h-4 w-4" />
        )}
        {t('saveChanges')}
      </Button>
    </DialogFooter>
  );
}

/** clamped numeric field (mirrors bridge-builder's NumField) */
function NumField({
  id,
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          // a cleared input coerces to 0 — clamp to the schema's range so we
          // never submit 0/NaN
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min);
        }}
      />
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

function BridgesTab({ settings }: { settings: AppSettings }) {
  const t = useTranslations('settingsDialog');
  const { form, set, save, saving } = useSettingsForm(settings);

  function toggleOp(op: CdcOp, on: boolean) {
    const next = on
      ? [...form.defaultCdcOperations, op]
      : form.defaultCdcOperations.filter((o) => o !== op);
    // keep at least one operation selected (schema requires min 1)
    if (next.length === 0) return;
    set('defaultCdcOperations', next);
  }

  return (
    <div className="grid gap-4">
      <NumField
        id="poll-interval"
        label={t('pollInterval')}
        hint={t('pollIntervalHint')}
        value={form.defaultPollIntervalMs}
        min={RANGES.defaultPollIntervalMs.min}
        max={RANGES.defaultPollIntervalMs.max}
        onChange={(v) => set('defaultPollIntervalMs', v)}
      />
      <NumField
        id="max-per-poll"
        label={t('maxPerPoll')}
        hint={t('maxPerPollHint')}
        value={form.defaultMaxPerPoll}
        min={RANGES.defaultMaxPerPoll.min}
        max={RANGES.defaultMaxPerPoll.max}
        onChange={(v) => set('defaultMaxPerPoll', v)}
      />
      <div className="grid gap-2">
        <Label>{t('cdcOperations')}</Label>
        <p className="text-muted-foreground text-xs">
          {t('cdcOperationsHint')}
        </p>
        <div className="grid gap-2">
          {CDC_OPS.map((op) => (
            <label
              key={op}
              className="flex items-center justify-between rounded-md border p-2.5"
            >
              <span className="text-sm capitalize">{t(`ops.${op}`)}</span>
              <Switch
                checked={form.defaultCdcOperations.includes(op)}
                onCheckedChange={(on) => toggleOp(op, on)}
              />
            </label>
          ))}
        </div>
      </div>
      <SaveBar saving={saving} onSave={save} />
    </div>
  );
}

function EngineTab({ settings }: { settings: AppSettings }) {
  const t = useTranslations('settingsDialog');
  const { form, set, save, saving } = useSettingsForm(settings);
  return (
    <div className="grid gap-4">
      <NumField
        id="max-query-rows"
        label={t('maxQueryRows')}
        hint={t('maxQueryRowsHint')}
        value={form.maxQueryRows}
        min={RANGES.maxQueryRows.min}
        max={RANGES.maxQueryRows.max}
        onChange={(v) => set('maxQueryRows', v)}
      />
      <NumField
        id="pool-idle"
        label={t('poolIdle')}
        hint={t('poolIdleHint')}
        value={form.poolIdleMs}
        min={RANGES.poolIdleMs.min}
        max={RANGES.poolIdleMs.max}
        onChange={(v) => set('poolIdleMs', v)}
      />
      <NumField
        id="job-concurrency"
        label={t('jobConcurrency')}
        hint={t('jobConcurrencyHint')}
        value={form.jobConcurrency}
        min={RANGES.jobConcurrency.min}
        max={RANGES.jobConcurrency.max}
        onChange={(v) => set('jobConcurrency', v)}
      />
      <NumField
        id="delivery-retention-days"
        label={t('deliveryRetentionDays')}
        hint={t('deliveryRetentionDaysHint')}
        value={form.deliveryRetentionDays}
        min={RANGES.deliveryRetentionDays.min}
        max={RANGES.deliveryRetentionDays.max}
        onChange={(v) => set('deliveryRetentionDays', v)}
      />
      <NumField
        id="delivery-max-per-job"
        label={t('deliveryMaxPerJob')}
        hint={t('deliveryMaxPerJobHint')}
        value={form.deliveryMaxPerJob}
        min={RANGES.deliveryMaxPerJob.min}
        max={RANGES.deliveryMaxPerJob.max}
        onChange={(v) => set('deliveryMaxPerJob', v)}
      />
      <SaveBar saving={saving} onSave={save} />
    </div>
  );
}

function SecurityTab({ settings }: { settings: AppSettings }) {
  const t = useTranslations('settingsDialog');
  const { form, set, save, saving } = useSettingsForm(settings);
  return (
    <div className="grid gap-4">
      <NumField
        id="session-ttl"
        label={t('sessionTtl')}
        hint={t('sessionTtlHint')}
        value={form.sessionTtlMinutes}
        min={RANGES.sessionTtlMinutes.min}
        max={RANGES.sessionTtlMinutes.max}
        onChange={(v) => set('sessionTtlMinutes', v)}
      />
      <SaveBar saving={saving} onSave={save} />
      <ApiKeysSection />
      {/* only while a change of master key is under way */}
      <EncryptionStatus />
    </div>
  );
}
