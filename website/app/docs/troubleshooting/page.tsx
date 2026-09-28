import { CodeBlock } from '@/components/docs/code-block';
import { DocArticle, docMetadata } from '@/components/docs/doc-article';
import { Note } from '@/components/docs/note';

export const metadata = docMetadata('troubleshooting');

export default function Page() {
  return (
    <DocArticle slug="troubleshooting">
      <p>
        The failures that come up most often, and what each one means. Most
        turn out to be a database setting rather than a bug in Syncle. CDC in
        particular needs the source server configured for it, and no tool can
        turn those settings on from the outside.
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

      <h2 id="forgot-password">I cannot sign in: the password is gone</h2>
      <p>
        There is no e-mail address on file to send a link to, so the reset
        works the way first-run setup did: a code is printed on the server, and
        reading it proves you have access to the machine.
      </p>
      <CodeBlock>{`syncle reset-password`}</CodeBlock>
      <p>
        …or choose <em>Forgot your password?</em> on the sign-in screen, press
        the button, and read the code from <code>syncle logs api</code> (without
        the launcher: the API&apos;s console, or the file{' '}
        <code>reset-code</code> in its data directory). Enter it with a new
        password. The code works once, for fifteen minutes, and dies after ten
        wrong guesses; setting the password signs you in and ends every session
        there was. Pressing the button tells a stranger nothing — not even
        whether an account exists — and without access to the server the code
        it produces is a line in a log they cannot read. At most one code a
        minute is made, so the button cannot flood the log either.
      </p>

      <h2 id="cross-origin-403">
        Signing in (or saving anything) answers &quot;came from another
        site&quot;
      </h2>
      <p>
        A request that changes something is only{' '}
        <a href="/docs/self-hosting#request-origin">taken from the app itself</a>
        . A <code>403</code> with that message means the API could not tell
        that it was: the browser is too old to say so (
        <code>Sec-Fetch-Site</code>), <em>and</em> the address in the
        browser&apos;s bar is not the one the API was reached under — a reverse
        proxy that replaces the <code>Host</code> header is the usual cause.
        Either have the proxy pass it on (nginx:{' '}
        <code>proxy_set_header Host $host;</code>) or set{' '}
        <code>WEB_ORIGIN</code> to the public address, for example{' '}
        <code>https://syncle.example.com</code>. The origin it saw is in the
        message.
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
      <p>
        If the bridge will not <em>start</em> and the message mentions a{' '}
        <strong>replica identity</strong>, the table has no primary key.
        PostgreSQL can then only report inserts for it — and publishing
        updates or deletes for such a table would make <code>UPDATE</code>{' '}
        and <code>DELETE</code> on it fail in your own database, which is why
        Syncle refuses instead of going ahead. Capture inserts only, add a
        primary key, or run{' '}
        <code>ALTER TABLE your_table REPLICA IDENTITY FULL;</code>. A refusal
        that says <em>deletes cannot reach</em> a target is the same rule seen
        from the other side: a delete carries only the source&apos;s key, so
        the target has to be keyed on it. Both are explained under{' '}
        <a href="/docs/cdc#postgres-table">what the table needs</a>.
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
      <p>
        On a CDC bridge, check that <code>delete</code> is among its
        operations, and that the target has key columns — an append-only
        (<code>insert</code> mode) target records rows and has nothing to
        delete by, so it never applies deletes. A <code>TRUNCATE</code> is not
        a delete of every row: it is its own event, PostgreSQL-only and off by
        default. When the source is truncated the timeline says so in an
        amber entry, and the destination keeps its rows unless the bridge
        captures <code>truncate</code> — see{' '}
        <a href="/docs/cdc#operations">operations</a>.
      </p>

      <h2 id="cannot-connect">A connection will not test</h2>
      <p>
        An error beginning <code>SSH:</code> comes from the tunnel, not the
        database — the jump host refused the key, the user, or the forward.
        Check the SSH credentials on their own before looking at the database.
        <code>SSH: the host key of … has CHANGED</code> means the jump host
        presented a different key than the one recorded for this connection:
        do not just clear the field — confirm the new fingerprint with whoever
        runs the host first.
      </p>
      <p>
        An error beginning <code>TLS:</code>, or mentioning a certificate,{' '}
        <code>altname</code> or <code>self-signed</code>, is the verification
        you asked for doing its job. <em>Self-signed certificate in chain</em>{' '}
        means the server&apos;s CA is not one Syncle trusts: paste it into the
        connection&apos;s CA certificate field. <em>Hostname/IP does not match
        certificate&apos;s altnames</em> means the certificate was issued for a
        different name than the one in the host field: dial the name on the
        certificate, or set the expected server name. Dropping to{' '}
        <em>Encrypt only</em> makes the error go away by no longer checking —
        use it to confirm the diagnosis, not as the fix.
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

      <h2 id="bridge-paused-itself">A live bridge paused itself</h2>
      <p>
        A watch or CDC bridge that stops on its own always leaves the reason
        on the job, and always stops <em>without</em> moving its cursor — so
        nothing was skipped, and starting it again picks up the same rows.
        What the message says tells you what to fix first:
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>The job says</th>
              <th>What happened</th>
              <th>What to do</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Paused after a failed delivery (onError=abort)</td>
              <td>
                the bridge is set to stop at the first failure, and it did
              </td>
              <td>
                fix what the error names, then start the bridge. If a single
                bad row should not stop everything, switch On failure to
                setting failed rows aside
              </td>
            </tr>
            <tr>
              <td>this is not a few bad rows</td>
              <td>
                a batch failed, and splitting it found nothing that would go
                through — the destination is rejecting everything
              </td>
              <td>
                check the destination is reachable, the table exists, and its
                columns still match the source
              </td>
            </tr>
            <tr>
              <td>N batches in a row delivered nothing</td>
              <td>the same, seen across several small batches</td>
              <td>
                as above. Rows from the earlier batches are in the dead-letter
                queue — retry them after starting the bridge
              </td>
            </tr>
            <tr>
              <td>the dead-letter queue is full</td>
              <td>
                failed rows reached{' '}
                <code>SYNCLE_DEAD_LETTER_MAX_ROWS</code>
              </td>
              <td>
                retry or discard the queue, then start the bridge. A queue
                that keeps filling means the cause was never fixed
              </td>
            </tr>
            <tr>
              <td>progress could not be saved</td>
              <td>
                Syncle&apos;s own database was unreachable. The job is marked{' '}
                <code>failed</code> rather than paused
              </td>
              <td>
                bring the metadata store back, then start the bridge
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="position-lost">A bridge says it cannot resume where it stopped</h2>
      <p>
        A live bridge resumes from a position in the source&apos;s change log,
        and that position no longer exists. The message names the cause: the
        PostgreSQL replication slot was dropped or invalidated (the server
        hit <code>max_slot_wal_keep_size</code>, or Syncle&apos;s own{' '}
        <code>SYNCLE_SLOT_MAX_BYTES</code> guard gave it up, or someone
        dropped it by hand); MySQL purged the binlog file; MongoDB&apos;s oplog
        rolled past the resume token; or a MySQL connection now reaches a
        different server than the one that issued the position.
      </p>
      <p>
        What changed at the source in between cannot be read any more, so
        there are two steps: start the bridge and confirm{' '}
        <strong>Continue from now</strong>, then run a replay of the same
        bridge to bring the destination up to date (writes are upserts, so
        replaying over existing rows is safe). To stop it recurring, keep the
        log for longer than a bridge is ever paused:{' '}
        <code>max_slot_wal_keep_size</code>,{' '}
        <code>binlog_expire_logs_seconds</code>, the oplog size.
      </p>

      <h2 id="source-disk">The source database&apos;s disk is filling up</h2>
      <p>
        On PostgreSQL, look for a replication slot nothing is reading:
      </p>
      <CodeBlock title="psql">{`SELECT slot_name, active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS pinned
FROM pg_replication_slots ORDER BY 3 DESC;`}</CodeBlock>
      <p>
        A <code>syncle_slot_…</code> that is not active belongs to a bridge
        that is paused or failed; the bridge&apos;s job view shows the same
        figure with a warning. Start the bridge and it catches up and lets
        the WAL go; delete the bridge and the slot goes with it. If the bridge
        is already gone — it was deleted while the server was unreachable —
        Syncle keeps retrying the drop (
        <code>GET /api/bridges/cdc/cleanups</code>), or drop it yourself with{' '}
        <code>SELECT pg_drop_replication_slot(&apos;syncle_slot_…&apos;);</code>
        . Then set <code>max_slot_wal_keep_size</code> so that it cannot
        happen again; the details are under{' '}
        <a href="/docs/cdc#postgres-slots">replication slots</a>.
      </p>

      <h2 id="dead-letters-stuck">Rows will not leave the dead-letter queue</h2>
      <p>
        A retry that still fails keeps the entry and replaces its error with
        the new one, so the entry always shows the <em>latest</em> reason.
        Usually the destination still refuses the row — fix the constraint,
        type or mapping it names and retry again.
      </p>
      <p>
        An entry that a retry leaves untouched, offering{' '}
        <em>Write recorded row</em>, is a different case: its source row no
        longer exists and the bridge does not propagate deletes, so Syncle
        cannot tell whether the row it recorded is still the newest version.
        Write it anyway if the destination is meant to keep rows the source
        has dropped; discard it otherwise.{' '}
        <a href="/docs/bridges#dead-letter-queue">How bridges work</a> has the
        reasoning.
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
