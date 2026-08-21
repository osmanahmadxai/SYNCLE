/**
 * `syncle up` reads the first-run token off the server and opens the GUI with
 * it in the URL fragment, so the operator never types it by hand.
 *
 * A fragment rather than a query string on purpose: fragments are not sent to
 * the server, so the token stays out of access logs and Referer headers. The
 * setup screen strips it from the address bar as soon as it is read, to keep
 * it out of browser history too.
 */
const TOKEN_PARAM = 'setup-token';

/**
 * Pull the setup token out of a location hash, or null when it isn't there.
 * Accepts the token in any position so the fragment can carry other params.
 */
export function readSetupTokenFromHash(hash: string): string | null {
  if (!hash) return null;
  // a hash may or may not include the leading '#', depending on the caller
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) !== TOKEN_PARAM) continue;
    const value = part.slice(eq + 1);
    if (!value) return null;
    try {
      const decoded = decodeURIComponent(value).trim();
      return decoded === '' ? null : decoded;
    } catch {
      // a malformed percent-escape shouldn't take the setup screen down —
      // fall back to the raw value and let the API reject it if it's wrong
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed;
    }
  }
  return null;
}

/** the URL a launcher should open to prefill the setup form */
export function setupUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/#${TOKEN_PARAM}=${encodeURIComponent(token)}`;
}
