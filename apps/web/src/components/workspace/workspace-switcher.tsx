'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronsUpDown, Plus, Trash2, Layers } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  useWorkspaces,
  useCreateWorkspace,
  useDeleteWorkspace,
} from '@/lib/queries';
import { readPersistedWorkspaceId, useStudio } from '@/lib/store';
import { DEFAULT_WORKSPACE_ID } from '@syncle/core';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export function WorkspaceSwitcher() {
  const t = useTranslations('workspaces');
  const tc = useTranslations('common');
  const { data: workspaces } = useWorkspaces();
  const activeWorkspaceId = useStudio((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useStudio((s) => s.setActiveWorkspace);
  const create = useCreateWorkspace();
  const del = useDeleteWorkspace();

  const [newOpen, setNewOpen] = useState(false);
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // once workspaces load, make sure something is selected. prefer keeping the
  // current one, then the persisted one (so a refresh returns to the same
  // workspace); otherwise fall back to the default, then the first.
  useEffect(() => {
    if (!workspaces || workspaces.length === 0) return;
    const stillThere = workspaces.some((w) => w.id === activeWorkspaceId);
    if (!stillThere) {
      const persisted = readPersistedWorkspaceId();
      const fallback =
        workspaces.find((w) => w.id === persisted) ??
        workspaces.find((w) => w.id === DEFAULT_WORKSPACE_ID) ??
        workspaces[0];
      if (fallback) setActiveWorkspace(fallback.id);
    }
  }, [workspaces, activeWorkspaceId, setActiveWorkspace]);

  const active = workspaces?.find((w) => w.id === activeWorkspaceId) ?? null;

  async function handleCreate() {
    // the Enter-key handler bypasses the button's disabled state
    if (create.isPending) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const ws = await create.mutateAsync({ name: trimmed });
      setActiveWorkspace(ws.id);
      setNewOpen(false);
      setName('');
      toast.success(t('created', { name: ws.name }));
    } catch (err) {
      toast.error(t('couldNotCreate'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleDelete() {
    if (!active) return;
    try {
      await del.mutateAsync(active.id);
      toast.success(t('deleted', { name: active.name }));
      setConfirmDelete(false);
    } catch (err) {
      toast.error(t('couldNotDelete'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 max-w-[150px] gap-1.5 px-2"
            title={t('switch')}
          >
            <Layers className="text-primary h-3.5 w-3.5 shrink-0" />
            <span className="truncate text-sm font-medium">
              {active?.name ?? t('fallback')}
            </span>
            <ChevronsUpDown className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel className="text-muted-foreground text-[11px] uppercase tracking-wide">
            {t('title')}
          </DropdownMenuLabel>
          {workspaces?.map((w) => (
            <DropdownMenuItem
              key={w.id}
              onClick={() => setActiveWorkspace(w.id)}
              className="gap-2"
            >
              <Check
                className={cn(
                  'h-4 w-4',
                  w.id === activeWorkspaceId ? 'opacity-100' : 'opacity-0',
                )}
              />
              <span className="truncate">{w.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setNewOpen(true)} className="gap-2">
            <Plus className="h-4 w-4" /> {t('new')}
          </DropdownMenuItem>
          {active && active.id !== DEFAULT_WORKSPACE_ID && (
            <DropdownMenuItem
              onClick={() => setConfirmDelete(true)}
              className="text-destructive focus:text-destructive gap-2"
            >
              <Trash2 className="h-4 w-4" /> {t('deleteNamed', { name: active.name })}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* New workspace dialog */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('new')}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={t('newPlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNewOpen(false)}>
              {tc('cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={!name.trim() || create.isPending}>
              {tc('create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deleteConfirmDescription', { name: active?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {tc('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
