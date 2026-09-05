/**
 * The set of UI locales IS the set of message files: adding a language means
 * dropping `<code>.json` into src/messages/, and nothing in here changes.
 *
 * The listing is resolved by the bundler at build time rather than by reading
 * the directory at runtime. The Docker image ships Next's standalone output,
 * which carries the compiled bundle but not `src/`, so a `readdirSync` here
 * would work in dev and come back empty in the container. `require.context`
 * compiles the directory listing into the bundle instead.
 */

/** webpack's context API — `@types/node` types `require` without it */
type RequireContext = (
  dir: string,
  useSubdirectories: boolean,
  regExp: RegExp,
) => { keys(): string[] };

const messageFiles = (
  require as unknown as { context: RequireContext }
).context('../messages', false, /\.json$/);

/** e.g. ['en', 'it', 'zh'] — sorted so the toggle cycles in a stable order */
export const locales: readonly string[] = messageFiles
  .keys()
  .map((key) => key.replace(/^\.\//, '').replace(/\.json$/, ''))
  .sort();

/** the fallback when the cookie is absent or names a language we don't ship */
export const defaultLocale = 'en';

export function isLocale(value: string | undefined): boolean {
  return value !== undefined && locales.includes(value);
}
