/**
 * the help panel's state: open or not, on which tab and section — and, per
 * browser, which suggestions have been seen (the bulb stops pulsing for them)
 * and which were dismissed (hidden until their situation changes).
 *
 * seen and dismissed are conveniences of one viewer, so they live in this
 * browser's storage, and everything works without it: a private window just
 * shows every suggestion as new.
 */
import { create } from 'zustand';
import type { GuideSection, Hint } from './diagnose';

export type HelpTab = 'suggestions' | 'guide';

const SEEN = 'syncle.hints.seen';
const DISMISSED = 'syncle.hints.dismissed';

function read(key: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(key);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(
      Array.isArray(list) ? list.filter((v) => typeof v === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

function write(key: string, set: Set<string>) {
  try {
    // bounded: what was dismissed long ago has long since changed
    window.localStorage.setItem(key, JSON.stringify([...set].slice(-500)));
  } catch {
    // storage refused (private mode, quota): the state still holds for this visit
  }
}

/** a hint as it stands now: the same hint in a changed situation is new again */
export const hintKey = (h: Pick<Hint, 'id' | 'fingerprint'>) =>
  `${h.id}@${h.fingerprint}`;

interface HelpState {
  open: boolean;
  tab: HelpTab;
  /** the guide section to show (and scroll to) */
  section: GuideSection | null;
  seen: Set<string>;
  dismissed: Set<string>;
  loaded: boolean;
  /** read the stored sets once, after mount (the server has no storage) */
  load: () => void;
  openHelp: (opts?: { tab?: HelpTab; section?: GuideSection | null }) => void;
  close: () => void;
  setTab: (tab: HelpTab) => void;
  markSeen: (hints: Hint[]) => void;
  dismiss: (hint: Hint) => void;
  restore: (hint: Hint) => void;
}

export const useHelp = create<HelpState>((set, get) => ({
  open: false,
  tab: 'suggestions',
  section: null,
  seen: new Set(),
  dismissed: new Set(),
  loaded: false,
  load: () => {
    if (get().loaded) return;
    set({ seen: read(SEEN), dismissed: read(DISMISSED), loaded: true });
  },
  openHelp: (opts) =>
    set({
      open: true,
      tab: opts?.tab ?? (opts?.section ? 'guide' : get().tab),
      section: opts?.section ?? null,
    }),
  close: () => set({ open: false }),
  setTab: (tab) => set({ tab }),
  markSeen: (hints) => {
    const seen = new Set(get().seen);
    let changed = false;
    for (const h of hints) {
      const key = hintKey(h);
      if (!seen.has(key)) {
        seen.add(key);
        changed = true;
      }
    }
    if (!changed) return;
    write(SEEN, seen);
    set({ seen });
  },
  dismiss: (hint) => {
    const dismissed = new Set(get().dismissed);
    dismissed.add(hintKey(hint));
    write(DISMISSED, dismissed);
    set({ dismissed });
  },
  restore: (hint) => {
    const dismissed = new Set(get().dismissed);
    dismissed.delete(hintKey(hint));
    write(DISMISSED, dismissed);
    set({ dismissed });
  },
}));
