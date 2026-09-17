import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { BridgeVerifyService } from './bridge-verify.service';
import { BRIDGE_VERIFY_QUEUE, type BridgeVerifyPayload } from './bridges.types';

/**
 * one verification (or reconcile) of a bridge. in a queue of its own so that a
 * long look at a large table takes no replay's place, and so that — with several
 * API processes on one Redis — exactly one of them does it
 */
@Processor(BRIDGE_VERIFY_QUEUE, { concurrency: 2 })
export class BridgeVerifyProcessor extends WorkerHost {
  constructor(private readonly verify: BridgeVerifyService) {
    super();
  }

  async process(job: Job<BridgeVerifyPayload>): Promise<void> {
    await this.verify.run(job.data.verificationId);
  }
}
