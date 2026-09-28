import { describe, expect, it } from 'vitest';
import { describeConnectionString, withDatabase, withHost } from './connection-string';

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

describe('withHost', () => {
  it('points the string at another host, keeping everything else', () => {
    expect(withHost('postgres://u:p@localhost:5432/app?sslmode=require', 'host.docker.internal')).toBe(
      'postgres://u:p@host.docker.internal:5432/app?sslmode=require',
    );
    expect(withHost('rediss://default:s3cret@127.0.0.1:6379/2', '192.168.65.254')).toBe(
      'rediss://default:s3cret@192.168.65.254:6379/2',
    );
  });

  it('leaves alone what it cannot or should not rewrite', () => {
    // a +srv host is a DNS record naming the servers, not an address to dial
    expect(withHost('mongodb+srv://u:p@cluster.example.com/app', 'h')).toBe(
      'mongodb+srv://u:p@cluster.example.com/app',
    );
    expect(withHost('not a url', 'h')).toBe('not a url');
    expect(withHost('postgres://u@db:5432/app', undefined)).toBe('postgres://u@db:5432/app');
    expect(withHost('postgres://u@db:5432/app', '  ')).toBe('postgres://u@db:5432/app');
    // already there: byte-for-byte unchanged, not re-serialised
    expect(withHost('postgres://u@db:5432/app', 'db')).toBe('postgres://u@db:5432/app');
  });
});
