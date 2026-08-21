import type { DatabaseEngine } from '@syncle/core';

interface EngineMeta {
  label: string;
  /** short tag shown in the avatar square */
  abbr: string;
  /** tailwind classes for the engine accent (bg + text) */
  className: string;
}

// labels mirror the driver registry names served by /drivers — only engines
// with a registered adapter get an entry; anything else falls back below
export const ENGINE_META: Partial<Record<DatabaseEngine, EngineMeta>> = {
  postgres: {
    label: 'PostgreSQL',
    abbr: 'PG',
    className: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  },
  mysql: {
    label: 'MySQL / MariaDB',
    abbr: 'My',
    className: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  },
  sqlite: {
    label: 'SQLite',
    abbr: 'SL',
    className: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400',
  },
  mongodb: {
    label: 'MongoDB',
    abbr: 'Mo',
    className: 'bg-green-500/15 text-green-600 dark:text-green-400',
  },
  redis: {
    label: 'Redis',
    abbr: 'Rd',
    className: 'bg-red-500/15 text-red-600 dark:text-red-400',
  },
};

/**
 * look up display metadata for an engine. pass the driver's registry label
 * (from /drivers) when it's at hand — the registry is the naming authority;
 * the local table only covers engines the API might not be serving yet.
 */
export function engineMeta(engine: DatabaseEngine, driverLabel?: string): EngineMeta {
  const meta = ENGINE_META[engine] ?? {
    label: engine,
    abbr: engine.slice(0, 2).toUpperCase(),
    className: 'bg-muted text-muted-foreground',
  };
  return driverLabel ? { ...meta, label: driverLabel } : meta;
}
