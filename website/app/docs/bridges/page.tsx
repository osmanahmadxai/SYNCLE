import { CodeBlock } from '@/components/docs/code-block';
import { DocArticle, docMetadata } from '@/components/docs/doc-article';
import { Note } from '@/components/docs/note';

export const metadata = docMetadata('bridges');

export default function Page() {
  return (
    <DocArticle slug="bridges">
      <p>
        A bridge is the saved sync path: a source, a column mapping, one or
        more destinations, and a trigger that decides when rows move. This
        page is the mental model — how a bridge turns into jobs and
        deliveries, what each trigger mode does, and what Syncle guarantees
        about what lands on the other side.
      </p>

      <h2 id="bridges-jobs-deliveries">Bridges, jobs and deliveries</h2>
      <p>
        Three words carry everything here. A <strong>bridge</strong> is the
        configuration: the source (a table, optionally filtered and sorted, or
        a raw query on a connection), the transform, the destinations, and the
        trigger. A <strong>job</strong> is one execution of a bridge. A{' '}
        <strong>delivery</strong> is one row — or one batch, when batching is
        on — delivered within a job; it is the unit the live timeline shows
        and the unit you can retry or skip.
      </p>
      <p>
        Every trigger funnels rows through the same delivery pipeline, so the
        timeline, retry controls and idempotency behave the same whether a row
        came from a one-shot replay, a poll, or a change event. Two knobs are
        narrower than that. The bridge&apos;s <code>batchSize</code> shapes
        replay jobs and the requests a CDC bridge sends to an HTTP
        destination; a watch bridge always delivers one row per delivery, and
        a CDC bridge writing to a <em>database</em> groups changes on its own
        (see <a href="/docs/configuration">SYNCLE_CDC_BATCH_SIZE</a>), which
        idempotent upserts make invisible. And the <code>minDelayMs</code>{' '}
        rate limit paces replay and watch deliveries but not CDC.
      </p>

      <h2 id="trigger-modes">The three trigger modes</h2>

      <h3 id="replay">Replay</h3>
      <p>
        A replay bridge runs on demand: press Run job and it streams the
        source once, a page at a time, delivering every row (or the filtered
        subset). This is the mode for an initial backfill or a one-off
        migration, and it is the default for a new bridge.
      </p>

      <h4 id="scheduled-replays">On a schedule</h4>
      <p>
        A replay bridge can also run by itself. In the builder, under{' '}
        <em>When it runs</em>, choose <em>On a schedule</em> and give it a cron
        line and the time zone the line is meant in — through the API,{' '}
        <code>
          {'trigger: { kind: "replay", schedule: { cron: "0 2 * * *", timezone: "Europe/Rome", enabled: true } }'}
        </code>
        . At every tick the <em>whole</em> source is replayed. Into a target
        in upsert mode that brings the destination up to date; into one in
        insert mode it inserts every row again, which the builder warns about —
        a scheduled bridge almost always wants upsert and key columns.
      </p>
      <ul>
        <li>
          <strong>The line</strong> is the classic five fields —{' '}
          <code>minute hour day-of-month month day-of-week</code> — with{' '}
          <code>*</code>, lists (<code>1,15</code>), ranges (
          <code>mon-fri</code>), steps (<code>*/15</code>,{' '}
          <code>9-17/2</code>) and the names of months and days. No seconds, no{' '}
          <code>@daily</code>, no <code>L</code> or <code>#</code>: once a minute
          is the most a bridge is scheduled. When both day fields are
          restricted, either one fires it, as in a crontab. The builder shows
          the next runs as the server works them out, so what you see is what
          will fire.
        </li>
        <li>
          <strong>The zone</strong> is a name (<code>Europe/Rome</code>,{' '}
          <code>UTC</code>), never an offset: “02:00” stays 02:00 there, summer
          and winter. On the night the clocks go back the run happens once, not
          twice; on the night they go forward a run due in the missing hour
          happens an hour later, not never.
        </li>
        <li>
          <strong>Never two at once.</strong> If the run before is still going
          when the next is due, that tick is skipped — shown on the bridge, and
          sent as a warning to{' '}
          <a href="/docs/self-hosting#alerts">alert channels</a> subscribed to
          bridge failures. If it keeps happening, the schedule is tighter than
          the replay takes.
        </li>
        <li>
          <strong>From the top, every time.</strong> Pressing Run on a bridge
          whose last run stopped half-way picks that run up again. A scheduled
          run does not: it is a new run of the whole source, and the stopped
          one stays in the list as history. Runs the schedule started carry a
          small calendar mark.
        </li>
        <li>
          <strong>Off means off.</strong> A schedule fires only while it is
          switched on <em>and</em> the bridge is enabled. A bridge that arrives
          by <a href="#export-import">import, or as a duplicate</a>, keeps its
          line but has it switched off, so that a file dropped onto production
          does not start writing at two in the morning because staging did.
        </li>
        <li>
          <strong>Restarts.</strong> The schedule lives in Redis beside the job
          queue, and several API processes on one Redis fire it once between
          them. If the API was down at the time of a tick, that one run happens
          when it is back; earlier missed ticks are not made up. At every start
          the schedules in Redis are compared with the bridges in the database
          and put right.
        </li>
      </ul>

      <h3 id="watch">Watch</h3>
      <p>
        A watch bridge polls the source on a cursor and delivers whatever is
        new. Polling works on every engine — including SQLite, which has no
        change log — so watch is the universal live mode. Three strategies
        decide what &quot;new&quot; means:
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Cursor</th>
              <th>Detects</th>
              <th>Semantics</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>increment</code>
              </td>
              <td>a strictly-increasing column (auto-increment id, sequence)</td>
              <td>inserts only</td>
              <td>
                exact: each poll asks for <code>{'col > cursor'}</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>timestamp</code>
              </td>
              <td>
                a <code>created_at</code> / <code>updated_at</code> column
              </td>
              <td>new rows, plus updates when the column is bumped</td>
              <td>
                polls <code>{'col >= cursor'}</code> and re-scans a{' '}
                <code>lookbackMs</code> window (default 3000 ms) behind the
                cursor so late-committing transactions are not lost. What it
                has already sent is remembered by key <em>and</em> timestamp,
                so re-reading the window sends nothing twice — and the same
                row with a later timestamp is a change, however soon after the
                last one
              </td>
            </tr>
            <tr>
              <td>
                <code>snapshot</code>
              </td>
              <td>the set of primary keys already seen</td>
              <td>rows with unseen keys</td>
              <td>
                for UUID and other non-monotonic keys; bounded by{' '}
                <code>maxTracked</code> (default 50,000), so best for small
                and medium tables
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        The watch trigger itself has three knobs:{' '}
        <code>pollIntervalMs</code> (1000–3600000, default 5000),{' '}
        <code>startFrom</code> (<code>beginning</code> or <code>now</code>,
        default <code>now</code> — which ignores existing rows and only
        delivers ones added after the watch starts), and{' '}
        <code>maxPerPoll</code> (default 500), which caps rows delivered per
        poll cycle as backpressure.
      </p>

      <h3 id="cdc">CDC</h3>
      <p>
        A CDC bridge streams changes from the database&apos;s own change log —
        real time, no polling: Postgres logical replication, MySQL binlog,
        MongoDB change streams, Redis keyspace notifications. You can
        subscribe to a subset of operations (insert, update, delete; default
        all three — PostgreSQL sources can also mirror{' '}
        <code>TRUNCATE</code>, which is opt-in). SQLite has no change log, so CDC is not available there —
        use a watch bridge. Each engine has prerequisites and honest
        limitations, and the bridge builder runs a readiness check that lists
        anything missing; the <a href="/docs/cdc">CDC setup page</a> covers
        all of it.
      </p>

      <h4 id="copy-then-follow">Copy what is there, then follow</h4>
      <p>
        A change log only knows about changes. A CDC bridge set to{' '}
        <strong>Only changes from now on</strong> (the default) leaves the
        rows a table already holds where they are. Set to{' '}
        <strong>Copy what is there, then follow changes</strong>, the same
        bridge does both — and the point of doing both in one bridge is the
        seam between them. A replay followed by a separate CDC bridge either
        misses what changed in between, or lets an old value the replay read
        land on top of a newer one. So, on its first start, the bridge:
      </p>
      <ol>
        <li>
          takes its place in the source&apos;s change log — without reading
          from it yet;
        </li>
        <li>
          reads the table from one end to the other and delivers every row
          as an <code>insert</code>, through the same pipeline changes use
          (filters, transforms, batching, the dead-letter queue);
        </li>
        <li>
          opens the change stream <em>at the place it took in step 1</em>.
          Everything that changed while the copy ran arrives now, after the
          copied rows, in order.
        </li>
      </ol>
      <p>
        A row that changed during the copy is therefore delivered twice —
        once as the copy read it, once as the change — and ends up right,
        because a keyed target is written with an idempotent upsert. An
        append-only (<code>insert</code>-mode) target or an HTTP receiver
        sees it twice; that is the same at-least-once contract every live
        bridge has. The timeline marks the end of the copy with a note
        (&quot;Copied the 1,204,551 rows the table already had…&quot;).
      </p>
      <ul>
        <li>
          <strong>It resumes.</strong> The copy&apos;s progress is
          checkpointed like any other position: a bridge stopped — or a
          Syncle restarted — mid-copy carries on from the row it had reached,
          with the place in the log it took the <em>first</em> time.
        </li>
        <li>
          <strong>It happens once.</strong> A bridge that already has a
          position resumes from it; changing the setting later does not
          re-copy anything. The table needs a primary key (or the bridge a
          sort) to be read in a stable order — without one the start is
          refused, before anything is touched.
        </li>
        <li>
          <strong>The source holds the log for as long as the copy
          runs.</strong>{' '}
          On PostgreSQL the replication slot pins WAL from the moment it is
          created (the <a href="/docs/cdc#postgres-slots">slot guard</a>{' '}
          reports how much); on MySQL and MongoDB the binlog / oplog has to
          outlast the copy, or the bridge stops and says its position was
          lost. Redis has no log: the stream is opened first and its changes
          are held in memory — the newest per key — until the copy is done
          (see{' '}
          <a href="/docs/configuration">
            <code>SYNCLE_SNAPSHOT_HOLD_MAX</code>
          </a>
          ).
        </li>
        <li>
          <strong>After a lost position</strong>, such a bridge offers to
          copy the table again, which brings every row that still exists up
          to date. Rows deleted at the source in the meantime stay at the
          destination. &quot;Continue from now&quot; still means exactly
          that: no copy.
        </li>
      </ul>

      <h2 id="filters-and-transforms">Filters and column transforms</h2>
      <p>
        Two things can happen to a row between the source and the
        destination: it can be left out, and its values can be changed. Both
        are set in the bridge builder, both are part of the bridge&apos;s
        saved configuration, and both apply the same way whatever the trigger
        and whatever the destination.
      </p>

      <h3 id="filters">Only rows where…</h3>
      <p>
        A bridge&apos;s source can carry a list of conditions —{' '}
        <em>equals</em>, <em>is not</em>, <em>greater / less than</em>,{' '}
        <em>contains</em>, <em>starts / ends with</em>, <em>is empty</em>,{' '}
        <em>is not empty</em> — and a row is sent only when it meets all of
        them. A replay and a watch bridge push the conditions into the
        source&apos;s own query, so rows that do not match are never read; a
        CDC bridge sees every change of the table and applies the same
        conditions, with the same semantics, to each one. A value typed into
        the builder for a numeric or boolean column is sent as a number or a
        boolean, which is what MongoDB needs to match it.
      </p>
      <p>
        The builder does not save a condition that is only half written — a
        comparison with no value blocks the save instead of quietly becoming
        &quot;no condition&quot;, which would send every row. Conditions set
        through the API that the editor has no row for (an{' '}
        <code>in</code> list, for instance) are kept as they are when the
        bridge is edited.
      </p>

      <h3 id="column-transforms">Change values on the way</h3>
      <p>
        A bridge can carry a list of steps that are applied to every row
        before it is delivered. There are five kinds:
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Step</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Mask</strong>
              </td>
              <td>
                hides a value. <em>Keep the ends</em> shows the first / last
                few characters and fills the middle (a value too short to
                keep anything of is filled entirely); <em>redact</em>{' '}
                replaces it with eight fill characters, whatever its length;{' '}
                <em>hash</em> replaces it with its SHA-256 (hex), optionally
                salted — stable, so the column still joins, dedupes and works
                as a key; <em>empty</em> sends <code>NULL</code> and keeps
                the column
              </td>
            </tr>
            <tr>
              <td>
                <strong>Convert type</strong>
              </td>
              <td>
                to text, number, whole number, true / false, date and time,
                or JSON. <code>&quot;yes&quot;</code>, <code>&quot;1&quot;</code>{' '}
                and <code>&quot;on&quot;</code> are true; a number of seconds
                or milliseconds since 1970 is a date
              </td>
            </tr>
            <tr>
              <td>
                <strong>Clean text</strong>
              </td>
              <td>trim, lower case, upper case</td>
            </tr>
            <tr>
              <td>
                <strong>Default value</strong>
              </td>
              <td>
                a value for when the source has none (typed in the builder
                for a numeric or boolean column, it is sent as a number or a
                boolean)
              </td>
            </tr>
            <tr>
              <td>
                <strong>Computed column</strong>
              </td>
              <td>
                a column built from a template over the others:{' '}
                <code>{'{{first_name}} {{last_name}}'}</code>.{' '}
                <code>{'{{$now}}'}</code> and <code>{'{{$table}}'}</code> are
                available. A template that is exactly one token copies that
                column with its type. A name the table does not have adds a
                column
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Steps run top to bottom and each one sees what the ones above it
        did, so &quot;lower-case the e-mail, then hash it&quot; is two steps
        in that order. They are declarative on purpose: there is no
        expression language and nothing is evaluated — a bridge&apos;s
        configuration runs inside the process that holds every stored
        credential.
      </p>
      <p>
        <strong>A value that cannot be converted</strong> (
        <code>&quot;n/a&quot;</code> to a number) is never decided quietly.
        Each conversion says what happens: <em>fail the delivery</em> (the
        default), <em>send it as empty</em>, or <em>leave it as it was</em>.
        A failed conversion fails the delivery before anything is sent, with
        the column and the value in the error — on a bridge set to{' '}
        <code>continue</code>, that one row goes to the{' '}
        <a href="#dead-letter-queue">dead-letter queue</a> and the rest carry
        on. A retry from there re-reads the row and runs the steps again, so
        fixing the value at the source is enough.
      </p>
      <p>What follows from changing values on the way:</p>
      <ul>
        <li>
          <strong>A table Syncle creates fits the new values.</strong> A
          hashed integer is text; a column converted to a date is a
          timestamp; a plain copy (<code>{'{{price}}'}</code>) is typed like
          the column it copies; a column a step can empty is nullable even
          when the source says <code>NOT NULL</code>; and the columns the
          steps add are created with the rest. The{' '}
          <a href="#dry-run">dry run</a> shows the planned
          column types, and the shaped sample rows, before anything exists.
          An existing table is never altered — its columns have to be able to
          hold what the steps produce.
        </li>
        <li>
          <strong>A masked key still works.</strong> A delete arrives with
          the source&apos;s plain key; the same steps are applied to it, so
          it finds the row that was written under the hash. Computed columns
          and defaults are not invented for a row that is being deleted.
        </li>
        <li>
          <strong>Delivery records hold the shaped row.</strong> A masked
          value does not reappear in the job timeline or in the payload
          Syncle keeps of an HTTP delivery.
        </li>
        <li>
          <strong>Masking protects the destination, not Syncle&apos;s own
          queue.</strong>{' '}
          A row set aside in the dead-letter queue is kept as the source has
          it — that is what lets a retry re-read and re-shape it. Anyone who
          can open Syncle can already browse the source.
        </li>
        <li>
          <strong>On PostgreSQL CDC</strong>, a large column that an update
          did not touch is not resent by the server. When a step needs such
          a column (a computed column that reads it), Syncle reads the row
          back from the source rather than compute from nothing.
        </li>
      </ul>
      <Note>
        The builder&apos;s live payload preview applies the steps to the
        sample row as you type. The one thing it cannot do is hash — it shows
        a stand-in — so use <strong>Dry run</strong> to see real hashed
        values.
      </Note>

      <h2 id="delivery-guarantees">Delivery guarantees</h2>
      <p>
        Database writes are idempotent upserts keyed by columns you choose,
        using each engine&apos;s atomic upsert: <code>ON CONFLICT</code> on
        Postgres and SQLite, <code>ON DUPLICATE KEY</code> on MySQL,{' '}
        <code>updateOne</code> with upsert on MongoDB. Delivery is
        at-least-once end to end, and the keyed upsert is what turns that
        into an exactly-once result — a replayed, retried or redelivered row
        overwrites itself instead of duplicating. On a CDC bridge, inserts,
        updates and deletes all propagate; a delete routes to a keyed delete
        on the target. Watch bridges only surface what polling can see —
        the table above says which strategy detects what, and none of them
        detects deletes.
      </p>
      <p>
        On relational targets a batch is written inside a transaction, so a
        retried batch is all-or-nothing. MongoDB and Redis have no
        transaction here; their retry safety comes from the per-row
        idempotent upsert and delete. Jobs checkpoint progress as they go,
        survive restarts, and auto-resume after a crash.
      </p>

      <h2 id="database-destinations">Database destinations</h2>
      <p>
        A database destination is a list of targets — one bridge can write to
        several at once. Each target is described by:
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Default</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>connectionId</code>
              </td>
              <td>required</td>
              <td>the destination connection</td>
            </tr>
            <tr>
              <td>
                <code>database</code>, <code>schema</code>
              </td>
              <td>optional</td>
              <td>where the table lives, when the engine has these levels</td>
            </tr>
            <tr>
              <td>
                <code>table</code>
              </td>
              <td>required</td>
              <td>target table or collection</td>
            </tr>
            <tr>
              <td>
                <code>writeMode</code>
              </td>
              <td>
                <code>upsert</code>
              </td>
              <td>
                <code>upsert</code> writes idempotently keyed by{' '}
                <code>keyColumns</code>; <code>insert</code> always appends
              </td>
            </tr>
            <tr>
              <td>
                <code>keyColumns</code>
              </td>
              <td>empty</td>
              <td>
                target columns that uniquely identify a row — required for
                upsert
              </td>
            </tr>
            <tr>
              <td>
                <code>mapping</code>
              </td>
              <td>empty = identity</td>
              <td>
                source→target column pairs; leave empty to map same-named
                columns
              </td>
            </tr>
            <tr>
              <td>
                <code>createMissingTable</code>
              </td>
              <td>
                <code>true</code>
              </td>
              <td>
                create the target table from the source&apos;s shape when it
                does not exist
              </td>
            </tr>
            <tr>
              <td>
                <code>onDelete</code>, <code>softDelete</code>
              </td>
              <td>
                <code>delete</code>
              </td>
              <td>
                what a delete at the source does to this target — see{' '}
                <a href="#delete-policy">below</a>
              </td>
            </tr>
            <tr>
              <td>
                <code>redis</code>
              </td>
              <td>none</td>
              <td>
                a target in Redis: how a row becomes a key — see{' '}
                <a href="#redis-targets">Rows in Redis</a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 id="redis-targets">Rows in Redis</h3>
      <p>
        Redis has no tables, so a target there says how a row becomes a{' '}
        <em>key</em>. Pick a Redis connection in the builder and the target
        card asks for exactly that:
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Default</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>redis.keyTemplate</code>
              </td>
              <td>required</td>
              <td>
                the key, built from the row&apos;s (target) columns:{' '}
                <code>{'user:{{id}}'}</code>,{' '}
                <code>{'tenant:{{tenant_id}}:user:{{id}}'}</code>. It has to
                contain at least one column, and only columns —{' '}
                <code>{'{{$now}}'}</code> is refused, because the same row has
                to be the same key every time
              </td>
            </tr>
            <tr>
              <td>
                <code>redis.type</code>
              </td>
              <td>
                <code>hash</code>
              </td>
              <td>
                <code>hash</code>: a field per column, so{' '}
                <code>HGETALL</code> gives the row back. A <code>NULL</code>{' '}
                column is a field that is not there, and fields your
                application adds beside the row&apos;s are left alone.{' '}
                <code>json</code>: the whole row as one JSON document in a
                string (<code>NULL</code>s included). <code>string</code>: one
                column&apos;s value
              </td>
            </tr>
            <tr>
              <td>
                <code>redis.valueColumn</code>
              </td>
              <td>—</td>
              <td>
                <code>string</code> only: the column whose value is stored
              </td>
            </tr>
            <tr>
              <td>
                <code>redis.ttlSeconds</code>
              </td>
              <td>never</td>
              <td>
                the key expires this long after its <em>last</em> write — every
                update renews it. Without it the key does not expire (an
                expiry it had is removed)
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        The columns in the key are the target&apos;s key columns — you do not
        pick them separately. So a delete at the source removes that key (or
        leaves it, with <code>onDelete: ignore</code>; a key cannot be{' '}
        <em>marked</em> deleted, so <code>soft</code> is refused), an{' '}
        <code>UPDATE</code> that changes a key column moves the row to its new
        key and removes the old one, and a row that has no value for a key
        column fails — by name — instead of landing under half a key. A key
        that already exists as another type is replaced.
      </p>
      <p>
        Values are kept as text, as Redis keeps everything: numbers as their
        digits, booleans as <code>true</code>/<code>false</code>, a JSON
        column as its JSON, binary as the bytes themselves (in a JSON
        document: base64), and a moment in time as ISO-8601 in UTC —{' '}
        <code>2026-03-01T10:20:30.123000Z</code>, to the microsecond the
        source keeps — which is what date parsers take.
      </p>
      <Note>
        <p>
          A Redis target <em>without</em> a <code>redis</code> block works as
          it always did: the row has to carry a column named <code>key</code>{' '}
          and one named <code>value</code> (rename them in the mapping), and
          the value is stored as a string. That is also what a bridge from
          Redis <em>to</em> Redis uses — and there a hash arrives as a hash, a
          list as a list, a set as a set and a sorted set as one, each with
          the time it has left to live. A Redis stream cannot be copied as a
          row, and says so.
        </p>
      </Note>

      <h3 id="delete-policy">When a row is deleted at the source</h3>
      <p>
        A live bridge that captures deletes applies them, and each target
        says how — so one bridge can keep a working copy in step and feed an
        archive that never forgets:
      </p>
      <ul>
        <li>
          <strong>Delete it here too</strong> (<code>delete</code>, the
          default): a keyed delete.
        </li>
        <li>
          <strong>Keep it, and mark it as deleted</strong> (<code>soft</code>
          ): the row stays, and a column of the target —{' '}
          <code>softDelete.column</code>, <code>deleted_at</code> by default
          — is set to the time of the delete, or to <code>true</code> with{' '}
          <code>softDelete.value: &quot;boolean&quot;</code>. Every ordinary
          write sets it back to <code>NULL</code> / <code>false</code>, so a
          row that comes back at the source under the same key is unmarked by
          the write that brings it back. The marker is a column of its own:
          not a key, not one that receives source data. Syncle creates it
          with the table when it creates the table; an existing table has to
          have it already — the <a href="#dry-run">dry run</a> says so when
          it does not — because an existing table is never altered.
        </li>
        <li>
          <strong>Do nothing</strong> (<code>ignore</code>): the target keeps
          every row it was ever sent.
        </li>
      </ul>
      <p>
        A <code>TRUNCATE</code> (PostgreSQL sources, opt-in) empties only the
        targets that delete; a soft-delete or ignore target is left as it is,
        and the delivery&apos;s summary says so per target. A target with no
        key columns (append-only <code>insert</code> mode) has nothing to
        find a row by, so deletes are never applied to it, whatever the
        policy. Polling (watch) bridges cannot see deletes at all.
      </p>

      <h3 id="type-translation">How column types are translated</h3>
      <p>
        An auto-created table takes <code>keyColumns</code> as its NOT NULL
        primary key, nothing auto-increment, and every other column typed
        from the source. Between two instances of the <em>same</em> engine
        the source&apos;s own type is reused word for word —{' '}
        <code>numeric(38,10)</code> stays <code>numeric(38,10)</code>,{' '}
        <code>timestamp(3) with time zone</code> stays exactly that — so a
        same-engine copy narrows nothing. (The exception is a type that lives
        in one database only, such as a Postgres enum or domain: a domain
        becomes the base type it wraps, an enum becomes text.)
      </p>
      <p>
        Across engines each type is read in the <em>source</em> engine&apos;s
        dialect — <code>float</code> is single precision in MySQL and double
        in Postgres, <code>timestamp</code> means different things in each —
        and rendered as the closest type the target has:
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Source column</th>
              <th>→ PostgreSQL</th>
              <th>→ MySQL</th>
              <th>→ SQLite</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>exact decimal, <code>numeric(p,s)</code></td>
              <td>
                <code>NUMERIC(p,s)</code>
              </td>
              <td>
                <code>DECIMAL(p,s)</code>, up to (65,30)
              </td>
              <td>
                <code>DECIMAL(p,s)</code> to 15 digits, text beyond
              </td>
            </tr>
            <tr>
              <td>
                64-bit and unsigned integers (<code>bigint unsigned</code>)
              </td>
              <td>
                <code>BIGINT</code> / <code>NUMERIC(20,0)</code>
              </td>
              <td>as declared</td>
              <td>
                <code>INTEGER</code> / text
              </td>
            </tr>
            <tr>
              <td>
                boolean, MySQL <code>tinyint(1)</code> and <code>bit(1)</code>
              </td>
              <td>
                <code>BOOLEAN</code>
              </td>
              <td>
                <code>TINYINT(1)</code>
              </td>
              <td>
                <code>INTEGER</code>
              </td>
            </tr>
            <tr>
              <td>
                bytes (<code>bytea</code>, <code>blob</code>, <code>binary</code>)
              </td>
              <td>
                <code>BYTEA</code>
              </td>
              <td>
                <code>LONGBLOB</code>
              </td>
              <td>
                <code>BLOB</code>
              </td>
            </tr>
            <tr>
              <td>unbounded text</td>
              <td>
                <code>TEXT</code>
              </td>
              <td>
                <code>LONGTEXT</code> (MySQL&apos;s <code>TEXT</code> stops at
                64 KB)
              </td>
              <td>
                <code>TEXT</code>
              </td>
            </tr>
            <tr>
              <td>wall-clock timestamp (no zone)</td>
              <td>
                <code>TIMESTAMP</code>
              </td>
              <td>
                <code>DATETIME(6)</code>
              </td>
              <td>text</td>
            </tr>
            <tr>
              <td>
                instant (<code>timestamptz</code>, a MongoDB date)
              </td>
              <td>
                <code>TIMESTAMPTZ</code>
              </td>
              <td>
                <code>DATETIME(6)</code>, as UTC
              </td>
              <td>ISO-8601 text, UTC</td>
            </tr>
            <tr>
              <td>JSON, arrays, nested documents</td>
              <td>
                <code>JSONB</code>; a Postgres array stays an array
              </td>
              <td>
                <code>JSON</code>
              </td>
              <td>JSON text</td>
            </tr>
            <tr>
              <td>
                <code>uuid</code> / MongoDB <code>ObjectId</code>
              </td>
              <td>
                <code>UUID</code> / <code>VARCHAR(24)</code>
              </td>
              <td>
                <code>CHAR(36)</code> / <code>CHAR(24)</code>
              </td>
              <td>text</td>
            </tr>
            <tr>
              <td>
                enum, set, geometry, anything Syncle does not recognise
              </td>
              <td colSpan={3}>text, with a warning</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        MongoDB has no declared types, so a field&apos;s type is sampled from
        its documents — all of the sample, not just the first, so a field
        that starts out <code>null</code> still gets its real type, and one
        that holds both numbers and strings is stored as text.
      </p>
      <p>
        <strong>A narrowing is never silent.</strong> Whenever the target
        cannot hold everything the source column can — a time zone MySQL has
        nowhere to put, a precision beyond MySQL&apos;s 65 digits, a key
        column that had to be bounded to <code>VARCHAR(255)</code>, an enum
        carried as text — the column is named in a warning. The preview
        (<code>POST /api/bridges/:id/preview</code>) lists the exact columns a
        run would create and those warnings <em>before</em> anything runs,
        and the same warnings are logged when the table is created. If a
        default is not what you want, create the table yourself: an existing
        table is never altered.
      </p>

      <h3 id="dry-run">See it before it happens</h3>
      <p>
        The builder&apos;s <strong>Dry run</strong> button shows what the
        bridge would do as it is set up right now, before it is saved: for
        each database target, whether the table exists and — if a run would
        create it — the table column by column, with the source&apos;s type
        beside the type it becomes; every column the target cannot hold
        faithfully, as a warning; and a few real rows from the source as they
        would be written (or, for an HTTP destination, the rendered payloads
        with the auth secret redacted). Nothing is saved, no table is
        created, and nothing is delivered. The same check is available for a
        saved bridge from the API — see the{' '}
        <a href="/docs/api">preview endpoints</a>.
      </p>

      <h3 id="value-fidelity">Values arrive as the values they were</h3>
      <p>
        The right column type is half of it; the drivers on either side also
        have to agree on what a value <em>is</em>. Syncle reads values in the
        form that loses nothing and converts only where the target needs it:
      </p>
      <ul>
        <li>
          Postgres dates and timestamps are read as the text Postgres sends,
          not as JavaScript dates — so microseconds survive (every{' '}
          <code>now()</code>-stamped column has them), and a wall-clock{' '}
          <code>timestamp</code> cannot shift by the server&apos;s time zone.
          An instant is written to MySQL and SQLite as its UTC reading.
        </li>
        <li>
          Exact numbers stay text end to end: Postgres <code>numeric</code>{' '}
          and <code>bigint</code>, MySQL <code>DECIMAL</code> and{' '}
          <code>BIGINT</code> (from the binlog too), SQLite 64-bit integers,
          MongoDB <code>Decimal128</code> and <code>Long</code>.
        </li>
        <li>
          MongoDB&apos;s wrapper types become plain values at every depth of
          a document: an <code>ObjectId</code> its hex string, a binary
          bytes, a UUID its canonical string.
        </li>
        <li>
          A MySQL zero date (<code>0000-00-00</code>) is MySQL&apos;s
          &quot;no date&quot; and becomes <code>NULL</code> in any other
          engine. A <code>tinyint(1)</code> or <code>bit(1)</code> becomes a
          real boolean.
        </li>
        <li>
          JSON keeps its shape into Postgres whatever it holds: an empty
          array stays an array, and the JSON string{' '}
          <code>&quot;123&quot;</code> stays a string.
        </li>
      </ul>
      <p>
        A row reads the same whether it arrived by replay or by CDC — the two
        are tested against each other on real engines, under more than one
        server time zone. One thing cannot be told apart: a JSON{' '}
        <code>null</code> inside a Postgres json column reads the same as SQL{' '}
        <code>NULL</code>, and is written as <code>NULL</code>.
      </p>
      <Note>
        <code>insert</code> mode appends on every delivery, so a retry or a
        second replay can write the same row twice. The idempotency guarantee
        belongs to <code>upsert</code> with <code>keyColumns</code> — prefer
        it unless the target really is an append-only log.
      </Note>

      <h2 id="http-destinations">HTTP destinations</h2>
      <p>
        Instead of a database, a bridge can POST, PUT or PATCH each row (or
        batch) to a URL, with optional headers and auth — none, a bearer
        token, or a custom header, with secrets encrypted at rest. An
        optional idempotency toggle adds an <code>Idempotency-Key</code>{' '}
        header derived from the job id plus a stable per-delivery identity —
        the delivery sequence on a replay, the row&apos;s key on a watch
        bridge, the change cursor on CDC — so a redelivery always carries the
        same key and the receiver can dedupe it.
      </p>
      <p>
        The request body comes from a JSON template with tokens. The default
        template is <code>{'"{{$row}}"'}</code> — the whole projected row:
      </p>
      <CodeBlock title="Payload template">{`{
  "event": "row.changed",
  "op": "{{$op}}",
  "row": "{{$row}}",
  "sent_at": "{{$now}}"
}`}</CodeBlock>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Token</th>
              <th>Resolves to</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>{'{{column}}'}</code>
              </td>
              <td>the value of that source column</td>
            </tr>
            <tr>
              <td>
                <code>{'{{$row}}'}</code>
              </td>
              <td>
                the projected row object, after the optional fields whitelist
                and rename map
              </td>
            </tr>
            <tr>
              <td>
                <code>{'{{$table}}'}</code>
              </td>
              <td>the source table name</td>
            </tr>
            <tr>
              <td>
                <code>{'{{$op}}'}</code>
              </td>
              <td>
                the change operation — insert, update or delete (or truncate,
                where a PostgreSQL bridge captures it) — set on CDC deliveries
              </td>
            </tr>
            <tr>
              <td>
                <code>{'{{$now}}'}</code>
              </td>
              <td>an ISO timestamp, captured once per delivery</td>
            </tr>
            <tr>
              <td>
                <code>{'{{$index}}'}</code>
              </td>
              <td>the 0-based row index across the whole job</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Substitution happens on the parsed JSON tree, never by string
        splicing, so a value containing quotes or newlines cannot break the
        JSON and nothing in a row is ever executed. A string that is exactly
        one token keeps the value&apos;s real type —{' '}
        <code>{'"{{$row}}"'}</code> becomes the object itself, not a string —
        while a token mixed into other text is stringified. Unresolved tokens
        surface as warnings, never as failures. Outbound requests never
        follow redirects; the rest of the destination security posture is on
        the <a href="/docs/self-hosting">self-hosting page</a>.
      </p>

      <h2 id="tuning">Delivery tuning</h2>
      <p>
        Every bridge carries the same set of delivery knobs. Three of them —{' '}
        <code>maxAttempts</code>, <code>backoffMs</code> and{' '}
        <code>timeoutMs</code> — govern HTTP deliveries only: a database write
        is a single attempt, and its retry safety comes from the keyed upsert
        plus the job-level retry controls. The rest apply to both destination
        kinds.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Knob</th>
              <th>Range</th>
              <th>Default</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>batchSize</code>
              </td>
              <td>1–1000</td>
              <td>1</td>
              <td>
                rows per delivery on replay jobs, and per request for a CDC
                bridge with an HTTP destination; watch delivers one row at a
                time
              </td>
            </tr>
            <tr>
              <td>
                <code>maxAttempts</code>
              </td>
              <td>1–10</td>
              <td>3</td>
              <td>total attempts per HTTP delivery; 1 means no retry</td>
            </tr>
            <tr>
              <td>
                <code>backoffMs</code>
              </td>
              <td>0–60000</td>
              <td>500</td>
              <td>
                base retry backoff, doubling each retry up to{' '}
                <code>backoffMaxMs</code> (default 30000)
              </td>
            </tr>
            <tr>
              <td>
                <code>minDelayMs</code>
              </td>
              <td>0–600000</td>
              <td>0</td>
              <td>minimum delay between deliveries (replay and watch)</td>
            </tr>
            <tr>
              <td>
                <code>timeoutMs</code>
              </td>
              <td>100–120000</td>
              <td>15000</td>
              <td>per-request timeout on HTTP deliveries</td>
            </tr>
            <tr>
              <td>
                <code>pageSize</code>
              </td>
              <td>1–1000</td>
              <td>200</td>
              <td>rows fetched per page from a table source</td>
            </tr>
            <tr>
              <td>
                <code>onError</code>
              </td>
              <td>
                <code>continue</code> | <code>abort</code>
              </td>
              <td>
                <code>abort</code>
              </td>
              <td>
                what a failed delivery does — stop without moving past it, or
                set the failed rows aside and carry on. See{' '}
                <a href="#when-a-delivery-fails">When a delivery fails</a>
              </td>
            </tr>
            <tr>
              <td>
                <code>onSchemaChange</code>
              </td>
              <td>
                <code>stop</code> | <code>evolve</code> |{' '}
                <code>continue</code>
              </td>
              <td>
                <code>stop</code>
              </td>
              <td>
                what happens when the source table is no longer the one the
                bridge was built on. See{' '}
                <a href="#schema-changes">When the source table changes</a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="when-a-delivery-fails">When a delivery fails</h2>
      <p>
        One rule sits under everything here: a row Syncle has read is always
        in one of three places — the destination, the bridge&apos;s{' '}
        <strong>dead-letter queue</strong>, or still ahead of the
        bridge&apos;s cursor, where it will be read again. It is never in
        none of them. That matters most on a CDC bridge, because a change
        stream is read once: when Syncle confirms a position, the source is
        free to discard everything before it, and a row that was stepped over
        cannot be fetched a second time.
      </p>
      <p>
        <code>onError</code> picks between the two ways of honouring that
        rule.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>
                <code>onError</code>
              </th>
              <th>On a failed delivery</th>
              <th>Choose it when</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>abort</code>
                <br />
                the default when a bridge is created through the API without
                saying
              </td>
              <td>
                the bridge stops <em>at</em> the failure, cursor untouched. A
                live bridge pauses and a replay job fails, each with the
                reason. Start it again and the same rows are retried into the
                same timeline cell.
              </td>
              <td>
                the destination must never run ahead of a row it is missing,
                and someone will notice a stopped bridge
              </td>
            </tr>
            <tr>
              <td>
                <code>continue</code>
              </td>
              <td>
                the bridge keeps going. On a live bridge the rows that failed
                are first written, complete, to the dead-letter queue — only
                then does the cursor move.
              </td>
              <td>
                one bad row should not hold up every row behind it. This is
                what the web app&apos;s builder pre-selects; the choice is on
                the form either way
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 id="dead-letter-queue">The dead-letter queue</h3>
      <p>
        A database batch is a single transaction, so one row the destination
        refuses — a value a constraint rejects, a type it cannot hold — fails
        every row that shared its batch. Under <code>continue</code> Syncle
        does not set the whole batch aside: it splits it and re-delivers the
        halves, again and again, until each failure is pinned to a single
        row. The healthy rows land; only the rows actually at fault are
        queued. (Finding one bad row among a hundred thousand costs a few
        dozen attempts, not a hundred thousand.) An HTTP destination is not
        split — there the batch <em>is</em> the payload the receiver sees —
        so the failed request is queued whole, and the same goes for a target
        in <code>insert</code> mode, where re-delivering rows would append
        them twice.
      </p>
      <p>
        An entry holds the source row exactly as it was read: never
        truncated, with bytes, timestamps and 64-bit integers preserved.
        Retrying it is safe while the bridge is still streaming, because a
        retry does not replay the recording. For a database destination fed
        from a table with a primary key, Syncle looks the row up at the
        source again and writes what is there <em>now</em>: the current row
        if it exists, a delete if it is gone, nothing if it has since left
        the bridge&apos;s filters. Replaying an hours-old payload could
        overwrite a newer version the stream has delivered in the meantime;
        re-reading cannot. The recording itself is sent only where that is
        the right thing — to HTTP destinations, to append-only{' '}
        <code>insert</code> targets, and for sources with no primary key to
        look a row up by.
      </p>
      <p>
        One case cannot be settled automatically: the source row is gone, and
        the bridge does not propagate deletes (a watch bridge, or a CDC
        bridge with deletes switched off). The recording might be the newest
        version of that row or an outdated one, and nothing can tell which,
        so the entry waits. Retry it with <code>force</code> to write the
        recording anyway, or discard it.
      </p>
      <p>
        When every row from a failed delivery has been delivered, its
        timeline cell turns green and the job&apos;s counters follow.
        Discarded rows leave the cell red — they never arrived.
      </p>

      <h3 id="when-continue-stops">When continue stops anyway</h3>
      <p>
        <code>continue</code> is for bad rows, not for a broken destination.
        If the target is unreachable or its table is gone, <em>every</em> row
        fails, and carrying on would simply pour the change stream into the
        queue. So a <code>continue</code> bridge still stops — cursor
        untouched, nothing lost, the reason on the job — when:
      </p>
      <ul>
        <li>
          splitting a failed batch shows the failure is not confined to a few
          rows (nothing at all succeeds, or more than 100 rows of one batch
          are bad);
        </li>
        <li>
          several batches in a row deliver nothing (
          <code>SYNCLE_MAX_CONSECUTIVE_FAILURES</code>, default 5);
        </li>
        <li>
          the queue is full (<code>SYNCLE_DEAD_LETTER_MAX_ROWS</code>, default
          10,000 waiting rows per bridge);
        </li>
        <li>the failed rows could not be written to the queue.</li>
      </ul>
      <p>
        Fix the destination, start the bridge again, and retry whatever was
        queued before it stopped.
      </p>
      <Note>
        <p>
          A replay job does not use the queue. Its source is a table that is
          still there, so its failed rows are re-read from it:{' '}
          <em>Retry failed</em> re-streams exactly those rows.
        </p>
      </Note>

      <h2 id="verify">Verify and reconcile</h2>
      <p>
        A bridge that has streamed for a month has delivered millions of
        changes, each of them green. That is evidence the pipe works — not that
        the two ends agree. A row edited by hand at the destination, a delete
        that happened while the bridge was paused past the source&apos;s log, a
        target restored from last week&apos;s backup: none of those is a failed
        delivery. <strong>Verify</strong> (the magnifier on a bridge&apos;s
        page, or <code>POST /api/bridges/:id/verify</code>) looks:
      </p>
      <ol>
        <li>
          the source is read once, a page at a time. Each page is turned into
          the rows the bridge <em>would</em> write — same filters, column
          transforms, value conversion and mapping, by the code that writes
          them — and the destination is asked for the rows with those keys.
          That finds what is <strong>missing</strong> and what is{' '}
          <strong>different</strong>;
        </li>
        <li>
          the destination is read once, and the source asked for <em>its</em>{' '}
          keys. That finds what is <strong>only in the destination</strong>.
        </li>
      </ol>
      <p>
        Values are compared by what kind of value the column holds, not as
        text: a numeric that one driver hands over as <code>&apos;1.50&apos;</code>{' '}
        and another as <code>1.5</code> is the same number, a{' '}
        <code>timestamptz</code> is the same instant in any zone&apos;s
        spelling, <code>jsonb</code> is the same document whatever its key
        order. A TEXT key is never read as a number (<code>007</code> and{' '}
        <code>7</code> are two rows). What is <em>not</em> forgiven is a
        destination column narrower than the source — fewer decimals, no
        fractional seconds: those rows are different, and saying so is the
        point. A computed column that uses <code>{'{{$now}}'}</code> can never
        be the same twice and is left out, with a note.
      </p>
      <p>
        <strong>A bridge that is delivering is a moving target.</strong> A row
        read a moment before its change arrives looks different, and is not. So
        nothing counts at first sight: what looks wrong is read again from both
        ends a little later (<code>SYNCLE_VERIFY_RECHECK_MS</code>, default
        1.5 s), and only what is still wrong is reported.
      </p>
      <p>
        <strong>Reconcile</strong> does the same and writes the rows that are
        missing or different — from the source as it is at that second look,
        through the bridge&apos;s own sink, and checks once more that the repair
        was not overtaken by the stream. Rows that are only in the destination
        are removed <em>only</em> when you tick the box (
        <code>deleteExtra</code>), and then the way the target&apos;s{' '}
        <a href="#delete-policy">delete policy</a> says: deleted, or marked.
        For a target that ignores deletes they are not even looked for — they
        are what such a target is for.
      </p>
      <Note>
        <p>
          What can be verified: a bridge that reads a <em>table</em> and writes
          to PostgreSQL, MySQL/MariaDB, SQLite or MongoDB targets that have key
          columns. An HTTP endpoint cannot be read back, a Redis destination
          cannot be asked for rows by key, and an insert-only target has
          nothing to find a row by — each says so instead of guessing. A
          verification costs two full reads and runs in the background, one per
          bridge at a time; the result, with up to 25 examples of each kind of
          difference and both readings of every column that differs, is kept
          for the last ten.
        </p>
      </Note>

      <h2 id="schema-changes">When the source table changes</h2>
      <p>
        A bridge is built against the columns a table has on the day it is
        built, and the table goes on living. Syncle keeps the columns the
        bridge was built for — recorded when the bridge is created, and again
        every time it is saved — and compares them with the table before a
        run starts, when a live bridge starts, and — on a live bridge and
        during a replay alike — the moment a row arrives whose columns are not
        the ones the row before it had. A{' '}
        <a href="#dead-letter-queue">dead-letter retry</a> asks first as well:
        it re-reads rows from the source, and is refused while the answer is
        “a column this bridge uses is gone”.
      </p>
      <p>Two very different things can have happened:</p>
      <ul>
        <li>
          <strong>A column the bridge uses is gone</strong> — dropped, or
          renamed, which to a catalog is the same thing. “Uses” means: mapped by
          name to a destination column, a key of a target with no mapping,
          filtered or sorted by, read by a column transform, polled by, pinned
          in an HTTP payload&apos;s field list, or named in its template (
          <code>{'{{email}}'}</code>). Every row from then on has no value for
          it, and an upsert would write <code>NULL</code> over the value the
          destination holds, row by row, every delivery green. So the bridge{' '}
          <strong>stops before that write</strong>: the job fails with the
          column&apos;s name, the row is not delivered and not skipped (a live
          bridge reads it again when it next starts), and the destination is
          exactly as it was.
        </li>
        <li>
          <strong>Anything else</strong> — a column added, a type changed, a
          column the bridge never touched dropped. The bridge carries on. Its
          page shows what changed, with an <em>Accept</em> button, because a
          copy that is now narrower than its original is worth knowing about.
        </li>
      </ul>
      <p>
        The way out of a stop is to edit the bridge: re-map the column to its
        new name, or remove it. Saving a bridge that no longer uses a missing
        column accepts the table as it is now. Saving it <em>unchanged</em>{' '}
        does not, and neither does <em>Accept</em> — there is deliberately no
        button that turns the protection off for one column.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>
                <code>onSchemaChange</code>
              </th>
              <th>A used column is gone</th>
              <th>A column was added</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>stop</code> (default)
              </td>
              <td>stops before writing; critical alert</td>
              <td>noted on the bridge; warning alert; not copied</td>
            </tr>
            <tr>
              <td>
                <code>evolve</code>
              </td>
              <td>stops before writing; critical alert</td>
              <td>
                added to every destination table that Syncle creates{' '}
                <em>and</em> fills without a column mapping — typed by the same
                map an auto-created table uses, always nullable. A target
                whose columns you chose is left alone. Nothing is ever dropped
                or retyped at the destination
              </td>
            </tr>
            <tr>
              <td>
                <code>continue</code>
              </td>
              <td>
                carries on, writing <code>NULL</code> for the column — the
                behaviour before this setting existed; warning alert
              </td>
              <td>noted on the bridge; warning alert; not copied</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Each change is said once — in the log, and to every{' '}
        <a href="/docs/self-hosting#alerts">alert channel</a> subscribed to{' '}
        <em>a source table changes under a bridge</em> — not once per batch.
      </p>
      <Note>
        <p>
          This applies to sources that have a schema: PostgreSQL, MySQL/MariaDB
          and SQLite tables. A MongoDB collection&apos;s or a Redis keyspace&apos;s
          “columns” are whatever the last documents happened to hold, so there
          is nothing to compare, and a saved-query source has no table to look
          at.
        </p>
      </Note>

      <h2 id="job-lifecycle">Job lifecycle and control</h2>
      <p>A job moves through these statuses:</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>draft</code>
              </td>
              <td>prepared in the UI, not sending yet</td>
            </tr>
            <tr>
              <td>
                <code>queued</code>
              </td>
              <td>waiting in the job queue</td>
            </tr>
            <tr>
              <td>
                <code>running</code>
              </td>
              <td>streaming and delivering rows</td>
            </tr>
            <tr>
              <td>
                <code>completed</code>
              </td>
              <td>ran to the end of the source</td>
            </tr>
            <tr>
              <td>
                <code>failed</code>
              </td>
              <td>
                stopped on an error — on a replay job,{' '}
                <code>onError: abort</code> lands here on the first failed
                delivery; a live watch or CDC bridge pauses instead, keeping
                its cursor
              </td>
            </tr>
            <tr>
              <td>
                <code>canceling</code>, <code>canceled</code>
              </td>
              <td>cancel requested, then done</td>
            </tr>
            <tr>
              <td>
                <code>paused</code>
              </td>
              <td>
                stopped — by you, or by a failure on a live bridge (the reason
                is on the job). Resumable in place, as the same job, from the
                same cursor
              </td>
            </tr>
            <tr>
              <td>
                <code>interrupted</code>
              </td>
              <td>
                a legacy status you may see on old jobs, resumable by hand. A
                job cut off by a crash keeps its <code>queued</code> or{' '}
                <code>running</code> status and is re-enqueued from its
                checkpoint at the next boot
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Control is in-place: you can cancel a job, resume a paused or
        interrupted one, skip queued deliveries by range or selection, or
        retry only the failed rows — the retry re-queues the same job and
        re-sends just its failed delivery cells, which flip to success in
        place. On a live bridge the failed rows are in its dead-letter queue,
        and <em>Retry failed</em> retries that instead, without stopping the
        bridge. A replay that had <strong>stopped</strong> at a failure (on
        failure: abort, the default) does not end there: once the failed
        delivery has gone through, it carries on from where it stopped, with
        the bridge as it is configured now — the rows after the failure were
        never read, and <em>completed</em> has to mean them too. A single
        failed delivery can be retried on its own from its detail panel, a
        job&apos;s failures can be downloaded as CSV or NDJSON (the rows&apos;
        keys, the error, the payload that was sent), and a bridge with more
        than one run shows them as a strip above the timeline — green for a
        clean run, amber for one that finished with failed deliveries, red
        for one a failure stopped. All of these are also plain endpoints,
        documented on the <a href="/docs/api">HTTP API page</a>; reading the
        delivery timeline is covered in the{' '}
        <a href="/docs/quickstart">quickstart</a>.
      </p>

      <h2 id="export-import">Duplicate, export, import</h2>
      <p>
        <strong>Duplicate</strong> makes a copy of a bridge under a new name,
        in the same workspace — credential and all, since it never leaves
        the instance. The copy has no job and no position: a copy of a live
        bridge starts from scratch when it is started.
      </p>
      <p>
        <strong>Export</strong> downloads a bridge (or, from the API, a whole
        workspace) as a JSON document: to keep in version control, to move
        from staging to production, to hand to a colleague. What travels is
        configuration — source, filters, transforms, targets, delete policy,
        delivery, trigger. What never does is anything secret:
      </p>
      <ul>
        <li>
          an HTTP destination&apos;s token or header value leaves{' '}
          <em>empty</em>. A bridge imported without its credential arrives
          switched off, and says why;
        </li>
        <li>
          a connection is a reference — its id, with its name and engine
          beside it. Where it points, and as whom, is not part of a bridge and
          is not exported.
        </li>
      </ul>
      <p>
        <strong>Import</strong> has to find this instance&apos;s connections
        for the ones the file talks about: the same id (a re-import where it
        came from), else the only connection here with that name and engine.
        When neither settles it, Syncle asks — listing your connections of
        that engine — and creates nothing until every one is decided: half an
        import is worse than none. Names that are taken get{' '}
        <code>(imported)</code> appended.
      </p>

      <h2 id="fan-out-and-chaining">Fan-out and chaining</h2>
      <p>
        Because a database destination is a list of targets, one bridge can
        fan a source out to several databases at once — each target with its
        own mapping, write mode and key columns. And because any connection
        can sit on either end, bridges chain: database A feeds B, and a
        second bridge watches B and feeds C.
      </p>

      <h3 id="two-way">Two-way sync, and rings</h3>
      <p>
        Two live bridges can feed each other — A → B plus B → A — and keep
        two tables in step in both directions. Left to itself that arrangement
        never rests: A&apos;s change is written to B, which B&apos;s change
        log reports, which the other bridge writes to A, which A&apos;s log
        reports… On PostgreSQL an upsert of identical values is still a logged
        change, so one <code>INSERT</code> by a person went back and forth
        about nine times a second for as long as both bridges ran.
      </p>
      <p>
        Syncle stops it by knowing its own writes. When a bridge writes to a
        table that another <em>listening</em> bridge reads, what it is about
        to write is remembered — per table, per row, in order — in
        Syncle&apos;s own Redis. The bridge that reads that table looks every
        change up there; one that matches is this instance&apos;s own write
        coming back, and:
      </p>
      <ul>
        <li>
          <strong>A pair</strong> (A ⇄ B): the change crosses once and is not
          sent back. Inserts, updates, deletes and mirrored{' '}
          <code>TRUNCATE</code>s alike.
        </li>
        <li>
          <strong>A chain</strong> (A → B → C) keeps working: a recognised
          change remembers which tables it has been through, and is only kept
          from going <em>back</em> to one of them. B&apos;s bridge to C passes
          on exactly the rows A&apos;s bridge wrote.
        </li>
        <li>
          <strong>A ring</strong> (A → B → C → A) stops where it began,
          whichever table the change was made in.
        </li>
      </ul>
      <p>
        It needs nothing from the source — no replication origins, no marker
        columns, no triggers — and works across engines and for polling
        (watch) bridges as well as CDC. Values are compared as what they{' '}
        <em>are</em> (<code>12.50</code>, <code>&apos;12.5&apos;</code> and{' '}
        <code>12.5</code> are one number), the same way{' '}
        <a href="#verify">Verify</a> compares them. A bridge that is tied to
        another says so on its page, names it, and counts the changes it held
        back.
      </p>
      <p>
        Two more things follow from it. Before writing to such a table the
        bridge looks at what is there, and{' '}
        <strong>
          a row that is already exactly what it would be set to is not
          written
        </strong>{' '}
        (the delivery says{' '}
        <code>wrote 0 (3 already up to date, not written)</code>). That is
        also the safety net: a change that is <em>not</em> recognised — the
        memory of it expired because the reading bridge was further behind
        than <code>SYNCLE_ECHO_TTL_SECONDS</code> (default 5 minutes) — is
        sent on, finds the other side already up to date, writes nothing, and
        the loop dies by itself one hop later. That look does not go through
        Redis, so it holds while Redis is away too. And none of this costs
        anything for a bridge whose destination nobody reads: no look before
        the write, nothing kept in Redis.
      </p>
      <p>
        What is remembered is a row of yours, so it is kept the way your
        connection passwords are: encrypted under the{' '}
        <a href="/docs/self-hosting#master-key">master key</a>, used up the
        moment the change comes back, and gone after{' '}
        <code>SYNCLE_ECHO_TTL_SECONDS</code> if it never does. Large values (a
        document, a file in a column) are remembered by their SHA-256 only.
      </p>
      <p>What it does not do:</p>
      <ul>
        <li>
          <strong>Resolve conflicts.</strong> If the same row is edited on
          both sides within the same moment, each edit crosses to the other
          side and the two tables can end up holding each other&apos;s value.
          Nothing loops, and nothing is flagged as failed — run{' '}
          <a href="#verify">Verify</a> on a schedule if that matters, and let
          one side own each row where you can.
        </li>
        <li>
          <strong>
            See through columns the database changes on every write.
          </strong>{' '}
          A trigger that stamps <code>updated_at = now()</code> on both sides
          makes every copy differ from what was written, so it is never
          recognised and each hop changes the row again. Leave such columns
          out of the mapping (both bridges), or let only the application set
          them.
        </li>
        <li>
          <strong>Know about writers that are not Syncle.</strong> A loop
          through a webhook and somebody else&apos;s code (A → HTTP → their
          service → B → A) is theirs to break.
        </li>
      </ul>

      <h2 id="workspaces">Workspaces</h2>
      <p>
        Workspaces are the top-level container: every connection and bridge
        belongs to one. A default workspace always exists, so the concept
        stays invisible until you create a second one. Deleting a workspace
        tears down everything in it — CDC slots dropped, watchers stopped,
        in-flight jobs canceled — before the delete cascades.
      </p>
    </DocArticle>
  );
}
