'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ColumnDefinition, DatabaseEngine } from '@syncle/core';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Props {
  connectionId: string;
  engine: DatabaseEngine;
  database?: string;
  schema?: string;
  dataTypes: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type DraftColumn = ColumnDefinition & { id: number };

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

// one template shared by header + rows so checkbox columns line up exactly
const GRID =
  'grid grid-cols-[minmax(0,1.3fr)_minmax(0,1.3fr)_2.4rem_2.4rem_2.4rem_2.4rem_minmax(0,1.4fr)_2rem] items-center gap-2';

/** common default expressions offered as suggestions per engine */
function defaultPresets(engine: DatabaseEngine): string[] {
  switch (engine) {
    case 'postgres':
      return ['now()', 'CURRENT_TIMESTAMP', 'gen_random_uuid()', 'true', 'false', '0', "''"];
    case 'mysql':
      return ['CURRENT_TIMESTAMP', 'NOW()', 'UUID()', '0', '1', "''"];
    case 'sqlite':
      return ['CURRENT_TIMESTAMP', "(datetime('now'))", '0', "''"];
    default:
      return [];
  }
}

function timestampHint(
  engine: DatabaseEngine,
  t: ReturnType<typeof useTranslations>,
): string {
  if (engine === 'postgres')
    return t('timestampHint', { type: 'timestamptz', value: 'now()' });
  if (engine === 'mysql')
    return t('timestampHint', { type: 'datetime', value: 'CURRENT_TIMESTAMP' });
  if (engine === 'sqlite')
    return t('timestampHint', { type: 'TEXT', value: 'CURRENT_TIMESTAMP' });
  return '';
}

let columnId = 0;
function newColumn(type: string): DraftColumn {
  return {
    id: columnId++,
    name: '',
    type,
    nullable: true,
    primaryKey: false,
    autoIncrement: false,
    unique: false,
  };
}

