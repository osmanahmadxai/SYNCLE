import type { Metadata } from 'next';
import { CopyCommand } from '@/components/copy-command';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { SyncDiagram } from '@/components/sync-diagram';
import { GITHUB, INSTALL_COMMAND } from '@/lib/content';
import { DOC_PAGES, docHref } from '@/lib/docs';
import { MEASURE } from '@/lib/layout';

export const metadata: Metadata = {
  alternates: { canonical: '/' },
};

const TRIGGERS: [string, string][] = [
  ['Replay', 'reads the whole table once and stops. Use it to backfill or to migrate.'],
  ['Watch', 'checks for new rows against a cursor you choose, such as an id or an updated_at column. It works on all five engines.'],
  ['CDC', "reads the database's own change log. Nothing polls, and a change shows up as soon as it commits."],
];

const STEPS: [string, string][] = [
  ['Run the command above.', 'It checks for Docker, pulls the image, starts four containers and opens localhost:3002.'],
  ['Create your account.', 'The setup form opens with a one-time token already in it.'],
  ['Build a bridge.', 'Choose a source table, choose a destination, press start.'],
];

const COMMANDS: [string, string][] = [
  ['syncle up', 'start it and open the interface'],
  ['syncle down', 'stop it, keeping your data'],
  ['syncle logs', 'follow what the bridges are doing'],
  ['syncle update', 'move to the newest release'],
  ['syncle uninstall', 'remove everything, data included'],
];

function Section({ id, title, children }: {
  id?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mt-16 scroll-mt-8">
      <h2 className="text-[1.3rem]">{title}</h2>
      {children}
    </section>
  );
}

export default function Home() {
  return (
    <>
      <SiteHeader />

      <main className={`mx-auto px-6 text-[17px] leading-[1.7] ${MEASURE}`}>
        <section className="pt-10">
          <h1 className="text-[2.2rem] leading-[1.15]">
            Keep multiple databases in sync without kafka
          </h1>

          <p className="mt-6 max-w-[60ch]">
            Syncle connects to PostgreSQL, MySQL, SQLite, MongoDB and Redis.
            You pick a table on one of them and where it should go on another.
            Syncle copies the rows across, then keeps copying as the source
            changes.
          </p>

          <div className="mt-8">
            <CopyCommand command={INSTALL_COMMAND} />
          </div>

          <p className="mt-3 max-w-[60ch] text-[15px] text-muted-foreground">
            Docker with Compose v2 is all you need. Runs on your own machine,
            MIT licensed.
          </p>
        </section>

        <Section title="What it does">
          <figure className="mt-6">
            <SyncDiagram />
            <figcaption className="mt-3 max-w-[60ch] text-[15px] text-muted-foreground">
              One Postgres table feeding three other databases at the same
              time.
            </figcaption>
          </figure>

          <p className="mt-6 max-w-[60ch]">
            A bridge connects one source to one or more destinations. Any
            engine can sit on either side, so a Postgres table can go to
            MongoDB, to Redis, or to another Postgres. A destination can also
            be an HTTP endpoint, if you are feeding a service instead of a
            database.
          </p>
          <p className="mt-4 max-w-[60ch]">
            If the destination table does not exist yet, Syncle creates it and
            works out the column types for that engine. Writes are upserts, so
            running a sync twice will not leave you with two copies of a row.
            A job that dies partway through restarts from the last row it
            recorded, not from the beginning.
          </p>
        </Section>

        <Section id="how-it-works" title="Three ways to run a bridge">
          <ul className="mt-5 space-y-3">
            {TRIGGERS.map(([name, what]) => (
              <li key={name} className="max-w-[60ch]">
                <span className="font-semibold">{name}</span> {what}
              </li>
            ))}
          </ul>
          <p className="mt-5 max-w-[60ch] text-[15px] text-muted-foreground">
            Two things to know. SQLite has no change log, so watch is the only
            option there. Redis keyspace notifications are not durable, so a
            Redis CDC bridge misses anything that changes while Syncle is off.
            Both are covered in{' '}
            <a href="/docs/bridges" className="link">how bridges work</a> and{' '}
            <a href="/docs/cdc" className="link">CDC setup</a>.
          </p>
        </Section>

        <Section id="install" title="Installing">
          <ol className="mt-5 list-decimal space-y-2 pl-5">
            {STEPS.map(([step, what]) => (
              <li key={step} className="max-w-[60ch] pl-1">
                <span className="font-semibold">{step}</span> {what}
              </li>
            ))}
          </ol>
          <p className="mt-6">After that you use the launcher:</p>
          <ul className="mt-3 space-y-1.5 text-[15px]">
            {COMMANDS.map(([cmd, what]) => (
              <li key={cmd}>
                <code className="code">{cmd}</code>
                <span className="text-muted-foreground"> — {what}</span>
              </li>
            ))}
          </ul>
          <p className="mt-6 max-w-[60ch] text-[15px] text-muted-foreground">
            The script is{' '}
            <a href={`${GITHUB}/blob/main/install.sh`} rel="noopener" className="link">
              install.sh
            </a>{' '}
            if you want to read it before you run it. The{' '}
            <a href="/docs/install" className="link">installation page</a>{' '}
            covers the manual Docker Compose route.
          </p>
        </Section>

        <Section id="docs" title="Documentation">
          <ul className="mt-5 space-y-2 text-[15px]">
            {DOC_PAGES.map((page) => (
              <li key={page.slug}>
                <a href={docHref(page)} className="link">{page.title}</a>{' '}
                <span className="text-muted-foreground">— {page.description}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Questions and bugs">
          <p className="mt-5 mb-16 max-w-[60ch]">
            Setup questions go in{' '}
            <a href={`${GITHUB}/discussions`} rel="noopener" className="link">
              Discussions
            </a>
            . Bugs go in{' '}
            <a href={`${GITHUB}/issues`} rel="noopener" className="link">
              the issue tracker
            </a>
            , including anywhere the docs and the software disagree. For a
            security problem,{' '}
            <a href="/docs/self-hosting#reporting" className="link">
              email instead of opening an issue
            </a>
            .
          </p>
        </Section>
      </main>

      <SiteFooter />
    </>
  );
}
