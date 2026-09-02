import { CodeBlock } from '@/components/docs/code-block';
import { DocArticle, docMetadata } from '@/components/docs/doc-article';
import { Note } from '@/components/docs/note';

export const metadata = docMetadata('troubleshooting');

export default function Page() {
  return (
    <DocArticle slug="troubleshooting">
      <p>
        The failures people actually hit, and what each one means. Most of them
        are a database setting rather than a bug in Syncle — CDC in particular
        needs the source server configured for it, and no tool can turn that on
        from the outside.
      </p>

      <h2 id="syncle-up-does-nothing">syncle up exits without starting</h2>
      <p>
        Two known causes. If the message mentions resolving a reference, you are
        on an install older than 1.2.0, where the installer asked for the image
        by its release tag (<code>v1.2.0</code>) while images publish without
        the prefix (<code>1.2.0</code>). Reinstalling picks up the fixed script.
      </p>
      <p>
        If the machine is offline, upgrade to 1.2.0 or later. Before it, a
        failed image pull aborted the whole start, so a host with the images
        already cached could not run Syncle at all; the pull is now best-effort.
      </p>
      <p>
        Otherwise it is usually the port. Syncle publishes one, 3002, and
        refuses to start if something already holds it:
      </p>
      <CodeBlock>{`lsof -i :3002`}</CodeBlock>

      <h2 id="lost-the-setup-token">The setup form wants a token</h2>
      <p>
        <code>syncle up</code> normally reads the first-run token off the server
        and opens the interface with it already accepted. Opening Syncle from a
        different device skips that, because the token is only readable by
        something with access to the container. Print it and paste it in:
      </p>
      <CodeBlock>{`syncle logs api`}</CodeBlock>
      <p>
        If the account already exists, there is no token to find — the API
        deletes it the moment setup succeeds, and clears it at boot when an
        account is present. Use the login form instead.
      </p>

      <h2 id="cdc-never-fires">A CDC bridge never delivers anything</h2>
      <p>
        Almost always the source server is not configured for change data
        capture. The builder checks this before it lets you save, and names the
        setting that is missing — if you skipped past that, re-open the bridge
        and look at the trigger step. What each engine needs:
      </p>

      <h3 id="cdc-postgres">PostgreSQL</h3>
      <p>
        <code>wal_level=logical</code>, set in <code>postgresql.conf</code> or
        your provider&apos;s parameter group, followed by a server restart. This
        is the one prerequisite that cannot be automated, because it needs the
        restart.
      </p>

      <h3 id="cdc-mysql">MySQL and MariaDB</h3>
      <p>
        Row-based binary logging, in <code>my.cnf</code>:{' '}
        <code>log_bin=ON</code>, <code>binlog_format=ROW</code>,{' '}
        <code>binlog_row_image=FULL</code>, and a unique{' '}
        <code>server_id</code>. It needs a server restart. On managed MySQL —
        RDS, Aurora, Cloud SQL — set these in the parameter group and reboot.
      </p>

      <h3 id="cdc-mongodb">MongoDB</h3>
      <p>
        Change streams require a replica set. A single-node replica set is fine
        for development: start <code>mongod</code> with{' '}
        <code>--replSet rs0</code> and run <code>rs.initiate()</code> once.
        Atlas already satisfies this.
      </p>

      <h3 id="cdc-redis">Redis</h3>
      <p>
        Keyspace notifications, which Syncle tries to enable itself on start:
      </p>
      <CodeBlock>{`CONFIG SET notify-keyspace-events EA`}</CodeBlock>
      <p>
        Managed Redis usually refuses that and wants it enabled in the provider
        console instead. It can also be set permanently in{' '}
        <code>redis.conf</code>.
      </p>

      <Note>
        Redis keyspace notifications are fire-and-forget. If Syncle is not
        running at the moment a key changes, that event is gone — it is not
        replayed on reconnect. A Redis CDC bridge is therefore not a
        completeness guarantee, and a periodic replay job is the way to close
        the gap. See <a href="/docs/cdc">CDC setup</a>.
      </Note>

      <h2 id="watch-delivers-nothing">A watch bridge delivers nothing</h2>
      <p>
        A new watch bridge starts from <strong>now</strong> by default, so it
        ignores everything already in the table and only delivers rows that
        appear after it started. If you wanted the existing rows too, either set
        it to start from the beginning, or run a replay job once to backfill and
        leave the watch running for what follows.
      </p>
      <p>
        If it delivers nothing even for new rows, check the cursor matches the
        table. A timestamp cursor on a column the application does not update
        will never advance; a table whose primary keys are UUIDs needs the
        primary-key diff strategy rather than an incrementing id. A cursor
        column holding future timestamps parks the bridge until real time
        catches up.
      </p>

      <h2 id="deletes-missing">Deletes are not crossing the bridge</h2>
      <p>
        Expected on a watch bridge. Watch polls for rows that exist, so it sees
        inserts, and updates when the cursor is a timestamp, but a deleted row
        is simply absent from the next poll and indistinguishable from one that
        was never there. Deletes need a CDC trigger, which reads them from the
        change log.
      </p>

      <h2 id="cannot-connect">A connection will not test</h2>
      <p>
        An error beginning <code>SSH:</code> comes from the tunnel, not the
        database — the jump host refused the key, the user, or the forward.
        Check the SSH credentials on their own before looking at the database.
      </p>
      <p>
        Without a tunnel, the usual causes are the database not listening on an
        interface Syncle can reach, or TLS. Syncle connects out to your
        database, so the database has to accept a connection from the Docker
        host. On the same machine, that is generally{' '}
        <code>host.docker.internal</code> rather than{' '}
        <code>localhost</code>, which inside a container means the container.
      </p>

      <h2 id="deliveries-failing">Rows are failing rather than syncing</h2>
      <p>
        Click a failed delivery on the timeline: it shows the row that was sent
        and the error that came back. Failed rows can be retried in place
        without rerunning the whole job.
      </p>
      <p>
        A bridge that fails everything usually has a destination mismatch — key
        columns that are not unique in the target, or a type the target will not
        accept. A bridge that fails intermittently against an HTTP endpoint is
        usually being rate limited; raise the minimum delay between requests, or
        lower the batch size, in the bridge&apos;s delivery settings.
      </p>

      <h2 id="still-stuck">Still stuck</h2>
      <p>
        <code>syncle logs api</code> carries the server side of anything the
        interface could not explain. If it looks like a bug, open an issue with
        the engine, the trigger type, and that log; if you are unsure whether it
        is a bug,{' '}
        <a
          href="https://github.com/osmanahmadxai/SYNCLE/discussions"
          rel="noopener"
        >
          Discussions
        </a>{' '}
        is the better place to start.
      </p>
    </DocArticle>
  );
}
