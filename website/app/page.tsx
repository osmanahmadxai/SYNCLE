import type { Metadata } from 'next';
import { CopyCommand } from '@/components/copy-command';
import { CodeBlock } from '@/components/docs/code-block';
import { formatReleaseDate, latestRelease } from '@/lib/release';
import { InstallTranscript } from '@/components/install-transcript';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { DemoVideo, Shot } from '@/components/shot';
import { FAQ, GITHUB, INSTALL_COMMAND, SECURITY, USE_CASES } from '@/lib/content';
import { DOC_PAGES, docHref } from '@/lib/docs';
import { MEASURE } from '@/lib/layout';

export const metadata: Metadata = {
  alternates: { canonical: '/' },
};

const TRIGGERS = [
  {
    name: 'Replay',
    body: 'Runs when you press the button: read the source table, or a filtered slice of it, from top to bottom and then stop. This is the one for an initial backfill or a migration.',
  },
  {
    name: 'Watch',
    body: 'Polls the source on a cursor — an auto-increment id, an updated_at column, or a diff of the primary keys. New rows sync as they appear. Works on every engine, SQLite included.',
  },
  {
    name: 'CDC',
    body: 'Reads the database change log itself: Postgres logical replication, MySQL binlog, MongoDB change streams, Redis keyspace notifications. Changes show up as they commit, with no polling.',
  },
];

const GUARANTEES = [
  {
    title: 'Writes are idempotent.',
    body: 'Every write is an upsert keyed by the columns you choose, so a replay, a retry or a redelivery rewrites the same row instead of adding a second one.',
  },
  {
    title: 'Deletes cross CDC bridges.',
    body: 'On a CDC trigger, inserts, updates and deletes all come through, each tagged with its operation. A watch bridge polls, so it sees new rows (and updates, if the cursor is a timestamp) but has no way to notice a delete.',
  },
  {
    title: 'Missing tables get created.',
    body: "If the destination table doesn't exist, Syncle builds it from the source's shape and translates the types for the target engine.",
  },
  {
    title: 'Interrupted jobs resume.',
    body: 'Jobs checkpoint their cursor as they go, so a crash or a restart picks up where it stopped instead of starting over.',
  },
  {
    title: 'Columns can be remapped.',
    body: 'Write this column into that column over there. Or build a JSON payload and POST each row to an HTTP endpoint instead.',
  },
];

const STEPS = [
  {
    t: 'Run the command.',
    b: 'It checks for Docker and Compose v2, pulls the prebuilt image, starts four containers, and opens the interface at localhost:3002.',
  },
  {
    t: 'Create your admin account.',
    b: 'The setup form opens with a one-time token already filled in. It is read off the server’s own data directory, and printed in the logs as well, so only someone with access to the machine can finish setup.',
  },
  {
    t: 'Build a bridge.',
    b: 'Pick a source table and its destinations, then start it. Backfill first, then leave it listening.',
  },
];

const DAY_TO_DAY: [string, string][] = [
  ['syncle up', 'start it, and open the interface'],
  ['syncle down', 'stop, keeping your data'],
  ['syncle logs', 'follow what the bridges are doing'],
  ['syncle update', 'move to the newest release'],
  ['syncle uninstall', 'remove everything, data included'],
];

function Section({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mt-16 scroll-mt-8">
      <h2 className="text-[1.35rem]">{title}</h2>
      {children}
    </section>
  );
}

