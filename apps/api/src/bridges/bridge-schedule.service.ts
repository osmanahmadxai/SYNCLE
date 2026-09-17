/**
 * replays that run by themselves: a replay bridge with a cron line gets a
 * BullMQ job scheduler, and every tick of it starts a FRESH run of the bridge.
 *
 * The scheduler lives in Redis, so it survives restarts and — with several API
 * processes on one Redis — fires once, not once per process. What this service
 * owns is keeping the schedulers in Redis equal to the bridges in the database:
 * on save, on delete, and at boot (a bridge deleted while Redis was away, a
 * Redis that was flushed).
 *
 * Two rules a tick keeps:
 *  - it never starts a run while one is going. a nightly run that takes 25 hours
 *    is not joined by a second one; the tick is recorded as skipped, and said
 *  - it starts from the top. `start()` on a bridge whose last run stopped
 *    half-way picks that run up again, which is right for a person pressing Run
 *    and wrong for "the whole table, every night"
 */
import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { parseExpression } from 'cron-parser';
import {
  BadRequestError,
  type Bridge,
  type BridgeScheduleStatus,
  type ReplaySchedule,
} from '@syncle/core';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../common/prisma.service';
import { BridgeJobService } from './bridge-job.service';
import { BridgeStoreService } from './bridge-store.service';
import {
  BRIDGE_SCHEDULE_QUEUE,
  type BridgeSchedulePayload,
} from './bridges.types';

const ACTIVE = ['queued', 'running', 'canceling'];
// no colon: BullMQ reads an id with colons in it as one of its old repeat keys
// (`name:id:endDate:tz:pattern`), and `getJobScheduler` then answers with a
// ghost for a scheduler that does not exist
const PREFIX = 'schedule_';

interface TickState {
  at: string;
  outcome: 'started' | 'skipped-active' | 'failed';
  error: string | null;
}

/** the schedule of a bridge, if it has one at all (on or off) */
export function scheduleOf(
  bridge: Pick<Bridge, 'trigger'>,
): ReplaySchedule | null {
  return bridge.trigger.kind === 'replay'
    ? (bridge.trigger.schedule ?? null)
    : null;
}

/** …and only if it should be firing */
export function wantsScheduler(
  bridge: Pick<Bridge, 'trigger' | 'enabled'>,
): ReplaySchedule | null {
  const schedule = scheduleOf(bridge);
  return schedule && schedule.enabled && bridge.enabled ? schedule : null;
}

/**
 * the next times a line fires, by the library that fires it. throws a
 * BadRequestError for a line it will not take — the last word on a schedule,
 * after the shape check every client can do
 */
export function nextRuns(
  schedule: Pick<ReplaySchedule, 'cron' | 'timezone'>,
  count: number,
  from = new Date(),
): string[] {
  try {
    const it = parseExpression(schedule.cron, {
      tz: schedule.timezone,
      currentDate: from,
    });
    const out: string[] = [];
    for (let i = 0; i < count && it.hasNext(); i++)
      out.push(it.next().toDate().toISOString());
    return out;
  } catch (err) {
    throw new BadRequestError(
      `This schedule cannot be used: ${(err as Error).message}`,
      { reason: 'invalid-schedule' },
    );
  }
}

@Injectable()
export class BridgeScheduleService implements OnApplicationBootstrap {
  private readonly logger = new Logger('BridgeSchedule');

  constructor(
    @InjectQueue(BRIDGE_SCHEDULE_QUEUE)
    private readonly queue: Queue<BridgeSchedulePayload>,
    private readonly prisma: PrismaService,
    private readonly store: BridgeStoreService,
    private readonly jobs: BridgeJobService,
    private readonly alerts: AlertsService,
  ) {}

  /** refuse a line the firing library will not take, before it is saved */
  assertUsable(bridge: Pick<Bridge, 'trigger'>): void {
    const schedule = scheduleOf(bridge);
    if (schedule) nextRuns(schedule, 1);
  }

  /** make Redis agree with this bridge: a scheduler if it should fire, none if not */
  async sync(
    bridge: Pick<Bridge, 'id' | 'trigger' | 'enabled'>,
  ): Promise<void> {
    const schedule = wantsScheduler(bridge);
    if (!schedule) {
      await this.remove(bridge.id);
      return;
    }
    await this.queue.upsertJobScheduler(
      PREFIX + bridge.id,
      { pattern: schedule.cron, tz: schedule.timezone },
      {
        name: 'tick',
        data: { bridgeId: bridge.id },
        // a tick is a moment, not a record: what it did is kept with the bridge
        opts: { removeOnComplete: true, removeOnFail: 50, attempts: 1 },
      },
    );
  }

  async remove(bridgeId: string): Promise<void> {
    await this.queue.removeJobScheduler(PREFIX + bridgeId).catch(() => false);
  }

