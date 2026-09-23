'use client';

/**
 * Settings › Security › API keys: a credential for a script or a CI job.
 * the key itself is on screen exactly once — in the panel that appears when it
 * has just been made — because after that nobody, the server included, has it.
 */
import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, Copy, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ApiKeyCreated, ApiKeyInfo, ApiKeyScope } from '@syncle/core';
import { ApiError } from '@/lib/api';
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '@/lib/queries';
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

/** what a key's row says about whether it still works */
export function keyState(
  key: Pick<ApiKeyInfo, 'revokedAt' | 'expiresAt'>,
  now = Date.now(),
): 'active' | 'revoked' | 'expired' {
  if (key.revokedAt) return 'revoked';
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= now)
    return 'expired';
  return 'active';
}

const EXPIRY_CHOICES = ['never', '30', '90', '365'] as const;

export function ApiKeysSection() {
  const t = useTranslations('apiKeys');
  const { data: keys, isLoading } = useApiKeys();
  const create = useCreateApiKey();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<ApiKeyScope>('read');
  const [expiry, setExpiry] = useState<(typeof EXPIRY_CHOICES)[number]>('90');
  const [fresh, setFresh] = useState<ApiKeyCreated | null>(null);

  async function handleCreate() {
    try {
      const created = await create.mutateAsync({
        name: name.trim(),
        scope,
        ...(expiry === 'never' ? {} : { expiresInDays: Number(expiry) }),
      });
      setFresh(created);
      setName('');
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
          <KeyRound className="h-3.5 w-3.5" />
          {t('title')}
        </h3>
        {/* angle brackets are markup to the message format: the header is passed in as a value */}
        <p className="text-muted-foreground text-xs">
          {t('intro', { header: 'Authorization: Bearer <key>' })}
        </p>
      </div>

      {fresh && <FreshKey created={fresh} onDone={() => setFresh(null)} />}

      {isLoading ? (
        <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
      ) : (
        (keys ?? []).length > 0 && (
          <ul className="grid gap-1.5">
            {(keys ?? []).map((key) => (
              <KeyRow key={key.id} apiKey={key} />
            ))}
          </ul>
        )
      )}

      <div className="grid grid-cols-[1fr_8rem_8rem_auto] items-end gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="api-key-name" className="text-xs">
            {t('name')}
          </Label>
          <Input
            id="api-key-name"
            className="h-8"
            value={name}
            placeholder={t('namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">{t('scope')}</Label>
          <Select
            value={scope}
            onValueChange={(v) => setScope(v as ApiKeyScope)}
          >
            <SelectTrigger className="h-8" aria-label={t('scope')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="read">{t('scopeRead')}</SelectItem>
              <SelectItem value="full">{t('scopeFull')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">{t('expires')}</Label>
          <Select
            value={expiry}
            onValueChange={(v) =>
              setExpiry(v as (typeof EXPIRY_CHOICES)[number])
            }
          >
            <SelectTrigger className="h-8" aria-label={t('expires')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPIRY_CHOICES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c === 'never'
                    ? t('never')
                    : t('inDays', { days: Number(c) })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          size="sm"
          className="h-8"
          disabled={!name.trim() || create.isPending}
          onClick={() => void handleCreate()}
        >
          {create.isPending ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="mr-1.5 h-3.5 w-3.5" />
          )}
          {t('create')}
        </Button>
      </div>
      <p className="text-muted-foreground text-[11px]">
        {scope === 'read' ? t('scopeReadHint') : t('scopeFullHint')}
      </p>
    </section>
  );
}

function FreshKey({
  created,
  onDone,
}: {
  created: ApiKeyCreated;
  onDone: () => void;
}) {
  const t = useTranslations('apiKeys');
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-2 rounded-md border border-emerald-600/40 bg-emerald-500/5 p-3">
      <p className="text-xs font-medium">
        {t('freshTitle', { name: created.name })}
      </p>
      <div className="flex items-center gap-2">
        <code className="bg-background min-w-0 flex-1 truncate rounded border px-2 py-1 font-mono text-xs">
          {created.key}
        </code>
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0"
          onClick={() => {
            void navigator.clipboard
              .writeText(created.key)
              .then(() => setCopied(true));
          }}
        >
          {copied ? (
            <Check className="mr-1 h-3.5 w-3.5" />
          ) : (
            <Copy className="mr-1 h-3.5 w-3.5" />
          )}
          {copied ? t('copied') : t('copy')}
        </Button>
      </div>
      <p className="text-muted-foreground text-[11px]">{t('freshHint')}</p>
      <pre className="bg-muted overflow-x-auto rounded p-2 font-mono text-[11px]">{`curl -H "Authorization: Bearer ${created.key.slice(0, 12)}…" \\\n  ${typeof window === 'undefined' ? '' : window.location.origin}/api/bridges`}</pre>
      <Button size="sm" variant="ghost" className="h-7 w-fit" onClick={onDone}>
        {t('freshDone')}
      </Button>
    </div>
  );
}

function KeyRow({ apiKey }: { apiKey: ApiKeyInfo }) {
  const t = useTranslations('apiKeys');
  const locale = useLocale();
  const confirm = useConfirm();
  const revoke = useRevokeApiKey();
  const state = keyState(apiKey);
  const date = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
      new Date(iso),
    );

  async function handleRevoke() {
    const ok = await confirm({
      title: t('revokeTitle', { name: apiKey.name }),
      description: t('revokeDescription'),
      confirmText: t('revoke'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await revoke.mutateAsync(apiKey.id);
      toast.success(t('revoked'));
    } catch (err) {
      toast.error(t('couldNotRevoke'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  return (
    <li className="flex items-center gap-2 rounded-md border px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={
              state === 'active'
                ? 'truncate text-sm font-medium'
                : 'text-muted-foreground truncate text-sm line-through'
            }
          >
            {apiKey.name}
          </span>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {apiKey.scope === 'full' ? t('scopeFull') : t('scopeRead')}
          </Badge>
          {state !== 'active' && (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {t(`state.${state}`)}
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground truncate font-mono text-[11px]">
          {apiKey.prefix}…
          <span className="font-sans">
            <span className="mx-1.5 opacity-40">·</span>
            {apiKey.lastUsedAt
              ? t('lastUsed', { date: date(apiKey.lastUsedAt) })
              : t('neverUsed')}
            {apiKey.expiresAt && state === 'active' && (
              <>
                <span className="mx-1.5 opacity-40">·</span>
                {t('expiresOn', { date: date(apiKey.expiresAt) })}
              </>
            )}
          </span>
        </p>
      </div>
      {state === 'active' && (
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0"
          aria-label={t('revoke')}
          disabled={revoke.isPending}
          onClick={() => void handleRevoke()}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </li>
  );
}
