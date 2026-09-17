/**
 * MongoDB CDC via change streams (`collection.watch()`), built on the oplog.
 * real-time, durable, resumable via a resume token, as long as the token still
 * falls inside the oplog window. needs the server to be a replica set (a
 * single-node replica set works for dev) or a sharded cluster. change streams
 * aren't available on a standalone mongod.
 *
 * resume token (`change._id`) gets serialized into the cursor. on a long pause
 * the oplog can roll past the token (`ChangeStreamHistoryLost`). the bridge is
 * then stopped and says why: carrying on from "now" would leave a hole in the
 * destination that nothing showed (see CdcStreamHandlers.onPositionLost).
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  MongoClient,
  type ChangeStream,
  type ChangeStreamDocument,
  type Document,
} from 'mongodb';
import type {
  CdcOperation,
  CdcReadiness,
  CdcReadinessDTO,
  ConnectionConfig,
  DatabaseEngine,
} from '@syncle/core';
import { mongoTlsOptions, mongoTunnelOptions, normalizeMongoDocument } from '@syncle/core/adapters';
import type { ResolvedBridge } from '../../bridges.types';
import { backoffMs, delay, type CdcChange, type CdcProvider, type CdcStreamContext, type CdcStreamHandle } from '../cdc-provider';

/** map enabled CDC ops to the change-stream operationTypes to match */
function operationTypes(ops: Set<CdcOperation>): string[] {
  const out: string[] = [];
  if (ops.has('insert')) out.push('insert');
  if (ops.has('update')) out.push('update', 'replace'); // replace is an update
  if (ops.has('delete')) out.push('delete');
  return out;
}

@Injectable()
export class MongodbCdcProvider implements CdcProvider {
  readonly engine: DatabaseEngine = 'mongodb';
  private readonly logger = new Logger('BridgeCdc:mongo');

  // resume tokens are exact, the driver replays from the token with no overlap
  cursorAfter(): boolean {
    return true;
  }

  /* ----- connection ----- */

  /**
   * the change stream gets the SAME TLS treatment as the adapter's connection.
   * it was never told about TLS at all, so with "Use TLS" switched on every
   * change still crossed the network in plaintext.
   */
  private clientOptions(conn: ConnectionConfig): Record<string, unknown> {
    return { serverSelectionTimeoutMS: 8000, ...mongoTunnelOptions(conn), ...mongoTlsOptions(conn) };
  }

  private uri(conn: ConnectionConfig): string {
    if (conn.connectionString) return conn.connectionString;
    const auth =
      conn.user && conn.password
        ? `${encodeURIComponent(conn.user)}:${encodeURIComponent(conn.password)}@`
        : '';
    const host = conn.host ?? 'localhost';
    const port = conn.port ?? 27017;
    return `mongodb://${auth}${host}:${port}`;
  }

  /* ----- readiness ----- */

