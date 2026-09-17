import { CodeBlock } from '@/components/docs/code-block';
import { DocArticle, docMetadata } from '@/components/docs/doc-article';
import { Note } from '@/components/docs/note';

export const metadata = docMetadata('api');

export default function Page() {
  return (
    <DocArticle slug="api">
      <p>
        The web interface has no privileged path into Syncle — everything it
        does goes through the REST API on this page, so anything you can click,
        you can script. Every route lives under <code>/api</code>, requests and
        responses are JSON, and a session cookie is the only authentication.
      </p>

      <h2 id="conventions">Conventions</h2>
      <p>
        The origin that serves the interface serves the API too: the web app
        proxies <code>/api</code> through to the API server, so with a default
        install the base URL is <code>http://localhost:3002/api</code>. The API
        container itself is not published outside the Docker network unless you
        expose it, so go through the web origin — the{' '}
        <a href="/docs/install">installation page</a> covers the ports.
      </p>
      <p>
        Every successful response is wrapped in a <code>data</code> envelope;
        every error is an <code>error</code> object with a machine-readable{' '}
        <code>code</code>, a human <code>message</code>, and a{' '}
        <code>details</code> field that is <code>null</code> unless the error
        carries extra data:
      </p>
      <CodeBlock>{`$ curl http://localhost:3002/api/health
{"data":{"ok":true,"checks":{"database":"ok","redis":"ok"}}}

$ curl http://localhost:3002/api/connections
{"error":{"code":"UNAUTHORIZED","message":"Authentication required","details":null}}`}</CodeBlock>
      <p>
        Scripts should branch on the code, not the HTTP status alone — two
        codes share status 400:
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Status</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>BAD_REQUEST</code>
              </td>
              <td>400</td>
              <td>Invalid body or query parameter (schema validation)</td>
            </tr>
            <tr>
              <td>
                <code>QUERY_FAILED</code>
              </td>
              <td>400</td>
              <td>The target database rejected a statement</td>
            </tr>
            <tr>
              <td>
                <code>UNAUTHORIZED</code>
              </td>
              <td>401</td>
              <td>No valid session cookie</td>
            </tr>
            <tr>
              <td>
                <code>FORBIDDEN</code>
              </td>
              <td>403</td>
              <td>Signed in, but not allowed to do this</td>
            </tr>
            <tr>
              <td>
                <code>NOT_FOUND</code>
              </td>
              <td>404</td>
              <td>No such resource</td>
            </tr>
            <tr>
              <td>
                <code>CONFLICT</code>
              </td>
              <td>409</td>
              <td>
                The request contradicts current state, such as deleting a
                connection a bridge still uses
              </td>
            </tr>
            <tr>
              <td>
                <code>RATE_LIMITED</code>
              </td>
              <td>429</td>
              <td>Too many login or setup attempts; wait and retry</td>
            </tr>
            <tr>
              <td>
                <code>INTERNAL</code>
              </td>
              <td>500</td>
              <td>Unexpected error</td>
            </tr>
            <tr>
              <td>
                <code>UNSUPPORTED</code>
              </td>
              <td>501</td>
              <td>The engine cannot do what was asked</td>
            </tr>
            <tr>
              <td>
                <code>CONNECTION_FAILED</code>
              </td>
              <td>502</td>
              <td>The target database could not be reached</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="authentication">Authentication</h2>
      <p>
        Syncle has a single admin account, created on first run with the setup
        token (the <a href="/docs/quickstart">quickstart</a> walks through
        that). Signing in sets <code>db_session</code>, a signed httpOnly
        cookie with <code>SameSite=Lax</code>, valid for the{' '}
        <code>sessionTtlMinutes</code> setting — one week by default. Keep it
        in a cookie jar and send it back on every call:
      </p>
      <CodeBlock>{`# sign in once, keeping the cookie
curl -c cookies.txt -H 'Content-Type: application/json' \\
  -d '{"username":"admin","password":"your-password"}' \\
  http://localhost:3002/api/auth/login

# every later call sends it back
curl -b cookies.txt http://localhost:3002/api/bridges`}</CodeBlock>
      <Note>
        Two credentials reach the API: the session cookie of whoever signed
        in, and an <a href="#api-keys">API key</a> for what cannot sign in. A
        handful of routes work without either: the two probes{' '}
        <code>GET /api/health</code> and <code>GET /api/health/ready</code>,{' '}
        <code>GET /api/auth/status</code>, <code>POST /api/auth/setup</code>,{' '}
        <code>POST /api/auth/login</code>, and the two a locked-out operator
        needs: <code>POST /api/auth/reset/request</code> (answers{' '}
        <code>202</code> and says nothing; if there is an account, a one-time
        code is printed on the server&apos;s console and written to{' '}
        <code>reset-code</code> in its data directory) and{' '}
        <code>POST /api/auth/reset</code> with{' '}
        <code>{'{ resetCode, newPassword }'}</code> (sets the password, signs
        in, ends every other session). <code>GET /api/metrics</code>{' '}
        takes a bearer token of its own instead of a session (and does not
        exist until one is configured). Everything else answers 401.
      </Note>
      <p>
        <code>GET /api/version</code> says which release is running —{' '}
        <code>{'{ version, source, node }'}</code>, where <code>source</code>{' '}
        is <code>build</code> when the container image carried the version of
        the release tag it was built from, and <code>package</code> for a
        source checkout. It is behind the login on purpose: the public health
        probe says nothing beyond &quot;up&quot;, and a version number is what
        someone scanning for a known flaw wants to read without asking. The
        same line is at the bottom of the Settings dialog.
      </p>
      <p>
        Repeated failed logins lock the account out per IP and username and
        answer 429 with code <code>RATE_LIMITED</code>; setup attempts are
        limited per IP. Changing the password invalidates every outstanding
        session at once — the response re-issues the cookie for the session
        that made the change.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Endpoint</th>
              <th>Body</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>GET /api/auth/status</code>
              </td>
              <td>—</td>
              <td>
                Returns <code>{'{ needsSetup, authenticated, user }'}</code>;
                public, so a client can decide which screen to show
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/auth/setup</code>
              </td>
              <td>
                <code>{'{ username, password, setupToken }'}</code>
              </td>
              <td>Create the admin account on first run and sign in</td>
            </tr>
            <tr>
              <td>
                <code>POST /api/auth/login</code>
              </td>
              <td>
                <code>{'{ username, password }'}</code>
              </td>
              <td>Sign in; sets the session cookie</td>
            </tr>
            <tr>
              <td>
                <code>POST /api/auth/logout</code>
              </td>
              <td>—</td>
              <td>Clear the cookie</td>
            </tr>
            <tr>
              <td>
                <code>GET /api/auth/me</code>
              </td>
              <td>—</td>
              <td>The signed-in user</td>
            </tr>
            <tr>
              <td>
                <code>POST /api/auth/change-password</code>
              </td>
              <td>
                <code>{'{ currentPassword, newPassword }'}</code>
              </td>
              <td>Change the password; invalidates all other sessions</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="workspaces">Workspaces</h2>
      <p>
        Workspaces are the top-level container for connections and bridges. A
        default workspace always exists, so you only meet these routes once you
        create a second one.
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
                <code>GET /api/workspaces</code>
              </td>
              <td>List workspaces</td>
            </tr>
            <tr>
              <td>
                <code>POST /api/workspaces</code>
              </td>
              <td>
                Create one — <code>{'{ name, color? }'}</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>GET /api/workspaces/:id</code>
              </td>
              <td>Fetch one</td>
            </tr>
            <tr>
              <td>
                <code>PUT /api/workspaces/:id</code>
              </td>
              <td>Update name or color</td>
            </tr>
            <tr>
              <td>
                <code>DELETE /api/workspaces/:id</code>
              </td>
              <td>
                Tears down every bridge inside — CDC slots dropped, watchers
                stopped, in-flight jobs canceled — then deletes the workspace
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="connections">Connections</h2>
      <p>
        A connection is a saved database config. Passwords, SSH secrets and
        connection strings are encrypted at rest and redacted in every
        response. Routes that touch data accept a <code>?database=</code> query
        parameter to address one database on the server; leave it off to use
        the connection&apos;s default.
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
                <code>GET /api/connections?workspaceId=</code>
              </td>
              <td>List connections</td>
            </tr>
            <tr>
              <td>
                <code>POST /api/connections</code>
              </td>
              <td>Create one</td>
            </tr>
            <tr>
              <td>
                <code>POST /api/connections/test</code>
              </td>
              <td>
                Test an unsaved config without storing it. Add{' '}
                <code>?from=:id</code> when it is an edit of a saved
                connection: secrets sent back redacted are then taken from the
                stored copy. Returns <code>{'{ success, sshHostKey? }'}</code>{' '}
                — the jump host&apos;s fingerprint, when a tunnel was used. The
                body takes <code>tls</code> (<code>mode</code>:{' '}
                <code>disable</code> | <code>require</code> |{' '}
                <code>verify-ca</code> | <code>verify-full</code>, with
                optional PEM <code>ca</code>, <code>cert</code>,{' '}
                <code>key</code> and a <code>servername</code>) and{' '}
                <code>ssh.hostKey</code>, as every connection body does
              </td>
            </tr>
            <tr>
              <td>
                <code>GET /api/connections/:id</code>
              </td>
              <td>Fetch one</td>
            </tr>
            <tr>
              <td>
                <code>PUT /api/connections/:id</code>
              </td>
              <td>Update; any pooled connection is evicted</td>
            </tr>
            <tr>
              <td>
                <code>DELETE /api/connections/:id</code>
              </td>
              <td>
                Delete — answers 409 <code>CONFLICT</code> while any bridge
                still uses it as source or destination, or while Syncle still
                has a replication slot to remove through it (
                <code>?force=true</code> deletes it regardless; drop the slot
                on the server yourself first)
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/connections/:id/test</code>
              </td>
              <td>Test a saved connection</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 id="data-operations">Data operations</h3>
      <p>
        These are the routes behind the{' '}
        <a href="/docs/workbench">database workbench</a>. What each engine
        supports varies — the driver&apos;s capability flags say which of them
        apply.
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
                <code>GET /api/connections/:id/databases</code>
              </td>
              <td>List databases on the server</td>
            </tr>
            <tr>
              <td>
                <code>GET /api/connections/:id/schema?database=</code>
              </td>
              <td>Introspect tables, columns, keys and indexes</td>
            </tr>
            <tr>
              <td>
                <code>POST /api/connections/:id/browse?database=</code>
              </td>
              <td>
                Paged reads with filters and sort; <code>limit</code> 1–1000,
                default 100
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/connections/:id/query?database=</code>
              </td>
              <td>
                Ad-hoc query — <code>{'{ statement, params }'}</code>. On a
                connection saved with <code>readOnly: true</code> the
                statement runs only when every part of it is recognisably a
                read (otherwise 403), and the engine holds it to reading too;
                every route below that writes answers 403 on such a
                connection. See{' '}
                <a href="/docs/workbench#production-and-read-only">
                  production, and read-only
                </a>
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/connections/:id/rows</code>
              </td>
              <td>Insert a row</td>
            </tr>
            <tr>
              <td>
                <code>PATCH /api/connections/:id/rows</code>
              </td>
              <td>Update a row, identified by its primary key values</td>
            </tr>
            <tr>
              <td>
                <code>DELETE /api/connections/:id/rows</code>
              </td>
              <td>Delete a row</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 id="ddl-backup-and-restore">DDL, backup and restore</h3>
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
                <code>POST /api/connections/:id/ddl/database</code>
              </td>
              <td>
                Create a database — <code>{'{ name }'}</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/connections/:id/ddl/drop-database</code>
              </td>
              <td>Drop a database (pooled connections to it close first)</td>
            </tr>
            <tr>
              <td>
                <code>POST /api/connections/:id/ddl/table?database=</code>
              </td>
              <td>Create a table from a column-definition list</td>
            </tr>
            <tr>
              <td>
                <code>POST /api/connections/:id/ddl/drop-table?database=</code>
              </td>
              <td>
                Drop a table — <code>{'{ table, schema? }'}</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>
                  POST /api/connections/:id/ddl/truncate-table?database=
                </code>
              </td>
              <td>Truncate a table</td>
            </tr>
            <tr>
              <td>
                <code>POST /api/connections/:id/backup?database=</code>
              </td>
              <td>
                Dump a database; returns{' '}
                <code>{'{ filename, format, content }'}</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/connections/:id/restore?database=</code>
              </td>
              <td>
                Restore from <code>{'{ content, format }'}</code>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Backups come in two formats: <code>json</code>, a portable dump any
        engine can read back, and <code>sql</code>, a DDL-plus-INSERT script
        for relational engines only — MongoDB and Redis support just{' '}
        <code>json</code>.
      </p>

      <h2 id="drivers-and-settings">Drivers and settings</h2>
      <p>
        <code>GET /api/drivers</code> lists the five supported engines with
        their labels, default ports, capability flags and the fields their
        connection forms need — the interface builds its connection dialog
        from this list, and a script can do the same.
      </p>
      <p>
        <code>GET /api/settings</code> returns the resolved app settings
        (stored overrides merged over defaults);{' '}
        <code>PUT /api/settings</code> applies a partial update. The{' '}
        <a href="/docs/configuration">configuration page</a> documents each
        setting and its default.
      </p>

      <h3 id="api-keys">API keys</h3>
      <p>
        A script or a CI job should not be given the operator&apos;s
        password. Create a key in <strong>Settings › Security</strong> and
        send it as a bearer token:
      </p>
      <CodeBlock>{`$ curl -H "Authorization: Bearer syn_…" http://localhost:3002/api/bridges`}</CodeBlock>
      <ul>
        <li>
          The key is shown <strong>once</strong>, when it is created. What is
          stored is its SHA-256 — the key is 32 random bytes, so there is
          nothing to brute-force, and a copy of the metadata store yields no
          usable key. Lost keys are revoked and replaced, not recovered.
        </li>
        <li>
          <strong>Scope.</strong> <code>read</code> may <code>GET</code> and
          nothing else — not even a <code>POST</code> that only reads, so
          that what a read key can do is answerable by looking at the verb.{' '}
          <code>full</code> may do what the operator can, <em>except</em>{' '}
          anything about credentials: no key of any scope can list, create or
          revoke keys, change the password, or end sessions (403). A leaked
          key cannot mint more keys or lock you out.
        </li>
        <li>
          A key can be given an expiry; a revoked or expired key answers 401
          at once. Revoked keys stay in the list, crossed out, with when they
          were last used — so &quot;which key was that?&quot; has an answer.
        </li>
      </ul>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Endpoint (signed in only)</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>GET /api/auth/api-keys</code>
              </td>
              <td>List keys: name, how each starts, scope, expiry, last use</td>
            </tr>
            <tr>
              <td>
                <code>POST /api/auth/api-keys</code>
              </td>
              <td>
                <code>{'{ name, scope, expiresInDays? }'}</code> — the answer
                carries <code>key</code>, this once
              </td>
            </tr>
            <tr>
              <td>
                <code>DELETE /api/auth/api-keys/:id</code>
              </td>
              <td>Revoke</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="monitoring">Health, metrics and alerts</h2>
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
                <code>GET /api/health</code>
              </td>
              <td>
                Is the API alive, and can it reach its metadata store? 200 —
                or 503 when the store is unreachable — with{' '}
                <code>{'{ ok, checks: { database, redis } }'}</code>. It{' '}
                <em>reports</em> Redis without failing on it: what a
                container health check should use. Public
              </td>
            </tr>
            <tr>
              <td>
                <code>GET /api/health/ready</code>
              </td>
              <td>
                Can it do everything? 503 unless the store <em>and</em> Redis
                answer (replays, polling bridges and the CDC spool run on
                Redis). What an uptime monitor or a load balancer should use.
                Public
              </td>
            </tr>
            <tr>
              <td>
                <code>GET /api/metrics</code>
              </td>
              <td>
                Prometheus text format. Exists only when{' '}
                <code>SYNCLE_METRICS_TOKEN</code> is set (404 otherwise) and
                answers only to <code>Authorization: Bearer &lt;token&gt;</code>
                . See <a href="/docs/self-hosting#monitoring">monitoring</a>{' '}
                for what it exposes
              </td>
            </tr>
            <tr>
              <td>
                <code>GET /api/alerts/channels</code>
              </td>
              <td>
                Alert channels. Secrets — everything after a URL&apos;s
                origin, a signing secret, header values, an SMTP password —
                come back as <code>••••••••</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/alerts/channels</code>,{' '}
                <code>PUT …/:id</code>, <code>DELETE …/:id</code>
              </td>
              <td>
                Create, replace, delete. On a <code>PUT</code>, a secret sent
                back as <code>••••••••</code> keeps what is stored; a mask
                with nothing stored behind it is refused. Kinds:{' '}
                <code>webhook</code> (<code>url</code>, optional{' '}
                <code>headers</code> and <code>secret</code>),{' '}
                <code>slack</code> (<code>url</code>), <code>email</code> (
                <code>smtp</code>, <code>from</code>, <code>to</code>); each
                with <code>name</code>, <code>enabled</code> and{' '}
                <code>events</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/alerts/channels/:id/test</code>
              </td>
              <td>
                Sends a test alert through the channel as stored; answers{' '}
                <code>{'{ ok, detail }'}</code> and records the outcome on the
                channel
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="bridges">Bridges</h2>
      <p>
        A bridge is the saved sync path, a job is one execution of it, and a
        delivery is one row or batch within a job —{' '}
        <a href="/docs/bridges">how bridges work</a> covers the model. The
        routes below manage all three.
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
                <code>GET /api/bridges?workspaceId=</code>
              </td>
              <td>List bridges</td>
            </tr>
            <tr>
              <td>
                <code>GET /api/bridges/statuses?workspaceId=</code>
              </td>
              <td>Latest job status per bridge, in one call</td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges</code>
              </td>
              <td>
                Create a bridge; a draft job is prepared so the timeline shows
                the planned deliveries right away
              </td>
            </tr>
            <tr>
              <td>
                <code>GET /api/bridges/:id</code>
              </td>
              <td>Fetch one</td>
            </tr>
            <tr>
              <td>
                <code>PUT /api/bridges/:id</code>
              </td>
              <td>
                Update; a live watch or CDC listener is stopped first and
                restarted on the new config
              </td>
            </tr>
            <tr>
              <td>
                <code>DELETE /api/bridges/:id</code>
              </td>
              <td>Full lifecycle teardown, then delete</td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/bulk</code>
              </td>
              <td>
                One bridge per table, for many tables at once. Body{' '}
                <code>
                  {'{ source: { connectionId, database?, schema?, tables: [...] }, destination: { connectionId, database?, schema?, tablePrefix? }, trigger: { kind: "cdc", startFrom?, slot? } | { kind: "replay" }, delivery? }'}
                </code>
                . Each table is copied as it is into <code>tablePrefix + table</code>,
                keyed by its primary key; on PostgreSQL the bridges{' '}
                <a href="/docs/cdc#shared-slot">share one replication slot</a>{' '}
                unless <code>{'slot: "own"'}</code>. Answers{' '}
                <code>{'{ created: [{ id, name, table }], skipped: [{ table, reason }] }'}</code>{' '}
                — a table with no primary key, or one that cannot be read, is
                skipped with the reason and does not stop the others. Nothing
                is started
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/:id/clone</code>
              </td>
              <td>
                A copy under a new name, credential included (it never
                leaves the instance); no job, no position
              </td>
            </tr>
            <tr>
              <td>
                <code>GET /api/bridges/:id/export</code>,{' '}
                <code>GET /api/bridges/export?workspaceId=</code>
              </td>
              <td>
                One bridge, or a workspace&apos;s, as a document —{' '}
                <a href="/docs/bridges#export-import">no secret is in it</a>
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/import</code>
              </td>
              <td>
                <code>{'{ document, connectionMap?, workspaceId? }'}</code>.
                All or nothing. 400 with{' '}
                <code>{'details.reason = "unresolved-connections"'}</code>{' '}
                and the candidates when the file refers to a connection this
                instance has no obvious counterpart for
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p>
        The body of a create or an update is the bridge&apos;s whole
        configuration. Its source can carry <code>filters</code> (ANDed;
        operators <code>eq</code>, <code>neq</code>, <code>gt</code>,{' '}
        <code>gte</code>, <code>lt</code>, <code>lte</code>,{' '}
        <code>contains</code>, <code>startsWith</code>,{' '}
        <code>endsWith</code>, <code>in</code>, <code>isNull</code>,{' '}
        <code>notNull</code>), and its <code>transform.columns</code> is the
        ordered list of{' '}
        <a href="/docs/bridges#column-transforms">column transforms</a> — at
        most 100, each one of the five kinds below. A kind the server does
        not know is refused with a <code>400</code>, never ignored.
      </p>
      <p>
        A CDC trigger is{' '}
        <code>{'{ "kind": "cdc", "operations": [...], "startFrom": "now" | "beginning" }'}</code>
        . <code>beginning</code>{' '}
        <a href="/docs/bridges#copy-then-follow">
          copies the table, then follows its changes
        </a>{' '}
        with nothing lost in between; <code>now</code> (the default, and what
        every bridge saved before this option existed is) follows changes
        only.
      </p>
      <CodeBlock title="Filters and column transforms in a bridge body">{`{
  "source": {
    "kind": "table", "connectionId": "…", "table": "customers",
    "filters": [
      { "column": "age", "operator": "gte", "value": 18 },
      { "column": "deleted_at", "operator": "isNull" }
    ]
  },
  "transform": {
    "columns": [
      { "kind": "text", "column": "email", "op": "lower" },
      { "kind": "mask", "column": "email", "mode": "hash", "salt": "…" },
      { "kind": "mask", "column": "card", "mode": "partial", "keepStart": 0, "keepEnd": 4, "fill": "*" },
      { "kind": "cast", "column": "joined", "to": "date", "onError": "null" },
      { "kind": "default", "column": "tier", "value": "standard" },
      { "kind": "set", "column": "full_name", "template": "{{first}} {{last}}" }
    ]
  }
}`}</CodeBlock>
      <p>
        <code>mask.mode</code> is <code>partial</code>, <code>redact</code>,{' '}
        <code>hash</code> or <code>null</code>; <code>cast.to</code> is{' '}
        <code>string</code>, <code>number</code>, <code>integer</code>,{' '}
        <code>boolean</code>, <code>date</code> or <code>json</code>, and its{' '}
        <code>onError</code> is <code>fail</code> (the default),{' '}
        <code>null</code> or <code>keep</code>; <code>text.op</code> is{' '}
        <code>trim</code>, <code>lower</code> or <code>upper</code>. A column
        that a <code>set</code> or a <code>default</code> adds has to be named
        in <code>transform.fields</code> (when that list is pinned) and in a
        database target&apos;s <code>mapping</code> to be delivered, like any
        other column.
      </p>

      <h3 id="jobs-and-deliveries">Jobs and deliveries</h3>
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
                <code>POST /api/bridges/:id/preview</code>
              </td>
              <td>
                Render what would be delivered without delivering — body{' '}
                <code>{'{ sampleRow?, limit }'}</code>, limit 1–10, default 3.
                For a database destination each target also reports{' '}
                <code>exists</code> and, when a run would create the table,{' '}
                <code>plannedColumns</code> (name, source type, target type,
                nullable, primary key); <code>warnings</code> names every
                column the target cannot hold faithfully. Read-only: nothing
                is created
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/preview</code>
              </td>
              <td>
                The same dry run for a bridge that is <em>not saved</em> —
                body <code>{'{ bridge, sampleRow?, limit }'}</code>, where{' '}
                <code>bridge</code> is exactly what <code>POST /api/bridges</code>{' '}
                takes. This is what the builder&apos;s <strong>Dry run</strong>{' '}
                button calls. Nothing is stored, created or delivered
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/:id/jobs</code>
              </td>
              <td>
                Start a job; the body may carry <code>resumeJobId</code>,{' '}
                <code>jobId</code> (start a prepared draft) or{' '}
                <code>retryFailedOf</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>GET /api/bridges/:id/jobs</code>
              </td>
              <td>List jobs</td>
            </tr>
            <tr>
              <td>
                <code>GET /api/bridges/:id/jobs/:jobId</code>
              </td>
              <td>Job detail — status, counts, cursor, error</td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/:id/jobs/:jobId/retry-failed</code>
              </td>
              <td>
                Re-queue the same job to re-send only its failed deliveries.
                On a watch or CDC bridge whose failed rows are in the
                dead-letter queue, retries the queue instead — without
                stopping the bridge. A replay that had <em>stopped</em> at a
                failure (on failure: abort) then carries on from where it
                stopped: the rows after the failure were never read, and
                &quot;completed&quot; has to mean them too
              </td>
            </tr>
            <tr>
              <td>
                <code>
                  POST /api/bridges/:id/jobs/:jobId/deliveries/:sequence/retry
                </code>
              </td>
              <td>
                Retry one failed delivery, now; answers with the delivery as
                it is afterwards. Rows a live bridge set aside are retried
                from its dead-letter queue (re-read from the source);
                anything else is re-sent from what was captured. 400 unless
                the delivery is <code>failed</code>, 409 while the job is
                active
              </td>
            </tr>
            <tr>
              <td>
                <code>
                  GET /api/bridges/:id/jobs/:jobId/failures?format=csv|ndjson
                </code>
              </td>
              <td>
                The job&apos;s failed deliveries as a file download:
                sequence, operation, row count, the rows&apos; keys,
                attempts, HTTP status, error, time and the payload that was
                sent. Streamed, so a job with very many failures is fine. CSV
                cells that would be read as a formula by a spreadsheet are
                neutralised with a leading apostrophe
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/:id/jobs/:jobId/cancel</code>
              </td>
              <td>
                Cancel; for a watch or CDC job this stops the listener and the
                job pauses, keeping its cursor
              </td>
            </tr>
            <tr>
              <td>
                <code>GET /api/bridges/:id/jobs/:jobId/deliveries</code>
              </td>
              <td>
                Delivery list; filters <code>status=</code> (one of{' '}
                <code>success</code>, <code>failed</code>, <code>skipped</code>
                ), <code>from</code>, <code>to</code>, <code>offset</code>,{' '}
                <code>limit</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/:id/jobs/:jobId/skip</code>
              </td>
              <td>
                Skip queued deliveries by <code>{'{ sequences }'}</code>;
                returns <code>{'{ skipped }'}</code>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        The numeric delivery-list parameters must be non-negative integers —
        anything else is a 400, not an empty result. Skipping only affects
        deliveries that are still queued.
      </p>

      <h3 id="dead-letters">Dead letters</h3>
      <p>
        Rows a watch or CDC bridge could not deliver under{' '}
        <code>onError: continue</code>, kept in full.{' '}
        <a href="/docs/bridges#when-a-delivery-fails">How bridges work</a>{' '}
        explains when a row lands here and what a retry does.
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
                <code>GET /api/bridges/:id/dead-letters</code>
              </td>
              <td>
                Newest first; filters <code>status=</code> (one of{' '}
                <code>pending</code>, <code>resolved</code>,{' '}
                <code>discarded</code>), <code>offset</code>,{' '}
                <code>limit</code> (default 100, at most 500). Returns{' '}
                <code>{'{ items, pendingEntries, pendingRows }'}</code> — the
                two counts cover the whole bridge, not just the page
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/:id/dead-letters/retry</code>
              </td>
              <td>
                Body <code>{'{ ids?, force? }'}</code>. Omit <code>ids</code>{' '}
                to retry every pending entry (up to 500 per call, oldest
                first). Returns{' '}
                <code>{'{ resolved, stillFailing, needsForce }'}</code>. Safe
                while the bridge is running; a second call while one is in
                progress is a 409
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/:id/dead-letters/discard</code>
              </td>
              <td>
                Body <code>{'{ ids? }'}</code>. Marks pending entries as never
                to be delivered; returns <code>{'{ discarded }'}</code>. The
                entries stay on record and their delivery stays failed
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Each item carries <code>op</code> (<code>insert</code>,{' '}
        <code>update</code>, <code>delete</code>, or <code>null</code> for a
        watch bridge), the source <code>rows</code> as read,{' '}
        <code>error</code>, <code>attempts</code>, the{' '}
        <code>sequence</code> of the delivery it came from, and{' '}
        <code>needsForce</code>. In <code>rows</code>, binary values are
        shown as a byte count rather than dumped; the stored copy is
        complete. An entry with <code>needsForce: true</code> was left alone
        by a plain retry because its source row is gone and the bridge does
        not propagate deletes — send <code>force: true</code> to write the
        recorded row anyway, or discard it.
      </p>

      <h3 id="live-listening">Live listening</h3>
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
              <td>
                Probe whether a source can do CDC —{' '}
                <code>{'{ connectionId, database?, schema?, table, bridgeId? }'}</code>
                . Pass <code>bridgeId</code> for a bridge that already exists,
                so that the replication slot it owns is not counted against
                it. Besides <code>checks</code> and <code>instructions</code>{' '}
                the answer may carry <code>advisories</code>: things that do
                not block a start but are worth knowing first. See{' '}
                <a href="/docs/cdc">CDC setup</a> for what readiness means per
                engine
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/:id/watch/start</code>
              </td>
              <td>
                Start live listening; routed to CDC or polling watch by the
                bridge&apos;s trigger. If the bridge&apos;s place in the
                source&apos;s change log is gone, it answers 400 with{' '}
                <code>{'details: { reason: "position-lost" }'}</code>; send{' '}
                <code>{'{ "fromNow": true }'}</code> to continue from the
                current position and accept the gap. On a CDC bridge whose
                trigger has <code>startFrom: &quot;beginning&quot;</code>, add{' '}
                <code>{'"recopy": true'}</code> to{' '}
                <a href="/docs/bridges#copy-then-follow">copy the table again</a>{' '}
                first; without it, &quot;from now&quot; copies nothing
              </td>
            </tr>
            <tr>
              <td>
                <code>GET /api/bridges/:id/source-hold</code>
              </td>
              <td>
                What a CDC bridge is holding on its source —{' '}
                <code>
                  {'{ kind, name, exists, active, retainedBytes, limitBytes, status, level, message, running }'}
                </code>
                , or <code>null</code> when it holds nothing. For PostgreSQL,{' '}
                <code>retainedBytes</code> is the WAL pinned by the
                bridge&apos;s replication slot
              </td>
            </tr>
            <tr>
              <td>
                <code>GET /api/bridges/:id/schema-drift</code>
              </td>
              <td>
                Has the source table{' '}
                <a href="/docs/bridges#schema-changes">changed</a> since the
                bridge was set up —{' '}
                <code>
                  {'{ baselineAt, checkedAt, drift: { added, removed, retyped } | null, missingUsed }'}
                </code>
                . <code>missingUsed</code> lists the columns the bridge uses
                that the table no longer has: not empty means the bridge will
                not run. Reads the source; changes nothing
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/:id/schema-drift/accept</code>
              </td>
              <td>
                The table as it is now becomes what the bridge is built for.{' '}
                <code>400</code> with{' '}
                <code>{'details.reason: "schema-drift"'}</code> and{' '}
                <code>details.missingUsed</code> while the bridge still uses a
                column that is gone — edit the bridge instead; a{' '}
                <code>PUT</code> that no longer uses it accepts the table. The
                same <code>reason</code> comes back from{' '}
                <code>watch/start</code> when a live bridge is refused for it
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/:id/verify</code>
              </td>
              <td>
                Start a{' '}
                <a href="/docs/bridges#verify">verification</a> in the
                background. Body{' '}
                <code>{'{ mode: "verify" | "reconcile", deleteExtra?: boolean }'}</code>
                ; answers <code>202</code> with the verification. <code>400</code>{' '}
                (<code>{'details.reason: "not-verifiable"'}</code>) for a
                bridge with a query source or an HTTP destination,{' '}
                <code>409</code> while one is running or a replay of the bridge
                is
              </td>
            </tr>
            <tr>
              <td>
                <code>GET /api/bridges/:id/verifications[/:verificationId]</code>
              </td>
              <td>
                The last ten, newest first — or one. Each:{' '}
                <code>
                  {'{ id, mode, status, sourceRows, sourceTotal, inSync, error, targets: [{ target, unsupported, notes, checked, missing, different, extra, fixed, removed, samples }] }'}
                </code>
                . <code>inSync</code> is <code>null</code> until it has
                completed; <code>extra</code> is <code>null</code> when rows
                that are only in the destination were not looked for. Poll this
                for progress
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/:id/verifications/:verificationId/cancel</code>
              </td>
              <td>Stop one that is queued or running</td>
            </tr>
            <tr>
              <td>
                <code>GET /api/bridges/:id/schedule</code>
              </td>
              <td>
                A replay bridge&apos;s{' '}
                <a href="/docs/bridges#scheduled-replays">schedule</a> —{' '}
                <code>
                  {'{ schedule, active, nextRuns, lastTickAt, lastOutcome, lastError }'}
                </code>
                . <code>active</code> is whether it is registered and firing;{' '}
                <code>lastOutcome</code> is <code>started</code>,{' '}
                <code>skipped-active</code> (the run before was still going)
                or <code>failed</code>. The schedule itself is part of the
                bridge: set it with <code>trigger.schedule</code> on{' '}
                <code>POST</code>/<code>PUT /api/bridges</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/schedule-preview</code>
              </td>
              <td>
                <code>{'{ cron, timezone }'}</code> →{' '}
                <code>{'{ nextRuns: [5 ISO times] }'}</code>, worked out by the
                library that fires schedules. <code>400</code> with the reason
                for a line or a zone that cannot be used
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/retention/run</code>
              </td>
              <td>
                Apply the{' '}
                <a href="/docs/configuration#delivery-history">
                  delivery-history retention
                </a>{' '}
                now instead of at the next hourly sweep. Answers{' '}
                <code>
                  {'{ expiredDeliveries, overflowDeliveries, deadLetters, jobsEmptied, limited }'}
                </code>
                ; <code>limited</code> means the sweep stopped at its
                500,000-row limit and the rest goes next time
              </td>
            </tr>
            <tr>
              <td>
                <code>GET /api/bridges/cdc/cleanups</code>
              </td>
              <td>
                Replication slots of deleted or edited bridges that could not
                be dropped yet. They are retried every minute;{' '}
                <code>POST /api/bridges/cdc/cleanups/retry</code> tries now,
                and <code>DELETE /api/bridges/cdc/cleanups/:id</code> stops
                tracking one you removed by hand
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/:id/watch/stop</code>
              </td>
              <td>Stop listening and return the finalized job</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="limits">Limits</h2>
      <ul>
        <li>
          JSON request bodies cap at <strong>50 MB</strong> — sized so backup
          and restore payloads, which carry whole dumps, fit.
        </li>
        <li>
          Ad-hoc query results cap at the <code>maxQueryRows</code> setting,
          default <strong>5000</strong> rows; the{' '}
          <a href="/docs/configuration">configuration page</a> covers raising
          it globally or per connection.
        </li>
        <li>
          Browse pages return at most <strong>1000</strong> rows per request
          (default 100).
        </li>
        <li>
          A single skip call accepts at most <strong>10,000</strong> sequence
          numbers.
        </li>
      </ul>
    </DocArticle>
  );
}
