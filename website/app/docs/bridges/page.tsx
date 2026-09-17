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
                polls <code>{'col >= cursor'}</code> with boundary-key dedupe,
                and re-scans a <code>lookbackMs</code> window (default 3000
                ms) behind the cursor so late-committing transactions are not
                lost
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
        all three). SQLite has no change log, so CDC is not available there —
        use a watch bridge. Each engine has prerequisites and honest
        limitations, and the bridge builder runs a readiness check that lists
        anything missing; the <a href="/docs/cdc">CDC setup page</a> covers
        all of it.
      </p>

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
          </tbody>
        </table>
      </div>
      <p>
        Auto-created tables use cross-engine type translation: each source
        column type is collapsed to a portable type (integer, bigint, number,
        boolean, timestamp, json, uuid, text — falling back to text) and
        rendered in the target engine&apos;s dialect, with{' '}
        <code>keyColumns</code> as the NOT NULL primary key and nothing
        auto-increment. The mapping preview in the builder renders exactly
        the mapping the runner performs.
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
                the change operation — insert, update or delete — set on CDC
                deliveries
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
        bridge. All of these are also plain endpoints,
        documented on the <a href="/docs/api">HTTP API page</a>; reading the
        delivery timeline is covered in the{' '}
        <a href="/docs/quickstart">quickstart</a>.
      </p>

      <h2 id="fan-out-and-chaining">Fan-out and chaining</h2>
      <p>
        Because a database destination is a list of targets, one bridge can
        fan a source out to several databases at once — each target with its
        own mapping, write mode and key columns. And because any connection
        can sit on either end, bridges chain: database A feeds B, and a
        second bridge watches B and feeds C.
      </p>

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
