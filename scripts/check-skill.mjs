// Every pseudocode example in the agent skill must agree with the checker.
// Fence tags in skills/telkom-pseudocode/SKILL.md:
//   ```pseudo                 a whole program / function / procedure: no errors allowed
//   ```pseudo wrong           shows a mistake: must have at least one error
//   ```pseudo fragment        a template or a few lines: not checked
//   ```pseudo kamus           declarations only: checked inside a small program's kamus
//   name=x / uses=x           a kamus block named x supplies its declarations to later blocks
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const { analyze } = require('./lang/analyzer.js');

const file = 'skills/telkom-pseudocode/SKILL.md';
const lines = readFileSync(join(root, file), 'utf8').split('\n');

let fails = 0;
const ok = (cond, msg, extra = '') => { if (!cond) { fails++; console.error('FAIL:', msg, extra); } else console.log('ok:', msg); };

// collect fenced pseudo blocks, removing the fence's own indentation
const blocks = [];
for (let i = 0; i < lines.length; i++) {
  const open = lines[i].match(/^(\s*)```pseudo\b(.*)$/);
  if (!open) continue;
  const indent = open[1].length;
  const body = [];
  let j = i + 1;
  for (; j < lines.length && !/^\s*```\s*$/.test(lines[j]); j++) body.push(lines[j].slice(Math.min(indent, lines[j].search(/\S|$/))));
  if (j === lines.length) { ok(false, `${file}:${i + 1} fence is never closed`); break; }
  const tags = open[2].trim().split(/\s+/).filter(Boolean);
  const kv = Object.fromEntries(tags.filter(t => t.includes('=')).map(t => t.split('=')));
  blocks.push({ line: i + 1, text: body.join('\n'), flags: new Set(tags.filter(t => !t.includes('='))), name: kv.name, uses: kv.uses });
  i = j;
}

const known = new Set(['wrong', 'fragment', 'kamus']);
const named = {}; // name -> declaration lines
const indentAll = (text) => text.split('\n').map(l => (l ? '  ' + l : l)).join('\n');
let checked = 0;

for (const b of blocks) {
  const where = `${file}:${b.line}`;
  const unknown = [...b.flags].filter(f => !known.has(f));
  ok(!unknown.length, `${where} known fence tags`, unknown.join(' '));
  if (b.flags.has('fragment')) continue;
  if (b.uses && !named[b.uses]) { ok(false, `${where} uses=${b.uses} names an earlier kamus block`); continue; }

  const shared = b.uses ? named[b.uses] : [];
  let src;
  if (b.flags.has('kamus')) {
    const decls = [...shared, b.text];
    if (b.name) named[b.name] = decls;
    src = `program skill_example\nkamus\n${indentAll(decls.join('\n'))}\nalgoritma\n  output("ok")\nendprogram\n`;
  } else if (shared.length) {
    src = `program skill_example\nkamus\n${indentAll(shared.join('\n'))}\nalgoritma\n  output("ok")\nendprogram\n\n${b.text}\n`;
  } else src = b.text + '\n';

  const errors = analyze(src).filter(d => d.sev === 0);
  checked++;
  if (b.flags.has('wrong')) ok(errors.length > 0, `${where} "wrong" example is rejected by the checker`);
  else ok(!errors.length, `${where} example passes the checker`, errors.map(e => `\n    line ${e.line + 1}: ${e.msg}`).join(''));
}

ok(checked >= 8, `checked ${checked} examples`);
if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nAll skill examples agree with the checker.');
