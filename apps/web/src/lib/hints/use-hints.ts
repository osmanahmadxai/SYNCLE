/**
 * the workspace's hints, kept current.
 *
 * what `diagnose` needs beyond the bridge list is read per bridge, and only
 * where it can matter: dead letters of the bridges that set rows aside, the
 * runs of a bridge that failed (and of the one on screen), the source hold of
 * CDC bridges, and schema drift where a bridge failed or is open. each is read
 * under the SAME query key the bridge view uses, so it is one cache — what the
 * page shows and what the bulb says cannot disagree, and a live event that
 * refreshes one refreshes both.
 */
import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type {
  BridgeJob,
  BridgeSchemaDrift,
  BridgeSourceHold,
  DeadLetterPage,
} from '@syncle/core';
import { api } from '@/lib/api';
import { pollEvery } from '@/lib/live-events';
import {
  queryKeys,
  useBridges,
  useBridgeStatuses,
  useConnections,
} from '@/lib/queries';
import { useStudio } from '@/lib/store';
import { diagnose, type Hint } from './diagnose';

/** engines whose CDC holds something on the source that can grow */
const HOLDING = new Set(['postgres', 'mysql']);

export function useHints(): { hints: Hint[]; loaded: boolean } {
  const bridgesQ = useBridges();
  const connectionsQ = useConnections();
  const { data: statusList } = useBridgeStatuses();
  const selectedBridgeId = useStudio((s) => s.selectedBridgeId);

  const bridges = useMemo(() => bridgesQ.data ?? [], [bridgesQ.data]);
  const connections = useMemo(
    () => connectionsQ.data ?? [],
    [connectionsQ.data],
  );
  const statuses = useMemo(
    () => new Map((statusList ?? []).map((s) => [s.bridgeId, s])),
    [statusList],
  );
  const engineOf = useMemo(
    () => new Map(connections.map((c) => [c.id, c.engine])),
    [connections],
  );

  const failed = bridges.filter(
    (b) => statuses.get(b.id)?.lastStatus === 'failed',
  );
  const watched = new Set([
    ...failed.map((b) => b.id),
    ...(selectedBridgeId ? [selectedBridgeId] : []),
  ]);
  const ofIds = (ids: Iterable<string>) =>
    bridges.filter((b) => [...ids].includes(b.id));

  const settingAside = bridges.filter(
    (b) => (b.delivery.onError ?? 'abort') === 'continue',
  );
  const cdcHolding = bridges.filter(
    (b) =>
      b.trigger.kind === 'cdc' &&
      HOLDING.has(engineOf.get(b.source.connectionId) ?? ''),
  );

  const deadQ = useQueries({
    queries: settingAside.map((b) => ({
      queryKey: queryKeys.deadLetters(b.id),
      queryFn: () =>
        api.listDeadLetters(b.id, { status: 'pending', limit: 100 }),
      refetchInterval: () => pollEvery(30_000),
    })),
  });
  const jobsQ = useQueries({
    queries: ofIds(watched).map((b) => ({
      queryKey: queryKeys.bridgeJobs(b.id),
      queryFn: () => api.listBridgeJobs(b.id),
    })),
  });
  const holdQ = useQueries({
    queries: cdcHolding.map((b) => ({
      queryKey: queryKeys.sourceHold(b.id),
      queryFn: () => api.sourceHold(b.id),
      refetchInterval: 60_000,
      retry: false,
    })),
  });
  const driftQ = useQueries({
    queries: ofIds(watched)
      .filter((b) => b.source.kind === 'table')
      .map((b) => ({
        queryKey: queryKeys.schemaDrift(b.id),
        queryFn: () => api.schemaDrift(b.id),
        refetchInterval: 60_000,
        retry: false,
      })),
  });

  const loaded = bridgesQ.isSuccess && connectionsQ.isSuccess;
  const pick = <T>(ids: string[], data: (T | undefined)[]) => {
    const out = new Map<string, T>();
    ids.forEach((id, i) => {
      const d = data[i];
      if (d !== undefined) out.set(id, d);
    });
    return out;
  };
  const watchedIds = ofIds(watched).map((b) => b.id);

  // cheap (a pass over the bridges): worked out afresh each render, from what
  // the queries hold now
  const hints = diagnose({
    bridges,
    connections,
    statuses,
    deadLetters: pick<DeadLetterPage>(
      settingAside.map((b) => b.id),
      deadQ.map((q) => q.data),
    ),
    jobs: pick<BridgeJob[]>(
      watchedIds,
      jobsQ.map((q) => q.data),
    ),
    sourceHolds: pick<BridgeSourceHold | null>(
      cdcHolding.map((b) => b.id),
      holdQ.map((q) => q.data),
    ),
    drift: pick<BridgeSchemaDrift>(
      ofIds(watched)
        .filter((b) => b.source.kind === 'table')
        .map((b) => b.id),
      driftQ.map((q) => q.data),
    ),
    loaded,
  });

  return { hints, loaded };
}
