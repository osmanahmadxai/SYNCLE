/**
 * what in the workspace needs somebody's attention, and what to do about it.
 *
 * every rule reads only what the page already holds — the bridges, their
 * connections and statuses, and the few per-bridge things the bridge view
 * fetches anyway (dead letters, the latest run, the source hold, schema drift)
 * — and turns a situation into a hint: how serious it is, what it is about,
 * the words to fill in, and where to go to fix it. the words themselves are
 * the components' (they are translated); this decides WHEN to speak.
 *
 * some hints are not about anything broken yet, but about a set-up that WILL
 * break, or surprise, the first time a certain thing happens: a live bridge
 * that inserts every change fails on the first update of a row it already
 * wrote. those are said before it happens, and louder once it has.
 */
import type {
  Bridge,
  BridgeJob,
  BridgeSchemaDrift,
  BridgeSourceHold,
  ConnectionConfig,
  DeadLetterPage,
} from '@syncle/core';
import { causeOf, type ErrorCause } from './error-causes';

export type Severity = 'critical' | 'warning' | 'info';

export type HintRule =
  | 'missing-connection'
  | 'failed'
  | 'dead-letters'
  | 'insert-on-live'
  | 'schema-drift'
  | 'source-hold'
  | 'cdc-from-now'
  | 'redis-cdc'
  | 'abort-on-live'
  | 'http-no-idempotency'
  | 'history-pruned'
  | 'no-connections'
  | 'no-bridges';

/** the guide's sections; a hint points at the one that explains it */
export type GuideSection =
  | 'overview'
  | 'connections'
  | 'first-bridge'
  | 'triggers'
  | 'cdc-setup'
  | 'write-modes'
  | 'columns'
  | 'backfill'
  | 'failures'
  | 'verify'
  | 'schedule'
  | 'schema-changes'
  | 'http'
  | 'monitoring'
  | 'accounts'
  | 'workbench'
  | 'shortcuts'
  | 'troubleshooting';

export type HintAction =
  | { kind: 'open-bridge'; bridgeId: string }
  | { kind: 'edit-bridge'; bridgeId: string }
  | { kind: 'new-bridge' }
  | { kind: 'data-sources' };

export interface Hint {
  /** the rule and what it is about: the same situation is the same id */
  id: string;
  rule: HintRule;
  severity: Severity;
  bridgeId?: string;
  /** the values its words are filled in with */
  values: Record<string, string | number>;
  /** for a failure: what the error most likely means */
  cause?: ErrorCause;
  /** the error itself, as the engine said it */
  detail?: string;
  actions: HintAction[];
  guide: GuideSection;
  /**
   * changes when the situation does. a hint that was dismissed comes back
   * when this changes — more rows set aside, a different error — and not
   * before
   */
  fingerprint: string;
}

export interface DiagnoseInput {
  bridges: Bridge[];
  connections: ConnectionConfig[];
  statuses: Map<string, { active: boolean; lastStatus: string }>;
  /** pending dead letters, for the bridges whose were read */
  deadLetters: Map<string, DeadLetterPage>;
  /** the runs, newest first, for the bridges whose were read */
  jobs: Map<string, BridgeJob[]>;
  sourceHolds: Map<string, BridgeSourceHold | null>;
  drift: Map<string, BridgeSchemaDrift>;
  /** false while the lists are still loading: nothing is "missing" yet */
  loaded: boolean;
}

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

const isLive = (b: Bridge) =>
  b.trigger.kind === 'cdc' || b.trigger.kind === 'watch';

/**
 * a live bridge that will see the SAME row again: CDC carrying updates, or a
 * watch on a timestamp (an updated row moves past the cursor again). an
 * increment or key-diff watch only ever sees new rows
 */
function seesRowsAgain(b: Bridge): boolean {
  if (b.trigger.kind === 'cdc')
    return (b.trigger.operations ?? ['update']).includes('update');
  if (b.trigger.kind === 'watch')
    return b.trigger.strategy.strategy === 'timestamp';
  return false;
}

const qualified = (schema: string | undefined, table: string) =>
  schema ? `${schema}.${table}` : table;

