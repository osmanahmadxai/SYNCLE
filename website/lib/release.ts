import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The newest shipped version, read out of the repository's CHANGELOG at build
 * time. The site lives in the same repo as the code it describes, so this can
 * be a fact rather than a number someone has to remember to update — which is
 * exactly how the changelog itself fell two releases behind.
 *
 * Server-side only: this runs during `next build`, never in the browser.
 */
export interface Release {
  version: string;
  /** the date as written in the changelog, ISO */
  date: string;
}

/** `## [1.2.0] - 2026-08-21`, first match wins — the changelog is newest-first */
const ENTRY = /^##\s*\[(\d+\.\d+\.\d+)\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/m;

export function latestRelease(): Release | null {
  try {
    const text = readFileSync(join(process.cwd(), '..', 'CHANGELOG.md'), 'utf8');
    const m = ENTRY.exec(text);
    return m ? { version: m[1], date: m[2] } : null;
  } catch {
    // building the site outside the monorepo: fall back to saying nothing
    return null;
  }
}

/** `2026-08-21` → `21 August 2026`, to match how the page writes dates */
export function formatReleaseDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
