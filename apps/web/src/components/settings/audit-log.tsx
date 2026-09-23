'use client';

/**
 * Settings › Activity: who did what. every change made through the API, by an
 * account or an API key, and every sign-in — newest first, a page at a time,
 * narrowed by what was done and by whom. an admin's to read.
 */
import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { ChevronDown, Loader2, ScrollText } from 'lucide-react';
import { AUDIT_ACTIONS, type AuditEntry } from '@syncle/core';
import { useAudit } from '@/lib/queries';
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

const PAGE = 50;

/** `bridge.create` as a message key: a dot in a key is a path to next-intl */
export const actionKey = (action: string): string => action.replace(/\./g, '_');

export function AuditLog() {
  const t = useTranslations('audit');
  const [action, setAction] = useState<string>('');
  const [actor, setActor] = useState('');
  const [pages, setPages] = useState<string[]>([]); // the cursors of the pages after the first
  const filter = {
    action: action || undefined,
    actor: actor.trim() || undefined,
  };
  const first = useAudit({ limit: PAGE, ...filter });
  const reset = () => setPages([]);

  return (
    <div className="grid gap-3">
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <ScrollText className="h-3.5 w-3.5" />
          {t('title')}
        </h3>
        <p className="text-muted-foreground text-xs">{t('intro')}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-1">
          <Label className="text-xs">{t('filterAction')}</Label>
          <Select
            value={action || '__all'}
            onValueChange={(v) => {
              setAction(v === '__all' ? '' : v);
              reset();
            }}
          >
            <SelectTrigger className="h-8" aria-label={t('filterAction')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">{t('anyAction')}</SelectItem>
              {AUDIT_ACTIONS.map((a) => (
                <SelectItem key={a} value={a}>
                  {t(`actions.${actionKey(a)}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="audit-actor" className="text-xs">
            {t('filterActor')}
          </Label>
          <Input
            id="audit-actor"
            className="h-8"
            placeholder={t('filterActorPlaceholder')}
            value={actor}
            onChange={(e) => {
              setActor(e.target.value);
              reset();
            }}
          />
        </div>
      </div>
      <Page
        query={{ limit: PAGE, ...filter }}
        onMore={(next) => setPages((p) => [...p, next])}
        first={first}
      />
      {pages.map((cursor, i) => (
        <Page
          key={cursor}
          query={{ limit: PAGE, before: cursor, ...filter }}
          onMore={
            i === pages.length - 1
              ? (next) => setPages((p) => [...p, next])
              : undefined
          }
        />
      ))}
    </div>
  );
}

function Page({
  query,
  onMore,
  first,
}: {
  query: Parameters<typeof useAudit>[0];
  onMore?: (next: string) => void;
  first?: ReturnType<typeof useAudit>;
}) {
  const t = useTranslations('audit');
  const own = useAudit(query, !first);
  const { data, isLoading, isError } = first ?? own;
  if (isLoading)
    return <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />;
  if (isError || !data)
    return <p className="text-destructive text-xs">{t('couldNotLoad')}</p>;
  return (
    <>
      {data.entries.length === 0 && !query.before && (
        <p className="text-muted-foreground text-xs">{t('empty')}</p>
      )}
      <ul className="grid gap-1">
        {data.entries.map((entry) => (
          <Entry key={entry.id} entry={entry} />
        ))}
      </ul>
      {data.next && onMore && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 justify-self-start"
          onClick={() => onMore(data.next!)}
        >
          <ChevronDown className="mr-1 h-3.5 w-3.5" />
          {t('more')}
        </Button>
      )}
    </>
  );
}

export function Entry({ entry }: { entry: AuditEntry }) {
  const t = useTranslations('audit');
  const format = useFormatter();
  const known = (AUDIT_ACTIONS as readonly string[]).includes(entry.action);
  const details = entry.details
    ? Object.entries(entry.details).filter(
        ([, v]) => v !== undefined && v !== null && v !== '',
      )
    : [];
  return (
    <li className="grid gap-0.5 rounded-md border px-2.5 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="text-muted-foreground tabular-nums">
          {format.dateTime(new Date(entry.at), {
            dateStyle: 'medium',
            timeStyle: 'medium',
          })}
        </span>
        <span className="font-medium">{entry.actor.name}</span>
        {entry.actor.type !== 'user' && (
          <Badge variant="outline" className="px-1 py-0 text-[10px]">
            {t(`actorType.${entry.actor.type}`)}
          </Badge>
        )}
        <span>
          {known ? t(`actions.${actionKey(entry.action)}`) : entry.action}
        </span>
        {entry.target && (
          <span className="text-muted-foreground">
            {entry.target.name ?? entry.target.id}
            {entry.target.name && entry.target.id ? (
              <span className="ml-1 font-mono opacity-60">
                {entry.target.id.slice(0, 8)}
              </span>
            ) : null}
          </span>
        )}
        {entry.ip && (
          <span className="text-muted-foreground ml-auto font-mono">
            {entry.ip}
          </span>
        )}
      </div>
      {details.length > 0 && (
        <p className="text-muted-foreground font-mono text-[11px]">
          {details
            .map(
              ([k, v]) =>
                `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`,
            )
            .join('  ')}
        </p>
      )}
    </li>
  );
}
