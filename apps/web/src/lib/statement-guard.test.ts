import { describe, expect, it } from 'vitest';
import { statementVerdict } from './statement-guard';

const pg = (extra: Record<string, unknown> = {}) => ({
  engine: 'postgres' as const,
  ...extra,
});

describe('what the editor does before it sends a statement', () => {
  it('sends a read, on any connection, without a word', () => {
    for (const conn of [
      pg(),
      pg({ readOnly: true }),
      pg({ environment: 'production' }),
      pg({ readOnly: true, environment: 'production' }),
    ]) {
      expect(statementVerdict(conn, 'SELECT * FROM users')).toEqual({
        action: 'run',
      });
    }
  });

  it('sends an ordinary write on an ordinary connection', () => {
    expect(
      statementVerdict(pg(), `UPDATE users SET name = 'x' WHERE id = 1`),
    ).toEqual({ action: 'run' });
    expect(
      statementVerdict(
        pg({ environment: 'staging' }),
        'INSERT INTO t VALUES (1)',
      ),
    ).toEqual({ action: 'run' });
  });

  it('asks before anything that cannot be taken back, wherever it is', () => {
    for (const conn of [
      pg(),
      pg({ environment: 'development' }),
      pg({ environment: 'production' }),
    ]) {
      const verdict = statementVerdict(conn, 'DELETE FROM users');
      expect(verdict).toMatchObject({ action: 'confirm', why: 'destructive' });
      expect(
        verdict.action === 'confirm' && verdict.assessment.reasons,
      ).toEqual(['DELETE without WHERE']);
    }
    expect(statementVerdict({ engine: 'redis' }, 'FLUSHALL')).toMatchObject({
      action: 'confirm',
      why: 'destructive',
    });
    expect(
      statementVerdict(
        { engine: 'mongodb' },
        JSON.stringify({ collection: 'u', aggregate: [{ $out: 'u' }] }),
      ),
    ).toMatchObject({
      action: 'confirm',
    });
  });

  it('on production, asks before ANY write', () => {
    expect(
      statementVerdict(
        pg({ environment: 'production' }),
        `UPDATE users SET name = 'x' WHERE id = 1`,
      ),
    ).toMatchObject({
      action: 'confirm',
      why: 'production-write',
    });
    expect(
      statementVerdict(
        { engine: 'redis', environment: 'production' },
        'SET a 1',
      ),
    ).toMatchObject({ action: 'confirm', why: 'production-write' });
  });

  it('on a read-only connection, does not send what is not a read — not even to ask', () => {
    expect(
      statementVerdict(pg({ readOnly: true }), 'DROP TABLE users'),
    ).toMatchObject({ action: 'refuse' });
    expect(
      statementVerdict(
        pg({ readOnly: true, environment: 'production' }),
        'INSERT INTO t VALUES (1)',
      ),
    ).toMatchObject({ action: 'refuse' });
    // what cannot be told to be a read is not one
    expect(
      statementVerdict(pg({ readOnly: true }), 'CALL something()'),
    ).toMatchObject({ action: 'refuse' });
  });
});
