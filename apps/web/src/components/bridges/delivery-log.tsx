'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Braces,
  ChevronLeft,
  ChevronRight,
  Copy,
  Grid2x2,
  List,
  Loader2,
  MousePointerClick,
  Search,
  SkipForward,
  Table as TableIcon,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  DeliveryStatus,
  EndpointInfo,
  BridgeDelivery,
} from '@syncle/core';
import { ApiError } from '@/lib/api';
import { useBridgeDeliveries, useSkipDeliveries } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

const CELLS_PER_PAGE = 600;
/**
 * page size for watch/CDC jobs, where the total is unknown so we can't build a
 * fixed grid. we page the delivery log by offset in windows of this many rows.
 */
const LIVE_PAGE_SIZE = 200;

/** hard cap on derived columns so a wide/ragged payload can't blow up the table */
const MAX_COLUMNS = 40;

/**
 * how the synced rows are presented.
 * - records: the rows themselves, as a table. what actually moved.
 * - feed:    newest-first stream. reads well while a CDC bridge is live.
 * - map:     one cell per delivery. progress at a glance over a huge replay,
 *            and the only place queued sequences exist to be skipped.
 */
type ViewMode = 'records' | 'feed' | 'map';

/** visual state of a timeline cell */
type CellState = DeliveryStatus | 'queued';

const CELL_STYLES: Record<CellState, string> = {
  success: 'bg-emerald-500 border-emerald-600/40 text-white',
  failed:  'bg-red-500   border-red-700/40   text-white',
  skipped: 'bg-amber-400 border-amber-500/40 text-amber-950',
  queued:  'bg-muted     border-border        text-muted-foreground/60',
};

const DOT_STYLES: Record<CellState, string> = {
  success: 'bg-emerald-500',
  failed:  'bg-red-500',
  skipped: 'bg-amber-400',
  queued:  'bg-muted-foreground/30',
};

const LEGEND: { state: CellState; label: string }[] = [
  { state: 'success', label: 'Delivered' },
  { state: 'failed',  label: 'Failed'    },
  { state: 'skipped', label: 'Skipped'  },
  { state: 'queued',  label: 'Queued'   },
];

const FILTERS: { value: 'all' | DeliveryStatus; label: string }[] = [
  { value: 'all',     label: 'All'       },
  { value: 'success', label: 'Delivered' },
  { value: 'failed',  label: 'Failed'    },
  { value: 'skipped', label: 'Skipped'   },
];

function pretty(text: string | null): string {
  if (!text) return '';
  try { return JSON.stringify(JSON.parse(text), null, 2); }
  catch { return text; }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * a delivery body is whatever the transform rendered: usually one row object,
 * an array of them when batching, and for a custom HTTP template possibly
 * neither. returns null when there's no row shape to tabulate.
 */
function parseRows(body: string | null): Record<string, unknown>[] | null {
  if (!body) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (Array.isArray(parsed)) {
    const rows = parsed.filter(isPlainObject);
    return rows.length > 0 ? rows : null;
  }
  return isPlainObject(parsed) ? [parsed] : null;
}

/** one synced row, paired with the delivery that carried it */
interface RecordEntry {
  id: string;
  delivery: BridgeDelivery;
  /** null when the body wasn't a row object (custom HTTP template, or skipped) */
  row: Record<string, unknown> | null;
  /** absolute index of this row in the source */
  rowIndex: number;
  searchText: string;
}

function toEntries(deliveries: BridgeDelivery[]): RecordEntry[] {
  const out: RecordEntry[] = [];
  for (const d of deliveries) {
    const rows = parseRows(d.requestBody);
    if (!rows) {
      out.push({
        id: d.id,
        delivery: d,
        row: null,
        rowIndex: d.rowIndex,
        searchText: (d.requestBody ?? '').toLowerCase(),
      });
      continue;
    }
    rows.forEach((row, i) => {
      out.push({
        id: rows.length > 1 ? `${d.id}:${i}` : d.id,
        delivery: d,
        row,
        rowIndex: d.rowIndex + i,
        searchText: JSON.stringify(row).toLowerCase(),
      });
    });
  }
  return out;
}

/** union of keys across the loaded rows, in first-seen order */
function deriveColumns(entries: RecordEntry[]): string[] {
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e.row) continue;
    for (const k of Object.keys(e.row)) {
      if (seen.has(k)) continue;
      seen.add(k);
      cols.push(k);
      if (cols.length >= MAX_COLUMNS) return cols;
    }
  }
  return cols;
}

