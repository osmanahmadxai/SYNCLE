import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { BridgeScheduleService } from './bridge-schedule.service';
import {
  BRIDGE_SCHEDULE_QUEUE,
  type BridgeSchedulePayload,
} from './bridges.types';

/** each fire of a bridge's cron line: start its replay, unless one is still going */
@Processor(BRIDGE_SCHEDULE_QUEUE, { concurrency: 4 })
export class BridgeScheduleProcessor extends WorkerHost {
  constructor(private readonly schedule: BridgeScheduleService) {
    super();
  }

  async process(job: Job<BridgeSchedulePayload>): Promise<void> {
    await this.schedule.tick(job.data.bridgeId);
  }
}
