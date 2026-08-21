/**
 * SSH tunnels for databases that are only reachable through a jump host.
 *
 * one tunnel = one ssh2 client plus a loopback TCP listener on an ephemeral
 * port: every socket accepted locally is forwarded through the SSH connection
 * to the configured database host/port, so the adapter simply dials
 * 127.0.0.1:<localPort> and never needs to know the tunnel exists. the tunnel
 * lives and dies with the adapter that uses it (see AdapterPoolService).
 *
 * every ssh-level failure is normalized to a ConnectionError with an
 * "SSH: ..." prefix so connection tests read unambiguously.
 */
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { Client, type ConnectConfig } from 'ssh2';
import { getDriver } from '@syncle/core/adapters';
import { ConnectionError, type ConnectionConfig } from '@syncle/core';

/** the slice of the ssh2 Client the tunnel uses — stubbed in unit tests */
export interface SshClientLike {
  once(event: 'ready', listener: () => void): this;
  once(event: 'error', listener: (err: Error) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  removeListener(event: 'error', listener: (err: Error) => void): this;
  connect(config: ConnectConfig): this;
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (err: Error | undefined, stream: Duplex) => void,
  ): void;
  end(): unknown;
}

const prefixed = (message: string): ConnectionError =>
  new ConnectionError(
    message.startsWith('SSH: ') ? message : `SSH: ${message}`,
  );

/**
 * a live tunnel. `localPort` is where the adapter connects; `close()` tears
 * everything down; `onClose` fires only when the tunnel dies underneath us
 * (never on a deliberate close), so the pool can evict the orphaned adapter.
 */
export class SshTunnel {
  readonly localHost = '127.0.0.1';
  private closed = false;
  private readonly sockets = new Set<Socket>();
  private readonly closeListeners: Array<() => void> = [];
  /** last ssh-level failure (e.g. a refused forward), kept for the caller */
  private lastError: ConnectionError | undefined;

  constructor(
    readonly localPort: number,
    private readonly client: SshClientLike,
    private readonly server: Server,
  ) {}

  /** register a socket piped through the tunnel so close() can sever it */
  track(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
  }

  recordError(message: string): void {
    this.lastError = prefixed(message);
  }

  /**
   * pop the last ssh-level failure. a refused forward reaches the adapter as
   * a bare socket reset, so callers ask the tunnel for the real story when a
   * connect attempt fails
   */
  takeError(): ConnectionError | undefined {
    const err = this.lastError;
    this.lastError = undefined;
    return err;
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  /** the ssh connection dropped underneath us — tear down and notify */
  markDead(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (err) this.lastError = prefixed(err.message);
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server.close(() => {});
    this.client.end();
    for (const listener of this.closeListeners) listener();
  }

  /** deliberate teardown (adapter evicted / test finished). never notifies */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.client.end();
  }
}

@Injectable()
export class SshTunnelService {
  private readonly logger = new Logger('SshTunnel');

  /** factory for the underlying ssh2 client — replaced with a stub in tests */
  createClient: () => SshClientLike = () => new Client();

  /**
   * open a tunnel for a connection, or return undefined when the config
   * doesn't ask for one (sqlite never tunnels — it's a local file)
   */
  async openFor(config: ConnectionConfig): Promise<SshTunnel | undefined> {
    if (!config.ssh?.enabled || config.engine === 'sqlite') return undefined;
    return this.open(config);
  }

  /** point the adapter at the tunnel instead of the (unreachable) db host */
  reroute(
    config: ConnectionConfig,
    tunnel: SshTunnel | undefined,
  ): ConnectionConfig {
    if (!tunnel) return config;
    return { ...config, host: tunnel.localHost, port: tunnel.localPort };
  }

  private async open(config: ConnectionConfig): Promise<SshTunnel> {
    const ssh = config.ssh!;
    const dbHost = config.host;
    const dbPort = config.port ?? getDriver(config.engine)?.defaultPort;
    if (!dbHost || !dbPort) {
      throw prefixed('a database host and port are required to tunnel');
    }

    const client = this.createClient();

    // 1) dial the jump host. auth failures and unreachable hosts land here
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        client.end();
        reject(prefixed(err.message));
      };
      client.once('ready', () => {
        // hand post-ready errors to the drop handler installed below
        client.removeListener('error', onError);
        resolve();
      });
      client.once('error', onError);
      try {
        client.connect({
          host: ssh.host,
          port: ssh.port ?? 22,
          username: ssh.username,
          readyTimeout: 10_000,
          // let a dead network surface as a close event, not a silent hang
          keepaliveInterval: 15_000,
          keepaliveCountMax: 3,
          ...(ssh.authMethod === 'password'
            ? { password: ssh.password ?? '' }
            : {
                privateKey: ssh.privateKey ?? '',
                passphrase: ssh.passphrase || undefined,
              }),
        });
      } catch (err) {
        reject(prefixed(err instanceof Error ? err.message : String(err)));
      }
    });

    // 2) accept adapter sockets on a loopback ephemeral port and forward
    //    each one through the ssh connection to the real database
    const server = createServer();
    const tunnel = await new Promise<SshTunnel>((resolve, reject) => {
      server.once('error', (err) => {
        client.end();
        reject(prefixed(err.message));
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve(new SshTunnel(port, client, server));
      });
    });

    server.on('connection', (socket) => {
      tunnel.track(socket);
      client.forwardOut(
        socket.remoteAddress ?? '127.0.0.1',
        socket.remotePort ?? 0,
        dbHost,
        dbPort,
        (err, stream) => {
          if (err) {
            // e.g. sshd's AllowTcpForwarding off, or the db host refusing
            tunnel.recordError(
              `port forward to ${dbHost}:${dbPort} failed (${err.message})`,
            );
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
          stream.on('error', () => socket.destroy());
          socket.on('error', () => stream.destroy());
        },
      );
    });

    // a drop after setup (network cut, sshd restart) kills the tunnel; the
    // pool listens via onClose and evicts the now-orphaned adapter
    client.on('error', (err) => {
      this.logger.warn(`Tunnel to ${ssh.host} errored: ${err.message}`);
      tunnel.markDead(err);
    });
    client.on('close', () => tunnel.markDead());

    return tunnel;
  }
}
