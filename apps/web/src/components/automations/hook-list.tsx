'use client';

import { Plus, Radio, Zap, Network, Workflow, AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { destinationLabel, type Hook } from '@syncle/core';
import { useHooks, useHookStatuses } from '@/lib/queries';
import { useStudio } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

function sourceLabel(hook: Hook, customQuery: string): string {
  return hook.source.kind === 'table' ? hook.source.table : customQuery;
}

function destLabel(hook: Hook): string {
  return destinationLabel(hook.destination);
}

type RunState = 'live' | 'failed' | 'idle' | 'off';

/**
 * the badge reflects what the bridge is doing right now, not just its type:
 * live = actually listening/running, failed = last run failed, idle = enabled
 * but not running, off = disabled. The label is a message key resolved by the
 * caller (module-level helpers can't use the translation hook).
 */
function badge(
  hook: Hook,
  status: { active: boolean; lastStatus: string } | undefined,
): { state: RunState; labelKey: string } {
  if (!hook.enabled) return { state: 'off', labelKey: 'badgeOff' };
  if (status?.active) return { state: 'live', labelKey: 'badgeLive' };
  if (status?.lastStatus === 'failed')
    return { state: 'failed', labelKey: 'badgeFailed' };
  // not running: show what it is, not a fake "live"
  return hook.trigger.kind === 'replay'
    ? { state: 'idle', labelKey: 'badgeOnDemand' }
    : { state: 'idle', labelKey: 'badgeIdle' };
}

const DOT: Record<RunState, string> = {
  live: 'bg-emerald-500',
  failed: 'bg-red-500',
  idle: 'bg-muted-foreground/40',
  off: 'bg-muted-foreground/25',
};

export function HookList() {
  const t = useTranslations('hookList');
  const tc = useTranslations('common');
  const { selectedHookId, selectHook, openHookEditor } = useStudio();
  const { data: hooks, isLoading } = useHooks();
  const { data: statuses } = useHookStatuses();

  const bridges = hooks ?? [];
  const statusById = new Map((statuses ?? []).map((s) => [s.hookId, s]));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <button
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide transition-colors"
          title={t('viewMap')}
          onClick={() => selectHook(null)}
        >
          <Network className="h-3.5 w-3.5" />
          {t('map')}
        </button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => openHookEditor()}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('newBridge')}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2 pb-2">
        {isLoading && (
          <p className="text-muted-foreground px-2 py-3 text-sm">{tc('loading')}</p>
        )}
        {!isLoading && bridges.length === 0 && (
          <div className="text-muted-foreground px-2 py-6 text-center text-sm">
            <Workflow className="mx-auto mb-2 h-6 w-6 opacity-50" />
            {t('noBridges')}
            <button
              className="text-primary mt-1 block w-full hover:underline"
              onClick={() => openHookEditor()}
            >
              {t('createFirst')}
            </button>
          </div>
        )}
        <div className="flex flex-col gap-0.5">
          {bridges.map((hook) => {
            const b = badge(hook, statusById.get(hook.id));
            const Icon =
              b.state === 'failed'
                ? AlertTriangle
                : hook.trigger.kind === 'replay'
                  ? Zap
                  : Radio;
            return (
              <button
                key={hook.id}
                onClick={() => selectHook(hook.id)}
                className={cn(
                  'flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors',
                  selectedHookId === hook.id ? 'bg-accent' : 'hover:bg-accent/50',
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      DOT[b.state],
                      b.state === 'live' && 'animate-pulse',
                    )}
                  />
                  <span className="truncate text-sm font-medium">{hook.name}</span>
                  <span
                    className={cn(
                      'ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
                      b.state === 'live' &&
                        'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
                      b.state === 'failed' &&
                        'bg-red-500/10 text-red-600 dark:text-red-400',
                      (b.state === 'idle' || b.state === 'off') &&
                        'bg-muted text-muted-foreground',
                    )}
                  >
                    <Icon className="h-3 w-3" />
                    {t(b.labelKey)}
                  </span>
                </div>
                <span className="text-muted-foreground truncate pl-3 font-mono text-xs">
                  {sourceLabel(hook, t('customQuery'))} → {destLabel(hook)}
                </span>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
