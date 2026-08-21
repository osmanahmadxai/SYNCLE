import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { BridgeWatchService } from './bridge-watch.service';
import { BRIDGE_WATCH_QUEUE, type BridgeWatchPayload } from './bridges.types';

/** each scheduled fire is one poll cycle for a watch bridge */
@Processor(BRIDGE_WATCH_QUEUE, { concurrency: 8 })
export class BridgeWatchProcessor extends WorkerHost {
  constructor(private readonly watch: BridgeWatchService) {
    super();
  }

  async process(job: Job<BridgeWatchPayload>): Promise<void> {
    await this.watch.poll(job.data.bridgeId);
  }
}
