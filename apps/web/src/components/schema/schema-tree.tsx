'use client';

import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Archive,
  Database,
  DatabaseBackup,
  Download,
  Eraser,
  Eye,
  KeyRound,
  Loader2,
  MoreHorizontal,
  MoreVertical,
  Plus,
  Search,
  SquareTerminal,
  Table2,
  Trash2,
  Upload,
  Webhook,
} from 'lucide-react';
import { toast } from 'sonner';
import type { BackupFormat, RelationKind, TableSchema } from '@syncle/core';
import { api, ApiError } from '@/lib/api';
import { downloadText } from '@/lib/export';
import {
  useConnections,
  useDatabases,
  useDrivers,
  useSchema,
} from '@/lib/queries';
import { useStudio } from '@/lib/store';
import { buildSelect } from '@/lib/sql';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/confirm';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CreateTableDialog } from './create-table-dialog';
import { CreateDatabaseDialog } from './create-database-dialog';

function RelationIcon({ kind }: { kind: RelationKind }) {
  const cls = 'h-3.5 w-3.5 shrink-0 text-muted-foreground';
  if (kind === 'view' || kind === 'materialized_view')
    return <Eye className={cls} />;
  if (kind === 'collection') return <Database className={cls} />;
  if (kind === 'keyspace') return <KeyRound className={cls} />;
  return <Table2 className={cls} />;
}

