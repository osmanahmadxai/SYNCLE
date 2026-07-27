'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { KeyRound, LogOut, Settings, User } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuthStatus, useLogout } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SettingsDialog } from './settings-dialog';

export function UserMenu() {
  const t = useTranslations('userMenu');
  const { data: status } = useAuthStatus();
  const logout = useLogout();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('account');

  const username = status?.user?.username ?? t('account');

  function openSettings(tab: string) {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }

  async function handleLogout() {
    try {
      await logout.mutateAsync();
    } catch (err) {
      toast.error(t('couldNotLogout'), {
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
            size="icon"
            className="h-8 w-8"
            title={t('account')}
          >
            <User className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel className="truncate">{username}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => openSettings('account')}
            className="gap-2"
          >
            <Settings className="h-4 w-4" /> {t('settings')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => openSettings('account')}
            className="gap-2"
          >
            <KeyRound className="h-4 w-4" /> {t('changePassword')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={handleLogout}
            disabled={logout.isPending}
            className="text-destructive focus:text-destructive gap-2"
          >
            <LogOut className="h-4 w-4" /> {t('logout')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <SettingsDialog
        key={settingsTab}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialTab={settingsTab}
      />
    </>
  );
}
