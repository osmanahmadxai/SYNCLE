import 'reflect-metadata';
import { EventEmitter, once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { PassThrough, type Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ConnectConfig } from 'ssh2';
import { ConnectionError, type ConnectionConfig } from '@syncle/core';
import { SshTunnelService, type SshClientLike } from './ssh-tunnel.service';

/** in-memory ssh2 stand-in: no real SSH anywhere near these tests */
class StubSshClient extends EventEmitter implements SshClientLike {
  connectConfig?: ConnectConfig;
  forwardCalls: Array<{ dstIP: string; dstPort: number }> = [];
  /** when set, connect() emits this instead of 'ready' */
  failWith?: Error;
  /** when set, every forwardOut() is refused with this */
  refuseForwardWith?: Error;
  ended = false;

  connect(config: ConnectConfig): this {
    this.connectConfig = config;
    queueMicrotask(() => {
      if (this.failWith) this.emit('error', this.failWith);
      else this.emit('ready');
    });
    return this;
  }

  forwardOut(
    _srcIP: string,
    _srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (err: Error | undefined, stream: Duplex) => void,
  ): void {
    this.forwardCalls.push({ dstIP, dstPort });
    if (this.refuseForwardWith) {
      callback(this.refuseForwardWith, undefined as unknown as Duplex);
      return;
    }
    // a PassThrough makes the "remote database" an echo server
    callback(undefined, new PassThrough());
  }

  end(): this {
    this.ended = true;
    this.emit('close');
    return this;
  }
}

function makeService(client: StubSshClient): SshTunnelService {
  const service = new SshTunnelService();
  service.createClient = () => client;
  return service;
}

function config(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  const now = new Date().toISOString();
  return {
    id: 'c1',
    name: 'Remote PG',
    workspaceId: 'ws',
    engine: 'postgres',
    host: 'db.internal',
    port: 5432,
    user: 'app',
    password: 'secret',
    ssh: {
      enabled: true,
      host: 'bastion.example.com',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      password: 'hunter2',
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const dial = (port: number): Socket => connect({ port, host: '127.0.0.1' });

describe('SshTunnelService', () => {
  it('opens nothing when ssh is absent, disabled, or the engine is sqlite', async () => {
    const service = makeService(new StubSshClient());
    await expect(service.openFor(config({ ssh: undefined }))).resolves.toBeUndefined();
    const c = config();
    await expect(
      service.openFor({ ...c, ssh: { ...c.ssh!, enabled: false } }),
    ).resolves.toBeUndefined();
    await expect(
      service.openFor(config({ engine: 'sqlite', database: '/tmp/x.db' })),
    ).resolves.toBeUndefined();
  });

  it('rewrites the adapter config to the loopback port, leaving the rest alone', async () => {
    const client = new StubSshClient();
    const service = makeService(client);
    const original = config();
    const tunnel = (await service.openFor(original))!;
    try {
      const rewritten = service.reroute(original, tunnel);
      expect(rewritten.host).toBe('127.0.0.1');
      expect(rewritten.port).toBe(tunnel.localPort);
      expect(rewritten.user).toBe('app');
      expect(rewritten.password).toBe('secret');
      // the original config is untouched
      expect(original.host).toBe('db.internal');
      expect(original.port).toBe(5432);
      // and without a tunnel, reroute is the identity
      expect(service.reroute(original, undefined)).toBe(original);
    } finally {
      await tunnel.close();
    }
  });

  it('dials the jump host with password auth', async () => {
    const client = new StubSshClient();
    const service = makeService(client);
    const tunnel = (await service.openFor(config()))!;
    try {
      expect(client.connectConfig).toMatchObject({
        host: 'bastion.example.com',
        port: 22,
        username: 'deploy',
        password: 'hunter2',
      });
      expect(client.connectConfig).not.toHaveProperty('privateKey');
    } finally {
      await tunnel.close();
    }
  });

  it('dials the jump host with private-key auth', async () => {
    const client = new StubSshClient();
    const service = makeService(client);
    const c = config();
    const tunnel = (await service.openFor({
      ...c,
      ssh: {
        ...c.ssh!,
        authMethod: 'privateKey',
        password: undefined,
        privateKey: 'PEM',
        passphrase: 'pp',
      },
    }))!;
    try {
      expect(client.connectConfig).toMatchObject({
        privateKey: 'PEM',
        passphrase: 'pp',
      });
      expect(client.connectConfig).not.toHaveProperty('password');
    } finally {
      await tunnel.close();
    }
  });

  it('forwards local sockets through the client to the configured db host', async () => {
    const client = new StubSshClient();
    const service = makeService(client);
    const tunnel = (await service.openFor(config()))!;
    try {
      const socket = dial(tunnel.localPort);
      await once(socket, 'connect');
      socket.write('ping');
      const [reply] = (await once(socket, 'data')) as [Buffer];
      // the stub's PassThrough echoes, proving bytes went through the forward
      expect(reply.toString()).toBe('ping');
      expect(client.forwardCalls).toEqual([{ dstIP: 'db.internal', dstPort: 5432 }]);
      socket.destroy();
    } finally {
      await tunnel.close();
    }
  });

  it('falls back to the driver default when the db port is omitted', async () => {
    const client = new StubSshClient();
    const service = makeService(client);
    const tunnel = (await service.openFor(config({ port: undefined })))!;
    try {
      const socket = dial(tunnel.localPort);
      await once(socket, 'connect');
      socket.write('x');
      await once(socket, 'data');
      expect(client.forwardCalls[0]?.dstPort).toBe(5432);
      socket.destroy();
    } finally {
      await tunnel.close();
    }
  });

  it('rejects a tunnel with no database host to forward to', async () => {
    const service = makeService(new StubSshClient());
    await expect(service.openFor(config({ host: undefined }))).rejects.toThrow(
      /^SSH: .*host/,
    );
  });

  it('surfaces auth failures as ConnectionError with an SSH prefix', async () => {
    const client = new StubSshClient();
    client.failWith = new Error('All configured authentication methods failed');
    const service = makeService(client);
    const err = await service.openFor(config()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as Error).message).toBe(
      'SSH: All configured authentication methods failed',
    );
    expect(client.ended).toBe(true);
  });

  it('records a refused forward so the caller can surface it', async () => {
    const client = new StubSshClient();
    client.refuseForwardWith = new Error('administratively prohibited');
    const service = makeService(client);
    const tunnel = (await service.openFor(config()))!;
    try {
      const socket = dial(tunnel.localPort);
      // the local socket is severed when the ssh forward is refused
      await once(socket, 'close');
      const err = tunnel.takeError();
      expect(err).toBeInstanceOf(ConnectionError);
      expect(err?.message).toMatch(
        /^SSH: port forward to db\.internal:5432 failed/,
      );
      // taking the error clears it
      expect(tunnel.takeError()).toBeUndefined();
    } finally {
      await tunnel.close();
    }
  });

  it('close() stops accepting connections and ends the ssh client', async () => {
    const client = new StubSshClient();
    const service = makeService(client);
    const tunnel = (await service.openFor(config()))!;
    const port = tunnel.localPort;
    await tunnel.close();
    expect(client.ended).toBe(true);
    const refused = dial(port);
    await expect(once(refused, 'connect')).rejects.toThrow();
  });

  it('a dropped ssh connection tears the tunnel down and notifies listeners', async () => {
    const client = new StubSshClient();
    const service = makeService(client);
    const tunnel = (await service.openFor(config()))!;
    let notified = 0;
    tunnel.onClose(() => (notified += 1));

    client.emit('error', new Error('read ECONNRESET'));

    expect(notified).toBe(1);
    expect(tunnel.takeError()?.message).toBe('SSH: read ECONNRESET');
    // give the listener handle a beat to finish closing before probing it
    await new Promise((resolve) => setTimeout(resolve, 20));
    const refused = dial(tunnel.localPort);
    await expect(once(refused, 'connect')).rejects.toThrow();
    // a later deliberate close is a no-op, and never re-notifies
    await tunnel.close();
    expect(notified).toBe(1);
  });
});
