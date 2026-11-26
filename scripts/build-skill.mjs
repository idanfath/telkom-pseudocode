// Packs the agent skill as dist/telkom-pseudocode-skill.zip (a telkom-pseudocode/ folder with
// SKILL.md), the format claude.ai accepts under Settings → Capabilities → Skills.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'telkom-pseudocode-skill.zip');
mkdirSync(join(root, 'dist'), { recursive: true });
rmSync(out, { force: true });
const r = spawnSync('zip', ['-rX', out, 'telkom-pseudocode'], { cwd: join(root, 'skills'), stdio: 'inherit' });
if (r.error) { console.error('zip not found: install zip, or zip skills/telkom-pseudocode by hand'); process.exit(1); }
process.exit(r.status ?? 1);
