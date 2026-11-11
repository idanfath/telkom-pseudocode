// Extension wiring against a fake `vscode` module: activation, Run in a terminal, Check File, rename.
// Also the terminal session on its own (lang/run-session.js needs no VS Code).
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));

let fails = 0;
const ok = (cond, msg, extra = '') => { if (!cond) { fails++; console.error('FAIL:', msg, extra); } else console.log('ok:', msg); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// wait until cond() holds (the runner works on another thread)
const until = async (cond, ms = 5000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await sleep(10); return cond(); };
// what a terminal would show: colour codes dropped, backspace-erase applied
const plain = (s) => {
  s = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  while (/[^\x08]\x08 \x08/.test(s)) s = s.replace(/[^\x08]\x08 \x08/, '');
  return s;
};

// One shared object: extension.js captures `vscode` once at load; each scenario refills it.
const vscode = {};
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : origLoad.call(this, req, ...rest); };
const ext = require('./extension.js');

function scenario({ docs = [], active = null } = {}) {
  const log = { channels: [], sets: new Map(), terminals: [], handlers: {}, commands: {}, rename: null };
  const ev = (name) => (fn) => { log.handlers[name] = fn; return { dispose() {} }; };
  const disposable = { dispose() {} };
  Object.assign(vscode, {
    Range: class { constructor(...a) { this.a = a; } },
    Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    CompletionItem: class { constructor(label, kind) { Object.assign(this, { label, kind }); } },
    CompletionItemKind: {},
    SnippetString: class { constructor(v) { this.value = v; } },
    MarkdownString: class { constructor(v) { this.value = v; } },
    WorkspaceEdit: class { constructor() { this.edits = []; } replace(uri, range, text) { this.edits.push(text); } },
    EventEmitter: class {
      constructor() { this.listeners = []; this.event = (fn) => { this.listeners.push(fn); return disposable; }; }
      fire(data) { for (const fn of this.listeners) fn(data); }
      dispose() {}
    },
    languages: {
      createDiagnosticCollection: () => ({ set: (uri, ds) => log.sets.set(uri, ds), delete: (uri) => log.sets.delete(uri), dispose() {} }),
      registerCompletionItemProvider: () => disposable,
      registerRenameProvider: (sel, p) => { log.rename = p; return disposable; },
    },
    workspace: {
      textDocuments: docs,
      onDidOpenTextDocument: ev('open'), onDidChangeTextDocument: ev('change'),
      onDidSaveTextDocument: ev('save'), onDidCloseTextDocument: ev('close'),
    },
    window: {
      activeTextEditor: active ? { document: active } : undefined,
      createOutputChannel: (name) => {
        const ch = { name, lines: [], clear() { this.lines = []; }, appendLine(l) { this.lines.push(l); }, show() {}, dispose() {} };
        log.channels.push(ch);
        return ch;
      },
      // a terminal that records what the extension writes, like the real one would display it
      createTerminal: ({ name, pty }) => {
        const term = { name, pty, screen: '', focus: null, show(preserveFocus) { this.focus = !preserveFocus; }, dispose() { pty.close(); } };
        pty.onDidWrite((data) => { term.screen = data.includes('\x1b[2J') ? '' : term.screen + data; });
        log.terminals.push(term);
        return term;
      },
      showErrorMessage: () => {},
      showInformationMessage: () => {},
    },
    commands: { registerCommand: (id, fn) => { log.commands[id] = fn; return disposable; } },
  });
  ext.activate({ subscriptions: [] });
  log.run = () => log.commands['telkomPseudocode.runFile']();
  log.term = () => log.terminals[log.terminals.length - 1];
  log.lines = () => plain(log.term().screen).split('\r\n').filter(l => l !== '');
  return log;
}
const doc = (uri, text, languageId = 'telkom-pseudocode') => ({ uri, languageId, getText: () => text });
const prog = (algo, kamus = '  n : integer') => `program t\nkamus\n${kamus}\nalgoritma\n${algo}\nendprogram`;

