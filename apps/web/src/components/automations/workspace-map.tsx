'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Database, Globe, Loader2, Radio, Zap, Plus, Network } from 'lucide-react';
import type { ConnectionConfig, Hook } from '@syncle/core';
import { useConnections, useHooks, useHookStatuses } from '@/lib/queries';
import { useStudio } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/** a bridge's live status, derived from its latest run */
type BridgeStatus = 'active' | 'failed' | 'idle' | 'disabled';

const STATUS_STROKE: Record<BridgeStatus, string> = {
  active: '#10b981', // emerald — listening/running
  failed: '#ef4444', // red — last run failed
  idle: '#94a3b8', // slate — enabled but not running
  disabled: '#cbd5e1', // faint — disabled
};

const STATUS_DOT: Record<BridgeStatus, string> = {
  active: 'bg-emerald-500',
  failed: 'bg-red-500',
  idle: 'bg-muted-foreground/50',
  disabled: 'bg-muted-foreground/30',
};

/**
 * the workspace map — a Packet-Tracer-ish picture of the whole workspace.
 * source databases on the left, bridges in the middle, destination endpoints on
 * the right, wired together. click a bridge to open it.
 */

type ConnNodeData = { label: string; engine: string };
type BridgeNodeData = {
  hookId: string;
  label: string;
  kind: Hook['trigger']['kind'];
  status: BridgeStatus;
  selected: boolean;
};
type DestNodeData = { label: string; kind: 'http' | 'database' };

function ConnectionNode({ data }: NodeProps<Node<ConnNodeData>>) {
  return (
    <div className="bg-card flex min-w-[150px] items-center gap-2 rounded-md border px-3 py-2 shadow-sm">
      <Database className="text-primary h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <div className="truncate text-xs font-semibold">{data.label}</div>
        <div className="text-muted-foreground text-[10px] uppercase">{data.engine}</div>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-primary" />
    </div>
  );
}

function BridgeNode({ data }: NodeProps<Node<BridgeNodeData>>) {
  const t = useTranslations('workspaceMap');
  const Icon = data.kind === 'replay' ? Zap : Radio;
  return (
    <div
      className={cn(
        'bg-card min-w-[170px] cursor-pointer rounded-md border px-3 py-2 shadow-sm transition-shadow hover:shadow-md',
        data.selected ? 'ring-primary ring-2' : '',
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-primary" />
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            STATUS_DOT[data.status],
            data.status === 'active' && 'animate-pulse',
          )}
        />
        <span className="truncate text-xs font-semibold">{data.label}</span>
      </div>
      <div className="text-muted-foreground mt-1 flex items-center gap-1 text-[10px]">
        <Icon className="h-3 w-3" />
        {data.kind === 'replay'
          ? t('kindOnDemand')
          : data.kind === 'cdc'
            ? 'CDC'
            : t('kindWatch')}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-primary" />
    </div>
  );
}

function DestinationNode({ data }: NodeProps<Node<DestNodeData>>) {
  return (
    <div className="bg-card flex min-w-[150px] items-center gap-2 rounded-md border px-3 py-2 shadow-sm">
      <Handle type="target" position={Position.Left} className="!bg-primary" />
      {data.kind === 'database' ? (
        <Database className="h-4 w-4 shrink-0 text-emerald-500" />
      ) : (
        <Globe className="h-4 w-4 shrink-0 text-sky-500" />
      )}
      <span className="truncate text-xs font-medium">{data.label}</span>
    </div>
  );
}