export function CreateTableDialog({
  connectionId,
  engine,
  database,
  schema,
  dataTypes,
  open,
  onOpenChange,
}: Props) {
  const t = useTranslations('createTable');
  const tc = useTranslations('common');
  // Mongo (and other schemaless engines) expose no column types, a table is
  // just a named collection
  const schemaless = dataTypes.length === 0;
  const defaultType = dataTypes[0] ?? 'text';
  const presets = defaultPresets(engine);

  const [table, setTable] = useState('');
  const [columns, setColumns] = useState<DraftColumn[]>(() => {
    const id = newColumn(engine === 'sqlite' ? 'INTEGER' : defaultType);
    id.name = 'id';
    id.primaryKey = true;
    id.autoIncrement = true;
    id.nullable = false;
    return [id];
  });
  const [saving, setSaving] = useState(false);
  const qc = useQueryClient();

  function patch(id: number, change: Partial<DraftColumn>) {
    setColumns((cols) =>
      cols.map((c) => (c.id === id ? { ...c, ...change } : c)),
    );
  }

  async function handleCreate() {
    const tableName = table.trim();
    if (!IDENT.test(tableName)) {
      toast.error(t('invalidTableName'), {
        description: t('invalidTableNameDescription'),
      });
      return;
    }

    let payloadColumns: ColumnDefinition[];
    if (schemaless) {
      payloadColumns = [
        { name: '_id', type: 'objectId', nullable: false, primaryKey: true, autoIncrement: false },
      ];
    } else {
      // ignore fully-blank rows the user never filled in
      const defined = columns.filter((c) => c.name.trim() !== '');
      if (defined.length === 0) {
        toast.error(t('needNamedColumn'));
        return;
      }
      for (const c of defined) {
        if (!IDENT.test(c.name.trim())) {
          toast.error(t('invalidColumnName', { name: c.name }), {
            description: t('invalidColumnNameDescription'),
          });
          return;
        }
        if (!c.type.trim()) {
          toast.error(t('columnNeedsType', { name: c.name }));
          return;
        }
      }
      payloadColumns = defined.map((c) => ({
        name: c.name.trim(),
        type: c.type,
        nullable: c.nullable,
        primaryKey: c.primaryKey,
        autoIncrement: c.autoIncrement,
        unique: c.unique,
        defaultValue: c.defaultValue?.trim() || undefined,
      }));
    }

    setSaving(true);
    try {
      await api.createTable(
        connectionId,
        { schema, table: tableName, columns: payloadColumns },
        database,
      );
      await qc.invalidateQueries({
        queryKey: ['connections', connectionId, 'schema'],
      });
      toast.success(t('created', { name: tableName }));
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
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[840px]">
        <DialogHeader>
          <DialogTitle>
            {schemaless ? t('titleCollection') : t('titleTable')}
          </DialogTitle>
          <DialogDescription>
            {schemaless
              ? t('descriptionCollection')
              : t('descriptionTable')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="tbl-name">
              {schemaless ? t('collectionName') : t('tableName')}
            </Label>
            <Input
              id="tbl-name"
              value={table}
              onChange={(e) => setTable(e.target.value)}
              placeholder={schemaless ? 'events' : 'users'}
              autoFocus
            />
          </div>

          {!schemaless && (
            <div className="grid gap-2">
              <div
                className={`${GRID} px-1 text-[11px] font-medium text-muted-foreground`}
              >
                <span>{t('colName')}</span>
                <span>{t('colType')}</span>
                <span className="text-center" title={t('nullable')}>
                  {t('colNull')}
                </span>
                <span className="text-center" title={t('primaryKey')}>
                  {t('colPk')}
                </span>
                <span className="text-center" title={t('autoIncrement')}>
                  {t('colAi')}
                </span>
                <span className="text-center" title={t('unique')}>
                  {t('colUnique')}
                </span>
                <span>{t('colDefault')}</span>
                <span />
              </div>

              {columns.map((col) => (
                <div key={col.id} className={GRID}>
                  <Input
                    value={col.name}
                    placeholder={t('columnPlaceholder')}
                    className="h-8"
                    onChange={(e) => patch(col.id, { name: e.target.value })}
                  />
                  <Select
                    value={col.type}
                    onValueChange={(v) => patch(col.id, { type: v })}
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {dataTypes.map((dt) => (
                        <SelectItem key={dt} value={dt} className="font-mono">
                          {dt}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <input
                    type="checkbox"
                    aria-label={t('nullable')}
                    checked={col.nullable}
                    disabled={col.primaryKey}
                    onChange={(e) => patch(col.id, { nullable: e.target.checked })}
                    className="mx-auto h-4 w-4 accent-primary"
                  />
                  <input
                    type="checkbox"
                    aria-label={t('primaryKey')}
                    checked={col.primaryKey}
                    onChange={(e) =>
                      patch(col.id, {
                        primaryKey: e.target.checked,
                        nullable: e.target.checked ? false : col.nullable,
                      })
                    }
                    className="mx-auto h-4 w-4 accent-primary"
                  />
                  <input
                    type="checkbox"
                    aria-label={t('autoIncrement')}
                    checked={col.autoIncrement}
                    onChange={(e) =>
                      patch(col.id, {
                        autoIncrement: e.target.checked,
                        primaryKey: e.target.checked ? true : col.primaryKey,
                        nullable: e.target.checked ? false : col.nullable,
                      })
                    }
                    className="mx-auto h-4 w-4 accent-primary"
                  />
                  <input
                    type="checkbox"
                    aria-label={t('unique')}
                    checked={col.unique}
                    disabled={col.primaryKey}
                    onChange={(e) => patch(col.id, { unique: e.target.checked })}
                    className="mx-auto h-4 w-4 accent-primary"
                  />
                  <Input
                    list="omni-default-presets"
                    value={col.defaultValue ?? ''}
                    placeholder="—"
                    className="h-8"
                    onChange={(e) =>
                      patch(col.id, { defaultValue: e.target.value })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    disabled={columns.length === 1}
                    onClick={() =>
                      setColumns((cols) => cols.filter((c) => c.id !== col.id))
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}

              <datalist id="omni-default-presets">
                {presets.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>

              <Button
                variant="outline"
                size="sm"
                className="justify-self-start"
                onClick={() =>
                  setColumns((cols) => [...cols, newColumn(defaultType)])
                }
              >
                <Plus className="mr-1 h-4 w-4" /> {t('addColumn')}
              </Button>

              <p className="text-xs text-muted-foreground">
                {timestampHint(engine, t)} {t('identifierHint')}
              </p>
            </div>
          )}
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
