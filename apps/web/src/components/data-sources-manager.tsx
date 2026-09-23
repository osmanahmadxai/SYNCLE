'use client';

import { useTranslations } from 'next-intl';
import {
  Database,
  LayoutGrid,
  Network,
  Table2,
  TerminalSquare,
  X,
} from 'lucide-react';
import { useConnections } from '@/lib/queries';
import { useStudio, type StudioTab } from '@/lib/store';
import { cn } from '@/lib/utils';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ConnectionList } from '@/components/connections/connection-list';
import { SchemaTree } from '@/components/schema/schema-tree';
import { DataGrid } from '@/components/data/data-grid';
import { QueryEditor } from '@/components/query/query-editor';
import { StructureView } from '@/components/structure/structure-view';
import { ERDiagram } from '@/components/diagram/er-diagram';

// `labelKey` is a `dataSources` message key, translated where it is rendered
const TABS: { id: StudioTab; labelKey: string; icon: typeof Table2 }[] = [
  { id: 'data', labelKey: 'tabs.data', icon: LayoutGrid },
  { id: 'structure', labelKey: 'tabs.structure', icon: Table2 },
  { id: 'query', labelKey: 'tabs.query', icon: TerminalSquare },
  { id: 'diagram', labelKey: 'tabs.diagram', icon: Network },
];

/**
 * full database workbench (connections, schema, data browser, DDL) shown as an
 * overlay in the bridges app. data sources feed bridges, so it's one click away
 * rather than in the main chrome.
 */
export function DataSourcesManager() {
  const t = useTranslations('dataSources');
  const { dataSourcesOpen, closeDataSources, activeConnectionId, activeDatabase, selected, tab, setTab } =
    useStudio();
  const { data: connections } = useConnections();
  const conn = connections?.find((c) => c.id === activeConnectionId);

  if (!dataSourcesOpen) return null;

  return (
    <div className="bg-background fixed inset-0 z-40 flex flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Database className="text-primary h-5 w-5" />
        <span className="font-semibold tracking-tight">{t('title')}</span>
        <span className="text-muted-foreground text-xs">
          {t('subtitle')}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={closeDataSources}
        >
          <X className="mr-1.5 h-4 w-4" />
          {t('done')}
        </Button>
      </div>

      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize={22} minSize={16} maxSize={34}>
          <div className="flex h-full flex-col">
            <ConnectionList />
            <Separator className="my-1" />
            <SchemaTree />
          </div>
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel defaultSize={78}>
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-1 border-b px-3">
              <div className="text-muted-foreground flex h-11 items-center gap-1.5 pr-3 text-sm">
                {conn ? (
                  <>
                    <span className="text-foreground font-medium">{conn.name}</span>
                    {activeDatabase && (
                      <>
                        <span>/</span>
                        <span>{activeDatabase}</span>
                      </>
                    )}
                    {selected && (
                      <>
                        <span>/</span>
                        <span className="text-foreground font-mono">{selected.table}</span>
                      </>
                    )}
                  </>
                ) : (
                  <span>{t('selectConnection')}</span>
                )}
              </div>
              <div className="ml-auto flex items-center">
                {TABS.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setTab(item.id)}
                    className={cn(
                      'flex h-11 items-center gap-1.5 border-b-2 px-3 text-sm transition-colors',
                      tab === item.id
                        ? 'border-primary text-foreground'
                        : 'text-muted-foreground hover:text-foreground border-transparent',
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    {t(item.labelKey)}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1">
              {tab === 'data' && <DataGrid />}
              {tab === 'structure' && <StructureView />}
              {tab === 'query' && <QueryEditor />}
              {tab === 'diagram' && <ERDiagram />}
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
