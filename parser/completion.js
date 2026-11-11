// Dynamic completion core. vscode-free: getCompletions(text, line, col) -> items.
// Item: {label, kind, detail, doc, insert, isSnippet, sort}.
// kind: var|func|proc|builtin|keyword|type|field|const. Never throws: catch-all returns [].
const { tokenize } = require('./tokenizer');
const { parse } = require('./parser');

const BASE_TYPES = ['integer', 'real', 'char', 'boolean', 'string'];
const BUILTINS = [
  { label: 'input', insert: 'input(${1:a})', detail: 'input(a, ...)', doc: 'Read space-separated values into variables.' },
  { label: 'output', insert: 'output(${1:x})', detail: 'output(a, ...)', doc: 'Print space-separated values.' },
  { label: 'allocate', insert: 'allocate(${1:p})', detail: 'allocate(p)', doc: 'Allocate a heap node for a pointer variable.' },
  { label: 'deallocate', insert: 'deallocate(${1:p})', detail: 'deallocate(p)', doc: 'Free a heap node.' },
  { label: 'len', insert: 'len(${1:s})', detail: 'len(s: string) -> integer', doc: 'String length.' },
];
const KEYWORD_LABELS = ['if', 'then', 'else', 'endif', 'case', 'of', 'endcase', 'for', 'to', 'do', 'endfor', 'while', 'endwhile', 'repeat', 'until', 'return'];
const CLOSER_FOR = { program: 'endprogram', function: 'endfunction', procedure: 'endprocedure' };

function getCompletions(text, line, col) {
  try {
    return complete(text, line, col);
  } catch {
    return [];
  }
}

function complete(text, line, col) {
  const rawLines = text.split(/\r?\n/);
  if (line < 0 || line >= rawLines.length) return [];
  const raw = rawLines[line];
  col = Math.max(0, Math.min(col, raw.length));
  const { lines: tokLines } = tokenize(text);
  // suppress inside comments / strings / chars
  for (const t of tokLines[line] || []) {
    if ((t.kind === 'comment' || t.kind === 'string' || t.kind === 'char' || t.kind === 'error') &&
      col > t.col && col < t.col + t.text.length) return [];
  }
  const pre = raw.slice(0, col);
  const { units } = parse(text);
  // field context takes precedence: <access chain>. or <access chain>->
  const fm = pre.match(/(->|\.)\s*([a-zA-Z_]*)$/);
  const chain = fm && chainBefore(pre.slice(0, pre.length - fm[0].length));
  if (chain) {
    const unit = unitAt(units, rawLines, line);
    if (!unit) return [];
    return fieldItems(unit, units, rawLines, line, chain, fm[1], fm[2]);
  }
  const pm = pre.match(/[a-zA-Z_]\w*$/);
  const prefix = pm ? pm[0] : '';
  const unit = unitAt(units, rawLines, line);
  if (!unit) return topItems(prefix);
  if (line <= unit.startLine) return headerItems(prefix, unit);
  if (unit.algoLine !== undefined && line >= unit.algoLine) return bodyItems(unit, units, rawLines, line, prefix);
  if (unit.kamusLine !== undefined && line >= unit.kamusLine) return declItems(units, prefix);
  return headerItems(prefix, unit);
}

// The access chain ending right before a '.'/'->': "(p->next)", "L.first->next", "d[i + 1].p".
// Returns {base, steps: ['[]' | {op, name}]} or null (e.g. "1." in a number).
function chainBefore(s) {
  // walk back over the chain; [...] may hold anything, other text ends it
  let i = s.length, depth = 0;
  while (i > 0) {
    const c = s[i - 1];
    if (c === ']') depth++;
    else if (c === '[') { if (!depth) break; depth--; }
    else if (!depth && !/[\w\s.()>-]/.test(c)) break;
    i--;
  }
  // drop grouping parens; a '(' right after a name opens a call, so the chain starts after it
  let out = '';
  depth = 0;
  for (const c of s.slice(i)) {
    if (c === '[') depth++;
    if (c === ']') depth--;
    if (!depth && c === '(') { if (/\w$/.test(out)) out = ''; continue; }
    if (!depth && c === ')') continue;
    out += c;
  }
  out = out.replace(/\s*(->|\.)\s*/g, '$1').replace(/\s*\[/g, '[');
  const m = out.match(/(?:^|[^\w\]])([a-zA-Z_]\w*)((?:\[[^\]]*\]|(?:->|\.)[a-zA-Z_]\w*)*)$/) || out.match(/^([a-zA-Z_]\w*)((?:\[[^\]]*\]|(?:->|\.)[a-zA-Z_]\w*)*)$/);
  if (!m) return null;
  const steps = [];
  for (const st of m[2].matchAll(/\[[^\]]*\]|(->|\.)([a-zA-Z_]\w*)/g)) steps.push(st[1] ? { op: st[1], name: st[2] } : '[]');
  return { base: m[1], steps };
}

