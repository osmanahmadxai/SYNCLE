import { describe, expect, it } from 'vitest';
import { assessStatement, maskSql } from './statement-safety';

const pg = (sql: string) => assessStatement('postgres', sql);

describe('reading a SQL statement', () => {
  it('knows a read when it sees one', () => {
    for (const sql of [
      'SELECT * FROM users',
      '  select 1;  ',
      "WITH recent AS (SELECT * FROM orders WHERE at > now() - interval '1 day') SELECT count(*) FROM recent",
      'SHOW search_path',
      'EXPLAIN SELECT * FROM users',
      'EXPLAIN ANALYZE SELECT * FROM users',
      'TABLE users',
      'VALUES (1), (2)',
      'DESCRIBE users',
      'PRAGMA table_info',
      'SELECT 1; SELECT 2',
      'SELECT * FROM users FOR UPDATE',
    ]) {
      expect(pg(sql).risk, sql).toBe('read');
    }
    expect(pg('SELECT 1; SELECT 2').statements).toBe(2);
  });

  it('is not fooled by what is inside a string, a quoted name or a comment', () => {
    expect(
      pg(`SELECT 'DROP TABLE users; DELETE FROM x' AS note`),
    ).toMatchObject({ risk: 'read', statements: 1 });
    expect(pg(`SELECT "delete", \`update\` FROM t -- DROP TABLE t`).risk).toBe(
      'read',
    );
    expect(pg(`SELECT 1 /* ; TRUNCATE t */`)).toMatchObject({
      risk: 'read',
      statements: 1,
    });
    expect(pg(`SELECT $body$ DROP TABLE users; $body$`)).toMatchObject({
      risk: 'read',
      statements: 1,
    });
    expect(pg(`SELECT 'it''s; DROP TABLE t'`)).toMatchObject({
      risk: 'read',
      statements: 1,
    });
    expect(pg(`SELECT 'a\\'; DROP TABLE t; --'`).statements).toBe(1);
    // …and a write hidden BEHIND a comment is still found
    expect(pg(`SELECT 1; -- harmless\nDROP TABLE users`).risk).toBe(
      'destructive',
    );
    expect(pg(`/* SELECT */ DELETE FROM users`).risk).toBe('destructive');
  });

  it('finds the write a read is carrying', () => {
    expect(
      pg(
        'WITH gone AS (DELETE FROM users WHERE id = 1 RETURNING *) SELECT * FROM gone',
      ),
    ).toMatchObject({ risk: 'write', reasons: ['DELETE'] });
    expect(
      pg('WITH gone AS (DELETE FROM users RETURNING *) SELECT * FROM gone')
        .risk,
    ).toBe('destructive');
    expect(pg('SELECT * INTO backup FROM users')).toMatchObject({
      risk: 'write',
      reasons: ['SELECT … INTO'],
    });
    expect(
      assessStatement('mysql', `SELECT * FROM users INTO OUTFILE '/tmp/x'`)
        .risk,
    ).toBe('write');
    expect(pg('EXPLAIN ANALYZE DELETE FROM users WHERE id = 1')).toMatchObject({
      risk: 'write',
      reasons: ['EXPLAIN ANALYZE DELETE'],
    });
    expect(assessStatement('sqlite', 'PRAGMA journal_mode = WAL').risk).toBe(
      'write',
    );
    expect(assessStatement('sqlite', 'PRAGMA wal_checkpoint(FULL)').risk).toBe(
      'write',
    );
  });

  it('calls a write a write, and what is not known not a read', () => {
    for (const sql of [
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET a = 1 WHERE id = 2',
      'DELETE FROM t WHERE id = 2',
      'CREATE TABLE t (id int)',
      'ALTER TABLE t ADD COLUMN c int',
      'GRANT ALL ON t TO someone',
      'CALL refresh_everything()',
      'DO $$ BEGIN DELETE FROM t; END $$',
      'SET default_transaction_read_only = off',
      'BEGIN',
      'COMMIT',
      'COPY t FROM STDIN',
      'VACUUM FULL',
      'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = s.a',
      'FROBNICATE t',
    ]) {
      expect(pg(sql).risk, sql).toBe('write');
    }
  });

  it('calls out what cannot be taken back', () => {
    expect(pg('DROP TABLE users')).toMatchObject({
      risk: 'destructive',
      reasons: ['DROP TABLE'],
    });
    expect(pg('drop database prod').reasons).toEqual(['DROP DATABASE']);
    expect(pg('TRUNCATE users, orders').risk).toBe('destructive');
    expect(pg('DELETE FROM users')).toMatchObject({
      risk: 'destructive',
      reasons: ['DELETE without WHERE'],
    });
    expect(pg('UPDATE users SET active = false').reasons).toEqual([
      'UPDATE without WHERE',
    ]);
    expect(pg('ALTER TABLE users DROP COLUMN email').reasons).toEqual([
      'ALTER … DROP',
    ]);
    // the WHERE has to be the statement's own, not a word in a string
    expect(pg(`DELETE FROM users /* WHERE id = 1 */`).risk).toBe('destructive');
    expect(pg(`UPDATE users SET note = 'WHERE it all began'`).risk).toBe(
      'destructive',
    );
  });

  it('is as bad as its worst statement, and says why for each', () => {
    expect(
      pg('SELECT 1; UPDATE t SET a = 1 WHERE id = 1; DROP TABLE t'),
    ).toEqual({
      risk: 'destructive',
      statements: 3,
      reasons: ['UPDATE', 'DROP TABLE'],
    });
    expect(pg('')).toEqual({ risk: 'read', statements: 0, reasons: [] });
    expect(pg(' ; ;; ')).toMatchObject({ statements: 0 });
  });
});