export function SchemaTree() {
  const {
    activeConnectionId,
    activeDatabase,
    setActiveDatabase,
    selected,
    selectRelation,
    clearSelection,
    openInQuery,
    openBridgeEditor,
  } = useStudio();
  const [filter, setFilter] = useState('');
  const [createTableOpen, setCreateTableOpen] = useState(false);
  const [createDbOpen, setCreateDbOpen] = useState(false);
  const qc = useQueryClient();

  const { data: connections } = useConnections();
  const { data: drivers } = useDrivers();
  const conn = connections?.find((c) => c.id === activeConnectionId);
  const driver = drivers?.find((d) => d.engine === conn?.engine);
  const canQuery = driver?.capabilities.queryLanguage === 'sql';
  const canDdl = !!driver?.capabilities.ddl;
  const canManageDb = !!driver?.capabilities.manageDatabases;
  const backupFormats = driver?.capabilities.backupFormats ?? [];
  const fileRef = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();

  const { data: databases } = useDatabases(
    driver?.capabilities.multipleDatabases ? activeConnectionId : null,
  );
  const {
    data: schema,
    isLoading,
    error,
  } = useSchema(activeConnectionId, activeDatabase);

  const namespaces = useMemo(() => {
    if (!schema) return [];
    const q = filter.trim().toLowerCase();
    return schema.namespaces
      .map((ns) => ({
        ...ns,
        tables: q
          ? ns.tables.filter((t) => t.name.toLowerCase().includes(q))
          : ns.tables,
      }))
      .filter((ns) => ns.tables.length > 0);
  }, [schema, filter]);

  async function refreshSchema() {
    await qc.invalidateQueries({
      queryKey: ['connections', activeConnectionId, 'schema'],
    });
  }

  async function handleDrop(table: string, tableSchema?: string) {
    const ok = await confirm({
      title: `Drop “${table}”?`,
      description:
        'This permanently deletes the table and all of its data. This cannot be undone.',
      confirmText: 'Drop table',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.dropTable(
        activeConnectionId as string,
        table,
        tableSchema,
        activeDatabase,
      );
      // if the dropped table is the one being browsed, deselect it and drop
      // its cached pages so the grid doesn't query a ghost table
      if (
        selected?.table === table &&
        (selected.schema ?? '') === (tableSchema ?? '')
      ) {
        clearSelection();
      }
      await qc.invalidateQueries({
        queryKey: ['connections', activeConnectionId, 'browse'],
      });
      await refreshSchema();
      toast.success(`Dropped ${table}`);
    } catch (err) {
      toast.error('Drop failed', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleBackup(format: BackupFormat, table?: TableSchema) {
    try {
      const res = await api.backup(
        activeConnectionId as string,
        {
          format,
          tables: table ? [table.name] : undefined,
          schema: table?.schema,
        },
        activeDatabase,
      );
      downloadText(res.filename, res.content);
      toast.success('Backup downloaded', { description: res.filename });
    } catch (err) {
      toast.error('Backup failed', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleRestoreFile(file: File) {
    const format: BackupFormat = file.name.endsWith('.sql') ? 'sql' : 'json';
    const ok = await confirm({
      title: 'Restore from file?',
      description: `“${file.name}” will be written into the current database. Existing rows may be overwritten.`,
      confirmText: 'Restore',
    });
    if (!ok) return;
    try {
      const content = await file.text();
      const res = await api.restore(
        activeConnectionId as string,
        { format, content },
        activeDatabase,
      );
      await refreshSchema();
      await qc.invalidateQueries({
        queryKey: ['connections', activeConnectionId, 'browse'],
      });
      toast.success(
        `Restored ${res.rows} row(s)${res.tables ? ` across ${res.tables} table(s)` : ''}`,
      );
    } catch (err) {
      toast.error('Restore failed', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleDropDatabase(name: string) {
    const ok = await confirm({
      title: `Drop database “${name}”?`,
      description:
        'This permanently deletes the database and all of its data. This cannot be undone.',
      confirmText: 'Drop database',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.dropDatabase(activeConnectionId as string, name);
      setActiveDatabase(undefined);
      await qc.invalidateQueries({
        queryKey: ['connections', activeConnectionId, 'databases'],
      });
      await qc.invalidateQueries({
        queryKey: ['connections', activeConnectionId, 'schema'],
      });
      toast.success(`Dropped database ${name}`);
    } catch (err) {
      toast.error('Drop failed', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleTruncate(table: string, tableSchema?: string) {
    const ok = await confirm({
      title: `Truncate “${table}”?`,
      description: 'This deletes all rows in the table. This cannot be undone.',
      confirmText: 'Truncate',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.truncateTable(
        activeConnectionId as string,
        table,
        tableSchema,
        activeDatabase,
      );
      await qc.invalidateQueries({
        queryKey: ['connections', activeConnectionId, 'browse'],
      });
      toast.success(`Truncated ${table}`);
    } catch (err) {
      toast.error('Truncate failed', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  if (!activeConnectionId) {
    return (
      <div className="px-4 py-8 text-center text-xs text-muted-foreground">
        Select a connection to browse its schema.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {databases && databases.length > 0 && (
        <div className="flex items-center gap-1 px-2 pb-2">
          <Select
            value={activeDatabase ?? schema?.database ?? ''}
            onValueChange={setActiveDatabase}
          >
            <SelectTrigger className="h-8 flex-1 text-xs">
              <Database className="mr-1 h-3.5 w-3.5" />
              <SelectValue placeholder="Database" />
            </SelectTrigger>
            <SelectContent>
              {databases.map((db) => (
                <SelectItem key={db} value={db} className="text-xs">
                  {db}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canManageDb && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  title="Database actions"
                >
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setCreateDbOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" /> New database…
                </DropdownMenuItem>
                {(activeDatabase ?? schema?.database) && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() =>
                        handleDropDatabase(
                          (activeDatabase ?? schema?.database) as string,
                        )
                      }
                    >
                      <Trash2 className="mr-2 h-4 w-4" /> Drop “
                      {activeDatabase ?? schema?.database}”…
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}

      <div className="flex items-center gap-1 px-2 pb-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter tables…"
            className="h-8 pl-7 text-xs"
          />
        </div>
        {canDdl && (
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0"
            title="New table"
            onClick={() => setCreateTableOpen(true)}
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
        {backupFormats.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                title="Backup / restore"
              >
                <DatabaseBackup className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {backupFormats.map((fmt) => (
                <DropdownMenuItem key={fmt} onClick={() => handleBackup(fmt)}>
                  <Download className="mr-2 h-4 w-4" />
                  Download backup ({fmt.toUpperCase()})
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => fileRef.current?.click()}>
                <Upload className="mr-2 h-4 w-4" />
                Restore from file…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".json,.sql,application/json,text/plain"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void handleRestoreFile(file);
        }}
      />

      <ScrollArea className="min-h-0 flex-1 px-2">
        {isLoading && (
          <div className="flex items-center gap-2 px-2 py-4 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading schema…
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 px-2 py-4 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{(error as Error).message}</span>
          </div>
        )}

        {namespaces.map((ns) => (
          <div key={ns.name || 'default'} className="pb-2">
            {ns.name && (
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {ns.name}
              </div>
            )}
            {ns.tables.map((table: TableSchema) => {
              const isSelected =
                selected?.table === table.name &&
                (selected?.schema ?? '') === (table.schema ?? '');
              return (
                <div
                  key={`${table.schema ?? ''}.${table.name}`}
                  className={cn(
                    'group flex w-full items-center gap-2 rounded px-2 py-1 text-[13px]',
                    isSelected
                      ? 'bg-primary text-primary-foreground'
                      : 'hover:bg-accent',
                  )}
                >
                  <button
                    onClick={() =>
                      selectRelation({
                        schema: table.schema,
                        table: table.name,
                        kind: table.kind,
                      })
                    }
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <RelationIcon kind={table.kind} />
                    <span className="min-w-0 flex-1 truncate">
                      {table.name}
                    </span>
                  </button>

                  {(canQuery || canDdl) && conn && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          className={cn(
                            'opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100',
                            isSelected
                              ? 'text-primary-foreground/80'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                          aria-label="Table actions"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canQuery && (
                          <DropdownMenuItem
                            onClick={() =>
                              openInQuery(
                                buildSelect(
                                  conn.engine,
                                  table.name,
                                  table.schema,
                                ),
                                table.name,
                              )
                            }
                          >
                            <SquareTerminal className="mr-2 h-4 w-4" />
                            Open SELECT
                          </DropdownMenuItem>
                        )}
                        {activeConnectionId && (
                          <DropdownMenuItem
                            onClick={() =>
                              openBridgeEditor({
                                seed: {
                                  connectionId: activeConnectionId,
                                  database: activeDatabase,
                                  schema: table.schema,
                                  table: table.name,
                                },
                              })
                            }
                          >
                            <Webhook className="mr-2 h-4 w-4" />
                            Create bridge
                          </DropdownMenuItem>
                        )}
                        {backupFormats.length > 0 && (
                          <DropdownMenuItem
                            onClick={() => handleBackup('json', table)}
                          >
                            <Archive className="mr-2 h-4 w-4" />
                            Backup table
                          </DropdownMenuItem>
                        )}
                        {canDdl && (
                          <>
                            <DropdownMenuItem
                              onClick={() =>
                                handleTruncate(table.name, table.schema)
                              }
                            >
                              <Eraser className="mr-2 h-4 w-4" />
                              Truncate…
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() =>
                                handleDrop(table.name, table.schema)
                              }
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Drop…
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}

                  <span
                    className={cn(
                      'text-[10px]',
                      isSelected
                        ? 'text-primary-foreground/70'
                        : 'text-muted-foreground',
                    )}
                  >
                    {table.columns.length}
                  </span>
                </div>
              );
            })}
          </div>
        ))}

        {!isLoading && !error && namespaces.length === 0 && (
          <div className="px-2 py-4 text-xs text-muted-foreground">
            {filter ? 'No matching tables.' : 'No tables yet.'}
          </div>
        )}
      </ScrollArea>

      {conn && canDdl && (
        <CreateTableDialog
          connectionId={conn.id}
          engine={conn.engine}
          database={activeDatabase}
          dataTypes={driver?.dataTypes ?? []}
          open={createTableOpen}
          onOpenChange={(o) => {
            setCreateTableOpen(o);
            if (!o) void refreshSchema();
          }}
        />
      )}
      {conn && canManageDb && (
        <CreateDatabaseDialog
          connectionId={conn.id}
          open={createDbOpen}
          onOpenChange={setCreateDbOpen}
        />
      )}
    </div>
  );
}
