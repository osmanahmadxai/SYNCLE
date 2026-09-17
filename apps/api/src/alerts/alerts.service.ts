/**
 * says out loud that a bridge needs someone.
 *
 * `emit` is fire-and-forget by contract: it is called from the middle of a
 * bridge stopping, and nothing that goes wrong with an alert — a Slack that is
 * down, a channel that cannot be decrypted — may get in the way of that, or
 * throw back into it.
 *
 * Throttled per (channel, kind of event, bridge): a bridge that fails every
 * thirty seconds sends one alert per window, and the next one says how many
 * were not sent in between.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { AlertEvent, AlertEventType, AlertTestResult } from '@syncle/core';
import { PrismaService } from '../common/prisma.service';
import { runtimeConfig } from '../common/runtime-config';
import { resolveVersion } from '../common/version';
import { AlertChannelStore } from './alert-channel.store';
import { sendAlert, type SenderDeps } from './alert-senders';

export type AlertInput = Omit<AlertEvent, 'at' | 'suppressed' | 'type'> & {
  type: AlertEventType;
};

const RETRY_PAUSE_MS = 1_500;

@Injectable()
export class AlertsService {
  private readonly logger = new Logger('Alerts');
  /** key -> when the last one went out, and how many were held back since */
  private readonly sent = new Map<string, { at: number; suppressed: number }>();
  /** replaced in tests */
  deps: SenderDeps = { version: resolveVersion().version };
  /** settles when everything emitted so far has been dealt with (for tests and shutdown) */
  private inflight: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly channels: AlertChannelStore,
    private readonly prisma: PrismaService,
  ) {}

  emit(input: AlertInput): void {
    const event: AlertEvent = { ...input, at: new Date().toISOString() };
    const work = this.dispatch(event).catch((err) =>
      this.logger.warn(`Could not send an alert: ${(err as Error).message}`),
    );
    this.inflight = Promise.allSettled([this.inflight, work]);
  }

  /** `emit` for the places that know a job and nothing else about it */
  emitForJob(
    jobId: string,
    input: Omit<AlertInput, 'bridgeId' | 'bridgeName' | 'jobId' | 'title'> & {
      title: (bridgeName: string) => string;
    },
  ): void {
    const work = (async () => {
      const job = await this.prisma.bridgeJob.findUnique({
        where: { id: jobId },
        select: { bridgeId: true, bridge: { select: { name: true } } },
      });
      const bridgeName = job?.bridge?.name ?? 'a deleted bridge';
      const { title, ...rest } = input;
      await this.dispatch({
        ...rest,
        title: title(bridgeName),
        bridgeId: job?.bridgeId,
        bridgeName,
        jobId,
        at: new Date().toISOString(),
      });
    })().catch((err) =>
      this.logger.warn(`Could not send an alert: ${(err as Error).message}`),
    );
    this.inflight = Promise.allSettled([this.inflight, work]);
  }

  idle(): Promise<void> {
    return this.inflight.then(() => undefined);
  }

  private async dispatch(event: AlertEvent): Promise<void> {
    if (event.type === 'test') return;
    const subscribers = await this.channels.subscribers(event.type);
    await Promise.all(
      subscribers.map(async (channel) => {
        const key = `${channel.id}|${event.type}|${event.bridgeId ?? ''}`;
        const now = Date.now();
        const last = this.sent.get(key);
        if (last && now - last.at < runtimeConfig.alertThrottleSeconds * 1000) {
          last.suppressed++;
          return;
        }
        this.sent.set(key, { at: now, suppressed: 0 });
        const outgoing = last?.suppressed
          ? { ...event, suppressed: last.suppressed }
          : event;
        let result = await sendAlert(channel, outgoing, this.deps);
        if (!result.ok) {
          await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
          result = await sendAlert(channel, outgoing, this.deps);
        }
        await this.channels.recordOutcome(
          channel.id,
          result.ok,
          result.ok ? null : result.detail,
        );
        if (!result.ok)
          this.logger.warn(
            `Alert channel "${channel.name}" did not take "${event.title}": ${result.detail}`,
          );
      }),
    );
    // the map is keyed by bridge: forget what is long past its window
    if (this.sent.size > 5_000) {
      const horizon = Date.now() - runtimeConfig.alertThrottleSeconds * 1000;
      for (const [k, v] of this.sent) if (v.at < horizon) this.sent.delete(k);
    }
  }

  /** send a test message to one channel, now, whatever it subscribes to; never throttled */
  async test(channelId: string): Promise<AlertTestResult> {
    const channel = await this.channels.resolve(channelId);
    const result = await sendAlert(
      channel,
      {
        type: 'test',
        severity: 'warning',
        title: 'Test alert from Syncle',
        message: `This is what an alert on the channel "${channel.name}" looks like. Nothing is wrong.`,
        at: new Date().toISOString(),
      },
      this.deps,
    );
    await this.channels.recordOutcome(
      channel.id,
      result.ok,
      result.ok ? null : result.detail,
    );
    return result;
  }
}
