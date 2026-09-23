import { describe, expect, it } from 'vitest';
import {
  EMPTY_URL_STATE,
  createUrlSync,
  historyAction,
  readUrlState,
  sameUrlState,
  writeUrlState,
  type UrlState,
} from './url-state';

describe('url state', () => {
  it('round-trips through the query string', () => {
    for (const state of [
      EMPTY_URL_STATE,
      { bridge: 'b-1', data: false, edit: null },
      { bridge: null, data: true, edit: null },
      { bridge: 'b-1', data: true, edit: 'b-1' },
      { bridge: null, data: false, edit: 'new' },
    ]) {
      expect(readUrlState(writeUrlState(state))).toEqual(state);
    }
  });

  it('the empty state is the bare path, not "?"', () => {
    expect(writeUrlState(EMPTY_URL_STATE)).toBe('');
  });

  it('ignores parameters it does not own, and junk values of the ones it does', () => {
    expect(readUrlState('?utm_source=x&data=yes&bridge=&edit=')).toEqual(
      EMPTY_URL_STATE,
    );
    expect(readUrlState('?data=1&other=2')).toEqual({
      bridge: null,
      data: true,
      edit: null,
    });
  });

  it('escapes ids', () => {
    const qs = writeUrlState({ bridge: 'a b&c', data: false, edit: null });
    expect(qs).toBe('?bridge=a+b%26c');
    expect(readUrlState(qs).bridge).toBe('a b&c');
  });

  it('compares by value', () => {
    expect(
      sameUrlState(
        { bridge: 'x', data: true, edit: null },
        { bridge: 'x', data: true, edit: null },
      ),
    ).toBe(true);
    expect(
      sameUrlState(
        { bridge: 'x', data: true, edit: null },
        { bridge: 'x', data: false, edit: null },
      ),
    ).toBe(false);
  });
});

describe('what a state change does to the browser history', () => {
  const at = (bridge: string | null) => ({ bridge, data: false, edit: null });

  it('going somewhere adds an entry, so Back returns from it', () => {
    expect(
      historyAction({ current: at('a'), next: at('b'), firstWrite: false }),
    ).toBe('push');
    expect(
      historyAction({
        current: at('a'),
        next: { ...at('a'), data: true },
        firstWrite: false,
      }),
    ).toBe('push');
  });

  it('a change that CAME from Back or Forward adds nothing: the URL already says it', () => {
    // popstate moved the URL to `a`, and the store followed. answering that
    // with a push would undo every Back the user presses
    expect(
      historyAction({ current: at('a'), next: at('a'), firstWrite: false }),
    ).toBe('none');
  });

  it('the first write after load completes the entry the user arrived on', () => {
    // e.g. the app picks the first bridge for a bare URL: that is not a place
    // the user went FROM anywhere
    expect(
      historyAction({ current: at(null), next: at('a'), firstWrite: true }),
    ).toBe('replace');
    expect(
      historyAction({ current: at('a'), next: at('a'), firstWrite: true }),
    ).toBe('none');
  });
});

