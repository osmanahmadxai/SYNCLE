/**
 * Delivery history does not get to grow for ever.
 *
 * Every delivery a bridge makes is recorded — with the payload it sent and the
 * response it got, up to 16 KB each — so the timeline can show exactly what
 * happened. Nothing ever removed those rows. A replay leaves its history
 * behind when it finishes; a live bridge never finishes at all, and one doing a
 * modest ten deliveries a second writes 26 million rows a month. The metadata
 * store filled up, the timeline queries slowed down with it, and the first sign
 * was usually the disk.
 *
 * What is kept is decided by two settings (both editable in the UI):
 *
 *  - `deliveryRetentionDays`  how long a delivery's details are kept
 *  - `deliveryMaxPerJob`      how many a LIVE job keeps, however recent
 *
 * What is never touched:
 *
 *  - the job's own counters — delivered / failed / skipped totals are stored on
 *    the job, so the numbers on screen do not change when details are removed
 *  - a failed delivery whose rows are still waiting in the dead-letter queue:
 *    that row is where a retry reports back to
 *  - a replay job that is still running (its rows are its resume guard)
 *
 * A finished job loses its details all at once, when the JOB is older than the
 * retention — never row by row, which would leave a grid with holes in it. And
 * every job remembers the sequence below which details have been removed
 * (`prunedBelowSequence`), so the timeline can say "delivered, details removed"
 * for those instead of drawing them as still queued.
 */
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { InstanceService } from '../common/instance.service';
import { runtimeConfig } from '../common/runtime-config';
import { SettingsStoreService } from '../settings/settings-store.service';

/** rows removed per statement: small enough not to hold locks for long */
const BATCH = 2_000;
/** rows removed per sweep at most, so one sweep never runs away with the store */
const SWEEP_LIMIT = 500_000;

/** how long after boot the first sweep waits */
const FIRST_SWEEP_MS = 10 * 60_000;

const ACTIVE = ['queued', 'running', 'canceling'];

