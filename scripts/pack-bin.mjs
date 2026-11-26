// Packs each standalone executable into a smaller download, next to the raw file:
//   tpseudo-<os>-<cpu>          -> tpseudo-<os>-<cpu>.tar.xz   holding `tpseudo` (executable bit kept)
//   tpseudo-windows-<cpu>.exe   -> tpseudo-windows-<cpu>.zip   holding `tpseudo.exe`
//   node scripts/pack-bin.mjs [dir]   (default dist/; scripts/build-bin.mjs runs it after building)
import { spawnSync } from 'node:child_process';
import { readdirSync, mkdtempSync, copyFileSync, chmodSync, rmSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(process.argv[2] || join(root, 'dist'));
const bins = readdirSync(dir).filter(f => /^tpseudo-[a-z]+-[a-z0-9]+(\.exe)?$/.test(f));
if (!bins.length) { console.error(`No tpseudo-<platform> executables in ${dir}`); process.exit(1); }

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) { console.error(`${cmd} not found`); process.exit(1); }
  if (r.status) process.exit(r.status);
};
const mb = (f) => (statSync(f).size / 1048576).toFixed(1) + ' MB';

for (const bin of bins) {
  const windows = bin.endsWith('.exe');
  const stage = mkdtempSync(join(tmpdir(), 'tpseudo-pack-'));
  const inner = windows ? 'tpseudo.exe' : 'tpseudo';
  copyFileSync(join(dir, bin), join(stage, inner));
  chmodSync(join(stage, inner), 0o755);
  const out = join(dir, windows ? bin.replace(/\.exe$/, '.zip') : bin + '.tar.xz');
  rmSync(out, { force: true });
  if (windows) run('zip', ['-9qX', out, inner], { cwd: stage });
  else run('tar', ['-cJf', out, '--owner=0', '--group=0', '-C', stage, inner], { env: { ...process.env, XZ_OPT: '-6 -T0' } });
  rmSync(stage, { recursive: true, force: true });
  console.log(`${bin} (${mb(join(dir, bin))}) -> ${out.slice(dir.length + 1)} (${mb(out)})`);
}
