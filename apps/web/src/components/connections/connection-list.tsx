'use client';

import { MoreVertical, Pencil, PlugZap, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useConnections, useDeleteConnection } from '@/lib/queries';
import { useStudio } from '@/lib/store';
import { engineMeta } from '@/lib/engines';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function ConnectionList() {
  const t = useTranslations('connections');
  const tc = useTranslations('common');
  const { data: connections, isLoading } = useConnections();
  const { activeConnectionId, setActiveConnection, openConnectionDialog } =
    useStudio();
  const del = useDeleteConnection();

  async function handleTest(id: string) {
    try {
      await api.testSavedConnection(id);
      toast.success(t('successful'));
    } catch (err) {
      toast.error(t('failed'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleDelete(id: string) {
    try {
      await del.mutateAsync(id);
      if (activeConnectionId === id) setActiveConnection(null);
      toast.success(t('removed'));
    } catch (err) {
      toast.error(t('deleteFailed'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('title')}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={t('new')}
          onClick={() => openConnectionDialog()}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-0.5 px-2">
        {isLoading &&
          Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}

        {connections?.length === 0 && (
          <button
            onClick={() => openConnectionDialog()}
            className="w-full rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground hover:bg-accent"
          >
            {t('noneYet')}
            <br />
            {t('clickToAdd')}
          </button>
        )}

        {connections?.map((conn) => {
          const meta = engineMeta(conn.engine);
          const active = conn.id === activeConnectionId;
          return (
            <div
              key={conn.id}
              className={cn(
                'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                active ? 'bg-accent' : 'hover:bg-accent/60',
              )}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => setActiveConnection(conn.id)}
              >
                <span
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded text-[10px] font-bold',
                    meta.className,
                  )}
                >
                  {meta.abbr}
                </span>
                <span className="min-w-0 flex-1 truncate">{conn.name}</span>
              </button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => handleTest(conn.id)}>
                    <PlugZap className="mr-2 h-4 w-4" /> {tc('test')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => openConnectionDialog(conn.id)}
                  >
                    <Pencil className="mr-2 h-4 w-4" /> {tc('edit')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => handleDelete(conn.id)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" /> {tc('delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </div>
    </div>
  );
}
