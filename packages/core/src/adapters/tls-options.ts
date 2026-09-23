/**
 * One place that turns a connection's TLS setting into what each driver needs.
 *
 * Before this there was a checkbox, and every driver did something different
 * with it: MySQL and the Postgres change stream encrypted but never checked the
 * certificate (`rejectUnauthorized: false`, hard-coded); Postgres' ordinary
 * connections checked it only behind an undocumented `options.sslVerify`;
 * MongoDB ignored the checkbox altogether and connected in plaintext; and the
 * MySQL binlog stream — the connection every change travels over — was never
 * given TLS options at all. Only Redis verified. A switch labelled "Use TLS"
 * that means four different things is worse than no switch.
 *
 * Server-only (it needs node:tls). The browser-safe types live in `types.ts`.
 */
import { isIP } from 'node:net';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import type { ConnectionConfig, TlsConfig, TlsMode } from './types';

/**
 * the TLS setting actually in force. a connection saved before `tls` existed
 * carries only the old boolean, and keeps EXACTLY what that boolean did on its
 * engine — an upgrade must not start refusing connections that worked:
 *
 *   Postgres  encrypted, unverified — unless `options.sslVerify` was set
 *   MySQL     encrypted, unverified
 *   MongoDB   (was plaintext, silently) → encrypted, unverified: the user asked
 *             for TLS, so they get it; the certificate is as unchecked as on
 *             the engines beside it
 *   Redis     verified against the system's CAs, as before
 */
export function effectiveTls(config: ConnectionConfig): TlsConfig {
  if (config.tls) return config.tls;
  if (!config.ssl) return { mode: 'disable' };
  if (config.engine === 'redis') return { mode: 'verify-full' };
  if (config.engine === 'postgres' && config.options?.sslVerify === true) {
    return { mode: 'verify-full' };
  }
  return { mode: 'require' };
}

/** the name the server's certificate has to be valid for */
export function tlsServerName(config: ConnectionConfig): string | undefined {
  const tls = effectiveTls(config);
  // through an SSH tunnel `host` is the tunnel's loopback end, not the server
  return (
    tls.servername?.trim() || config.tlsHostOverride || config.host || undefined
  );
}

const given = (v?: string): string | undefined =>
  v && v.trim() !== '' ? v : undefined;

/** options in the shape `tls.connect` takes — what pg and ioredis pass through */
export interface NodeTlsOptions {
  rejectUnauthorized: boolean;
  ca?: string;
  cert?: string;
  key?: string;
  /** SNI; never an IP address (RFC 6066) */
  servername?: string;
  checkServerIdentity?: (
    host: string,
    cert: PeerCertificate,
  ) => Error | undefined;
}

/**
 * TLS options for a driver that hands them to `tls.connect` (pg, ioredis).
 * `undefined` = do not use TLS.
 */
export function nodeTlsOptions(
  config: ConnectionConfig,
): NodeTlsOptions | undefined {
  const tls = effectiveTls(config);
  if (tls.mode === 'disable') return undefined;

  const base = {
    ...(given(tls.cert) ? { cert: tls.cert } : {}),
    ...(given(tls.key) ? { key: tls.key } : {}),
  };
  if (tls.mode === 'require') return { rejectUnauthorized: false, ...base };

  const trusted = {
    rejectUnauthorized: true,
    ...(given(tls.ca) ? { ca: tls.ca } : {}),
    ...base,
  };
  if (tls.mode === 'verify-ca') {
    // the chain is checked; the name on the certificate deliberately is not
    return { ...trusted, checkServerIdentity: () => undefined };
  }

  const name = tlsServerName(config);
  return {
    ...trusted,
    // an IP cannot be sent as SNI, but it can still be checked against the
    // certificate's IP SANs — which is what the explicit check below does
    ...(name && isIP(name) === 0 ? { servername: name } : {}),
    // verify against the name WE mean, not whatever host the socket was opened
    // to: through an SSH tunnel that is 127.0.0.1, which is on no certificate
    checkServerIdentity: (host, cert) =>
      checkServerIdentity(name ?? host, cert),
  };
}

/**
 * mysql2's `ssl` option. it builds its own TLS socket and honours only
 * `ca/cert/key/rejectUnauthorized/verifyIdentity` — a custom
 * `checkServerIdentity` or `servername` is ignored — and with `verifyIdentity`
 * it checks the name against `config.host`, skipping the check entirely when
 * that host is an IP address. `verifyPeerIdentity` closes that gap.
 */
export function mysqlTlsOptions(
  config: ConnectionConfig,
): Record<string, unknown> | undefined {
  const tls = effectiveTls(config);
  if (tls.mode === 'disable') return undefined;
  return {
    rejectUnauthorized: tls.mode !== 'require',
    ...(tls.mode !== 'require' && given(tls.ca) ? { ca: tls.ca } : {}),
    ...(given(tls.cert) ? { cert: tls.cert } : {}),
    ...(given(tls.key) ? { key: tls.key } : {}),
    // identity is verified by verifyPeerIdentity (the adapter turns mysql2's own
    // check on where it can run inside the handshake)
    verifyIdentity: false,
  };
}

/**
 * for `verify-full`: is this certificate valid for the server we meant to
 * reach? returns the reason it is not, or null. used where a driver offers no
 * hook for the check (both MySQL clients), after its handshake.
 */
export function verifyPeerIdentity(
  config: ConnectionConfig,
  cert: PeerCertificate | undefined,
): string | null {
  if (effectiveTls(config).mode !== 'verify-full') return null;
  const name = tlsServerName(config);
  if (!name)
    return 'TLS: no host name to verify the server certificate against';
  if (!cert || Object.keys(cert).length === 0) {
    return 'TLS: the server presented no certificate to verify';
  }
  const err = checkServerIdentity(name, cert);
  return err ? `TLS: ${err.message}` : null;
}

/**
 * MongoClient options. with discrete host fields the driver was never told
 * about TLS at all; a connection string carries its own `tls=` and is left to
 * say what it says unless a TLS setting was chosen explicitly.
 */
export function mongoTlsOptions(
  config: ConnectionConfig,
): Record<string, unknown> {
  if (config.connectionString && !config.tls) return {};
  const tls = effectiveTls(config);
  if (tls.mode === 'disable')
    return config.connectionString ? {} : { tls: false };
  const name = tlsServerName(config);
  return {
    tls: true,
    ...(given(tls.cert) ? { cert: tls.cert } : {}),
    ...(given(tls.key) ? { key: tls.key } : {}),
    ...(tls.mode === 'require'
      ? { tlsAllowInvalidCertificates: true, tlsAllowInvalidHostnames: true }
      : {
          ...(given(tls.ca) ? { ca: tls.ca } : {}),
          ...(tls.mode === 'verify-ca'
            ? { tlsAllowInvalidHostnames: true }
            : {
                checkServerIdentity: (host: string, cert: PeerCertificate) =>
                  checkServerIdentity(name ?? host, cert),
              }),
        }),
  };
}

/** a one-line description for logs and the readiness panel */
export function describeTls(mode: TlsMode): string {
  switch (mode) {
    case 'disable':
      return 'no TLS';
    case 'require':
      return 'encrypted, server certificate NOT verified';
    case 'verify-ca':
      return 'encrypted, certificate authority verified';
    case 'verify-full':
      return 'encrypted, certificate authority and host name verified';
  }
}
