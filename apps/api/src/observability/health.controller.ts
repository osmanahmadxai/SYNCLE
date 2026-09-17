/**
 * probes for containers and monitors. public by design — they leak nothing
 * beyond "is it up", and an orchestrator needs them before anyone can log in.
 *
 *   GET /api/health        is the API alive, and can it reach its metadata
 *                          store? 200, or 503 when the store is unreachable.
 *                          what a container health check should use. it
 *                          REPORTS Redis without failing on it: a live bridge
 *                          delivers without Redis, and restarting the API does
 *                          not bring Redis back
 *   GET /api/health/ready  can it do everything? 503 unless the store AND
 *                          Redis answer (replays, polling bridges and the CDC
 *                          spool all run on Redis). what a load balancer or an
 *                          uptime monitor should use
 */
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../common/prisma.service';
import { RedisProbeService } from './redis-probe.service';

export interface HealthReport {
  ok: boolean;
  checks: { database: 'ok' | 'down'; redis: 'ok' | 'down' };
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisProbeService,
  ) {}

  private async report(): Promise<HealthReport> {
    const [database, redis] = await Promise.all([
      // a real round-trip to the metadata store, not just "process is up"
      this.prisma.$queryRaw`SELECT 1`.then(
        () => 'ok' as const,
        () => 'down' as const,
      ),
      this.redis
        .check()
        .then((why) => (why === null ? ('ok' as const) : ('down' as const))),
    ]);
    return {
      ok: database === 'ok' && redis === 'ok',
      checks: { database, redis },
    };
  }

  @Public()
  @Get()
  async health(): Promise<HealthReport> {
    const report = await this.report();
    if (report.checks.database === 'down')
      throw new ServiceUnavailableException(report);
    return report;
  }

  @Public()
  @Get('ready')
  async ready(): Promise<HealthReport> {
    const report = await this.report();
    if (!report.ok) throw new ServiceUnavailableException(report);
    return report;
  }
}
