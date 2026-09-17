'use client';

/**
 * ⌘K / Ctrl+K: go to any bridge or connection, or do the few things the app
 * does, without reaching for the mouse. `cmdk` and `ui/command` had been
 * installed since the first release; nothing ever used them.
 */
import { useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import {
  BookOpen,
  Database,
  FolderOpen,
  Moon,
  Pencil,
  Plus,
  Settings,
  Sun,
  Webhook,
} from 'lucide-react';
import { useBridges, useConnections, useWorkspaces } from '@/lib/queries';
import { useStudio } from '@/lib/store';
import {
  isPaletteShortcut,
  paletteCommands,
  type PaletteCommand,
  type PaletteGroup,
} from '@/lib/palette';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

const GROUPS: PaletteGroup[] = [
  'actions',
  'bridges',
  'connections',
  'workspaces',
];

function iconFor(command: PaletteCommand) {
  if (command.group === 'bridges') return Webhook;
  if (command.group === 'connections') return Database;
  if (command.group === 'workspaces') return FolderOpen;
  switch (command.id) {
    case 'new-bridge':
    case 'new-connection':
      return Plus;
    case 'data-sources':
      return Database;
    case 'settings':
      return Settings;
    case 'edit-bridge':
      return Pencil;
    case 'docs':
      return BookOpen;
    default:
      return Sun;
  }
}

export function CommandPalette() {
  const t = useTranslations('palette');
  const { theme, setTheme } = useTheme();
  const { data: bridges } = useBridges();
  const { data: connections } = useConnections();
  const { data: workspaces } = useWorkspaces();
  const {
    activeWorkspaceId,
    selectedBridgeId,
    selectBridge,
    openBridgeEditor,
    openDataSources,
    openConnectionDialog,
    openSettings,
    setActiveWorkspace,
    paletteOpen: open,
    setPaletteOpen: setOpen,
  } = useStudio();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      setOpen(!useStudio.getState().paletteOpen);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  const commands = useMemo(
    () =>
      paletteCommands({
        bridges: bridges ?? [],
        connections: connections ?? [],
        workspaces: workspaces ?? [],
        activeWorkspaceId,
        selectedBridgeId,
        theme,
        text: {
          newBridge: t('newBridge'),
          newConnection: t('newConnection'),
          dataSources: t('dataSources'),
          settings: t('settings'),
          editBridge: t('editBridge'),
          lightTheme: t('lightTheme'),
          darkTheme: t('darkTheme'),
          docs: t('docs'),
          switchTo: (name) => t('switchTo', { name }),
          editConnection: (name) => t('editConnection', { name }),
        },
        actions: {
          selectBridge,
          editBridge: (id) =>
            openBridgeEditor(id ? { editingId: id } : undefined),
          openDataSources,
          openConnection: (id) => openConnectionDialog(id),
          openSettings: () => openSettings('account'),
          setWorkspace: setActiveWorkspace,
          setTheme,
          openDocs: () =>
            window.open(
              'https://syncle.dev/docs',
              '_blank',
              'noopener,noreferrer',
            ),
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      bridges,
      connections,
      workspaces,
      activeWorkspaceId,
      selectedBridgeId,
      theme,
      t,
    ],
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title={t('title')}>
      <CommandInput placeholder={t('placeholder')} />
      <CommandList>
        <CommandEmpty>{t('nothing')}</CommandEmpty>
        {GROUPS.map((group) => {
          const items = commands.filter((c) => c.group === group);
          if (items.length === 0) return null;
          return (
            <CommandGroup key={group} heading={t(`group.${group}`)}>
              {items.map((command) => {
                const Icon =
                  command.id === 'theme' && theme !== 'dark'
                    ? Moon
                    : iconFor(command);
                return (
                  <CommandItem
                    key={command.id}
                    // cmdk filters on this: the visible words plus the hidden ones
                    value={[
                      command.label,
                      command.hint,
                      ...(command.keywords ?? []),
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onSelect={() => {
                      setOpen(false);
                      command.run();
                    }}
                  >
                    <Icon className="mr-2 h-4 w-4 shrink-0 opacity-70" />
                    <span className="truncate">{command.label}</span>
                    {command.hint && (
                      <span className="text-muted-foreground ml-auto pl-3 text-xs">
                        {command.hint}
                      </span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}
