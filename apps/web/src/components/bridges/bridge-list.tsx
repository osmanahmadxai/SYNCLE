'use client';

import { useState } from 'react';
import { Plus, Radio, Zap, Network, Workflow, AlertTriangle, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ImportBridgesButton } from './import-bridges';
import { BulkBridgesButton } from './bulk-bridges';
import { destinationLabel, type Bridge, type ConnectionConfig } from '@syncle/core';
import { useBridges, useBridgeStatuses, useConnections } from '@/lib/queries';
import { summarizeBridge, type EndpointSummary } from '@/lib/bridge-summary';
import { useStudio } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { BridgeDetails, EndpointLine } from './bridge-details';

function destLabel(bridge: Bridge): string {
  return destinationLabel(bridge.destination);
}

export type BridgeState = 'live' | 'failed' | 'idle' | 'off';
export type BridgeStatus = { active: boolean; lastStatus: string };

/**
 * the badge reflects what the bridge is doing right now, not just its type:
 * live = actually listening/running, failed = last run failed, idle = enabled
 * but not running, off = disabled. The label is a message key resolved by the
 * caller (module-level helpers can't use the translation bridge).
 */
export function badge(
  bridge: Bridge,
  status: BridgeStatus | undefined,
): { state: BridgeState; labelKey: string } {
  if (!bridge.enabled) return { state: 'off', labelKey: 'badgeOff' };
  if (status?.active) return { state: 'live', labelKey: 'badgeLive' };
  if (status?.lastStatus === 'failed')
    return { state: 'failed', labelKey: 'badgeFailed' };
  // not running: show what it is, not a fake "live"
  return bridge.trigger.kind === 'replay'
    ? { state: 'idle', labelKey: 'badgeOnDemand' }
    : { state: 'idle', labelKey: 'badgeIdle' };
}

const DOT: Record<BridgeState, string> = {
  live: 'bg-emerald-500',
  failed: 'bg-red-500',
  idle: 'bg-muted-foreground/40',
  off: 'bg-muted-foreground/25',
};

export type StateFilter = 'all' | BridgeState;

const FILTERS: { value: StateFilter; labelKey: string }[] = [
  { value: 'all', labelKey: 'filterAll' },
  { value: 'live', labelKey: 'badgeLive' },
  { value: 'failed', labelKey: 'badgeFailed' },
  { value: 'idle', labelKey: 'badgeIdle' },
  { value: 'off', labelKey: 'badgeOff' },
];

const endText = (end: EndpointSummary) =>
  [end.table, end.connectionName, end.address, end.via, end.database];

/**
 * what a search is matched against: the name, and both ends — table,
 * connection, host and database — for every place the rows go, not just the
 * first one the row shows
 */
function searchText(bridge: Bridge, connections: ConnectionConfig[]): string {
  const summary = summarizeBridge(bridge, connections);
  return [
    bridge.name,
    destLabel(bridge),
    ...endText(summary.source),
    ...summary.targets.flatMap(endText),
    bridge.destination.kind === 'http' ? bridge.destination.url : null,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

/**
 * the bridges a search and a state filter leave, and how many bridges are in
 * each state — counted over the search, so a chip says what clicking it shows
 */
export function filterBridges(
  bridges: Bridge[],
  statusById: Map<string, BridgeStatus>,
  query: string,
  filter: StateFilter,
  connections: ConnectionConfig[] = [],
): { visible: Bridge[]; counts: Record<StateFilter, number> } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const counts: Record<StateFilter, number> = { all: 0, live: 0, failed: 0, idle: 0, off: 0 };
  const visible: Bridge[] = [];
  for (const bridge of bridges) {
    const text = searchText(bridge, connections);
    if (!words.every((w) => text.includes(w))) continue;
    const { state } = badge(bridge, statusById.get(bridge.id));
    counts.all++;
    counts[state]++;
    if (filter === 'all' || filter === state) visible.push(bridge);
  }
  return { visible, counts };
}

export function BridgeList() {
  const t = useTranslations('bridgeList');
  const tc = useTranslations('common');
  const { selectedBridgeId, selectBridge, openBridgeEditor } = useStudio();
  const { data, isLoading } = useBridges();
  const { data: statuses } = useBridgeStatuses();
  const { data: connections } = useConnections();

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StateFilter>('all');

  const bridges = data ?? [];
  const statusById = new Map((statuses ?? []).map((s) => [s.bridgeId, s]));
  const { visible, counts } = filterBridges(
    bridges,
    statusById,
    query,
    filter,
    connections ?? [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <button
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide transition-colors"
          title={t('viewMap')}
          onClick={() => selectBridge(null)}
        >
          <Network className="h-3.5 w-3.5" />
          {t('map')}
        </button>
        <div className="flex items-center">
          <BulkBridgesButton />
          <ImportBridgesButton />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => openBridgeEditor()}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('newBridge')}
          </Button>
        </div>
      </div>

      {/* only once there is something to narrow down */}
      {bridges.length > 0 && (
        <div className="flex flex-col gap-1.5 px-3 pb-2">
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchPlaceholder')}
              className="h-7 pl-7 text-xs"
            />
          </div>
          <div className="bg-muted flex flex-wrap items-center gap-0.5 rounded-md p-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                aria-pressed={filter === f.value}
                className={cn(
                  'flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors',
                  filter === f.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                  f.value === 'failed' &&
                    counts.failed > 0 &&
                    'text-red-600 dark:text-red-400',
                )}
              >
                {t(f.labelKey)}
                <span className="tabular-nums opacity-70">{counts[f.value]}</span>
              </button>
            ))}
          </div>
        </div>
      )}

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
              onClick={() => openBridgeEditor()}
            >
              {t('createFirst')}
            </button>
          </div>
        )}
        {bridges.length > 0 && visible.length === 0 && (
          <div className="text-muted-foreground px-2 py-6 text-center text-sm">
            {t('noMatches')}
            <button
              className="text-primary mt-1 block w-full hover:underline"
              onClick={() => {
                setQuery('');
                setFilter('all');
              }}
            >
              {t('clearFilters')}
            </button>
          </div>
        )}
        <div className="flex flex-col gap-0.5">
          {visible.map((bridge) => {
            const b = badge(bridge, statusById.get(bridge.id));
            const Icon =
              b.state === 'failed'
                ? AlertTriangle
                : bridge.trigger.kind === 'replay'
                  ? Zap
                  : Radio;
            const summary = summarizeBridge(bridge, connections ?? []);
            const [firstTarget, ...moreTargets] = summary.targets;
            return (
              <Tooltip key={bridge.id}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => selectBridge(bridge.id)}
                    className={cn(
                      'flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors',
                      selectedBridgeId === bridge.id ? 'bg-accent' : 'hover:bg-accent/50',
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
                      <span className="truncate text-sm font-medium">{bridge.name}</span>
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
                    <EndpointLine end={summary.source} className="pl-3 text-[11px]" />
                    <span className="text-muted-foreground flex min-w-0 items-center gap-1 pl-3 text-[11px]">
                      <span className="shrink-0">→</span>
                      {firstTarget ? (
                        <>
                          <EndpointLine end={firstTarget} className="flex-1" />
                          {moreTargets.length > 0 && (
                            <span className="shrink-0 font-mono">+{moreTargets.length}</span>
                          )}
                        </>
                      ) : (
                        <span className="truncate font-mono">{destLabel(bridge)}</span>
                      )}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  side="right"
                  align="start"
                  className="bg-popover text-popover-foreground border p-3 shadow-md"
                >
                  <BridgeDetails bridge={bridge} summary={summary} />
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
