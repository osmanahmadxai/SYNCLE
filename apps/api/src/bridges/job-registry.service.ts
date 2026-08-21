/**
 * in-process registry of `AbortController`s for currently-executing jobs. the
 * BullMQ worker jobs in this process, so aborting the controller here cancels
 * the in-flight `fetch` immediately (no Redis round-trip). state is deliberately
 * ephemeral, durability lives in Redis/Prisma, this is only for live abort.
 */
import { Injectable, type OnModuleDestroy } from '@nestjs/common';

@Injectable()
export class JobRegistryService implements OnModuleDestroy {
  private readonly controllers = new Map<string, AbortController>();

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
    if (!controller) return false;
    controller.abort();
    return true;
  }

  onModuleDestroy(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }
}
