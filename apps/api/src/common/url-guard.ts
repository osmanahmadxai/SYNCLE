/**
 * outbound-destination guard for bridge HTTP deliveries (SSRF).
 *
 * two tiers:
 *  - cloud metadata endpoints (169.254.169.254 and friends) are ALWAYS
 *    blocked — no legitimate bridge posts rows to an instance-metadata API,
 *    and they are the highest-value SSRF target.
 *  - loopback / private / link-local ranges are blocked only when
 *    SYNCLE_BLOCK_PRIVATE_DESTINATIONS=true. Syncle is local-first, and
 *    posting to a service on localhost is a primary, documented use case —
 *    the strict tier exists for network-exposed deployments.
 *
 * the caller must also disable redirect-following: a public host that 302s to
 * an internal address would otherwise bypass any pre-flight check.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BadRequestError } from '@syncle/core';
import { runtimeConfig } from './runtime-config';

/** instance-metadata addresses, blocked unconditionally */
const METADATA_ADDRS = new Set([
  '169.254.169.254', // AWS / GCP / Azure / OpenStack IMDS
  'fd00:ec2::254', // AWS IMDSv2 over IPv6
  '100.100.100.200', // Alibaba Cloud
]);

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fe80:') || // link-local
    lower.startsWith('fc') || // ULA fc00::/7
    lower.startsWith('fd') ||
    lower.startsWith('::ffff:127.') || // v4-mapped loopback
    lower.startsWith('::ffff:10.') ||
    lower.startsWith('::ffff:192.168.') ||
    lower.startsWith('::ffff:169.254.')
  );
}

function normalizeAddr(ip: string): string {
  // strip a v4-mapped prefix so METADATA_ADDRS matches either notation
  const lower = ip.toLowerCase();
  return lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4
    ? lower.slice(7)
    : lower;
}

/**
 * throw when `rawUrl` may not be used as a delivery destination. resolves the
 * hostname so DNS-based dodges (a public name pointing at an internal IP) are
 * caught at the same tier as literal addresses.
 */
export async function assertAllowedDestination(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestError('Destination is not a valid URL.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, ''); // [::1] → ::1

  const addrs: string[] = [];
  if (isIP(host)) {
    addrs.push(host);
  } else {
    try {
      const resolved = await lookup(host, { all: true, verbatim: true });
      addrs.push(...resolved.map((r) => r.address));
    } catch {
      // unresolvable hosts fail at fetch time with a clearer network error
      return;
    }
  }

  for (const raw of addrs) {
    const addr = normalizeAddr(raw);
    if (METADATA_ADDRS.has(addr)) {
      throw new BadRequestError(
        'Destination resolves to a cloud metadata endpoint, which is not allowed.',
      );
    }
    if (
      runtimeConfig.blockPrivateDestinations &&
      (isPrivateV4(addr) || isPrivateV6(addr))
    ) {
      throw new BadRequestError(
        `Destination resolves to a private address (${addr}); this deployment only allows public destinations (SYNCLE_BLOCK_PRIVATE_DESTINATIONS).`,
      );
    }
  }
}
