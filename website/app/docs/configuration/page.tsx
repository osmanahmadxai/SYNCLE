import { CodeBlock } from '@/components/docs/code-block';
import { DocArticle, docMetadata } from '@/components/docs/doc-article';
import { Note } from '@/components/docs/note';

export const metadata = docMetadata('configuration');

export default function Page() {
  return (
    <DocArticle slug="configuration">
      <p>
        Syncle is configured through environment variables, plus a small set of
        runtime settings edited in the web interface and stored in its metadata
        database. This page lists every variable with its shipped default,
        where each configuration file lives, and how the in-app settings layer
        over the env values.
      </p>

      <h2 id="where-configuration-lives">Where configuration lives</h2>
      <p>
        Which file matters depends on how you run Syncle. There is no dotfile
        config — no <code>.synclerc</code>, no <code>syncle.config.js</code>;
        configuration is exclusively environment variables plus the in-app
        settings described at the end of this page.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Applies to</th>
              <th>How it gets there</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>$SYNCLE_HOME/.env</code> (default{' '}
                <code>~/.syncle/.env</code>)
              </td>
              <td>Docker install</td>
              <td>
                Written by <code>install.sh</code> with mode 600; passed to
                Docker Compose as the env file. Holds{' '}
                <code>SYNCLE_MASTER_KEY</code> and the pinned{' '}
                <code>SYNCLE_IMAGE</code>, and is where you add any of the{' '}
                <a href="#api-environment-variables">API settings</a> below.
              </td>
            </tr>
            <tr>
              <td>
                <code>apps/api/.env</code>
              </td>
              <td>API, source checkout</td>
              <td>
                Copied from <code>apps/api/.env.example</code> by{' '}
                <code>scripts/setup-env.mjs</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>apps/web/.env.local</code>
              </td>
              <td>Web app, source checkout</td>
              <td>
                Copied from <code>apps/web/.env.example</code> by the same
                script.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        <code>scripts/setup-env.mjs</code> runs before <code>pnpm dev</code>{' '}
        and <code>pnpm start</code> — not on <code>pnpm install</code> — and
        never overwrites a file that already exists, so your edits survive
        every run.
      </p>
      <p>
        In the Docker install, <code>docker-compose.app.yml</code> fixes the
        wiring (<code>PORT=4002</code>, a <code>DATABASE_URL</code> pointing
        at the bundled Postgres, the Redis URL, the data directory) and
        passes every other API setting on this page through from{' '}
        <code>$SYNCLE_HOME/.env</code>. To change one, add a line and bring
        the stack up again:
      </p>
      <CodeBlock title="~/.syncle/.env">{`SYNCLE_CDC_SPOOL=on
SYNCLE_DELIVERY_RETENTION_DAYS=90`}</CodeBlock>
      <CodeBlock title="apply it">{`syncle up      # not "syncle restart": a restart keeps the old environment`}</CodeBlock>
      <p>
        A setting you leave out keeps its default. (Releases up to 1.3 passed
        only <code>SYNCLE_MASTER_KEY</code> and <code>SYNCLE_IMAGE</code>, so
        none of the others could be changed on a Docker install at all; run{' '}
        <code>syncle update</code> to get the newer compose file.) The <code>syncle</code> launcher itself reads{' '}
        <code>SYNCLE_PORT</code> and <code>SYNCLE_HOME</code> from your shell
        — the <a href="/docs/install">installation page</a> covers those.
      </p>

      <h2 id="api-environment-variables">API environment variables</h2>
      <p>
        Read from <code>apps/api/.env</code> (or the container environment) at
        boot. Defaults below are the shipped{' '}
        <code>apps/api/.env.example</code> values or, where that file has no
        line, the code defaults.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Variable</th>
              <th>Default</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>PORT</code>
              </td>
              <td>
                <code>4002</code>
              </td>
              <td>
                Port the API listens on. Must match the web app&apos;s{' '}
                <code>SYNCLE_API_ORIGIN</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>DATABASE_URL</code>
              </td>
              <td>
                <code>
                  postgresql://postgres:postgres@localhost:5433/syncle?schema=public
                </code>
              </td>
              <td>
                PostgreSQL URL for Syncle&apos;s own metadata store
                (connections, bridges, jobs) — not a database you sync. No
                code fallback: the API cannot start without it.
              </td>
            </tr>
            <tr>
              <td>
                <code>REDIS_URL</code>
              </td>
              <td>
                <code>redis://localhost:6379</code>
              </td>
              <td>
                Redis behind the job queue. Only running bridge jobs needs it;
                the API boots fine with Redis down.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_MASTER_KEY</code>
              </td>
              <td>unset (auto-generated)</td>
              <td>
                Base64 32-byte key that encrypts stored credentials and signs
                session cookies. See{' '}
                <a href="#the-master-key">the master key</a>.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_DATA_DIR</code>
              </td>
              <td>
                <code>apps/api/.syncle</code>
              </td>
              <td>
                Directory for local state — the auto-generated{' '}
                <code>master.key</code>, the first-run setup token, and{' '}
                <code>syncle.db</code>. Created with mode 700.
              </td>
            </tr>
            <tr>
              <td>
                <code>WEB_ORIGIN</code>
              </td>
              <td>
                <code>http://localhost:3002</code>
              </td>
              <td>
                Origins a browser may use Syncle from <em>besides the
                app&apos;s own</em>, comma-separated. They are allowed by
                credentialed CORS, and they are the only other origins a request
                that changes something is{' '}
                <a href="/docs/self-hosting#request-origin">taken from</a>.
                Needed when the browser calls the API directly via{' '}
                <code>NEXT_PUBLIC_API_URL</code>; otherwise only behind a
                reverse proxy that rewrites the <code>Host</code> header, for
                browsers too old to send <code>Sec-Fetch-Site</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>WEB_PORT</code>
              </td>
              <td>
                <code>3002</code>
              </td>
              <td>
                The web app&apos;s port; sets the default CORS origin and the
                address in the ready banner.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_JOB_CONCURRENCY</code>
              </td>
              <td>
                <code>5</code>
              </td>
              <td>How many bridge jobs may execute concurrently.</td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_CDC_BATCH_SIZE</code>
              </td>
              <td>
                <code>100000</code>
              </td>
              <td>
                Rows per CDC delivery to a database destination. Database
                destinations only — HTTP keeps the bridge&apos;s own batch
                size. The default is the measured peak; a larger batch buys
                nothing and lengthens what a crash has to replay.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_CDC_BATCH_BYTES</code>
              </td>
              <td>
                <code>67108864</code>
              </td>
              <td>
                Byte ceiling for one batch. A row cap alone is unsafe, since
                100,000 wide rows could be gigabytes — the row size is
                estimated once per batch and whichever limit binds first wins.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_CDC_LINGER_MS</code>
              </td>
              <td>
                <code>50</code>
              </td>
              <td>
                How long a partial CDC batch waits for more changes before it
                is sent anyway.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_CDC_SPOOL</code>
              </td>
              <td>
                <em>off</em>
              </td>
              <td>
                <code>on</code> spools changes through Redis before writing, so
                the source is acknowledged without waiting for the destination.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_CDC_SPOOL_MAX</code>
              </td>
              <td>
                <code>50000</code>
              </td>
              <td>
                Unwritten changes held in the spool before the reader is
                throttled.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_DEAD_LETTER_MAX_ROWS</code>
              </td>
              <td>
                <code>10000</code>
              </td>
              <td>
                Undelivered rows one bridge may hold in its{' '}
                <a href="/docs/bridges#dead-letter-queue">dead-letter queue</a>.
                At the limit a <code>continue</code> bridge stops, without
                moving its cursor, rather than grow the metadata store
                without bound.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_MAX_CONSECUTIVE_FAILURES</code>
              </td>
              <td>
                <code>5</code>
              </td>
              <td>
                Batches in a row that may deliver nothing before a{' '}
                <code>continue</code> bridge stops. One bad row fails one
                batch; a destination that is down fails all of them.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_SLOT_CHECK_SECONDS</code>
              </td>
              <td>
                <code>60</code>
              </td>
              <td>
                How often to measure what each CDC bridge is holding on its
                source — for PostgreSQL, the WAL pinned by its replication
                slot — and to retry dropping slots that could not be dropped.{' '}
                <code>0</code> turns it off.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_SLOT_WARN_BYTES</code>
              </td>
              <td>
                <code>1073741824</code>
              </td>
              <td>
                WAL pinned by one bridge before it is flagged in the job view
                and the log (1 GiB). <code>0</code> never warns.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_SLOT_MAX_BYTES</code>
              </td>
              <td>
                <code>0</code>
              </td>
              <td>
                WAL pinned by a bridge that is <em>not running</em> before
                Syncle drops its replication slot to protect the source.{' '}
                <code>0</code> (the default) never does: a dropped slot is a
                gap in that bridge. Prefer{' '}
                <code>max_slot_wal_keep_size</code> on the server, which also
                works while Syncle is down — see{' '}
                <a href="/docs/cdc#postgres-slots">replication slots</a>.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_SNAPSHOT_HOLD_MAX</code>
              </td>
              <td>
                <code>100000</code>
              </td>
              <td>
                A Redis CDC bridge that{' '}
                <a href="/docs/bridges#copy-then-follow">
                  copies its keys before following them
                </a>{' '}
                holds the changes made meanwhile in memory — the newest per
                key, since Redis has no log to read them back from. This is
                how many keys may be held before the bridge stops rather than
                grow without limit. PostgreSQL, MySQL and MongoDB keep those
                changes in their own log and are not affected.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_LOG_LEVEL</code>
              </td>
              <td>
                <code>warn</code>
              </td>
              <td>
                <code>error</code>, <code>warn</code>, <code>log</code> (or{' '}
                <code>info</code>), <code>debug</code>, <code>verbose</code>.
                The default logs what it always did — warnings and errors;{' '}
                <code>log</code> adds the lifecycle lines: a bridge started, a
                table copied, a slot released, a retention sweep.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_METRICS_TOKEN</code>
              </td>
              <td>unset</td>
              <td>
                Turns on <code>GET /api/metrics</code> (Prometheus) for
                requests carrying{' '}
                <code>Authorization: Bearer &lt;token&gt;</code>. Unset, the
                endpoint does not exist. See{' '}
                <a href="/docs/self-hosting#monitoring">monitoring</a>.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_ALERT_THROTTLE_SECONDS</code>
              </td>
              <td>
                <code>300</code>
              </td>
              <td>
                <a href="/docs/self-hosting#alerts">Alerts</a> are throttled
                per channel, kind of event and bridge: one per this many
                seconds, the next one saying how many were held back.{' '}
                <code>0</code> sends every one.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_VERIFY_RECHECK_MS</code>
              </td>
              <td>
                <code>1500</code>
              </td>
              <td>
                <a href="/docs/bridges#verify">Verifying</a> a bridge that is
                delivering: a row that looks wrong is looked at again this many
                milliseconds later, from both ends, before it counts. A change
                that was only in flight is not a difference.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_SHARED_SLOT_JOIN_WAIT_MS</code>
              </td>
              <td>
                <code>60000</code>
              </td>
              <td>
                A bridge joining a{' '}
                <a href="/docs/cdc#shared-slot">shared replication slot</a>{' '}
                waits for the transactions that were open when its table was
                published to end. After this long it gives up and names the
                transaction it was waiting for.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_DELIVERY_RETENTION_DAYS</code>
              </td>
              <td>
                <code>30</code>
              </td>
              <td>
                Default for the <code>deliveryRetentionDays</code> setting:
                days a delivery&apos;s details are kept. <code>0</code> keeps
                them for ever. See{' '}
                <a href="#delivery-history">delivery history</a>.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_DELIVERY_MAX_PER_JOB</code>
              </td>
              <td>
                <code>100000</code>
              </td>
              <td>
                Default for the <code>deliveryMaxPerJob</code> setting: how
                many deliveries a live (watch / CDC) bridge keeps, however
                recent. <code>0</code> is no limit.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_RETENTION_SWEEP_MINUTES</code>
              </td>
              <td>
                <code>60</code>
              </td>
              <td>
                How often delivery history is pruned. <code>0</code> never
                prunes on a timer (<code>POST /api/bridges/retention/run</code>{' '}
                still does it on demand).
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_MAX_QUERY_ROWS</code>
              </td>
              <td>
                <code>5000</code>
              </td>
              <td>
                Reported as the settings default. The working ad-hoc query cap
                is the built-in 5000, or a per-connection{' '}
                <code>maxQueryRows</code> option.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_POOL_IDLE_MS</code>
              </td>
              <td>
                <code>300000</code>
              </td>
              <td>
                Idle milliseconds before a pooled database connection is
                closed.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_SECURE_COOKIES</code>
              </td>
              <td>unset (auto-detect)</td>
              <td>
                <code>true</code> forces the Secure attribute on session
                cookies, <code>false</code> forces it off; unset detects HTTPS
                from the request.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_BLOCK_PRIVATE_DESTINATIONS</code>
              </td>
              <td>unset (off)</td>
              <td>
                <code>true</code> refuses HTTP destinations that resolve to
                loopback, private, or link-local addresses.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_SQLITE_DIR</code>
              </td>
              <td>unset (no restriction)</td>
              <td>
                When set, SQLite connections may only open files under this
                directory.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <Note>
        The code default for <code>PORT</code> is 4000, but every shipped
        configuration — <code>.env.example</code>,{' '}
        <code>docker-compose.app.yml</code>, and the web proxy&apos;s fallback
        — uses 4002. Delete the <code>PORT</code> line from{' '}
        <code>apps/api/.env</code> and the API comes up on 4000 where the
        proxy, still expecting 4002, cannot reach it. Keep the line, or change
        both sides together.
      </Note>
      <p>
        Three details worth knowing. <code>SYNCLE_HOOK_CONCURRENCY</code> is
        the legacy name for <code>SYNCLE_JOB_CONCURRENCY</code> and is still
        honored as a fallback; prefer the new name.{' '}
        <code>SYNCLE_BLOCK_PRIVATE_DESTINATIONS</code> is compared to the
        literal string <code>true</code> — <code>1</code> or <code>TRUE</code>{' '}
        leaves the guard off (cloud metadata endpoints are blocked regardless
        of this flag). And Secure-cookie detection follows the request&apos;s{' '}
        <code>X-Forwarded-Proto</code> header via Express trust-proxy —{' '}
        <code>NODE_ENV</code> plays no part in it, despite a stale comment in
        the env example.
      </p>

      <h2 id="the-master-key">The master key</h2>
      <p>
        <code>SYNCLE_MASTER_KEY</code> is a base64-encoded 32-byte key with
        two jobs: it encrypts stored connection credentials with AES-256-GCM,
        and an HKDF-derived sub-key signs login session cookies. Generate one
        with either of:
      </p>
      <CodeBlock>{`openssl rand -base64 32
# or, without openssl:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`}</CodeBlock>
      <p>
        Left unset, the API generates a random key on first run and writes it
        to <code>master.key</code> in the data directory with mode 600,
        logging a warning to set the variable in production. That
        auto-generated key sits beside the data it protects: a data-directory
        backup carries both, and losing the volume loses the key. The
        installer avoids this by generating a key into{' '}
        <code>$SYNCLE_HOME/.env</code> and preserving it on every re-run. A
        key of the wrong length is rejected at boot with{' '}
        <code>SYNCLE_MASTER_KEY must be a base64-encoded 32-byte value</code>.
      </p>
      <Note>
        Never regenerate the key once Syncle holds data. A new key makes every
        stored credential undecryptable and logs everyone out.
      </Note>

      <h2 id="web-environment-variables">Web app environment variables</h2>
      <p>
        Read from <code>apps/web/.env.local</code> (or the container
        environment). The browser normally calls a relative <code>/api</code>{' '}
        on the web app&apos;s own origin, and the web server proxies that to
        the API — so the API&apos;s address is never baked into the browser
        bundle.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Variable</th>
              <th>Default</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>SYNCLE_API_ORIGIN</code>
              </td>
              <td>
                <code>http://127.0.0.1:4002</code>
              </td>
              <td>
                Where the <code>/api</code> proxy forwards requests; must
                match the API&apos;s <code>PORT</code>. Read at request time,
                not build time.
              </td>
            </tr>
            <tr>
              <td>
                <code>WEB_PORT</code>
              </td>
              <td>
                <code>3002</code>
              </td>
              <td>Port the web app runs on.</td>
            </tr>
            <tr>
              <td>
                <code>API_PORT</code>
              </td>
              <td>
                <code>4002</code>
              </td>
              <td>
                Fallback port for the proxy&apos;s default origin when{' '}
                <code>SYNCLE_API_ORIGIN</code> is unset.
              </td>
            </tr>
            <tr>
              <td>
                <code>NEXT_PUBLIC_API_URL</code>
              </td>
              <td>unset</td>
              <td>
                Optional absolute API URL (e.g.{' '}
                <code>https://api.example.com/api</code>) that makes the
                browser call the API directly, skipping the proxy.
              </td>
            </tr>
            <tr>
              <td>
                <code>NEXT_OUTPUT</code>
              </td>
              <td>unset</td>
              <td>
                Set to <code>standalone</code> to build the self-contained
                server the Docker image runs.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        <code>NEXT_PUBLIC_API_URL</code> is inlined into the browser bundle at
        build time. Setting it turns on cross-origin requests, so the
        API&apos;s <code>WEB_ORIGIN</code> must then list the web app&apos;s
        origin. Leave it unset for the default same-origin proxy — the{' '}
        <a href="/docs/self-hosting">self-hosting page</a> discusses when the
        direct route is worth it.
      </p>

      <h2 id="in-app-settings">In-app settings</h2>
      <p>
        The Settings dialog (in the user menu) edits a handful of server-wide
        values at runtime. They persist as a single row in the metadata
        database and layer over the env values — the env vars act as defaults,
        not ceilings. The same values are readable and writable over HTTP via{' '}
        <code>GET /api/settings</code> and <code>PUT /api/settings</code>,
        covered on the <a href="/docs/api">API page</a>.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Setting</th>
              <th>Default</th>
              <th>Range</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>defaultPollIntervalMs</code>
              </td>
              <td>
                <code>5000</code>
              </td>
              <td>1000 – 3,600,000</td>
              <td>Default poll cadence (ms) for polling bridges.</td>
            </tr>
            <tr>
              <td>
                <code>defaultMaxPerPoll</code>
              </td>
              <td>
                <code>500</code>
              </td>
              <td>1 – 5000</td>
              <td>Default rows fetched per poll.</td>
            </tr>
            <tr>
              <td>
                <code>defaultCdcOperations</code>
              </td>
              <td>insert, update, delete</td>
              <td>non-empty subset of the three</td>
              <td>Default operation set for CDC bridges.</td>
            </tr>
            <tr>
              <td>
                <code>maxQueryRows</code>
              </td>
              <td>
                <code>SYNCLE_MAX_QUERY_ROWS</code>, else 5000
              </td>
              <td>1 – 1,000,000</td>
              <td>Cap on rows from one ad-hoc query.</td>
            </tr>
            <tr>
              <td>
                <code>poolIdleMs</code>
              </td>
              <td>
                <code>SYNCLE_POOL_IDLE_MS</code>, else 300,000
              </td>
              <td>10,000 – 86,400,000</td>
              <td>Idle ms before a pooled connection closes.</td>
            </tr>
            <tr>
              <td>
                <code>jobConcurrency</code>
              </td>
              <td>
                <code>SYNCLE_JOB_CONCURRENCY</code>, else 5
              </td>
              <td>1 – 100</td>
              <td>Concurrent bridge jobs.</td>
            </tr>
            <tr>
              <td>
                <code>sessionTtlMinutes</code>
              </td>
              <td>
                <code>10080</code> (one week)
              </td>
              <td>15 – 43,200</td>
              <td>Minutes before a login session expires.</td>
            </tr>
            <tr>
              <td>
                <code>deliveryRetentionDays</code>
              </td>
              <td>
                <code>SYNCLE_DELIVERY_RETENTION_DAYS</code>, else 30
              </td>
              <td>0 – 3,650</td>
              <td>
                Days a delivery&apos;s details are kept. 0 keeps them for
                ever.
              </td>
            </tr>
            <tr>
              <td>
                <code>deliveryMaxPerJob</code>
              </td>
              <td>
                <code>SYNCLE_DELIVERY_MAX_PER_JOB</code>, else 100,000
              </td>
              <td>0 – 100,000,000</td>
              <td>
                Deliveries a live (watch / CDC) bridge keeps, however recent.
                0 is no limit.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 id="delivery-history">Delivery history</h3>
      <p>
        Every delivery is recorded with what was sent and what came back (up
        to 16&nbsp;KB each), which is what the timeline shows. Nothing used to
        remove those rows, and a live bridge writes them for as long as it
        runs — ten deliveries a second is 26 million rows a month in the
        metadata store. Two settings, under Settings › Engine, bound it, and
        both take effect at the next hourly sweep without a restart:
      </p>
      <ul>
        <li>
          <strong>Keep delivery details for (days)</strong> — a finished
          replay loses its details all at once, when the <em>job</em> is older
          than this (never row by row, which would leave a timeline with
          holes in it); a live bridge loses them as each row passes that age.
        </li>
        <li>
          <strong>Deliveries kept per live bridge</strong> — a watch or CDC
          bridge never finishes, so age alone does not bound it: only the
          newest this-many are kept.
        </li>
      </ul>
      <p>
        What is never removed: the job&apos;s delivered / failed / skipped{' '}
        <strong>totals</strong>, which are stored on the job and do not change
        when details go; a failed delivery whose rows are still waiting in the{' '}
        <a href="/docs/bridges">dead-letter queue</a>; and anything belonging
        to a replay that is still queued or running. On the timeline a
        delivery whose details are gone is drawn as a dashed cell —{' '}
        <em>delivered, details removed</em> — rather than as queued. Retrying
        failed deliveries needs those details, so it is available for as long
        as they are kept; after that, run the bridge again. Settled
        dead letters (retried successfully, or discarded) expire on the same
        schedule; pending ones are data and are kept until you deal with them.
      </p>
      <p>
        All of them take effect without a restart. The three{' '}
        <code>default*</code> values are what the bridge builder starts a{' '}
        <em>new</em> bridge from; existing bridges keep their own.{' '}
        <code>maxQueryRows</code> caps ad-hoc queries on every connection that
        does not set its own <code>maxQueryRows</code> option, and reaches
        connections that are already open. <code>jobConcurrency</code> is
        applied to the replay worker as soon as it is saved (jobs already
        running finish as they are). <code>sessionTtlMinutes</code> has no env
        var and is edited only here, under Settings › Security. A settings row
        persisted before the bridges rename under the old{' '}
        <code>hookConcurrency</code> key is migrated to{' '}
        <code>jobConcurrency</code> automatically.
      </p>
      <p>
        Releases up to 1.3 stored these values and reported them back, but only{' '}
        <code>sessionTtlMinutes</code> did anything: the builder used a 5
        second poll, 500 rows per poll and all three CDC operations whatever
        was saved, the query cap was the built-in 5000, and concurrency came
        from <code>SYNCLE_JOB_CONCURRENCY</code> alone.
      </p>
    </DocArticle>
  );
}
