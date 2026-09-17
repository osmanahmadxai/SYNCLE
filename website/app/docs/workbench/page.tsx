import { CodeBlock } from '@/components/docs/code-block';
import { DocArticle, docMetadata } from '@/components/docs/doc-article';
import { Note } from '@/components/docs/note';
import { Shot } from '@/components/shot';

export const metadata = docMetadata('workbench');

export default function Page() {
  return (
    <DocArticle slug="workbench">
      <p>
        The Data sources overlay is a full database workbench: every connection
        you add for syncing can also be browsed, queried, edited, diagrammed,
        backed up and restored from the same place. Open it with the Data
        sources button at the top of the sidebar; close it with Done.
      </p>

      <h2 id="one-overlay-four-tabs">One overlay, four tabs</h2>
      <p>
        The overlay splits in two. The left side lists your connections and,
        under each one, a schema tree of databases and tables. The right side
        has four tabs that act on whatever the tree has selected:{' '}
        <strong>Data</strong> (a row grid), <strong>Structure</strong>,{' '}
        <strong>Query</strong> and <strong>Diagram</strong>. The open state
        persists in the URL as <code>?data=1</code>, so a reload brings the
        workbench back. Connections belong to the active workspace and are the
        same connections the bridge builder uses — the{' '}
        <a href="/docs/quickstart">quickstart</a> walks through creating one.
      </p>
      <p>
        Five engines are supported: PostgreSQL (default port 5432),
        MySQL/MariaDB (3306), SQLite (a file path instead of a host), MongoDB
        (27017, with an optional connection URI for Atlas) and Redis (6379,
        plus a logical database index 0–15). The connection dialog has a Test
        button that tries the connection before saving, and credentials are
        encrypted at rest.
      </p>

      <h2 id="browsing-and-editing-rows">Browsing and editing rows</h2>
      <p>
        The Data tab reads through{' '}
        <code>POST /api/connections/:id/browse</code>: paginated, sortable, and
        filterable with any number of conditions. The page size is selectable
        — 25, 50, 100 (the default), 250 or 500 rows — and the server caps a
        single page at 1000. Filter operators are <code>eq</code>,{' '}
        <code>neq</code>, <code>lt</code>, <code>lte</code>, <code>gt</code>,{' '}
        <code>gte</code>, <code>contains</code>, <code>startsWith</code>,{' '}
        <code>endsWith</code>, <code>isNull</code>, <code>notNull</code> and{' '}
        <code>in</code>.
      </p>
      <p>
        Editing goes through a row editor dialog: insert a new row, or update
        and delete existing ones. Rows are identified by primary key, so
        editing is only offered when the engine supports row editing and the
        table actually has a primary key. The export buttons write the rows
        currently in the grid to CSV or JSON entirely in the browser — no
        server round-trip, so what you export is exactly the page you are
        looking at.
      </p>

      <h2 id="the-query-editor">The query editor</h2>
      <p>
        The Query tab is a multi-tab Monaco editor. Tabs keep their content
        when you switch views, autocomplete draws on the connection&apos;s
        schema, and Cmd/Ctrl+Enter runs the active tab. What you write depends
        on the engine:
      </p>
      <ul>
        <li>
          <strong>PostgreSQL, MySQL/MariaDB, SQLite</strong> — plain SQL, with
          a Format button (sql-formatter) in the toolbar.
        </li>
        <li>
          <strong>MongoDB</strong> — a JSON command document naming the
          collection. Supported operations: <code>find</code> (with{' '}
          <code>sort</code> and <code>limit</code>; the default limit is 100),{' '}
          <code>aggregate</code> (results capped at 1000 documents) and{' '}
          <code>countDocuments</code>.
        </li>
        <li>
          <strong>Redis</strong> — one command per line; lines starting with{' '}
          <code>#</code> are comments.
        </li>
      </ul>
      <CodeBlock title="MongoDB query — a JSON command document">{`{
  "collection": "users",
  "find": { "status": "active" },
  "sort": { "created_at": -1 },
  "limit": 20
}`}</CodeBlock>
      <p>
        SQL results are capped at 5000 rows by default. The cap can be raised
        per connection with the <code>maxQueryRows</code> connection option —
        see <a href="/docs/configuration">Configuration</a> for the related
        settings and their current limits.
      </p>
      <Shot
        src="/media/08-workbench-query.webp"
        alt="The Syncle query editor running a grouped aggregate over the customers table, with the result set below it in 11 milliseconds"
        caption="The query editor, with the result set underneath."
      />

      <h2 id="structure-and-the-er-diagram">Structure and the ER diagram</h2>
      <p>
        Structure shows the selected table&apos;s columns with primary-key and
        foreign-key badges. Diagram renders the whole schema as an interactive
        ER diagram: one node per table listing up to its first 20 columns — a
        key icon marks the primary key, a link icon marks referencing columns
        — and an edge for every foreign key, labeled with the referencing
        columns. Only engines that report foreign keys (the three relational
        ones) get edges; MongoDB and Redis schemas render as unconnected
        nodes.
      </p>
      <Shot
        src="/media/09-workbench-diagram.webp"
        alt="The interactive ER diagram in Syncle showing customers, orders, order_items and products with their columns, types and foreign keys"
        caption="A whole schema as an ER diagram, foreign keys drawn."
      />

      <h2 id="schema-operations">Schema operations</h2>
      <p>
        The schema tree doubles as the DDL surface. At the connection level
        you can create and drop databases on PostgreSQL and MySQL/MariaDB —
        SQLite is a single file, MongoDB creates a database implicitly when
        you add a collection to it, and Redis databases are fixed numbered
        slots. Tables (and MongoDB collections, which behave like tables here)
        are created through a dialog whose column types come from the driver;
        names must match <code>{'^[A-Za-z_][A-Za-z0-9_$]*$'}</code> and stay
        within 128 characters.
      </p>
      <p>
        Per table, the tree offers: browse it, open it in the query editor
        (SQL engines), seed the bridge builder from it (see{' '}
        <a href="/docs/bridges">How bridges work</a>), truncate it, or drop
        it. Destructive actions ask for confirmation first. Redis has no
        tables or databases to manage, so none of this appears for it.
      </p>

      <h2 id="backup-and-restore">Backup and restore</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Format</th>
              <th>Contents</th>
              <th>Engines</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>json</code>
              </td>
              <td>
                Portable dump of schema and data in Syncle&apos;s own format
                (version 1); any engine can restore it, via parameterized
                inserts
              </td>
              <td>all five</td>
            </tr>
            <tr>
              <td>
                <code>sql</code>
              </td>
              <td>A DDL + INSERT script</td>
              <td>PostgreSQL, MySQL/MariaDB, SQLite</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        On the relational engines, backups fetch 1000 rows per batch to bound
        memory and restores insert up to 500 rows at a time; MongoDB and Redis
        stream in their own units. The browser calls{' '}
        <code>{'POST /api/connections/:id/backup?database=...'}</code>, which
        returns <code>{'{ filename, format, content }'}</code> — the filename
        is <code>{'<database>-<timestamp>.json'}</code> or <code>.sql</code> —
        and saves the file locally (see the{' '}
        <a href="/docs/api">HTTP API</a> page for the response envelope).
        Individual tables can also be backed up to JSON from their own menu.
        Restore takes an uploaded <code>.json</code> or <code>.sql</code>{' '}
        file; the format is inferred from the extension.
      </p>
      <Note>
        A restore travels as one JSON request body, and the API caps bodies at
        50 MB. A dump larger than that is rejected before it reaches the
        database — for datasets of that size, copy the data with a one-time
        bridge instead.
      </Note>

      <h2 id="what-each-engine-supports">What each engine supports</h2>
      <p>
        Feature availability never branches on engine names. Each driver
        publishes capability flags through <code>GET /api/drivers</code> —
        query language, DDL, database management, row editing, backup formats
        — and the UI shows or hides features by reading those flags. An
        engine that lacks a capability just does not offer the control.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Engine</th>
              <th>Query language</th>
              <th>DDL</th>
              <th>Manage databases</th>
              <th>Foreign keys</th>
              <th>Transactions</th>
              <th>Backup formats</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>PostgreSQL</td>
              <td>SQL</td>
              <td>yes</td>
              <td>yes</td>
              <td>yes</td>
              <td>yes</td>
              <td>
                <code>json</code>, <code>sql</code>
              </td>
            </tr>
            <tr>
              <td>MySQL/MariaDB</td>
              <td>SQL</td>
              <td>yes</td>
              <td>yes</td>
              <td>yes</td>
              <td>yes</td>
              <td>
                <code>json</code>, <code>sql</code>
              </td>
            </tr>
            <tr>
              <td>SQLite</td>
              <td>SQL</td>
              <td>yes</td>
              <td>—</td>
              <td>yes</td>
              <td>yes</td>
              <td>
                <code>json</code>, <code>sql</code>
              </td>
            </tr>
            <tr>
              <td>MongoDB</td>
              <td>JSON command documents</td>
              <td>yes (collections)</td>
              <td>—</td>
              <td>—</td>
              <td>—</td>
              <td>
                <code>json</code>
              </td>
            </tr>
            <tr>
              <td>Redis</td>
              <td>Redis commands</td>
              <td>—</td>
              <td>—</td>
              <td>—</td>
              <td>—</td>
              <td>
                <code>json</code>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="connection-strings">Connection strings</h2>
      <p>
        PostgreSQL, MySQL/MariaDB, MongoDB and Redis connections can be given
        as a single connection string instead of separate host, port, user and
        password fields — which is what a hosted database (Neon, Supabase,
        PlanetScale, Atlas, Upstash…) usually hands you:
      </p>
      <CodeBlock>{`postgres://user:password@host:5432/database?sslmode=require
mysql://user:password@host:3306/database
mongodb+srv://user:password@cluster.example.net/database
rediss://default:password@host:6379/0`}</CodeBlock>
      <p>
        When the field is filled in it is used instead of the fields above
        it. The string contains a password, so it is treated as one: encrypted
        at rest, and shown back as <code>********</code> — leave that in
        place when you edit the connection and the stored string is kept. The
        database a string names is only a default: browsing another database
        in the workbench, or a bridge whose source says which database it
        reads, uses <em>that</em> database with the same credentials. A
        string&apos;s own <code>sslmode</code> or <code>rediss://</code>{' '}
        scheme turns TLS on; the <a href="#tls">TLS setting</a> beside it
        decides how far the certificate is trusted. A connection string
        cannot be combined with an <a href="#ssh-tunnels">SSH tunnel</a>.
      </p>

      <h2 id="tls">TLS to the database</h2>
      <p>
        A connection&apos;s TLS setting applies to <em>every</em> connection
        Syncle opens with it — the workbench, replay jobs, and the CDC change
        streams, which are separate connections of their own. The four modes
        are PostgreSQL&apos;s <code>sslmode</code> values, because those are
        the names people already know, and they mean the same thing on every
        engine:
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Mode</th>
              <th>Encrypted</th>
              <th>Checks the CA</th>
              <th>Checks the host name</th>
              <th>Protects against</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Off</td>
              <td>no</td>
              <td>—</td>
              <td>—</td>
              <td>nothing; the password crosses the network in plain text</td>
            </tr>
            <tr>
              <td>
                Encrypt only (<code>require</code>)
              </td>
              <td>yes</td>
              <td>no</td>
              <td>no</td>
              <td>
                passive eavesdropping only — whoever can sit in the path can
                present any certificate and be accepted
              </td>
            </tr>
            <tr>
              <td>
                Verify the authority (<code>verify-ca</code>)
              </td>
              <td>yes</td>
              <td>yes</td>
              <td>no</td>
              <td>
                an impostor without a certificate from your CA — but any
                server holding one passes
              </td>
            </tr>
            <tr>
              <td>
                Verify authority and host (<code>verify-full</code>)
              </td>
              <td>yes</td>
              <td>yes</td>
              <td>yes</td>
              <td>
                impersonation: the only mode that proves you reached the
                server you meant to. Use this one
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Give a <strong>CA certificate</strong> (PEM) when the database uses a
        private CA — a self-hosted server, or a cloud provider&apos;s own
        root. Leave it empty to trust the system&apos;s authorities, which
        is right for a managed database with a public certificate. The{' '}
        <strong>expected server name</strong> is for the case where the
        certificate was issued to a different name than the one you dial — an
        IP address in the host field, say. A <strong>client certificate</strong>{' '}
        and key are for servers that demand mutual TLS; the key is encrypted at
        rest and comes back redacted, like a password.
      </p>
      <p>
        Through an SSH tunnel the certificate is still checked against the{' '}
        <em>database&apos;s</em> host name, not the tunnel&apos;s{' '}
        <code>127.0.0.1</code> — so <code>verify-full</code> works through a
        bastion without listing loopback addresses on your certificates.
      </p>
      <Note>
        <p>
          Connections saved before these modes existed had one on/off switch,
          and it meant something different on each engine. They keep exactly
          what they had, shown as the matching mode when you open them:
          encrypted but unverified on PostgreSQL and MySQL, verified on Redis.
          On <strong>MongoDB</strong> the switch did nothing at all with
          host and port fields — the connection was plaintext — so a MongoDB
          connection with it on now really uses TLS, and will fail if the
          server does not offer it.
        </p>
      </Note>

      <h2 id="ssh-tunnels">SSH tunnels</h2>
      <p>
        A database on a private network can be reached through an SSH tunnel
        configured on the connection itself: SSH host, port (default 22) and
        user, authenticated by password or a PEM private key with an optional
        passphrase. The tunnel is opened by the API server, and the SSH
        secrets are encrypted at rest alongside the database password — see{' '}
        <a href="/docs/self-hosting">Self-hosting &amp; security</a> for the
        wider posture.
      </p>
      <p>
        The jump host&apos;s identity is checked the way <code>ssh</code>{' '}
        itself checks it. Paste its <strong>host key fingerprint</strong>{' '}
        (<code>SHA256:…</code>, as <code>ssh-keygen -lf</code> prints it) and
        any other key is refused. Leave it empty and the key seen on the first
        successful connection is recorded and enforced from then on — the
        Test button shows you that fingerprint so you can compare it first.
        If a host later presents a <em>different</em> key, the tunnel refuses
        to open and says so: either the server was reinstalled or something
        is answering in its place. Confirm the new fingerprint with whoever
        runs the host before updating it.
      </p>
      <p>
        Two rules are enforced at validation time. SQLite connections cannot
        use a tunnel — a file has no network hop — and the API refuses with
        &quot;SSH tunnels are not supported for SQLite connections&quot;. A
        tunnel also cannot be combined with a connection string, because the
        tunnel rewrites the discrete host and port and a full URI would bypass
        it; use the separate host/port fields instead. That leaves PostgreSQL,
        MySQL/MariaDB, MongoDB and Redis as the engines that tunnel.
      </p>
      <p>
        A tunnel covers everything the connection is used for: the workbench,
        replays and watch bridges, and <a href="/docs/cdc">CDC</a> change
        streams, which open a tunnel of their own that lives exactly as long
        as the stream and is re-established if the SSH connection drops.
        (Until recently a change stream dialled the database host directly and
        ignored the tunnel, so CDC could not be used with a tunnelled
        connection at all.) Through a tunnel a MongoDB connection talks only
        to the address it was given rather than discovering the replica
        set&apos;s other members, whose internal names cannot be reached from
        this side of the bastion — point it at the primary.
      </p>
    </DocArticle>
  );
}