export function diagnose(input: DiagnoseInput): Hint[] {
  const hints: Hint[] = [];
  const byId = new Map(input.connections.map((c) => [c.id, c]));

  if (input.loaded && input.connections.length === 0) {
    hints.push({
      id: 'no-connections',
      rule: 'no-connections',
      severity: 'info',
      values: {},
      actions: [{ kind: 'data-sources' }],
      guide: 'connections',
      fingerprint: '',
    });
  } else if (input.loaded && input.bridges.length === 0) {
    hints.push({
      id: 'no-bridges',
      rule: 'no-bridges',
      severity: 'info',
      values: {},
      actions: [{ kind: 'new-bridge' }],
      guide: 'first-bridge',
      fingerprint: '',
    });
  }

  for (const b of input.bridges) {
    const name = b.name;
    const open = { kind: 'open-bridge', bridgeId: b.id } as const;
    const edit = { kind: 'edit-bridge', bridgeId: b.id } as const;
    const status = input.statuses.get(b.id);
    const pending = input.deadLetters.get(b.id);
    const latest = input.jobs.get(b.id)?.[0];
    const targets =
      b.destination.kind === 'database' ? b.destination.targets : [];

    // ---- a connection the bridge needs is gone -----------------------------
    if (input.loaded) {
      const ids = [
        b.source.connectionId,
        ...targets.map((t) => t.connectionId),
      ];
      const gone = ids.filter((id) => !byId.has(id));
      if (gone.length > 0) {
        hints.push({
          id: `missing-connection:${b.id}`,
          rule: 'missing-connection',
          severity: 'critical',
          bridgeId: b.id,
          values: { bridge: name, count: gone.length },
          actions: [edit, { kind: 'data-sources' }],
          guide: 'connections',
          fingerprint: gone.join(','),
        });
      }
    }

    // ---- what has already gone wrong ---------------------------------------
    const failedError =
      status?.lastStatus === 'failed' ? (latest?.error ?? null) : null;
    const deadError =
      pending && pending.pendingEntries > 0
        ? (pending.items[0]?.error ?? null)
        : null;
    const causes = [causeOf(failedError), causeOf(deadError)];

    if (b.enabled && status?.lastStatus === 'failed') {
      const cause = causeOf(failedError);
      hints.push({
        id: `failed:${b.id}`,
        rule: 'failed',
        severity: 'critical',
        bridgeId: b.id,
        values: { bridge: name },
        cause,
        detail: failedError ?? undefined,
        actions:
          cause === 'duplicate-key' || cause === 'missing-column'
            ? [edit, open]
            : [open, edit],
        guide: guideFor(cause),
        fingerprint: `${latest?.id ?? ''}:${cause}`,
      });
    }

    if (pending && pending.pendingEntries > 0) {
      const cause = causeOf(deadError);
      hints.push({
        id: `dead-letters:${b.id}`,
        rule: 'dead-letters',
        severity: 'critical',
        bridgeId: b.id,
        values: { bridge: name, count: pending.pendingRows },
        cause,
        detail: deadError ?? undefined,
        actions: [open, edit],
        guide: 'failures',
        fingerprint: `${pending.pendingEntries}:${cause}`,
      });
    }

    // ---- a set-up that will fail the first time a row changes --------------
    if (isLive(b) && seesRowsAgain(b)) {
      for (const t of targets) {
        if (t.writeMode !== 'insert' || t.redis) continue;
        const already = causes.includes('duplicate-key');
        hints.push({
          id: `insert-on-live:${b.id}:${t.connectionId}:${t.table}`,
          rule: 'insert-on-live',
          // said before it happens; loud once it has
          severity: already ? 'critical' : 'warning',
          bridgeId: b.id,
          values: {
            bridge: name,
            table: qualified(t.schema, t.table),
            keys: (t.keyColumns ?? []).join(', ') || 'id',
          },
          actions: [edit],
          guide: 'write-modes',
          fingerprint: already ? 'happened' : 'set-up',
        });
      }
    }

    // ---- the source changed under the bridge -------------------------------
    const drift = input.drift.get(b.id);
    if (drift?.drift && b.enabled) {
      const breaking = drift.missingUsed.length > 0;
      hints.push({
        id: `schema-drift:${b.id}`,
        rule: 'schema-drift',
        severity: breaking ? 'critical' : 'info',
        bridgeId: b.id,
        values: {
          bridge: name,
          columns: drift.missingUsed.join(', '),
          breaking: breaking ? 'yes' : 'no',
        },
        actions: breaking ? [edit, open] : [open],
        guide: 'schema-changes',
        fingerprint: `${drift.checkedAt.slice(0, 10)}:${drift.missingUsed.join(',')}`,
      });
    }

    // ---- what a CDC bridge is holding on its source ------------------------
    const hold = input.sourceHolds.get(b.id);
    if (hold && hold.level !== 'ok') {
      hints.push({
        id: `source-hold:${b.id}`,
        rule: 'source-hold',
        severity: hold.level === 'critical' ? 'critical' : 'warning',
        bridgeId: b.id,
        values: {
          bridge: name,
          size: formatBytes(hold.retainedBytes ?? 0),
          running: hold.running ? 'yes' : 'no',
        },
        detail: hold.message ?? undefined,
        actions: [open],
        guide: 'cdc-setup',
        fingerprint: hold.level,
      });
    }

    // ---- things worth knowing about how it is set up -----------------------
    if (b.trigger.kind === 'cdc') {
      const source = byId.get(b.source.connectionId);
      if (source?.engine === 'redis') {
        hints.push({
          id: `redis-cdc:${b.id}`,
          rule: 'redis-cdc',
          severity: 'info',
          bridgeId: b.id,
          values: { bridge: name },
          actions: [edit],
          guide: 'triggers',
          fingerprint: '',
        });
      } else if (
        (b.trigger.startFrom ?? 'now') === 'now' &&
        b.destination.kind === 'database'
      ) {
        hints.push({
          id: `cdc-from-now:${b.id}`,
          rule: 'cdc-from-now',
          severity: 'info',
          bridgeId: b.id,
          values: { bridge: name },
          actions: [open],
          guide: 'backfill',
          fingerprint: '',
        });
      }
    }

    if (isLive(b) && b.enabled && (b.delivery.onError ?? 'abort') === 'abort') {
      hints.push({
        id: `abort-on-live:${b.id}`,
        rule: 'abort-on-live',
        severity: 'info',
        bridgeId: b.id,
        values: { bridge: name },
        actions: [edit],
        guide: 'failures',
        fingerprint: '',
      });
    }

    if (
      b.destination.kind === 'http' &&
      !b.destination.idempotency &&
      (b.delivery.maxAttempts ?? 3) > 1
    ) {
      hints.push({
        id: `http-no-idempotency:${b.id}`,
        rule: 'http-no-idempotency',
        severity: 'info',
        bridgeId: b.id,
        values: { bridge: name },
        actions: [edit],
        guide: 'http',
        fingerprint: '',
      });
    }

    if (latest && latest.prunedDeliveries > 0) {
      hints.push({
        id: `history-pruned:${b.id}:${latest.id}`,
        rule: 'history-pruned',
        severity: 'info',
        bridgeId: b.id,
        values: { bridge: name, count: latest.prunedDeliveries },
        actions: [open],
        guide: 'monitoring',
        fingerprint: '',
      });
    }
  }

  return hints.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/** the guide section that explains a failure best */
function guideFor(cause: ErrorCause): GuideSection {
  switch (cause) {
    case 'duplicate-key':
      return 'write-modes';
    case 'schema-changed':
    case 'missing-column':
      return 'schema-changes';
    case 'cdc-not-enabled':
    case 'slots-exhausted':
      return 'cdc-setup';
    case 'transform-failed':
    case 'bad-value':
    case 'not-null':
      return 'columns';
    case 'auth-failed':
    case 'permission-denied':
    case 'tls':
    case 'host-not-found':
    case 'connection-refused':
    case 'timeout':
      return 'connections';
    case 'http-auth':
    case 'http-not-found':
    case 'http-rate-limited':
    case 'http-client-error':
    case 'http-server-error':
      return 'http';
    default:
      return 'troubleshooting';
  }
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** the most serious severity among hints, or null when there are none */
export function topSeverity(hints: Hint[]): Severity | null {
  return hints.reduce<Severity | null>(
    (top, h) =>
      top === null || RANK[h.severity] < RANK[top] ? h.severity : top,
    null,
  );
}