const nodeTypes = {
  connection: ConnectionNode,
  bridge: BridgeNode,
  destination: DestinationNode,
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** the destination node(s) a bridge feeds: one HTTP host, or N database tables */
function destsOf(
  h: Hook,
): { key: string; label: string; kind: 'http' | 'database' }[] {
  if (h.destination.kind === 'database') {
    return h.destination.targets.map((t) => {
      const tbl = t.schema ? `${t.schema}.${t.table}` : t.table;
      return { key: `db:${t.connectionId}:${tbl}`, label: tbl, kind: 'database' as const };
    });
  }
  const host = hostOf(h.destination.url);
  return [{ key: `http:${host}`, label: host, kind: 'http' as const }];
}

function buildGraph(
  hooks: Hook[],
  connections: ConnectionConfig[],
  selectedHookId: string | null,
  statusOf: (hookId: string) => BridgeStatus,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const ROW = 110;

  // left column: only connections actually used by a bridge here
  const usedConnIds = [...new Set(hooks.map((h) => h.source.connectionId))];
  const connName = new Map(connections.map((c) => [c.id, c]));
  usedConnIds.forEach((id, i) => {
    const c = connName.get(id);
    nodes.push({
      id: `conn-${id}`,
      type: 'connection',
      position: { x: 0, y: i * ROW },
      data: { label: c?.name ?? 'connection', engine: c?.engine ?? '' },
    });
  });

  // right column: unique destinations (HTTP hosts and/or database tables)
  const destMap = new Map<string, { label: string; kind: 'http' | 'database' }>();
  for (const h of hooks) {
    for (const d of destsOf(h)) destMap.set(d.key, { label: d.label, kind: d.kind });
  }
  [...destMap.entries()].forEach(([key, d], i) => {
    nodes.push({
      id: `dest-${key}`,
      type: 'destination',
      position: { x: 620, y: i * ROW },
      data: { label: d.label, kind: d.kind },
    });
  });

  // middle column: the bridges, wired source -> bridge -> destination
  hooks.forEach((h, i) => {
    const status = statusOf(h.id);
    nodes.push({
      id: `bridge-${h.id}`,
      type: 'bridge',
      position: { x: 310, y: i * ROW },
      data: {
        hookId: h.id,
        label: h.name,
        kind: h.trigger.kind,
        status,
        selected: h.id === selectedHookId,
      },
    });
    // line color + flow animation follow the bridge's live status
    const animated = status === 'active';
    const style = { stroke: STATUS_STROKE[status], strokeWidth: status === 'active' ? 2 : 1.5 };
    edges.push({
      id: `e-conn-${h.id}`,
      source: `conn-${h.source.connectionId}`,
      target: `bridge-${h.id}`,
      animated,
      style,
    });
    for (const d of destsOf(h)) {
      edges.push({
        id: `e-dest-${h.id}-${d.key}`,
        source: `bridge-${h.id}`,
        target: `dest-${d.key}`,
        animated,
        style,
      });
    }
  });

  return { nodes, edges };
}

export function WorkspaceMap() {
  const t = useTranslations('workspaceMap');
  const { data: hooks, isLoading } = useHooks();
  const { data: connections } = useConnections();
  const { data: statuses } = useHookStatuses();
  const { selectedHookId, selectHook, openHookEditor } = useStudio();

  const { nodes, edges } = useMemo(() => {
    const byId = new Map((statuses ?? []).map((s) => [s.hookId, s]));
    const statusOf = (id: string): BridgeStatus => {
      const hook = (hooks ?? []).find((h) => h.id === id);
      if (hook && !hook.enabled) return 'disabled';
      const s = byId.get(id);
      if (!s) return 'idle';
      if (s.active) return 'active';
      if (s.lastStatus === 'failed') return 'failed';
      return 'idle';
    };
    return buildGraph(hooks ?? [], connections ?? [], selectedHookId, statusOf);
  }, [hooks, connections, statuses, selectedHookId]);

  // don't flash the "no bridges" empty state while the list is still loading
  if (isLoading) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('loadingWorkspace')}
      </div>
    );
  }

  if ((hooks?.length ?? 0) === 0) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 text-center">
        <Network className="h-10 w-10 opacity-40" />
        <div>
          <p className="text-sm">{t('noBridges')}</p>
          <p className="text-xs">
            {t('description')}{' '}
            <button
              className="text-primary hover:underline"
              onClick={() => openHookEditor()}
            >
              {t('createOne')}
            </button>
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => openHookEditor()}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {t('newBridge')}
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
        onNodeClick={(_e, node) => {
          const data = node.data as Partial<BridgeNodeData>;
          if (node.type === 'bridge' && data.hookId) selectHook(data.hookId);
        }}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
