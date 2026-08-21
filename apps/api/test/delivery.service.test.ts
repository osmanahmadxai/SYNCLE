/**
 * DeliveryService transport tests against a throwaway node:http server: retry
 * classification (retryable vs terminal status), Retry-After honored and
 * clamped, run-abort propagation, and the truncated-capture flag that keeps
 * the resend path from replaying garbage.
 */
import 'reflect-metadata';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { HookDeliveryConfig, HttpDestination } from '@syncle/core';
import { DeliveryService } from '../src/hooks/delivery.service';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server | null = null;

/** start a one-off server and return the URL to POST at */
async function listen(handler: Handler): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}/hook`;
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

function config(overrides: Partial<HookDeliveryConfig> = {}): HookDeliveryConfig {
  return {
    batchSize: 1,
    maxAttempts: 3,
    backoffMs: 5,
    backoffMaxMs: 40,
    minDelayMs: 0,
    timeoutMs: 2000,
    pageSize: 200,
    onError: 'continue',
    ...overrides,
  };
}

function dest(url: string): HttpDestination {
  return {
    kind: 'http',
    url,
    method: 'POST',
    headers: {},
    auth: { type: 'none' },
    idempotency: false,
  };
}

describe('DeliveryService.send', () => {
  it('retries a retryable status and succeeds', async () => {
    let hits = 0;
    const url = await listen((_req, res) => {
      hits++;
      res.statusCode = hits === 1 ? 503 : 200;
      res.end(hits === 1 ? 'busy' : 'ok');
    });
    const outcome = await new DeliveryService().send(
      { id: 1 },
      dest(url),
      config(),
      new AbortController().signal,
    );
    expect(outcome.status).toBe('success');
    expect(outcome.attempts).toBe(2);
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.bodyTruncated).toBe(false);
    expect(hits).toBe(2);
  });

  it('fails a terminal status without retrying', async () => {
    let hits = 0;
    const url = await listen((_req, res) => {
      hits++;
      res.statusCode = 400;
      res.end('bad payload');
    });
    const outcome = await new DeliveryService().send(
      { id: 1 },
      dest(url),
      config(),
      new AbortController().signal,
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.httpStatus).toBe(400);
    expect(outcome.error).toContain('HTTP 400');
    expect(hits).toBe(1); // 400 is not retryable
  });

  it('honors a numeric Retry-After beyond the computed backoff', async () => {
    const times: number[] = [];
    const url = await listen((_req, res) => {
      times.push(Date.now());
      if (times.length === 1) {
        res.statusCode = 429;
        res.setHeader('retry-after', '1'); // 1s, far above backoffMs
        res.end('slow down');
      } else {
        res.statusCode = 200;
        res.end('ok');
      }
    });
    const outcome = await new DeliveryService().send(
      { id: 1 },
      dest(url),
      config({ backoffMs: 5, backoffMaxMs: 5000 }),
      new AbortController().signal,
    );
    expect(outcome.status).toBe('success');
    expect(times).toHaveLength(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(900);
  });

  it('clamps Retry-After to backoffMaxMs', async () => {
    const times: number[] = [];
    const url = await listen((_req, res) => {
      times.push(Date.now());
      if (times.length === 1) {
        res.statusCode = 429;
        res.setHeader('retry-after', '3600'); // an hour — must not be waited out
        res.end('slow down');
      } else {
        res.statusCode = 200;
        res.end('ok');
      }
    });
    const outcome = await new DeliveryService().send(
      { id: 1 },
      dest(url),
      config({ backoffMs: 5, backoffMaxMs: 50 }),
      new AbortController().signal,
    );
    expect(outcome.status).toBe('success');
    expect(times).toHaveLength(2);
    expect(times[1]! - times[0]!).toBeLessThan(1000); // ~50ms + jitter, not 1h
  });

  it('propagates a run-level abort as a rejection', async () => {
    const url = await listen(() => {
      /* never respond, the abort must cut the in-flight request */
    });
    const controller = new AbortController();
    const pending = new DeliveryService().send(
      { id: 1 },
      dest(url),
      config(),
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  });

  it('flags a capture cut at the storage cap as truncated', async () => {
    const url = await listen((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });
    const outcome = await new DeliveryService().send(
      { blob: 'x'.repeat(20_000) },
      dest(url),
      config(),
      new AbortController().signal,
    );
    expect(outcome.status).toBe('success');
    expect(outcome.bodyTruncated).toBe(true);
    expect(outcome.requestBody).toHaveLength(16_384);
  });
});
