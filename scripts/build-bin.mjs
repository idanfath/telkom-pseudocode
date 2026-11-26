// Builds standalone tpseudo executables (no Node needed) into dist/ with Bun.
//   node scripts/build-bin.mjs            every platform
//   node scripts/build-bin.mjs linux-x64  only the ones named
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const all = ['linux-x64', 'linux-arm64', 'windows-x64', 'darwin-x64', 'darwin-arm64'];
const targets = process.argv.length > 2 ? process.argv.slice(2) : all;
const bad = targets.filter(t => !all.includes(t));
if (bad.length) { console.error(`Unknown target(s): ${bad.join(', ')}. Known: ${all.join(', ')}`); process.exit(1); }

mkdirSync(join(root, 'dist'), { recursive: true });
for (const t of targets) {
  const out = join('dist', `tpseudo-${t}${t.startsWith('windows') ? '.exe' : ''}`);
  const r = spawnSync('bun', ['build', '--compile', '--minify', `--target=bun-${t}`, 'bin/tpseudo.js', '--outfile', out], { cwd: root, stdio: 'inherit' });
  if (r.error) { console.error('bun not found: install it from https://bun.sh'); process.exit(1); }
  if (r.status) process.exit(r.status);
}
