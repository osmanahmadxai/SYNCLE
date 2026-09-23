'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { QueryColumn } from '@syncle/core';
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
  database?: string;
  schema?: string;
  table: string;
  columns: QueryColumn[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function RowEditorDialog({
  connectionId,
  database,
  schema,
  table,
  columns,
  open,
  onOpenChange,
  onSaved,
}: Props) {
  const t = useTranslations('rowEditor');
  const tc = useTranslations('common');
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(values)) {
        if (v !== '') payload[k] = v;
      }
      await api.insertRow(
        connectionId,
        { schema, table, values: payload },
        database,
      );
      toast.success(t('rowInserted'));
      setValues({});
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(t('insertFailed'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t('title', { table })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          {columns.map((col) => (
            <div key={col.name} className="grid gap-1.5">
              <Label htmlFor={`row-${col.name}`} className="text-xs">
                {col.name}
                {col.dataType && (
                  <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                    {col.dataType}
                  </span>
                )}
              </Label>
              <Input
                id={`row-${col.name}`}
                value={values[col.name] ?? ''}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [col.name]: e.target.value }))
                }
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('insert')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
