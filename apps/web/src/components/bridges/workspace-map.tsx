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
import { Loader2, Radio, Zap, Plus, Network } from 'lucide-react';
import type { ConnectionConfig, Bridge } from '@syncle/core';
import {
  httpColumns,
  summarizeBridge,
  type BridgeSummary,
  type EndpointSummary,
  type HttpSummary,
} from '@/lib/bridge-summary';
import { EndpointBlock, HttpBlock, useBridgeWords } from './bridge-details';
import { useConnections, useBridges, useBridgeStatuses } from '@/lib/queries';
import { useStudio } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/** a bridge's live status, derived from its latest job */
type BridgeStatus = 'active' | 'failed' | 'idle' | 'disabled';

const STATUS_STROKE: Record<BridgeStatus, string> = {
  active: '#10b981', // emerald — listening/running
  failed: '#ef4444', // red — last job failed
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
 * source tables on the left, bridges in the middle, destination tables and
 * endpoints on the right, wired together. each end says which connection it is
 * on and where that runs; each bridge says how it fires and which columns
 * cross. click a bridge to open it.
 */

type EndNodeData = { end: EndpointSummary; side: 'source' | 'target' };
type BridgeNodeData = {
  bridgeId: string;
  bridge: Bridge;
  summary: BridgeSummary;
  status: BridgeStatus;
  selected: boolean;
};
type HttpNodeData = { http: HttpSummary };

const NODE = 'bg-card w-[230px] rounded-md border px-3 py-2 shadow-sm';

/** a table at either end of a bridge: what it is, which connection, where */
function EndNode({ data }: NodeProps<Node<EndNodeData>>) {
  return (
    <div className={NODE}>
      {data.side === 'target' && (
        <Handle type="target" position={Position.Left} className="!bg-primary" />
      )}
      <EndpointBlock end={data.end} />
      {data.side === 'source' && (
        <Handle type="source" position={Position.Right} className="!bg-primary" />
      )}
    </div>
  );
}

function HttpNode({ data }: NodeProps<Node<HttpNodeData>>) {
  return (
    <div className={NODE}>
      <Handle type="target" position={Position.Left} className="!bg-primary" />
      <HttpBlock http={data.http} />
    </div>
  );
}

function BridgeNode({ data }: NodeProps<Node<BridgeNodeData>>) {
  const { trigger, columns, shaping } = useBridgeWords();
  const Icon = data.bridge.trigger.kind === 'replay' ? Zap : Radio;
  const { bridge, summary } = data;
  // the columns that cross: one target's mapping, the HTTP field list, or —
  // when targets differ — each says its own on its edge
  const crossing =
    summary.http
      ? columns(httpColumns(bridge))
      : summary.targets.length === 1
        ? columns(summary.targets[0]!.columns)
        : null;
  const shaped = shaping(summary);
  return (
    <div
      className={cn(
        NODE,
        'cursor-pointer transition-shadow hover:shadow-md',
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
        <span className="truncate text-xs font-semibold">{bridge.name}</span>
      </div>
      <div className="text-muted-foreground mt-1 flex items-start gap-1 text-[10px]">
        <Icon className="mt-px h-3 w-3 shrink-0" />
        <span className="line-clamp-2">{trigger(bridge)}</span>
      </div>
      {crossing && (
        <div className="text-muted-foreground mt-0.5 truncate font-mono text-[10px]" title={crossing}>
          {crossing}
        </div>
      )}
      {shaped && <div className="text-muted-foreground mt-0.5 text-[10px]">{shaped}</div>}
      <Handle type="source" position={Position.Right} className="!bg-primary" />
    </div>
  );
}

const nodeTypes = {
  end: EndNode,
  http: HttpNode,
  bridge: BridgeNode,
};

/**
 * the node an end belongs on. two bridges reading the same table share its
 * node, and so do two writing into the same one; a custom query is its own
 */
function endKey(end: EndpointSummary, bridgeId: string): string {
  return end.table === null
    ? `query:${bridgeId}`
    : `db:${end.connectionId}:${end.database ?? ''}:${end.table}`;
}

/** where an edge into a destination says how that destination is written */
type EdgeLabeler = (bridge: Bridge, summary: BridgeSummary, targetIndex: number) => string;

function buildGraph(
  bridges: Bridge[],
  connections: ConnectionConfig[],
  selectedBridgeId: string | null,
  statusOf: (bridgeId: string) => BridgeStatus,
  edgeLabel: EdgeLabeler,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const ROW = 130;
  const COLUMN = 340;

  const summaries = bridges.map((b) => summarizeBridge(b, connections));

  // left column: the source tables, each once
  const sources = new Map<string, EndpointSummary>();
  bridges.forEach((b, i) => sources.set(endKey(summaries[i]!.source, b.id), summaries[i]!.source));
  [...sources.entries()].forEach(([key, end], i) => {
    nodes.push({
      id: `src-${key}`,
      type: 'end',
      position: { x: 0, y: i * ROW },
      data: { end, side: 'source' } satisfies EndNodeData,
    });
  });

  // right column: the destination tables and HTTP hosts, each once
  const dests = new Map<string, Node>();
  bridges.forEach((b, i) => {
    const s = summaries[i]!;
    for (const target of s.targets) {
      const key = `dest-${endKey(target, b.id)}`;
      if (!dests.has(key))
        dests.set(key, { id: key, type: 'end', position: { x: 0, y: 0 }, data: { end: target, side: 'target' } });
    }
    if (s.http) {
      const key = `dest-http:${s.http.method}:${s.http.host}${s.http.path}`;
      if (!dests.has(key))
        dests.set(key, { id: key, type: 'http', position: { x: 0, y: 0 }, data: { http: s.http } });
    }
  });
  [...dests.values()].forEach((node, i) => {
    nodes.push({ ...node, position: { x: COLUMN * 2, y: i * ROW } });
  });

  // middle column: the bridges, wired source -> bridge -> destination
  bridges.forEach((b, i) => {
    const summary = summaries[i]!;
    const status = statusOf(b.id);
    nodes.push({
      id: `bridge-${b.id}`,
      type: 'bridge',
      position: { x: COLUMN, y: i * ROW },
      data: {
        bridgeId: b.id,
        bridge: b,
        summary,
        status,
        selected: b.id === selectedBridgeId,
      } satisfies BridgeNodeData,
    });
    // line color + flow animation follow the bridge's live status
    const animated = status === 'active';
    const style = { stroke: STATUS_STROKE[status], strokeWidth: status === 'active' ? 2 : 1.5 };
    const labelProps = {
      labelStyle: { fontSize: 10 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
    };
    edges.push({
      id: `e-src-${b.id}`,
      source: `src-${endKey(summary.source, b.id)}`,
      target: `bridge-${b.id}`,
      animated,
      style,
    });
    summary.targets.forEach((target, t) => {
      edges.push({
        id: `e-dest-${b.id}-${t}`,
        source: `bridge-${b.id}`,
        target: `dest-${endKey(target, b.id)}`,
        animated,
        style,
        label: edgeLabel(b, summary, t),
        ...labelProps,
      });
    });
    if (summary.http) {
      edges.push({
        id: `e-dest-${b.id}-http`,
        source: `bridge-${b.id}`,
        target: `dest-http:${summary.http.method}:${summary.http.host}${summary.http.path}`,
        animated,
        style,
      });
    }
  });

  return { nodes, edges };
}

export function WorkspaceMap() {
  const t = useTranslations('workspaceMap');
  const { data: bridges, isLoading } = useBridges();
  const { data: connections } = useConnections();
  const { data: statuses } = useBridgeStatuses();
  const { selectedBridgeId, selectBridge, openBridgeEditor } = useStudio();
  const { writes, columns } = useBridgeWords();

  const { nodes, edges } = useMemo(() => {
    const byId = new Map((statuses ?? []).map((s) => [s.bridgeId, s]));
    const statusOf = (id: string): BridgeStatus => {
      const bridge = (bridges ?? []).find((h) => h.id === id);
      if (bridge && !bridge.enabled) return 'disabled';
      const s = byId.get(id);
      if (!s) return 'idle';
      if (s.active) return 'active';
      if (s.lastStatus === 'failed') return 'failed';
      return 'idle';
    };
    // one target: its columns are on the bridge, so the edge says how it writes.
    // a fan-out: each target may take different columns, so its edge says which
    const edgeLabel: EdgeLabeler = (_bridge, summary, i) => {
      const target = summary.targets[i]!;
      return summary.targets.length > 1
        ? `${writes(target)} · ${columns(target.columns, 2)}`
        : writes(target);
    };
    return buildGraph(bridges ?? [], connections ?? [], selectedBridgeId, statusOf, edgeLabel);
  }, [bridges, connections, statuses, selectedBridgeId, writes, columns]);

  // don't flash the "no bridges" empty state while the list is still loading
  if (isLoading) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('loadingWorkspace')}
      </div>
    );
  }

  if ((bridges?.length ?? 0) === 0) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 text-center">
        <Network className="h-10 w-10 opacity-40" />
        <div>
          <p className="text-sm">{t('noBridges')}</p>
          <p className="text-xs">
            {t('description')}{' '}
            <button
              className="text-primary hover:underline"
              onClick={() => openBridgeEditor()}
            >
              {t('createOne')}
            </button>
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => openBridgeEditor()}>
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
          if (node.type === 'bridge' && data.bridgeId) selectBridge(data.bridgeId);
        }}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
