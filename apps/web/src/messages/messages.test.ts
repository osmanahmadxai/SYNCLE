/**
 * The translations, held to the code that uses them.
 *
 * next-intl looks a key up at render time, so a key that is misspelled, or that
 * exists in English only, is not a build error: it is a raw "bridges.runJob" on
 * somebody's screen, in the one language nobody on the team reads. Nothing
 * checked for that.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..');
const LOCALES = ['en', 'it', 'zh'] as const;

type Messages = { [key: string]: string | Messages };
const load = (locale: string): Messages =>
  JSON.parse(
    readFileSync(join(__dirname, `${locale}.json`), 'utf8'),
  ) as Messages;

function flatten(messages: Messages, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value === 'string') out.set(prefix + key, value);
    else for (const [k, v] of flatten(value, `${prefix}${key}.`)) out.set(k, v);
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** the `{placeholders}` of an ICU message, ignoring what is inside plural/select branches */
function placeholders(message: string): string[] {
  const names = new Set<string>();
  let depth = 0;
  let current = '';
  for (const ch of message) {
    if (ch === '{') {
      depth++;
      if (depth === 1) current = '';
      continue;
    }
    if (ch === '}') {
      if (depth === 1) {
        const name = current.split(',')[0]!.trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
      }
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 1) current += ch;
  }
  return [...names].sort();
}

const en = flatten(load('en'));

describe('the three locales', () => {
  it.each(LOCALES.filter((l) => l !== 'en'))(
    '%s has exactly the keys English has',
    (locale) => {
      const other = flatten(load(locale));
      expect([...en.keys()].filter((k) => !other.has(k))).toEqual([]);
      expect([...other.keys()].filter((k) => !en.has(k))).toEqual([]);
    },
  );

  it.each(LOCALES.filter((l) => l !== 'en'))(
    '%s uses the same placeholders in every message',
    (locale) => {
      const other = flatten(load(locale));
      const different = [...en.entries()]
        .filter(([key]) => other.has(key))
        .filter(
          ([key, message]) =>
            placeholders(message).join() !==
            placeholders(other.get(key)!).join(),
        )
        .map(
          ([key, message]) =>
            `${key}: en {${placeholders(message)}} vs ${locale} {${placeholders(other.get(key)!)}}`,
        );
      // a missing {count} renders as nothing; an extra one as a literal "{count}"
      expect(different).toEqual([]);
    },
  );

  it('has no empty message', () => {
    for (const locale of LOCALES) {
      const empty = [...flatten(load(locale)).entries()]
        .filter(([, v]) => v.trim() === '')
        .map(([k]) => k);
      expect(empty, locale).toEqual([]);
    }
  });
});

describe('every message', () => {
  /**
   * a message is a small program: `{count, plural, …}`, `<b>…</b>`. one that
   * does not PARSE is not a build error and not a missing key — it is found when
   * someone opens that screen in that language. a bare `<key>` in a sentence is
   * enough ("Bearer <key>" was).
   */
  it.each(LOCALES)('%s: parses, and formats with a value for each of its placeholders', (locale) => {
    const messages = load(locale);
    const problems: string[] = [];
    const t = createTranslator({
      locale,
      messages: messages as never,
      onError: (err) => problems.push(err.message.slice(0, 160)),
      getMessageFallback: ({ key }) => key,
    });
    for (const [key, message] of flatten(messages)) {
      const values: Record<string, unknown> = {};
      for (const name of placeholders(message)) {
        values[name] = new RegExp(`\\{\\s*${name}\\s*,\\s*(plural|number|selectordinal)`).test(message) ? 2 : 'x';
      }
      const tags = [...message.matchAll(/<([A-Za-z][\w-]*)>/g)].map((m) => m[1]!);
      for (const tag of tags) values[tag] = (chunks: unknown) => String(chunks);
      if (tags.length) (t as unknown as { markup: (k: string, v: unknown) => string }).markup(key, values);
      else (t as unknown as (k: string, v: unknown) => string)(key, values);
    }
    expect(problems).toEqual([]);
  });
});

describe('the keys the code asks for', () => {
  /** `const t = useTranslations('ns')` -> every `t('key')`, `t.rich('key'` in that file */
  function used(): Array<{ file: string; key: string; dynamic: boolean }> {
    const out: Array<{ file: string; key: string; dynamic: boolean }> = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      const hooks = [
        ...text.matchAll(
          /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/g,
        ),
      ];
      for (const hook of hooks) {
        const [, variable, single, double] = hook;
        const namespace = single ?? double ?? '';
        const call = new RegExp(
          `(?<![\\w.])${variable}(?:\\.rich|\\.markup|\\.raw)?\\(\\s*(['"\`])((?:(?!\\1).)*)\\1`,
          'g',
        );
        for (const m of text.matchAll(call)) {
          const raw = m[2]!;
          const dynamic = m[1] === '`' && raw.includes('${');
          // for a dynamic key, what can be checked is the part before the first ${
          const key = dynamic
            ? raw.slice(0, raw.indexOf('${')).replace(/\.$/, '')
            : raw;
          out.push({
            file: file.slice(SRC.length + 1),
            key: [namespace, key].filter(Boolean).join('.'),
            dynamic,
          });
        }
      }
    }
    return out;
  }

  it('all exist', () => {
    const calls = used();
    // the scan has to be finding things, or this proves nothing
    expect(calls.length).toBeGreaterThan(200);
    const keys = [...en.keys()];
    const missing = calls
      .filter(({ key, dynamic }) =>
        dynamic ? !keys.some((k) => k.startsWith(`${key}.`)) : !en.has(key),
      )
      .map(({ file, key }) => `${file}: ${key}`);
    expect(missing).toEqual([]);
  });
});