export default function Home() {
  const release = latestRelease();

  return (
    <>
      <SiteHeader />

      <main className={`mx-auto px-6 text-[18px] leading-[1.75] ${MEASURE}`}>
        {/* ── intro ───────────────────────────────────────────────────── */}
        <section className="pt-10 sm:pt-14">
          <h1 className="max-w-[17ch] text-[2.4rem] leading-[1.1] sm:text-[2.9rem]">
            Keep your databases in sync
          </h1>

          <p className="mt-7 max-w-[62ch] text-pretty text-[19px] leading-[1.65]">
            Syncle copies rows between databases and keeps them copied. You
            point it at a source table, say where the rows should go, and it
            writes them there — once, on a timer, or the moment they change.
          </p>

          <p className="mt-4 max-w-[62ch] text-pretty">
            Most change-data-capture tools stop one step short of that.
            Debezium puts change events on a Kafka topic; you run the broker
            and write the consumer that turns those events into rows in your
            database. <strong>Syncle does the writing part.</strong> There is
            no broker to operate and no account to create.
          </p>

          <p className="mt-4 max-w-[70ch]">
            It works with PostgreSQL, MySQL, SQLite, MongoDB and Redis, and
            any of them can be the source or the destination. If the rows need
            to reach a service instead of a database, a bridge can POST them
            to an HTTP endpoint.
          </p>

          <div className="mt-8">
            <CopyCommand command={INSTALL_COMMAND} />
          </div>

          <p className="mt-4 max-w-[70ch] text-[15px] leading-relaxed text-muted-foreground">
            Docker with Compose v2 and curl are the only requirements; the
            script checks for those before it runs, and everything else lives
            in containers. Open source under the MIT licence.
          </p>

          <p className="mt-6">
            <a href="/docs" className="link">
              Read the documentation
            </a>
            <span className="mx-3 text-muted-foreground">·</span>
            <a href={GITHUB} rel="noopener" className="link">
              Source on GitHub
            </a>
          </p>

          <Shot
            eager
            src="/media/04-workspace-map.webp"
            alt="The Syncle workspace map: one PostgreSQL source feeding four bridges — on-demand, CDC and watch — into MySQL, MongoDB and Redis destinations"
            caption="One source, four bridges, four destinations, on one canvas."
          />
        </section>

        {/* ── the walkthrough ─────────────────────────────────────────── */}
        <Section id="demo" title="A bridge being built">
          <p className="mt-4">
            Fifty-eight seconds, uncut. It starts on an empty workspace and
            builds a bridge from a Postgres <code className="code">orders</code>{' '}
            table into MongoDB: naming it, picking the source, choosing change
            data capture, pointing it at the destination. Then it starts, rows
            are inserted into Postgres from a terminal outside the browser, and
            they show up on the other side.
          </p>
          <DemoVideo
            caption={
              <>
                Recorded against a running instance. The MongoDB collection at
                the end did not exist when the recording started.
              </>
            }
          />
        </Section>

        {/* ── why ─────────────────────────────────────────────────────── */}
        <Section title="Why it exists">
          <p className="mt-4">
            I kept writing the same one-off sync scripts: a cron job here, a
            copy-pasted ETL script there. None of them handled deletes, or
            retries, or the day someone changed the schema. I wanted one thing
            I could run on my own machine, point at two databases, and stop
            thinking about.
          </p>
        </Section>

        {/* ── how it works ────────────────────────────────────────────── */}
        <Section id="how-it-works" title="How a bridge runs">
          <p className="mt-4">
            A bridge is a saved sync path: a source table or query, the columns
            and how they map, the destinations, and a trigger. There are three
            triggers and you pick one per bridge; everything downstream of the
            trigger is the same either way. The destination table does not have
            to exist beforehand — unless you turn that off, Syncle creates it
            from the source schema on the first write, translating the types
            for whichever engine is receiving them.
          </p>
          <div className="mt-5 space-y-4">
            {TRIGGERS.map((t) => (
              <p key={t.name}>
                <span className="font-semibold">{t.name}.</span> {t.body}
              </p>
            ))}
          </div>
          <Shot
            src="/media/05-bridge-builder.webp"
            alt="The Syncle bridge builder: source table with selectable columns, a live preview of real rows, trigger configuration, the inferred schema and a sample payload"
            caption="Picking a trigger in the builder, with a live preview of what will be sent."
          />

          <p className="mt-5">
            Choosing CDC checks the source before it lets you continue: logical
            replication on for Postgres, row-format binlog for MySQL, a replica
            set for Mongo, keyspace notifications for Redis. If something is
            missing it names the setting and the value it needs, so you find
            out in the builder instead of from a bridge that never fires.
          </p>

          <p className="mt-5 text-[15px] text-muted-foreground">
            Two limits worth knowing up front. SQLite has no change log, so it
            syncs by watch instead of CDC. And Redis keyspace notifications are
            not durable, so a Redis CDC bridge misses anything that happens
            while Syncle is down. The{' '}
            <a href="/docs/cdc" className="link">
              CDC documentation
            </a>{' '}
            covers both.
          </p>
        </Section>

        {/* ── guarantees ──────────────────────────────────────────────── */}
        <Section title="Delivery guarantees">
          <p className="mt-4">
            What you can rely on once a bridge is actually running, whichever
            trigger it uses:
          </p>
          <div className="mt-5 space-y-4">
            {GUARANTEES.map((g) => (
              <p key={g.title}>
                <span className="font-semibold">{g.title}</span> {g.body}
              </p>
            ))}
          </div>
        </Section>

        {/* ── the interface ───────────────────────────────────────────── */}
        <Section title="The interface">
          <p className="mt-4">
            Every delivery lands on a live timeline, marked synced, failed,
            skipped or queued. Click one and you get the row that was written,
            how long it took, and the error if there was one. Failed rows can
            be retried in place, without rerunning the whole job.
          </p>

          <Shot
            src="/media/01-bridge-live-cdc.webp"
            alt="A live CDC bridge in Syncle: running, 2,580 delivered, 0 failed, 0 skipped, 100% success, and the customer rows that crossed it with the time each took"
            caption="A CDC bridge mid-flight, and every row that crossed it."
          />

          <p className="mt-8">
            Any database you connect for syncing is also browsable, so the
            interface doubles as a small workbench — for every connection, not
            only the ones in a bridge. You can browse, filter, sort and edit
            rows, and export them as CSV or JSON. There is a query editor (SQL
            for the relational engines, command documents for MongoDB, plain
            commands for Redis), schema views and an interactive ER diagram,
            DDL for creating and dropping tables and databases, and backup and
            restore — portable JSON for any engine, or a{' '}
            <code className="code">.sql</code> script for the relational ones.
          </p>
          <Shot
            src="/media/06-workbench-data.webp"
            alt="The Syncle workbench browsing a customers table: the connection list, a schema tree with row counts, and a paginated grid of 5,060 rows"
            caption="Browsing a source table, with the schema tree beside it."
          />

          <p className="mt-8">
            <a href="/docs/workbench" className="link">
              The query editor and the ER diagram
            </a>
          </p>
        </Section>

        {/* ── install ─────────────────────────────────────────────────── */}
        <Section id="install" title="Installing">
          <div className="mt-5">
            <CopyCommand command={INSTALL_COMMAND} />
          </div>
          <div className="mt-3">
            <InstallTranscript />
          </div>
          <p className="mt-3 text-[15px] text-muted-foreground">
            What a first run prints, start to finish — the script&apos;s actual
            output, not a mock-up.
          </p>

          <ol className="mt-6 list-decimal space-y-3 pl-5">
            {STEPS.map((s) => (
              <li key={s.t} className="pl-1">
                <span className="font-semibold">{s.t}</span> {s.b}
              </li>
            ))}
          </ol>

          <p className="mt-6">After that, a small launcher does the day-to-day:</p>
          <ul className="mt-4 space-y-2">
            {DAY_TO_DAY.map(([cmd, what]) => (
              <li key={cmd} className="text-[15px]">
                <code className="code">{cmd}</code>
                <span className="text-muted-foreground"> — {what}</span>
              </li>
            ))}
          </ul>

          <p className="mt-6 text-[15px] text-muted-foreground">
            Prefer to see what you are piping to sh first? The script is{' '}
            <a
              href={`${GITHUB}/blob/main/install.sh`}
              rel="noopener"
              className="link"
            >
              install.sh in the repository
            </a>
            , and the{' '}
            <a href="/docs/install" className="link">
              installation page
            </a>{' '}
            covers the manual Docker Compose route, ports, and where your data
            lives.
          </p>
        </Section>

        {/* ── use cases ───────────────────────────────────────────────── */}
        <Section id="use-cases" title="What people use it for">
          <p className="mt-4">
            Each of these is one bridge, configured differently.
          </p>
          <div className="mt-5 space-y-4">
            {USE_CASES.map((u) => (
              <p key={u.title}>
                <span className="font-semibold">{u.title}</span>{' '}
                <span className="text-muted-foreground">({u.tag}).</span>{' '}
                {u.body}
              </p>
            ))}
          </div>
        </Section>

        {/* ── http destinations ───────────────────────────────────────── */}
        <Section title="HTTP destinations">
          <p className="mt-4">
            If the rows need to reach a service rather than a database, a
            bridge can POST each change to a URL with a JSON body you design
            yourself:
          </p>
          <CodeBlock title="Payload template">{`{
  "event": "row.changed",
  "op": "{{$op}}",
  "row": "{{$row}}",
  "sent_at": "{{$now}}"
}`}</CodeBlock>
          <p className="mt-4">
            Tokens are filled in per row: any column by name, the whole row,
            the operation that produced it. Substitution happens on the parsed
            JSON rather than by concatenating strings, so a value full of
            quotes cannot break the body and nothing in a row is ever
            evaluated. Failed requests retry with backoff.{' '}
            <a href="/docs/bridges" className="link">
              How bridges work
            </a>{' '}
            has the full token list.
          </p>
        </Section>

        {/* ── what it isn't ───────────────────────────────────────────── */}
        <Section id="compare" title="What it isn’t">
          <p className="mt-4">Some things Syncle deliberately is not:</p>
          <div className="mt-5 space-y-4">
            <p>
              <span className="font-semibold">Not a data platform.</span> There
              is no Kafka, no connector marketplace and no DAG scheduler.
              Airbyte expects a platform deployment and someone to operate it;
              Debezium expects Kafka. Both are aimed at teams whose job is
              running data pipelines, and if that describes you, they are the
              better fit. Syncle is aimed at one person with two databases that
              need to match.
            </p>
            <p>
              <span className="font-semibold">Not a cloud service.</span>{' '}
              Nothing is hosted and there is no account to create. You run it,
              which also means backups are yours to do — the{' '}
              <a href="/docs/self-hosting" className="link">
                self-hosting page
              </a>{' '}
              lists what to back up.
            </p>
            <p>
              <span className="font-semibold">Not a team platform.</span> The
              first run creates one admin account, and an admin can add
              operators and viewers. But there are no organisations, no
              per-bridge permissions and no SSO.
            </p>
            <p>
              <span className="font-semibold">Not free of caveats.</span> CDC
              has prerequisites on each engine, SQLite has no change log to
              read, and Redis change events are not durable. Each of those is
              written down next to the feature it affects.
            </p>
          </div>
        </Section>

        {/* ── security ────────────────────────────────────────────────── */}
        <Section id="security" title="Credentials and data">
          <p className="mt-4">
            Syncle holds credentials for both ends of every bridge and sees
            every row that crosses it. What that means in practice:
          </p>
          <div className="mt-5 space-y-4">
            {SECURITY.map((item) => (
              <p key={item.title}>
                <span className="font-semibold">{item.title}.</span> {item.body}
              </p>
            ))}
          </div>
        </Section>

        {/* ── under the hood ──────────────────────────────────────────── */}
        <Section title="How it is built">
          <p className="mt-4">
            The first stable release, 1.0.0, shipped on 23 July 2026; before
            that the project went by Data Bridge.{' '}
            {/* the sentence already names 1.0.0; only add the clause once
                the changelog has something newer to report */}
            {release && release.version !== '1.0.0' ? (
              <>
                The current release is {release.version}, from{' '}
                {formatReleaseDate(release.date)}.
              </>
            ) : (
              <>The link below always points at the current release.</>
            )}{' '}
            It is TypeScript throughout: a NestJS API and a Next.js
            interface, running as four containers behind one published port,
            with a bundled PostgreSQL and Redis for their own state. The
            interface is available in English and Chinese, and the whole thing
            is MIT licensed.
          </p>
          <p className="mt-4">
            The changelog follows Keep a Changelog and releases aim at semantic
            versioning, so a version number tells you whether an update is a
            fix or a change. <code className="code">syncle update</code> moves a
            running install to the newest release whenever you decide to.
          </p>
          <p className="mt-4">
            <a href={`${GITHUB}/releases/latest`} rel="noopener" className="link">
              Releases
            </a>
            <span className="mx-3 text-muted-foreground">·</span>
            <a
              href={`${GITHUB}/blob/main/CHANGELOG.md`}
              rel="noopener"
              className="link"
            >
              Changelog
            </a>
          </p>
        </Section>

        {/* ── documentation ───────────────────────────────────────────── */}
        <Section id="docs" title="Documentation">
          <p className="mt-4">
            Nine pages cover the whole tool. The commands, defaults and
            endpoints in them were taken from the source rather than from
            memory, and limits are written next to the features they apply to.
          </p>
          <ul className="mt-5 space-y-3 text-[15px]">
            {DOC_PAGES.map((page) => (
              <li key={page.slug}>
                <a href={docHref(page)} className="link">
                  {page.title}
                </a>{' '}
                <span className="text-muted-foreground">
                  — {page.description}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        {/* ── faq ─────────────────────────────────────────────────────── */}
        <Section id="faq" title="Common questions">
          <div className="mt-5 space-y-6">
            {FAQ.map((item) => (
              <div key={item.q}>
                <h3 className="text-[1.05rem]">{item.q}</h3>
                <p className="mt-2">{item.a}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* ── closing ─────────────────────────────────────────────────── */}
        <Section title="Try it">
          <p className="mt-4">
            One command, about a minute. If it turns out not to be for you,{' '}
            <code className="code">syncle uninstall</code> removes everything it
            installed.
          </p>
          <div className="mt-5">
            <CopyCommand command={INSTALL_COMMAND} />
          </div>
          <p className="mt-5">
            <a href="/docs/quickstart" className="link">
              Follow the quickstart
            </a>
          </p>
          <p className="mt-10">
            Questions and setup help go in{' '}
            <a href={`${GITHUB}/discussions`} rel="noopener" className="link">
              Discussions
            </a>
            , so the answer is searchable for the next person who asks. Bugs go
            in{' '}
            <a href={`${GITHUB}/issues`} rel="noopener" className="link">
              the issue tracker
            </a>
            , and that includes places where the documentation and the software
            disagree. I read all of them. Code contributions are welcome; the{' '}
            <a
              href={`${GITHUB}/blob/main/CONTRIBUTING.md`}
              rel="noopener"
              className="link"
            >
              contributing guide
            </a>{' '}
            covers the setup, which is three commands once you have Node 22,
            pnpm 10 and Docker. Security problems should go by email rather
            than into a public issue — the{' '}
            <a href="/docs/self-hosting#reporting" className="link">
              self-hosting page
            </a>{' '}
            explains how.
          </p>
          <p className="mb-16 mt-5">— Osman Ahmadzai</p>
        </Section>
      </main>

      <SiteFooter />
    </>
  );
}
