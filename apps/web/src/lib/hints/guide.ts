import type { GuideSection } from './diagnose';

/** the guide's sections, in reading order (their words are `help.guide.sections.<id>`) */
export const GUIDE_SECTIONS: GuideSection[] = [
  'overview',
  'first-bridge',
  'connections',
  'triggers',
  'cdc-setup',
  'write-modes',
  'columns',
  'backfill',
  'failures',
  'verify',
  'schedule',
  'schema-changes',
  'http',
  'monitoring',
  'accounts',
  'workbench',
  'shortcuts',
  'troubleshooting',
];

/** does a section's text hold every word of a search */
export function matchesSearch(text: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = text.toLowerCase();
  return words.every((w) => hay.includes(w));
}
