'use client';

/**
 * a bridge's two ends and what crosses between them, in words: the pieces the
 * bridge list and the workspace map both show. the facts come from
 * `summarizeBridge`; this is only how they read.
 */
import { useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Globe } from 'lucide-react';
import type { Bridge, DatabaseEngine } from '@syncle/core';
import { engineMeta } from '@/lib/engines';
import {
  columnList,
  httpColumns,
  type BridgeSummary,
  type EndpointSummary,
  type StreamedColumns,
  type TargetSummary,
} from '@/lib/bridge-summary';
import { ConnectionBadges } from '@/components/connections/connection-badges';
import { cn } from '@/lib/utils';

/** the engine's two-letter square, as the connection list draws it */
export function EngineChip({
  engine,
  className,
}: {
  engine: DatabaseEngine | null;
  className?: string;
}) {
  if (!engine) return null;
  const meta = engineMeta(engine);
  return (
    <span
      className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[8px] font-bold leading-none',
        meta.className,
        className,
      )}
      title={meta.label}
    >
      {meta.abbr}
    </span>
  );
}

/** the words for how a bridge fires, what a target does with a row, and what crosses */
export function useBridgeWords() {
  const t = useTranslations('bridgeSummary');
  // stable while the language is: the map rebuilds its graph when these change
  return useMemo(() => bridgeWords(t), [t]);
}

function bridgeWords(t: ReturnType<typeof useTranslations<'bridgeSummary'>>) {
  const trigger = (bridge: Bridge): string => {
    const tr = bridge.trigger;
    if (tr.kind === 'replay') {
      return tr.schedule?.enabled
        ? t('scheduled', {
            cron: tr.schedule.cron,
            timezone: tr.schedule.timezone,
          })
        : t('onDemand');
    }
    if (tr.kind === 'watch') {
      const seconds = Number((tr.pollIntervalMs / 1000).toFixed(1));
      return tr.strategy.strategy === 'snapshot'
        ? t('watchSnapshot', { seconds })
        : t('watchColumn', { column: tr.strategy.column, seconds });
    }
    const cdc = t('cdc', { operations: tr.operations.join(', ') });
    return tr.startFrom === 'beginning' ? `${cdc} · ${t('cdcBackfill')}` : cdc;
  };

  const writes = (target: TargetSummary): string => {
    const mode =
      target.writeMode === 'insert'
        ? t('insert')
        : target.keyColumns.length > 0
          ? t('upsertBy', { keys: target.keyColumns.join(', ') })
          : t('upsert');
    if (target.onDelete === 'soft' && target.softDeleteColumn)
      return `${mode} · ${t('deleteSoft', { column: target.softDeleteColumn })}`;
    if (target.onDelete === 'ignore') return `${mode} · ${t('deleteIgnore')}`;
    return mode;
  };

  const columns = (cols: StreamedColumns, shown?: number): string =>
    cols === null
      ? t('allColumns')
      : `${t('columnCount', { count: cols.length })}: ${columnList(cols, shown)}`;

  /** "2 filters · 1 transform", or '' when the rows cross as they are */
  const shaping = (summary: BridgeSummary): string =>
    [
      summary.filterCount > 0 && t('filters', { count: summary.filterCount }),
      summary.transformCount > 0 &&
        t('transforms', { count: summary.transformCount }),
    ]
      .filter(Boolean)
      .join(' · ');

  /** where the database runs — or why that cannot be said */
  const where = (end: EndpointSummary): string => {
    const place = end.address ?? (end.connection ? t('connectionString') : '');
    return [place, end.via && t('via', { host: end.via })]
      .filter(Boolean)
      .join(' ');
  };

  return { t, trigger, writes, columns, shaping, where };
}

/** one end of a bridge on one line: engine, table, connection */
export function EndpointLine({
  end,
  className,
}: {
  end: EndpointSummary;
  className?: string;
}) {
  const { t } = useBridgeWords();
  return (
    <span className={cn('flex min-w-0 items-center gap-1', className)}>
      <EngineChip engine={end.engine} />
      <span className="truncate font-mono">
        {end.table ?? t('customQuery')}
      </span>
      <span className="text-muted-foreground/70 shrink-0">·</span>
      <span className="text-muted-foreground/80 truncate">
        {end.connectionName ?? t('missingConnection')}
      </span>
    </span>
  );
}

/**
 * a database end, in full: the table, then the connection it is reached
 * through and where that runs. the body of a map node and of a list tooltip
 */
export function EndpointBlock({ end }: { end: EndpointSummary }) {
  const { t, where } = useBridgeWords();
  const place = where(end);
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <EngineChip engine={end.engine} />
        <span className="truncate font-mono text-xs font-semibold">
          {end.table ?? t('customQuery')}
        </span>
        <ConnectionBadges connection={end.connection} className="ml-auto" />
      </div>
      <div className="text-muted-foreground mt-0.5 truncate text-[10px]">
        {end.connectionName ?? t('missingConnection')}
        {end.database && <span className="font-mono"> / {end.database}</span>}
      </div>
      {place && (
        <div
          className="text-muted-foreground/80 truncate font-mono text-[10px]"
          title={place}
        >
          {place}
        </div>
      )}
    </div>
  );
}

/** an HTTP destination: method, host, path */
export function HttpBlock({
  http,
}: {
  http: NonNullable<BridgeSummary['http']>;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <Globe className="h-3.5 w-3.5 shrink-0 text-sky-500" />
        <span className="text-[10px] font-bold">{http.method}</span>
        <span className="truncate font-mono text-xs font-semibold">
          {http.host}
        </span>
      </div>
      {http.path && (
        <div
          className="text-muted-foreground truncate font-mono text-[10px]"
          title={http.path}
        >
          {http.path}
        </div>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide">
        {label}
      </div>
      {children}
    </div>
  );
}

/** everything a bridge connects, for a hover card: both ends, how and what */
export function BridgeDetails({
  bridge,
  summary,
}: {
  bridge: Bridge;
  summary: BridgeSummary;
}) {
  const { t, trigger, writes, columns, shaping } = useBridgeWords();
  const shaped = shaping(summary);
  return (
    <div className="w-72 space-y-2.5 text-xs">
      <Section label={t('from')}>
        <EndpointBlock end={summary.source} />
      </Section>
      <Section label={t('to')}>
        {summary.http && (
          <>
            <HttpBlock http={summary.http} />
            <div className="text-muted-foreground text-[10px]">
              {columns(httpColumns(bridge), 8)}
            </div>
          </>
        )}
        {summary.targets.map((target, i) => (
          <div key={i} className="space-y-0.5">
            <EndpointBlock end={target} />
            <div className="text-muted-foreground text-[10px]">
              {writes(target)}
            </div>
            <div className="text-muted-foreground text-[10px]">
              {columns(target.columns, 8)}
            </div>
          </div>
        ))}
      </Section>
      <Section label={t('trigger')}>
        <div>{trigger(bridge)}</div>
        {shaped && (
          <div className="text-muted-foreground text-[10px]">{shaped}</div>
        )}
      </Section>
    </div>
  );
}
