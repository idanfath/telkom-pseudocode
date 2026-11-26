#!/usr/bin/env node
// tpseudo: run or check Telkom pseudocode files from a terminal.
//
//   tpseudo [run] <file>      check the file, then run it; input() reads from stdin
//   tpseudo check <file>...   report errors and warnings without running
//
// Exit codes: 0 ok, 1 static errors, 2 runtime error, 3 usage or file error, 130 interrupted.
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { analyze } = require('../lang/analyzer');
const { startRun } = require('../lang/run-worker');

const EXIT = { OK: 0, STATIC: 1, RUNTIME: 2, USAGE: 3 };

const USAGE = `Usage:
  tpseudo [run] <file>       check the file, then run it (input() reads stdin)
  tpseudo check <file>...    report errors and warnings without running

Options:
  --max-steps <n>   stop the program after n steps (default 500000, 0 = no limit)
  --no-check        run even when the checker finds errors
  --no-color        plain output (also when NO_COLOR is set)
  -h, --help        show this help
  -v, --version     show the version

Exit codes: 0 ok, 1 static errors, 2 runtime error, 3 usage or file error`;

function parseArgs(argv) {
  const o = { cmd: 'run', files: [], maxSteps: undefined, check: true, color: undefined };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-v' || a === '--version') o.version = true;
    else if (a === '--no-check') o.check = false;
    else if (a === '--no-color') o.color = false;
    else if (a === '--max-steps' || a.startsWith('--max-steps=')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      const n = Number(v);
      if (v === undefined || !Number.isInteger(n) || n < 0) throw new Error(`--max-steps needs a whole number, got '${v ?? ''}'`);
      o.maxSteps = n === 0 ? Infinity : n;
    } else if (a === '--') rest.push(...argv.slice(i + 1)), i = argv.length;
    else if (a.startsWith('-') && a !== '-') throw new Error(`Unknown option '${a}'`);
    else rest.push(a);
  }
  if (rest[0] === 'run' || rest[0] === 'check') o.cmd = rest.shift();
  o.files = rest;
  return o;
}

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`tpseudo: ${e.message}\n\n${USAGE}\n`); return EXIT.USAGE; }
  if (o.help) { process.stdout.write(USAGE + '\n'); return EXIT.OK; }
  if (o.version) { process.stdout.write(require('../package.json').version + '\n'); return EXIT.OK; }

  const useColor = o.color ?? (!process.env.NO_COLOR && process.stderr.isTTY);
  const paint = (code) => (s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
  const c = { red: paint(31), yellow: paint(33), dim: paint(2), bold: paint(1) };

  if (!o.files.length) { process.stderr.write(`tpseudo: no file given\n\n${USAGE}\n`); return EXIT.USAGE; }
  if (o.cmd === 'run' && o.files.length > 1) { process.stderr.write('tpseudo: run takes one file\n'); return EXIT.USAGE; }

  const sources = [];
  for (const f of o.files) {
    try { sources.push({ file: f, text: fs.readFileSync(f, 'utf8') }); }
    catch (e) { process.stderr.write(`tpseudo: cannot read ${f}: ${e.code === 'ENOENT' ? 'no such file' : e.message}\n`); return EXIT.USAGE; }
  }

  const report = (file, d) => {
    const kind = d.sev === 0 ? c.red('error') : c.yellow('warning');
    process.stderr.write(`${c.bold(`${file}:${d.line + 1}:${d.col + 1}`)}: ${kind}: ${d.msg}\n`);
  };

  if (o.cmd === 'check') {
    let errors = 0, warnings = 0;
    for (const { file, text } of sources) {
      for (const d of analyze(text)) {
        report(file, d);
        if (d.sev === 0) errors++; else warnings++;
      }
    }
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    process.stderr.write(errors || warnings ? `${plural(errors, 'error')}, ${plural(warnings, 'warning')}\n` : c.dim('No problems found.') + '\n');
    return errors ? EXIT.STATIC : EXIT.OK;
  }

  const { file, text } = sources[0];
  if (o.check) {
    const errors = analyze(text).filter(d => d.sev === 0);
    if (errors.length) {
      for (const d of errors) report(file, d);
      process.stderr.write(c.red(`Cannot run: ${errors.length} error(s).`) + '\n');
      return EXIT.STATIC;
    }
  }
  return run(text, o, c);
}

function run(text, o, c) {
  return new Promise((resolve) => {
    const interactive = process.stdin.isTTY && process.stdout.isTTY; // show a '> ' prompt only to a person at a terminal
    const queue = []; // lines typed or piped that the program has not read yet
    let waiting = false, inputEnded = false;

    const rl = readline.createInterface({ input: process.stdin }); // no output: the terminal's own line editing applies
    const feed = () => {
      if (!waiting) return;
      if (queue.length) { waiting = false; handle.sendLine(queue.shift()); }
      else if (inputEnded) { waiting = false; handle.endInput(); }
    };
    rl.on('line', (line) => { queue.push(line); feed(); });
    rl.on('close', () => { inputEnded = true; feed(); });

    const handle = startRun(text, {
      onOutput: (line) => process.stdout.write(line + '\n'),
      onNeedInput: () => {
        waiting = true;
        if (interactive && !queue.length && !inputEnded) process.stdout.write(c.dim('> '));
        feed();
      },
      onDone: (result) => {
        rl.close();
        process.stdin.destroy();
        if (result && result.error) {
          process.stderr.write(c.red(`Runtime error at line ${result.error.line + 1}: ${result.error.msg}`) + '\n');
          resolve(EXIT.RUNTIME);
        } else if (result && result.staticErrors) {
          process.stderr.write(c.red(`Cannot run: ${result.staticErrors.length} error(s).`) + '\n');
          resolve(EXIT.STATIC);
        } else resolve(EXIT.OK);
      },
    }, { maxSteps: o.maxSteps, ignoreStatic: !o.check });

    process.once('SIGINT', () => {
      handle.kill();
      process.stderr.write('\n' + c.dim('--- stopped ---') + '\n');
      process.exit(130);
    });
  });
}

// When bundled into one file (bun build --compile), the runner's worker thread loads this same
// file; only the main thread is the CLI.
if (require('worker_threads').isMainThread) Promise.resolve(main()).then((code) => { process.exitCode = code; });
