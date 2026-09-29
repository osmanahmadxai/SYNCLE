/**
 * the query editor (Monaco) served by the app itself.
 *
 * `@monaco-editor/react` fetches Monaco from the jsDelivr CDN at run time unless
 * told where else to find it. For a self-hosted tool that is wrong twice over:
 * on a network with no internet the query editor never loads, and a script from
 * somebody else's server runs in a page that handles database credentials. So
 * Monaco's own build is copied into `public/monaco/vs` (git-ignored; 13 MB that
 * belongs in node_modules, not in the repository) before every dev and build,
 * and the editor is pointed at it (see query-editor.tsx).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * where monaco-editor is on disk. Found by walking the resolver's own search
 * paths rather than by resolving a file inside it: a package's `exports` map can
 * decline to expose even its own package.json, and monaco-editor's does from
 * 0.57 on — `require.resolve('monaco-editor/package.json')` there is answered by
 * a wildcard entry and fails as `esm/vs/package.json.js`. A directory on disk is
 * a directory on disk.
 */
function packageDir(name) {
  for (const base of require.resolve.paths(name) ?? []) {
    const dir = join(base, name);
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  return null;
}

const monaco = packageDir('monaco-editor');
if (!monaco) {
  console.error('copy-monaco: monaco-editor is not installed');
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(join(monaco, 'package.json'), 'utf8'));
const source = join(monaco, 'min', 'vs');
const target = join(here, '..', 'public', 'monaco');
const stamp = join(target, '.version');

if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === version)
  process.exit(0);
if (!existsSync(source)) {
  console.error(
    `copy-monaco: ${source} does not exist — is monaco-editor installed?`,
  );
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, join(target, 'vs'), { recursive: true });
writeFileSync(stamp, `${version}\n`);
console.log(`copy-monaco: monaco-editor ${version} -> public/monaco/vs`);
