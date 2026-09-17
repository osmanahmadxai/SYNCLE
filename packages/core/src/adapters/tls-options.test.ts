/**
 * tls-options: what "TLS" means is decided once, for every driver — and a
 * connection saved under the old on/off switch keeps exactly what it had.
 */
import type { PeerCertificate } from 'node:tls';
import { describe, expect, it } from 'vitest';
import type { ConnectionConfig, DatabaseEngine, TlsConfig } from './types';
import {
  effectiveTls,
  mongoTlsOptions,
  mysqlTlsOptions,
  nodeTlsOptions,
  tlsServerName,
  verifyPeerIdentity,
} from './tls-options';

const conn = (over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: 'c',
  name: 'c',
  workspaceId: 'w',
  engine: 'postgres',
  host: 'db.example.com',
  createdAt: '',
  updatedAt: '',
  ...over,
});
const withTls = (
  tls: TlsConfig,
  over: Partial<ConnectionConfig> = {},
): ConnectionConfig => conn({ tls, ...over });

/** a certificate as Node hands it to checkServerIdentity */
const certFor = (names: string[], ips: string[] = []): PeerCertificate =>
  ({
    subject: { CN: names[0] ?? 'x' },
    subjectaltname: [
      ...names.map((n) => `DNS:${n}`),
      ...ips.map((i) => `IP Address:${i}`),
    ].join(', '),
  }) as unknown as PeerCertificate;

const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

describe('effectiveTls: connections saved before TLS modes existed', () => {
  it('no switch, no TLS', () => {
    for (const engine of [
      'postgres',
      'mysql',
      'mongodb',
      'redis',
    ] as DatabaseEngine[]) {
      expect(effectiveTls(conn({ engine })).mode).toBe('disable');
    }
  });

  it('keeps what the switch did on each engine, so an upgrade refuses nothing that worked', () => {
    expect(effectiveTls(conn({ engine: 'postgres', ssl: true })).mode).toBe(
      'require',
    );
    expect(effectiveTls(conn({ engine: 'mysql', ssl: true })).mode).toBe(
      'require',
    );
    // Redis passed `tls: {}`, which verifies against the system CAs
    expect(effectiveTls(conn({ engine: 'redis', ssl: true })).mode).toBe(
      'verify-full',
    );
    // Postgres' undocumented opt-in
    expect(
      effectiveTls(
        conn({ engine: 'postgres', ssl: true, options: { sslVerify: true } }),
      ).mode,
    ).toBe('verify-full');
  });

  it('MongoDB was plaintext despite the switch; it now gets the TLS that was asked for', () => {
    expect(effectiveTls(conn({ engine: 'mongodb', ssl: true })).mode).toBe(
      'require',
    );
    expect(mongoTlsOptions(conn({ engine: 'mongodb', ssl: true })).tls).toBe(
      true,
    );
  });

  it('an explicit setting always wins over the old switch', () => {
    expect(
      effectiveTls(withTls({ mode: 'verify-ca' }, { ssl: false })).mode,
    ).toBe('verify-ca');
    expect(effectiveTls(withTls({ mode: 'disable' }, { ssl: true })).mode).toBe(
      'disable',
    );
  });
});

