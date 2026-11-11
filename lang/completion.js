// Completion: getCompletions(text, line, col) -> items. No VS Code import.
// Item: {label, kind, detail, doc, insert, isSnippet, sort}
//   kind: var | const | func | proc | builtin | keyword | type | field
// Reads the analysis model: names come from scopes, fields from resolved types.
'use strict';
const { analyzeProgram } = require('./analyzer');
const { parseExprTokens, tokLen } = require('./parser');
const { BASE_TYPES } = require('./lexer');
const T = require('./types');

const BUILTINS = [
  { label: 'input', insert: 'input(${1:a})', detail: 'input(a, ...)', doc: 'Read space-separated values into variables.' },
  { label: 'output', insert: 'output(${1:x})', detail: 'output(a, ...)', doc: 'Print space-separated values.' },
  { label: 'allocate', insert: 'allocate(${1:p})', detail: 'allocate(p)', doc: 'Allocate a heap node for a pointer variable.' },
  { label: 'deallocate', insert: 'deallocate(${1:p})', detail: 'deallocate(p)', doc: 'Free a heap node.' },
  { label: 'len', insert: 'len(${1:s})', detail: 'len(s: string) -> integer', doc: 'String length.' },
];
const KEYWORD_LABELS = ['if', 'then', 'else', 'endif', 'case', 'of', 'endcase', 'for', 'to', 'do', 'endfor', 'while', 'endwhile', 'repeat', 'until', 'return'];
const ALGO_ITEM = { label: 'algoritma', kind: 'keyword', detail: 'algoritma … end', doc: 'Start of the instructions.', sort: '4_algoritma' };

const isOp = (t, o) => !!t && t.kind === 'op' && t.text === o;
const isWord = (t) => !!t && (t.kind === 'ident' || t.kind === 'keyword' || t.kind === 'constant');
const matches = (prefix) => (i) => !prefix || i.label.toLowerCase().startsWith(prefix.toLowerCase());

/** Never throws: any failure gives no completions. */
function getCompletions(text, line, col) {
  try {
    return complete(text, line, col);
  } catch {
    return [];
  }
}

function complete(text, line, col) {
  const model = analyzeProgram(text);
  const { rawLines, lines, units } = model.ast;
  if (line < 0 || line >= rawLines.length) return [];
  const raw = rawLines[line];
  col = Math.max(0, Math.min(col, raw.length));
  for (const t of lines[line]) { // nothing inside comments and literals
    const end = t.col + t.text.length;
    const open = t.kind === 'error' || (t.kind === 'comment' && !t.text.endsWith('}')); // runs to the end of the line
    if ((t.kind === 'comment' || t.kind === 'string' || t.kind === 'char' || t.kind === 'error') && col > t.col && (open ? col <= end : col < end)) return [];
  }
  const toks = lines[line].filter(t => t.kind !== 'comment' && t.col < col);
  let prefix = '';
  let k = toks.length - 1;
  if (isWord(toks[k]) && col <= toks[k].col + tokLen(toks[k])) { prefix = raw.slice(toks[k].col, col); k--; } // the word being typed
  const unit = unitAt(units, line);

  // after '.' or '->': fields of whatever the access chain before it is
  if (isOp(toks[k], '.') || isOp(toks[k], '->')) {
    const chain = chainTokens(toks, k - 1);
    const e = chain && parseExprTokens(chain);
    if (!e || !unit) return [];
    let t = model.typeOf(e, unit);
    if (toks[k].text === '->') t = t.k === 'pointer' ? t.target : T.UNKNOWN;
    if (t.k !== 'struct') return [];
    return [...t.fields].map(([name, ft]) => ({ label: name, kind: 'field', detail: T.describe(ft), doc: `${toks[k].text}${name} : ${T.describe(ft)}`, sort: '1_' + name })).filter(matches(prefix));
  }

  let items;
  if (!unit) items = topItems();
  else if (line > unit.startLine && unit.algoLine !== null && line >= unit.algoLine) items = bodyItems(model, unit);
  else if (line > unit.startLine && unit.kamusLine !== null && line >= unit.kamusLine) items = declItems(model);
  else items = headerItems(unit);
  return items.filter(matches(prefix));
}

// The tokens of the access chain that ends at toks[end]: p->next, (p->next), d[i + 1].p, f(x)
function chainTokens(toks, end) {
  let i = end;
  for (;;) {
    const t = toks[i];
    if (isOp(t, ']') || isOp(t, ')')) {
      const open = t.text === ']' ? '[' : '(';
      let depth = 0;
      for (; i >= 0; i--) {
        if (isOp(toks[i], t.text)) depth++;
        else if (isOp(toks[i], open) && --depth === 0) break;
      }
      if (i < 0) return null;
      if (open === '[') { i--; continue; } // an index: the chain goes on to its left
      if (!toks[i - 1] || toks[i - 1].kind !== 'ident') return toks.slice(i, end + 1); // ( ... ) grouping starts the chain
      i--; // a call: f( ... )
    } else if (!isWord(t)) return null;
    if (isOp(toks[i - 1], '.') || isOp(toks[i - 1], '->')) { i -= 2; continue; }
    return toks.slice(i, end + 1);
  }
}

