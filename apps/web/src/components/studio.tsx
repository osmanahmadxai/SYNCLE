'use client';

import { useEffect, useRef } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { BookOpen, Database } from 'lucide-react';
import { useStudio } from '@/lib/store';
import { createUrlSync, type UrlState } from '@/lib/url-state';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ThemeToggle } from '@/components/theme-toggle';
import { LangToggle } from '@/components/lang-toggle';
import { UserMenu } from '@/components/settings/user-menu';
import { ConnectionDialog } from '@/components/connections/connection-dialog';
import { BridgesView } from '@/components/bridges/bridges-view';
import { BridgeList } from '@/components/bridges/bridge-list';
import { BridgeBuilder } from '@/components/bridges/bridge-builder';
import { DataSourcesManager } from '@/components/data-sources-manager';
import { WorkspaceSwitcher } from '@/components/workspace/workspace-switcher';

/**
 * the app is a bridges workspace. sidebar lists bridges, main panel shows the
 * selected bridge's jobs. connecting, browsing tables and DDL live in the Data
 * Sources surface and the Bridge Builder. data sources exist to feed bridges.
 */
export function Studio() {
  const t = useTranslations('nav');
  const {
    selectedBridgeId,
    selectBridge,
    dataSourcesOpen,
    openDataSources,
    bridgeEditor,
    openBridgeEditor,
    closeBridgeEditor,
    closeDataSources,
  } = useStudio();

  // the UI's place lives in the URL, in both directions. it used to be written
  // with replaceState and read once: the whole app was ONE history entry, so
  // Back left Syncle instead of returning to the bridge you were on, and
  // Forward into the app changed the address bar and nothing else
  const sync = useRef<ReturnType<typeof createUrlSync> | null>(null);

  useEffect(() => {
    const created = createUrlSync(
      {
        search: () => window.location.search,
        pathname: () => window.location.pathname,
        push: (url) => window.history.pushState(null, '', url),
        replace: (url) => window.history.replaceState(null, '', url),
        onPop: (listener) => {
          window.addEventListener('popstate', listener);
          return () => window.removeEventListener('popstate', listener);
        },
      },
      {
        // the store itself, not this render's snapshot of it
        get: () => {
          const now = useStudio.getState();
          return {
            bridge: now.selectedBridgeId,
            data: now.dataSourcesOpen,
            edit: now.bridgeEditor.open
              ? (now.bridgeEditor.editingId ?? 'new')
              : null,
          };
        },
        apply: (state: UrlState) => {
          const now = useStudio.getState();
          if (now.selectedBridgeId !== state.bridge) selectBridge(state.bridge);
          if (state.data && !now.dataSourcesOpen) openDataSources();
          if (!state.data && now.dataSourcesOpen) closeDataSources();
          const editing = now.bridgeEditor.open
            ? (now.bridgeEditor.editingId ?? 'new')
            : null;
          if (state.edit === editing) return;
          if (state.edit === null) closeBridgeEditor();
          else
            openBridgeEditor(
              state.edit === 'new' ? undefined : { editingId: state.edit },
            );
        },
      },
    );
    sync.current = created;
    return created.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    sync.current?.write();
  }, [
    selectedBridgeId,
    dataSourcesOpen,
    bridgeEditor.open,
    bridgeEditor.editingId,
  ]);

  return (
    <>
      <ResizablePanelGroup direction="horizontal" className="h-screen">
        {/* sidebar, bridges only */}
        <ResizablePanel defaultSize={22} minSize={16} maxSize={32}>
          <div className="flex h-full flex-col border-r">
            <div className="flex items-center justify-between px-3 py-2.5">
              <div className="flex items-center">
                {/* dark artwork in light mode, white artwork in dark mode */}
                <Image
                  src="/logo-dark.png"
                  alt="Syncle"
                  width={747}
                  height={412}
                  priority
                  className="h-7 w-auto dark:hidden"
                />
                <Image
                  src="/logo-white.png"
                  alt="Syncle"
                  width={747}
                  height={412}
                  priority
                  className="hidden h-7 w-auto dark:block"
                />
              </div>
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  title={t('dataSources')}
                  onClick={openDataSources}
                >
                  <Database className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                  <a
                    href="https://syncle.dev/docs"
                    target="_blank"
                    rel="noreferrer noopener"
                    title={t('docs')}
                    aria-label={t('docs')}
                  >
                    <BookOpen className="h-4 w-4" />
                  </a>
                </Button>
                <ThemeToggle />
                <LangToggle />
                <UserMenu />
              </div>
            </div>
            <Separator />
            {/* which workspace you're in — scopes the bridges + connections below */}
            <div className="px-2 py-1.5">
              <WorkspaceSwitcher />
            </div>
            <Separator />
            <BridgeList />
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* main, the bridges workspace */}
        <ResizablePanel defaultSize={78}>
          <BridgesView />
        </ResizablePanel>
      </ResizablePanelGroup>

      <ConnectionDialog />
      <BridgeBuilder />
      <DataSourcesManager />
    </>
  );
}
