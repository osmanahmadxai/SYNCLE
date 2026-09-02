import { CodeBlock } from '@/components/docs/code-block';
import { DocArticle, docMetadata } from '@/components/docs/doc-article';
import { Note } from '@/components/docs/note';
import { INSTALL_COMMAND } from '@/lib/content';

export const metadata = docMetadata('install');

export default function Page() {
  return (
    <DocArticle slug="install">
      <p>
        Syncle installs with one command on any machine that has Docker. The
        installer needs Docker with Compose v2 and curl, and nothing else —
        Node, Postgres and Redis run in containers, and the app image is
        pulled prebuilt from GHCR, so nothing is compiled and the repository
        is never cloned.
      </p>

      <h2 id="the-one-command-install">The one-command install</h2>
      <CodeBlock>{INSTALL_COMMAND}</CodeBlock>
      <p>
        <code>syncle.dev/install</code> redirects to <code>install.sh</code>{' '}
        at the head of the repository, so this is the same script you can
        read on GitHub before running it. The trailing <code>-s -- up</code>{' '}
        hands the script an <code>up</code> argument so it starts Syncle
        immediately after installing; drop it to install without starting.
        The script checks its prerequisites up front and stops with a plain
        error if curl or Docker is missing, or if{' '}
        <code>docker compose version</code> fails.
      </p>
      <p>What it actually does, in order:</p>
      <ol>
        <li>
          Resolves the version to install — the newest published release,
          falling back to <code>main</code> if the GitHub API is unreachable.
        </li>
        <li>
          Downloads exactly two files into <code>~/.syncle</code>:{' '}
          <code>docker-compose.app.yml</code> and the <code>syncle</code>{' '}
          launcher.
        </li>
        <li>
          Generates <code>SYNCLE_MASTER_KEY</code> — the key that encrypts
          saved database credentials — into <code>~/.syncle/.env</code>,
          created with mode 600. An existing key is kept on a re-run.
        </li>
        <li>
          Pins <code>SYNCLE_IMAGE</code> in the same file, so{' '}
          <code>syncle up</code> keeps running the installed version until{' '}
          <code>syncle update</code> moves the pin.
        </li>
        <li>
          Installs the launcher to <code>/usr/local/bin</code> (retrying with
          sudo), or to <code>~/.local/bin</code> if it cannot — printing the{' '}
          <code>{'export PATH="$HOME/.local/bin:$PATH"'}</code> line to add
          if that directory is not already on your PATH.
        </li>
      </ol>
      <Note>
        Never regenerate <code>SYNCLE_MASTER_KEY</code>. It encrypts stored
        connection credentials and signs sessions, so a new key makes
        everything already stored undecryptable. The installer keeps an
        existing key on re-runs and updates for exactly this reason.
      </Note>
      <p>
        Four environment variables steer the installer and the launcher; the
        defaults are right for almost everyone:
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
                <code>SYNCLE_HOME</code>
              </td>
              <td>
                <code>~/.syncle</code>
              </td>
              <td>
                Where the compose file, <code>.env</code> and version marker
                live. Read by both the installer and the launcher.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_PORT</code>
              </td>
              <td>
                <code>3002</code>
              </td>
              <td>Host port for the web GUI. Read by the launcher.</td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_REF</code>
              </td>
              <td>newest release</td>
              <td>Git ref the installer fetches its two files from.</td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_IMAGE</code>
              </td>
              <td>the tag matching the release</td>
              <td>App image to run instead of the default GHCR one.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="the-syncle-launcher">The syncle launcher</h2>
      <p>
        After install, the <code>syncle</code> command manages the stack from
        any directory. Running it with no arguments means{' '}
        <code>syncle up</code>.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Command</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>syncle up</code>
              </td>
              <td>
                Pull newer images, start everything, wait for the web GUI,
                open it in the browser.
              </td>
            </tr>
            <tr>
              <td>
                <code>syncle down</code>
              </td>
              <td>Stop and remove the containers. Data is kept.</td>
            </tr>
            <tr>
              <td>
                <code>syncle restart</code>
              </td>
              <td>Restart the running containers.</td>
            </tr>
            <tr>
              <td>
                <code>syncle status</code>
              </td>
              <td>
                Show container status. Alias: <code>syncle ps</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>syncle logs [svc]</code>
              </td>
              <td>
                Follow logs, optionally for one of <code>api</code>,{' '}
                <code>web</code>, <code>postgres</code>, <code>redis</code>.{' '}
                <code>syncle logs api</code> shows the first-run setup token.
              </td>
            </tr>
            <tr>
              <td>
                <code>syncle open</code>
              </td>
              <td>Open the web GUI in the browser.</td>
            </tr>
            <tr>
              <td>
                <code>syncle update</code>
              </td>
              <td>Fetch the newest release and restart.</td>
            </tr>
            <tr>
              <td>
                <code>syncle uninstall</code>
              </td>
              <td>Stop everything and delete all data. Asks first.</td>
            </tr>
            <tr>
              <td>
                <code>syncle version</code>
              </td>
              <td>Print the installed Syncle version.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        <code>syncle up</code> pulls images best-effort — offline, it falls
        back to what is already downloaded — then starts the containers and
        polls the web GUI until it answers. The browser opens via{' '}
        <code>open</code> on macOS or <code>xdg-open</code> on Linux;
        anywhere else the URL is printed instead. On a first run it also
        reads the one-time setup token from the api container and opens the
        GUI with the setup form prefilled — the{' '}
        <a href="/docs/quickstart">quickstart</a> walks through what happens
        from there.
      </p>

      <h2 id="ports">Ports</h2>
      <p>
        The web GUI is the only published port —{' '}
        <code>http://localhost:3002</code> by default. To run it somewhere
        else, set the port at launch:
      </p>
      <CodeBlock>{'SYNCLE_PORT=8080 syncle up'}</CodeBlock>
      <p>
        The API listens on 4002 inside the compose network but is
        deliberately not published: the browser reaches it through the web
        app&apos;s <code>/api</code> proxy, so only one port has to be open.
        The compose file carries a commented <code>ports</code> mapping on
        the api service for calling the <a href="/docs/api">HTTP API</a>{' '}
        directly from outside the stack. Syncle&apos;s own Postgres and Redis
        publish no host ports at all.
      </p>

      <h2 id="manual-docker-compose">The manual Docker Compose route</h2>
      <p>
        If you would rather not pipe curl into sh, the same stack runs from
        the compose file alone. Set an explicit master key first — generated
        once, then kept forever:
      </p>
      <CodeBlock>{`curl -fsSLO https://raw.githubusercontent.com/osmanahmadxai/SYNCLE/main/docker-compose.app.yml
export SYNCLE_MASTER_KEY="$(openssl rand -base64 32)"
docker compose -f docker-compose.app.yml up -d`}</CodeBlock>
      <p>
        With <code>SYNCLE_MASTER_KEY</code> left empty, the API generates a
        key of its own inside the <code>syncle-api-data</code> volume —
        stored next to the data it protects, and lost with it if the volume
        is removed — which is why setting one explicitly is worth the extra
        line. Compose reads the variable on every <code>up</code>, so keep it
        somewhere it will be set again; an <code>.env</code> file next to the
        compose file works, which is exactly what the installer sets up in{' '}
        <code>~/.syncle</code>.
      </p>
      <p>
        On this route there is no launcher to fetch the first-run setup token
        for you. It is printed to the api container&apos;s console — read it
        with <code>docker compose -f docker-compose.app.yml logs api</code>.
      </p>

      <h2 id="image-tags">Image tags</h2>
      <p>
        One app image runs both the api and web containers:{' '}
        <code>{'${SYNCLE_IMAGE:-ghcr.io/osmanahmadxai/syncle:latest}'}</code>.
        Image tags on GHCR drop the release tag&apos;s <code>v</code> prefix:
        the git tag <code>v1.1.0</code> publishes image <code>1.1.0</code>,
        and asking for <code>ghcr.io/osmanahmadxai/syncle:v1.1.0</code> gets{' '}
        <code>not found</code>. The installer maps this for you (and installs
        from <code>main</code> as <code>latest</code>); when pinning by hand
        with <code>SYNCLE_IMAGE</code>, use the numeric tag.
      </p>

      <h2 id="building-the-image-yourself">Building the image yourself</h2>
      <p>
        The compose file has an opt-in <code>build</code> profile that builds
        the image from a checkout of the repository instead of pulling it:
      </p>
      <CodeBlock>{`docker compose -f docker-compose.app.yml --profile build build
SYNCLE_IMAGE=syncle-app:local docker compose -f docker-compose.app.yml up -d`}</CodeBlock>
      <p>
        The first command produces <code>syncle-app:local</code> from the
        repository&apos;s Dockerfile; the second runs the stack from it. The
        builder service itself never starts and is never pulled.
      </p>

      <h2 id="updating-and-uninstalling">Updating and uninstalling</h2>
      <p>
        <code>syncle update</code> re-runs the installer, which refreshes the
        compose file and the launcher and re-pins the image to the newest
        release — the encryption key in <code>~/.syncle/.env</code> is
        preserved — then pulls the images and restarts the containers.
      </p>
      <p>
        <code>syncle down</code> stops the containers and keeps all data; the
        next <code>syncle up</code> carries on where you left off.{' '}
        <code>syncle uninstall</code> is the destructive one: after a y/N
        confirmation it removes the containers, images and every data volume,
        deletes <code>~/.syncle</code>, and removes the launcher from the
        PATH. Syncle&apos;s metadata — saved connections, bridges, job
        history — lives in those volumes and goes with them, so read the{' '}
        <a href="/docs/self-hosting">self-hosting page</a> on what to back up
        first.
      </p>
    </DocArticle>
  );
}
