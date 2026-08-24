import {
  ArrowUpRight,
  CircleSlash2,
  Columns3,
  GitBranch,
  Radio,
  RefreshCw,
  TableProperties,
  Trash2,
} from 'lucide-react';
import { AppWindow } from '@/components/app-window';
import { CopyCommand } from '@/components/copy-command';
import { HeroScene } from '@/components/hero-scene';
import { Logo } from '@/components/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AUTHOR_GITHUB,
  COMPARISON,
  FAQ,
  GITHUB,
  INSTALL_COMMAND,
  SECURITY,
  USE_CASES,
} from '@/lib/content';

const ENGINES = [
  'PostgreSQL',
  'MySQL',
  'MariaDB',
  'SQLite',
  'MongoDB',
  'Redis',
  'HTTP',
];

const TRIGGERS = [
  {
    icon: RefreshCw,
    name: 'Replay',
    tagline: 'One shot',
    body: 'Stream all — or a filtered slice — of the source once, then finish. The right tool for an initial backfill or a migration.',
  },
  {
    icon: GitBranch,
    name: 'Watch',
    tagline: 'Polled',
    body: 'Follow a cursor: an auto-increment id, an updated_at column, or a primary-key diff. New rows sync as they appear, on every engine.',
  },
  {
    icon: Radio,
    name: 'CDC',
    tagline: 'Real time',
    body: 'True change data capture (CDC): read the change log itself — Postgres logical replication, MySQL binlog, MongoDB change streams, Redis keyspace notifications.',
  },
];

const GUARANTEES = [
  {
    icon: CircleSlash2,
    title: 'No duplicates, ever',
    body: 'Writes are idempotent upserts keyed by the columns you choose, so replays, retries and redeliveries never double-write.',
  },
  {
    icon: Trash2,
    title: 'Deletes propagate',
    body: 'Inserts, updates and deletes all cross the bridge, each tagged with its operation — not just the rows that happen to be new.',
  },
  {
    icon: TableProperties,
    title: 'Missing table? Created',
    body: "If the destination doesn't exist, Syncle builds it from the source's shape, translating types across engines.",
  },
  {
    icon: Columns3,
    title: 'Map and rename columns',
    body: 'Write this column into that column over there — or design a payload and POST it to an HTTP endpoint instead.',
  },
];

const STEPS = [
  {
    t: 'Run the command',
    b: 'The image is pulled prebuilt for your architecture — Intel or ARM, macOS or Linux. Nothing compiles.',
  },
  {
    t: 'Create your admin account',
    b: 'Syncle opens with a one-time setup token already filled in, proving you operate the machine.',
  },
  {
    t: 'Draw your first bridge',
    b: 'Pick a source table and its destinations, then start it. Backfill first, then leave it listening.',
  },
];

