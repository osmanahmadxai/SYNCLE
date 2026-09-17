/**
 * What version is this process?
 *
 * Nothing could answer that. The workspace's package.json said 1.0.0 (the API's
 * own said 0.1.0) through three releases, the image carried no version at all,
 * and a bug report's "which version?" had no answer but the date it was
 * installed.
 *
 * In order: SYNCLE_VERSION, which the image build bakes in from the release tag
 * (so an image knows what it is even if a package.json was not bumped); then
 * the API's own package.json, which is what a source checkout has.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface VersionInfo {
  /** `1.3.0`, without a leading v */
  version: string;
  /** where that came from: the image build, or this package */
  source: 'build' | 'package';
  node: string;
}

/** `v1.3.0` / `1.3.0` / `refs/tags/v1.3.0` -> `1.3.0`; anything else -> null */
export function normalizeVersion(raw: string | undefined): string | null {
  if (!raw) return null;
  const text = raw
    .trim()
    .replace(/^refs\/tags\//, '')
    .replace(/^v(?=\d)/, '');
  // a version, not a branch name or a commit: the image of a non-tag build
  // must not announce itself as "main"
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(text) ? text : null;
}

function packageVersion(): string {
  // dist/common/version.js and src/common/version.ts are both two levels below
  // the package root
  for (const path of [
    resolve(__dirname, '../../package.json'),
    resolve(process.cwd(), 'package.json'),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (parsed.name === '@syncle/api' && parsed.version)
        return parsed.version;
    } catch {
      /* try the next place */
    }
  }
  return '0.0.0';
}

export function resolveVersion(
  env: NodeJS.ProcessEnv = process.env,
): VersionInfo {
  const built = normalizeVersion(env.SYNCLE_VERSION);
  return {
    version: built ?? packageVersion(),
    source: built ? 'build' : 'package',
    node: process.versions.node,
  };
}