function isPastHeader(unit, line) {
  void unit; void line;
  return false;
}

function unitAt(units, rawLines, n) {
  let best = null;
  for (const u of units) {
    if (u.startLine <= n && (!best || u.startLine > best.startLine)) best = u;
  }
  if (!best) return null;
  if (n <= (best.endLine === undefined ? best.startLine : best.endLine)) return best;
  // past end: keep only if the unit never closed (still being typed)
  const endRaw = (rawLines[best.endLine] || '').trim();
  if (endRaw.startsWith(CLOSER_FOR[best.kind] || 'endprogram')) return null;
  return best;
}

function scopeEntries(unit, units, rawLines, line) {
  const entries = [];
  const seen = new Set();
  const add = (name, kind, detail, type) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    entries.push({ name, kind, detail, type });
  };
  for (const p of unit.params || []) {
    if (p.bad) continue;
    for (const nm of p.names) add(nm, 'param', `(${(p.mode || 'in')}) ${p.type}`, p.type);
  }
  for (const d of unit.decls || []) {
    if (d.kind === 'var') add(d.name, 'var', d.type, d.type);
    else if (d.kind === 'const') add(d.name, 'var', `const : ${d.type}`, d.type);
  }
  for (const n of unit.bodyLines || []) {
    if (n >= line) continue;
    const m = (rawLines[n] || '').match(/^\s*for\s+([a-zA-Z_]\w*)\s*=/);
    if (m) add(m[1], 'var', 'loop var : integer', 'integer');
  }
  const prog = units.find(u => u.kind === 'program');
  if (prog && prog !== unit) {
    for (const d of prog.decls || []) {
      if (d.kind === 'var') add(d.name, 'var', `global : ${d.type}`, d.type);
      else if (d.kind === 'const') add(d.name, 'var', `global const : ${d.type}`, d.type);
    }
  }
  return entries;
}

function typeIndex(units) {
  const structs = new Map(); // name -> [{name, type}]
  const aliases = new Map(); // name -> target string
  for (const u of units) {
    for (const d of u.decls || []) {
      if (d.kind === 'struct') structs.set(d.name, parseStructFields(d.fields || ''));
      else if (d.kind === 'typealias') aliases.set(d.name, d.type);
    }
  }
  return { structs, aliases };
}

function parseStructFields(fieldsStr) {
  const s = fieldsStr.trim().replace(/\s*>\s*$/, '');
  if (!s) return [];
  return s.split(',').map(f => {
    const m = f.match(/^\s*([a-zA-Z_]\w*)\s*(:?)\s*(.*?)\s*$/);
    if (!m || !m[1]) return null;
    if (m[2] !== ':') return { name: m[1], type: m[3] || '', bad: true }; // field needs ':'
    return m[3] ? { name: m[1], type: m[3].trim() } : null;
  }).filter(Boolean);
}

function matchPrefix(label, prefix) {
  return !prefix || label.toLowerCase().startsWith(prefix.toLowerCase());
}

function topItems(prefix) {
  const items = [
    { label: 'program', kind: 'keyword', detail: 'program NAME … endprogram', doc: 'New program unit.', sort: '4_program' },
    { label: 'function', kind: 'keyword', detail: 'function NAME(params) -> TYPE', doc: 'New function subprogram.', sort: '4_function' },
    { label: 'procedure', kind: 'keyword', detail: 'procedure NAME(params)', doc: 'New procedure subprogram.', sort: '4_procedure' },
  ];
  return items.filter(i => matchPrefix(i.label, prefix));
}

const ALGO_ITEM = { label: 'algoritma', kind: 'keyword', detail: 'algoritma … end', doc: 'Start of the instructions.', sort: '4_algoritma' };
function headerItems(prefix, unit) {
  const items = [
    { label: 'kamus', kind: 'keyword', detail: 'kamus … algoritma', doc: 'Declare variables here, then write algoritma.', sort: '4_kamus' },
  ];
  if (unit && unit.kind !== 'program') items.push(ALGO_ITEM); // kamus is optional in subprograms
  return items.filter(i => matchPrefix(i.label, prefix));
}

