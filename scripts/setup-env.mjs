// makes sure local env files exist by copying from the committed examples.
// idempotent, never overwrites files that already exist. runs automatically
// before `pnpm dev` / `pnpm start` (it is NOT wired to `pnpm install`)
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const pairs = [
  ['apps/api/.env.example', 'apps/api/.env'],
  ['apps/web/.env.example', 'apps/web/.env.local'],
];

for (const [example, target] of pairs) {
  const src = resolve(root, example);
  const dest = resolve(root, target);
  if (existsSync(src) && !existsSync(dest)) {
    copyFileSync(src, dest);
    console.log(`  created ${target} from example`);
  }
}
