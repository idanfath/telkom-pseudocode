// VS Code wiring only: diagnostics, Check File, Run File (in a terminal), completion, rename.
// Everything about the language itself lives in lang/ and has no VS Code dependency.
let vscode;
try { vscode = require('vscode'); } catch { vscode = null; }
const { analyze } = require('./lang/analyzer');
const { tokenize } = require('./lang/lexer');
const { RunSession } = require('./lang/run-session');
const { getCompletions } = require('./lang/completion');
const { findRenameRanges, isValidNewName } = require('./lang/rename');

const LANG = 'telkom-pseudocode';
const SEL = { language: LANG };
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

// input(...) as code, not inside a comment or string
const callsInput = (text) => tokenize(text).lines.some(l => l.some(t => t.kind === 'keyword' && t.text === 'input'));

function toVsDiag(d) {
  const line = Math.max(0, d.line);
  const col = Math.max(0, d.col);
  const range = new vscode.Range(line, col, line, Math.max(col + 1, d.endCol || col + 1));
  const sev = d.sev === 0 ? vscode.DiagnosticSeverity.Error
    : d.sev === 1 ? vscode.DiagnosticSeverity.Warning
    : vscode.DiagnosticSeverity.Information;
  const diag = new vscode.Diagnostic(range, d.msg, sev);
  diag.source = LANG;
  return diag;
}

function activate(context) {
  // ---------- live diagnostics ----------
  const collection = vscode.languages.createDiagnosticCollection(LANG);
  const refresh = (doc) => {
    if (!doc || doc.languageId !== LANG) return;
    collection.set(doc.uri, analyze(doc.getText()).map(toVsDiag));
  };
  const timers = new Map(); // per document, so typing in one file never cancels another's refresh
  const schedule = (doc) => {
    const key = String(doc.uri);
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); refresh(doc); }, 300));
  };
  context.subscriptions.push(
    collection,
    { dispose: () => timers.forEach(clearTimeout) },
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidSaveTextDocument(refresh),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri)),
  );
  for (const doc of vscode.workspace.textDocuments || []) refresh(doc); // documents opened before activation

  // ---------- Check File ----------
  const checkOut = vscode.window.createOutputChannel('Telkom Pseudocode');
  context.subscriptions.push(checkOut, vscode.commands.registerCommand('telkomPseudocode.checkFile', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showInformationMessage('No active editor.'); return; }
    const found = analyze(editor.document.getText());
    checkOut.clear();
    if (found.length === 0) checkOut.appendLine('OK: no issues found.');
    else {
      checkOut.appendLine(`Found ${found.length} issue(s):`);
      found.forEach(d => checkOut.appendLine(` - line ${d.line + 1}: ${d.msg}`));
    }
    checkOut.show(true);
  }));

  // ---------- Run File: one terminal, reused for every run ----------
  const screen = new vscode.EventEmitter(); // text for the terminal
  let terminal = null, opened = false, session = null, queued = null;
  const startRun = (text) => {
    if (session) session.kill();
    screen.fire(CLEAR_SCREEN);
    session = new RunSession(text, (data) => screen.fire(data));
    session.start();
  };
  const closeRun = () => {
    if (session) session.kill();
    session = null; terminal = null; opened = false; queued = null;
  };
  context.subscriptions.push(screen, { dispose: () => { const t = terminal; closeRun(); if (t) t.dispose(); } });
  context.subscriptions.push(vscode.commands.registerCommand('telkomPseudocode.runFile', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== LANG) { vscode.window.showInformationMessage('Open a .pseudo file first.'); return; }
    const text = editor.document.getText();
    if (!terminal) {
      terminal = vscode.window.createTerminal({
        name: 'Telkom Pseudocode',
        pty: {
          onDidWrite: screen.event,
          open: () => { opened = true; if (queued !== null) { const t = queued; queued = null; startRun(t); } },
          close: closeRun, // the user closed the terminal: stop whatever is running
          handleInput: (data) => { if (session) session.handleInput(data); },
        },
      });
    }
    terminal.show(!callsInput(text)); // take keyboard focus only when the program will ask for input
    if (opened) startRun(text);
    else queued = text; // the terminal is still opening
  }));

  // ---------- completion ----------
  const KIND_MAP = {
    var: 'Variable', func: 'Function', proc: 'Function', builtin: 'Function',
    keyword: 'Keyword', type: 'Class', field: 'Field', const: 'Constant',
  };
  const toVsItem = (i) => {
    const item = new vscode.CompletionItem(i.label, vscode.CompletionItemKind[KIND_MAP[i.kind] || 'Text']);
    item.detail = i.detail || '';
    if (i.doc) item.documentation = new vscode.MarkdownString(i.doc);
    if (i.isSnippet) item.insertText = new vscode.SnippetString(i.insert);
    else if (i.insert && i.insert !== i.label) item.insertText = i.insert;
    item.sortText = i.sort || i.label;
    return item;
  };
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(SEL, {
    provideCompletionItems: (doc, pos) => getCompletions(doc.getText(), pos.line, pos.character).map(toVsItem),
  }, '.', '>'));

  // ---------- rename ----------
  const renameAt = (doc, pos) => {
    const r = findRenameRanges(doc.getText(), pos.line, pos.character);
    if (!r || !r.ranges.length) throw new Error('Cannot rename this symbol.');
    return r;
  };
  context.subscriptions.push(vscode.languages.registerRenameProvider(SEL, {
    prepareRename(doc, pos) {
      const r = renameAt(doc, pos);
      const here = r.ranges.find(q => q.line === pos.line && pos.character >= q.col && pos.character <= q.endCol) || r.ranges[0];
      return { range: new vscode.Range(here.line, here.col, here.line, here.endCol), placeholder: r.name };
    },
    provideRenameEdits(doc, pos, newName) {
      const invalid = isValidNewName(newName);
      if (invalid) throw new Error(invalid);
      const edit = new vscode.WorkspaceEdit();
      for (const q of renameAt(doc, pos).ranges) edit.replace(doc.uri, new vscode.Range(q.line, q.col, q.line, q.endCol), newName);
      return edit;
    },
  }));
}

function deactivate() {}

// kept for node-side tests (no vscode needed)
function checkDocument(doc) {
  return analyze(typeof doc === 'string' ? doc : doc.getText()).map(d => `${d.line + 1}: ${d.msg}`);
}

module.exports = { activate, deactivate, checkDocument };