describe('maskSql', () => {
  it('leaves the statement’s own words and nothing else', () => {
    expect(
      maskSql(`SELECT 'x;y' -- c\nFROM t`).replace(/\s+/g, ' ').trim(),
    ).toBe(`SELECT '' FROM t`);
    expect(maskSql('SELECT "a;b" FROM t').replace(/\s+/g, ' ').trim()).toBe(
      'SELECT "x" FROM t',
    );
    // an unterminated string swallows the rest rather than exposing it
    expect(maskSql(`SELECT 'oops; DROP TABLE t`)).not.toContain('DROP');
  });
});

describe('reading Redis commands', () => {
  const redis = (text: string) => assessStatement('redis', text);
  it('reads, writes, and the ones that empty a database', () => {
    expect(
      redis('GET user:1\nHGETALL user:1\nSCAN 0 MATCH user:* COUNT 100'),
    ).toEqual({ risk: 'read', statements: 3, reasons: [] });
    expect(redis('# a comment\nget user:1').risk).toBe('read');
    expect(redis('SET user:1 x')).toMatchObject({
      risk: 'write',
      reasons: ['SET'],
    });
    expect(redis('DEL user:1').risk).toBe('write');
    expect(redis('EVAL "return redis.call(\'flushall\')" 0').risk).toBe(
      'write',
    );
    expect(redis('GET a\nFLUSHALL')).toMatchObject({
      risk: 'destructive',
      reasons: ['FLUSHALL'],
    });
    expect(redis('flushdb').risk).toBe('destructive');
    expect(redis('CONFIG GET maxmemory').risk).toBe('read');
    expect(redis('CONFIG SET maxmemory 1').risk).toBe('destructive');
    expect(redis('SOMETHINGNEW key').risk).toBe('write');
  });
});

describe('reading a MongoDB command document', () => {
  const mongo = (doc: unknown) =>
    assessStatement(
      'mongodb',
      typeof doc === 'string' ? doc : JSON.stringify(doc),
    );
  it('find, aggregate and count read — unless the pipeline writes', () => {
    expect(mongo({ collection: 'users', find: { active: true } }).risk).toBe(
      'read',
    );
    expect(
      mongo('// a comment\n{ "collection": "users", "find": {} }').risk,
    ).toBe('read');
    expect(mongo({ collection: 'users', countDocuments: {} }).risk).toBe(
      'read',
    );
    expect(
      mongo({
        collection: 'users',
        aggregate: [{ $group: { _id: '$country' } }],
      }).risk,
    ).toBe('read');
    expect(
      mongo({
        collection: 'users',
        aggregate: [{ $match: {} }, { $merge: { into: 'other' } }],
      }),
    ).toMatchObject({ risk: 'write', reasons: ['$merge'] });
    // $out REPLACES the collection it names
    expect(
      mongo({ collection: 'users', aggregate: [{ $out: 'users' }] }),
    ).toMatchObject({ risk: 'destructive', reasons: ['$out'] });
    expect(mongo({ collection: 'users', deleteMany: {} }).risk).toBe('write');
    expect(mongo('not json').risk).toBe('write');
  });
});
