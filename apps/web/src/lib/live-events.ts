/**
 * the API's stream of events, and what the page does with one: it asks again
 * for whatever the event was about. nothing on the page is drawn from an
 * event itself — a query is invalidated, and refetches the way it always did —
 * so a missed event costs a little staleness and never a wrong picture.
 *
 * while the stream is up, the polls that used to be the only way to notice a
 * change slow down to a safety net (see {@link pollEvery}); when it is not
 * (a proxy that will not stream, an old browser), they carry on as before.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { LiveEvent } from '@syncle/core';
import { eventsUrl } from './api';

/** how often a poll runs while the stream is up: it is only there for what the stream missed */
export const SLOW_POLL_MS = 30_000;

/* ----- is the stream up? one flag for the page ----- */

let connected = false;
const listeners = new Set<() => void>();

function setConnected(value: boolean): void {
  if (connected === value) return;
  connected = value;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** whether events are arriving (for anything that wants to say so) */
export function useLive(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => connected,
    () => false,
  );
}

/** a poll's interval: as asked while nothing is pushing, slow while the stream is up */
export function pollEvery(ms: number): number {
  return connected ? Math.max(ms, SLOW_POLL_MS) : ms;
}

/* ----- an event -> the queries it makes stale ----- */

type Key = readonly unknown[];

/** what an event makes stale. the keys are those of `queries.ts` (its test keeps them so) */
export function invalidateFor(qc: QueryClient, event: LiveEvent): void {
  const stale = (queryKey: Key, exact = false) =>
    void qc.invalidateQueries({ queryKey, exact });
  const { bridgeId, jobId, id } = event;
  switch (event.type) {
    case 'bridge':
      // the bridge and what is derived from it — not its runs, which have events of their own
      stale(['bridges'], true);
      stale(['bridgeStatuses']);
      if (bridgeId) {
        stale(['bridges', bridgeId], true);
        for (const part of ['loops', 'schemaDrift', 'schedule', 'sourceHold'])
          stale(['bridges', bridgeId, part]);
      } else {
        void qc.invalidateQueries({
          predicate: (q) =>
            q.queryKey[0] === 'bridges' && q.queryKey[2] !== 'jobs',
        });
      }
      return;
    case 'bridge.job':
      stale(['bridgeStatuses']);
      stale(['bridges'], true);
      if (bridgeId) {
        stale(['bridges', bridgeId, 'jobs'], true);
        if (jobId) stale(['bridges', bridgeId, 'jobs', jobId], true);
      } else {
        void qc.invalidateQueries({
          predicate: (q) =>
            q.queryKey[0] === 'bridges' &&
            q.queryKey[2] === 'jobs' &&
            (q.queryKey.length === 3 ||
              (q.queryKey.length === 4 && (!jobId || q.queryKey[3] === jobId))),
        });
      }
      return;
    case 'bridge.deliveries':
      // deliveries are keyed under their run: matched by the run, whichever bridge it is of
      void qc.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === 'bridges' &&
          q.queryKey[2] === 'jobs' &&
          q.queryKey[4] === 'deliveries' &&
          (!jobId || q.queryKey[3] === jobId),
      });
      return;
    case 'bridge.verification':
      if (bridgeId) stale(['bridges', bridgeId, 'verifications']);
      else
        void qc.invalidateQueries({
          predicate: (q) =>
            q.queryKey[0] === 'bridges' && q.queryKey[2] === 'verifications',
        });
      return;
    case 'bridge.deadLetters':
      if (bridgeId) stale(['bridges', bridgeId, 'deadLetters']);
      else
        void qc.invalidateQueries({
          predicate: (q) =>
            q.queryKey[0] === 'bridges' && q.queryKey[2] === 'deadLetters',
        });
      return;
    case 'connection':
      stale(['connections'], true);
      if (id) stale(['connections', id]);
      // a bridge is described by its connections' names
      stale(['bridges'], true);
      return;
    case 'workspace':
      stale(['workspaces']);
      return;
    case 'settings':
      stale(['settings']);
      stale(['encryptionStatus']);
      return;
    case 'users':
      stale(['users']);
      return;
    case 'apiKeys':
      stale(['api-keys']);
      return;
    case 'audit':
      stale(['audit']);
      return;
    case 'alertChannels':
      stale(['alert-channels']);
      return;
    default:
      return;
  }
}

/* ----- the connection ----- */

/** what the page needs of an EventSource (so a test can hand it one of its own) */
export interface EventStream {
  onopen: ((ev: Event) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  /** 0 connecting, 1 open, 2 closed for good */
  readonly readyState: number;
  close(): void;
}

const CLOSED = 2;
/** after a close the browser will not retry (a 401, a 502 from a proxy), a try of our own — backing off */
const RETRY_MS = [5_000, 15_000, 60_000];

/**
 * open the stream and keep it open; returns what closes it. an EventSource
 * reconnects by itself after a network error — but not after a response it
 * did not like, so that case is retried here (and a session that is gone
 * gets its 401 seen by the queries, which send the page back to the login)
 */
export function connect(
  qc: QueryClient,
  open: (url: string) => EventStream,
  url: string = eventsUrl(),
): () => void {
  let source: EventStream | null = null;
  let stopped = false;
  let opened = 0;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const start = (): void => {
    if (stopped) return;
    const s = open(url);
    source = s;
    s.onopen = () => {
      failures = 0;
      setConnected(true);
      // back after a gap: whatever happened meanwhile is asked for, all of it
      if (opened++ > 0) void qc.invalidateQueries();
    };
    s.onerror = () => {
      setConnected(false);
      if (stopped || s.readyState !== CLOSED) return; // reconnecting by itself
      const wait = RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]!;
      retry = setTimeout(start, wait);
    };
    s.onmessage = (ev) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(String(ev.data)) as LiveEvent;
      } catch {
        return;
      }
      if (event && typeof event === 'object' && typeof event.type === 'string')
        invalidateFor(qc, event);
    };
  };
  start();

  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    source?.close();
    setConnected(false);
  };
}

/** listen while mounted (the studio, once): the browser's EventSource, with the session cookie */
export function useLiveEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined;
    return connect(
      qc,
      (url) => new EventSource(url, { withCredentials: true }),
    );
  }, [qc]);
}
