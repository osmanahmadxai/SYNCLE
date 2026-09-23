'use client';

/**
 * a bridge per table, for many tables at once: pick a source connection, tick
 * the tables, say where they go. what it makes are ordinary bridges — each can
 * be opened, filtered, transformed, verified and deleted like any other — so
 * this is a way of not going through the builder thirty times, and nothing more.
 *
 * on a PostgreSQL source the bridges it makes read through ONE shared
 * replication slot unless told otherwise, which is the point of making thirty.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Layers, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type {
  BridgeBulkInput,
  BridgeBulkResult,
  DatabaseSchema,
} from '@syncle/core';
import { ApiError } from '@/lib/api';
import { useBulkBridges, useConnections, useSchema } from '@/lib/queries';
import { useStudio } from '@/lib/store';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface BulkForm {
  sourceId: string;
  /** `schema.table` of every ticked table */
  picked: Set<string>;
  destinationId: string;
  destinationSchema: string;
  tablePrefix: string;
  mode: 'cdc' | 'replay';
  startFrom: 'now' | 'beginning';
  slot: 'own' | 'shared';
}

export const blankBulkForm = (): BulkForm => ({
  sourceId: '',
  picked: new Set(),
  destinationId: '',
  destinationSchema: '',
  tablePrefix: '',
  mode: 'cdc',
  startFrom: 'beginning',
  slot: 'shared',
});

/** every table of a schema as `namespace.table`, in the order the server lists them */
export function tablesOf(
  schema: DatabaseSchema | undefined,
): Array<{ id: string; namespace: string; table: string }> {
  return (schema?.namespaces ?? []).flatMap((ns) =>
    ns.tables.map((t) => ({
      id: `${ns.name}.${t.name}`,
      namespace: ns.name,
      table: t.name,
    })),
  );
}

/** what stops this form from being sent; null = nothing */
export function bulkProblem(
  form: BulkForm,
): 'source' | 'tables' | 'destination' | 'prefix' | 'oneSchema' | null {
  if (!form.sourceId) return 'source';
  if (form.picked.size === 0) return 'tables';
  // one request is one source schema: the tables are named without it
  if (
    new Set([...form.picked].map((id) => id.slice(0, id.indexOf('.')))).size > 1
  )
    return 'oneSchema';
  if (!form.destinationId) return 'destination';
  if (!/^[A-Za-z0-9_]{0,40}$/.test(form.tablePrefix)) return 'prefix';
  return null;
}

/** the form as the API takes it. only meaningful when {@link bulkProblem} is null */
export function bulkInput(
  form: BulkForm,
  workspaceId: string | null,
  sourceEngine: string | undefined,
): BridgeBulkInput {
  const picked = [...form.picked];
  const namespace = picked[0]!.slice(0, picked[0]!.indexOf('.'));
  return {
    ...(workspaceId ? { workspaceId } : {}),
    source: {
      connectionId: form.sourceId,
      // a schema only where the engine has them; elsewhere the "namespace" is the database itself
      ...(sourceEngine === 'postgres' ? { schema: namespace } : {}),
      tables: picked.map((id) => id.slice(id.indexOf('.') + 1)),
    },
    destination: {
      connectionId: form.destinationId,
      ...(form.destinationSchema.trim()
        ? { schema: form.destinationSchema.trim() }
        : {}),
      tablePrefix: form.tablePrefix,
    },
    trigger:
      form.mode === 'replay'
        ? { kind: 'replay' }
        : {
            kind: 'cdc',
            startFrom: form.startFrom,
            slot: sourceEngine === 'postgres' ? form.slot : 'own',
          },
  };
}

