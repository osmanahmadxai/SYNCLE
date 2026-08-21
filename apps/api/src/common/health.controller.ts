/**
 * liveness/readiness probe for containers and monitors. public by design —
 * it leaks nothing beyond "the API and its metadata store are reachable",
 * and orchestrators need it before anyone can log in.
 */
import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { PrismaService } from './prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async health(): Promise<{ ok: true }> {
    // a real round-trip to the metadata store, not just "process is up"
    await this.prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  }
}
