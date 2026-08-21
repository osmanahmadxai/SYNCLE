/**
 * single-request HTTP delivery with retries, exponential backoff and a hard
 * per-request timeout. pure transport: knows nothing about runs, rows, or
 * persistence. the caller supplies the body and records the outcome.
 *
 * auth secrets get applied to headers at send time and are never logged, only a
 * truncated response snippet is kept.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { HookDeliveryConfig, HttpDestination } from '@syncle/core';
import type { DeliveryOutcome } from './hooks.types';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RESPONSE_LIMIT = 16_384;
/** stop reading a response body past this point, the rest is never kept anyway */
const BODY_READ_LIMIT = 65_536;

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger('HookDelivery');

  /** build request headers, merging static headers with the auth scheme */
  buildHeaders(
    dest: HttpDestination,
    idempotencyKey?: string,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(dest.headers ?? {}),
    };
    if (dest.auth.type === 'bearer' && dest.auth.token) {
      headers['authorization'] = `Bearer ${dest.auth.token}`;
    } else if (dest.auth.type === 'header' && dest.auth.value) {
      headers[dest.auth.name] = dest.auth.value;
    }
    if (idempotencyKey && dest.idempotency) {
      headers['idempotency-key'] = idempotencyKey;
    }
    return headers;
  }

  /** headers with the auth secret redacted, safe for preview/UI */
  redactedHeaders(dest: HttpDestination): Record<string, string> {
    const headers = this.buildHeaders(dest);
    if (dest.auth.type === 'bearer' && headers['authorization']) {
      headers['authorization'] = 'Bearer ********';
    } else if (dest.auth.type === 'header' && dest.auth.name in headers) {
      headers[dest.auth.name] = '********';
    }
    return headers;
  }

  /**
   * send one request, retrying transient failures up to `maxAttempts`. resolves
   * with an outcome describing success or terminal failure, it doesn't throw for
   * HTTP errors (the run decides whether to continue). re-throws only if the
   * run's abort signal fires, so the caller can finalize as canceled.
   */
  async send(
    body: unknown,
    dest: HttpDestination,
    delivery: HookDeliveryConfig,
    runSignal: AbortSignal,
    idempotencyKey?: string,
  ): Promise<DeliveryOutcome> {
    const headers = this.buildHeaders(dest, idempotencyKey);
    const payload = JSON.stringify(body ?? null);
    const requestBody = payload.slice(0, RESPONSE_LIMIT);
    // a capture cut at the cap can never be JSON.parsed back for a resend, so
    // flag it — the retry path refuses these instead of re-sending garbage
    const bodyTruncated = payload.length > RESPONSE_LIMIT;
    const started = performance.now();
    let lastError: string | null = null;
    let lastStatus: number | null = null;
    let lastResponse: string | null = null;

    for (let attempt = 1; attempt <= delivery.maxAttempts; attempt++) {
      if (runSignal.aborted) throw new DOMException('Run canceled', 'AbortError');

      const timeout = AbortSignal.timeout(delivery.timeoutMs);
      const signal = AbortSignal.any([runSignal, timeout]);
      try {
        const res = await fetch(dest.url, {
          method: dest.method,
          headers,
          body: payload,
          signal,
        });
        lastStatus = res.status;
        lastResponse = (await readBodyCapped(res)).slice(0, RESPONSE_LIMIT);

        if (res.ok) {
          return {
            status: 'success',
            httpStatus: res.status,
            attempts: attempt,
            error: null,
            requestBody,
            responseBody: lastResponse || null,
            durationMs: Math.round(performance.now() - started),
            bodyTruncated,
          };
        }

        lastError = `HTTP ${res.status} ${res.statusText}`.trim();
        if (RETRYABLE_STATUS.has(res.status) && attempt < delivery.maxAttempts) {
          await this.backoff(attempt, delivery, res.headers.get('retry-after'), runSignal);
          continue;
        }
        break; // non-retryable HTTP error
      } catch (err) {
        // a run-level abort must propagate, a timeout/network error is retryable
        if (runSignal.aborted) throw err;
        lastError = describeFetchError(err);
        lastStatus = null;
        if (attempt < delivery.maxAttempts) {
          await this.backoff(attempt, delivery, null, runSignal);
          continue;
        }
      }
    }

    return {
      status: 'failed',
      httpStatus: lastStatus,
      attempts: delivery.maxAttempts,
      error: lastError ?? 'Delivery failed',
      requestBody,
      responseBody: lastResponse,
      durationMs: Math.round(performance.now() - started),
      bodyTruncated,
    };
  }

  /**
   * exponential backoff with jitter, honoring a numeric `Retry-After`. aborts
   * early on the run's signal so a cancel never waits out `backoffMaxMs`.
   */
  private async backoff(
    attempt: number,
    delivery: HookDeliveryConfig,
    retryAfter: string | null,
    signal: AbortSignal,
  ): Promise<void> {
    let delay = Math.min(
      delivery.backoffMaxMs,
      delivery.backoffMs * 2 ** (attempt - 1),
    );
    const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : NaN;
    if (Number.isFinite(retryAfterMs)) {
      delay = Math.max(delay, Math.min(retryAfterMs, delivery.backoffMaxMs));
    }
    const jitter = delay * 0.2 * Math.random();
    await sleep(delay + jitter, signal);
  }
}

/**
 * read at most {@link BODY_READ_LIMIT} of a response body, then cancel the
 * rest, so a huge (or endless streaming) response can't balloon memory the way
 * an unbounded `res.text()` would.
 */
async function readBodyCapped(res: Response, limit = BODY_READ_LIMIT): Promise<string> {
  const body = res.body;
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  try {
    while (out.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } catch {
    /* a partial body is fine, it's only kept as a log snippet */
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return out.slice(0, limit);
}

/**
 * turn an opaque `fetch failed` into something actionable. Node's `fetch`
 * (undici) wraps the real reason in `error.cause`, so surface its `code`,
 * `address`/`port` and message. a delivery log then reads e.g.
 * "fetch failed (ECONNREFUSED 127.0.0.1:8000)" instead of just "fetch failed".
 */
export function describeFetchError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return 'Request timed out';
  }
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause as
    | { code?: string; address?: string; port?: number; message?: string }
    | undefined;
  if (!cause) return err.message;
  const where = cause.address
    ? ` ${cause.address}${cause.port ? `:${cause.port}` : ''}`
    : '';
  const detail = cause.code ? `${cause.code}${where}` : (cause.message ?? '');
  return detail ? `${err.message} (${detail.trim()})` : err.message;
}

/** sleep that resolves early if the signal aborts, keeps cancel responsive */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
