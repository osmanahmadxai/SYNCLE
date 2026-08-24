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
import { DatabaseFlow } from '@/components/database-flow';
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
    body: 'Read the change log itself — Postgres logical replication, MySQL binlog, MongoDB change streams, Redis keyspace notifications.',
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
  eyebrow,
  title,
  lead,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  lead?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-16 border-t py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="max-w-2xl">
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
            {eyebrow}
          </p>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            {title}
          </h2>
          {lead && (
            <p className="mt-4 text-pretty leading-relaxed text-muted-foreground">
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
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Logo className="h-8 w-auto" />
          <nav className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="hidden sm:inline-flex"
              render={<a href="#how-it-fires" />}
            >
              How it works
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="hidden md:inline-flex"
              render={<a href="#use-cases" />}
            >
              Use cases
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="hidden sm:inline-flex"
              render={<a href="#faq" />}
            >
              FAQ
            </Button>
            <Button variant="outline" size="sm" render={<a href={GITHUB} rel="noopener" />}>
              GitHub
            </Button>
            <ThemeToggle />
          </nav>
        </div>
      </header>

      {/* ── hero ────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="dot-grid pointer-events-none absolute inset-x-0 top-0 h-[420px]"
        />
        <div className="relative mx-auto max-w-6xl px-5 pb-16 pt-16 sm:px-8 sm:pt-24">
          <div className="mx-auto max-w-3xl text-center">
            <Badge variant="secondary" className="font-mono text-xs font-normal">
              Open source · MIT · self-hosted
            </Badge>

            <h1 className="mt-6 text-balance text-[2.6rem] font-semibold leading-[1.03] tracking-[-0.03em] sm:text-6xl">
              Keep any databases in sync, live, across engines
            </h1>

            <p className="mx-auto mt-5 max-w-xl text-pretty text-lg leading-relaxed text-muted-foreground">
              Draw a bridge from a source to its destinations. The moment a row
              changes, it is written everywhere you linked — any engine to any
              other.
            </p>

            <div className="mx-auto mt-8 max-w-xl">
              <CopyCommand command={INSTALL_COMMAND} />
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
              <span>Docker is the only requirement</span>
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
              <a
                href={GITHUB}
                rel="noopener"
                className="inline-flex items-center gap-1 underline-offset-4 transition hover:text-foreground hover:underline"
              >
                Read the docs <ArrowUpRight className="size-3.5" />
              </a>
            </div>
          </div>

          <div className="mx-auto mt-14 max-w-5xl sm:mt-16">
            <DatabaseFlow />
          </div>
        </div>
      </section>

      {/* ── engines ─────────────────────────────────────────────────── */}
      <section className="border-t">
        <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
          <div className="flex flex-col items-center gap-5 sm:flex-row sm:justify-between">
            <p className="text-sm text-muted-foreground">
              One bridge, several destinations at once — and bridges chain.
            </p>
            <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
              {ENGINES.map((name) => (
                <li
                  key={name}
                  className="font-mono text-sm text-muted-foreground/80"
                >
                  {name}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── triggers ────────────────────────────────────────────────── */}
      <Section
        id="how-it-fires"
        eyebrow="How a bridge fires"
        title="Backfill it, poll it, or read the log"
        lead="Three ways of noticing that something changed. Pick per bridge — the rest of the pipeline is identical."
      >
        <div className="mt-12 grid overflow-hidden rounded-xl border sm:grid-cols-3">
          {TRIGGERS.map((t, i) => (
            <div
              key={t.name}
              className={`p-6 ${i > 0 ? 'border-t sm:border-l sm:border-t-0' : ''}`}
            >
              <t.icon className="size-5 text-muted-foreground" aria-hidden />
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
        eyebrow="What makes it trustworthy"
        title="Moving data is the easy half"
        lead="The hard half is moving it exactly once, in the right shape, and noticing when a row disappears."
      >
        <div className="mt-12 grid overflow-hidden rounded-xl border sm:grid-cols-2">
          {GUARANTEES.map((g, i) => (
            <div
              key={g.title}
              className={`p-7 ${i > 0 ? 'border-t' : ''} ${
                i % 2 === 1 ? 'sm:border-l' : ''
              } ${i === 1 ? 'sm:border-t-0' : ''}`}
            >
              <g.icon className="size-5 text-muted-foreground" aria-hidden />
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
        eyebrow="Get started"
        title="One command, then a browser tab"
        lead="It downloads the newest release, starts it, and opens the interface. No Node, no Postgres, no Redis to install — they all run in containers."
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

          <div className="rounded-xl border bg-card/30 p-6">
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              Then, day to day
            </p>
            <dl className="mt-5 divide-y">
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
        eyebrow="What people use it for"
        title="The jobs a bridge is actually for"
        lead="Every one of these is the same primitive — a source, some destinations, and a trigger — pointed at a different problem."
      >
        <div className="mt-12 grid overflow-hidden rounded-xl border sm:grid-cols-2 lg:grid-cols-3">
          {USE_CASES.map((u, i) => (
            <div
              key={u.title}
              className={`p-6 ${i > 0 ? 'border-t' : ''} ${
                i % 2 === 1 ? 'sm:border-l' : ''
              } ${i >= 2 ? 'sm:border-t' : 'sm:border-t-0'} ${
                i % 3 !== 0 ? 'lg:border-l' : 'lg:border-l-0'
              } ${i >= 3 ? 'lg:border-t' : 'lg:border-t-0'}`}
            >
              <h3 className="font-semibold">{u.title}</h3>
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
        eyebrow="Where it sits"
        title="Smaller than a data platform, on purpose"
        lead="Airbyte and Debezium are built for teams running pipelines as a discipline. Syncle is for one person who wants two databases to agree."
      >
        <div className="mt-12 overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[42rem] text-left text-sm">
            <thead>
              <tr className="border-b bg-muted/20">
                <th className="px-5 py-3 font-medium text-muted-foreground">
                  <span className="sr-only">Aspect</span>
                </th>
                <th className="px-5 py-3 font-semibold">Syncle</th>
                <th className="px-5 py-3 font-medium text-muted-foreground">Airbyte</th>
                <th className="px-5 py-3 font-medium text-muted-foreground">Debezium</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {COMPARISON.map((row) => (
                <tr key={row.aspect}>
                  <th
                    scope="row"
                    className="px-5 py-3 text-left font-normal text-muted-foreground"
                  >
                    {row.aspect}
                  </th>
                  <td className="px-5 py-3 font-medium">{row.syncle}</td>
                  <td className="px-5 py-3 text-muted-foreground">{row.airbyte}</td>
                  <td className="px-5 py-3 text-muted-foreground">{row.debezium}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          Not a knock on either — if you already run Kafka, Debezium is the right
          answer. This is for everyone who does not.
        </p>
      </Section>

      {/* ── security ────────────────────────────────────────────────── */}
      <Section
        id="security"
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
      <Section id="faq" eyebrow="Questions" title="Before you install it">
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
      <section className="border-t">
        <div className="mx-auto max-w-6xl px-5 py-24 text-center sm:px-8">
          <Logo className="mx-auto h-10 w-auto opacity-80" />
          <h2 className="mx-auto mt-6 max-w-xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
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
                Open-source database synchronisation. Any engine to any other,
                live — running entirely on your own machines.
              </p>
            </div>

            <div>
              <h3 className="text-sm font-semibold">Product</h3>
              <ul className="mt-4 space-y-2.5 text-sm text-muted-foreground">
                <li>
                  <a href="#how-it-fires" className="transition hover:text-foreground">
                    How it works
                  </a>
                </li>
                <li>
                  <a href="#install" className="transition hover:text-foreground">
                    Install
                  </a>
                </li>
                <li>
                  <a href="#use-cases" className="transition hover:text-foreground">
                    Use cases
                  </a>
                </li>
                <li>
                  <a href="#compare" className="transition hover:text-foreground">
                    Comparison
                  </a>
                </li>
                <li>
                  <a href="#security" className="transition hover:text-foreground">
                    Security
                  </a>
                </li>
                <li>
                  <a href="#faq" className="transition hover:text-foreground">
                    FAQ
                  </a>
                </li>
              </ul>
            </div>

            <div>
              <h3 className="text-sm font-semibold">Project</h3>
              <ul className="mt-4 space-y-2.5 text-sm text-muted-foreground">
                <li>
                  <a href={GITHUB} rel="noopener" className="transition hover:text-foreground">
                    Source on GitHub
                  </a>
                </li>
                <li>
                  <a
                    href={`${GITHUB}/releases/latest`}
                    rel="noopener"
                    className="transition hover:text-foreground"
                  >
                    Releases
                  </a>
                </li>
                <li>
                  <a
                    href={`${GITHUB}/issues`}
                    rel="noopener"
                    className="transition hover:text-foreground"
                  >
                    Report an issue
                  </a>
                </li>
                <li>
                  <a
                    href={`${GITHUB}/blob/main/LICENSE`}
                    rel="noopener"
                    className="transition hover:text-foreground"
                  >
                    MIT licence
                  </a>
                </li>
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
                className="underline-offset-4 transition hover:text-foreground hover:underline"
              >
                Osman Ahmadzai
              </a>
            </p>
          </div>
        </div>
      </footer>
    </>
  );
}
