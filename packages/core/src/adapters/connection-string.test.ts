import { describe, expect, it } from 'vitest';
import { describeConnectionString, withDatabase } from './connection-string';

describe('withDatabase', () => {
  it('points the string at the chosen database, keeping everything else', () => {
    expect(
      withDatabase(
        'postgres://app:s3cret@db.internal:5433/main?sslmode=require',
        'analytics',
      ),
    ).toBe('postgres://app:s3cret@db.internal:5433/analytics?sslmode=require');
    expect(withDatabase('mysql://root@localhost/shop', 'shop_eu')).toBe(
      'mysql://root@localhost/shop_eu',
    );
  });

  it('adds a database to a string that names none', () => {
    expect(withDatabase('postgres://app@db.internal', 'main')).toBe(
      'postgres://app@db.internal/main',
    );
  });

  it('leaves the string alone when there is nothing to change', () => {
    const uri = 'postgres://app:p%40ss@db.internal/main';
    expect(withDatabase(uri, undefined)).toBe(uri);
    expect(withDatabase(uri, '  ')).toBe(uri);
    // byte for byte: re-serialising could re-encode the password
    expect(withDatabase(uri, 'main')).toBe(uri);
  });

  it('encodes a name that needs it, and reads one that was', () => {
    expect(withDatabase('postgres://h/x', 'my db/2')).toBe(
      'postgres://h/my%20db%2F2',
    );
    expect(withDatabase('postgres://h/my%20db', 'my db')).toBe(
      'postgres://h/my%20db',
    );
  });

  it('does not mangle a string it cannot parse', () => {
    expect(withDatabase('host=db.internal dbname=main', 'other')).toBe(
      'host=db.internal dbname=main',
    );
  });
});

describe('describeConnectionString', () => {
  it('says where it points, never with what password', () => {
    const d = describeConnectionString(
      'postgres://app%40corp:s3cret@db.internal:5433/main?sslmode=require',
    );
    expect(d).toEqual({
      host: 'db.internal',
      port: 5433,
      database: 'main',
      user: 'app@corp',
    });
    expect(JSON.stringify(d)).not.toContain('s3cret');
  });

  it('copes with the minimum and with junk', () => {
    expect(describeConnectionString('redis://cache')).toEqual({
      host: 'cache',
      port: null,
      database: null,
      user: null,
    });
    expect(describeConnectionString('not a url')).toEqual({
      host: null,
      port: null,
      database: null,
      user: null,
    });
  });
});
