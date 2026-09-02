import { CodeBlock } from '@/components/docs/code-block';
import { DocArticle, docMetadata } from '@/components/docs/doc-article';
import { Note } from '@/components/docs/note';

export const metadata = docMetadata('quickstart');

export default function Page() {
  return (
    <DocArticle slug="quickstart">
      <p>
        From a running install to a first working bridge: create the operator
        account, connect a database, build a bridge from one of its tables,
        run it, and read the delivery timeline. It assumes you have already
        run <code>syncle up</code> — if not, start with the{' '}
        <a href="/docs/install">installation page</a>.
      </p>

      <h2 id="create-the-operator-account">Create the operator account</h2>
      <p>
        The first time Syncle starts, the API writes a one-time setup token to
        its data directory and prints it in its logs. <code>syncle up</code>{' '}
        (and <code>syncle open</code>) read that token off the container and
        open the interface with it in the URL fragment, as{' '}
        <code>{'http://localhost:3002/#setup-token=<token>'}</code>. A
        fragment never leaves the browser, so the token appears in no request
        log; the setup form reads it, shows a banner confirming you are
        verified as this server&apos;s operator, and strips it from the
        address bar.
      </p>
      <p>
        The form asks for a username (at least 3 characters) and a password
        (at least 8, entered twice). Submitting it creates the single
        operator account — there is no signup and no second account — and the
        API deletes the token the moment the account exists.
      </p>
      <p>
        If you open Syncle from a different device, the token is not
        prefilled. Print it and paste it into the form by hand:
      </p>
      <CodeBlock>{`syncle logs api`}</CodeBlock>

      <h2 id="connect-a-database">Connect a database</h2>
      <p>
        Databases live behind the <strong>Data sources</strong> button in the
        sidebar — a full-screen overlay for connecting databases, browsing
        tables and managing schema. Add a connection: a display name, an
        engine — PostgreSQL, MySQL/MariaDB, SQLite, MongoDB or Redis — and
        host, port, user and password. A <strong>Use TLS / SSL</strong>{' '}
        toggle covers encrypted connections, and an <strong>SSH tunnel</strong>{' '}
        option reaches a database through a jump host, authenticated by
        password or PEM private key. The <strong>Test</strong> button tries
        the connection before you save it; credentials are encrypted at rest
        and come back to the browser redacted.
      </p>
      <p>
        Your database stays where it is — Syncle connects out to it. Once
        saved, the connection&apos;s tables appear in the schema tree, and
        the overlay&apos;s Data, Structure, Query and Diagram tabs let you
        look around; the <a href="/docs/workbench">workbench page</a> covers
        those in full.
      </p>

      <h2 id="create-a-bridge">Create a bridge</h2>
      <p>
        Every table in the schema tree has a <strong>Create bridge</strong>{' '}
        action in its table menu, which opens the bridge builder seeded with
        that table. The builder is one full-screen form: source, trigger,
        payload, destination, delivery settings.
      </p>
      <Note>
        A bridge source needs a table with a single-column primary key. If
        the builder refuses your table, that is what it is missing.
      </Note>
      <p>
        In the source table&apos;s preview, click column headers to include
        or exclude columns; the sample payload under{' '}
        <strong>What gets sent</strong> updates as you do. Under{' '}
        <strong>Trigger</strong>, choose <strong>One-time job</strong>{' '}
        — streams the rows once when run — or <strong>Live bridge</strong>,
        which delivers new rows as they appear, either by polling on a cursor
        or by event-based CDC from the database&apos;s change log. For a
        first bridge, a one-time job shows the whole loop in a single run.
        CDC has per-engine prerequisites: the builder&apos;s{' '}
        <strong>Check readiness</strong> button either reports that the
        source is ready (&quot;we&apos;ll auto-create the publication &amp;
        slot on start&quot;) or lists the setup steps still needed, which the{' '}
        <a href="/docs/cdc">CDC page</a> explains.
      </p>
      <p>
        Under <strong>Destination</strong>, point the bridge at an HTTP
        endpoint (URL and method, with optional bearer-token or
        custom-header auth) or at one or more target databases — pick the
        target connection and table, existing or new, and a write mode of
        Upsert or Insert. Cross-engine targets work, and Syncle can create
        the target table from the source&apos;s shape. Write modes, column
        mapping and the delivery knobs are covered on the{' '}
        <a href="/docs/bridges">bridges page</a>.
      </p>

      <h2 id="run-it-and-read-the-timeline">Run it and read the timeline</h2>
      <p>
        On the bridge&apos;s panel, a one-time job has a{' '}
        <strong>Run job</strong> button; a live bridge has{' '}
        <strong>Start listening</strong> and <strong>Stop listening</strong>.
        Either way, a live timeline colours every delivery: green for
        synced, red for failed, amber for skipped, slate for queued.
        Clicking a cell shows the exact row that was written, the result,
        the timing, and any error, and failed deliveries can be retried in
        place.
      </p>
      <p>
        The log has three views: records (the synced rows as a table), feed
        (newest first, useful while a live bridge is listening), and map
        (one cell per delivery, for progress at a glance). Jobs, statuses
        and what the guarantees actually are belong to the{' '}
        <a href="/docs/bridges">bridges page</a>.
      </p>

      <h2 id="testing-http-destinations">Testing HTTP destinations</h2>
      <p>
        The product repository ships a small echo receiver for trying HTTP
        destinations without a real endpoint. From a checkout:
      </p>
      <CodeBlock>{`pnpm dev:receiver
# Receiver listening on http://localhost:4990`}</CodeBlock>
      <p>
        It logs every request&apos;s method, URL and body — JSON is
        pretty-printed — and answers everything with{' '}
        <code>{'{"ok":true}'}</code>. Point a bridge&apos;s HTTP destination
        at <code>http://localhost:4990</code> and each delivery prints in
        the terminal as it lands. That address works when the API can reach
        your machine&apos;s localhost — running from source it can; from the
        Docker install, localhost inside the API container is the container
        itself, not your machine.
      </p>

      <h2 id="where-next">Where next</h2>
      <p>
        <a href="/docs/bridges">How bridges work</a> explains trigger modes,
        delivery guarantees and the tuning knobs;{' '}
        <a href="/docs/cdc">CDC setup</a> walks the per-engine prerequisites
        for real-time bridges; and <a href="/docs/workbench">the workbench
        page</a> covers everything else behind the Data sources button.
      </p>
    </DocArticle>
  );
}
