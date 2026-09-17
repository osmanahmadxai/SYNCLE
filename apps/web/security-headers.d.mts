export interface SecurityHeaderOptions {
  /** NEXT_PUBLIC_API_URL: when absolute, the browser talks to the API itself */
  apiUrl?: string;
  /** the dev server evaluates code and hot-reloads over a websocket */
  dev?: boolean;
}
export function contentSecurityPolicy(opts?: SecurityHeaderOptions): string;
export function securityHeaders(
  opts?: SecurityHeaderOptions,
): Array<{ key: string; value: string }>;
