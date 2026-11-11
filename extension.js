// Telkom Pseudocode extension: live diagnostics + check command. No dependencies.
let vscode;
try { vscode = require('vscode'); } catch { vscode = null; }
const { analyze } = require('./diagnostics');
const { runInWorker } = require('./parser/run-worker');
const { getCompletions } = require('./parser/completion');
const { findRenameRanges, isValidNewName } = require('./parser/rename');
const { tokenize } = require('./parser/tokenizer');

// input(...) as code, not inside a comment or string
const callsInput = (text) => tokenize(text).lines.some(l => l.some(t => t.kind === 'keyword' && t.text === 'input'));

const SEL = { language: 'telkom-pseudocode' };

function toVsDiag(d) {
  const line = Math.max(0, d.line);
  const col = Math.max(0, d.col);
  const endCol = Math.max(col + 1, d.endCol || col + 1);
  const range = new vscode.Range(line, col, line, endCol);
  const sev = d.sev === 0 ? vscode.DiagnosticSeverity.Error
    : d.sev === 1 ? vscode.DiagnosticSeverity.Warning
    : vscode.DiagnosticSeverity.Information;
  const diag = new vscode.Diagnostic(range, d.msg, sev);
  diag.source = 'telkom-pseudocode';
  return diag;
}

function refresh(doc, collection) {
  if (!doc || doc.languageId !== 'telkom-pseudocode') return;
  try {
    const found = analyze(doc.getText());
    collection.set(doc.uri, found.map(toVsDiag));
  } catch {
    collection.set(doc.uri, []);
  }
}

function activate(context) {
  const collection = vscode.languages.createDiagnosticCollection('telkom-pseudocode');
  context.subscriptions.push(collection);

  const timers = new Map(); // per document, so typing in one file never cancels another's refresh
  const schedule = (doc) => {
    const key = String(doc.uri);
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); refresh(doc, collection); }, 300)); // ponytail: full reparse per keystroke, fine under ~2000 lines
  };
  const checkOut = vscode.window.createOutputChannel('Telkom Pseudocode');
  const runOut = vscode.window.createOutputChannel('Telkom Pseudocode Run');
  context.subscriptions.push(checkOut, runOut, { dispose: () => timers.forEach(clearTimeout) });

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => refresh(doc, collection)),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidSaveTextDocument((doc) => refresh(doc, collection)),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri)),
  );
  // documents opened before activation get diagnostics too, not only the active one
  for (const doc of vscode.workspace.textDocuments || []) refresh(doc, collection);
  if (vscode.window.activeTextEditor) refresh(vscode.window.activeTextEditor.document, collection);

  const cmd = vscode.commands.registerCommand('telkomPseudocode.checkFile', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showInformationMessage('No active editor.'); return; }
    const found = analyze(editor.document.getText());
    const out = checkOut;
    out.clear();
    if (found.length === 0) out.appendLine('OK: no issues found.');
    else { out.appendLine(`Found ${found.length} issue(s):`); found.forEach(d => out.appendLine(` - line ${d.line + 1}: ${d.msg}`)); }
    out.show(true);
  });
  context.subscriptions.push(cmd);

  const runCmd = vscode.commands.registerCommand('telkomPseudocode.runFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'telkom-pseudocode') { vscode.window.showInformationMessage('Open a .pseudo file first.'); return; }
    const text = editor.document.getText();
    const statics = analyze(text).filter(d => d.sev === 0);
    const out = runOut;
    out.clear();
    if (statics.length) {
      vscode.window.showErrorMessage(`Cannot run: ${statics.length} static error(s). Fix them first (see Problems panel).`);
      out.appendLine(`Cannot run: ${statics.length} static error(s). Fix them first (see Problems panel).`);
      out.show(true);
      return;
    }
    let inputText = '';
    if (callsInput(text)) {
      const answer = await vscode.window.showInputBox({
        prompt: 'Program calls input(...). Type values separated by spaces.',
        placeHolder: 'e.g. Budi 7',
      });
      if (answer === undefined) return; // Esc: cancel the run (an empty Enter still runs with no input)
      inputText = answer;
    }
    const r = await runInWorker(text, inputText); // off the extension host thread, full recursion cap
    if (r.staticErrors) { // raced edit between analyze and run; surface plainly
      vscode.window.showErrorMessage(`Cannot run: ${r.staticErrors.length} static error(s).`);
      out.appendLine(`Cannot run: ${r.staticErrors.length} static error(s).`);
    } else {
      for (const line of r.output) out.appendLine(line);
      if (r.error) {
        const msg = `Runtime error at line ${r.error.line + 1}: ${r.error.msg}`;
        out.appendLine(msg);
        vscode.window.showErrorMessage(msg);
      } else out.appendLine('--- done ---');
    }
    out.show(true);
  });
  context.subscriptions.push(runCmd);

  const KIND_MAP = {
    var: 'Variable', func: 'Function', proc: 'Function', builtin: 'Function',
    keyword: 'Keyword', type: 'Class', field: 'Field', const: 'Constant',
  };
  const toVsItem = (i) => {
    const item = new vscode.CompletionItem(i.label, vscode.CompletionItemKind[KIND_MAP[i.kind] || 'Text']);
    item.detail = (i.kind === 'proc' ? 'procedure ' : '') + (i.detail || '');
    if (i.doc) item.documentation = new vscode.MarkdownString(i.doc);
    if (i.isSnippet) item.insertText = new vscode.SnippetString(i.insert);
    else if (i.insert && i.insert !== i.label) item.insertText = i.insert;
    item.sortText = i.sort || i.label;
    return item;
  };
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(SEL, {
      provideCompletionItems(doc, pos) {
        try {
          return getCompletions(doc.getText(), pos.line, pos.character).map(toVsItem);
        } catch {
          return [];
        }
      },
    }, '.', '>')
  );
  context.subscriptions.push(
    vscode.languages.registerRenameProvider(SEL, {
      prepareRename(doc, pos) {
        try {
          const r = findRenameRanges(doc.getText(), pos.line, pos.character);
          if (!r) throw new Error('Cannot rename this symbol.');
          return r.name;
        } catch {
          throw new Error('Cannot rename this symbol.');
        }
      },
      provideRenameEdits(doc, pos, newName) {
        const invalid = isValidNewName(newName);
        if (invalid) throw new Error(invalid);
        let r;
        try { r = findRenameRanges(doc.getText(), pos.line, pos.character); } catch { r = null; }
        if (!r || !r.ranges.length) throw new Error('Cannot rename this symbol.');
        const edit = new vscode.WorkspaceEdit();
        for (const q of r.ranges) edit.replace(doc.uri, new vscode.Range(q.line, q.col, q.line, q.endCol), newName);
        return edit;
      },
    })
  );
}

function deactivate() {}

// kept for node-side tests (no vscode needed)
function checkDocument(doc) {
  return analyze(typeof doc === 'string' ? doc : doc.getText())
    .map(d => `${d.line + 1}: ${d.msg}`);
}

module.exports = { activate, deactivate, checkDocument };