  async readiness(_dto: CdcReadinessDTO, conn: ConnectionConfig): Promise<CdcReadiness> {
    const checks: CdcReadiness['checks'] = [];
    const instructions: string[] = [];
    let client: MongoClient | null = null;
    try {
      client = new MongoClient(this.uri(conn), this.clientOptions(conn));
      await client.connect();
      const hello = (await client.db('admin').command({ hello: 1 })) as {
        setName?: string;
        msg?: string;
      };
      const isReplicaSet = !!hello.setName;
      const isSharded = hello.msg === 'isdbgrid';
      const ok = isReplicaSet || isSharded;
      checks.push({
        label: 'replica set or sharded cluster',
        ok,
        detail: isReplicaSet
          ? `replica set "${hello.setName}"`
          : isSharded
            ? 'sharded cluster'
            : 'standalone server',
      });
      if (!ok) {
        instructions.push(
          'MongoDB change streams require a replica set. For local dev, start mongod with `--replSet rs0` and run `rs.initiate()` once. Managed MongoDB (Atlas) already satisfies this.',
        );
      }
      return { engine: 'mongodb', supported: true, ready: ok, checks, instructions };
    } catch (err) {
      return {
        engine: 'mongodb',
        supported: true,
        ready: false,
        checks: [{ label: 'connect to MongoDB', ok: false, detail: (err as Error).message }],
        instructions: ['Could not connect to MongoDB to check readiness.'],
      };
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  /* ----- provisioning ----- */

  /**
   * enable change-stream pre-images on the source collection so DELETE (and
   * UPDATE) events carry the full prior document. without this, Mongo's delete
   * event only includes `_id`, so a bridge keyed on a business column couldn't
   * locate the row to remove in downstream databases. requires MongoDB 6.0+,
   * on older servers this is a best-effort no-op (deletes then carry only _id).
   */
  async provision(
    _bridgeId: string,
    bridge: ResolvedBridge,
    conn: ConnectionConfig,
  ): Promise<void> {
    if (bridge.source.kind !== 'table') return;
    const table = bridge.source.table;
    const client = new MongoClient(this.uri(conn), this.clientOptions(conn));
    try {
      await client.connect();
      const db = client.db(bridge.source.database || conn.database || 'test');
      await db.command({
        collMod: table,
        changeStreamPreAndPostImages: { enabled: true },
      });
      this.logger.log(`Enabled change-stream pre-images on "${table}"`);
    } catch (err) {
      this.logger.warn(
        `Could not enable pre-images on "${table}" (${(err as Error).message}). ` +
          `Deletes will carry only _id and may not propagate by business key.`,
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  }
  async deprovision(): Promise<void> {
    /* no-op */
  }

  /* ----- the stream ----- */

  async startStream(ctx: CdcStreamContext): Promise<CdcStreamHandle> {
    const { bridge, conn, handlers, fromCursor } = ctx;
    if (bridge.source.kind !== 'table' || bridge.trigger.kind !== 'cdc') {
      throw new Error('MongoDB CDC requires a collection source and cdc trigger.');
    }
    const src = bridge.source;
    const ops = new Set<CdcOperation>(bridge.trigger.operations);
    const matchTypes = operationTypes(ops);

    const client = new MongoClient(this.uri(conn), this.clientOptions(conn));
    await client.connect();
    const db = client.db(src.database || conn.database || 'test');
    const collection = db.collection(src.table);

    let stopped = false;
    let current: ChangeStream | null = null;
    let resumeToken: unknown = fromCursor ? this.parseToken(fromCursor) : null;
    let attempt = 0;

    const pipeline =
      matchTypes.length > 0 ? [{ $match: { operationType: { $in: matchTypes } } }] : [];

    const loop = async (): Promise<void> => {
      while (!stopped) {
        try {
          // `updateLookup` gives the post-image on updates; `whenAvailable`
          // pre-images give the pre-delete document (when provisioned) so we can
          // route deletes by a business key, not just _id.
          const options: Document = {
            fullDocument: 'updateLookup',
            fullDocumentBeforeChange: 'whenAvailable',
          };
          if (resumeToken) options.startAfter = resumeToken;
          const stream = collection.watch(pipeline, options);
          current = stream;
          attempt = 0; // successful open resets backoff

          for await (const change of stream as AsyncIterable<ChangeStreamDocument>) {
            if (stopped) break;
            const mapped = this.mapChange(change);
            if (mapped) await handlers.onChange(mapped);
            resumeToken = (change as { _id?: unknown })._id ?? resumeToken;
          }
          // iterator ended without error (e.g. closed by stop())
          if (stopped) break;
        } catch (err) {
          if (stopped) break;
          const e = err as Error & { codeName?: string; code?: number };
          const historyLost =
            e.codeName === 'ChangeStreamHistoryLost' || e.code === 286;
          if (historyLost) {
            if (handlers.onPositionLost) {
              // this used to restart from "now" and mention it in the log. the
              // destination then had a hole in it that nothing on the bridge
              // showed. it stops instead, and the next start accepts the gap
              // in so many words
              stopped = true;
              await handlers.onPositionLost(
                'The resume token is older than the MongoDB oplog window: the oplog rolled over while the bridge was not reading it.',
              );
              break;
            }
            handlers.onError(
              new Error(
                'Resume token is older than the MongoDB oplog window — restarting from now. Changes during the gap were not captured.',
              ),
            );
            resumeToken = null; // start over from "now"
            continue;
          }
          handlers.onError(e);
          await delay(backoffMs(attempt++));
        }
      }
    };

    // drive the loop in the background, it owns its own lifecycle
    void loop().catch((err) => handlers.onError(err as Error));

    return {
      stop: async () => {
        stopped = true;
        await current?.close().catch(() => undefined);
        await client.close().catch(() => undefined);
      },
    };
  }

  /** map a change-stream event into the normalized shape, or null to skip */
  private mapChange(change: ChangeStreamDocument): CdcChange | null {
    const cursor = this.serializeToken((change as { _id?: unknown })._id);
    switch (change.operationType) {
      case 'insert':
      case 'update':
      case 'replace': {
        const full = (change as { fullDocument?: Record<string, unknown> }).fullDocument;
        // on update the doc may have been deleted before updateLookup ran
        const row =
          full ?? ((change as { documentKey?: Record<string, unknown> }).documentKey ?? {});
        // replace behaves like an overwrite, so report it as an update
        const op: CdcOperation = change.operationType === 'insert' ? 'insert' : 'update';
        // plain values, exactly as a replay reads them: an ObjectId left as an
        // object reaches a SQL driver as `"507f…"`, quotes and all
        return { op, row: normalizeMongoDocument(row), cursor };
      }
      case 'delete': {
        // prefer the pre-image (full prior document, incl. business keys); fall
        // back to documentKey (_id only) when pre-images aren't enabled
        const before = (change as { fullDocumentBeforeChange?: Record<string, unknown> })
          .fullDocumentBeforeChange;
        const key = (change as { documentKey?: Record<string, unknown> }).documentKey ?? {};
        return { op: 'delete', row: normalizeMongoDocument(before ?? key), cursor };
      }
      default:
        return null; // drop, rename, invalidate, etc
    }
  }

  private serializeToken(token: unknown): string {
    try {
      return JSON.stringify(token);
    } catch {
      return '';
    }
  }
  private parseToken(s: string): unknown {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }
}
