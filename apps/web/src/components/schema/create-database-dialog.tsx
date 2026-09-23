'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Props {
  connectionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateDatabaseDialog({
  connectionId,
  open,
  onOpenChange,
}: Props) {
  const t = useTranslations('createDatabase');
  const tc = useTranslations('common');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const qc = useQueryClient();

  async function handleCreate() {
    // the Enter-key handler bypasses the button's disabled state
    if (saving) return;
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.createDatabase(connectionId, name.trim());
      await qc.invalidateQueries({
        queryKey: ['connections', connectionId, 'databases'],
      });
      toast.success(t('created', { name: name.trim() }));
      setName('');
      onOpenChange(false);
    } catch (err) {
      toast.error(t('createFailed'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5 py-2">
          <Label htmlFor="db-name">{t('name')}</Label>
          <Input
            id="db-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="analytics"
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {tc('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
