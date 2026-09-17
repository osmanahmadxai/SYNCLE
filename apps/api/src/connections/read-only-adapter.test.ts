import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ForbiddenError, type DatabaseAdapter } from '@syncle/core';
import { WRITING_METHODS, asReadOnly } from './read-only-adapter';

/** an adapter that records what reached it */
function fake(extra: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const state = { secret: 'kept' };
  const method = (name: string) =>
    async function (this: unknown, ...args: unknown[]) {
      calls.push(`${name}(${args.length})`);
      // an adapter's methods use `this`: a proxy that loses it breaks every one of them
      return this === adapter ? state.secret : 'lost-this';
    };
  const adapter: Record<string, unknown> = {
    engine: 'postgres',
    capabilities: { query: true },
  };
  for (const name of [
    ...WRITING_METHODS,
    'browse',
    'query',
    'queryReadOnly',
    'getSchema',
    'ping',
    'backup',
    'listDatabases',
  ]) {
    adapter[name] = method(name);
  }
  Object.assign(adapter, extra);
  return { adapter: adapter as unknown as DatabaseAdapter, calls };
}

describe('the adapter of a read-only connection', () => {
  it('refuses every method that writes — by name, saying how to lift it — and none of them reaches the engine', async () => {
    const { adapter, calls } = fake();
    const guarded = asReadOnly(adapter, 'Production') as unknown as Record<
      string,
      (...a: unknown[]) => Promise<unknown>
    >;
    for (const name of WRITING_METHODS) {
      await expect(guarded[name]!({}), name).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(guarded[name]!({}), name).rejects.toThrow(
        /"Production" is a read-only connection.*Untick "Read-only"/,
      );
    }
    expect(calls).toEqual([]);
  });

  it('lets every read through, with the adapter’s own `this`', async () => {
    const { adapter, calls } = fake();
    const guarded = asReadOnly(adapter, 'Production') as unknown as Record<
      string,
      (...a: unknown[]) => Promise<unknown>
    >;
    for (const name of [
      'browse',
      'getSchema',
      'ping',
      'backup',
      'listDatabases',
      'queryReadOnly',
    ]) {
      expect(await guarded[name]!('x'), name).toBe('kept');
    }
    // `query` too: what Syncle itself runs on a SOURCE (a change stream's
    // publication) goes through it; the editor's statements are read at the route
    expect(await guarded.query!('SELECT 1')).toBe('kept');
    expect(calls).toHaveLength(7);
    expect(guarded.engine).toBe('postgres');
  });

  it('does not grow methods the engine does not have: callers feature-test them', () => {
    const { adapter } = fake({
      upsertRows: undefined,
      deleteRows: undefined,
      insertRows: undefined,
    });
    const guarded = asReadOnly(adapter, 'Production');
    expect(guarded.upsertRows).toBeUndefined();
    expect(guarded.deleteRows).toBeUndefined();
    expect(guarded.insertRows).toBeUndefined();
    expect(typeof guarded.insertRow).toBe('function');
  });
});

describe('what counts as writing', () => {
  /**
   * every method the adapter contract has is either refused on a read-only
   * connection or known to be a read. a method added to the contract and to
   * neither list fails here — before it can be a way around the guard
   */
  it('is decided for EVERY method of the adapter contract', () => {
    const READS = new Set([
      'connect',
      'close',
      'ping',
      'listDatabases',
      'getSchema',
      'browse',
      'query',
      'queryReadOnly',
      'backup',
      'withTransaction',
    ]);
    const source = readFileSync(
      join(__dirname, '../../../../packages/core/src/adapters/types.ts'),
      'utf8',
    );
    const start = source.indexOf('export interface DatabaseAdapter {');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    const methods = [...body.matchAll(/^ {2}(\w+)\??\s*[(<]/gm)].map(
      (m) => m[1]!,
    );
    expect(methods.length).toBeGreaterThan(15);
    const undecided = methods.filter(
      (m) =>
        !READS.has(m) && !(WRITING_METHODS as readonly string[]).includes(m),
    );
    expect(undecided).toEqual([]);
  });
});
