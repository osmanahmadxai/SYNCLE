import type { Metadata } from 'next';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { GITHUB } from '@/lib/content';
import { MEASURE } from '@/lib/layout';
import {
  formatDuration,
  formatNumber,
  loadBenchmarks,
  type BenchResult,
} from '@/lib/benchmarks';

export const metadata: Metadata = {
  title: 'Benchmarks — Syncle',
  description:
    'Measured throughput for Syncle, run against real PostgreSQL, MySQL and MongoDB with millions of rows. Every figure comes from a recorded benchmark run.',
};

const RESULTS_SOURCE = `${GITHUB}/blob/main/benchmarks/results.json`;
const RUNNER_SOURCE = `${GITHUB}/blob/main/apps/api/bench`;

/** the extra readings a scenario carries, shown under its row */
function Detail({ detail }: { detail: BenchResult['detail'] }) {
  if (!detail || Object.keys(detail).length === 0) return null;
  return (
    <ul className="mt-1 flex flex-wrap gap-x-4 text-[13px] text-muted-foreground">
      {Object.entries(detail).map(([k, v]) => (
        <li key={k}>
          {k}: {String(v)}
        </li>
      ))}
    </ul>
  );
}

/**
 * A suite whose scenarios are all "Source → Destination" reads far better as a
 * grid than as twenty rows: the engine pairs are a matrix, and a matrix shows
 * at a glance which combinations are fast and which are not.
 */
function asMatrix(results: BenchResult[]): {
  sources: string[];
  dests: string[];
  cell: (s: string, d: string) => BenchResult | undefined;
} | null {
  const parsed = results.map((r) => {
    const m = /^(.+?)\s*→\s*(.+?)(?:\s*·.*)?$/.exec(r.scenario);
    return m ? { source: m[1].trim(), dest: m[2].trim(), r } : null;
  });
  if (parsed.some((p) => p === null) || parsed.length < 4) return null;
  const rows = parsed as Array<{ source: string; dest: string; r: BenchResult }>;
  const sources = [...new Set(rows.map((x) => x.source))];
  const dests = [...new Set(rows.map((x) => x.dest))];
  // only a reasonably filled grid is clearer as a grid
  if (sources.length < 2 || dests.length < 2) return null;
  return {
    sources,
    dests,
    cell: (src, dst) => rows.find((x) => x.source === src && x.dest === dst)?.r,
  };
}

