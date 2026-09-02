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
        Every API route sits behind a single admin account — created once on
        first run, guarded by a one-time setup token, with no signup (the{' '}
        <a href="/docs/quickstart">quickstart</a> walks through it). The
        password is hashed with scrypt, and the session is a signed httpOnly
        cookie named <code>db_session</code> that expires after one week by
        default; the length is configurable in-app under Settings › Security.
        Login and setup attempts are rate-limited. Changing the password bumps
        the account&apos;s session version, which instantly invalidates every
        outstanding cookie on every device.
      </p>
      <p>
        What Syncle does not ship: TLS. It serves plain HTTP, and the security
        policy is explicit that TLS termination and network-level control over
        who can reach the port are the operator&apos;s job the moment anything
        beyond localhost can connect.
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
        Connection passwords, SSH secrets and bridge auth secrets are encrypted
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
        Never regenerate <code>SYNCLE_MASTER_KEY</code> once data exists. A new
        key makes every stored credential undecryptable and logs everyone out.
        If the key ever appears invalid, recover the original — do not mint a
        replacement.
      </Note>

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
