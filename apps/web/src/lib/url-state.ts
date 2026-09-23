/**
 * The part of the UI that lives in the URL: which bridge is open, whether the
 * data-sources surface is up, which bridge is being edited.
 *
 * It was written with `history.replaceState` and never read again after load,
 * so the browser's history had exactly one entry for the whole app. Back did
 * not go to the bridge you were looking at before — it left Syncle. And with
 * nothing listening for `popstate`, Forward into the app changed the URL and
 * nothing else. Kept free of React and of `window` so it can be tested.
 */
export interface UrlState {
  bridge: string | null;
  data: boolean;
  /** a bridge id, or 'new' for the builder opened on a new bridge */
  edit: string | null;
}

export const EMPTY_URL_STATE: UrlState = {
  bridge: null,
  data: false,
  edit: null,
};

export function readUrlState(search: string): UrlState {
  const p = new URLSearchParams(search);
  return {
    bridge: p.get('bridge') || null,
    data: p.get('data') === '1',
    edit: p.get('edit') || null,
  };
}

/** the query string for a state, with its leading `?`; '' for the empty state */
export function writeUrlState(state: UrlState): string {
  const p = new URLSearchParams();
  if (state.bridge) p.set('bridge', state.bridge);
  if (state.data) p.set('data', '1');
  if (state.edit) p.set('edit', state.edit);
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

export function sameUrlState(a: UrlState, b: UrlState): boolean {
  return a.bridge === b.bridge && a.data === b.data && a.edit === b.edit;
}

/**
 * what to do with the browser's history when the UI has moved to `next`:
 *
 *  - nothing, when the URL already says so (the change CAME from the URL — a
 *    Back or Forward — and answering it with a new entry would trap the user:
 *    every Back would be undone by a push)
 *  - replace, for the first write after load: the entry the user arrived on is
 *    completed, not followed by a copy of itself
 *  - push otherwise: a place the user went, which Back should return from
 */
export function historyAction(opts: {
  current: UrlState;
  next: UrlState;
  firstWrite: boolean;
}): 'none' | 'replace' | 'push' {
  if (sameUrlState(opts.current, opts.next)) return 'none';
  return opts.firstWrite ? 'replace' : 'push';
}

/** the bits of the browser this needs, so a test can stand in for it */
export interface HistoryEnv {
  /** `window.location.search` */
  search(): string;
  /** `window.location.pathname`, written when the state is empty */
  pathname(): string;
  push(url: string): void;
  replace(url: string): void;
  /** subscribe to Back / Forward; returns the unsubscribe */
  onPop(listener: () => void): () => void;
}

export interface UiBinding {
  /** the UI's state RIGHT NOW (not a render's snapshot of it) */
  get(): UrlState;
  /** make the UI match */
  apply(state: UrlState): void;
}

/**
 * keeps the URL and the UI in step, in both directions.
 *
 *   const sync = createUrlSync(env, ui);
 *   const stop = sync.start();   // once: URL -> UI, and follow Back / Forward
 *   sync.write();                // after every UI change: UI -> URL
 */
export function createUrlSync(env: HistoryEnv, ui: UiBinding) {
  let started = false;
  let wrote = false;
  return {
    start(): () => void {
      ui.apply(readUrlState(env.search()));
      started = true;
      return env.onPop(() => ui.apply(readUrlState(env.search())));
    },
    write(): void {
      // before the URL has been read there is nothing true to write: the UI
      // still holds its defaults, and writing those would wipe the URL the
      // page was loaded with
      if (!started) return;
      const next = ui.get();
      const action = historyAction({
        current: readUrlState(env.search()),
        next,
        firstWrite: !wrote,
      });
      if (action === 'none') return;
      wrote = true;
      const url = writeUrlState(next) || env.pathname();
      if (action === 'push') env.push(url);
      else env.replace(url);
    },
  };
}
