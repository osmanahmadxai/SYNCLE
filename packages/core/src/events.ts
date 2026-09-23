/**
 * what the API tells a listening browser as things happen — instead of the
 * browser asking every few seconds whether anything did.
 *
 * an event says only THAT something changed, and what it was about; the
 * listener asks for the thing itself, the way it always did. so a missed event
 * costs a little staleness, never a wrong picture, and the polls that remain
 * (slower, while a stream is up) are the safety net.
 */

export const LIVE_EVENT_TYPES = [
  /** a bridge was created, changed or removed (`bridgeId`) */
  'bridge',
  /** a run of a bridge started, moved on, or ended (`bridgeId`, `jobId`) */
  'bridge.job',
  /** deliveries of a run were recorded or changed (`jobId`) */
  'bridge.deliveries',
  /** a verification of a bridge started, moved on, or ended (`bridgeId`) */
  'bridge.verification',
  /** a row was set aside, retried or discarded (`bridgeId`) */
  'bridge.deadLetters',
  /** a saved connection was created, changed or removed (`id`) */
  'connection',
  /** a workspace was created, changed or removed (`id`) */
  'workspace',
  /** a setting changed */
  'settings',
  /** an account was created, changed or removed */
  'users',
  /** an API key was created, changed or removed */
  'apiKeys',
  /** an entry was added to the activity log */
  'audit',
  /** an alert channel was created, changed or removed */
  'alertChannels',
] as const;

export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

export interface LiveEvent {
  type: LiveEventType;
  /** the bridge it is about, when it is about one */
  bridgeId?: string;
  /** the run it is about, when it is about one */
  jobId?: string;
  /** the connection or workspace it is about, when it is about one */
  id?: string;
  /** when it happened (ISO 8601) */
  at: string;
}
