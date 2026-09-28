/**
 * A database on the machine that runs Syncle, reached from inside Syncle's
 * container.
 *
 * `localhost` is the first address anyone types, and on a Docker install it is
 * the one address that cannot work: inside a container it is the container, and
 * nothing is listening there. What came back was the driver's own words —
 * `ECONNREFUSED 127.0.0.1:5432` — which leaves the reader to already know that a
 * container has a loopback of its own. So a loopback address is now read as what
 * it plainly means, the database on this machine, and dialled at the host.
 *
 * The address of the host is `host.docker.internal` where Docker provides that
 * name (Docker Desktop always; Compose on Linux when the file maps it, which
 * Syncle's does), and otherwise the container's default gateway, which is the
 * same address that name resolves to. `SYNCLE_HOST_GATEWAY` overrides both.
 *
 * Three things this deliberately leaves alone:
 *
 *   - **A connection that tunnels through SSH.** Its host is resolved on the far
 *     side of the bastion, where `localhost` means the bastion's own localhost —
 *     a normal thing to ask for. The tunnel puts its own loopback address in
 *     place afterwards, which is why this runs before it and never after.
 *   - **Anything not in a container**, where localhost already means this
 *     machine and there is nothing to correct.
 *   - **What the connection says it is.** The rewrite happens on the way to a
 *     driver, not in the stored connection: the form still shows the address
 *     that was typed, and saving it again keeps it.
 */
import { lookup } from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import { withHost } from './connection-string';
import type { ConnectionConfig } from './types';

/** names and addresses that mean "this machine" */
const LOOPBACK_NAMES = new Set([
  'localhost',
  '::1',
  '0.0.0.0',
  '::',
  // what a container's own loopback is called in some images
  'localhost.localdomain',
]);

/** `localhost`, anything in 127.0.0.0/8, the IPv6 loopback, or "all interfaces" */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!h) return false;
  if (LOOPBACK_NAMES.has(h)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Docker writes `/.dockerenv`; Podman writes `/run/.containerenv`. Read once:
 * a process does not move in or out of a container while it runs.
 */
let container: boolean | undefined;
export function inContainer(): boolean {
  container ??= existsSync('/.dockerenv') || existsSync('/run/.containerenv');
  return container;
}

/**
 * the container's default gateway, which is the address the host answers on.
 * `/proc/net/route` gives it as a little-endian hex word.
 */
function defaultGateway(): string | null {
  try {
    const rows = readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
    for (const row of rows) {
      const cols = row.split(/\s+/);
      // destination 0.0.0.0 with a gateway of its own: the default route
      if (cols[1] !== '00000000' || !cols[2] || cols[2] === '00000000') continue;
      const hex = cols[2];
      if (!/^[0-9a-fA-F]{8}$/.test(hex)) continue;
      const octets = [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)].map(
        (pair) => Number.parseInt(pair, 16),
      );
      return octets.join('.');
    }
  } catch {
    // no procfs: not Linux, which means Docker Desktop, which maps the name
  }
  return null;
}

/** where the host is, from in here — resolved once */
let gateway: string | null | undefined;
export async function hostGateway(): Promise<string | null> {
  if (gateway !== undefined) return gateway;
  const override = process.env.SYNCLE_HOST_GATEWAY?.trim();
  if (override) return (gateway = override);
  for (const name of ['host.docker.internal', 'gateway.docker.internal']) {
    try {
      await lookup(name);
      return (gateway = name);
    } catch {
      // the name is not mapped here; try the next, then the route table
    }
  }
  return (gateway = defaultGateway());
}

/** what {@link reachHostFromContainer} asks about its surroundings, so a test can answer */
export interface HostReach {
  inContainer: () => boolean;
  gateway: () => Promise<string | null>;
}

const surroundings: HostReach = { inContainer, gateway: hostGateway };

/**
 * the same connection, with a loopback address pointed at the host running
 * Syncle. Unchanged when it is not in a container, when it tunnels, when the
 * address is not loopback, or when the host's address cannot be worked out.
 */
export async function reachHostFromContainer(
  config: ConnectionConfig,
  reach: HostReach = surroundings,
): Promise<ConnectionConfig> {
  // a file on a volume, not a socket
  if (config.engine === 'sqlite') return config;
  // the far side of the bastion has a localhost of its own, and it is the one meant
  if (config.ssh?.enabled) return config;
  if (!reach.inContainer()) return config;

  const stringHost = hostOf(config.connectionString);
  const hostIsLoopback = isLoopbackHost(config.host);
  const stringIsLoopback = isLoopbackHost(stringHost);
  if (!hostIsLoopback && !stringIsLoopback) return config;

  const host = await reach.gateway();
  if (!host) return config;

  const asked = (hostIsLoopback ? config.host : stringHost) as string;
  return {
    ...config,
    ...(hostIsLoopback ? { host } : {}),
    ...(stringIsLoopback && config.connectionString
      ? { connectionString: withHost(config.connectionString, host) }
      : {}),
    // a certificate is still checked against the name that was asked for, not
    // against the address this put in its place
    ...(config.tls && !config.tls.servername
      ? { tls: { ...config.tls, servername: asked } }
      : {}),
  };
}

function hostOf(connectionString: string | undefined): string | undefined {
  if (!connectionString) return undefined;
  try {
    return new URL(connectionString).hostname || undefined;
  } catch {
    return undefined;
  }
}
