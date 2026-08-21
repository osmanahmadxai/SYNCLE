'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Loader2,
  MousePointerClick,
  SkipForward,
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

/** visual state of a timeline cell */
type CellState = DeliveryStatus | 'queued';

const CELL_STYLES: Record<CellState, string> = {
  success: 'bg-emerald-500 border-emerald-600/40 text-white',
  failed:  'bg-red-500   border-red-700/40   text-white',
  skipped: 'bg-amber-400 border-amber-500/40 text-amber-950',
  queued:  'bg-muted     border-border        text-muted-foreground/60',
};

const LEGEND: { state: CellState; label: string }[] = [
  { state: 'success', label: 'Delivered' },
  { state: 'failed',  label: 'Failed'    },
  { state: 'skipped', label: 'Skipped'  },
  { state: 'queued',  label: 'Queued'   },
];

function pretty(text: string | null): string {
  if (!text) return '';
  try { return JSON.stringify(JSON.parse(text), null, 2); }
  catch { return text; }
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

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">

        {/* ── toolbar ─────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-2">

          {/* legend */}
          <div className="flex items-center gap-3">
            {LEGEND.map((l) => (
              <span key={l.state} className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
                <span className={cn('h-3 w-3 rounded-sm border', CELL_STYLES[l.state])} />
                {l.label}
              </span>
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

          <div className="ml-auto flex items-center gap-2">
            {/* range skip */}
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
        </div>

        {/* ── timeline grid ───────────────────────────────────────────── */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sequences.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-12">
              {live ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin opacity-50" />
                  <p className="text-sm">Waiting for first delivery…</p>
                </>
              ) : (
                <p className="text-sm">No deliveries recorded.</p>
              )}
            </div>
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

function DeliveryDetail({
  delivery: d,
  endpoint,
  onClose,
}: {
  delivery: BridgeDelivery;
  endpoint: EndpointInfo;
  onClose:  () => void;
}) {
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
        </div>

        {d.error && (
          <Block label="Error" tone="danger">
            {d.error}
          </Block>
        )}

        {d.status !== 'skipped' ? (
          <>
            <Block label={isDb ? 'Row written' : 'Request body'}>
              {pretty(d.requestBody) || '—'}
            </Block>
            <Block label={isDb ? 'Write result' : 'Response'}>
              {pretty(d.responseBody) || '(empty)'}
            </Block>
          </>
        ) : (
          <p className="text-muted-foreground">
            This delivery was skipped and never {isDb ? 'written' : 'sent'}.
          </p>
        )}
      </div>
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