  /**
   * at boot: every bridge that should fire has its scheduler, and no scheduler
   * is left for a bridge that should not — deleted, switched off, or edited
   * while Redis was not there to be told
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.reconcile();
    } catch (err) {
      this.logger.warn(
        `Could not reconcile replay schedules (is Redis up?): ${(err as Error).message}`,
      );
    }
  }

  async reconcile(): Promise<{ scheduled: number; removed: number }> {
    const bridges = await this.store.list();
    const wanted = new Map(
      bridges.filter((b) => wantsScheduler(b)).map((b) => [PREFIX + b.id, b]),
    );
    let removed = 0;
    // (paged: a scheduler is a few hundred bytes, but there is no reason to assume there are few)
    for (let start = 0; ; start += 200) {
      const page = await this.queue.getJobSchedulers(start, start + 199, true);
      for (const scheduler of page) {
        const key = scheduler.key ?? (scheduler as { id?: string }).id;
        if (!key || !key.startsWith(PREFIX) || wanted.has(key)) continue;
        // the list of bridges is a moment old: another API process may have saved
        // this very bridge since. asked again, of the database, before its
        // scheduler is taken for a stale one
        const fresh = await this.store
          .get(key.slice(PREFIX.length))
          .catch(() => null);
        if (fresh && wantsScheduler(fresh)) continue;
        await this.queue.removeJobScheduler(key).catch(() => false);
        removed++;
      }
      if (page.length < 200) break;
    }
    for (const bridge of wanted.values()) await this.sync(bridge);
    if (wanted.size || removed)
      this.logger.log(
        `Replay schedules: ${wanted.size} active, ${removed} stale removed`,
      );
    return { scheduled: wanted.size, removed };
  }

  /** it is time. called by the queue's worker */
  async tick(bridgeId: string): Promise<TickState['outcome'] | 'gone'> {
    const bridge = await this.store.get(bridgeId).catch(() => null);
    if (!bridge || !wantsScheduler(bridge)) {
      // deleted, switched off or no longer a scheduled replay, and Redis was not told
      await this.remove(bridgeId);
      return 'gone';
    }
    const active = await this.prisma.bridgeJob.findFirst({
      where: { bridgeId, status: { in: ACTIVE } },
      select: { id: true },
    });
    if (active) {
      this.logger.warn(
        `Scheduled replay of "${bridge.name}" skipped: the run before it is still going`,
      );
      await this.record(bridgeId, { outcome: 'skipped-active', error: null });
      this.alerts.emit({
        type: 'bridge.failed',
        severity: 'warning',
        title: `Scheduled replay of "${bridge.name}" skipped`,
        message:
          'It was time for the next scheduled run, and the run before it had not finished, so it was not started a second time. ' +
          'If this keeps happening the schedule is tighter than the replay takes.',
        bridgeId,
        bridgeName: bridge.name,
      });
      return 'skipped-active';
    }
    try {
      await this.jobs.start(bridgeId, { fresh: true, startedBy: 'schedule' });
      await this.record(bridgeId, { outcome: 'started', error: null });
      return 'started';
    } catch (err) {
      const error = (err as Error).message;
      this.logger.warn(
        `Scheduled replay of "${bridge.name}" could not be started: ${error}`,
      );
      await this.record(bridgeId, { outcome: 'failed', error });
      this.alerts.emit({
        type: 'bridge.failed',
        severity: 'critical',
        title: `Scheduled replay of "${bridge.name}" could not be started`,
        message: error,
        bridgeId,
        bridgeName: bridge.name,
      });
      return 'failed';
    }
  }

  private async record(
    bridgeId: string,
    state: Omit<TickState, 'at'>,
  ): Promise<void> {
    const json = JSON.stringify({
      at: new Date().toISOString(),
      ...state,
    } satisfies TickState);
    // updateMany: no `updatedAt` bump semantics to worry about, and no throw if the bridge has just gone
    await this.prisma.bridge.updateMany({
      where: { id: bridgeId },
      data: { scheduleStateJson: json },
    });
  }

  /** for the bridge's page */
  async status(bridgeId: string): Promise<BridgeScheduleStatus> {
    const bridge = await this.store.get(bridgeId);
    const schedule = scheduleOf(bridge);
    const row = await this.prisma.bridge.findUnique({
      where: { id: bridgeId },
      select: { scheduleStateJson: true },
    });
    let last: TickState | null = null;
    try {
      last = row?.scheduleStateJson
        ? (JSON.parse(row.scheduleStateJson) as TickState)
        : null;
    } catch {
      last = null;
    }
    const firing = wantsScheduler(bridge);
    let active = false;
    if (firing) {
      active = await this.queue
        .getJobScheduler(PREFIX + bridgeId)
        .then((s) => !!s?.pattern)
        .catch(() => false);
    }
    return {
      schedule,
      active,
      nextRuns: firing ? nextRuns(firing, 3) : [],
      lastTickAt: last?.at ?? null,
      lastOutcome: last?.outcome ?? null,
      lastError: last?.error ?? null,
    };
  }
}
