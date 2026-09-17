/**
 * what Syncle is doing, as numbers a monitoring system can scrape.
 *
 * Everything here is read from the metadata store at scrape time, with
 * aggregates over small tables (bridges, jobs) or indexed columns — never a
 * scan of the delivery log. Counters that live in the job rows survive a
 * restart; the process gauges are this process's own.
 */
import { Injectable } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { PrismaService } from '../common/prisma.service';
import { resolveVersion } from '../common/version';
import { renderMetrics, type Metric, type Sample } from './prometheus';
import { RedisProbeService } from './redis-probe.service';

/** gauges other parts of the app keep up to date (the source guard's measurements) */
type Pushed = { help: string; samples: Map<string, Sample> };

@Injectable()
export class MetricsService {
  private readonly pushed = new Map<string, Pushed>();
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  private readonly version = resolveVersion().version;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisProbeService,
  ) {
    this.loop.enable();
  }

  /** set (or, with `value: null`, withdraw) one sample of a gauge owned by the caller */
  setGauge(
    name: string,
    help: string,
    labels: Record<string, string>,
    value: number | null,
  ): void {
    let metric = this.pushed.get(name);
    if (!metric) {
      metric = { help, samples: new Map() };
      this.pushed.set(name, metric);
    }
    const key = JSON.stringify(labels);
    if (value === null) metric.samples.delete(key);
    else metric.samples.set(key, { labels, value });
  }

  async render(): Promise<string> {
    const metrics: Metric[] = [
      {
        name: 'syncle_build_info',
        help: 'The running version, as a label.',
        type: 'gauge',
        samples: [{ labels: { version: this.version }, value: 1 }],
      },
    ];

    const redisDown = await this.redis.check();
    let databaseUp = 1;
    try {
      metrics.push(...(await this.fromStore()));
    } catch {
      // the store is down: say so, and still answer with what is known
      databaseUp = 0;
    }
    metrics.push({
      name: 'syncle_up',
      help: '1 when the component answers: the metadata store, and the Redis the job queue runs on.',
      type: 'gauge',
      samples: [
        { labels: { component: 'database' }, value: databaseUp },
        { labels: { component: 'redis' }, value: redisDown === null ? 1 : 0 },
      ],
    });

    for (const [name, m] of this.pushed) {
      metrics.push({
        name,
        help: m.help,
        type: 'gauge',
        samples: [...m.samples.values()],
      });
    }

    const mem = process.memoryUsage();
    metrics.push(
      {
        name: 'process_resident_memory_bytes',
        help: 'Resident memory of the API process.',
        type: 'gauge',
        samples: [{ value: mem.rss }],
      },
      {
        name: 'nodejs_heap_size_used_bytes',
        help: 'V8 heap in use.',
        type: 'gauge',
        samples: [{ value: mem.heapUsed }],
      },
      {
        name: 'process_uptime_seconds',
        help: 'Seconds since the API process started.',
        type: 'gauge',
        samples: [{ value: Math.round(process.uptime()) }],
      },
      {
        name: 'nodejs_eventloop_lag_p99_seconds',
        help: '99th percentile event-loop delay since the last scrape.',
        type: 'gauge',
        samples: [
          {
            value: Number.isFinite(this.loop.percentile(99))
              ? this.loop.percentile(99) / 1e9
              : 0,
          },
        ],
      },
    );
    this.loop.reset();
    return renderMetrics(metrics);
  }

  private async fromStore(): Promise<Metric[]> {
    const [bridges, jobs, totals, deadLetters] = await Promise.all([
      this.prisma.bridge.findMany({
        select: { id: true, name: true, enabled: true, triggerJson: true },
      }),
      this.prisma.bridgeJob.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.bridgeJob.aggregate({
        _sum: { sentCount: true, failedCount: true, skippedCount: true },
      }),
      this.prisma.bridgeDeadLetter.groupBy({
        by: ['bridgeId'],
        where: { status: 'pending' },
        _count: { _all: true },
        _sum: { rowCount: true },
      }),
    ]);

    const names = new Map(bridges.map((b) => [b.id, b.name]));
    const byKind = new Map<string, number>();
    for (const b of bridges) {
      let trigger = 'replay';
      try {
        trigger = b.triggerJson
          ? ((JSON.parse(b.triggerJson) as { kind?: string }).kind ?? 'replay')
          : 'replay';
      } catch {
        /* counted as a replay bridge */
      }
      const key = `${trigger}|${b.enabled}`;
      byKind.set(key, (byKind.get(key) ?? 0) + 1);
    }

    return [
      {
        name: 'syncle_bridges',
        help: 'Bridges, by trigger and whether they are enabled.',
        type: 'gauge',
        samples: [...byKind].map(([key, value]) => {
          const [trigger, enabled] = key.split('|');
          return { labels: { trigger: trigger!, enabled: enabled! }, value };
        }),
      },
      {
        name: 'syncle_jobs',
        help: 'Jobs, by status. A live bridge has one long-running job.',
        type: 'gauge',
        samples: jobs.map((j) => ({
          labels: { status: j.status },
          value: j._count._all,
        })),
      },
      {
        name: 'syncle_deliveries_total',
        help: 'Deliveries recorded by all jobs that still exist, by outcome.',
        type: 'counter',
        samples: [
          { labels: { status: 'success' }, value: totals._sum.sentCount ?? 0 },
          { labels: { status: 'failed' }, value: totals._sum.failedCount ?? 0 },
          {
            labels: { status: 'skipped' },
            value: totals._sum.skippedCount ?? 0,
          },
        ],
      },
      {
        name: 'syncle_dead_letter_rows',
        help: 'Rows waiting in a bridge’s dead-letter queue for someone to retry or discard them.',
        type: 'gauge',
        samples: deadLetters.map((d) => ({
          labels: {
            bridge_id: d.bridgeId,
            bridge: names.get(d.bridgeId) ?? '',
          },
          value: d._sum.rowCount ?? 0,
        })),
      },
    ];
  }
}