describe('nodeTlsOptions (pg, ioredis)', () => {
  it('disable: no TLS at all', () => {
    expect(nodeTlsOptions(withTls({ mode: 'disable' }))).toBeUndefined();
  });

  it('require: encrypted, nothing verified — and it says so by not pretending', () => {
    expect(nodeTlsOptions(withTls({ mode: 'require', ca: CA }))).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('verify-ca: the chain is checked, the name deliberately is not', () => {
    const o = nodeTlsOptions(withTls({ mode: 'verify-ca', ca: CA }))!;
    expect(o.rejectUnauthorized).toBe(true);
    expect(o.ca).toBe(CA);
    expect(
      o.checkServerIdentity!(
        'db.example.com',
        certFor(['someone-else.example']),
      ),
    ).toBeUndefined();
  });

  it('verify-full: the certificate must be for the host that was dialled', () => {
    const o = nodeTlsOptions(withTls({ mode: 'verify-full', ca: CA }))!;
    expect(o.rejectUnauthorized).toBe(true);
    expect(o.servername).toBe('db.example.com');
    expect(
      o.checkServerIdentity!('ignored', certFor(['db.example.com'])),
    ).toBeUndefined();
    expect(
      o.checkServerIdentity!('ignored', certFor(['evil.example'])),
    ).toBeInstanceOf(Error);
  });

  it('without a CA the system store is used, not "anything goes"', () => {
    const o = nodeTlsOptions(withTls({ mode: 'verify-full' }))!;
    expect(o.rejectUnauthorized).toBe(true);
    expect('ca' in o).toBe(false);
  });

  it('through an SSH tunnel it still verifies the DATABASE host, not 127.0.0.1', () => {
    // what the tunnel service hands the adapter
    const tunnelled = withTls(
      { mode: 'verify-full' },
      {
        host: '127.0.0.1',
        port: 50123,
        tlsHostOverride: 'db.internal.example',
      },
    );
    const o = nodeTlsOptions(tunnelled)!;
    expect(o.servername).toBe('db.internal.example');
    // the driver passes the address it dialled; that must not be what is checked
    expect(
      o.checkServerIdentity!('127.0.0.1', certFor(['db.internal.example'])),
    ).toBeUndefined();
    expect(
      o.checkServerIdentity!('127.0.0.1', certFor(['127.0.0.1'])),
    ).toBeInstanceOf(Error);
  });

  it('an explicit server name beats both', () => {
    const c = withTls(
      { mode: 'verify-full', servername: 'pg.prod.example' },
      { host: '10.0.0.5' },
    );
    expect(tlsServerName(c)).toBe('pg.prod.example');
    expect(nodeTlsOptions(c)!.servername).toBe('pg.prod.example');
  });

  it('an IP address is never sent as SNI, but is still checked against IP SANs', () => {
    const o = nodeTlsOptions(
      withTls({ mode: 'verify-full' }, { host: '10.0.0.5' }),
    )!;
    expect(o.servername).toBeUndefined(); // RFC 6066
    expect(
      o.checkServerIdentity!('10.0.0.5', certFor(['db'], ['10.0.0.5'])),
    ).toBeUndefined();
    expect(
      o.checkServerIdentity!('10.0.0.5', certFor(['db'], ['10.0.0.9'])),
    ).toBeInstanceOf(Error);
  });

  it('carries a client certificate in every mode that uses TLS', () => {
    for (const mode of ['require', 'verify-ca', 'verify-full'] as const) {
      expect(
        nodeTlsOptions(withTls({ mode, cert: 'CERT', key: 'KEY' })),
      ).toMatchObject({
        cert: 'CERT',
        key: 'KEY',
      });
    }
  });

  it('blank fields are absent, not empty strings a TLS stack would choke on', () => {
    const o = nodeTlsOptions(
      withTls({ mode: 'verify-ca', ca: '  ', cert: '', key: '' }),
    )!;
    expect(Object.keys(o).sort()).toEqual([
      'checkServerIdentity',
      'rejectUnauthorized',
    ]);
  });
});

describe('mysqlTlsOptions', () => {
  it('no longer hard-codes rejectUnauthorized: false', () => {
    expect(mysqlTlsOptions(withTls({ mode: 'require' }))).toMatchObject({
      rejectUnauthorized: false,
    });
    expect(
      mysqlTlsOptions(withTls({ mode: 'verify-ca', ca: CA })),
    ).toMatchObject({
      rejectUnauthorized: true,
      ca: CA,
    });
    expect(mysqlTlsOptions(withTls({ mode: 'verify-full' }))).toMatchObject({
      rejectUnauthorized: true,
    });
    expect(mysqlTlsOptions(withTls({ mode: 'disable' }))).toBeUndefined();
  });
});

describe('verifyPeerIdentity (for drivers with no hook of their own)', () => {
  const full = withTls({ mode: 'verify-full' });

  it('passes a certificate issued for the host, fails any other', () => {
    expect(verifyPeerIdentity(full, certFor(['db.example.com']))).toBeNull();
    expect(verifyPeerIdentity(full, certFor(['other.example']))).toMatch(
      /^TLS: /,
    );
  });

  it('checks an IP host against IP SANs — the case mysql2 skips entirely', () => {
    const ip = withTls({ mode: 'verify-full' }, { host: '10.0.0.5' });
    expect(verifyPeerIdentity(ip, certFor(['db'], ['10.0.0.5']))).toBeNull();
    expect(verifyPeerIdentity(ip, certFor(['db'], ['10.0.0.6']))).toMatch(
      /TLS/,
    );
  });

  it('a missing certificate is a failure, not a pass', () => {
    expect(verifyPeerIdentity(full, undefined)).toMatch(/no certificate/);
    expect(verifyPeerIdentity(full, {} as PeerCertificate)).toMatch(
      /no certificate/,
    );
  });

  it('only applies to verify-full', () => {
    for (const mode of ['disable', 'require', 'verify-ca'] as const) {
      expect(
        verifyPeerIdentity(withTls({ mode }), certFor(['wrong.example'])),
      ).toBeNull();
    }
  });
});

describe('mongoTlsOptions', () => {
  const mongo = (
    tls: TlsConfig,
    over: Partial<ConnectionConfig> = {},
  ): ConnectionConfig => withTls(tls, { engine: 'mongodb', ...over });

  it('maps each mode onto the driver’s own switches', () => {
    expect(mongoTlsOptions(mongo({ mode: 'disable' }))).toEqual({ tls: false });
    expect(mongoTlsOptions(mongo({ mode: 'require' }))).toEqual({
      tls: true,
      tlsAllowInvalidCertificates: true,
      tlsAllowInvalidHostnames: true,
    });
    expect(mongoTlsOptions(mongo({ mode: 'verify-ca', ca: CA }))).toEqual({
      tls: true,
      ca: CA,
      tlsAllowInvalidHostnames: true,
    });
    const full = mongoTlsOptions(mongo({ mode: 'verify-full', ca: CA }));
    expect(full).toMatchObject({ tls: true, ca: CA });
    expect('tlsAllowInvalidCertificates' in full).toBe(false);
    expect('tlsAllowInvalidHostnames' in full).toBe(false);
  });

  it('leaves a connection string to say what it says, unless TLS was set explicitly', () => {
    const uri = 'mongodb+srv://u:p@cluster.example/?tls=true';
    expect(
      mongoTlsOptions(
        conn({ engine: 'mongodb', connectionString: uri, ssl: true }),
      ),
    ).toEqual({});
    expect(
      mongoTlsOptions(
        mongo({ mode: 'verify-ca', ca: CA }, { connectionString: uri }),
      ),
    ).toMatchObject({ tls: true, ca: CA });
  });
});
