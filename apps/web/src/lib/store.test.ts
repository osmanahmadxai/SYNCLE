import { beforeEach, describe, expect, it } from 'vitest';
import { useStudio } from './store';

const tabs = () => useStudio.getState().queryTabs;

describe('query tabs', () => {
  beforeEach(() => {
    // back to one fresh tab
    const s = useStudio.getState();
    for (const t of [...s.queryTabs]) s.closeQueryTab(t.id);
  });

  it('a tab has a number, not a name of its own, so the title can be in the user’s language', () => {
    expect(tabs()).toHaveLength(1);
    expect(tabs()[0]).toMatchObject({ number: 1, sql: '' });
    expect(tabs()[0]!.name).toBeUndefined();
    useStudio.getState().addQueryTab();
    useStudio.getState().addQueryTab({ sql: 'select 1' });
    expect(tabs().map((t) => [t.number, t.name, t.sql])).toEqual([
      [1, undefined, ''],
      [2, undefined, ''],
      [3, undefined, 'select 1'],
    ]);
  });

  it('a name it was given is kept', () => {
    useStudio
      .getState()
      .addQueryTab({ name: 'orders', sql: 'select * from orders' });
    useStudio.getState().openInQuery('select 2', 'two');
    useStudio.getState().openInQuery('select 3');
    expect(tabs().map((t) => [t.number, t.name])).toEqual([
      [1, undefined],
      [2, 'orders'],
      [3, 'two'],
      [4, undefined],
    ]);
  });

  it('closing a tab renumbers nothing, and the next one counts on from the highest', () => {
    const s = useStudio.getState();
    s.addQueryTab();
    s.addQueryTab();
    const second = tabs()[1]!;
    useStudio.getState().closeQueryTab(second.id);
    expect(tabs().map((t) => t.number)).toEqual([1, 3]);
    useStudio.getState().addQueryTab();
    expect(tabs().map((t) => t.number)).toEqual([1, 3, 4]);
  });

  it('closing the last tab leaves a fresh first one', () => {
    const only = tabs()[0]!;
    useStudio.getState().closeQueryTab(only.id);
    expect(tabs()).toHaveLength(1);
    expect(tabs()[0]!.number).toBe(1);
    expect(tabs()[0]!.id).not.toBe(only.id);
  });
});
