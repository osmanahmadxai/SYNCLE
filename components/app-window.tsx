import { Radio } from 'lucide-react';

/**
 * A mockup of the Syncle interface — the bridge list, the live job, and the
 * rows that have actually crossed.
 *
 * Built in markup rather than shipped as a screenshot: it stays sharp on every
 * display, weighs nothing, restyles with the theme, and the text in it is real
 * text rather than pixels.
 */

const BRIDGES = [
  { name: 'Customers → Replica', live: true },
  { name: 'Orders → Analytics', live: true },
  { name: 'Sessions → Redis', live: false },
  { name: 'Products → Search', live: false },
];

const ROWS = [
  { id: 5, name: 'Edsger Dijkstra', email: 'edsger@example.com', city: 'Rotterdam', plan: 'Pro', ms: 45 },
  { id: 6, name: 'Barbara Liskov', email: 'barbara@example.com', city: 'Boston', plan: 'Enterprise', ms: 3 },
  { id: 7, name: 'Donald Knuth', email: 'don@example.com', city: 'Stanford', plan: 'Team', ms: 2 },
  { id: 8, name: 'Margaret Hamilton', email: 'margaret@example.com', city: 'Boston', plan: 'Pro', ms: 2 },
  { id: 9, name: 'Grace Hopper', email: 'grace@example.com', city: 'Arlington', plan: 'Pro', ms: 4 },
];

const STATS = [
  { label: 'Delivered', value: '12,480' },
  { label: 'Failed', value: '0' },
  { label: 'Skipped', value: '3' },
  { label: 'Success', value: '100%' },
];

export function AppWindow() {
  return (
    <div className="relative">
      {/* a soft light behind the window so it sits on the page rather than on top of it */}
      <div
        aria-hidden
        className="absolute inset-x-0 -top-6 bottom-0 rounded-[2rem] bg-foreground/[0.04] blur-2xl sm:-inset-x-8"
      />

      <div className="relative overflow-hidden rounded-xl border bg-card shadow-2xl shadow-black/60 ring-1 ring-foreground/[0.06]">
        {/* title bar */}
        <div className="flex h-9 items-center gap-2 border-b bg-muted/30 px-3.5">
          <span className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-foreground/15" />
            <span className="size-2.5 rounded-full bg-foreground/15" />
            <span className="size-2.5 rounded-full bg-foreground/15" />
          </span>
          <span className="mx-auto rounded-md bg-background/60 px-2.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            localhost:3002
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[196px_1fr]">
          {/* ── rail ─────────────────────────────────────────────── */}
          <aside className="hidden border-r bg-muted/15 p-3 sm:block">
            <p className="px-2 pb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Bridges
            </p>
            <ul className="space-y-0.5">
              {BRIDGES.map((b, i) => (
                <li
                  key={b.name}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] ${
                    i === 0
                      ? 'bg-foreground/[0.07] text-foreground'
                      : 'text-muted-foreground'
                  }`}
                >
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${
                      b.live ? 'animate-pulse bg-foreground/70' : 'bg-foreground/20'
                    }`}
                  />
                  <span className="truncate">{b.name}</span>
                </li>
              ))}
            </ul>
          </aside>

          {/* ── main ─────────────────────────────────────────────── */}
          <div className="min-w-0">
            {/* bridge header */}
            <div className="flex items-center gap-3 border-b px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold">
                  Customers → Replica
                </p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  shop.customers → shop_replica.customers
                </p>
              </div>
              <span className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                <Radio className="size-3" aria-hidden />
                CDC
              </span>
            </div>

            {/* stats */}
            <div className="grid grid-cols-4 divide-x border-b">
              {STATS.map((s) => (
                <div key={s.label} className="px-3 py-2.5">
                  <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    {s.label}
                  </p>
                  <p className="mt-0.5 text-base font-semibold tabular-nums">
                    {s.value}
                  </p>
                </div>
              ))}
            </div>

            {/* records */}
            <div className="overflow-hidden">
              <table className="w-full text-left text-[11.5px]">
                <thead>
                  <tr className="border-b bg-muted/20 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                    <th className="px-3 py-1.5 font-normal">id</th>
                    <th className="px-3 py-1.5 font-normal">name</th>
                    <th className="hidden px-3 py-1.5 font-normal md:table-cell">email</th>
                    <th className="hidden px-3 py-1.5 font-normal lg:table-cell">city</th>
                    <th className="px-3 py-1.5 font-normal">plan</th>
                    <th className="px-3 py-1.5 text-right font-normal">took</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {ROWS.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-[7px] font-mono tabular-nums text-muted-foreground">
                        <span className="mr-2 inline-block size-1.5 rounded-full bg-foreground/60 align-middle" />
                        {r.id}
                      </td>
                      <td className="px-3 py-[7px] font-medium">{r.name}</td>
                      <td className="hidden px-3 py-[7px] text-muted-foreground md:table-cell">
                        {r.email}
                      </td>
                      <td className="hidden px-3 py-[7px] text-muted-foreground lg:table-cell">
                        {r.city}
                      </td>
                      <td className="px-3 py-[7px] text-muted-foreground">{r.plan}</td>
                      <td className="px-3 py-[7px] text-right font-mono tabular-nums text-muted-foreground">
                        {r.ms}ms
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* the table continues past the frame rather than stopping dead */}
              <div className="h-10 bg-gradient-to-b from-transparent to-card" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