function declItems(units, prefix) {
  const items = [];
  for (const b of BASE_TYPES) items.push({ label: b, kind: 'type', detail: 'base type', sort: '4_' + b });
  items.push({ label: 'array', kind: 'type', detail: 'array[lo..hi] of T', doc: 'Array declaration.', insert: 'array[0..${1:MAX}-1] of ${2:integer}', isSnippet: true, sort: '4_array' });
  items.push({ label: 'pointer', kind: 'type', detail: 'pointer to T', doc: 'Pointer declaration.', insert: 'pointer to ${1:Type}', isSnippet: true, sort: '4_pointer' });
  items.push({ label: 'constant', kind: 'keyword', detail: 'constant NAME : TYPE = value', sort: '4_constant' });
  items.push({ label: 'type', kind: 'keyword', detail: 'type NAME … (alias or struct)', sort: '4_type' });
  items.push(ALGO_ITEM);
  const { structs, aliases } = typeIndex(units);
  for (const name of structs.keys()) items.push({ label: name, kind: 'type', detail: 'struct', sort: '4_' + name });
  for (const [name, target] of aliases) items.push({ label: name, kind: 'type', detail: `alias of ${target}`, sort: '4_' + name });
  return items.filter(i => matchPrefix(i.label, prefix));
}

function paramGroups(u) {
  const out = [];
  for (const p of u.params || []) {
    if (p.bad) { out.push({ text: p.raw, names: [] }); continue; }
    const mode = p.mode || 'in';
    const text = u.kind === 'procedure' ? `${mode} ${p.names.join(', ')}: ${p.type}` : `${p.names.join(', ')}: ${p.type}`;
    out.push({ text, names: p.names });
  }
  return out;
}

function bodyItems(unit, units, rawLines, line, prefix) {
  const items = [];
  for (const e of scopeEntries(unit, units, rawLines, line)) {
    items.push({ label: e.name, kind: 'var', detail: e.detail, sort: '0_' + e.name });
  }
  for (const u of units) {
    if (u.kind !== 'function' && u.kind !== 'procedure') continue; // includes the current one: recursion
    const groups = paramGroups(u);
    const flat = groups.map(g => g.names[0]).filter(Boolean);
    const sig = `(${groups.map(g => g.text).join('; ')})` + (u.kind === 'function' ? ` -> ${u.retType || '?'}` : '');
    items.push({
      label: u.name,
      kind: u.kind === 'function' ? 'func' : 'proc',
      detail: (u.kind === 'function' ? '' : 'procedure ') + sig,
      doc: u.kind === 'function' ? `Function ${u.name}${sig}` : `Procedure ${u.name}${sig}`,
      insert: flat.length ? `${u.name}(${flat.map((n, i) => `\${${i + 1}:${n}}`).join(', ')})` : `${u.name}()`,
      isSnippet: flat.length > 0,
      sort: '2_' + u.name,
    });
  }
  for (const b of BUILTINS) {
    items.push({ label: b.label, kind: 'builtin', detail: b.detail, doc: b.doc, insert: b.insert, isSnippet: true, sort: '3_' + b.label });
  }
  for (const c of ['NIL', 'true', 'false']) items.push({ label: c, kind: 'const', detail: 'constant', sort: '4_' + c });
  for (const k of KEYWORD_LABELS) {
    items.push({
      label: k, kind: 'keyword', sort: '4_' + k,
      doc: k === 'return' ? 'return <expr> — in procedures, bare `return` exits early.' : undefined,
    });
  }
  return items.filter(i => matchPrefix(i.label, prefix));
}

function fieldItems(unit, units, rawLines, line, chain, accessor, prefix) {
  const e = scopeEntries(unit, units, rawLines, line).find(x => x.name === chain.base);
  if (!e) return [];
  const { structs, aliases } = typeIndex(units);
  // follow aliases to a written-out type: 'Address' -> 'pointer to ElmList'
  const unalias = (t) => {
    for (let k = 0; k < 10 && t; k++) {
      t = String(t).trim();
      if (!aliases.has(t)) return t;
      t = aliases.get(t);
    }
    return null;
  };
  const pointee = (t) => { const m = (unalias(t) || '').match(/^pointer\s+to\s+(.+)$/i); return m ? m[1].trim() : null; };
  const elem = (t) => { const m = (unalias(t) || '').match(/^array\s*\[[^\]]*\]\s*of\s+(.+)$/i); return m ? m[1].trim() : null; };
  const fieldsOf = (t) => { const s = unalias(t); return s && structs.has(s) ? structs.get(s) : null; };
  const fieldType = (t, name) => { const f = (fieldsOf(t) || []).find(x => x.name === name); return f ? f.type : null; };
  let t = e.type;
  for (const st of chain.steps) {
    t = st === '[]' ? elem(t) : fieldType(st.op === '->' ? pointee(t) : t, st.name);
    if (!t) return [];
  }
  const fields = fieldsOf(accessor === '->' ? pointee(t) : t);
  if (!fields) return [];
  return fields
    .filter(f => matchPrefix(f.name, prefix))
    .map(f => ({ label: f.name, kind: 'field', detail: f.type, doc: `${accessor}${f.name} : ${f.type}`, sort: '1_' + f.name }));
}

module.exports = { getCompletions };