// activation: every open pseudocode document gets diagnostics, not only the active one
{
  const a = doc('a', prog('  n = 1')), b = doc('b', prog('  n = 2')), c = doc('c', 'hello', 'plaintext');
  const log = scenario({ docs: [a, b, c], active: a });
  ok(log.sets.has('a') && log.sets.has('b') && !log.sets.has('c'), 'activation refreshes all open .pseudo documents');
}
// edits in two documents within the debounce window refresh both
{
  const a = doc('a', prog('  n = 1')), b = doc('b', prog('  n = 2'));
  const log = scenario({ docs: [] });
  log.handlers.change({ document: a });
  log.handlers.change({ document: b });
  await sleep(400);
  ok(log.sets.has('a') && log.sets.has('b'), 'debounce is per document');
}
// Run: output goes to a terminal, input is asked for when the program reaches it
{
  const log = scenario({ active: doc('p', prog('  output("Berapa?")\n  input(n)\n  output(n * 2)')) });
  log.run();
  const term = log.term();
  ok(term && term.name === 'Telkom Pseudocode' && term.focus === true, 'run opens a terminal and focuses it when the program reads input');
  ok(term.screen === '', 'nothing runs before the terminal is open');
  term.pty.open();
  ok(await until(() => plain(term.screen).includes('> ')), 'program prints, then waits for input', JSON.stringify(term.screen));
  ok(log.lines()[0] === 'Berapa?', 'output appears before input is given', JSON.stringify(log.lines()));
  term.pty.handleInput('2');
  term.pty.handleInput('x');
  term.pty.handleInput('\x7f'); // backspace
  term.pty.handleInput('1\r');
  ok(await until(() => plain(term.screen).includes('--- done ---')), 'run finishes after the input line', JSON.stringify(term.screen));
  ok(JSON.stringify(log.lines()) === JSON.stringify(['Berapa?', '> 21', '42', '--- done ---']), 'typed line is echoed, edited with backspace and used', JSON.stringify(log.lines()));

  // a second run reuses the terminal and starts from a clean screen
  log.run();
  ok(log.terminals.length === 1, 'the terminal is reused');
  ok(await until(() => plain(term.screen).includes('> ')), 'second run reaches input');
  ok(JSON.stringify(log.lines()) === JSON.stringify(['Berapa?', '> ']), 'screen is cleared between runs', JSON.stringify(log.lines()));
  term.pty.handleInput('\x03'); // Ctrl+C
  ok(plain(term.screen).includes('--- stopped ---'), 'Ctrl+C stops the program', JSON.stringify(term.screen));

  // closing the terminal: the next run opens a new one
  term.pty.close();
  log.run();
  ok(log.terminals.length === 2, 'a closed terminal is replaced');
  log.term().pty.close();
}
// Run: no input -> editor keeps focus; runtime and static errors are shown in the terminal
{
  let log = scenario({ active: doc('p', prog('  n = 1\n  output(n div 0)')) });
  log.run(); log.term().pty.open();
  ok(log.term().focus === false, 'a program without input leaves focus in the editor');
  ok(await until(() => plain(log.term().screen).includes('Runtime error at line 6: Division by zero')), 'runtime error is reported with its line', JSON.stringify(log.term().screen));

  log = scenario({ active: doc('p', prog('  n = "satu"')) });
  log.run(); log.term().pty.open();
  ok(/Cannot run: 1 error/.test(plain(log.term().screen)) && /line 5: Type mismatch/.test(plain(log.term().screen)), 'static errors block the run and are listed', JSON.stringify(log.term().screen));

  log = scenario({ active: doc('p', prog('  { input(n) nanti }\n  n = 3\n  output("input(", n)')) });
  log.run(); log.term().pty.open();
  ok(log.term().focus === false, 'input( in a comment or string is not an input call');
  ok(await until(() => plain(log.term().screen).includes('--- done ---')) && log.lines()[0] === 'input( 3', 'and the program runs', JSON.stringify(log.lines()));
}
// Run: an endless program can be stopped; lines typed ahead are kept for later input()
{
  const { RunSession } = require('./lang/run-session.js');
  let screen = '', ended = 'no';
  let s = new RunSession(prog('  n = 0\n  while true do\n    n = n + 0\n  endwhile'), (d) => { screen += d; }, { onEnd: (r) => { ended = r; }, opts: { maxSteps: 1e12 } });
  s.start();
  await sleep(100);
  s.kill();
  ok(ended === null && !s.running, 'kill stops an endless loop');

  screen = ''; ended = 'no';
  s = new RunSession(prog('  input(a)\n  input(b)\n  output(a + b)', '  a, b : integer'), (d) => { screen += d; }, { onEnd: (r) => { ended = r; } });
  s.start();
  s.handleInput('3\r4\r'); // both lines before the program asked for either
  ok(await until(() => ended !== 'no') && ended.output[0] === '7', 'type-ahead lines feed later input calls', JSON.stringify(ended));
}
// Check File writes to one output channel, created once
{
  const log = scenario({ active: doc('p', prog('  n = 1\n  output(n)')) });
  log.commands['telkomPseudocode.checkFile']();
  log.commands['telkomPseudocode.checkFile']();
  ok(log.channels.length === 1 && log.channels[0].name === 'Telkom Pseudocode', 'one output channel for Check File', JSON.stringify(log.channels.map(c => c.name)));
  ok(JSON.stringify(log.channels[0].lines) === JSON.stringify(['OK: no issues found.']), 'Check File output is cleared between checks', JSON.stringify(log.channels[0].lines));
}
// rename: the box opens on the word under the cursor; reserved words are refused
{
  const p = doc('p', prog('  n = 1\n  output(n)'));
  const log = scenario({ active: p });
  const prep = log.rename.prepareRename(p, { line: 4, character: 2 });
  ok(prep.placeholder === 'n' && JSON.stringify(prep.range.a) === '[4,2,4,3]', 'prepareRename gives the range and the current name', JSON.stringify(prep));
  let msg = '';
  try { log.rename.provideRenameEdits(p, { line: 4, character: 2 }, 'if'); } catch (e) { msg = e.message; }
  ok(/reserved/.test(msg), 'rename to a reserved word is refused', msg);
  const edit = log.rename.provideRenameEdits(p, { line: 4, character: 2 }, 'nilai');
  ok(edit.edits.length === 3, 'rename to a valid name edits every use', JSON.stringify(edit.edits));
  msg = '';
  try { log.rename.prepareRename(p, { line: 3, character: 2 }); } catch (e) { msg = e.message; }
  ok(/Cannot rename/.test(msg), 'a keyword cannot be renamed', msg);
}

if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nAll extension checks passed.');
process.exit(0);