// the unit the cursor line belongs to; null between units
function unitAt(units, line) {
  let best = null;
  for (const u of units) if (u.startLine <= line && (!best || u.startLine >= best.startLine)) best = u;
  return best && !(best.closed && line > best.endLine) ? best : null;
}

function topItems() {
  return [
    { label: 'program', kind: 'keyword', detail: 'program NAME … endprogram', doc: 'New program unit.', sort: '4_program' },
    { label: 'function', kind: 'keyword', detail: 'function NAME(params) -> TYPE', doc: 'New function subprogram.', sort: '4_function' },
    { label: 'procedure', kind: 'keyword', detail: 'procedure NAME(params)', doc: 'New procedure subprogram.', sort: '4_procedure' },
  ];
}

function headerItems(unit) {
  const items = [{ label: 'kamus', kind: 'keyword', detail: 'kamus … algoritma', doc: 'Declare variables here, then write algoritma.', sort: '4_kamus' }];
  if (unit.kind !== 'program') items.push(ALGO_ITEM); // kamus is optional in subprograms
  return items;
}

function declItems(model) {
  const src = (span) => (model.ast.rawLines[span.line] || '').slice(span.col, span.endCol);
  const items = BASE_TYPES.map(b => ({ label: b, kind: 'type', detail: 'base type', sort: '4_' + b }));
  items.push({ label: 'array', kind: 'type', detail: 'array[lo..hi] of T', doc: 'Array declaration.', insert: 'array[0..${1:MAX}-1] of ${2:integer}', isSnippet: true, sort: '4_array' });
  items.push({ label: 'pointer', kind: 'type', detail: 'pointer to T', doc: 'Pointer declaration.', insert: 'pointer to ${1:Type}', isSnippet: true, sort: '4_pointer' });
  items.push({ label: 'constant', kind: 'keyword', detail: 'constant NAME : TYPE = value', sort: '4_constant' });
  items.push({ label: 'type', kind: 'keyword', detail: 'type NAME … (alias or struct)', sort: '4_type' });
  items.push(ALGO_ITEM);
  for (const entry of model.typeTable.values())
    items.push({ label: entry.name, kind: 'type', detail: entry.node.k === 'struct' ? 'struct' : `alias of ${src(entry.node.span)}`, sort: '4_' + entry.name });
  return items;
}

function bodyItems(model, unit) {
  const src = (span) => (model.ast.rawLines[span.line] || '').slice(span.col, span.endCol);
  const items = [];
  const scope = model.scopes.get(unit);
  const seen = new Set();
  const addSyms = (syms, global) => {
    for (const s of syms.values()) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      const type = T.describe(s.type);
      const detail = s.kind === 'param' ? `(${s.mode}) ${type}` : s.kind === 'loopvar' ? `loop var : ${type}`
        : `${global ? 'global ' : ''}${s.kind === 'const' ? 'const ' : ''}${global || s.kind === 'const' ? ': ' : ''}${type}`;
      items.push({ label: s.name, kind: s.kind === 'const' ? 'const' : 'var', detail, sort: '0_' + s.name });
    }
  };
  addSyms(scope.syms, false);
  if (scope.parent) addSyms(scope.parent.syms, true);

  for (const sub of model.subs.values()) { // includes the current one: recursion
    const u = sub.unit;
    const groups = []; // names that share one written type and mode: 'in a, b: integer'
    for (const p of u.params) {
      const last = groups[groups.length - 1];
      if (last && last.type === p.type && last.mode === p.mode) last.names.push(p.name);
      else groups.push({ names: [p.name], type: p.type, mode: p.mode });
    }
    const text = groups.map(g => `${u.kind === 'procedure' ? (g.mode || 'in') + ' ' : ''}${g.names.join(', ')}: ${src(g.type.span)}`).join('; ');
    const sig = `(${text})` + (u.kind === 'function' ? ` -> ${u.retType ? src(u.retType.span) : '?'}` : '');
    const first = groups.map(g => g.names[0]);
    items.push({
      label: sub.name,
      kind: u.kind === 'function' ? 'func' : 'proc',
      detail: (u.kind === 'function' ? '' : 'procedure ') + sig,
      doc: `${u.kind === 'function' ? 'Function' : 'Procedure'} ${sub.name}${sig}`,
      insert: first.length ? `${sub.name}(${first.map((n, i) => `\${${i + 1}:${n}}`).join(', ')})` : `${sub.name}()`,
      isSnippet: first.length > 0,
      sort: '2_' + sub.name,
    });
  }
  for (const b of BUILTINS) items.push({ label: b.label, kind: 'builtin', detail: b.detail, doc: b.doc, insert: b.insert, isSnippet: true, sort: '3_' + b.label });
  for (const c of ['NIL', 'true', 'false']) items.push({ label: c, kind: 'const', detail: 'constant', sort: '4_' + c });
  for (const kw of KEYWORD_LABELS)
    items.push({ label: kw, kind: 'keyword', sort: '4_' + kw, doc: kw === 'return' ? 'return <expr> — in procedures, bare `return` exits early.' : undefined });
  return items;
}

module.exports = { getCompletions, complete };