function Section({
  id,
  index,
  eyebrow,
  title,
  lead,
  tint = false,
  children,
}: {
  id?: string;
  /** printed into the eyebrow — gives the long page a visible order */
  index: number;
  eyebrow: string;
  title: string;
  lead?: string;
  /** alternate surface band so the page striping is more than borders */
  tint?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={`scroll-mt-16 border-t py-16 sm:py-24 ${tint ? 'bg-muted/[0.03]' : ''}`}
    >
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="max-w-2xl">
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
            {String(index).padStart(2, '0')} — {eyebrow}
          </p>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
            {title}
          </h2>
          {lead && (
            <p className="mt-4 text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
              {lead}
            </p>
          )}
        </div>
        {children}
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <>
      {/* ── nav ─────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-8">
          <a href="#" aria-label="Syncle — back to top">
            <Logo className="h-7 w-auto sm:h-8" priority />
          </a>
          <nav className="flex items-center gap-0.5 sm:gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="max-sm:h-10 max-sm:px-2.5"
              nativeButton={false} render={<a href="#how-it-fires" />}
            >
              How it works
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="hidden md:inline-flex"
              nativeButton={false} render={<a href="#use-cases" />}
            >
              Use cases
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="hidden sm:inline-flex"
              nativeButton={false} render={<a href="#faq" />}
            >
              FAQ
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="max-sm:h-10 max-sm:px-3"
              nativeButton={false} render={<a href={GITHUB} rel="noopener" />}
            >
              GitHub
            </Button>
            <ThemeToggle />
          </nav>
        </div>
      </header>

      {/* ── hero ────────────────────────────────────────────────────── */}
      <section className="relative overflow-x-clip">
        <div
          aria-hidden
          className="dot-grid pointer-events-none absolute inset-x-0 top-0 h-[420px]"
        />
        <div className="relative mx-auto max-w-6xl px-5 pb-14 pt-14 sm:px-8 sm:pb-16 sm:pt-24">
          <div className="mx-auto max-w-4xl text-center">
            <a href={GITHUB} rel="noopener" className="inline-flex">
              <Badge
                variant="secondary"
                className="gap-2 border border-foreground/10 bg-secondary/40 font-mono text-xs font-normal backdrop-blur"
              >
                <span className="size-1.5 animate-pulse rounded-full bg-foreground/80" />
                Open source · MIT · self-hosted
              </Badge>
            </a>

            <h1 className="mt-6 text-balance text-4xl font-semibold leading-[1.03] tracking-[-0.03em] min-[420px]:text-[2.75rem] sm:text-6xl sm:tracking-[-0.035em] lg:text-7xl">
              Keep any databases in{' '}
              <span className="whitespace-nowrap">sync, live,</span> across
              engines
            </h1>

            <p className="mx-auto mt-5 max-w-xl text-pretty text-lg leading-relaxed text-muted-foreground">
              Draw a bridge from a source to its destinations. The moment a row
              changes, it is written everywhere you linked — any engine to any
              other.
            </p>

            <div className="mx-auto mt-8 max-w-xl">
              <CopyCommand command={INSTALL_COMMAND} prominent />
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
              <span className="py-2">Docker is the only requirement</span>
              <span aria-hidden className="hidden text-muted-foreground/40 sm:inline">
                ·
              </span>
              <a
                href={GITHUB}
                rel="noopener"
                className="inline-flex items-center gap-1 py-2 underline-offset-4 transition hover:text-foreground hover:underline"
              >
                Read the docs <ArrowUpRight className="size-3.5" />
              </a>
            </div>
          </div>

          <div className="mt-10 sm:mt-16">
            <HeroScene />
          </div>
        </div>
      </section>

      {/* ── engines ─────────────────────────────────────────────────── */}
      <section className="border-t">
        <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
          <div className="flex flex-col items-center gap-5 lg:flex-row lg:justify-between">
            <p className="text-center text-sm text-muted-foreground lg:text-left">
              One bridge, several destinations at once — and bridges chain.
            </p>
            <ul className="flex flex-wrap items-center justify-center gap-2">
              {ENGINES.map((name) => (
                <li key={name}>
                  <span className="inline-flex rounded-md border border-foreground/[0.07] px-2.5 py-1 font-mono text-xs text-muted-foreground transition hover:text-foreground">
                    {name}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── triggers ────────────────────────────────────────────────── */}
      <Section
        id="how-it-fires"
        index={1}
        eyebrow="How a bridge fires"
        title="Backfill it, poll it, or read the log"
        lead="Three ways of noticing that something changed. Pick per bridge — the rest of the pipeline is identical."
      >
        <div className="mt-12 grid overflow-hidden rounded-xl border sm:grid-cols-3">
          {TRIGGERS.map((t, i) => (
            <div
              key={t.name}
              className={`group p-6 transition-colors duration-200 hover:bg-foreground/[0.03] ${
                i > 0
                  ? 'border-t border-foreground/[0.06] sm:border-l sm:border-t-0'
                  : ''
              }`}
            >
              <t.icon
                className="size-5 text-muted-foreground transition-colors group-hover:text-foreground"
                aria-hidden
              />
              <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                {t.tagline}
              </p>
              <h3 className="mt-1 text-lg font-semibold">{t.name}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {t.body}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-6">
          <AppWindow />
        </div>
      </Section>

      {/* ── guarantees ──────────────────────────────────────────────── */}
      <Section
        index={2}
        eyebrow="What makes it trustworthy"
        title="Moving data is the easy half"
        lead="The hard half is moving it exactly once, in the right shape, and noticing when a row disappears."
      >
        <div className="mt-12 grid overflow-hidden rounded-xl border sm:grid-cols-2">
          {GUARANTEES.map((g, i) => (
            <div
              key={g.title}
              className={`group p-7 transition-colors duration-200 hover:bg-foreground/[0.03] ${
                i > 0 ? 'border-t border-foreground/[0.06]' : ''
              } ${i % 2 === 1 ? 'sm:border-l' : ''} ${i === 1 ? 'sm:border-t-0' : ''}`}
            >
              <g.icon
                className="size-5 text-muted-foreground transition-colors group-hover:text-foreground"
                aria-hidden
              />
              <h3 className="mt-4 font-semibold">{g.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {g.body}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── install ─────────────────────────────────────────────────── */}
      <Section
        id="install"
        index={3}
        eyebrow="Get started"
        title="One command, then a browser tab"
        lead="It downloads the newest release, starts it, and opens the interface. No Node, no Postgres, no Redis to install — they all run in containers."
        tint
      >
        {/* full width: in a narrow column the command truncates mid-string,
            and it is the one thing on the page people came to copy */}
        <div className="mt-12">
          <CopyCommand command={INSTALL_COMMAND} />
        </div>

        <div className="mt-10 grid gap-10 lg:grid-cols-2">
          <div>
            <ol className="space-y-7">
              {STEPS.map((s, i) => (
                <li key={s.t} className="flex gap-4">
                  <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] text-muted-foreground">
                    {i + 1}
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold">{s.t}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      {s.b}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="rounded-xl border bg-card/30 p-6 shadow-[inset_0_1px_0_0_theme(colors.foreground/8%)]">
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              Then, day to day
            </p>
            <dl className="mt-5 divide-y divide-foreground/[0.06]">
              {[
                ['syncle up', 'start it, and open the interface'],
                ['syncle down', 'stop, keeping your data'],
                ['syncle logs', 'follow what the bridges are doing'],
                ['syncle update', 'move to the newest release'],
                ['syncle uninstall', 'remove everything, data included'],
              ].map(([cmd, what]) => (
                <div
                  key={cmd}
                  className="flex flex-wrap items-baseline gap-x-3 py-2.5"
                >
                  <dt className="font-mono text-[13px]">{cmd}</dt>
                  <dd className="text-sm text-muted-foreground">{what}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </Section>

      {/* ── use cases ───────────────────────────────────────────────── */}
      <Section
        id="use-cases"
        index={4}
        eyebrow="What people use it for"
        title="The jobs a bridge is actually for"
        lead="Every one of these is the same primitive — a source, some destinations, and a trigger — pointed at a different problem."
      >
        <div className="mt-12 grid overflow-hidden rounded-xl border sm:grid-cols-2 lg:grid-cols-3">
          {USE_CASES.map((u, i) => (
            <div
              key={u.title}
              className={`group relative p-6 transition-colors duration-200 hover:bg-foreground/[0.03] ${
                i > 0 ? 'border-t border-foreground/[0.06]' : ''
              } ${i % 2 === 1 ? 'sm:border-l' : ''} ${
                i >= 2 ? 'sm:border-t' : 'sm:border-t-0'
              } ${i % 3 !== 0 ? 'lg:border-l' : 'lg:border-l-0'} ${
                i >= 3 ? 'lg:border-t' : 'lg:border-t-0'
              }`}
            >
              <span className="absolute right-5 top-6 font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">
                {u.tag}
              </span>
              <h3 className="pr-16 font-semibold">{u.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {u.body}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── comparison ──────────────────────────────────────────────── */}
      <Section
        id="compare"
        index={5}
        eyebrow="Where it sits"
        title="Smaller than a data platform, on purpose"
        lead="A lightweight, self-hosted Airbyte and Debezium alternative: those are built for teams running pipelines as a discipline. Syncle is for one person who wants two databases to agree."
        tint
      >
        <div className="relative mt-12">
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[42rem] text-left text-sm">
              <thead>
                <tr className="border-b bg-muted/20">
                  <th className="px-5 py-3 font-medium text-muted-foreground">
                    <span className="sr-only">Aspect</span>
                  </th>
                  <th className="border-x border-foreground/[0.06] bg-foreground/[0.03] px-5 py-3 font-semibold">
                    Syncle
                  </th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">Airbyte</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">Debezium</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-foreground/[0.06]">
                {COMPARISON.map((row) => (
                  <tr key={row.aspect} className="transition-colors hover:bg-muted/10">
                    <th
                      scope="row"
                      className="px-5 py-3 text-left font-normal text-muted-foreground"
                    >
                      {row.aspect}
                    </th>
                    <td className="border-x border-foreground/[0.06] bg-foreground/[0.03] px-5 py-3 font-medium">
                      {row.syncle}
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">{row.airbyte}</td>
                    <td className="px-5 py-3 text-muted-foreground">{row.debezium}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* edge fade signals the table pans on phones (scrollbars are hidden there) */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-10 rounded-r-xl bg-gradient-to-l from-background sm:hidden"
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground sm:hidden">
          Swipe to compare →
        </p>
        <p className="mt-4 text-sm text-muted-foreground">
          Not a knock on either — if you already run Kafka, Debezium is the right
          answer. This is for everyone who does not.
        </p>
      </Section>

      {/* ── security ────────────────────────────────────────────────── */}
      <Section
        id="security"
        index={6}
        eyebrow="Your data, your machines"
        title="Nothing phones home"
        lead="A sync tool sees every row it moves and holds the credentials to both ends. That earns some scrutiny."
      >
        <div className="mt-12 grid gap-x-12 gap-y-9 sm:grid-cols-2">
          {SECURITY.map((item) => (
            <div key={item.title}>
              <h3 className="font-semibold">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {item.body}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── faq ─────────────────────────────────────────────────────── */}
      <Section id="faq" index={7} eyebrow="Questions" title="Before you install it">
        <div className="mt-12 grid gap-x-12 gap-y-9 sm:grid-cols-2">
          {FAQ.map((item) => (
            <div key={item.q}>
              <h3 className="font-semibold">{item.q}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {item.a}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── closing call to action ──────────────────────────────────── */}
      <section className="relative overflow-x-clip border-t">
        <div
          aria-hidden
          className="dot-grid pointer-events-none absolute inset-x-0 bottom-0 h-[320px]"
          style={{
            maskImage:
              'radial-gradient(60% 50% at 50% 100%, #000 20%, transparent 78%)',
          }}
        />
        <div className="relative mx-auto max-w-6xl px-5 py-20 text-center sm:px-8 sm:py-28">
          <Logo className="mx-auto h-10 w-auto opacity-80" />
          <h2 className="mx-auto mt-6 max-w-xl text-balance text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
            Two databases, kept in step, in about a minute
          </h2>
          <div className="mx-auto mt-8 max-w-xl">
            <CopyCommand command={INSTALL_COMMAND} />
          </div>
        </div>
      </section>

      {/* ── footer ──────────────────────────────────────────────────── */}
      <footer className="border-t">
        <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            <div className="lg:col-span-2">
              <Logo className="h-8 w-auto" />
              <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted-foreground">
                Open-source database synchronization. Any engine to any other,
                live — running entirely on your own machines.
              </p>
            </div>

            <div>
              <h3 className="text-sm font-semibold">Product</h3>
              <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                {[
                  ['#how-it-fires', 'How it works'],
                  ['#install', 'Install'],
                  ['#use-cases', 'Use cases'],
                  ['#compare', 'Comparison'],
                  ['#security', 'Security'],
                  ['#faq', 'FAQ'],
                ].map(([href, label]) => (
                  <li key={href}>
                    <a
                      href={href}
                      className="inline-block py-1.5 transition hover:text-foreground"
                    >
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="text-sm font-semibold">Project</h3>
              <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                {[
                  [GITHUB, 'Source on GitHub'],
                  [`${GITHUB}/releases/latest`, 'Releases'],
                  [`${GITHUB}/issues`, 'Report an issue'],
                  [`${GITHUB}/blob/main/LICENSE`, 'MIT licence'],
                ].map(([href, label]) => (
                  <li key={href}>
                    <a
                      href={href}
                      rel="noopener"
                      className="inline-block py-1.5 transition hover:text-foreground"
                    >
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t pt-6 text-sm text-muted-foreground sm:flex-row">
            <p>© {new Date().getFullYear()} Syncle. MIT licensed.</p>
            <p className="font-mono text-xs">
              Built by{' '}
              <a
                href={AUTHOR_GITHUB}
                rel="noopener"
                className="inline-flex items-center gap-1 py-2 underline-offset-4 transition hover:text-foreground hover:underline"
              >
                Osman Ahmadzai <ArrowUpRight className="size-3" />
              </a>
            </p>
          </div>
        </div>
      </footer>
    </>
  );
}
