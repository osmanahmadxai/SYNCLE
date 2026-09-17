import { CodeBlock } from '@/components/docs/code-block';
import { DocArticle, docMetadata } from '@/components/docs/doc-article';
import { Note } from '@/components/docs/note';

export const metadata = docMetadata('cdc');

export default function Page() {
  return (
    <DocArticle slug="cdc">
      <p>
        A bridge with the CDC trigger streams changes out of the source
        database&apos;s own change log the moment they commit — no polling.
        Each engine captures changes a different way and each has
        prerequisites Syncle cannot always set up for you. This page lists
        them per engine, shows what Syncle provisions itself, and states the
        limits plainly.
      </p>

      <p>
        The alternative for live syncing is a <strong>watch</strong> bridge,
        which polls the source on a cursor and works on every engine —
        including the two cases where CDC falls short: SQLite has no change
        log at all, and the Redis change feed is not durable. The trigger
        modes are compared on <a href="/docs/bridges">How bridges work</a>.
      </p>

      <h2 id="per-engine">Per-engine prerequisites</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Engine</th>
              <th>Mechanism</th>
              <th>You configure</th>
              <th>Syncle provisions</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>PostgreSQL</td>
              <td>Logical replication (pgoutput)</td>
              <td>
                <code>wal_level=logical</code>, a role with{' '}
                <code>REPLICATION</code>
              </td>
              <td>Publication and replication slot, per bridge</td>
            </tr>
            <tr>
              <td>MySQL</td>
              <td>Row-based binlog</td>
              <td>
                <code>log_bin=ON</code>, <code>binlog_format=ROW</code>,{' '}
                <code>binlog_row_image=FULL</code>, replication grants
              </td>
              <td>Nothing — the binlog already exists</td>
            </tr>
            <tr>
              <td>MongoDB</td>
              <td>Change streams</td>
              <td>A replica set (single-node is fine)</td>
              <td>Pre-images on the source collection</td>
            </tr>
            <tr>
              <td>Redis</td>
              <td>Keyspace notifications</td>
              <td>
                <code>notify-keyspace-events</code>
              </td>
              <td>Enables notifications itself when it can</td>
            </tr>
            <tr>
              <td>SQLite</td>
              <td>Not available — use a watch bridge</td>
              <td>—</td>
              <td>—</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 id="postgres">PostgreSQL</h3>
      <p>
        Syncle uses logical replication with the built-in{' '}
        <code>pgoutput</code> plugin, so there is no server extension to
        install. Two things must be true on the server:{' '}
        <code>wal_level=logical</code>, and the connection&apos;s role has{' '}
        <code>REPLICATION</code> (superusers pass too). Changing{' '}
        <code>wal_level</code> needs a server restart, which is the one step
        Syncle cannot automate — on managed Postgres, set it in your
        provider&apos;s parameter group and reboot.
      </p>
      <CodeBlock title="postgresql.conf — needs a restart">{`wal_level = logical`}</CodeBlock>
      <p>
        Grant replication with{' '}
        <code>ALTER ROLE your_user REPLICATION;</code>. The rest is
        provisioned for you: each CDC bridge gets a publication scoped to its
        source table and a logical replication slot, named{' '}
        <code>{'syncle_pub_<id>'}</code> and <code>{'syncle_slot_<id>'}</code>{' '}
        (the bridge id with dashes removed). If you later point the bridge at
        a different table, the publication is updated to match. The slot
        stores the confirmed position and is only advanced after Syncle has
        persisted its own cursor, so a restart resumes exactly where it left
        off without skipping changes.
      </p>

      <h4 id="postgres-table">What the table needs</h4>
      <p>
        PostgreSQL identifies the row an <code>UPDATE</code> or{' '}
        <code>DELETE</code> touched by the table&apos;s{' '}
        <strong>replica identity</strong> — its primary key, unless you have
        set something else. A table with no primary key and no replica
        identity can only report inserts. Worse, publishing updates or
        deletes for such a table makes those statements <em>fail in your
        database</em> (&quot;cannot update table … because it does not have a
        replica identity and publishes updates&quot;). Syncle checks this
        before it creates anything on the source and refuses to start the
        bridge rather than break the application that owns the table. You
        have three ways forward:
      </p>
      <ul>
        <li>capture <code>insert</code> only — Syncle then publishes only inserts;</li>
        <li>add a primary key;</li>
        <li>
          have the table send whole rows:{' '}
          <code>ALTER TABLE your_table REPLICA IDENTITY FULL;</code>
        </li>
      </ul>
      <p>
        The same rule decides what a <strong>delete</strong> can do. A delete
        message carries only the replica-identity columns, so a target keyed
        on any other column would be handed a delete with no key in it —
        which matches nothing and leaves the row behind for ever, without an
        error. A bridge that captures deletes into a target keyed on a column
        the delete does not carry is refused at start, with the three fixes
        spelled out: key the target on the source&apos;s key, stop capturing
        deletes, or switch the table to <code>REPLICA IDENTITY FULL</code>.
        The readiness panel shows which columns the table identifies rows by.
      </p>

      <h4 id="postgres-behaviour">How particular changes are handled</h4>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>At the source</th>
              <th>What Syncle does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                An <code>UPDATE</code> that does not touch a large column
              </td>
              <td>
                PostgreSQL stores large values out of line (TOAST) and leaves
                them out of an update that did not change them. Syncle leaves
                such a column out of the write, so the destination keeps the
                copy it has — it is never overwritten with <code>NULL</code>.
                Where the value itself is needed — a source filter on that
                column, an HTTP payload, a Redis destination, or a row whose
                key changed — it is read back from the source table.
              </td>
            </tr>
            <tr>
              <td>
                An <code>UPDATE</code> that changes the primary key
              </td>
              <td>
                The row has moved: the old key is deleted at the destination
                and the row is written under the new one. (The delete is
                applied only if the bridge captures deletes; without it the
                old row stays, as any deleted row would.)
              </td>
            </tr>
            <tr>
              <td>
                <code>TRUNCATE</code>
              </td>
              <td>
                Off by default: the destination keeps its rows, and the
                timeline gets an amber entry saying the source was truncated
                and that it was not applied. Add <code>truncate</code> to the
                bridge&apos;s operations to empty the destination table too.
              </td>
            </tr>
            <tr>
              <td>A partitioned table</td>
              <td>
                Bridge the parent. The publication is created with{' '}
                <code>publish_via_partition_root</code>, so rows written to
                any partition arrive under the parent&apos;s name. Needs
                PostgreSQL 13 or newer; on 12 the bridge is refused — bridge
                each partition separately there.
              </td>
            </tr>
            <tr>
              <td>
                Bulk loads (<code>COPY</code>) and overlapping transactions
              </td>
              <td>
                Nothing to configure. Changes are delivered in commit order,
                a transaction at a time, and every row has its own position
                even when hundreds share one WAL record — so a restart in the
                middle of a large transaction resumes in the middle, without
                repeating or skipping rows.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <h4 id="postgres-slots">Replication slots and the source&apos;s disk</h4>
      <p>
        A replication slot makes PostgreSQL keep every byte of WAL written
        since the slot&apos;s position —{' '}
        <strong>for as long as the slot exists, whether or not anything is
        reading it</strong>. A bridge that is paused or has failed keeps its
        slot so that it can resume without a gap, and the source keeps
        accumulating WAL for it. Left alone for long enough, that fills the
        source&apos;s disk, and a PostgreSQL with a full disk stops accepting
        writes. This is the one way a Syncle bridge can hurt the database it
        reads from, so it is watched:
      </p>
      <ul>
        <li>
          Every minute (<code>SYNCLE_SLOT_CHECK_SECONDS</code>) Syncle
          measures how much WAL each CDC bridge&apos;s slot is pinning. Past{' '}
          <code>SYNCLE_SLOT_WARN_BYTES</code> (1 GiB) the bridge&apos;s job
          view shows a warning with the amount and what to do, and the same
          line goes to the log. It is also available from{' '}
          <code>GET /api/bridges/:id/source-hold</code>.
        </li>
        <li>
          <strong>The real safety net is on the server.</strong> On
          PostgreSQL 13+, set <code>max_slot_wal_keep_size</code> (for
          example <code>10GB</code>): past it the server invalidates the slot
          instead of filling the disk, and that protects you even while
          Syncle itself is switched off. The readiness check tells you when
          it is unlimited, which is the default.
        </li>
        <li>
          Optionally, <code>SYNCLE_SLOT_MAX_BYTES</code> makes Syncle do the
          same from its side: a bridge that is <em>not running</em> and pins
          more than that has its slot dropped. It is off by default, because
          it trades a gap in that bridge for the source staying up, and that
          is a decision for whoever runs the source. A running bridge is
          never touched — it is behind, not abandoned.
        </li>
      </ul>
      <p>
        A slot is released as soon as it is no longer needed: when the bridge
        is deleted, when it is edited into a watch or replay bridge, and when
        it is pointed at another connection or database (the slot lives on
        the <em>old</em> server, where nothing else would ever look for it
        again). If the drop fails — the server is unreachable at that moment —
        it is recorded and retried every minute until it succeeds;{' '}
        <code>GET /api/bridges/cdc/cleanups</code> lists what is still
        outstanding, and the connection it has to go through cannot be deleted
        in the meantime. To remove one by hand:{' '}
        <code>SELECT pg_drop_replication_slot(&apos;syncle_slot_…&apos;);</code>
      </p>
      <p>
        Each CDC bridge uses one slot and one WAL sender, and a server has a
        fixed number of both (<code>max_replication_slots</code>,{' '}
        <code>max_wal_senders</code>; 10 each by default). The readiness
        check counts them, and a bridge is not started on a server that has
        none left.
      </p>

      <h4 id="position-lost">When a bridge&apos;s place in the log is gone</h4>
      <p>
        A bridge resumes from a position in the source&apos;s change log, and
        that position can stop existing: the slot was dropped (by hand, by{' '}
        <code>SYNCLE_SLOT_MAX_BYTES</code>) or invalidated by the server
        (<code>max_slot_wal_keep_size</code>); MySQL purged the binlog file;
        MongoDB&apos;s oplog rolled past the resume token. Whatever changed at
        the source between that position and now can no longer be read.
      </p>
      <p>
        Syncle does not paper over that. The bridge stops (or refuses to
        start) and says why; starting it again asks you to confirm{' '}
        <strong>Continue from now</strong> —{' '}
        <code>{'POST /api/bridges/:id/watch/start'}</code> with{' '}
        <code>{'{ "fromNow": true }'}</code>. The timeline records the point
        where the gap is, and a replay of the same bridge brings the
        destination back in line. Earlier versions quietly made a new slot
        (or restarted the change stream) at the current position and carried
        on, leaving a hole in the destination that nothing showed.
      </p>

      <Note>
        Bridges created before these positions existed keep working: the
        saved cursor is understood as &quot;everything up to here&quot;. The
        first start after the upgrade may deliver the last transaction again;
        database destinations absorb that (writes are upserts), and an HTTP
        receiver sees at most that one transaction twice.
      </Note>

      <h3 id="mysql">MySQL</h3>
      <p>
        Syncle connects as a replication client and decodes row events from
        the binary log. Four server settings matter, and on managed MySQL
        they usually mean a parameter-group change plus a reboot:
      </p>
      <CodeBlock title="my.cnf — needs a restart">{`log_bin          = ON
binlog_format    = ROW
binlog_row_image = FULL
server_id        = 1   # any unique id`}</CodeBlock>
      <p>
        The connecting user needs replication grants (a user with{' '}
        <code>ALL PRIVILEGES</code> also passes):
      </p>
      <CodeBlock>{`GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO CURRENT_USER;`}</CodeBlock>
      <p>
        There is nothing to provision — the binlog already exists. The cursor
        is the binlog file and position, so MySQL CDC is durable and resumes
        exactly after a restart, even in the middle of a multi-row statement.
      </p>
      <p>
        Three limits are worth knowing before you point a bridge at MySQL.
      </p>
      <p>
        <strong>
          <code>binlog_transaction_compression</code> is not supported.
        </strong>{' '}
        MySQL 8.0.20 and later can wrap a transaction&apos;s row events inside a
        compressed payload event, and the binlog reader has no decoder for it —
        the rows inside are not seen. Leave it <code>OFF</code> on a source you
        stream from.
      </p>
      <p>
        <strong>MariaDB is untested.</strong> Connections, replay and watch
        bridges go through <code>mysql2</code> and work, but CDC reads the
        binlog with a client that targets MySQL and that path has not been
        verified against MariaDB. Treat MariaDB CDC as unsupported until it has
        been.
      </p>
      <p>
        <strong>Binlog positions belong to one server.</strong> A cursor records
        the server&apos;s <code>@@server_uuid</code> (and the GTID of the
        transaction it sits at). If the connection later reaches a different
        server — after a failover, say — the bridge refuses to resume rather
        than reading unrelated offsets, and says so.
      </p>
      <p>
        <strong>MySQL purges its binlog on its own schedule</strong>{' '}
        (<code>binlog_expire_logs_seconds</code>, 30 days by default, often
        far less on managed servers), whoever still needs it. A bridge paused
        for longer than that has lost its place: the file its position is in
        no longer exists. Syncle checks for this before it starts a bridge,
        and in both cases asks you to confirm continuing from the current
        position — see{' '}
        <a href="#position-lost">when a bridge&apos;s place in the log is gone</a>.
        Keep the binlog for at least as long as you might leave a bridge
        stopped.
      </p>

      <h3 id="mongodb">MongoDB</h3>
      <p>
        Syncle opens a change stream on the source collection. Change streams
        require a replica set or a sharded cluster — they are not available
        on a standalone <code>mongod</code>. A single-node replica set is
        fine for development: start the server with{' '}
        <code>--replSet rs0</code> and run <code>rs.initiate()</code> once.
        Managed MongoDB (Atlas) already satisfies this.
      </p>
      <p>
        On MongoDB 6.0 and newer, Syncle enables change-stream{' '}
        <strong>pre-images</strong> on the source collection so a delete
        event carries the full prior document — without them a delete event
        contains only <code>_id</code>, and a bridge keyed on a business
        column could not find the row to remove downstream. On older servers
        this is a best-effort no-op and deletes carry only <code>_id</code>.
        The resume token is durable as long as it stays inside the oplog
        window. If the bridge is paused long enough for the oplog to roll
        past it, the bridge stops and says so, and starting it again asks you
        to confirm continuing from now — see{' '}
        <a href="#position-lost">when a bridge&apos;s place in the log is gone</a>.
        Size the oplog for the longest pause you expect.
      </p>

      <h3 id="redis">Redis</h3>
      <p>
        Syncle subscribes to keyspace notifications — pub/sub on the{' '}
        <code>{'__keyevent@<db>__'}</code> channels of the connection&apos;s
        database index. The server must have{' '}
        <code>notify-keyspace-events</code> enabled with the <code>E</code>{' '}
        flag plus event classes. Syncle attempts{' '}
        <code>CONFIG SET notify-keyspace-events EA</code> itself when a
        bridge goes live; managed Redis may require enabling it in the
        provider console, and the readiness check tells you where you stand.
      </p>
      <p>
        A notification carries only the key, so Syncle reads the current
        value afterwards, best-effort, and delivers rows shaped like{' '}
        <code>{'{ key, event, type, value }'}</code> — deletes carry only{' '}
        <code>key</code> and <code>event</code>, because the value is already
        gone. Redis cannot tell a create from an overwrite, so every write is
        delivered as an <strong>update</strong>; <code>del</code>,{' '}
        <code>unlink</code>, <code>expired</code> and <code>evicted</code>{' '}
        arrive as deletes. Setting a TTL is not a delete — only the TTL
        actually firing is. A filter on the <code>key</code> column acts as a
        Redis-style glob (<code>user:*</code>) applied at the subscription.
      </p>
      <Note>
        Redis keyspace notifications are fire-and-forget pub/sub with no
        backlog: any change that happens while Syncle is disconnected — a
        restart, a network blip — is gone for good, and there is no resume
        cursor. When every change matters, use a watch bridge on Redis
        instead.
      </Note>

      <h3 id="sqlite">SQLite</h3>
      <p>
        SQLite has no change log an external reader can tail: the update hook
        only fires for writes made through the same in-process connection,
        and Syncle opens a file that other processes write to. CDC is
        therefore not supported — the readiness check reports it as such —
        and the right tool is a <a href="/docs/bridges">watch bridge</a>,
        which polls and works reliably on SQLite.
      </p>

      <h2 id="readiness">The readiness check</h2>
      <p>
        The bridge builder runs a readiness check when you choose the CDC
        trigger and lists anything missing, with the instruction to fix it.
        The same probe is available as{' '}
        <code>POST /api/bridges/cdc/readiness</code> with a body of{' '}
        <code>{'{ connectionId, database?, schema?, table }'}</code>. The
        response says whether the engine supports CDC at all, whether this
        connection is ready right now, the individual checks, and the manual
        steps left:
      </p>
      <CodeBlock title="POST /api/bridges/cdc/readiness">{`// request
{ "connectionId": "b6f4…", "database": "shop", "table": "orders" }

// response
{
  "data": {
    "engine": "postgres",
    "supported": true,
    "ready": false,
    "checks": [
      { "label": "wal_level = logical", "ok": false, "detail": "currently \\"replica\\"" },
      { "label": "role can replicate", "ok": true }
    ],
    "instructions": [
      "Set wal_level=logical on the server (postgresql.conf or your provider’s parameter group) and restart it. This is the one step we can’t automate — it needs a server restart."
    ]
  }
}`}</CodeBlock>

      <h2 id="operations">Operations and the op token</h2>
      <p>
        A CDC trigger carries the set of operations to deliver — any subset
        of <code>insert</code>, <code>update</code> and <code>delete</code>,
        all three by default. On a database
        destination a delete routes to a keyed delete on the target; on an
        HTTP destination the payload template can expose the operation
        through the <code>{'{{$op}}'}</code> token, which resolves to{' '}
        <code>insert</code>, <code>update</code> or <code>delete</code>. The
        token is populated on CDC deliveries only — a watch bridge sees rows,
        not operations; the other template tokens are covered in{' '}
        <a href="/docs/bridges">How bridges work</a>.
      </p>
      <p>
        PostgreSQL sources have a fourth, opt-in operation:{' '}
        <code>truncate</code>. With it, a <code>TRUNCATE</code> of the source
        table empties every database target&apos;s table (a Redis target has
        no table to empty, and says so in the delivery&apos;s result), and an
        HTTP destination receives one delivery with an empty row and{' '}
        <code>{'{{$op}}'}</code> set to <code>truncate</code>. It is always
        delivered on its own, in order: rows written before the truncate are
        delivered before it, and rows inserted after it are still there
        afterwards. Without it, the truncate is recorded on the timeline as
        a skipped entry explaining that the destination was left alone.
        Other engines do not report a truncate as a change (in MySQL it is
        DDL, not row events), so a bridge on them that asks for it is
        refused at start instead of waiting for something that never comes.
      </p>

      <h2 id="lifecycle">Going live, stopping, and deleting</h2>
      <p>
        A CDC bridge does not run one-shot jobs — asking it to replay returns
        an error pointing you at live listening instead. Going live opens one
        long-running job, and every captured change is recorded in it as a
        delivery, which is what the live timeline shows. Watch bridges share
        exactly the same lifecycle and the same endpoints:
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Endpoint</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>POST /api/bridges/cdc/readiness</code>
              </td>
              <td>Probe a connection and table for CDC readiness</td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/:id/watch/start</code>
              </td>
              <td>
                Start live listening — routes to CDC or the polling watch by
                the bridge&apos;s trigger kind
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/:id/watch/stop</code>
              </td>
              <td>
                Stop both mechanisms (CDC first) and return the finalized job
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Canceling the running job stops the listener too — the job pauses and
        keeps its cursor, so it can resume in place. Updating a live bridge
        stops the listener first and restarts it on the new configuration.
        When you go live again, each engine resumes from its persisted
        cursor: Postgres from the slot&apos;s confirmed position, MySQL from
        the binlog position, MongoDB from the resume token — and Redis always
        starts from now. Authentication and the response envelope are covered
        on the <a href="/docs/api">HTTP API</a> page.
      </p>
      <p>
        Deleting a CDC bridge deprovisions what was created for it. On
        Postgres the replication slot and publication are dropped — this
        matters, because a slot nothing reads pins WAL on the source and
        eventually fills its disk. The same happens when a CDC bridge is
        edited into another kind of bridge or moved to another connection,
        and a drop that fails is retried until it succeeds (see{' '}
        <a href="#postgres-slots">replication slots and the source&apos;s disk</a>). On Redis, notifications are left enabled,
        since other consumers may rely on them; MySQL has nothing to remove,
        and MongoDB pre-images stay enabled. Deleting a workspace does the
        same teardown for every bridge in it.
      </p>
    </DocArticle>
  );
}
