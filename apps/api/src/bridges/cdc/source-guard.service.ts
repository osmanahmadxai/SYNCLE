/**
 * Keeps an eye on what CDC bridges are holding on their SOURCE databases.
 *
 * A PostgreSQL replication slot makes the server keep every byte of WAL written
 * since the slot's position, for as long as the slot exists — whether or not
 * anything is reading it. A bridge that is paused, or failed, or was edited
 * into something else, keeps its slot; the source's disk fills; and when it is
 * full the database stops accepting writes. Nothing in Syncle looked, so the
 * first sign was the outage.
 *
 * Every SYNCLE_SLOT_CHECK_SECONDS this:
 *  - measures each CDC bridge's hold and says so when it crosses a threshold
 *    (once per change of level, not once per tick)
 *  - if SYNCLE_SLOT_MAX_BYTES is set, gives up the slot of a bridge that is NOT
 *    running once it pins more than that. Off by default: it trades a gap in
 *    one bridge for the source staying up, and that is the operator's call. A
 *    running bridge is never touched — it is behind, not abandoned.
 *  - retries the removal of anything a deleted or edited bridge left behind.
 */
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { BridgeSourceHold } from '@syncle/core';
import { PrismaService } from '../../common/prisma.service';
import { runtimeConfig } from '../../common/runtime-config';
import { BridgeCdcService, formatBytes } from '../bridge-cdc.service';

@Injectable()
export class SourceGuardService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('SourceGuard');
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  /** the level last reported per bridge, so a standing condition is said once */
  private readonly reported = new Map<string, BridgeSourceHold['level']>();
  /** the latest measurement per bridge, for the API */
  private readonly latest = new Map<string, BridgeSourceHold>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cdc: BridgeCdcService,
  ) {}

  onModuleInit(): void {
    const seconds = runtimeConfig.sourceHoldCheckSeconds;
    if (seconds <= 0) return;
    this.timer = setInterval(() => void this.sweep(), seconds * 1000);
    // never the reason the process stays alive
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** the last measurement taken for a bridge, if any */
  lastKnown(bridgeId: string): BridgeSourceHold | null {
    return this.latest.get(bridgeId) ?? null;
  }

  /** one pass over every CDC bridge. never throws; never overlaps itself */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      // only bridges that have been live at some point: one that was never
      // started holds nothing, and looking would mean opening a connection to
      // its source for no reason — once a minute, for every such bridge
      const bridges = await this.prisma.bridge.findMany({
        where: {
          triggerJson: { contains: '"cdc"' },
          jobs: { some: { status: { not: 'queued' } } },
        },
        select: { id: true, name: true },
      });
      const seen = new Set<string>();
      for (const bridge of bridges) {
        seen.add(bridge.id);
        await this.check(bridge.id, bridge.name).catch((err) => {
          // an unreachable source is its own, louder, problem elsewhere
          this.logger.debug(
            `could not inspect ${bridge.id}: ${(err as Error).message}`,
          );
        });
      }
      for (const id of [...this.latest.keys()]) {
        if (!seen.has(id)) {
          this.latest.delete(id);
          this.reported.delete(id);
        }
      }
      const left = await this.cdc.retryCleanups().catch(() => 0);
      if (left > 0)
        this.logger.warn(
          `${left} replication slot(s) of removed bridges still could not be dropped; retrying`,
        );
    } finally {
      this.sweeping = false;
    }
  }

  /** measure one bridge now, and act on what is found */
  async check(bridgeId: string, name = bridgeId): Promise<void> {
    const hold = await this.cdc.hold(bridgeId);
    if (!hold) {
      this.latest.delete(bridgeId);
      this.reported.delete(bridgeId);
      return;
    }
    this.latest.set(bridgeId, hold);

    const max = runtimeConfig.slotMaxBytes;
    if (
      max > 0 &&
      !hold.running &&
      hold.kind === 'replication-slot' &&
      hold.exists &&
      hold.status !== 'lost' &&
      (hold.retainedBytes ?? 0) > max
    ) {
      const surrendered = await this.cdc.surrenderSlot(
        bridgeId,
        `Syncle dropped this bridge's replication slot to protect the source: the bridge was not running and the slot was pinning ${formatBytes(hold.retainedBytes ?? 0)} of WAL, ` +
          `more than SYNCLE_SLOT_MAX_BYTES allows (${formatBytes(max)}).`,
      );
      if (surrendered) {
        this.reported.set(bridgeId, 'critical');
        return;
      }
    }

    const before = this.reported.get(bridgeId) ?? 'ok';
    if (hold.level !== before) {
      this.reported.set(bridgeId, hold.level);
      if (hold.level === 'ok')
        this.logger.log(
          `Bridge "${name}" (${bridgeId}): source hold back to normal`,
        );
      else this.logger.warn(`Bridge "${name}" (${bridgeId}): ${hold.message}`);
    }
  }
}
