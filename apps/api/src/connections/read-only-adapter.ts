/**
 * a connection marked READ-ONLY, held to it where every write has to pass: the
 * adapter the pool hands out. whoever asks — the workbench, a bridge's sink, a
 * dead-letter retry, a restore — gets an adapter whose writing methods refuse,
 * by name, saying which connection and how to lift it.
 *
 * `query` is deliberately NOT refused here. the editor's statements are read
 * and refused at the route (see ConnectionsController.query); what reaches
 * `query` from inside Syncle is its own housekeeping on a SOURCE — a change
 * stream's publication and slot on PostgreSQL. those hold no data and change
 * none, and "read-only" would be of little use if it meant a production
 * database could not be streamed FROM.
 */
import { ForbiddenError, type DatabaseAdapter } from '@syncle/core';

/** every method of an adapter that changes data or schema */
export const WRITING_METHODS = [
  'insertRow',
  'insertRows',
  'updateRow',
  'deleteRow',
  'deleteRows',
  'upsertRow',
  'upsertRows',
  'ensureKeyIndex',
  'createTable',
  'addColumns',
  'dropTable',
  'truncateTable',
  'createDatabase',
  'dropDatabase',
  'restore',
] as const;

const WRITES: ReadonlySet<string> = new Set(WRITING_METHODS);

export function readOnlyError(connectionName: string): ForbiddenError {
  return new ForbiddenError(
    `"${connectionName}" is a read-only connection: nothing is written through it. ` +
      'Untick "Read-only" on the connection if that is what you mean to do.',
  );
}

export function asReadOnly(
  adapter: DatabaseAdapter,
  connectionName: string,
): DatabaseAdapter {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && WRITES.has(prop)) {
        // only where the engine has the method at all: callers feature-test
        // (`if (adapter.upsertRows)`), and must go on seeing what is really there
        if (typeof Reflect.get(target, prop, receiver) !== 'function')
          return undefined;
        return () => Promise.reject(readOnlyError(connectionName));
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      // methods keep their `this`: the adapters use private state
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
