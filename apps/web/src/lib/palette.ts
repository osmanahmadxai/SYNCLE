/**
 * What the command palette offers. Kept apart from the component — and from
 * React — so the list itself can be tested: which commands exist for a given
 * state of the app, what each is called, and that running one does the thing.
 */
export type PaletteGroup = 'actions' | 'bridges' | 'connections' | 'workspaces';

export interface PaletteCommand {
  id: string;
  group: PaletteGroup;
  label: string;
  /** extra words to match on (an engine name, a trigger kind), never shown */
  keywords?: string[];
  /** a second line: what the entry is */
  hint?: string;
  run(): void;
}

export interface PaletteInput {
  bridges: Array<{ id: string; name: string; trigger: { kind: string } }>;
  connections: Array<{ id: string; name: string; engine: string }>;
  workspaces: Array<{ id: string; name: string }>;
  activeWorkspaceId: string | null;
  selectedBridgeId: string | null;
  theme: string | undefined;
  /** the words, already translated */
  text: {
    newBridge: string;
    newConnection: string;
    dataSources: string;
    settings: string;
    editBridge: string;
    lightTheme: string;
    darkTheme: string;
    docs: string;
    switchTo(name: string): string;
    editConnection(name: string): string;
  };
  actions: {
    selectBridge(id: string): void;
    editBridge(id: string | null): void;
    openDataSources(): void;
    openConnection(id: string | null): void;
    openSettings(): void;
    setWorkspace(id: string): void;
    setTheme(theme: 'light' | 'dark'): void;
    openDocs(): void;
  };
}

export function paletteCommands(input: PaletteInput): PaletteCommand[] {
  const { text, actions } = input;
  const commands: PaletteCommand[] = [
    {
      id: 'new-bridge',
      group: 'actions',
      label: text.newBridge,
      keywords: ['create', 'add'],
      run: () => actions.editBridge(null),
    },
    {
      id: 'new-connection',
      group: 'actions',
      label: text.newConnection,
      keywords: ['create', 'add', 'database'],
      run: () => actions.openConnection(null),
    },
    {
      id: 'data-sources',
      group: 'actions',
      label: text.dataSources,
      keywords: ['tables', 'query', 'browse'],
      run: actions.openDataSources,
    },
    {
      id: 'settings',
      group: 'actions',
      label: text.settings,
      keywords: ['preferences', 'password'],
      run: actions.openSettings,
    },
  ];

  // only what makes sense right now: editing needs a bridge to edit
  const selected = input.bridges.find((b) => b.id === input.selectedBridgeId);
  if (selected) {
    commands.push({
      id: 'edit-bridge',
      group: 'actions',
      label: text.editBridge,
      hint: selected.name,
      run: () => actions.editBridge(selected.id),
    });
  }

  const dark = input.theme === 'dark';
  commands.push({
    id: 'theme',
    group: 'actions',
    label: dark ? text.lightTheme : text.darkTheme,
    keywords: ['theme', 'appearance', 'mode'],
    run: () => actions.setTheme(dark ? 'light' : 'dark'),
  });
  commands.push({
    id: 'docs',
    group: 'actions',
    label: text.docs,
    keywords: ['help', 'documentation'],
    run: actions.openDocs,
  });

  for (const bridge of input.bridges) {
    commands.push({
      id: `bridge:${bridge.id}`,
      group: 'bridges',
      label: bridge.name,
      keywords: [bridge.trigger.kind],
      hint: bridge.trigger.kind,
      run: () => actions.selectBridge(bridge.id),
    });
  }
  for (const connection of input.connections) {
    commands.push({
      id: `connection:${connection.id}`,
      group: 'connections',
      label: text.editConnection(connection.name),
      keywords: [connection.engine, connection.name],
      hint: connection.engine,
      run: () => actions.openConnection(connection.id),
    });
  }
  for (const workspace of input.workspaces) {
    if (workspace.id === input.activeWorkspaceId) continue; // already there
    commands.push({
      id: `workspace:${workspace.id}`,
      group: 'workspaces',
      label: text.switchTo(workspace.name),
      keywords: ['workspace'],
      run: () => actions.setWorkspace(workspace.id),
    });
  }
  return commands;
}

/** Ctrl+K, or ⌘K on a Mac — and not while the key is held down */
export function isPaletteShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
}): boolean {
  if (event.repeat || event.altKey || event.shiftKey) return false;
  return event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey);
}