/** a browser history that behaves like one: a stack, a position, Back and Forward */
function fakeBrowser(initial: string) {
  const entries = [initial];
  let index = 0;
  const listeners = new Set<() => void>();
  const search = () => {
    const url = entries[index]!;
    const q = url.indexOf('?');
    return q < 0 ? '' : url.slice(q);
  };
  return {
    entries,
    position: () => index,
    env: {
      search,
      pathname: () => '/',
      push(url: string) {
        entries.splice(index + 1); // a push discards the forward entries
        entries.push(url);
        index++;
      },
      replace(url: string) {
        entries[index] = url;
      },
      onPop(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    back() {
      if (index === 0) return false; // would leave the app
      index--;
      for (const l of listeners) l();
      return true;
    },
    forward() {
      if (index >= entries.length - 1) return false;
      index++;
      for (const l of listeners) l();
      return true;
    },
  };
}

/** a UI whose every change is written through, the way the app's effect does */
function fakeUi(sync: () => ReturnType<typeof createUrlSync>) {
  let state: UrlState = { ...EMPTY_URL_STATE };
  return {
    binding: {
      get: () => state,
      apply: (next: UrlState) => {
        state = { ...next };
      },
    },
    state: () => state,
    /** the user does something */
    go(change: Partial<UrlState>) {
      state = { ...state, ...change };
      sync().write();
    },
  };
}

function setup(initialUrl: string) {
  const browser = fakeBrowser(initialUrl);
  // eslint-disable-next-line prefer-const
  let sync: ReturnType<typeof createUrlSync>;
  const ui = fakeUi(() => sync);
  sync = createUrlSync(browser.env, ui.binding);
  return { browser, ui, sync };
}

describe('the URL and the UI, kept in step', () => {
  it('Back returns to the bridge you were on, instead of leaving the app', () => {
    const { browser, ui, sync } = setup('/');
    sync.start();
    sync.write();
    ui.go({ bridge: 'a' });
    ui.go({ bridge: 'b' });
    ui.go({ data: true });

    expect(browser.back()).toBe(true);
    expect(ui.state()).toEqual({ bridge: 'b', data: false, edit: null });
    expect(browser.back()).toBe(true);
    expect(ui.state().bridge).toBe('a');
    // and Forward goes the other way
    expect(browser.forward()).toBe(true);
    expect(ui.state().bridge).toBe('b');
  });

  it('following Back does not write a new entry (which would undo every Back)', () => {
    const { browser, ui, sync } = setup('/');
    sync.start();
    ui.go({ bridge: 'a' });
    ui.go({ bridge: 'b' });
    const length = browser.entries.length;

    browser.back();
    sync.write(); // the effect runs again because the store changed
    expect(browser.entries.length).toBe(length);
    expect(browser.position()).toBe(length - 2);
    expect(browser.forward()).toBe(true); // Forward is still there
  });

  it('a reload keeps the URL it was loaded with', () => {
    const { browser, ui, sync } = setup('/?bridge=a&data=1');
    // the effect that writes runs in the same commit as the one that reads,
    // still holding the UI's defaults. it used to wipe the URL right here
    sync.write();
    expect(browser.entries).toEqual(['/?bridge=a&data=1']);

    sync.start();
    sync.write();
    expect(ui.state()).toEqual({ bridge: 'a', data: true, edit: null });
    expect(browser.entries).toEqual(['/?bridge=a&data=1']);
  });

  it('the first thing the app fills in completes the entry, it is not a place to go back to', () => {
    const { browser, ui, sync } = setup('/');
    sync.start();
    // the app opens the first bridge by itself for a bare URL
    ui.go({ bridge: 'first' });
    // (the app writes a relative `?query`, which the browser resolves)
    expect(browser.entries).toEqual(['?bridge=first']);
    ui.go({ bridge: 'second' });
    expect(browser.entries).toEqual(['?bridge=first', '?bridge=second']);
  });

  it('closing everything goes back to the bare path, and the editor round-trips (new and existing)', () => {
    const { browser, ui, sync } = setup('/');
    sync.start();
    ui.go({ bridge: 'a' });
    ui.go({ edit: 'new' });
    ui.go({ edit: null });
    ui.go({ edit: 'a' });
    ui.go({ bridge: null, edit: null });
    expect(browser.entries.at(-1)).toBe('/');

    browser.back();
    expect(ui.state()).toEqual({ bridge: 'a', data: false, edit: 'a' });
    browser.back();
    browser.back();
    expect(ui.state().edit).toBe('new');
  });

  it('stops following the history once stopped', () => {
    const { browser, ui, sync } = setup('/');
    const stop = sync.start();
    ui.go({ bridge: 'a' });
    ui.go({ bridge: 'b' });
    stop();
    browser.back();
    expect(ui.state().bridge).toBe('b');
  });
});
