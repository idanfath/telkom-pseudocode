// Runs the tpseudo CLI as a real process: output, exit codes, piped input.
// TPSEUDO_BIN=path/to/binary checks a compiled build (bun build --compile) instead of bin/tpseudo.js.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'bin', 'tpseudo.js');

let fails = 0;
const ok = (cond, msg, extra = '') => { if (!cond) { fails++; console.error('FAIL:', msg, extra); } else console.log('ok:', msg); };
const tp = (args, input = '') => {
  const [cmd, pre] = process.env.TPSEUDO_BIN ? [process.env.TPSEUDO_BIN, []] : [process.execPath, [cli]];
  const r = spawnSync(cmd, [...pre, ...args], { cwd: root, input, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 20000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const show = (r) => JSON.stringify(r);

let r = tp(['samples/run/run_hello.pseudo'], 'Budi 7\n');
ok(r.code === 0 && r.out === 'Halo Dunia\nNama: Budi\nn: 7\n', 'run by default, input from stdin', show(r));

r = tp(['run', 'samples/run/run_hello.pseudo'], 'Budi\n7\n');
ok(r.code === 0 && r.out.endsWith('n: 7\n'), 'run subcommand, input over several lines', show(r));

r = tp(['samples/run/run_hello.pseudo'], 'Budi 7');
ok(r.code === 0 && r.out.endsWith('n: 7\n'), 'last line without newline', show(r));

r = tp(['samples/run/err_noinput.pseudo']);
ok(r.code === 2 && r.err.includes('Not enough input values'), 'end of input is a runtime error', show(r));

r = tp(['samples/run/err_divzero.pseudo']);
ok(r.code === 2 && r.err.includes('Runtime error at line 5: Division by zero'), 'runtime error exits 2', show(r));

r = tp(['--max-steps', '10', 'samples/run/run_fact.pseudo']);
ok(r.code === 2 && r.err.includes('Execution limit exceeded'), '--max-steps', show(r));

r = tp(['samples/bad.pseudo']);
ok(r.code === 1 && r.out === '' && r.err.includes("samples/bad.pseudo:4:3: error: Duplicate declaration 'x'") && r.err.includes('Cannot run'), 'static errors block the run, exit 1', show(r));

r = tp(['check', 'samples/bad.pseudo']);
ok(r.code === 1 && r.err.includes('warning:') && /9 errors, 2 warnings/.test(r.err), 'check lists errors and warnings', show(r));

r = tp(['check', 'samples/hello.pseudo', 'samples/all-constructs.pseudo']);
ok(r.code === 0, 'check clean files exits 0', show(r));

r = tp(['samples/run/run_leak.pseudo']);
ok(r.code === 0 && r.out.includes('never deallocated'), 'leak warning printed', show(r));

r = tp(['missing.pseudo']);
ok(r.code === 3 && r.err.includes('cannot read'), 'missing file exits 3', show(r));

r = tp(['--bogus']);
ok(r.code === 3 && r.err.includes("Unknown option '--bogus'"), 'unknown option exits 3', show(r));

r = tp(['run', 'a.pseudo', 'b.pseudo']);
ok(r.code === 3, 'run takes one file', show(r));

r = tp(['--help']);
ok(r.code === 0 && r.out.includes('Usage:'), '--help', show(r));

if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nall CLI checks passed');
