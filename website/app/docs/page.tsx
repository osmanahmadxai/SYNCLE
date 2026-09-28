import { CodeBlock } from '@/components/docs/code-block';
import { DocArticle, docMetadata } from '@/components/docs/doc-article';
import { GITHUB, INSTALL_COMMAND } from '@/lib/content';
import { DOC_PAGES, docHref } from '@/lib/docs';

export const metadata = docMetadata('');

export default function DocsIndex() {
  return (
    <DocArticle slug="">
      <p>
        Syncle keeps databases in sync, live and across engines, without a
        data platform in between. Most change-data-capture tools hand you a
        stream and stop there: Debezium gives you a Kafka topic, and you still
        run the broker and build the thing that writes to your database. Syncle
        writes to your database. You connect databases, draw a{' '}
        <strong>bridge</strong> from a source to one or more destinations, and
        rows move across it — once, on a schedule, or the moment they change.
      </p>

      <p>
        Five engines are supported — PostgreSQL, MySQL, SQLite, MongoDB
        and Redis — and any of them can sit on either end of a bridge. A
        relational table can feed a document store, a document collection can
        feed a key-value cache, and an HTTP endpoint can stand in for a
        database on the receiving side. Everything runs on your own machine,
        under the MIT licence, and the web interface is how you use it day to
        day.
      </p>

      <h2 id="the-shape-of-it">What gets installed</h2>
      <p>
        Four containers: the web interface, the API, and a PostgreSQL and
        Redis instance of its own. The PostgreSQL holds Syncle&apos;s metadata
        (connections, bridges, job history) and the Redis backs the job queue.
        Your databases stay wherever they already are; Syncle connects out to
        them.
      </p>
      <p>Three terms come up throughout these pages:</p>
      <ul>
        <li>
          A <strong>bridge</strong> is the saved sync path — the source table
          or query, the column mapping, the destinations, and the trigger.
        </li>
        <li>
          A <strong>job</strong> is one execution of a bridge.
        </li>
        <li>
          A <strong>delivery</strong> is one row (or batch) delivered within a
          job — the unit the live timeline shows, and the unit you can retry
          or skip.
        </li>
      </ul>

      <h2 id="installing">Installing</h2>
      <p>
        Docker with Compose v2 and curl are the only requirements. One command
        downloads the newest release, starts it, and opens the interface:
      </p>
      <CodeBlock>{INSTALL_COMMAND}</CodeBlock>
      <p>
        The <a href="/docs/install">installation page</a> explains what the
        script actually does, the manual Docker Compose route if you would
        rather not pipe curl into sh, and how updating and uninstalling work.
      </p>

      <h2 id="reading-order">Where to go next</h2>
      <ul>
        {DOC_PAGES.filter((p) => p.slug !== '').map((p) => (
          <li key={p.slug}>
            <a href={docHref(p)}>{p.title}</a> — {p.description}
          </li>
        ))}
      </ul>

      <h2 id="about-these-docs">About these docs</h2>
      <p>
        These pages document Syncle 1.0. Every command, endpoint and default
        in them was taken from{' '}
        <a href={GITHUB} rel="noopener">
          the source repository
        </a>{' '}
        rather than from memory. Where a feature has a limitation — SQLite has
        no change log to capture, Redis change events are not durable — it is
        written down next to the feature itself. If you find a place where the
        docs and the software disagree, that is a bug:{' '}
        <a href={`${GITHUB}/issues`} rel="noopener">
          please report it
        </a>
        .
      </p>
    </DocArticle>
  );
}
