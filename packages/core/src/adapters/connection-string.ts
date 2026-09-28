/**
 * Connection strings, where they meet the rest of a connection's settings.
 *
 * A connection string names a database. The workbench and bridges name one too
 * — "browse `analytics`", "this bridge reads from `orders_eu`" — and the pool
 * opens an adapter per database. With discrete fields the chosen database is
 * simply used; with a connection string the drivers let the STRING win, so the
 * choice was ignored: the workbench showed the string's database under another
 * one's name, and a bridge configured for `orders_eu` read whatever the string
 * said, with nothing to show for it.
 */

/** the same connection string, pointed at `database`. unparseable = unchanged */
export function withDatabase(
  connectionString: string,
  database: string | undefined,
): string {
  const name = database?.trim();
  if (!name) return connectionString;
  try {
    const url = new URL(connectionString);
    const current = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (current === name) return connectionString;
    url.pathname = `/${encodeURIComponent(name)}`;
    return url.toString();
  } catch {
    return connectionString;
  }
}

/**
 * the same connection string, pointed at `host`. unparseable = unchanged, and so
 * is a `+srv` scheme, where the host is a DNS record that names the servers
 * rather than an address to dial.
 */
export function withHost(connectionString: string, host: string | undefined): string {
  const name = host?.trim();
  if (!name) return connectionString;
  try {
    const url = new URL(connectionString);
    if (url.protocol.includes('+srv')) return connectionString;
    if (url.hostname === name) return connectionString;
    url.hostname = name;
    return url.toString();
  } catch {
    return connectionString;
  }
}

/** what a connection string points at, without its secrets — for labels and logs */
export function describeConnectionString(connectionString: string): {
  host: string | null;
  port: number | null;
  database: string | null;
  user: string | null;
} {
  try {
    const url = new URL(connectionString);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    return {
      host: url.hostname || null,
      port: url.port ? Number(url.port) : null,
      database: database || null,
      user: url.username ? decodeURIComponent(url.username) : null,
    };
  } catch {
    return { host: null, port: null, database: null, user: null };
  }
}
