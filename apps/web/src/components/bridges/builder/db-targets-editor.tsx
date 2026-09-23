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
import { ConnectionBadges } from '@/components/connections/connection-badges';
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
import {
  defaultKeyTemplate,
  redisTargetProblem,
  type RedisTargetProblem,
} from './redis-target';

export function DbTargetsEditor({
  targets,
  dispatch,
  sourceColumns,
  sourcePk,
  sourceTable,
}: {
  targets: DbTarget[];
  dispatch: Dispatch<BuilderAction>;
  sourceColumns: string[];
  sourcePk: string | null;
  sourceTable?: string | null;
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
          sourcePk={sourcePk}
          sourceTable={sourceTable}
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
  sourcePk,
  sourceTable,
  onChange,
  onRemove,
}: {
  target: DbTarget;
  sourceColumns: string[];
  sourcePk: string | null;
  sourceTable?: string | null;
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

  // Redis has no tables, no columns and no upsert: a target there is either a
  // key per row (built from a template) or, as before, the row's own `key` and
  // `value` columns. everything that only means something for a table is hidden
  const inRedis = conn?.engine === 'redis';
  const asKeys = inRedis && target.redisMode === 'template';
  const redisProblem = asKeys ? redisTargetProblem(target, targetNames) : null;

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
          onValueChange={(v) => {
            const picked = connections?.find((c) => c.id === v);
            onChange(
              picked?.engine === 'redis'
                ? {
                    connectionId: v,
                    database: '',
                    schema: '',
                    // (Redis has one keyspace; the API wants a name all the same)
                    table: 'keys',
                    redisMode: 'template',
                    redisKeyTemplate:
                      target.redisKeyTemplate ||
                      defaultKeyTemplate(
                        sourceTable,
                        sourcePk && (target.renames[sourcePk]?.trim() || sourcePk),
                        targetNames,
                      ),
                    onDelete: target.onDelete === 'soft' ? 'delete' : target.onDelete,
                  }
                : {
                    connectionId: v,
                    database: '',
                    schema: '',
                    table: '',
                    redisMode: 'columns',
                  },
            );
          }}
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
              // a bridge WRITES to its target: a read-only connection is shown,
              // so that it is not mysteriously missing, and cannot be picked
              <SelectItem key={c.id} value={c.id} disabled={c.readOnly === true}>
                {c.name}
                <span className="text-muted-foreground ml-1.5 text-[10px] uppercase">
                  {c.engine}
                </span>
                <ConnectionBadges connection={c} className="ml-1.5" />
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

      {inRedis && (
        <RedisTargetFields
          target={target}
          columns={targetNames}
          problem={redisProblem}
          onChange={onChange}
          defaultTemplate={defaultKeyTemplate(
            sourceTable,
            sourcePk && (target.renames[sourcePk]?.trim() || sourcePk),
            targetNames,
          )}
        />
      )}

      {!inRedis && (
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
      )}

      {!inRedis && (
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
      )}

      {target.writeMode === 'upsert' && !asKeys && (
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

      {target.writeMode === 'upsert' && (
        <div className="grid gap-1.5">
          <Label className="text-xs">{t('onDelete')}</Label>
          <Select
            value={target.onDelete}
            onValueChange={(v) => onChange({ onDelete: v as DbTarget['onDelete'] })}
          >
            <SelectTrigger className="h-8" aria-label={t('onDelete')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="delete">{t('onDeleteDelete')}</SelectItem>
              {/* a key is there or it is not: there is no column to mark it in */}
              {!asKeys && <SelectItem value="soft">{t('onDeleteSoft')}</SelectItem>}
              <SelectItem value="ignore">{t('onDeleteIgnore')}</SelectItem>
            </SelectContent>
          </Select>
          {target.onDelete === 'soft' && !asKeys && (
            <div className="grid grid-cols-2 gap-2">
              <Input
                className="h-8 font-mono text-xs"
                value={target.softDeleteColumn}
                placeholder="deleted_at"
                aria-label={t('softDeleteColumn')}
                onChange={(e) => onChange({ softDeleteColumn: e.target.value })}
              />
              <Select
                value={target.softDeleteValue}
                onValueChange={(v) =>
                  onChange({ softDeleteValue: v as DbTarget['softDeleteValue'] })
                }
              >
                <SelectTrigger className="h-8" aria-label={t('softDeleteValue')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="timestamp">{t('softDeleteTimestamp')}</SelectItem>
                  <SelectItem value="boolean">{t('softDeleteBoolean')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <p className="text-muted-foreground text-[11px]">
            {target.onDelete === 'soft'
              ? t('onDeleteSoftHint')
              : target.onDelete === 'ignore'
                ? t('onDeleteIgnoreHint')
                : t('onDeleteDeleteHint')}
          </p>
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

/**
 * a target in Redis: a key per row (what it is built from, what it holds, when
 * it expires) — or, as before this existed, the row's own `key` and `value`
 */
function RedisTargetFields({
  target,
  columns,
  problem,
  defaultTemplate,
  onChange,
}: {
  target: DbTarget;
  columns: string[];
  problem: { problem: RedisTargetProblem; column?: string } | null;
  defaultTemplate: string;
  onChange: (patch: Partial<DbTarget>) => void;
}) {
  // (its own name: the message guard ties a translator to its namespace by variable)
  const tr = useTranslations('bridgeBuilder.redis');
  const asKeys = target.redisMode === 'template';
  return (
    <div className="grid gap-2">
      <div className="grid gap-1.5">
        <Label className="text-xs">{tr('mode')}</Label>
        <Select
          value={target.redisMode}
          onValueChange={(v) =>
            onChange(
              v === 'template'
                ? {
                    redisMode: 'template',
                    redisKeyTemplate: target.redisKeyTemplate || defaultTemplate,
                    onDelete: target.onDelete === 'soft' ? 'delete' : target.onDelete,
                  }
                : { redisMode: 'columns' },
            )
          }
        >
          <SelectTrigger className="h-8" aria-label={tr('mode')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="template">{tr('modeTemplate')}</SelectItem>
            <SelectItem value="columns">{tr('modeColumns')}</SelectItem>
          </SelectContent>
        </Select>
        {!asKeys && (
          <p className="text-muted-foreground text-[11px]">{tr('modeColumnsHint')}</p>
        )}
      </div>

      {asKeys && (
        <>
          <div className="grid gap-1.5">
            <Label className="text-xs" htmlFor="redis-key-template">
              {tr('keyTemplate')}
            </Label>
            <Input
              id="redis-key-template"
              className="h-8 font-mono text-xs"
              value={target.redisKeyTemplate}
              placeholder={defaultTemplate}
              spellCheck={false}
              onChange={(e) => onChange({ redisKeyTemplate: e.target.value })}
            />
            <div className="flex flex-wrap gap-1.5">
              {columns.map((name) => (
                <button
                  key={name}
                  type="button"
                  title={tr('insertColumn', { column: name })}
                  onClick={() =>
                    onChange({
                      redisKeyTemplate: `${target.redisKeyTemplate}{{${name}}}`,
                    })
                  }
                  className="hover:bg-accent rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors"
                >
                  {`{{${name}}}`}
                </button>
              ))}
            </div>
            <p className="text-muted-foreground text-[11px]">{tr('keyTemplateHint')}</p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label className="text-xs">{tr('type')}</Label>
              <Select
                value={target.redisType}
                onValueChange={(v) => onChange({ redisType: v as DbTarget['redisType'] })}
              >
                <SelectTrigger className="h-8" aria-label={tr('type')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hash">{tr('typeHash')}</SelectItem>
                  <SelectItem value="json">{tr('typeJson')}</SelectItem>
                  <SelectItem value="string">{tr('typeString')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs" htmlFor="redis-ttl">
                {tr('ttl')}
              </Label>
              <Input
                id="redis-ttl"
                className="h-8"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                placeholder={tr('ttlNever')}
                value={target.redisTtlSeconds ?? ''}
                onChange={(e) => {
                  const text = e.target.value.trim();
                  onChange({ redisTtlSeconds: text === '' ? null : Number(text) });
                }}
              />
            </div>
          </div>

          {target.redisType === 'string' && (
            <div className="grid gap-1.5">
              <Label className="text-xs">{tr('valueColumn')}</Label>
              <Select
                value={target.redisValueColumn}
                onValueChange={(v) => onChange({ redisValueColumn: v })}
              >
                <SelectTrigger className="h-8" aria-label={tr('valueColumn')}>
                  <SelectValue placeholder={tr('valueColumnPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {columns.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <p className="text-muted-foreground text-[11px]">
            {target.redisType === 'hash'
              ? tr('typeHashHint')
              : target.redisType === 'json'
                ? tr('typeJsonHint')
                : tr('typeStringHint')}
          </p>
          {problem && (
            <p role="alert" className="text-destructive text-[11px]">
              {tr(`problem.${problem.problem}`, { column: problem.column ?? '' })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
