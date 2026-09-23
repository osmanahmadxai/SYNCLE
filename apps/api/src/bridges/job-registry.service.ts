/**
 * in-process registry of `AbortController`s for currently-executing jobs. the
 * BullMQ worker jobs in this process, so aborting the controller here cancels
 * the in-flight `fetch` immediately (no Redis round-trip). state is deliberately
 * ephemeral, durability lives in Redis/Prisma, this is only for live abort.
 */
import {
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { InstanceService } from '../common/instance.service';

@Injectable()
export class JobRegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly controllers = new Map<string, AbortController>();

  constructor(@Optional() private readonly instance?: InstanceService) {}

  /**
   * a job runs in whichever process picked it off the queue, and "cancel" or
   * "stop" arrives at whichever process the request reached. what is not running
   * here is aborted THERE: said to every process, and the one that has it acts
   */
  onModuleInit(): void {
    this.instance?.handle('job.abort', (p) => {
      this.controllers.get((p as { jobId: string }).jobId)?.abort();
    });
  }

  register(jobId: string): AbortController {
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    return controller;
  }

  release(jobId: string): void {
    this.controllers.delete(jobId);
  }

  abort(jobId: string): boolean {
    const controller = this.controllers.get(jobId);
    if (!controller) {
      void this.instance?.publish('job.abort', { jobId });
      return false;
    }
    controller.abort();
    return true;
  }

  onModuleDestroy(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }
}
