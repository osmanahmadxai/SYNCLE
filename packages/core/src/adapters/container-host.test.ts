/**
 * A loopback address, from inside a container, means the database on the machine
 * running Syncle — except where it doesn't, which is most of what is tested here.
 */
import { describe, expect, it } from 'vitest';
import {
  isLoopbackHost,
  reachHostFromContainer,
  type HostReach,
} from './container-host';
import type { ConnectionConfig } from './types';

const inside: HostReach = {
  inContainer: () => true,
  gateway: async () => 'host.docker.internal',
};
const outside: HostReach = { inContainer: () => false, gateway: async () => null };
const noGateway: HostReach = { inContainer: () => true, gateway: async () => null };

const conn = (over: Partial<ConnectionConfig> = {}): ConnectionConfig =>
  ({
    id: 'c1',
    name: 'db',
    engine: 'postgres',
    host: 'localhost',
    port: 5432,
    user: 'u',
    password: 'p',
    database: 'app',
    workspaceId: 'w',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as ConnectionConfig;

describe('what counts as this machine', () => {
  it('names and addresses that mean loopback', () => {
    for (const h of ['localhost', 'LOCALHOST', ' localhost ', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '0.0.0.0'])
      expect(isLoopbackHost(h), h).toBe(true);
  });

  it('and everything that does not', () => {
    for (const h of [undefined, '', 'db.internal', '10.0.0.5', '192.168.1.9', 'localhost.example.com', '128.0.0.1'])
      expect(isLoopbackHost(h), String(h)).toBe(false);
  });
});

describe('a loopback address in a container', () => {
  it('is dialled at the host instead', async () => {
    const out = await reachHostFromContainer(conn(), inside);
    expect(out.host).toBe('host.docker.internal');
    // nothing else moves
    expect({ ...out, host: 'localhost' }).toEqual(conn());
  });

  it('is corrected inside a connection string too', async () => {
    const out = await reachHostFromContainer(
      conn({ host: undefined, connectionString: 'postgres://u:p@127.0.0.1:5432/app?sslmode=require' }),
      inside,
    );
    expect(out.connectionString).toBe('postgres://u:p@host.docker.internal:5432/app?sslmode=require');
  });

  it('keeps the certificate check pointed at the name that was asked for', async () => {
    const out = await reachHostFromContainer(conn({ tls: { mode: 'verify-full' } }), inside);
    expect(out.host).toBe('host.docker.internal');
    expect(out.tls).toEqual({ mode: 'verify-full', servername: 'localhost' });
  });

  it('does not overrule a server name that was given', async () => {
    const out = await reachHostFromContainer(
      conn({ tls: { mode: 'verify-full', servername: 'db.example.com' } }),
      inside,
    );
    expect(out.tls?.servername).toBe('db.example.com');
  });
});

describe('what it leaves alone', () => {
  it('a connection that tunnels: localhost there is the bastion’s own, and is meant', async () => {
    const tunnelled = conn({ ssh: { enabled: true, host: 'bastion', port: 22, user: 'j' } as never });
    expect(await reachHostFromContainer(tunnelled, inside)).toEqual(tunnelled);
  });

  it('anything outside a container', async () => {
    expect(await reachHostFromContainer(conn(), outside)).toEqual(conn());
  });

  it('an address that is not loopback', async () => {
    const remote = conn({ host: 'db.internal' });
    expect(await reachHostFromContainer(remote, inside)).toEqual(remote);
  });

  it('SQLite, which is a file and not a socket', async () => {
    const file = conn({ engine: 'sqlite', host: undefined, database: '/data/app.sqlite' });
    expect(await reachHostFromContainer(file, inside)).toEqual(file);
  });

  it('a container with no way to reach its host', async () => {
    expect(await reachHostFromContainer(conn(), noGateway)).toEqual(conn());
  });

  it('a mongodb+srv URI, whose host is a DNS record and not an address', async () => {
    const srv = conn({
      engine: 'mongodb',
      host: undefined,
      connectionString: 'mongodb+srv://u:p@localhost/app',
    });
    expect(await reachHostFromContainer(srv, inside)).toEqual(srv);
  });
});