function formatValue(v: unknown): { text: string; tone?: 'muted' | 'accent' } {
  if (v === null || v === undefined) return { text: 'null', tone: 'muted' };
  if (typeof v === 'number' || typeof v === 'boolean') {
    return { text: String(v), tone: 'accent' };
  }
  if (typeof v === 'string') return { text: v };
  return { text: JSON.stringify(v) };
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString();
}

/** best-effort human label for a row, used as the feed headline */
const LABEL_KEYS = ['name', 'title', 'label', 'email', 'username', 'slug'];
const ID_KEYS = ['id', '_id', 'uuid', 'pk', 'key'];

function pickKey(row: Record<string, unknown>, prefer: string[]): string | null {
  const keys = Object.keys(row);
  for (const p of prefer) {
    const hit = keys.find((k) => k.toLowerCase() === p);
    if (hit && row[hit] != null && row[hit] !== '') return hit;
  }
  return null;
}

export function DeliveryMonitor({
  bridgeId,
  jobId,
  live,
  totalRows,
  batchSize,
  endpoint,
}: {
  bridgeId:    string;
  jobId:     string;
  live:      boolean;
  totalRows: number | null;
  batchSize: number;
  endpoint: EndpointInfo;
}) {
  const cellCount = totalRows != null
    ? Math.ceil(totalRows / Math.max(1, batchSize))
    : null;
  // known total (replay jobs): a fixed grid we can page over.
  // unknown total (watch/CDC): we page by offset without a known end.
  const knownTotal = cellCount != null;
  const pageCount = cellCount != null
    ? Math.max(1, Math.ceil(cellCount / CELLS_PER_PAGE))
    : 1;

  const [view, setView]             = useState<ViewMode>('records');
  const [query, setQuery]           = useState('');
  const [filter, setFilter]         = useState<'all' | DeliveryStatus>('all');
  const [page, setPage]             = useState(0);
  const [manualPage, setManualPage] = useState(false); // true = user navigated manually
  const [livePage, setLivePage]     = useState(0);      // offset-window index for unknown-total jobs
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected]     = useState<Set<number>>(new Set());
  const [anchor, setAnchor]         = useState<number | null>(null);
  const [openId, setOpenId]         = useState<string | null>(null);
  const [rangeFrom, setRangeFrom]   = useState('');
  const [rangeTo, setRangeTo]       = useState('');

  // reset all local state when switching to a different job
  useEffect(() => {
    setPage(0);
    setLivePage(0);
    setManualPage(false);
    setSelected(new Set());
    setOpenId(null);
    setSelectMode(false);
    setQuery('');
    setFilter('all');
  }, [jobId]);

  // auto-follow: while live and the user hasn't manually navigated,
  // keep the view on the latest page as new deliveries arrive
  const prevPageCountRef = useRef(pageCount);
  useEffect(() => {
    if (live && !manualPage && pageCount > prevPageCountRef.current) {
      setPage(pageCount - 1);
    }
    prevPageCountRef.current = pageCount;
  }, [live, manualPage, pageCount]);

  const windowStart = page * CELLS_PER_PAGE;
  const windowEnd   = cellCount != null
    ? Math.min(windowStart + CELLS_PER_PAGE, cellCount)
    : windowStart + CELLS_PER_PAGE;

  // unknown-total offset window. while live and not manually paged we follow the
  // latest window (offset undefined → server returns the tail of the log).
  const followingLatest = live && !manualPage;
  const liveOffset = knownTotal
    ? undefined
    : followingLatest
      ? undefined
      : livePage * LIVE_PAGE_SIZE;

  const { data: deliveries, isFetching } = useBridgeDeliveries(bridgeId, jobId, live, {
    from:   knownTotal ? windowStart : undefined,
    to:     knownTotal ? windowEnd - 1 : undefined,
    offset: knownTotal ? undefined : liveOffset,
    limit:  knownTotal ? undefined : LIVE_PAGE_SIZE,
  });

  const bySeq = useMemo(() => {
    const m = new Map<number, BridgeDelivery>();
    for (const d of deliveries ?? []) m.set(d.sequence, d);
    return m;
  }, [deliveries]);

  // an unknown-total page that came back short is the last page — nothing older
  const livePageShort = !knownTotal && (deliveries?.length ?? 0) < LIVE_PAGE_SIZE;

  const sequences = useMemo(() => {
    if (cellCount != null) {
      return Array.from({ length: windowEnd - windowStart }, (_, i) => windowStart + i);
    }
    return [...bySeq.keys()].sort((a, b) => a - b);
  }, [cellCount, windowStart, windowEnd, bySeq]);

  // ── the synced rows themselves ───────────────────────────────────────────
  const entries = useMemo(
    () => toEntries([...(deliveries ?? [])].sort((a, b) => a.sequence - b.sequence)),
    [deliveries],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (filter !== 'all' && e.delivery.status !== filter) return false;
      if (!q) return true;
      return e.searchText.includes(q) || String(e.rowIndex).includes(q);
    });
  }, [entries, filter, query]);

  const columns = useMemo(() => deriveColumns(visible), [visible]);

  const skip = useSkipDeliveries(bridgeId, jobId);
  const openDelivery = (deliveries ?? []).find((d) => d.id === openId) ?? null;

  function cellState(seq: number): CellState {
    return (bySeq.get(seq)?.status as CellState) ?? 'queued';
  }

  function navigatePage(p: number) {
    setManualPage(true);
    setPage(p);
  }

  function followGridLatest() {
    setManualPage(false);
    setPage(pageCount - 1);
  }

  // unknown-total paging: "Older" walks back in history (higher offset),
  // "Newer" walks toward the tail. offset 0 is the newest window.
  function goOlder() {
    setManualPage(true);
    setLivePage((p) => p + 1);
  }
  function goNewer() {
    const next = Math.max(0, livePage - 1);
    setLivePage(next);
    if (next === 0) setManualPage(false); // back at the tail → resume following
  }
  function followLiveLatest() {
    setManualPage(false);
    setLivePage(0);
  }

  function onCellClick(seq: number, shift: boolean) {
    if (selectMode) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (shift && anchor != null) {
          const [lo, hi] = anchor < seq ? [anchor, seq] : [seq, anchor];
          for (let s = lo; s <= hi; s++) next.add(s);
        } else if (next.has(seq)) {
          next.delete(seq);
        } else {
          next.add(seq);
        }
        return next;
      });
      setAnchor(seq);
      return;
    }
    const d = bySeq.get(seq);
    if (d) setOpenId(d.id);
  }

  function selectQueuedOnPage() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const seq of sequences) if (!bySeq.get(seq)) next.add(seq);
      return next;
    });
  }

  async function runSkip(targets: number[]) {
    if (targets.length === 0) {
      toast.info('Nothing to skip — only queued deliveries can be skipped.');
      return;
    }
    if (targets.length > 10_000) {
      toast.error('Too many at once — skip up to 10,000 sequences per action.');
      return;
    }
    try {
      const res = await skip.mutateAsync(targets);
      toast.success(`Skipped ${res.skipped.toLocaleString()} row${res.skipped === 1 ? '' : 's'}`);
      setSelected(new Set());
    } catch (err) {
      toast.error('Could not skip', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function skipRange() {
    const from = Number(rangeFrom);
    const to   = Number(rangeTo);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
      toast.error('Enter a valid range (from must be less than or equal to to).');
      return;
    }
    // bound the range BEFORE building it — a huge `to` would freeze the tab
    const start = Math.max(0, from);
    if (to - start + 1 > 10_000) {
      toast.error('Too many at once — skip up to 10,000 sequences per action.');
      return;
    }
    const targets: number[] = [];
    for (let s = start; s <= to; s++) {
      if (!bySeq.get(s)) targets.push(s);
    }
    await runSkip(targets);
  }

  const selectedQueued = [...selected].filter((s) => !bySeq.get(s)).length;
  const isMap = view === 'map';

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">

        {/* ── toolbar ─────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-2">

          {/* view switcher */}
          <div className="bg-muted flex items-center rounded-md p-0.5">
            {([
              { id: 'records', icon: TableIcon, label: 'Records' },
              { id: 'feed',    icon: List,      label: 'Feed'    },
              { id: 'map',     icon: Grid2x2,   label: 'Map'     },
            ] as const).map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => setView(id)}
                title={
                  id === 'map'
                    ? 'One cell per delivery — progress at a glance, and where queued rows can be skipped'
                    : id === 'feed'
                      ? 'Newest first, as a stream'
                      : 'The synced rows, as a table'
                }
                className={cn(
                  'flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors',
                  view === id
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          {/* live badge + refresh indicator */}
          <div className="flex items-center gap-2">
            {live && (
              <span className="flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                LIVE
              </span>
            )}
            {isFetching && !live && (
              <Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
            )}
          </div>

          {/* auto-follow notice (shown only when user manually navigated away during live) */}
          {live && manualPage && (
            <button
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px] underline underline-offset-2 transition-colors"
              onClick={() =>
                knownTotal ? followGridLatest() : followLiveLatest()
              }
            >
              Follow latest
            </button>
          )}

          {/* map keeps the colour legend; the row views use status dots + filters */}
          {isMap ? (
            <div className="flex items-center gap-3">
              {LEGEND.map((l) => (
                <span key={l.state} className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
                  <span className={cn('h-3 w-3 rounded-sm border', CELL_STYLES[l.state])} />
                  {l.label}
                </span>
              ))}
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search rows…"
                  className="h-7 w-48 pl-7 text-xs"
                />
              </div>
              <div className="bg-muted flex items-center rounded-md p-0.5">
                {FILTERS.map((f) => (
                  <button
                    key={f.value}
                    onClick={() => setFilter(f.value)}
                    className={cn(
                      'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                      filter === f.value
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <span className="text-muted-foreground text-[11px] tabular-nums">
                {visible.length.toLocaleString()}
                {visible.length === 1 ? ' row' : ' rows'}
              </span>
            </>
          )}

          {/* skip controls only make sense against the map, where queued
              sequences are visible — a queued row has no record to show yet */}
          {isMap && (
            <div className="ml-auto flex items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline" className="h-7">
                    <SkipForward className="mr-1.5 h-3.5 w-3.5" />
                    Skip sequences…
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 space-y-3">
                  <div>
                    <p className="text-sm font-medium">Skip a sequence range</p>
                    <p className="text-muted-foreground mt-0.5 text-[11px]">
                      Enter delivery sequence numbers (shown inside each cell).
                      Already-settled deliveries are left untouched.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      placeholder="from"
                      className="h-8"
                      value={rangeFrom}
                      onChange={(e) => setRangeFrom(e.target.value)}
                    />
                    <span className="text-muted-foreground text-xs">to</span>
                    <Input
                      type="number"
                      placeholder="to"
                      className="h-8"
                      value={rangeTo}
                      onChange={(e) => setRangeTo(e.target.value)}
                    />
                  </div>
                  <Button
                    size="sm"
                    className="h-7 w-full"
                    disabled={skip.isPending}
                    onClick={skipRange}
                  >
                    {skip.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                    Skip range
                  </Button>
                </PopoverContent>
              </Popover>

              <Button
                size="sm"
                variant={selectMode ? 'default' : 'outline'}
                className="h-7"
                onClick={() => { setSelectMode((v) => !v); setSelected(new Set()); }}
              >
                <MousePointerClick className="mr-1.5 h-3.5 w-3.5" />
                {selectMode ? 'Selecting' : 'Select'}
              </Button>

              {selectMode && (
                <>
                  <Button size="sm" variant="outline" className="h-7" onClick={selectQueuedOnPage}>
                    Select queued (page)
                  </Button>
                  {selected.size > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7"
                      onClick={() => setSelected(new Set())}
                    >
                      Clear
                    </Button>
                  )}
                  <Button
                    size="sm"
                    className="h-7"
                    disabled={selectedQueued === 0 || skip.isPending}
                    onClick={() => runSkip([...selected].filter((s) => !bySeq.get(s)))}
                  >
                    {skip.isPending
                      ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      : <SkipForward className="mr-1.5 h-3.5 w-3.5" />
                    }
                    Skip {selectedQueued > 0 ? selectedQueued : ''}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>

        {/* ── body ────────────────────────────────────────────────────── */}
        <div className="min-h-0 flex-1 overflow-auto">
          {view === 'records' && (
            <RecordsTable
              entries={visible}
              columns={columns}
              openId={openId}
              live={live}
              empty={entries.length === 0}
              onOpen={setOpenId}
            />
          )}

          {view === 'feed' && (
            <RecordsFeed
              entries={visible}
              openId={openId}
              live={live}
              empty={entries.length === 0}
              onOpen={setOpenId}
            />
          )}

          {view === 'map' && (
            sequences.length === 0 ? (
              <EmptyState live={live} />
            ) : (
              <div
                className="grid gap-1 p-3"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(2.25rem, 1fr))' }}
              >
                {sequences.map((seq) => {
                  const state  = cellState(seq);
                  const isSel  = selected.has(seq);
                  const d      = bySeq.get(seq);
                  const rowStart = seq * batchSize + 1;
                  const rowEnd   = d ? d.rowIndex + d.rowCount : rowStart + batchSize - 1;
                  const rowLabel = batchSize > 1 ? `rows ${rowStart}–${rowEnd}` : `row ${rowStart}`;
                  const tipAction = selectMode
                    ? 'click to toggle · shift+click to range-select'
                    : 'click to inspect';
                  return (
                    <button
                      key={seq}
                      onClick={(e) => onCellClick(seq, e.shiftKey)}
                      title={[
                        `Sequence #${seq}`,
                        rowLabel,
                        state.charAt(0).toUpperCase() + state.slice(1),
                        d?.httpStatus ? `HTTP ${d.httpStatus}` : null,
                        tipAction,
                      ].filter(Boolean).join(' · ')}
                      className={cn(
                        'flex h-[32px] items-center justify-center rounded border text-[10px] font-semibold tabular-nums',
                        'transition-[transform,box-shadow] duration-100',
                        'hover:scale-110 hover:z-10 hover:shadow-sm',
                        CELL_STYLES[state],
                        openDelivery?.sequence === seq && 'ring-foreground z-10 ring-2 scale-110',
                        isSel && 'ring-primary z-10 ring-2 scale-110',
                      )}
                    >
                      {seq}
                    </button>
                  );
                })}
              </div>
            )
          )}
        </div>

        {/* ── pagination (unknown total: watch/CDC offset window) ─────── */}
        {!knownTotal && (livePage > 0 || !livePageShort) && sequences.length > 0 && (
          <div className="text-muted-foreground flex items-center gap-2 border-t px-3 py-1.5 text-xs">
            <span>
              {followingLatest ? (
                'latest deliveries'
              ) : (
                <>
                  older window
                  <span className="mx-1 opacity-40">·</span>
                  offset {livePage * LIVE_PAGE_SIZE}
                </>
              )}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                disabled={livePage === 0}
                onClick={goNewer}
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                Newer
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                disabled={livePageShort}
                onClick={goOlder}
              >
                Older
                <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {/* ── pagination (known total: replay job grid) ───────────────── */}
        {cellCount != null && pageCount > 1 && (
          <div className="text-muted-foreground flex items-center gap-2 border-t px-3 py-1.5 text-xs">
            <span>
              sequences {windowStart}–{windowEnd - 1}
              <span className="mx-1 opacity-40">/</span>
              {cellCount.toLocaleString()} total
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                disabled={page === 0}
                onClick={() => navigatePage(Math.max(0, page - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="px-1.5 tabular-nums">
                {page + 1} / {pageCount}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                disabled={page >= pageCount - 1}
                onClick={() => navigatePage(Math.min(pageCount - 1, page + 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ── delivery detail panel ───────────────────────────────────── */}
      {openDelivery && (
        <div className="bg-muted/20 w-[44%] min-w-[320px] border-l">
          <DeliveryDetail
            delivery={openDelivery}
            endpoint={endpoint}
            onClose={() => setOpenId(null)}
          />
        </div>
      )}
    </div>
  );
}

function EmptyState({ live, filtered }: { live: boolean; filtered?: boolean }) {
  return (
    <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-12">
      {filtered ? (
        <p className="text-sm">No rows match this search.</p>
      ) : live ? (
        <>
          <Loader2 className="h-5 w-5 animate-spin opacity-50" />
          <p className="text-sm">Waiting for first delivery…</p>
        </>
      ) : (
        <p className="text-sm">No deliveries recorded.</p>
      )}
    </div>
  );
}

/** the synced rows as a table: real columns, one line per row */
function RecordsTable({
  entries,
  columns,
  openId,
  live,
  empty,
  onOpen,
}: {
  entries: RecordEntry[];
  columns: string[];
  openId: string | null;
  live: boolean;
  empty: boolean;
  onOpen: (id: string) => void;
}) {
  if (entries.length === 0) return <EmptyState live={live} filtered={!empty} />;

  return (
    <table className="w-full border-separate border-spacing-0 text-xs">
      <thead className="sticky top-0 z-10">
        <tr className="bg-muted/60 backdrop-blur">
          <th className="text-muted-foreground border-b px-2 py-1.5 text-left font-medium">
            #
          </th>
          {columns.map((c) => (
            <th
              key={c}
              className="text-muted-foreground border-b px-2 py-1.5 text-left font-medium whitespace-nowrap"
            >
              {c}
            </th>
          ))}
          {columns.length === 0 && (
            <th className="text-muted-foreground border-b px-2 py-1.5 text-left font-medium">
              payload
            </th>
          )}
          <th className="text-muted-foreground border-b px-2 py-1.5 text-right font-medium whitespace-nowrap">
            time
          </th>
          <th className="text-muted-foreground border-b px-2 py-1.5 text-right font-medium whitespace-nowrap">
            took
          </th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => {
          const d = e.delivery;
          const isOpen = d.id === openId;
          return (
            <tr
              key={e.id}
              onClick={() => onOpen(d.id)}
              className={cn(
                'hover:bg-muted/50 cursor-pointer',
                isOpen && 'bg-primary/10 hover:bg-primary/10',
              )}
            >
              <td className="border-b px-2 py-1.5 whitespace-nowrap">
                <span className="flex items-center gap-1.5">
                  <span
                    title={d.status}
                    className={cn('h-2 w-2 shrink-0 rounded-full', DOT_STYLES[d.status as CellState])}
                  />
                  <span className="text-muted-foreground tabular-nums">
                    {e.rowIndex}
                  </span>
                </span>
              </td>
              {columns.map((c) => {
                const { text, tone } = formatValue(e.row?.[c]);
                const present = e.row ? c in e.row : false;
                return (
                  <td
                    key={c}
                    title={present ? text : undefined}
                    className={cn(
                      'max-w-[20rem] truncate border-b px-2 py-1.5',
                      !present && 'text-muted-foreground/40',
                      tone === 'muted' && 'text-muted-foreground/50 italic',
                      tone === 'accent' && 'font-mono tabular-nums',
                    )}
                  >
                    {present ? text : '—'}
                  </td>
                );
              })}
              {columns.length === 0 && (
                <td className="text-muted-foreground max-w-[36rem] truncate border-b px-2 py-1.5 font-mono">
                  {d.requestBody ?? '—'}
                </td>
              )}
              <td className="text-muted-foreground border-b px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                {timeOf(d.createdAt)}
              </td>
              <td className="text-muted-foreground border-b px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                {d.durationMs != null ? `${d.durationMs}ms` : '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** newest-first stream — easier to watch than a table while a bridge is live */
function RecordsFeed({
  entries,
  openId,
  live,
  empty,
  onOpen,
}: {
  entries: RecordEntry[];
  openId: string | null;
  live: boolean;
  empty: boolean;
  onOpen: (id: string) => void;
}) {
  if (entries.length === 0) return <EmptyState live={live} filtered={!empty} />;

  const newestFirst = [...entries].reverse();

  return (
    <ul className="divide-y">
      {newestFirst.map((e) => {
        const d = e.delivery;
        const row = e.row;
        const labelKey = row ? pickKey(row, LABEL_KEYS) : null;
        const idKey = row ? pickKey(row, ID_KEYS) : null;
        const headline = labelKey
          ? String(row![labelKey])
          : row
            ? formatValue(Object.values(row)[0]).text
            : (d.requestBody ?? '—');
        const rest = row
          ? Object.entries(row).filter(([k]) => k !== labelKey && k !== idKey)
          : [];

        return (
          <li key={e.id}>
            <button
              onClick={() => onOpen(d.id)}
              className={cn(
                'hover:bg-muted/50 flex w-full items-start gap-3 px-3 py-2 text-left',
                d.id === openId && 'bg-primary/10 hover:bg-primary/10',
              )}
            >
              <span
                title={d.status}
                className={cn(
                  'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                  DOT_STYLES[d.status as CellState],
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  {idKey && (
                    <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                      {idKey} {String(row![idKey])}
                    </span>
                  )}
                  <span className="truncate text-xs font-medium">{headline}</span>
                </div>
                {rest.length > 0 && (
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {rest.slice(0, 8).map(([k, v]) => (
                      <span key={k} className="text-muted-foreground text-[11px]">
                        <span className="opacity-60">{k}</span>{' '}
                        <span className="text-foreground/80">{formatValue(v).text}</span>
                      </span>
                    ))}
                  </div>
                )}
                {d.error && (
                  <p className="text-destructive mt-0.5 truncate text-[11px]">{d.error}</p>
                )}
              </div>
              <div className="text-muted-foreground shrink-0 text-right text-[11px] tabular-nums">
                <div>{timeOf(d.createdAt)}</div>
                {d.durationMs != null && <div className="opacity-60">{d.durationMs}ms</div>}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function DeliveryDetail({
  delivery: d,
  endpoint,
  onClose,
}: {
  delivery: BridgeDelivery;
  endpoint: EndpointInfo;
  onClose:  () => void;
}) {
  const [raw, setRaw] = useState(false);
  const rows = parseRows(d.requestBody);

  function copyCurl() {
    const parts = [
      `curl -X ${endpoint.method}`,
      `'${endpoint.url}'`,
      `-H 'content-type: application/json'`,
    ];
    if (d.requestBody) parts.push(`-d '${d.requestBody.replace(/'/g, "'\\''")}'`);
    void navigator.clipboard.writeText(parts.join(' \\\n  '));
    toast.success('Copied cURL to clipboard');
  }

  const tone =
    d.status === 'success' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
    : d.status === 'skipped' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
    : 'bg-destructive/15 text-destructive';

  const isDb = endpoint.kind === 'database';

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-3 p-3 text-xs">
        {/* header row */}
        <div className="flex items-center gap-2">
          <span className={cn('rounded-full px-2 py-0.5 font-semibold capitalize', tone)}>
            {d.status}
          </span>
          {d.httpStatus != null && (
            <span className="text-muted-foreground font-mono">HTTP {d.httpStatus}</span>
          )}
          {isDb && (
            <span className="text-muted-foreground font-mono">DB write</span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {rows && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                onClick={() => setRaw((v) => !v)}
                title={raw ? 'Show fields' : 'Show raw JSON'}
              >
                <Braces className="mr-1 h-3.5 w-3.5" />
                {raw ? 'Fields' : 'Raw'}
              </Button>
            )}
            {!isDb && d.status !== 'skipped' && (
              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={copyCurl}>
                <Copy className="mr-1 h-3.5 w-3.5" /> cURL
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* meta row */}
        <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
          <span>
            seq <span className="text-foreground font-mono">#{d.sequence}</span>
          </span>
          <span>
            row{' '}
            <span className="text-foreground font-mono">
              {d.rowIndex}
              {d.rowCount > 1 ? `–${d.rowIndex + d.rowCount - 1}` : ''}
            </span>
          </span>
          <span>
            attempts <span className="text-foreground">{d.attempts}</span>
          </span>
          {d.durationMs != null && (
            <span>
              took <span className="text-foreground">{d.durationMs}ms</span>
            </span>
          )}
          <span>
            at <span className="text-foreground">{timeOf(d.createdAt)}</span>
          </span>
        </div>

        {d.error && (
          <Block label="Error" tone="danger">
            {d.error}
          </Block>
        )}

        {d.status === 'skipped' ? (
          <p className="text-muted-foreground">
            This delivery was skipped and never {isDb ? 'written' : 'sent'}.
          </p>
        ) : rows && !raw ? (
          <>
            {rows.map((row, i) => (
              <div key={i}>
                <p className="text-muted-foreground mb-1 font-medium">
                  {isDb ? 'Row written' : 'Row sent'}
                  {rows.length > 1 && (
                    <span className="ml-1 opacity-60">
                      {i + 1} of {rows.length}
                    </span>
                  )}
                </p>
                <FieldTable row={row} />
              </div>
            ))}
            <Block label={isDb ? 'Write result' : 'Response'}>
              {pretty(d.responseBody) || '(empty)'}
            </Block>
          </>
        ) : (
          <>
            <Block label={isDb ? 'Row written' : 'Request body'}>
              {pretty(d.requestBody) || '—'}
            </Block>
            <Block label={isDb ? 'Write result' : 'Response'}>
              {pretty(d.responseBody) || '(empty)'}
            </Block>
          </>
        )}
      </div>
    </div>
  );
}

/** field-by-field view of a synced row — readable where a JSON blob isn't */
function FieldTable({ row }: { row: Record<string, unknown> }) {
  const fields = Object.entries(row);
  if (fields.length === 0) {
    return <p className="text-muted-foreground italic">(empty row)</p>;
  }
  return (
    <div className="overflow-hidden rounded-md border">
      <table className="w-full text-[11px]">
        <tbody>
          {fields.map(([k, v], i) => {
            const { text, tone } = formatValue(v);
            return (
              <tr key={k} className={cn(i % 2 === 1 && 'bg-muted/40')}>
                <td className="text-muted-foreground w-[38%] border-r px-2 py-1 align-top font-medium break-words">
                  {k}
                </td>
                <td
                  className={cn(
                    'px-2 py-1 align-top break-words',
                    tone === 'muted' && 'text-muted-foreground/60 italic',
                    tone === 'accent' && 'font-mono',
                  )}
                >
                  {text}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Block({
  label,
  tone,
  children,
}: {
  label:    string;
  tone?:    'danger';
  children: ReactNode;
}) {
  return (
    <div>
      <p className="text-muted-foreground mb-1 font-medium">{label}</p>
      <pre
        className={cn(
          'max-h-60 overflow-auto rounded-md p-2 font-mono text-[11px] whitespace-pre-wrap',
          tone === 'danger' ? 'bg-destructive/10 text-destructive' : 'bg-muted',
        )}
      >
        {children}
      </pre>
    </div>
  );
}