export interface RetentionResult {
  /** delivery rows removed because they were older than the retention */
  expiredDeliveries: number;
  /** delivery rows removed because a live job held more than its cap */
  overflowDeliveries: number;
  /** resolved / discarded dead letters removed */
  deadLetters: number;
  /** finished replay jobs whose details were removed this sweep */
  jobsEmptied: number;
  /** audit-log entries older than `auditRetentionDays` */
  auditEntries: number;
  /** the sweep stopped at its row limit; the rest goes next time */
  limited: boolean;
}

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Retention');
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<RetentionResult> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsStoreService,
    private readonly instance: InstanceService,
    private readonly audit: AuditService,
  ) {}

  /** on its timer, by the process that leads: one sweep at a time is all the database needs */
  private timed(): void {
    if (this.instance.isLeader()) void this.sweep().catch(() => undefined);
  }

  onModuleInit(): void {
    const minutes = runtimeConfig.retentionSweepMinutes;
    if (minutes <= 0) return;
    // not at boot. the first start after an upgrade is when this removes the
    // most, and whoever runs it gets ten minutes to say "keep everything" first
    this.first = setTimeout(() => this.timed(), FIRST_SWEEP_MS);
    this.first.unref?.();
    this.timer = setInterval(() => this.timed(), minutes * 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  /** one pass. a second caller while one is running gets the same result */
  sweep(now: Date = new Date()): Promise<RetentionResult> {
    this.running ??= this.run(now).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(now: Date): Promise<RetentionResult> {
    const {
      deliveryRetentionDays: days,
      deliveryMaxPerJob: cap,
      auditRetentionDays: auditDays,
    } = await this.settings.resolved();
    const result: RetentionResult = {
      expiredDeliveries: 0,
      overflowDeliveries: 0,
      deadLetters: 0,
      jobsEmptied: 0,
      auditEntries: 0,
      limited: false,
    };
    let budget = SWEEP_LIMIT;
    const spend = (n: number): void => {
      budget -= n;
    };

    if (days > 0) {
      const cutoff = new Date(now.getTime() - days * 86_400_000);
      const emptied = await this.emptyFinishedJobs(cutoff, () => budget, spend);
      result.expiredDeliveries += emptied.rows;
      result.jobsEmptied = emptied.jobs;
      if (budget > 0)
        result.expiredDeliveries += await this.expireLiveDeliveries(
          cutoff,
          () => budget,
          spend,
        );
      if (budget > 0)
        result.deadLetters = await this.expireDeadLetters(
          cutoff,
          () => budget,
          spend,
        );
    }
    if (cap > 0 && budget > 0) {
      result.overflowDeliveries = await this.trimLiveJobs(
        cap,
        () => budget,
        spend,
      );
    }
    if (auditDays > 0 && budget > 0) {
      result.auditEntries = await this.audit.prune(
        new Date(now.getTime() - auditDays * 86_400_000),
        budget,
      );
      spend(result.auditEntries);
    }
    result.limited = budget <= 0;

    const removed =
      result.expiredDeliveries +
      result.overflowDeliveries +
      result.deadLetters +
      result.auditEntries;
    if (removed > 0) {
      this.logger.log(
        `Removed ${result.expiredDeliveries} expired and ${result.overflowDeliveries} overflow deliveries, ` +
          `${result.deadLetters} settled dead letters, ${result.auditEntries} old audit entries` +
          (result.limited
            ? ' (stopped at the per-sweep limit; the rest goes next time)'
            : ''),
      );
    }
    return result;
  }

  /**
   * the jobs that never finish: a watch / CDC bridge has ONE job, reused across
   * every stop and start, so it is that bridge's latest. (older jobs of such a
   * bridge are replays from before it was made live, and are finite.)
   */
  private async liveJobIds(): Promise<string[]> {
    const bridges = await this.prisma.bridge.findMany({
      where: {
        OR: [
          { triggerJson: { contains: '"cdc"' } },
          { triggerJson: { contains: '"watch"' } },
        ],
      },
      select: {
        jobs: { select: { id: true }, orderBy: { startedAt: 'desc' }, take: 1 },
      },
    });
    return bridges.flatMap((b) => b.jobs.map((j) => j.id));
  }

  /**
   * a replay that finished before the cutoff: every detail row goes at once and
   * the job says so. one that is still queued or running is left entirely alone
   */
  private async emptyFinishedJobs(
    cutoff: Date,
    budget: () => number,
    spend: (n: number) => void,
  ): Promise<{ rows: number; jobs: number }> {
    const live = new Set(await this.liveJobIds());
    const candidates = await this.prisma.bridgeJob.findMany({
      where: {
        status: { notIn: ACTIVE },
        finishedAt: { lt: cutoff },
        deliveries: { some: {} },
      },
      select: { id: true },
      orderBy: { finishedAt: 'asc' },
    });
    let rows = 0;
    let jobs = 0;
    for (const job of candidates) {
      if (live.has(job.id)) continue; // handled row by row, below
      if (budget() <= 0) break;
      const removed = await this.deleteWhere(
        { jobId: job.id },
        job.id,
        budget,
        spend,
      );
      rows += removed;
      // a sweep that ran out of budget halfway comes back to this job next time
      const left = await this.prisma.bridgeDelivery.count({
        where: { jobId: job.id },
      });
      if (left === 0) jobs++;
    }
    return { rows, jobs };
  }

  /** a live job's deliveries older than the cutoff */
  private async expireLiveDeliveries(
    cutoff: Date,
    budget: () => number,
    spend: (n: number) => void,
  ): Promise<number> {
    let total = 0;
    for (const jobId of await this.liveJobIds()) {
      if (budget() <= 0) break;
      total += await this.deleteWhere(
        {
          jobId,
          createdAt: { lt: cutoff },
          NOT: { sequence: { in: await this.parkedSequences(jobId) } },
        },
        jobId,
        budget,
        spend,
      );
    }
    return total;
  }

  /** keep the newest `cap` deliveries of each live job */
  private async trimLiveJobs(
    cap: number,
    budget: () => number,
    spend: (n: number) => void,
  ): Promise<number> {
    let total = 0;
    for (const jobId of await this.liveJobIds()) {
      if (budget() <= 0) break;
      const count = await this.prisma.bridgeDelivery.count({
        where: { jobId },
      });
      if (count <= cap) continue;
      // the sequence the newest `cap` rows start at; everything below it goes
      const boundary = await this.prisma.bridgeDelivery.findFirst({
        where: { jobId },
        orderBy: { sequence: 'desc' },
        skip: cap - 1,
        select: { sequence: true },
      });
      if (!boundary) continue;
      total += await this.deleteWhere(
        {
          jobId,
          sequence: { lt: boundary.sequence },
          NOT: { sequence: { in: await this.parkedSequences(jobId) } },
        },
        jobId,
        budget,
        spend,
      );
    }
    return total;
  }

  /** deliveries whose rows still wait in the dead-letter queue: a retry reports back to them */
  private async parkedSequences(jobId: string): Promise<number[]> {
    const parked = await this.prisma.bridgeDeadLetter.findMany({
      where: { jobId, status: 'pending' },
      select: { sequence: true },
      distinct: ['sequence'],
    });
    return parked.map((p) => p.sequence);
  }

  /** dead letters that were retried successfully or discarded: only the record is left */
  private async expireDeadLetters(
    cutoff: Date,
    budget: () => number,
    spend: (n: number) => void,
  ): Promise<number> {
    let total = 0;
    while (budget() > 0) {
      const batch = await this.prisma.bridgeDeadLetter.findMany({
        where: {
          status: { in: ['resolved', 'discarded'] },
          resolvedAt: { lt: cutoff },
        },
        select: { id: true },
        take: Math.min(BATCH, budget()),
      });
      if (batch.length === 0) break;
      const { count } = await this.prisma.bridgeDeadLetter.deleteMany({
        where: { id: { in: batch.map((b) => b.id) } },
      });
      total += count;
      spend(Math.max(count, 1));
      if (batch.length < BATCH) break;
    }
    return total;
  }

  /**
   * delete one job's matching deliveries in batches, oldest first, never past
   * the sweep's budget — and keep the job's record of what is gone up to date
   * after EVERY batch, so a crash halfway leaves the timeline telling the truth
   */
  private async deleteWhere(
    where: Record<string, unknown>,
    jobId: string,
    budget: () => number,
    spend: (n: number) => void,
  ): Promise<number> {
    let total = 0;
    while (budget() > 0) {
      const batch = await this.prisma.bridgeDelivery.findMany({
        where,
        select: { id: true, sequence: true },
        orderBy: { sequence: 'asc' },
        take: Math.min(BATCH, budget()),
      });
      if (batch.length === 0) break;
      const below = batch[batch.length - 1]!.sequence + 1;
      const [{ count }] = await this.prisma.$transaction([
        this.prisma.bridgeDelivery.deleteMany({
          where: { id: { in: batch.map((b) => b.id) } },
        }),
        // GREATEST: the boundary only ever moves up
        this.prisma.$executeRaw`
          UPDATE "bridge_jobs"
          SET "pruned_deliveries" = "pruned_deliveries" + ${batch.length},
              "pruned_below_sequence" = GREATEST(COALESCE("pruned_below_sequence", 0), ${below})
          WHERE "id" = ${jobId}`,
      ]);
      total += count;
      spend(Math.max(count, 1));
      if (batch.length < BATCH) break;
    }
    return total;
  }
}
