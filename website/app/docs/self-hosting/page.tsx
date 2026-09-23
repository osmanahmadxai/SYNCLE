import { CodeBlock } from '@/components/docs/code-block';
import { DocArticle, docMetadata } from '@/components/docs/doc-article';
import { Note } from '@/components/docs/note';

export const metadata = docMetadata('self-hosting');

export default function Page() {
  return (
    <DocArticle slug="self-hosting">
      <p>
        Syncle is built to run on your own machine or a trusted network. This
        page covers the protections it ships with, what stays your job when you
        expose it further, which volumes hold your data, and what the common
        failure messages mean.
      </p>

      <h2 id="security-posture">The security posture</h2>
      <p>
        Every API route sits behind an account. The first one is created on
        first run, guarded by a one-time setup token, with no signup (the{' '}
        <a href="/docs/quickstart">quickstart</a> walks through it); it is an
        admin, and can make more — see <a href="#accounts">accounts and roles</a>{' '}
        below. The password is hashed with scrypt, and the session is a signed httpOnly
        cookie named <code>db_session</code> that expires after one week{' '}
        <em>of inactivity</em> by default — using the app renews it — with the
        length configurable in-app under Settings › Security. Changing the
        password bumps the account&apos;s session version, which instantly
        invalidates every outstanding cookie on every device.
      </p>
      <p>
        Sign-in attempts are throttled twice over. Five failures from one
        address for one user name lock that pair out, for 30 seconds and
        doubling up to 15 minutes. And ten failures for a user name{' '}
        <em>from anywhere</em> pause sign-in for that name for a few seconds,
        doubling up to one minute. The second exists because the first can be
        dodged: the address is taken from <code>X-Forwarded-For</code>, which
        a client can set to anything it likes, so a guesser who changed it on
        every attempt was never locked out. The per-name throttle holds such
        a guesser to about one attempt a minute, at the cost of making the
        operator wait up to a minute during an attack. Setup attempts are
        limited per address, and the setup token is 72 random bits.
      </p>
      <p>
        What Syncle does not ship: TLS. It serves plain HTTP, and the security
        policy is explicit that TLS termination and network-level control over
        who can reach the port are the operator&apos;s job the moment anything
        beyond localhost can connect.
      </p>

      <h3 id="accounts">Accounts and roles</h3>
      <p>
        Settings › Security › Accounts is where an admin adds them. Every
        account has a role:
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Role</th>
              <th>May</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>admin</code>
              </td>
              <td>
                everything — including the accounts, the API keys, the
                settings, the alert channels, the workspaces, the master key
                and the activity log
              </td>
            </tr>
            <tr>
              <td>
                <code>operator</code>
              </td>
              <td>
                the work: connections, bridges, runs, verifications, the data
                browser (including DDL and raw queries on connections that
                allow them). Not the things above
              </td>
            </tr>
            <tr>
              <td>
                <code>viewer</code>
              </td>
              <td>
                look at everything, change nothing — every <code>GET</code>,
                and their own password
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        A role change takes effect on the next request, without signing in
        again. An account can be <strong>disabled</strong> — it cannot sign
        in and its sessions are over at once, but it keeps its name, so what
        it did stays attributed to it in the activity log — or deleted. Two
        things are refused because they would lock everybody out: the last
        admin that can sign in cannot be demoted, disabled or deleted, and
        nobody deletes the account they are signed in with. An admin can set
        another account&apos;s password (which ends that account&apos;s
        sessions) or end its sessions outright. API keys are not accounts:
        their scope (<code>read</code> or <code>full</code>) says what they
        may do, as before, and only an admin manages them. With more than one
        account, the password-reset code is asked for by user name (
        <code>syncle reset-password &lt;user&gt;</code>); unnamed, it is the
        first admin&apos;s.
      </p>

      <h3 id="activity-log">The activity log</h3>
      <p>
        Every change made through the API — by an account or an API key — and
        every sign-in, succeeded or not, is one entry: who (by name as well as
        by id, so the entry outlives the account), what, to what, from which
        address, and a few words of detail (which engine, which role, which
        setting). Never a secret: a password, a connection&apos;s credentials
        or an API key are not details, and what Syncle does by itself — the
        slot guard giving up a replication slot — is recorded as{' '}
        <em>Syncle</em>. Reads are not recorded; they are the ordinary use of
        the app. Settings › Activity shows it newest first, narrowed by what
        was done and by whom; <code>GET /api/audit</code> answers the same to
        an admin. Entries are kept for <code>auditRetentionDays</code>{' '}
        (Settings › Security; default 365, <code>0</code> = for ever) and
        pruned by the same retention sweep as delivery details. An entry that
        could not be written never fails the request it was about; it is said
        in the server log instead.
      </p>

      <h2 id="exposed-ports">What the compose stack exposes</h2>
      <p>
        The Docker install publishes exactly one host port. The API, Postgres
        and Redis containers are reachable only on the compose network:
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Container</th>
              <th>Host port</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>syncle-web</code>
              </td>
              <td>
                3002 (<code>SYNCLE_PORT</code> changes it)
              </td>
              <td>The GUI and its /api proxy — the only published port.</td>
            </tr>
            <tr>
              <td>
                <code>syncle-api</code>
              </td>
              <td>none</td>
              <td>
                The browser reaches it through the web container&apos;s /api
                proxy. A commented <code>ports</code> mapping in
                docker-compose.app.yml exposes 4002 directly if you need to
                call the <a href="/docs/api">HTTP API</a> without the proxy.
              </td>
            </tr>
            <tr>
              <td>
                <code>syncle-postgres</code>
              </td>
              <td>none</td>
              <td>Syncle&apos;s own metadata store.</td>
            </tr>
            <tr>
              <td>
                <code>syncle-redis</code>
              </td>
              <td>none</td>
              <td>The job queue.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="master-key">Encryption and the master key</h2>
      <p>
        Connection passwords, SSH secrets, TLS client keys and bridge auth
        secrets are encrypted
        at rest with AES-256-GCM under <code>SYNCLE_MASTER_KEY</code>, and only
        ever returned to the browser redacted. Session cookies are signed with
        an HKDF-derived sub-key of the same master key, so encryption and
        signing stay independent. The key must be base64 encoding exactly 32
        bytes — anything else fails with{' '}
        <code>
          SYNCLE_MASTER_KEY must be a base64-encoded 32-byte value
        </code>{' '}
        the first time the key is needed: a login, the first-run setup, or
        saving a connection. The API itself still boots and answers{' '}
        <code>/api/health</code>.
      </p>
      <p>
        The installer generates a key into <code>~/.syncle/.env</code> (mode
        600) and preserves it across every <code>syncle update</code>. If you
        run docker-compose.app.yml by hand without exporting one, the API
        generates a random key on first use and writes it to{' '}
        <code>master.key</code> inside the <code>syncle-api-data</code> volume,
        logging a warning — the key then lives right next to the data it
        protects, and is lost with the volume. Set it explicitly in anything
        you care about.
      </p>
      <Note>
        Never simply <em>replace</em> <code>SYNCLE_MASTER_KEY</code> once data
        exists: every stored credential is under it, and a new key on its own
        opens none of them. To change it, keep the old one beside it for a
        while — see below. If the key ever appears invalid, recover the
        original; do not mint a replacement.
      </Note>

      <h3 id="changing-the-master-key">Changing the master key</h3>
      <p>
        A key that may have leaked, an operator who has left, a policy that
        says yearly: the key can be changed without a moment at which anything
        is unreadable.
      </p>
      <ol>
        <li>
          Generate a new key (<code>openssl rand -base64 32</code>). Put it in{' '}
          <code>SYNCLE_MASTER_KEY</code>, and the key you had in{' '}
          <code>SYNCLE_MASTER_KEY_PREVIOUS</code> (comma-separated if there are
          several). On a launcher install both go in{' '}
          <code>~/.syncle/.env</code>.
        </li>
        <li>
          Restart. From this moment both keys open everything — the old one is
          only ever used to decrypt — and at start the API re-encrypts whatever
          is still under it with the new key: connection passwords and
          connection strings, SSH and TLS secrets, webhook credentials
          (including the copies inside jobs that can still be resumed), alert
          channels. It is safe to interrupt and safe to repeat.
        </li>
        <li>
          When the log says{' '}
          <em>
            Nothing depends on a previous master key any more
          </em>{' '}
          — <strong>Settings → Security</strong> shows the same, and{' '}
          <code>GET /api/settings/encryption</code> answers{' '}
          <code>{'{ previousKeys, reencrypted, unreadable }'}</code> — take{' '}
          <code>SYNCLE_MASTER_KEY_PREVIOUS</code> out and restart once more.
        </li>
      </ol>
      <p>
        Nobody is signed out: a session signed under the previous key stays
        valid while that key is listed, and is re-signed under the new one the
        next time it is renewed. An instance that started without a key in its
        environment (so with a generated <code>master.key</code> in its data
        directory) and is then given one needs no{' '}
        <code>SYNCLE_MASTER_KEY_PREVIOUS</code> at all: the file is treated as
        a previous key. A count of <code>unreadable</code> above zero means a
        secret fits none of the keys given — a key is missing from the list;
        nothing is touched until it is there.
      </p>

      <h2 id="beyond-localhost">Exposing Syncle beyond localhost</h2>
      <p>Before opening the port to a wider network:</p>
      <ul>
        <li>
          <strong>Complete first-run setup first.</strong> Create the admin
          account while the port is still private, so the setup screen is never
          reachable from the outside.
        </li>
        <li>
          <strong>Terminate TLS in front.</strong> The API trusts{' '}
          <code>X-Forwarded-Proto</code> to decide whether session cookies get
          the Secure attribute. If your reverse proxy does not forward that
          header, set <code>SYNCLE_SECURE_COOKIES=true</code> to force it —
          the decision is not keyed off <code>NODE_ENV</code>.
        </li>
        <li>
          <strong>Keep the <code>Host</code> header.</strong> A request that
          changes something is only taken from the app itself (see{' '}
          <a href="#request-origin">below</a>). Current browsers say so
          themselves; for older ones the API compares the request&apos;s{' '}
          <code>Origin</code> with the host it was reached under, so let your
          proxy pass that on (nginx: <code>proxy_set_header Host $host;</code>
          — Caddy and Traefik do by default), or name the public address in{' '}
          <code>WEB_ORIGIN</code>.
        </li>
        <li>
          <strong>Restrict destinations.</strong> Set{' '}
          <code>SYNCLE_BLOCK_PRIVATE_DESTINATIONS=true</code> so bridge
          deliveries refuse loopback, private and link-local addresses — see
          the <a href="#destination-guard">destination guard</a> below.
        </li>
        <li>
          <strong>Jail SQLite paths.</strong> Set{' '}
          <code>SYNCLE_SQLITE_DIR</code> so SQLite connections may only open
          files under that directory on the server.
        </li>
        <li>
          <strong>Control network access.</strong> A firewall or VPN deciding
          who can reach the port at all is still the outermost layer; the
          single admin login is the only thing behind it.
        </li>
      </ul>
      <p>
        On a Docker install, note that the stock compose file passes only a
        fixed set of variables to the api container — adding the hardening
        variables to <code>~/.syncle/.env</code> does nothing on its own. Add
        them to the api service&apos;s <code>environment</code> block instead:
      </p>
      <CodeBlock title="~/.syncle/docker-compose.app.yml (api service)">{`environment:
  # ...existing entries...
  SYNCLE_BLOCK_PRIVATE_DESTINATIONS: 'true'
  SYNCLE_SECURE_COOKIES: 'true'`}</CodeBlock>
      <Note>
        <code>syncle update</code> re-downloads docker-compose.app.yml, so
        edits to it are overwritten — re-apply them after every update. The{' '}
        <code>.env</code> file and its master key are preserved.
      </Note>
      <p>
        The full list of environment variables, with defaults, is on the{' '}
        <a href="/docs/configuration">configuration page</a>.
      </p>

      <h2 id="destination-guard">The outbound destination guard</h2>
      <p>
        Bridge deliveries to HTTP destinations never follow redirects — a
        public host that 302s to an internal address would otherwise bypass any
        pre-flight check. Cloud metadata endpoints (169.254.169.254 and its
        equivalents) are always refused, and hostnames are resolved before
        delivery, so a public DNS name pointing at an internal IP is caught the
        same as a literal address.
      </p>
      <p>
        Blocking loopback, private and link-local destinations is opt-in via{' '}
        <code>SYNCLE_BLOCK_PRIVATE_DESTINATIONS=true</code>, because posting to
        a service on localhost is a primary local use case. The value is
        compared to the literal string <code>true</code> — <code>1</code> or{' '}
        <code>TRUE</code> leaves the guard off.
      </p>

      <h2 id="monitoring">Monitoring</h2>
      <p>
        Two probes are public, because an orchestrator needs them before
        anyone can log in, and neither says more than &quot;up&quot; or
        &quot;down&quot;:
      </p>
      <ul>
        <li>
          <code>GET /api/health</code> — the API is alive and reaches its
          metadata store (503 when it does not). It reports Redis in{' '}
          <code>checks</code> but does not fail on it: a live bridge delivers
          without Redis, and restarting the API does not bring Redis back.
          The compose stack&apos;s container health check uses this one.
        </li>
        <li>
          <code>GET /api/health/ready</code> — 503 unless the store{' '}
          <em>and</em> Redis answer. Point an uptime monitor here. Redis is
          asked on a connection of its own that neither queues nor waits, so
          the probe answers in a second and a half even when Redis is gone —
          the job queue&apos;s own connection would wait for it to come back.
        </li>
      </ul>
      <p>
        <code>GET /api/metrics</code> speaks the Prometheus text format. A
        scraper cannot hold a session, so the route has a token of its own —
        and does not exist until <code>SYNCLE_METRICS_TOKEN</code> is set:
      </p>
      <CodeBlock title="prometheus.yml">{`scrape_configs:
  - job_name: syncle
    metrics_path: /api/metrics
    authorization:
      credentials: "<the value of SYNCLE_METRICS_TOKEN>"
    static_configs:
      - targets: ["syncle.internal:3002"]`}</CodeBlock>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th>What it is</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>syncle_up{'{component}'}</code>
              </td>
              <td>
                1 when <code>database</code> / <code>redis</code> answers
              </td>
            </tr>
            <tr>
              <td>
                <code>syncle_bridges{'{trigger,enabled}'}</code>,{' '}
                <code>syncle_jobs{'{status}'}</code>
              </td>
              <td>
                bridges by trigger, jobs by status. Alert on{' '}
                <code>syncle_jobs{'{status="failed"}'}</code> rising
              </td>
            </tr>
            <tr>
              <td>
                <code>syncle_deliveries_total{'{status}'}</code>
              </td>
              <td>deliveries recorded by the jobs that still exist</td>
            </tr>
            <tr>
              <td>
                <code>syncle_dead_letter_rows{'{bridge_id,bridge}'}</code>
              </td>
              <td>rows waiting in a bridge&apos;s dead-letter queue</td>
            </tr>
            <tr>
              <td>
                <code>syncle_source_retained_bytes{'{bridge_id,bridge}'}</code>
              </td>
              <td>
                change log a bridge makes its <em>source</em> keep (a
                PostgreSQL slot pinning WAL), as the{' '}
                <a href="/docs/cdc#postgres-slots">slot guard</a> last
                measured it
              </td>
            </tr>
            <tr>
              <td>
                <code>syncle_instance_leader{'{instance}'}</code>
              </td>
              <td>
                1 on the API process that{' '}
                <a href="#more-than-one-api">leads</a>, 0 on the others. Summed
                over every process you scrape it should be exactly 1
              </td>
            </tr>
            <tr>
              <td>
                <code>syncle_build_info{'{version}'}</code>,{' '}
                <code>process_*</code>, <code>nodejs_*</code>
              </td>
              <td>
                the running version; memory, uptime and event-loop lag of the
                API process
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Everything is read from the metadata store at scrape time with
        aggregates over small tables — never a scan of the delivery log — so
        a 15-second scrape interval is fine. Set{' '}
        <code>SYNCLE_LOG_LEVEL=log</code> to have the API also log lifecycle
        events (it logs warnings and errors only by default).
      </p>

      <h3 id="request-origin">Where a request may come from</h3>
      <p>
        The session is a cookie, and a browser sends a cookie with every
        request to the app — also one that <em>another</em> site made it send.{' '}
        <code>SameSite=Lax</code> stops most of that and not all of it (a
        sibling subdomain is the same &quot;site&quot;). So every request that
        changes something — anything but <code>GET</code>, <code>HEAD</code>{' '}
        and <code>OPTIONS</code> — is checked before it reaches a route:
      </p>
      <ul>
        <li>
          <code>Sec-Fetch-Site: same-origin</code>, which every current browser
          sends and no page can set, is the browser&apos;s own word that a page
          of the app made the request;
        </li>
        <li>
          otherwise the <code>Origin</code> header has to be the address the
          app was reached under, or one of <code>WEB_ORIGIN</code>;
        </li>
        <li>
          a request with no <code>Origin</code> at all is not a browser (curl,
          a script with an <a href="/docs/api#api-keys">API key</a>) and is not
          what this is about;
        </li>
        <li>
          anything else is answered <code>403</code> with{' '}
          <code>{'details.reason: "cross-origin"'}</code> — including a login
          with the right password.
        </li>
      </ul>
      <p>
        Every response also says what it is. The API&apos;s are data:{' '}
        <code>nosniff</code>, <code>X-Frame-Options: DENY</code>, a{' '}
        <code>Content-Security-Policy</code> of <code>default-src
        &apos;none&apos;</code>, <code>Cache-Control: no-store</code>, and{' '}
        <code>Strict-Transport-Security</code> when the browser came over
        HTTPS. The web app&apos;s pages allow scripts, styles, fonts and
        workers from the app itself and nowhere else, connections only to the
        app (and to <code>NEXT_PUBLIC_API_URL</code> where that is set), and
        may not be framed. Nothing is loaded from a CDN: the query editor is
        served by the app, so Syncle works on a network with no internet.
        (Inline scripts are allowed — Next.js hydrates through them; what the
        policy takes away is script from <em>another</em> origin.)
      </p>

      <h3 id="alerts">Alerts</h3>
      <p>
        A bridge that stops at three in the morning used to say so in one
        place: its own page. <strong>Settings › Alerts</strong> adds places
        to say it out loud — a <strong>webhook</strong>, a{' '}
        <strong>Slack</strong> incoming webhook, or <strong>e-mail</strong>{' '}
        over your SMTP server — each subscribed to the events it cares about:
      </p>
      <ul>
        <li>
          <code>bridge.failed</code> — a bridge or a replay stopped because
          of a failure (critical), or a run finished with deliveries that
          failed along the way (warning). A stop or a cancel somebody asked
          for is not an alert.
        </li>
        <li>
          <code>bridge.position_lost</code> — a live bridge lost its place
          in the source&apos;s change log and cannot resume without accepting
          a gap.
        </li>
        <li>
          <code>bridge.dead_letters</code> — rows were set aside. The bridge
          carries on, so nothing else would tell you they are waiting.
        </li>
        <li>
          <code>source.hold</code> — a bridge is making its source keep
          change log beyond the warning level. Sent when that gets worse, not
          on every check.
        </li>
        <li>
          <code>bridge.schema_drift</code> — a bridge&apos;s source table is
          no longer the one it was built on. Critical when the bridge uses a
          column that is gone and has stopped rather than write{' '}
          <code>NULL</code> over the copy; a warning when the change is
          harmless (a column added, a type changed). See{' '}
          <a href="/docs/bridges#schema-changes">
            When the source table changes
          </a>
          . (A stop of this kind is this one alert, not a second{' '}
          <code>bridge.failed</code>.)
        </li>
      </ul>
      <p>
        Alerts are <strong>throttled</strong> per channel, kind of event and
        bridge (five minutes by default,{' '}
        <code>SYNCLE_ALERT_THROTTLE_SECONDS</code>): a bridge that fails
        every thirty seconds is one message per window, and the next says how
        many were held back. Sending never blocks or fails a bridge; a
        channel that does not take an alert is tried once more, and the
        outcome of the last send is shown next to the channel. The{' '}
        <strong>Test</strong> button sends one now.
      </p>
      <p>
        A webhook receives the event as JSON —{' '}
        <code>
          {'{ app, version, type, severity, title, message, bridgeId, bridgeName, jobId, at, suppressed? }'}
        </code>{' '}
        — with an <code>X-Syncle-Event</code> header. Give the channel a{' '}
        <strong>signing secret</strong> and every request also carries{' '}
        <code>X-Syncle-Signature: sha256=&lt;hex&gt;</code>, the HMAC-SHA256
        of the exact body bytes, so the receiver can tell a real alert from
        anyone who found the URL:
      </p>
      <CodeBlock title="Verifying an alert (Node.js)">{`const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
const given = req.headers['x-syncle-signature'] ?? '';
const ok = given.length === expected.length &&
  crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));`}</CodeBlock>
      <p>
        A channel&apos;s whole configuration is encrypted at rest with the
        master key — a Slack webhook URL <em>is</em> its credential — and the
        API never hands a secret back: everything after a URL&apos;s origin,
        the signing secret, header values and the SMTP password read as{' '}
        <code>••••••••</code>. Alert requests are held to the same{' '}
        <a href="#destination-guard">destination guard</a> as bridge
        deliveries, and redirects are not followed.
      </p>

      <h2 id="more-than-one-api">Running more than one API process</h2>
      <p>
        One API process is what the compose stack runs, and all most
        installations need. A second one — a replica for availability, or the
        minute during which a rolling deploy overlaps — is safe: the processes
        find each other through the Redis they share, and one of them{' '}
        <strong>leads</strong>.
      </p>
      <ul>
        <li>
          <strong>The leader reads the live (CDC) bridges</strong> and runs the
          periodic sweeps (the slot guard, delivery retention). A source is
          never read by two processes: that used to mean a PostgreSQL slot
          fought over, a MySQL server throwing out one reader after the other
          (both connect under the same replication server id), and on MongoDB
          and Redis every change delivered twice.
        </li>
        <li>
          <strong>Runs, polls, schedules and verifications</strong> are jobs
          on the queue, picked up by whichever process is free — that part
          does scale out. A polling bridge is polled by one process at a time.
        </li>
        <li>
          <strong>Any process can be asked anything.</strong> Start or stop a
          live bridge through a process that does not lead and it is relayed
          to the leader, and answered when the leader has done it. A setting
          saved through one process reaches the others; a cancel reaches the
          process that is running the job; the first-run setup token is the
          same whichever process prints it.
        </li>
        <li>
          <strong>Failover.</strong> The lead is a lease in Redis, renewed
          three times within <code>SYNCLE_LEADER_TTL_SECONDS</code> (default
          20). A leader that is shut down hands it over at once; one that
          dies is replaced when the lease runs out. The new leader resumes
          every live bridge from its saved position — the same thing a restart
          does — so nothing is lost and nothing is delivered twice.
        </li>
      </ul>
      <p>What it needs from you:</p>
      <ul>
        <li>
          the <strong>same</strong> <code>DATABASE_URL</code>,{' '}
          <code>REDIS_URL</code> and <code>SYNCLE_MASTER_KEY</code> on every
          process. A master key generated into one container&apos;s data
          directory is not shared: set it explicitly (the first-run token
          differing between processes is the first sign that it is not);
        </li>
        <li>the same version everywhere, apart from the minutes of a rolling upgrade;</li>
        <li>
          a load balancer in front that can send any request to any process —
          no sticky sessions are needed.
        </li>
      </ul>
      <Note>
        <p>
          A leader that cannot reach Redis for as long as the lease lasts
          assumes another process has taken over, and stops reading the live
          bridges until Redis answers again (they carry on from their saved
          positions). That is also true of a single process: a Redis outage
          longer than <code>SYNCLE_LEADER_TTL_SECONDS</code> pauses live
          bridges — runs, polls and schedules need Redis anyway. Login
          rate limits and alert throttling are counted per process. Settings →{' '}
          <em>API processes</em> lists who is alive and who leads (as does{' '}
          <code>GET /api/settings/instances</code>); with one process, which
          is the usual case, it shows nothing.
        </p>
      </Note>

      <h2 id="backups">What to back up</h2>
      <p>The stack keeps its state in three named Docker volumes:</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Volume</th>
              <th>What it holds</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>syncle-postgres-data</code>
              </td>
              <td>
                The metadata store: workspaces, connections (credentials
                encrypted), bridges, job history and per-row delivery logs.
              </td>
            </tr>
            <tr>
              <td>
                <code>syncle-api-data</code>
              </td>
              <td>
                The API&apos;s local state: the first-run setup token while it
                exists, and the auto-generated master key if{' '}
                <code>SYNCLE_MASTER_KEY</code> was never set.
              </td>
            </tr>
            <tr>
              <td>
                <code>syncle-redis-data</code>
              </td>
              <td>
                The job queue that lets running bridge jobs survive a restart
                and auto-resume.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        A backup of the Postgres volume is only useful together with the master
        key — without it the stored credentials cannot be decrypted. Back up{' '}
        <code>~/.syncle/.env</code> alongside the volumes, and store it
        separately from them if you can.
      </p>
      <p>
        <code>syncle down</code> stops the containers and keeps all three
        volumes. <code>syncle uninstall</code> is the destructive one: it asks{' '}
        <code>{'This deletes all Syncle containers, images and DATA. Continue? [y/N]'}</code>{' '}
        and then runs <code>compose down -v --rmi all</code>, deleting the
        volumes with everything in them.
      </p>

      <h2 id="reporting">Reporting a vulnerability</h2>
      <p>
        Do not open a public issue for security problems. Email{' '}
        <a href="mailto:osmanahmadxai@gmail.com">osmanahmadxai@gmail.com</a>{' '}
        with a description of the issue and its impact, steps to reproduce, and
        any suggested fix. You get an acknowledgement within a few days,
        disclosure timing is coordinated with you, and you are credited in the
        release notes unless you prefer to stay anonymous.
      </p>
      <p>
        Security fixes land on main and the latest release only, so stay on the
        newest release. Always in scope: credential handling, SQL or command
        injection through the adapters, payload-template injection, auth
        bypasses, and SSRF that dodges the destination guard.
      </p>

      <h2 id="troubleshooting">Troubleshooting</h2>
      <ul>
        <li>
          <code>{'Port <n> is already in use. Stop the other process or set PORT.'}</code>{' '}
          — the API found its port taken and exited with code 1. Stop whatever
          holds the port, or change <code>PORT</code> — and keep the web
          app&apos;s proxy target in step with it.
        </li>
        <li>
          Every screen shows <code>Cannot reach the Syncle API</code> — the web
          app&apos;s proxy could not reach the API (it returns a 503 with code{' '}
          <code>NETWORK</code>). The api container is down or still starting;
          check <code>syncle status</code> and <code>syncle logs api</code>.
        </li>
        <li>
          <code>{'Could not refresh images — using what is already downloaded.'}</code>{' '}
          — <code>syncle up</code> could not pull newer images (offline, or the
          registry is unreachable) and started the cached ones instead. Not an
          error; the next successful <code>syncle up</code> or{' '}
          <code>syncle update</code> refreshes them.
        </li>
        <li>
          <code>{'Still starting — check `syncle logs`.'}</code> —{' '}
          <code>syncle up</code> polls the GUI every 2 seconds for up to 60
          attempts and gave up waiting. The containers usually keep starting in
          the background; <code>syncle logs</code> shows what they are doing.
        </li>
        <li>
          <strong>Lost the setup token</strong>, or the process died
          mid-setup — a fresh token is minted on the next boot as long as no
          account exists yet, and <code>syncle logs api</code> prints it.
        </li>
        <li>
          <strong>Logged out everywhere after a password change</strong> —
          deliberate. A password change invalidates all outstanding sessions
          and re-issues only the one that made the change.
        </li>
        <li>
          <strong>Bridges can be built and previewed, but jobs will not
          run</strong> — Redis is down. Only running a job needs Redis;
          connecting databases, browsing and building or previewing{' '}
          <a href="/docs/bridges">bridges</a> all work without it. Check{' '}
          <code>syncle logs redis</code>.
        </li>
        <li>
          <code>SYNCLE_MASTER_KEY must be a base64-encoded 32-byte value</code>{' '}
          — the key is not valid base64 of exactly 32 bytes. On a fresh
          install, generate one with <code>openssl rand -base64 32</code>. If
          data already exists, recover the original key rather than making a
          new one — see <a href="#master-key">above</a>.
        </li>
      </ul>
    </DocArticle>
  );
}
