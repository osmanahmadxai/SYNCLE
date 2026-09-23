import { Global, Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { RedisProbeService } from './redis-probe.service';

// @Global so that the parts of the app that measure something (the source
// guard) can publish it as a gauge without importing this module
@Global()
@Module({
  controllers: [HealthController, MetricsController],
  providers: [RedisProbeService, MetricsService],
  exports: [MetricsService],
})
export class ObservabilityModule {}