export function BulkBridgesButton() {
  const t = useTranslations('bulkBridges');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2"
        title={t('hint')}
        aria-label={t('button')}
        onClick={() => setOpen(true)}
      >
        <Layers className="h-3.5 w-3.5" />
      </Button>
      {open && <BulkBridgesDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function BulkBridgesDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations('bulkBridges');
  const workspaceId = useStudio((s) => s.activeWorkspaceId);
  const { data: connections } = useConnections();
  const [form, setForm] = useState<BulkForm>(blankBulkForm);
  const [filter, setFilter] = useState('');
  const [result, setResult] = useState<BridgeBulkResult | null>(null);
  const bulk = useBulkBridges();
  const { data: schema, isLoading: loadingTables } = useSchema(
    form.sourceId || null,
  );
  const source = connections?.find((c) => c.id === form.sourceId);
  const tables = useMemo(() => tablesOf(schema), [schema]);
  const shown = tables.filter((row) =>
    row.id.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const problem = bulkProblem(form);
  const patch = (p: Partial<BulkForm>) => setForm((f) => ({ ...f, ...p }));
  const toggle = (id: string) =>
    setForm((f) => {
      const picked = new Set(f.picked);
      if (picked.has(id)) picked.delete(id);
      else picked.add(id);
      return { ...f, picked };
    });

  async function submit() {
    try {
      setResult(
        await bulk.mutateAsync(bulkInput(form, workspaceId, source?.engine)),
      );
    } catch (err) {
      toast.error(t('failed'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {result ? (
          <BulkResult result={result} />
        ) : (
          <div className="space-y-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">{t('source')}</Label>
              <Select
                value={form.sourceId}
                onValueChange={(sourceId) =>
                  patch({ sourceId, picked: new Set() })
                }
              >
                <SelectTrigger className="h-8" aria-label={t('source')}>
                  <SelectValue placeholder={t('pickConnection')} />
                </SelectTrigger>
                <SelectContent>
                  {(connections ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} · {c.engine}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {form.sourceId && (
              <div className="grid gap-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">
                    {t('tables', { count: form.picked.size })}
                  </Label>
                  <span className="flex gap-2 text-[11px]">
                    <button
                      type="button"
                      className="hover:underline"
                      onClick={() =>
                        patch({
                          picked: new Set([
                            ...form.picked,
                            ...shown.map((r) => r.id),
                          ]),
                        })
                      }
                    >
                      {t('all')}
                    </button>
                    <button
                      type="button"
                      className="hover:underline"
                      onClick={() => patch({ picked: new Set() })}
                    >
                      {t('none')}
                    </button>
                  </span>
                </div>
                <Input
                  className="h-8 text-xs"
                  placeholder={t('filter')}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <div className="max-h-48 overflow-y-auto rounded-md border p-1.5">
                  {loadingTables && (
                    <Loader2 className="text-muted-foreground m-2 h-4 w-4 animate-spin" />
                  )}
                  {!loadingTables && shown.length === 0 && (
                    <p className="text-muted-foreground p-2 text-xs">
                      {t('noTables')}
                    </p>
                  )}
                  {shown.map((row) => (
                    <label
                      key={row.id}
                      className="hover:bg-accent/50 flex items-center gap-2 rounded px-1.5 py-0.5 font-mono text-xs"
                    >
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={form.picked.has(row.id)}
                        onChange={() => toggle(row.id)}
                      />
                      {row.id}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1.5">
                <Label className="text-xs">{t('destination')}</Label>
                <Select
                  value={form.destinationId}
                  onValueChange={(destinationId) => patch({ destinationId })}
                >
                  <SelectTrigger className="h-8" aria-label={t('destination')}>
                    <SelectValue placeholder={t('pickConnection')} />
                  </SelectTrigger>
                  <SelectContent>
                    {(connections ?? [])
                      .filter((c) => !c.readOnly)
                      .map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name} · {c.engine}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs" htmlFor="bulk-prefix">
                  {t('prefix')}
                </Label>
                <Input
                  id="bulk-prefix"
                  className="h-8 font-mono text-xs"
                  placeholder="raw_"
                  value={form.tablePrefix}
                  onChange={(e) => patch({ tablePrefix: e.target.value })}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1.5">
                <Label className="text-xs">{t('how')}</Label>
                <Select
                  value={form.mode === 'replay' ? 'replay' : form.startFrom}
                  onValueChange={(v) =>
                    v === 'replay'
                      ? patch({ mode: 'replay' })
                      : patch({
                          mode: 'cdc',
                          startFrom: v as 'now' | 'beginning',
                        })
                  }
                >
                  <SelectTrigger className="h-8" aria-label={t('how')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="beginning">
                      {t('copyThenFollow')}
                    </SelectItem>
                    <SelectItem value="now">{t('followFromNow')}</SelectItem>
                    <SelectItem value="replay">{t('copyOnce')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.mode === 'cdc' && source?.engine === 'postgres' && (
                <div className="grid gap-1.5">
                  <Label className="text-xs">{t('slot')}</Label>
                  <Select
                    value={form.slot}
                    onValueChange={(slot) =>
                      patch({ slot: slot as 'own' | 'shared' })
                    }
                  >
                    <SelectTrigger className="h-8" aria-label={t('slot')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="shared">{t('slotShared')}</SelectItem>
                      <SelectItem value="own">
                        {t('slotOwn', { count: form.picked.size })}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <p className="text-muted-foreground text-[11px]">{t('what')}</p>
            {problem && problem !== 'source' && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {t(`problem.${problem}`)}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button size="sm" onClick={onClose}>
              {t('done')}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!!problem || bulk.isPending}
              onClick={() => void submit()}
            >
              {bulk.isPending && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              {t('create', { count: form.picked.size })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BulkResult({ result }: { result: BridgeBulkResult }) {
  const t = useTranslations('bulkBridges');
  return (
    <div className="space-y-2 text-sm">
      <p role="status">{t('created', { count: result.created.length })}</p>
      {result.created.length > 0 && (
        <p className="text-muted-foreground text-xs">{t('notStarted')}</p>
      )}
      {result.skipped.length > 0 && (
        <div className="space-y-1">
          <p className="font-medium text-amber-700 dark:text-amber-400">
            {t('skipped', { count: result.skipped.length })}
          </p>
          <ul className="space-y-1 text-xs">
            {result.skipped.map((s) => (
              <li key={s.table}>
                <span className="font-mono">{s.table}</span> — {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
