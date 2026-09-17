import { describe, expect, it, vi } from 'vitest';
import {
  isPaletteShortcut,
  paletteCommands,
  type PaletteInput,
} from './palette';

function input(over: Partial<PaletteInput> = {}): PaletteInput {
  return {
    bridges: [
      { id: 'b1', name: 'Orders to warehouse', trigger: { kind: 'cdc' } },
      { id: 'b2', name: 'Nightly users', trigger: { kind: 'replay' } },
    ],
    connections: [{ id: 'c1', name: 'Prod', engine: 'postgres' }],
    workspaces: [
      { id: 'w1', name: 'Default' },
      { id: 'w2', name: 'Staging' },
    ],
    activeWorkspaceId: 'w1',
    selectedBridgeId: null,
    theme: 'light',
    text: {
      newBridge: 'New bridge',
      newConnection: 'New connection',
      dataSources: 'Data sources',
      settings: 'Settings',
      editBridge: 'Edit this bridge',
      lightTheme: 'Light theme',
      darkTheme: 'Dark theme',
      docs: 'Documentation',
      switchTo: (n) => `Switch to ${n}`,
      editConnection: (n) => `Edit connection ${n}`,
    },
    actions: {
      selectBridge: vi.fn(),
      editBridge: vi.fn(),
      openDataSources: vi.fn(),
      openConnection: vi.fn(),
      openSettings: vi.fn(),
      setWorkspace: vi.fn(),
      setTheme: vi.fn(),
      openDocs: vi.fn(),
    },
    ...over,
  };
}

const byId = (cmds: ReturnType<typeof paletteCommands>, id: string) => {
  const found = cmds.find((c) => c.id === id);
  if (!found) throw new Error(`no command ${id}`);
  return found;
};

describe('the command palette', () => {
  it('lists every bridge and connection, and running one goes there', () => {
    const i = input();
    const cmds = paletteCommands(i);
    byId(cmds, 'bridge:b2').run();
    expect(i.actions.selectBridge).toHaveBeenCalledWith('b2');
    byId(cmds, 'connection:c1').run();
    expect(i.actions.openConnection).toHaveBeenCalledWith('c1');
    expect(byId(cmds, 'connection:c1').label).toBe('Edit connection Prod');
  });

  it('can be found by what a thing IS, not only by its name', () => {
    const cmds = paletteCommands(input());
    expect(byId(cmds, 'bridge:b1').keywords).toContain('cdc');
    expect(byId(cmds, 'connection:c1').keywords).toContain('postgres');
  });

  it('creates things', () => {
    const i = input();
    const cmds = paletteCommands(i);
    byId(cmds, 'new-bridge').run();
    expect(i.actions.editBridge).toHaveBeenCalledWith(null);
    byId(cmds, 'new-connection').run();
    expect(i.actions.openConnection).toHaveBeenCalledWith(null);
  });

  it('offers "edit this bridge" only when there is a bridge to edit', () => {
    expect(paletteCommands(input()).some((c) => c.id === 'edit-bridge')).toBe(
      false,
    );
    const i = input({ selectedBridgeId: 'b1' });
    const edit = byId(paletteCommands(i), 'edit-bridge');
    expect(edit.hint).toBe('Orders to warehouse');
    edit.run();
    expect(i.actions.editBridge).toHaveBeenCalledWith('b1');
    // a selection that no longer exists (deleted elsewhere) offers nothing
    expect(
      paletteCommands(input({ selectedBridgeId: 'gone' })).some(
        (c) => c.id === 'edit-bridge',
      ),
    ).toBe(false);
  });

  it('offers the OTHER theme, and the other workspaces', () => {
    const light = input();
    byId(paletteCommands(light), 'theme').run();
    expect(byId(paletteCommands(light), 'theme').label).toBe('Dark theme');
    expect(light.actions.setTheme).toHaveBeenCalledWith('dark');
    expect(byId(paletteCommands(input({ theme: 'dark' })), 'theme').label).toBe(
      'Light theme',
    );

    const cmds = paletteCommands(input());
    expect(cmds.some((c) => c.id === 'workspace:w1')).toBe(false);
    expect(byId(cmds, 'workspace:w2').label).toBe('Switch to Staging');
  });

  it('has no two commands with the same id', () => {
    const ids = paletteCommands(input({ selectedBridgeId: 'b1' })).map(
      (c) => c.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the shortcut', () => {
  const key = (over: Record<string, unknown>) => ({
    key: 'k',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });

  it('is Ctrl+K or ⌘K', () => {
    expect(isPaletteShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isPaletteShortcut(key({ metaKey: true }))).toBe(true);
    expect(isPaletteShortcut(key({ metaKey: true, key: 'K' }))).toBe(true);
  });

  it('is nothing else', () => {
    expect(isPaletteShortcut(key({}))).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true, key: 'j' }))).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(
      false,
    );
    expect(isPaletteShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
    // held down: one press, one toggle
    expect(isPaletteShortcut(key({ ctrlKey: true, repeat: true }))).toBe(false);
  });
});
