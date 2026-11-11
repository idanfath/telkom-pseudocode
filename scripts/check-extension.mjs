// Extension wiring against a fake `vscode` module: activation, Run input, output channels, rename.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));

let fails = 0;
const ok = (cond, msg, extra = '') => { if (!cond) { fails++; console.error('FAIL:', msg, extra); } else console.log('ok:', msg); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// One shared object: extension.js captures `vscode` once at load; each scenario refills it.
const vscode = {};
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : origLoad.call(this, req, ...rest); };
const ext = require('./extension.js');

function scenario({ docs = [], active = null, answer } = {}) {
  const log = { channels: [], sets: new Map(), prompts: 0, errors: [], handlers: {}, commands: {}, rename: null };
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
      showInputBox: async () => { log.prompts++; return answer; },
      createOutputChannel: (name) => {
        const ch = { name, lines: [], clear() { this.lines = []; }, appendLine(l) { this.lines.push(l); }, show() {}, dispose() {} };
        log.channels.push(ch);
        return ch;
      },
      showErrorMessage: (m) => log.errors.push(m),
      showInformationMessage: () => {},
    },
    commands: { registerCommand: (id, fn) => { log.commands[id] = fn; return disposable; } },
  });
  ext.activate({ subscriptions: [] });
  log.runLines = () => (log.channels.find(c => c.name === 'Telkom Pseudocode Run') || { lines: [] }).lines;
  return log;
}
const doc = (uri, text, languageId = 'telkom-pseudocode') => ({ uri, languageId, getText: () => text });
const prog = (algo) => `program t\nkamus\n  n : integer\nalgoritma\n${algo}\nendprogram`;

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
// Run: Esc at the input box cancels; values typed are used; comment-only "input(" does not prompt
{
  const p = doc('p', prog('  input(n)\n  output(n * 2)'));
  let log = scenario({ active: p, answer: undefined });
  await log.commands['telkomPseudocode.runFile']();
  ok(log.prompts === 1 && !log.runLines().includes('--- done ---') && !log.runLines().length, 'Esc at the input box cancels the run', JSON.stringify(log.runLines()));
  log = scenario({ active: p, answer: '21' });
  await log.commands['telkomPseudocode.runFile']();
  ok(JSON.stringify(log.runLines()) === JSON.stringify(['42', '--- done ---']), 'typed input is used', JSON.stringify(log.runLines()));
  const c = doc('c', prog('  { input(n) nanti }\n  n = 3\n  output("input(", n)'));
  log = scenario({ active: c, answer: '9' });
  await log.commands['telkomPseudocode.runFile']();
  ok(log.prompts === 0 && log.runLines()[0] === 'input( 3', 'input( in a comment or string does not prompt', `${log.prompts} ${JSON.stringify(log.runLines())}`);
}
// output channels are created once, not per command
{
  const p = doc('p', prog('  n = 1\n  output(n)'));
  const log = scenario({ active: p });
  await log.commands['telkomPseudocode.runFile']();
  await log.commands['telkomPseudocode.runFile']();
  log.commands['telkomPseudocode.checkFile']();
  log.commands['telkomPseudocode.checkFile']();
  const count = (name) => log.channels.filter(c => c.name === name).length;
  ok(count('Telkom Pseudocode Run') === 1 && count('Telkom Pseudocode') === 1, 'one output channel each for Run and Check', JSON.stringify(log.channels.map(c => c.name)));
  ok(JSON.stringify(log.runLines()) === JSON.stringify(['1', '--- done ---']), 'Run output is cleared between runs', JSON.stringify(log.runLines()));
}
// rename refuses reserved words as the new name
{
  const p = doc('p', prog('  n = 1\n  output(n)'));
  const log = scenario({ active: p });
  let msg = '';
  try { log.rename.provideRenameEdits(p, { line: 4, character: 2 }, 'if'); } catch (e) { msg = e.message; }
  ok(/reserved/.test(msg), 'rename to a reserved word is refused', msg);
  const edit = log.rename.provideRenameEdits(p, { line: 4, character: 2 }, 'nilai');
  ok(edit.edits.length === 3, 'rename to a valid name edits every use', JSON.stringify(edit.edits));
}

if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nAll extension checks passed.');
process.exit(0);
