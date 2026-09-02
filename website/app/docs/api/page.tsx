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
{"data":{"ok":true}}

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
        There are no API keys or bearer tokens — the session cookie is the only
        credential. Exactly four routes work without it:{' '}
        <code>GET /api/health</code>, <code>GET /api/auth/status</code>,{' '}
        <code>POST /api/auth/setup</code> and <code>POST /api/auth/login</code>.
        Everything else answers 401.
      </Note>
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
              <td>Test an unsaved config without storing it</td>
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
                still uses it as source or destination
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
                Ad-hoc query — <code>{'{ statement, params }'}</code>
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
          </tbody>
        </table>
      </div>

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
                <code>{'{ sampleRow?, limit }'}</code>, limit 1–10, default 3
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
                Re-queue the same job to re-send only its failed deliveries
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
                <code>{'{ connectionId, database?, schema?, table }'}</code>;
                see <a href="/docs/cdc">CDC setup</a> for what readiness means
                per engine
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/:id/watch/start</code>
              </td>
              <td>
                Start live listening; routed to CDC or polling watch by the
                bridge&apos;s trigger
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