/** a table of key/value readings: the run's settings, or the machine */
function Readings({ values }: { values: Record<string, string> }) {
  return (
    <dl className="mt-4 text-[15px]">
      {Object.entries(values).map(([k, v]) => (
        <div key={k} className="flex gap-4 border-b py-2">
          <dt className="w-44 shrink-0 text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function BenchmarksPage() {
  const report = loadBenchmarks();

  return (
    <>
      <SiteHeader current="benchmarks" />
      <main className={`mx-auto px-6 pb-16 text-[17px] leading-[1.7] ${MEASURE}`}>
        <h1 className="text-[2.2rem] leading-[1.15]">Benchmarks</h1>

        {!report ? (
          <p className="mt-6 text-muted-foreground">
            No recorded run is checked in yet. Run{' '}
            <code className="code">pnpm benchmark</code> against the test stack
            to produce one.
          </p>
        ) : (
          <>
            <p className="mt-6 max-w-[62ch]">
              Every number here comes from a recorded run of{' '}
              <a href={RUNNER_SOURCE} rel="noopener" className="link">
                the benchmark suite
              </a>{' '}
              against real databases. The results are committed as{' '}
              <a href={RESULTS_SOURCE} rel="noopener" className="link">
                benchmarks/results.json
              </a>{' '}
              and this page only renders that file, so every figure can be
              traced back to a run and reproduced.
            </p>

            <p className="mt-4 max-w-[62ch] text-[15px] text-muted-foreground">
              {report.disclaimer}
            </p>

            <section className="mt-12">
              <h2 className="text-[1.3rem]">The configuration</h2>
              <p className="mt-2 max-w-[62ch] text-[15px] text-muted-foreground">
                The shipped defaults, not tuning done for the benchmark. These
                are read from the running configuration, so they are the ones
                the run actually used.
              </p>
              <Readings values={report.configuration ?? {}} />
            </section>

            <section className="mt-12">
              <h2 className="text-[1.3rem]">The machine</h2>
              <p className="mt-2 max-w-[62ch] text-[15px] text-muted-foreground">
                Syncle, the databases and Redis all ran on this one machine.
              </p>
              <Readings values={report.environment} />
            </section>

            {report.suites.map((suite) => {
              const matrix = asMatrix(suite.results);
              return (
                <section key={suite.id} className="mt-12">
                  <h2 className="text-[1.3rem]">{suite.name}</h2>
                  <p className="mt-2 max-w-[62ch] text-[15px] text-muted-foreground">
                    {suite.description}
                  </p>

                  {matrix ? (
                    <div className="mt-5 overflow-x-auto">
                      <table className="w-full min-w-[34rem] border-collapse text-[15px]">
                        <caption className="caption-bottom pt-3 text-left text-[13px] text-muted-foreground">
                          Rows per second, source down the side, destination
                          across the top. Every run was verified complete and
                          duplicate-free before its time was recorded.
                        </caption>
                        <thead>
                          <tr className="text-left">
                            <th className="border-b border-foreground py-2 pr-4 font-semibold">
                              Source \ Destination
                            </th>
                            {matrix.dests.map((d) => (
                              <th
                                key={d}
                                className="whitespace-nowrap border-b border-foreground py-2 pr-4 text-right font-semibold"
                              >
                                {d}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {matrix.sources.map((src) => (
                            <tr key={src}>
                              <td className="border-b py-2.5 pr-4">{src}</td>
                              {matrix.dests.map((d) => {
                                const cell = matrix.cell(src, d);
                                return (
                                  <td
                                    key={d}
                                    className="border-b py-2.5 pr-4 text-right tabular-nums"
                                  >
                                    {cell ? formatNumber(cell.rowsPerSec) : '—'}
                                    {cell ? (
                                      <div className="text-[13px] text-muted-foreground">
                                        {formatNumber(cell.rows)} rows
                                      </div>
                                    ) : null}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="mt-5 overflow-x-auto">
                      <table className="w-full min-w-[34rem] border-collapse text-[15px]">
                        <thead>
                          <tr className="text-left">
                            {['Scenario', 'Rows', 'Time', 'Rows / sec'].map(
                              (h, i) => (
                                <th
                                  key={h}
                                  className={`whitespace-nowrap border-b border-foreground py-2 pr-4 font-semibold${
                                    i === 0 ? '' : ' text-right'
                                  }`}
                                >
                                  {h}
                                </th>
                              ),
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {suite.results.map((r) => (
                            <tr key={r.scenario} className="align-top">
                              <td className="border-b py-2.5 pr-4">
                                {r.scenario}
                                <Detail detail={r.detail} />
                              </td>
                              <td className="border-b py-2.5 pr-4 text-right tabular-nums">
                                {formatNumber(r.rows)}
                              </td>
                              <td className="whitespace-nowrap border-b py-2.5 pr-4 text-right tabular-nums text-muted-foreground">
                                {formatDuration(r.ms)}
                              </td>
                              <td className="border-b py-2.5 pr-4 text-right tabular-nums">
                                {formatNumber(r.rowsPerSec)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              );
            })}

            <section className="mt-12">
              <h2 className="text-[1.3rem]">Reproducing this</h2>
              <pre className="mt-4 overflow-x-auto rounded bg-muted px-4 py-3.5 font-mono text-[13px] leading-relaxed">
                <code>{`docker compose -f docker-compose.test.yml up -d
pnpm benchmark`}</code>
              </pre>
              <p className="mt-3 max-w-[62ch] text-[15px] text-muted-foreground">
                The run resets replication slots, fixtures and the metadata
                store first, because leftovers from a previous run distort
                everything after them. Each run is checked for completeness and
                duplicates before its time is recorded, so a fast number that
                moved the wrong data is not published as a result.
              </p>
            </section>

            <p className="mt-10 text-[13px] text-muted-foreground">
              Recorded {new Date(report.generatedAt).toISOString().slice(0, 10)}.
            </p>
          </>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
