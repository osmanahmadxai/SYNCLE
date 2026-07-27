'use client';

import { useEffect } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { Database } from 'lucide-react';
import { useStudio } from '@/lib/store';
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
import { AutomationsView } from '@/components/automations/automations-view';
import { HookList } from '@/components/automations/hook-list';
import { HookBuilder } from '@/components/automations/hook-builder';
import { DataSourcesManager } from '@/components/data-sources-manager';
import { WorkspaceSwitcher } from '@/components/workspace/workspace-switcher';

/**
 * the app is a hooks workspace. sidebar lists hooks, main panel shows the
 * selected hook's runs. connecting, browsing tables and DDL live in the Data
 * Sources surface and the Hook Builder. data sources exist to feed hooks.
 */
export function Studio() {
  const t = useTranslations('nav');
  const {
    selectedHookId,
    selectHook,
    dataSourcesOpen,
    openDataSources,
    hookEditor,
    openHookEditor,
  } = useStudio();

  // restore UI state from the URL on load and keep the URL in sync, so a
  // refresh keeps you on the same hook/surface instead of bouncing to root
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const hook = p.get('hook');
    if (hook) selectHook(hook);
    if (p.get('data') === '1') openDataSources();
    const edit = p.get('edit');
    if (edit) openHookEditor({ editingId: edit });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const p = new URLSearchParams();
    if (selectedHookId) p.set('hook', selectedHookId);
    if (dataSourcesOpen) p.set('data', '1');
    if (hookEditor.open && hookEditor.editingId)
      p.set('edit', hookEditor.editingId);
    const qs = p.toString();
    window.history.replaceState(
      null,
      '',
      qs ? `?${qs}` : window.location.pathname,
    );
  }, [selectedHookId, dataSourcesOpen, hookEditor.open, hookEditor.editingId]);

  return (
    <>
      <ResizablePanelGroup direction="horizontal" className="h-screen">
        {/* sidebar, hooks only */}
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
            <HookList />
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* main, the hooks workspace */}
        <ResizablePanel defaultSize={78}>
          <AutomationsView />
        </ResizablePanel>
      </ResizablePanelGroup>

      <ConnectionDialog />
      <HookBuilder />
      <DataSourcesManager />
    </>
  );
}
