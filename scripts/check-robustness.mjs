// Half-typed and damaged code must never crash anything: the editor calls the checker,
// completion and rename on every keystroke. Each sample is cut short at every line and at
// many character positions, and has single tokens deleted; every result must be a normal one.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const { analyzeProgram } = require('./lang/analyzer.js');
const { runProgram } = require('./lang/interpreter.js');
const { complete } = require('./lang/completion.js'); // the throwing versions: the public ones swallow errors
const { renameRanges } = require('./lang/rename.js');
const { tokenize } = require('./lang/lexer.js');

let fails = 0, cases = 0;
const fail = (what, src, e) => { fails++; if (fails <= 10) console.error(`FAIL: ${what}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}\n--- source ---\n${src}\n---`); };

function exercise(src) {
  cases++;
  try { analyzeProgram(src); } catch (e) { fail('checker threw', src, e); return; }
  const r = runProgram(src, '1 2 3', { ignoreStatic: true, maxSteps: 2000 });
  if (r.error && /Interpreter crash/.test(r.error.msg)) fail('runner crashed', src, r.error.msg);
  const lines = src.split('\n');
  const last = lines.length - 1;
  for (const [l, c] of [[last, lines[last].length], [Math.floor(last / 2), 3], [Math.floor(last / 3), 9]]) {
    try { complete(src, l, c); renameRanges(src, l, c); } catch (e) { fail('editor feature threw', src, e); }
  }
}

const files = ['samples/hello.pseudo', 'samples/all-constructs.pseudo', 'samples/linkedlist.pseudo', 'samples/bad.pseudo',
  ...readdirSync(join(root, 'samples/run')).map(f => 'samples/run/' + f)];
for (const f of files) {
  const src = readFileSync(join(root, f), 'utf8');
  const lines = src.split('\n');
  for (let n = 0; n <= lines.length; n++) exercise(lines.slice(0, n).join('\n')); // cut at every line
  for (let i = 0; i < src.length; i += 7) exercise(src.slice(0, i)); // cut mid-line
  for (let n = 0; n < lines.length; n++) exercise([...lines.slice(0, n), ...lines.slice(n + 1)].join('\n')); // one line missing
  const toks = tokenize(src).lines.flat().filter(t => t.kind !== 'comment');
  for (let i = 0; i < toks.length; i += 3) { // one token missing
    const t = toks[i], ls = src.split('\n');
    ls[t.line] = ls[t.line].slice(0, t.col) + ls[t.line].slice(t.col + t.text.length);
    exercise(ls.join('\n'));
  }
}

if (fails) { console.error(`\n${fails} failure(s) in ${cases} damaged programs`); process.exit(1); }
console.log(`ok: ${cases} damaged programs: checker, runner, completion and rename all stayed up`);
console.log('\nAll robustness checks passed.');
