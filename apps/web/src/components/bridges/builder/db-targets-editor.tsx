'use client';

/* -------------------------------------------------------------------------- */
/* database destination editor                                                */
/* -------------------------------------------------------------------------- */

import { useMemo, useState, type Dispatch } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { TableSchema } from '@syncle/core';
import { useConnections, useDatabases, useSchema } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { BuilderAction, DbTarget } from './draft';

export function DbTargetsEditor({
  targets,
  dispatch,
  sourceColumns,
  sourcePk,
}: {
  targets: DbTarget[];
  dispatch: Dispatch<BuilderAction>;
  sourceColumns: string[];
  sourcePk: string | null;
}) {
  const t = useTranslations('bridgeBuilder');
  const patch = (i: number, p: Partial<DbTarget>) =>
    dispatch({ type: 'patchDbTarget', index: i, patch: p });
  const add = () => dispatch({ type: 'addDbTarget', sourcePk });
  const remove = (i: number) => dispatch({ type: 'removeDbTarget', index: i });

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-[11px]">
        {t('dbDescPre')} <strong>{t('dbDescUpsert')}</strong> {t('dbDescPost')}
      </p>
      {targets.map((t, i) => (
        <DbTargetCard
          key={i}
          target={t}
          sourceColumns={sourceColumns}
          onChange={(p) => patch(i, p)}
          onRemove={targets.length > 1 ? () => remove(i) : undefined}
        />
      ))}
      <Button variant="outline" size="sm" className="h-7" onClick={add}>
        <Plus className="mr-1 h-3.5 w-3.5" /> {t('addTargetDb')}
      </Button>
    </div>
  );
}

function DbTargetCard({
  target,
  sourceColumns,
  onChange,
  onRemove,
}: {
  target: DbTarget;
  sourceColumns: string[];
  onChange: (patch: Partial<DbTarget>) => void;
  onRemove?: () => void;
}) {
  const t = useTranslations('bridgeBuilder');
  const { data: connections } = useConnections();
  const { data: databases } = useDatabases(target.connectionId || null);
  const { data: schemaData } = useSchema(
    target.connectionId || null,
    target.database || undefined,
  );
  const [showMap, setShowMap] = useState(false);
  const tables = useMemo<TableSchema[]>(
    () => schemaData?.namespaces.flatMap((ns) => ns.tables) ?? [],
    [schemaData],
  );
  const conn = connections?.find((c) => c.id === target.connectionId);
  // target column names the row will be written under (after renames)
  const targetNames = sourceColumns.map(
    (s) => target.renames[s]?.trim() || s,
  );

  const toggleKey = (name: string) =>
    onChange({
      keyColumns: target.keyColumns.includes(name)
        ? target.keyColumns.filter((k) => k !== name)
        : [...target.keyColumns, name],
    });

  return (
    <div className="space-y-2 rounded-md border p-2.5">
      <div className="flex items-center gap-2">
        <Select
          value={target.connectionId}
          onValueChange={(v) =>
            onChange({ connectionId: v, database: '', schema: '', table: '' })
          }
        >
          <SelectTrigger className="h-8 flex-1">
            <SelectValue placeholder={t('targetConnection')} />
          </SelectTrigger>
          <SelectContent>
            {(connections?.length ?? 0) === 0 && (
              <div className="text-muted-foreground px-2 py-1.5 text-xs">
                {t('noConnections')}
              </div>
            )}
            {connections?.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
                <span className="text-muted-foreground ml-1.5 text-[10px] uppercase">
                  {c.engine}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {onRemove && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={onRemove}
            title={t('removeTarget')}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {(databases?.length ?? 0) > 0 && (
          <Select
            value={target.database || '__default'}
            onValueChange={(v) =>
              onChange({ database: v === '__default' ? '' : v, table: '' })
            }
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default">{t('defaultDb')}</SelectItem>
              {databases?.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {conn?.engine === 'postgres' && (
          <Input
            className="h-8"
            placeholder={t('schemaPlaceholder')}
            value={target.schema}
            onChange={(e) => onChange({ schema: e.target.value })}
          />
        )}
      </div>

      <div className="grid gap-1.5">
        <Label className="text-xs">{t('targetTable')}</Label>
        <Input
          className="h-8"
          list={`tables-${target.connectionId}`}
          placeholder={t('tableNamePlaceholder')}
          value={target.table}
          onChange={(e) => onChange({ table: e.target.value })}
        />
        <datalist id={`tables-${target.connectionId}`}>
          {tables.map((t) => (
            <option key={`${t.schema ?? ''}.${t.name}`} value={t.name} />
          ))}
        </datalist>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1.5">
          <Label className="text-xs">{t('writeMode')}</Label>
          <Select
            value={target.writeMode}
            onValueChange={(v) =>
              onChange({ writeMode: v as DbTarget['writeMode'] })
            }
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="upsert">{t('upsertOpt')}</SelectItem>
              <SelectItem value="insert">{t('insertOpt')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-end justify-between gap-2 pb-1">
          <span className="text-xs">{t('createIfMissing')}</span>
          <Switch
            checked={target.createMissingTable}
            onCheckedChange={(v) => onChange({ createMissingTable: v })}
          />
        </label>
      </div>

      {target.writeMode === 'upsert' && (
        <div className="grid gap-1.5">
          <Label className="text-xs">
            {t('keyColumns')}{' '}
            <span className="text-muted-foreground">
              {t('keyColumnsHint')}
            </span>
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {targetNames.length === 0 && (
              <span className="text-muted-foreground text-[11px]">
                {t('selectSourceFirst')}
              </span>
            )}
            {targetNames.map((name) => {
              const on = target.keyColumns.includes(name);
              return (
                <button
                  key={name}
                  onClick={() => toggleKey(name)}
                  className={cn(
                    'rounded border px-1.5 py-0.5 text-[11px] transition-colors',
                    on
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'hover:bg-accent',
                  )}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <button
        onClick={() => setShowMap((s) => !s)}
        className="text-muted-foreground hover:text-foreground text-[11px] underline"
      >
        {showMap ? t('hideMapping') : t('mapRename')}
      </button>
      {showMap && (
        <div className="grid gap-1 rounded-md border p-2">
          <div className="text-muted-foreground grid grid-cols-2 gap-2 text-[10px] uppercase">
            <span>{t('sourceColumn')}</span>
            <span>{t('targetColumn')}</span>
          </div>
          {sourceColumns.map((s) => (
            <div key={s} className="grid grid-cols-2 items-center gap-2">
              <span className="truncate font-mono text-[11px]">{s}</span>
              <Input
                className="h-7 text-xs"
                value={target.renames[s] ?? ''}
                placeholder={s}
                onChange={(e) => {
                  const renames = { ...target.renames };
                  if (e.target.value.trim()) renames[s] = e.target.value;
                  else delete renames[s];
                  onChange({ renames });
                }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
