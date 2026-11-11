// Tree-walk interpreter for Telkom pseudocode. No deps.
// runProgram(text, inputText='', opts={}) -> {output, error, staticErrors, leaks}
// Never throws: catch-all converts to line-0 error (must never fire in tests).
const { tokenize } = require('./tokenizer');
const { parse } = require('./parser');
const { analyze } = require('../diagnostics');

const RECURSION_CAP = 1000;
const DEFAULT_STEP_CAP = 500000;

class RTError extends Error { constructor(line, msg) { super(msg); this.line = line; } }

function runProgram(text, inputText = '', opts = {}) {
  const stepCap = opts.maxSteps || DEFAULT_STEP_CAP;
  try {
    const statics = analyze(text).filter(d => d.sev === 0);
    if (statics.length && !opts.ignoreStatic)
      return { output: [], error: null, staticErrors: statics, leaks: 0 };
    return exec(text, inputText, stepCap);
  } catch (e) {
    if (e instanceof RTError) return { output: e.partial || [], error: { line: e.line, msg: e.message }, staticErrors: null, leaks: 0 };
    return { output: [], error: { line: 0, msg: 'Interpreter crash: ' + (e && e.message) }, staticErrors: null, leaks: 0 };
  }
}

// ---------- values ----------
const V = {
  int: v => ({ tag: 'int', v }),
  real: v => ({ tag: 'real', v: v === 0 ? 0 : v }),
  char: v => ({ tag: 'char', v }),
  bool: v => ({ tag: 'bool', v }),
  str: v => ({ tag: 'str', v }),
  nil: () => ({ tag: 'nil' }),
  ptr: id => ({ tag: 'ptr', id }), // id null = NIL
  arr: (lo, hi, elems) => ({ tag: 'arr', lo, hi, elems }),
  struct: (tname, fields) => ({ tag: 'struct', tname, fields }),
};
const isNum = v => v.tag === 'int' || v.tag === 'real';
const numV = v => v.v;
function typeName(v) {
  return { int: 'integer', real: 'real', char: 'char', bool: 'boolean', str: 'string', nil: 'nil', ptr: 'pointer', arr: 'array', struct: v.tname || 'struct' }[v.tag];
}
function cloneVal(v) {
  if (v.tag === 'ptr' && v.bind) return { tag: 'ptr', id: v.id, bind: v.bind };
  if (v.tag === 'arr') return V.arr(v.lo, v.hi, v.elems.map(e => e.assigned ? { ...e, val: cloneVal(e.val) } : { ...e }));
  if (v.tag === 'struct') { const m = new Map(); for (const [k, c] of v.fields) m.set(k, { ...c, val: c.assigned ? cloneVal(c.val) : c.val }); return V.struct(v.tname, m); }
  return { ...v };
}
function fmtVal(v) {
  if (v.tag === 'str') return v.v;
  if (v.tag === 'bool') return v.v ? 'true' : 'false';
  if (v.tag === 'char') return v.v;
  if (v.tag === 'int') return String(v.v);
  if (v.tag === 'real') return String(v.v);
  if (v.tag === 'nil') return 'NIL';
  if (v.tag === 'ptr') {
    if (v.id !== null && v.id !== undefined) return '0x' + v.id.toString(16);
    return v.bind ? '0x' + varAddress(v.bind.cell).toString(16) : 'NIL';
  }
  return null; // compound
}
// Display address for &x: stable per variable within a run, distinct from heap ids.
let varAddrs = new WeakMap(), varAddrSeq = 0;
function varAddress(cell) {
  if (!varAddrs.has(cell)) varAddrs.set(cell, 0x7ffc2000 + 4 * varAddrSeq++);
  return varAddrs.get(cell);
}

// ---------- structure ----------
function exec(text, inputText, stepCap) {
  varAddrs = new WeakMap(); varAddrSeq = 0;
  // executable view of each line: trailing { comments } removed, so headers like
  // 'if x > 0 then { c }' and labels like '1: { c }' read the same as without them
  const rawLines = text.split(/\r?\n/).map(stripComments);
  const { lines } = tokenize(text);
  const parsed = parse(text);
  const units = parsed.units;
  const prog = units.find(u => u.kind === 'program');
  if (!prog) return { output: [], error: { line: 0, msg: 'No program block found' }, staticErrors: null, leaks: 0 };

  // type registry: alias -> resolved descriptor
  const aliases = new Map(); // name -> {kind:'base'|'array'|'pointer'|'struct'|'alias', ...}
  const structs = new Map(); // name -> [{name,type}]
  for (const u of units) for (const d of u.decls) {
    if (d.kind === 'struct') structs.set(d.name, parseFields(d.fields));
    else if (d.kind === 'typealias') aliases.set(d.name, d.type);
  }
  // constants visible to array bounds. Like the type registry this is flat per file:
  // the program's constants win over a same-named constant local to a subprogram.
  const boundConsts = new Map();
  for (const u of units) for (const d of u.decls) {
    if (d.kind === 'const' && (u.kind === 'program' || !boundConsts.has(d.name)))
      boundConsts.set(d.name, { cell: { type: d.type, val: evalConstExpr(d.init, d.line), assigned: true }, kind: 'const' });
  }
  const resolveType = (t, depth = 0, line = 0) => {
    if (depth > 20) throw new RTError(0, 'Cyclic type alias');
    t = t.trim();
    let m;
    if ((m = t.match(/^array\s*\[\s*(.+?)\s*\.\.\s*(.+?)\s*\]\s+of\s+(.+)$/i))) {
      const lo = evalConstBound(m[1], boundConsts, line), hi = evalConstBound(m[2], boundConsts, line);
      return { kind: 'array', lo, hi, elem: resolveType(m[3], depth + 1, line) };
    }
    if ((m = t.match(/^integer\s*\[\s*([+-]?\d+)\s*\.\.\s*([+-]?\d+)\s*\]$/i)))
      return { kind: 'subrange', lo: parseInt(m[1], 10), hi: parseInt(m[2], 10) };
    if ((m = t.match(/^pointer\s+to\s+(.+)$/i))) return { kind: 'pointer', target: m[1].trim() };
    if (/^(integer|real|char|boolean|string)$/i.test(t)) return { kind: 'base', name: t.toLowerCase() };
    if (structs.has(t)) return { kind: 'struct', name: t };
    if (aliases.has(t)) return resolveType(aliases.get(t), depth + 1, line);
    return { kind: 'named', name: t }; // forward ref, resolved at use
  };
  const defaultVal = (desc, line) => {
    if (desc.kind === 'base') return { int: V.int(0), real: V.real(0), char: V.char(' '), boolean: V.bool(false), string: V.str('') }[desc.name];
    if (desc.kind === 'subrange') return V.int(0); // placeholder; cell starts unassigned, range checked on write
    if (desc.kind === 'array') {
      const elems = [];
      for (let i = desc.lo; i <= desc.hi; i++) elems.push({ val: defaultVal(desc.elem, line), assigned: false });
      return V.arr(desc.lo, desc.hi, elems);
    }
    if (desc.kind === 'pointer') return V.ptr(null);
    if (desc.kind === 'struct') {
      const fs = structs.get(desc.name);
      if (!fs) throw new RTError(line, `Unknown type '${desc.name}'`);
      const m = new Map();
      for (const f of fs) m.set(f.name, { val: defaultVal(resolveType(f.type, 0, line), line), assigned: false });
      return V.struct(desc.name, m);
    }
    if (desc.kind === 'named') {
      if (structs.has(desc.name)) return defaultVal({ kind: 'struct', name: desc.name }, line);
      throw new RTError(line, `Unknown type '${desc.name}'`);
    }
  };

  // heap: id -> {desc, val}
  let heapSeq = 1;
  const heap = new Map();
  const freed = new Set();

  // envs
  const globals = new Map();
  const subprogs = new Map();
  for (const u of units) if (u.kind !== 'program') subprogs.set(u.name, u);

  const state = {
    out: [], steps: 0, depth: 0,
    input: inputText.split(/\s+/).filter(s => s.length),
    heap, freed, aliases, structs, resolveType, defaultVal,
    subprogs, stepCap, heapSeq: () => heapSeq++,
    _raw: rawLines, _toks: lines,
  };

  const declUnit = (u, env) => {
    for (const d of u.decls) {
      if (d.kind === 'const') { env.set(d.name, { cell: { type: d.type, val: evalConstExpr(d.init, u.startLine), assigned: true }, kind: 'const' }); continue; }
      if (d.kind === 'typealias' || d.kind === 'struct') continue;
      const desc = resolveType(d.type, 0, d.line);
      env.set(d.name, { cell: { type: canonType(desc, d.type), val: defaultVal(desc, d.line), assigned: false }, kind: 'var' });
    }
    for (const p of (u.params || [])) {
      if (p.bad) throw new RTError(u.startLine, `Bad parameter '${p.raw}'`);
      for (const nm of p.names) env.set(nm, { cell: { type: p.type, val: null, assigned: false }, kind: 'param', mode: p.mode || 'in' });
    }
  };

  // build executable tree for a unit from raw lines (markers known)
  const tree = buildTree(prog, rawLines, lines);
  for (const u of units) if (u.kind !== 'program') u._tree = buildTree(u, rawLines, lines);
  declUnit(prog, globals);
  for (const u of units) if (u.kind !== 'program') { u._env0 = new Map(); }

  state.env = globals;
  state.globals = globals;
  state.unit = prog;
  try {
    execNodes(tree, state, globals, prog);
  } catch (e) {
    if (e instanceof RangeError && /call stack/i.test(e.message)) {
      // JS stack ran out before RECURSION_CAP (main thread has a small stack; the worker runner does not)
      e = new RTError(state.callLine || 0, `Recursion too deep: ran out of stack after ${state.maxDepth} nested calls`);
    }
    if (e instanceof RTError) { e.partial = state.out; throw e; }
    throw e;
  }
  let leaks = 0;
  for (const [id] of heap) if (!freed.has(id)) leaks++;
  const out = state.out.slice();
  if (leaks) out.push(`Warning: ${leaks} heap allocation(s) never deallocated`);
  return { output: out, error: null, staticErrors: null, leaks };
}

// ---------- tree builder (raw-line scan, static gate already passed) ----------
function buildTree(u, rawLines, tokLines) {
  const start = u.algoLine !== undefined ? u.algoLine + 1 : u.startLine + 1;
  const end = u.endLine;
  const { nodes } = buildSeq(start, end, rawLines, tokLines);
  return nodes;
}
function firstKw(n, tokLines) {
  const t = (tokLines[n] || []).find(t => t.kind === 'keyword');
  return t ? t.text : null;
}
function buildSeq(i, end, rawLines, tokLines, stopAtLabels = false) {
  const nodes = [];
  while (i < end) {
    const raw = rawLines[i];
    if (/^\s*$/.test(raw) || ((tokLines[i] || []).length && (tokLines[i] || []).every(t => t.kind === 'comment'))) { i++; continue; }
    if (stopAtLabels && /^\s*else\s*:|^\s*.+?:\s*$/.test(raw) && !/^\s*(if|for|while|repeat|case|else|until|endif|endcase|endfor|endwhile)\b/.test(raw)) break;
    const kw = firstKw(i, tokLines);
    if (kw === 'if') {
      const cond = raw.slice(raw.search(/\bif\b/) + 2);
      const node = { t: 'if', line: i, branches: [{ cond: cond.replace(/\bthen\s*$/, '').trim(), nodes: null }], elseNodes: null };
      i++;
      let r = buildSeq(i, end, rawLines, tokLines); node.branches[0].nodes = r.nodes; i = r.i;
      // else-check before endif: an else after our endif belongs to an enclosing if/case
      while (i < end && /^\s*else\b/.test(rawLines[i])) {
        if (/^\s*else\s+if\b/.test(rawLines[i])) {
          const c = rawLines[i].slice(rawLines[i].search(/\bif\b/) + 2).replace(/\bthen\s*$/, '').trim();
          i++; r = buildSeq(i, end, rawLines, tokLines);
          node.branches.push({ cond: c, nodes: r.nodes }); i = r.i;
        } else { i++; r = buildSeq(i, end, rawLines, tokLines); node.elseNodes = r.nodes; i = r.i; break; }
      }
      if (i < end && firstKw(i, tokLines) === 'endif') i++;
      nodes.push(node); continue;
    }
    if (kw === 'for' || kw === 'while' || kw === 'repeat' || kw === 'case') {
      nodes.push(buildBlock(kw, i, end, rawLines, tokLines)); i = nodes[nodes.length - 1]._next; delete nodes[nodes.length - 1]._next; continue;
    }
    if (['endif', 'endcase', 'endfor', 'endwhile', 'until', 'else'].includes(kw)) break;
    if (['endprogram', 'endfunction', 'endprocedure', 'kamus', 'algoritma', 'dictionary', 'algorithm', 'program', 'function', 'procedure'].includes(kw)) { i++; continue; }
    nodes.push({ t: 'stmt', line: i }); i++;
  }
  return { nodes, i };
}
function buildBlock(kw, n, end, rawLines, tokLines) {
  const raw = rawLines[n];
  if (kw === 'for') {
    const m = raw.match(/for\s+([a-zA-Z_]\w*)\s*=\s*(.+?)\s+to\s+(.+?)\s+do/);
    if (!m) throw new RTError(n, "Missing 'do' or 'to' in for loop — for i = a to b do");
    const r = buildSeq(n + 1, end, rawLines, tokLines);
    let nx = r.i;
    if (nx < end && firstKw(nx, tokLines) === 'endfor') nx++;
    return { t: 'for', line: n, var: m[1], from: m[2].trim(), to: m[3].trim(), body: r.nodes, _next: nx };
  }
  if (kw === 'while') {
    const m = raw.match(/while\s+(.+?)\s+do/);
    if (!m) throw new RTError(n, "Missing 'do' after the while condition");
    const r = buildSeq(n + 1, end, rawLines, tokLines);
    let nx = r.i;
    if (nx < end && firstKw(nx, tokLines) === 'endwhile') nx++;
    return { t: 'while', line: n, cond: m[1].trim(), body: r.nodes, _next: nx };
  }
  if (kw === 'repeat') {
    // find matching until at depth 0
    let j = n + 1, depth = 0, cond = null, closeIdx = -1;
    while (j < end) {
      const k = firstKw(j, tokLines);
      if (['if', 'for', 'while', 'case', 'repeat'].includes(k)) depth++;
      if (['endif', 'endfor', 'endwhile', 'endcase'].includes(k)) depth--;
      if (k === 'until') {
        if (depth === 0) { cond = rawLines[j].replace(/^\s*until\s*/, '').trim(); closeIdx = j; break; }
        depth--; // closes a nested repeat
      }
      j++;
    }
    const r = buildSeq(n + 1, closeIdx === -1 ? end : closeIdx, rawLines, tokLines);
    return { t: 'repeat', line: n, cond, endLine: closeIdx, body: r.nodes, _next: (closeIdx === -1 ? end : closeIdx + 1) };
  }
  // case
  const m = raw.match(/case\s+(.+?)\s+of/);
  if (!m) throw new RTError(n, "Missing 'of' after the case expression");
  const branches = []; let elseNodes = null; let i = n + 1;
  while (i < end) {
    const r2 = rawLines[i];
    if (/^\s*$/.test(r2) || ((tokLines[i] || []).length && (tokLines[i] || []).every(t => t.kind === 'comment'))) { i++; continue; }
    const k2 = firstKw(i, tokLines);
    if (k2 === 'endcase') { i++; break; }
    if (/^\s*else\s*:/.test(r2)) { i++; const r = buildSeq(i, end, rawLines, tokLines, true); elseNodes = r.nodes; i = r.i; continue; }
    const lm = r2.match(/^\s*(.+?):\s*$/);
    if (lm && !/^\s*(if|for|while|repeat|case|else|until|endif|endcase|endfor|endwhile)\b/.test(r2)) {
      const labels = lm[1];
      i++; const r = buildSeq(i, end, rawLines, tokLines, true);
      branches.push({ labels, nodes: r.nodes }); i = r.i; continue;
    }
    break; // shouldn't happen post-static
  }
  return { t: 'case', line: n, expr: m[1].trim(), branches, elseNodes, _next: i };
}

// ---------- exec ----------
function tick(state, line) {
  if (++state.steps > state.stepCap) throw new RTError(line, 'Execution limit exceeded (possible infinite loop)');
}
function execNodes(nodes, state, env, unit) {
  for (const nd of nodes) {
    if (nd.t === 'stmt') { tick(state, nd.line); execStmt(nd.line, state, env, unit); }
    else if (nd.t === 'if') {
      tick(state, nd.line);
      let done = false;
      for (const b of nd.branches) {
        if (asBool(evalExpr(b.cond, state, env, nd.line), nd.line)) { execNodes(b.nodes, state, env, unit); done = true; break; }
      }
      if (!done && nd.elseNodes) execNodes(nd.elseNodes, state, env, unit);
    }
    else if (nd.t === 'for') {
      tick(state, nd.line);
      const a = evalExpr(nd.from, state, env, nd.line), b = evalExpr(nd.to, state, env, nd.line);
      if (a.tag !== 'int' || b.tag !== 'int') throw new RTError(nd.line, 'for bounds must be integers');
      const ent = envLookup(env, state, nd.var, nd.line, false);
      if (!ent) throw new RTError(nd.line, `Undeclared loop variable '${nd.var}' — declare it in kamus`);
      const cell = ent.cell;
      cell.assigned = true;
      for (let v = a.v; v <= b.v; v++) {
        tick(state, nd.line);
        cell.val = V.int(v); cell.assigned = true;
        execNodes(nd.body, state, env, unit);
      }
    }
    else if (nd.t === 'while') {
      while (true) {
        tick(state, nd.line);
        if (!asBool(evalExpr(nd.cond, state, env, nd.line), nd.line)) break;
        execNodes(nd.body, state, env, unit);
      }
    }
    else if (nd.t === 'repeat') {
      if (nd.endLine === -1 || nd.cond === null) throw new RTError(nd.line, "repeat without 'until'");
      while (true) {
        tick(state, nd.line);
        execNodes(nd.body, state, env, unit);
        tick(state, nd.endLine);
        if (asBool(evalExpr(nd.cond, state, env, nd.endLine), nd.endLine)) break;
      }
    }
    else if (nd.t === 'case') {
      tick(state, nd.line);
      const v = evalExpr(nd.expr, state, env, nd.line);
      let hit = false;
      for (const br of nd.branches) {
        for (const lab of splitLabels(br.labels)) {
          const lv = evalExpr(lab, state, env, nd.line);
          if (eqVal(v, lv)) { execNodes(br.nodes, state, env, unit); hit = true; break; }
        }
        if (hit) break;
      }
      if (!hit && nd.elseNodes) execNodes(nd.elseNodes, state, env, unit);
    }
  }
}
function asBool(v, line) {
  if (v.tag !== 'bool') throw new RTError(line, 'Non-boolean condition');
  return v.v;
}
function eqVal(a, b) {
  if (a.tag === 'int' && b.tag === 'real') return a.v === b.v;
  if (a.tag === 'real' && b.tag === 'int') return a.v === b.v;
  if (a.tag !== b.tag) return false;
  if (a.tag === 'ptr') {
    if ((a.bind || b.bind) && (a.id === null || a.id === undefined || b.id === null || b.id === undefined))
      return (a.bind || null) === (b.bind || null) && (a.id || null) === (b.id || null);
    return a.id === b.id;
  }
  return a.v === b.v;
}

function execStmt(n, state, env, unit) {
  const raw = stateRaw(state, n);
  const toks = stateToks(state, n).filter(t => t.kind !== 'comment');
  if (!toks.length) return;
  const stripped = stripComments(raw);
  if (!stripped.trim()) return;
  const kw = toks[0].kind === 'keyword' ? toks[0].text : null;
  if (kw === 'input' || kw === 'output' || kw === 'allocate' || kw === 'deallocate') return execBuiltin(kw, n, state, env, unit);
  if (kw === 'return') {
    const expr = stripped.replace(/^\s*return\s*/, '');
    if (unit.kind === 'program') throw new RTError(n, "'return' is only allowed inside a function or procedure");
    if (unit.kind === 'procedure') {
      if (expr.trim()) throw new RTError(n, 'Procedures do not return values');
      throw { early: true };
    }
    if (!expr.trim()) throw new RTError(n, `return needs a value in function '${unit.name}'`);
    const rv = evalExpr(expr, state, env, n);
    checkTypeFits(unit.retType, rv, `return of '${unit.name}'`, n, state, 'return');
    throw { value: rv };
  }
  // subprogram call statement: name(...)
  const callM = stripped.match(/^\s*([a-zA-Z_]\w*)\s*\((.*)\)\s*$/s);
  if (callM && (state.subprogs.has(callM[1]) || ['len'].includes(callM[1]))) {
    if (state.subprogs.has(callM[1])) { callSub(callM[1], splitArgsTop(callM[2]), state, env, n); return; }
    evalExpr(stripped, state, env, n); return;
  }
  // assignment (not ==, not <-; <- already static error)
  // split at first bare '=' in ORIGINAL (strings may contain '='); match target on stripped copy
  const eqAt = findBareEq(stripped);
  if (eqAt !== -1) {
    const code = stripStringsLn(stripped);
    if (/^\s*(.+?)\s*=(?!=)\s*(.+)$/s.test(code)) {
      assignTarget(code.slice(0, code.indexOf('=')).trim(), stripped.slice(eqAt + 1), n, state, env, unit, raw);
      return;
    }
  }
  if (/^\s*[a-zA-Z_]\w*\s*(\([^)]*\))?\s*$/.test(stripped)) {
    const nm = stripped.trim().match(/^([a-zA-Z_]\w*)/)[1];
    if (state.subprogs.has(nm)) { callSub(nm, [], state, env, n); return; }
    throw new RTError(n, `Unknown subprogram '${nm}'`);
  }
  throw new RTError(n, `Cannot execute: '${stripped.trim().slice(0, 40)}'`);
}

// ---------- builtins ----------
function execBuiltin(kw, n, state, env, unit) {
  const raw = stateRaw(state, n);
  const inner = raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')'));
  const args = inner.trim() ? splitArgsTop(inner) : [];
  if (kw === 'output') {
    const parts = [];
    for (const a of args) {
      const v = evalExpr(a, state, env, n);
      const f = fmtVal(v);
      if (f === null) throw new RTError(n, 'Cannot output compound value (print elements)');
      parts.push(f);
    }
    state.out.push(parts.join(' '));
    return;
  }
  if (kw === 'input') {
    if (!args.length) throw new RTError(n, 'input needs at least one variable');
    for (const a of args) {
      const lv = evalLvalue(a.trim(), state, env, n);
      if (lv.kind === 'const') throw new RTError(n, `Cannot assign to constant '${a.trim()}'`);
      const tok = state.input.length ? state.input.shift() : null;
      if (tok === null) throw new RTError(n, `Not enough input values for '${a.trim()}'`);
      // aliases (e.g. a field typed Infotype) resolve to their base type before parsing
      const vt = canonType(state.resolveType(lv.vartype || 'string', 0, n), lv.vartype || 'string');
      lv.write(parseInput(tok, vt, a.trim(), n));
    }
    return;
  }
  // pointer-typed target, through aliases: p, p->next, L.first, a param typed Address
  const pointerTarget = (lv, what, src) => {
    const ti = declaredTypeInfo(lv.vartype, state);
    if (!ti || ti.tag !== 'pointer') throw new RTError(n, `${what} expects a pointer variable '${src}'`);
    return ti.target;
  };
  if (kw === 'allocate') {
    if (args.length !== 1) throw new RTError(n, 'allocate expects one argument');
    const lv = evalLvalue(args[0].trim(), state, env, n);
    const target = pointerTarget(lv, 'allocate', args[0].trim());
    const id = state.heapSeq();
    const desc = state.resolveType(target, 0, n);
    state.heap.set(id, { desc, val: state.defaultVal(desc, n) });
    lv.write(V.ptr(id));
    return;
  }
  if (kw === 'deallocate') {
    if (args.length !== 1) throw new RTError(n, 'deallocate expects one argument');
    const lv = evalLvalue(args[0].trim(), state, env, n);
    pointerTarget(lv, 'deallocate', args[0].trim());
    const v = lv.cell.val;
    if (!v || v.tag !== 'ptr' || v.id === null) throw new RTError(n, 'NIL pointer dereference');
    if (state.freed.has(v.id) || !state.heap.has(v.id)) throw new RTError(n, 'Double free of pointer');
    state.heap.delete(v.id); state.freed.add(v.id);
    return;
  }
}
function parseInput(tok, vartype, name, line) {
  const t = (vartype || '').toLowerCase();
  const base = t.match(/^(integer|real|char|boolean|string)/)?.[1] || t;
  if (base === 'integer') {
    if (!/^[+-]?\d+$/.test(tok)) throw new RTError(line, `Invalid input '${tok}' for integer '${name}'`);
    const v = V.int(parseInt(tok, 10));
    const sub = t.match(/^integer\s*\[\s*([+-]?\d+)\s*\.\.\s*([+-]?\d+)\s*\]/);
    if (sub) {
      const lo = parseInt(sub[1], 10), hi = parseInt(sub[2], 10);
      if (v.v < lo || v.v > hi) throw new RTError(line, `Value ${v.v} out of subrange [${lo}..${hi}] for '${name}'`);
    }
    return v;
  }
  if (base === 'real') { if (!/^[+-]?(\d+\.\d*|\d*\.\d+|\d+)$/.test(tok)) throw new RTError(line, `Invalid input '${tok}' for real '${name}'`); return V.real(parseFloat(tok)); }
  if (base === 'boolean') { if (tok !== 'true' && tok !== 'false') throw new RTError(line, `Invalid input '${tok}' for boolean '${name}'`); return V.bool(tok === 'true'); }
  if (base === 'char') { if ([...tok].length !== 1) throw new RTError(line, `Invalid input '${tok}' for char '${name}'`); return V.char(tok); }
  return V.str(tok);
}

// ---------- subprogram calls ----------
function callSub(fname, argStrs, state, env, line) {
  const target = state.subprogs.get(fname);
  if (!target) throw new RTError(line, `Unknown subprogram '${fname}'`);
  if (++state.depth > RECURSION_CAP) throw new RTError(line, `Maximum recursion depth exceeded (${RECURSION_CAP})`);
  state.callLine = line; state.maxDepth = Math.max(state.maxDepth || 0, state.depth); // for stack-overflow reports
  try {
    const flat = [];
    for (const p of (target.params || [])) { if (p.bad) throw new RTError(line, `Bad parameter '${p.raw}'`); for (const nm of p.names) flat.push({ mode: p.mode || 'in', name: nm, type: p.type }); }
    if (argStrs.length !== flat.length) throw new RTError(line, `Wrong argument count for '${fname}' (expected ${flat.length}, got ${argStrs.length})`);
    const frame = new Map();
    for (const d of target.decls) {
      if (d.kind === 'const') { frame.set(d.name, { cell: { type: d.type, val: evalConstExpr(d.init, d.line), assigned: true }, kind: 'const' }); continue; }
      if (d.kind === 'typealias' || d.kind === 'struct') continue;
      const desc = state.resolveType(d.type, 0, d.line);
      frame.set(d.name, { cell: { type: canonType(desc, d.type), val: state.defaultVal(desc, d.line), assigned: false }, kind: 'var' });
    }
    for (let i = 0; i < flat.length; i++) {
      const f = flat[i], a = argStrs[i].trim();
      if (target.kind === 'function' || f.mode === 'in') {
        const v = evalExpr(a, state, env, line);
        checkTypeFits(f.type, v, `${fname}.${f.name}`, line, state, 'argument');
        frame.set(f.name, { cell: { type: canonType(state.resolveType(f.type, 0, line), f.type), val: cloneVal(v), assigned: true }, kind: 'param', mode: f.mode });
      } else {
        const lv = evalLvalue(a, state, env, line); // must be lvalue; errors if const? out-param write allowed
        // in/out args: check the lvalue's declared type against the param type
        if (f.mode === 'in/out') {
          const have = declaredTypeInfo(lv.vartype || (lv.cell && lv.cell.type), state);
          const want = declaredTypeInfo(f.type, state);
          if (have && want) {
            const eq = sameTypeInfo(want, have);
            if (eq !== true && eq !== 'coerce')
              throw new RTError(line, `Type mismatch in argument '${fname}.${f.name}' (expected ${describeTypeInfo(want)}, got ${describeTypeInfo(have)})`);
          }
        }
        // writes through this cell must fit the CALLER's declared type
        const entry = { cell: lv.cell, kind: 'param', mode: f.mode, callerType: lv.vartype || (lv.cell && lv.cell.type) };
        if (f.mode === 'out') { lv.cell.val = state.defaultVal(state.resolveType(f.type), line); lv.cell.assigned = false; }
        frame.set(f.name, entry); // shared cell
      }
    }
    const prevEnv = state.env, prevUnit = state.unit;
    state.env = frame; state.unit = target;
    let ret = null, returned = false;
    try { execNodes(target._tree, state, frame, target); }
    catch (e) { if (e && e.early) { /* procedure early exit */ } else if (e && 'value' in e) { ret = e.value; returned = true; } else throw e; }
    finally { state.env = prevEnv; state.unit = prevUnit; }
    if (target.kind === 'function') {
      if (!returned) throw new RTError(line, `Function '${fname}' finished without return`);
      return ret;
    }
    return null;
  } finally { state.depth--; }
}

// ---------- lvalues & assignment ----------
function assignTarget(targetSrc, exprSrc, line, state, env, unit, raw) {
  let v = evalExpr(exprSrc, state, env, line);
  // plain var?
  const lv = evalLvalue(targetSrc.trim(), state, env, line);
  if (lv.kind === 'const') throw new RTError(line, `Cannot assign to constant '${lv.name}'`);
  if (lv.isArrWhole) throw new RTError(line, 'Cannot assign array — copy element by element');
  // char -> string on assignment to a string variable (skill: t = s[i]); not for s[i] = 'a'
  if (v.tag === 'char' && !lv.isStringElem) {
    const ti = declaredTypeInfo(lv.callerType || lv.vartype, state);
    if (ti && ti.tag === 'string') v = V.str(v.v);
  }
  checkAssign(lv.vartype, v, lv.name, line);
  // out/in-out params: the write flows into the caller's cell, so the caller's type governs
  const gov = lv.callerType || lv.vartype;
  checkTypeFits(gov, v, lv.name, line, state, 'assignment');
  lv.write(cloneVal(v));
}
function checkAssign(vartype, v, name, line) {
  const t = (vartype || '').toLowerCase();
  if (/^array/i.test(t)) throw new RTError(line, 'Cannot assign array — copy element by element');
  const base = t.match(/^(integer|real|char|boolean|string)/)?.[1];
  const sub = t.match(/^integer\s*\[\s*([+-]?\d+)\s*\.\.\s*([+-]?\d+)\s*\]/);
  const want = { integer: 'int', real: 'real', char: 'char', boolean: 'bool', string: 'str' }[base];
  if (!want) return; // pointer/struct/alias: structural checks below
  if (v.tag === want) {
    if (sub && v.tag === 'int') {
      const lo = parseInt(sub[1], 10), hi = parseInt(sub[2], 10);
      if (v.v < lo || v.v > hi) throw new RTError(line, `Value ${v.v} out of subrange [${lo}..${hi}] for '${name}'`);
    }
    return;
  }
  if (want === 'real' && v.tag === 'int') return; // int -> real allowed
  throw new RTError(line, `Type mismatch in assignment to '${name}' (expected ${base}, got ${typeName(v)})`);
}
// evalLvalue returns {cell (for plain var) | write(), vartype, kind, name, ptype/target for pointers}
// '(P->info).nim' and '((L.first)->next)->info' are plain access chains: grouping parens
// and spaces outside [...] carry no meaning. A '(' right after a name is a call: leave it.
function normalizeTarget(s) {
  let out = '', br = 0;
  for (const c of s) {
    if (c === '[') br++;
    if (c === ']') br--;
    if (br === 0 && /\s/.test(c)) continue;
    if (br === 0 && (c === '(' || c === ')')) {
      if (c === '(' && /[\w\])]$/.test(out)) return s.trim();
      continue;
    }
    out += c;
  }
  return out;
}
function evalLvalue(src, state, env, line) {
  src = normalizeTarget(src);
  // deref *p
  let m;
  if ((m = src.match(/^\*\s*([a-zA-Z_]\w*)$/))) {
    const e = envLookup(env, state, m[1], line, true);
    if (!e) throw new RTError(line, `Undeclared identifier '${m[1]}'`);
    const v = e.cell.val;
    if (!v || v.tag !== 'ptr' || (v.id === null && !v.bind)) throw new RTError(line, 'NIL pointer dereference');
    if (v.bind && (v.id === null || v.id === undefined)) {
      const b = v.bind;
      const vt = e.cell.type.replace(/^pointer\s+to\s+/i, '');
      return { kind: 'var', name: src, vartype: vt, isDeref: true, write: (nv) => { b.cell.val = nv; b.cell.assigned = true; }, cell: b.cell };
    }
    const h = state.heap.get(v.id);
    if (!h || state.freed.has(v.id)) throw new RTError(line, 'Use after free');
    const vt = e.cell.type.replace(/^pointer\s+to\s+/i, '');
    return {
      kind: 'var', name: src, vartype: vt, isDeref: true, write: (nv) => { h.val = nv; },
      cell: { type: vt, get val() { return h.val; }, set val(nv) { h.val = nv; }, get assigned() { return true; }, set assigned(_) {} },
    };
  }
  // chain: base (-> f | . f | [e])*
  const baseM = src.match(/^([a-zA-Z_]\w*)/);
  if (!baseM) throw new RTError(line, `Bad assignment target '${src}'`);
  const e = envLookup(env, state, baseM[1], line, true);
  if (!e) throw new RTError(line, `Undeclared identifier '${baseM[1]}'`);
  let rest = src.slice(baseM[1].length);
  if (!rest.trim()) {
    if (e.kind === 'const') return { kind: 'const', name: baseM[1], cell: e.cell, vartype: e.cell.type };
    const pt = /^pointer\s+to\s+(.+)$/i.exec(e.cell.type || '');
    return {
      kind: e.kind, name: baseM[1], cell: e.cell, vartype: e.cell.type,
      callerType: e.callerType || null, // set for out/in-out params: writes flow into caller's cell
      ptype: pt ? 'pointer' : null, target: pt ? pt[1] : null,
      write: (nv) => { e.cell.val = nv; e.cell.assigned = true; },
    };
  }
  // walk chain on a CLONE path? No — resolve live refs.
  // curType tracks the DECLARED type string of curVal so writes are type-checked.
  let curVal = e.cell.val;
  let curType = e.cell.type;
  const fieldTypeOfStruct = (structName, field) => {
    const fs = state.structs.get(structName);
    if (!fs) return null;
    const f = fs.find(x => x.name === field);
    return f ? f.type : null;
  };
  const structNameOfType = (t) => {
    const ti = declaredTypeInfo(t, state);
    return ti && ti.tag === 'struct' ? ti.tname : null;
  };
  let parent = null, parentKey = null, parentIsHeap = false, heapEntry = null;
  const touched = []; // slots passed through: a write to d[1].a or (P->info).nim also sets d[1] / P->info
  const steps = [];
  const stepRe = /^(->|\.)([a-zA-Z_]\w*)|^(\[([^\]]*)\])/;
  let r = rest;
  while (r.trim()) {
    const mm = r.trim().match(/^(->|\.)([a-zA-Z_]\w*)|^\[([^\]]*)\]/);
    if (!mm) throw new RTError(line, `Bad assignment target '${src}'`);
    steps.push(mm); r = r.slice(mm[0].length);
  }
  const derefVal = (v, what) => {
    if (!v) throw new RTError(line, 'NIL pointer dereference');
    if (v.tag === 'ptr' && v.bind && (v.id === null || v.id === undefined)) return { val: v.bind.cell.val };
    if (v.tag !== 'ptr' || v.id === null) throw new RTError(line, 'NIL pointer dereference');
    const h = state.heap.get(v.id);
    if (!h || state.freed.has(v.id)) throw new RTError(line, 'Use after free');
    return h;
  };
  for (const st of steps) {
    if (st[1] === '->') {
      const h = derefVal(curVal, '->');
      heapEntry = h;
      const sv = h.val;
      if (!sv || sv.tag !== 'struct') throw new RTError(line, `Cannot access field '${st[2]}' of non-struct`);
      const f = sv.fields.get(st[2]);
      if (!f) throw new RTError(line, `Unknown field '${st[2]}'`);
      touched.push(f);
      parent = sv.fields; parentKey = st[2]; parentIsHeap = true;
      curVal = f.val; curType = fieldTypeOfStruct(sv.tname, st[2]);
    } else if (st[1] === '.') {
      if (!curVal || curVal.tag !== 'struct') throw new RTError(line, `Cannot access field '${st[2]}' of non-struct`);
      const f = curVal.fields.get(st[2]);
      if (!f) throw new RTError(line, `Unknown field '${st[2]}'`);
      const parentStruct = curVal.tname || structNameOfType(curType);
      touched.push(f);
      parent = curVal.fields; parentKey = st[2]; parentIsHeap = false;
      curVal = f.val; curType = fieldTypeOfStruct(parentStruct, st[2]);
    } else {
      const idx = evalExpr(st[3], state, env, line);
      if (curVal && curVal.tag === 'str' && idx.tag === 'int') {
        // string element: handled by caller via special path
        return stringElemLvalue(e, curVal, parent, parentKey, idx.v, line, state);
      }
      if (!curVal || curVal.tag !== 'arr') throw new RTError(line, `Cannot index non-array`);
      if (idx.tag !== 'int') throw new RTError(line, 'Array index must be integer');
      if (idx.v < curVal.lo || idx.v > curVal.hi) throw new RTError(line, `Array index ${idx.v} out of bounds [${curVal.lo}..${curVal.hi}]`);
      const slot = curVal.elems[idx.v - curVal.lo];
      touched.push(slot);
      parent = curVal.elems; parentKey = idx.v - curVal.lo; parentIsHeap = false;
      curVal = slot.val;
      const am = String(curType || '').match(/^array\s*\[[^\]]*\]\s+of\s+(.+)$/i);
      curType = am ? am[1].trim() : curType;
    }
  }
  if (parent === null) throw new RTError(line, `Bad assignment target '${src}'`);
  // The element/field behaves as a variable of its own: input(), in/out and out bind to this cell.
  const slotOf = () => (parent instanceof Map ? parent.get(parentKey) : parent[parentKey]);
  const markPath = () => { for (const s of touched) s.assigned = true; e.cell.assigned = true; };
  const finalWrite = (nv) => { const s = slotOf(); s.val = nv; s.assigned = true; markPath(); };
  const cell = {
    type: curType,
    get val() { return slotOf().val; }, set val(nv) { slotOf().val = nv; markPath(); },
    get assigned() { return slotOf().assigned; }, set assigned(b) { slotOf().assigned = b; },
  };
  return { kind: e.kind === 'const' ? 'const' : 'var', name: src, vartype: curType, cell, write: finalWrite };
}
function fTypeName() { return ''; }
function fieldTypeOf() { return ''; }
function elemTypeOf() { return ''; }
// resolve a declared type string against the program's struct/alias tables
function declaredTypeInfo(t, state) {
  const structs = state.structs, aliases = state.aliases;
  const seen = new Set();
  const go = (s, depth) => {
    if (s === undefined || s === null || depth > 10) return null;
    s = String(s).trim();
    if (seen.has(s.toLowerCase())) return null;
    seen.add(s.toLowerCase());
    if (/^(integer|real|char|boolean|string)$/i.test(s)) return { tag: s.toLowerCase() };
    const sub = s.match(/^integer\s*\[\s*([+-]?\d+)\s*\.\.\s*([+-]?\d+)\s*\]$/i);
    if (sub) return { tag: 'integer', sub: [parseInt(sub[1], 10), parseInt(sub[2], 10)] };
    const pt = s.match(/^pointer\s+to\s+(.+)$/i);
    if (pt) return { tag: 'pointer', target: pt[1].trim() };
    const ar = s.match(/^array\s*\[[^\]]*\]\s+of\s+(.+)$/i); // first [..] only: 2D arrays nest in the element
    if (ar) return { tag: 'array', elem: go(ar[1], depth + 1) };
    if (structs.has(s)) return { tag: 'struct', tname: s };
    if (aliases.has(s)) return go(aliases.get(s), depth + 1);
    return null; // unknown / forward ref: checked elsewhere or at runtime
  };
  return go(t, 0);
}
// structural type equality (base tags; pointers by target; int counts as real-compatible via caller)
function sameTypeInfo(a, b) {
  if (!a || !b) return false;
  if (a.tag === 'real' && b.tag === 'integer') return 'coerce';
  if (a.tag !== 'integer' || b.tag !== 'integer') {
    if (a.tag !== b.tag) return false;
  }
  if (a.tag === 'pointer' || b.tag === 'pointer') {
    if (a.tag !== 'pointer' || b.tag !== 'pointer') return false;
    return (a.target || '').toLowerCase() === (b.target || '').toLowerCase() ? true : false;
  }
  if (a.tag === 'array') return sameTypeInfo(a.elem, b ? b.elem : null) === true;
  if (a.tag === 'struct') return (a.tname || '').toLowerCase() === (b.tname || '').toLowerCase();
  return true;
}
// runtime value -> declared-type-shape of its producer
function valueTypeInfo(v, state) {
  if (!v) return null;
  if (v.tag === 'int') return { tag: 'integer' };
  if (v.tag === 'real') return { tag: 'real' };
  if (v.tag === 'char') return { tag: 'char' };
  if (v.tag === 'bool') return { tag: 'boolean' };
  if (v.tag === 'str') return { tag: 'string' };
  if (v.tag === 'nil') return { tag: 'nil' };
  if (v.tag === 'ptr') {
    if (v.bind) {
      const bt = declaredTypeInfo(v.bind.cell.type, state);
      if (bt) return { tag: 'pointer', target: describeTypeInfo(bt) }; // &x: pointer to (type of x)
      return { tag: 'pointer', target: '?' };
    }
    return { tag: 'pointer', target: v.id }; // heap id: target resolved via heap below
  }
  if (v.tag === 'arr') return { tag: 'array', elem: null };
  if (v.tag === 'struct') return { tag: 'struct', tname: v.tname };
  return null;
}
function describeTypeInfo(ti) {
  if (!ti) return 'unknown';
  if (ti.tag === 'pointer') return `pointer to ${ti.target || '?'}`;
  if (ti.tag === 'array') return `array of ${ti.elem ? describeTypeInfo(ti.elem) : '?'}`;
  return ti.tag;
}
// central type gate: value `v` must fit declared type string `vartype`
function heapTargetName(v, state) {
  if (!v || v.tag !== 'ptr' || typeof v.id !== 'number') return null;
  const h = state.heap.get(v.id);
  if (!h || !h.desc) return null;
  if (h.desc.kind === 'base') return h.desc.name;
  if (h.desc.kind === 'struct') return h.desc.name;
  if (h.desc.kind === 'subrange') return 'integer';
  return null;
}
function checkTypeFits(vartype, v, name, line, state, what) {
  const want = declaredTypeInfo(vartype, state);
  if (!want) return; // unresolvable here: runtime structural errors fire on use
  const got = valueTypeInfo(v, state);
  if (!got) throw new RTError(line, `Type mismatch in ${what} '${name}' (cannot determine value type)`);
  const mismatch = () => {
    let gotDesc = describeTypeInfo(got);
    if (got.tag === 'pointer' && typeof got.target === 'number') {
      const hn = heapTargetName(v, state);
      gotDesc = hn ? `pointer to ${hn}` : 'pointer';
    }
    throw new RTError(line, `Type mismatch in ${what} '${name}' (expected ${describeTypeInfo(want)}, got ${gotDesc})`);
  };
  if (got.tag === 'nil') {
    if (want.tag === 'pointer') return; // NIL fits any pointer
  } else if (want.tag === 'array' || got.tag === 'array') {
    if (what === 'assignment') throw new RTError(line, 'Cannot assign array — copy element by element');
    // passing/returning an array: same bounds, and every set element fits the element type
    if (want.tag !== 'array' || got.tag !== 'array') mismatch();
    const wd = state.resolveType(vartype, 0, line);
    if (wd.lo !== v.lo || wd.hi !== v.hi)
      throw new RTError(line, `Type mismatch in ${what} '${name}' (expected array[${wd.lo}..${wd.hi}], got array[${v.lo}..${v.hi}])`);
    const elemType = canonType(wd.elem, '?');
    for (const slot of v.elems) if (slot.assigned) checkTypeFits(elemType, slot.val, name, line, state, what);
    return;
  } else if (want.tag === 'pointer' || got.tag === 'pointer') {
    // heap-id values: resolve target via heap descriptor
    if (got.tag === 'pointer' && typeof got.target === 'number') {
      const hd = heapTargetName(v, state);
      if (!hd) return; // freed/unknown heap: use-after-free fires on use
      if ((want.target || '').toLowerCase() === '?') return;
      if (want.tag === 'pointer' && (want.target || '').toLowerCase() === hd.toLowerCase()) return;
    } else {
      const eq = sameTypeInfo(want, got);
      if (eq === true) return;
      if (eq === 'coerce') return;
    }
  } else {
    const eq = sameTypeInfo(want, got);
    if (eq === true) return;
    if (eq === 'coerce') return; // int -> real allowed
  }
  mismatch();
}
function stringElemLvalue(baseEntry, strVal, parent, parentKey, idx, line, state) {
  if (idx < 0 || idx >= strVal.v.length) throw new RTError(line, `String index ${idx} out of bounds (len ${strVal.v.length})`);
  return {
    kind: baseEntry.kind === 'const' ? 'const' : 'var', name: '[string-index]', vartype: 'string', cell: baseEntry.cell, isStringElem: true,
    write: (nv) => {
      let ch;
      if (nv.tag === 'str' && [...nv.v].length === 1) ch = nv.v;
      else throw new RTError(line, `Type mismatch in string element assignment (expected single character string)`);
      const s = strVal.v;
      const arr = [...s]; arr[idx] = ch;
      const nw = arr.join('');
      if (parent instanceof Map) { const f = parent.get(parentKey); f.val = V.str(nw); f.assigned = true; }
      else if (parent) { parent[parentKey].val = V.str(nw); parent[parentKey].assigned = true; }
      else { baseEntry.cell.val = V.str(nw); baseEntry.cell.assigned = true; }
    },
  };
}

// ---------- expressions (recursive descent over token slice) ----------
function exprToks(src, state, line) {
  const { lines } = tokenize(src);
  const out = [];
  for (const t of lines[0] || []) {
    if (t.kind === 'comment') continue;
    // an expression holds no assignment: a lone 'x<-1' is 'x < -1'
    if (t.kind === 'op' && t.text === '<-') out.push({ ...t, text: '<' }, { ...t, text: '-', col: t.col + 1 });
    else out.push(t);
  }
  return out;
}
function evalExpr(src, state, env, line) {
  const toks = exprToks(src, state, line);
  if (!toks.length) throw new RTError(line, 'Empty expression');
  const p = { toks, i: 0, state, env, line, src };
  const v = parseOr(p);
  if (p.i < p.toks.length) throw new RTError(line, `Unexpected '${p.toks[p.i].text}' in expression`);
  return v;
}
function peek(p) { return p.toks[p.i]; }
function next(p) { return p.toks[p.i++]; }
// Short-circuit: advance past an operand without evaluating it. Stops at a same-level
// stop keyword, at a ',' or at the bracket that closes the enclosing group.
function skipOperand(p, stops) {
  let depth = 0;
  for (let t = peek(p); t; t = peek(p)) {
    if (t.kind === 'op' && (t.text === '(' || t.text === '[')) depth++;
    else if (t.kind === 'op' && (t.text === ')' || t.text === ']')) { if (depth === 0) return; depth--; }
    else if (depth === 0 && (t.text === ',' || (t.kind === 'keyword' && stops.includes(t.text)))) return;
    next(p);
  }
}
function parseOr(p) {
  let v = parseAnd(p);
  while (peek(p) && peek(p).kind === 'keyword' && peek(p).text === 'or') {
    next(p);
    if (v.tag === 'bool' && v.v === true) { skipOperand(p, ['or']); continue; }
    const r = parseAnd(p);
    v = V.bool(asBool(v, p.line) || asBool(r, p.line));
  }
  return v;
}
function parseAnd(p) {
  let v = parseNot(p);
  while (peek(p) && peek(p).kind === 'keyword' && peek(p).text === 'and') {
    next(p);
    if (v.tag === 'bool' && v.v === false) { skipOperand(p, ['and', 'or']); continue; }
    const r = parseNot(p);
    v = V.bool(asBool(v, p.line) && asBool(r, p.line));
  }
  return v;
}
function parseNot(p) {
  if (peek(p) && peek(p).kind === 'keyword' && peek(p).text === 'not') { next(p); const v = parseNot(p); return V.bool(!asBool(v, p.line)); }
  return parseCmp(p);
}
function parseCmp(p) {
  let v = parseAdd(p);
  const t = peek(p);
  if (t && t.kind === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(t.text)) {
    next(p);
    const r = parseAdd(p);
    return V.bool(applyCmp(t.text, v, r, p.line));
  }
  return v;
}
function applyCmp(op, a, b, line) {
  if (a.tag === 'struct' || b.tag === 'struct') throw new RTError(line, `Type mismatch: cannot '${op}' struct values — compare field by field`);
  if (a.tag === 'arr' || b.tag === 'arr') throw new RTError(line, `Type mismatch: cannot '${op}' arrays — compare element by element`);
  if (op === '==' || op === '!=') {
    // NIL compares freely with pointers and NIL
    if (a.tag === 'nil' || b.tag === 'nil') {
      if (a.tag !== 'nil' && a.tag !== 'ptr') throw new RTError(line, `Type mismatch: cannot '${op}' ${typeName(a)} and ${typeName(b)}`);
      if (b.tag !== 'nil' && b.tag !== 'ptr') throw new RTError(line, `Type mismatch: cannot '${op}' ${typeName(a)} and ${typeName(b)}`);
      const eq = eqVal(a, b);
      return op === '==' ? eq : !eq;
    }
    const eq = eqVal(a, b);
    if (!eq && !(sameCmpClass(a, b))) throw new RTError(line, `Type mismatch: cannot '${op}' ${typeName(a)} and ${typeName(b)}`);
    return op === '==' ? eq : !eq;
  }
  if ((isNum(a) && isNum(b)) || (a.tag === 'char' && b.tag === 'char')) {
    const x = a.tag === 'char' ? a.v.codePointAt(0) : numV(a);
    const y = b.tag === 'char' ? b.v.codePointAt(0) : numV(b);
    if (op === '<') return x < y; if (op === '>') return x > y;
    if (op === '<=') return x <= y; return x >= y;
  }
  throw new RTError(line, `Type mismatch: cannot '${op}' ${typeName(a)} and ${typeName(b)}`);
}
function sameCmpClass(a, b) {
  if (a.tag === b.tag) return true;
  if (isNum(a) && isNum(b)) return true;
  return false;
}
function parseAdd(p) {
  let v = parseMul(p);
  while (peek(p) && peek(p).kind === 'op' && (peek(p).text === '+' || peek(p).text === '-')) {
    const op = next(p).text;
    const r = parseMul(p);
    v = applyAdd(op, v, r, p.line);
  }
  return v;
}
function applyAdd(op, a, b, line) {
  if (op === '+') {
    if (a.tag === 'str' && b.tag === 'str') return V.str(a.v + b.v);
    if (isNum(a) && isNum(b)) {
      if (a.tag === 'real' || b.tag === 'real') return V.real(numV(a) + numV(b));
      return V.int(a.v + b.v);
    }
    throw new RTError(line, `Type mismatch: cannot '+' ${typeName(a)} and ${typeName(b)}`);
  }
  if (isNum(a) && isNum(b)) {
    if (a.tag === 'real' || b.tag === 'real') return V.real(numV(a) - numV(b));
    return V.int(a.v - b.v);
  }
  throw new RTError(line, `Type mismatch: cannot '-' ${typeName(a)} and ${typeName(b)}`);
}
function parseMul(p) {
  let v = parseUnary(p);
  for (;;) {
    const t = peek(p);
    if (t && t.kind === 'op' && (t.text === '*' || t.text === '/')) {
      next(p);
      const r = parseUnary(p);
      if (t.text === '*') {
        if (!isNum(v) || !isNum(r)) throw new RTError(p.line, `Type mismatch: cannot '*' ${typeName(v)} and ${typeName(r)}`);
        v = (v.tag === 'real' || r.tag === 'real') ? V.real(numV(v) * numV(r)) : V.int(v.v * r.v);
      } else {
        if (v.tag === 'int' && r.tag === 'int') throw new RTError(p.line, "Type mismatch: 'integer / integer' not allowed — use div");
        if (!isNum(v) || !isNum(r)) throw new RTError(p.line, `Type mismatch: cannot '/' ${typeName(v)} and ${typeName(r)}`);
        if (numV(r) === 0) throw new RTError(p.line, 'Division by zero');
        v = V.real(numV(v) / numV(r));
      }
      continue;
    }
    if (t && t.kind === 'keyword' && (t.text === 'div' || t.text === 'mod')) {
      next(p);
      const r = parseUnary(p);
      if (t.text === 'div') {
        if (v.tag === 'int' && r.tag === 'int') {
          if (r.v === 0) throw new RTError(p.line, 'Division by zero');
          v = V.int(Math.trunc(v.v / r.v));
        } else if (isNum(v) && isNum(r)) {
          if (numV(r) === 0) throw new RTError(p.line, 'Division by zero');
          v = V.real(numV(v) / numV(r)); // unconfirmed: real div real allowed
        } else throw new RTError(p.line, `Type mismatch: cannot 'div' ${typeName(v)} and ${typeName(r)}`);
      } else {
        if (!isNum(v) || !isNum(r)) throw new RTError(p.line, `Type mismatch: cannot 'mod' ${typeName(v)} and ${typeName(r)}`);
        if (numV(r) === 0) throw new RTError(p.line, 'Modulo by zero');
        v = (v.tag === 'real' || r.tag === 'real') ? V.real(numV(v) % numV(r)) : V.int(v.v % r.v); // truncated, matching div
      }
      continue;
    }
    break;
  }
  return v;
}
function parseUnary(p) {
  const t = peek(p);
  if (t && t.kind === 'op' && t.text === '-') { next(p); const v = parseUnary(p); if (!isNum(v)) throw new RTError(p.line, `Type mismatch: cannot negate ${typeName(v)}`); return v.tag === 'int' ? V.int(-v.v) : V.real(-v.v); }
  return parsePostfix(p);
}
function parsePostfix(p) {
  let v = parsePrimary(p);
  for (;;) {
    const t = peek(p);
    if (t && t.kind === 'op' && t.text === '(') {
      // call in expression — only functions/len; handled by reparsing slice
      return parseCallRest(p, v);
    }
    if (t && t.kind === 'op' && t.text === '[') {
      next(p);
      const idx = parseOr(p);
      const c = peek(p);
      if (!c || c.kind !== 'op' || c.text !== ']') throw new RTError(p.line, "Expected ']'");
      next(p);
      v = indexVal(v, idx, p.line);
      continue;
    }
    if (t && t.kind === 'op' && t.text === '->') {
      next(p);
      const f = peek(p);
      if (!f || (f.kind !== 'ident' && f.kind !== 'keyword')) throw new RTError(p.line, "Expected field name after '->'");
      next(p);
      v = fieldVal(v, f.text, p.line, p.state, true);
      continue;
    }
    if (t && t.kind === 'op' && t.text === '.') {
      next(p);
      const f = peek(p);
      if (!f || (f.kind !== 'ident' && f.kind !== 'keyword')) throw new RTError(p.line, "Expected field name after '.'");
      next(p);
      v = fieldVal(v, f.text, p.line, p.state, false);
      continue;
    }
    break;
  }
  return v;
}
function indexVal(v, idx, line) {
  if (v.tag === 'str') {
    if (idx.tag !== 'int') throw new RTError(line, 'String index must be integer');
    if (idx.v < 0 || idx.v >= v.v.length) throw new RTError(line, `String index ${idx.v} out of bounds (len ${v.v.length})`);
    return V.char([...v.v][idx.v]); // read yields char (skill: unconfirmed coerce on assign handled by checker)
  }
  if (v.tag !== 'arr') throw new RTError(line, 'Cannot index non-array');
  if (idx.tag !== 'int') throw new RTError(line, 'Array index must be integer');
  if (idx.v < v.lo || idx.v > v.hi) throw new RTError(line, `Array index ${idx.v} out of bounds [${v.lo}..${v.hi}]`);
  const slot = v.elems[idx.v - v.lo];
  if (!slot.assigned) throw new RTError(line, `Uninitialized array element [${idx.v}]`);
  return cloneVal(slot.val);
}
function fieldVal(v, field, line, state, deref) {
  let sv = v;
  if (deref) sv = derefHeap(v, line, state).val;
  if (!sv || sv.tag !== 'struct') throw new RTError(line, `Cannot access field '${field}' of non-struct`);
  const f = sv.fields.get(field);
  if (!f) throw new RTError(line, `Unknown field '${field}'`);
  if (!f.assigned) throw new RTError(line, `Uninitialized variable '${field}'`);
  return cloneVal(f.val);
}
function parsePrimary(p) {
  const t = peek(p);
  if (!t) throw new RTError(p.line, 'Empty expression');
  if (t.kind === 'number') { next(p); return t.text.includes('.') ? V.real(parseFloat(t.text)) : V.int(Number(t.text)); } // Number: decimal or 0x hex
  if (t.kind === 'string') { next(p); return V.str(unescapeStr(t.text.slice(1, -1))); }
  if (t.kind === 'char') { next(p); return V.char(unescapeStr(t.text.slice(1, -1))); }
  if (t.kind === 'constant') {
    next(p);
    if (t.text === 'true') return V.bool(true);
    if (t.text === 'false') return V.bool(false);
    return V.nil();
  }
  if (t.kind === 'op' && t.text === '(') {
    next(p); const v = parseOr(p);
    const c = peek(p);
    if (!c || c.kind !== 'op' || c.text !== ')') throw new RTError(p.line, "Expected ')'");
    next(p); return v;
  }
  if (t.kind === 'op' && t.text === '&') {
    next(p);
    const idt = peek(p);
    if (!idt || idt.kind !== 'ident') throw new RTError(p.line, "'&' needs a variable");
    next(p);
    const e = envLookup(p.env, p.state, idt.text, p.line, true);
    if (!e) throw new RTError(p.line, `Undeclared identifier '${idt.text}'`);
    if (e.kind === 'const') throw new RTError(p.line, `Cannot take address of constant '${idt.text}'`);
    return { tag: 'ptr', id: null, bind: e }; // pointer to a variable (not heap)
  }
  if (t.kind === 'op' && t.text === '*') {
    next(p);
    const v = parsePostfix(p);
    // *p as rvalue
    const h = derefHeap(v, p.line, p.state);
    if (!h.val || !h.val.tag) throw new RTError(p.line, 'NIL pointer dereference');
    return cloneVal(h.val);
  }
  if (t.kind === 'ident' || (t.kind === 'keyword' && !isReservedWord(t.text))) {
    next(p);
    const nx = peek(p);
    if (nx && nx.kind === 'op' && nx.text === '(') return parseCallRest(p, { tag: 'callname', name: t.text });
    const e = envLookup(p.env, p.state, t.text, p.line, true);
    if (!e) throw new RTError(p.line, `Undeclared identifier '${t.text}'`);
    if (!e.cell.assigned) throw new RTError(p.line, `Uninitialized variable '${t.text}'`);
    return cloneVal(e.cell.val);
  }
  throw new RTError(p.line, `Unexpected '${t.text}' in expression`);
}
function isReservedWord(w) {
  return ['program', 'kamus', 'algoritma', 'endprogram', 'function', 'endfunction', 'procedure', 'endprocedure', 'return', 'if', 'then', 'else', 'endif', 'case', 'of', 'endcase', 'for', 'to', 'do', 'endfor', 'while', 'endwhile', 'repeat', 'until', 'input', 'output', 'allocate', 'deallocate', 'integer', 'real', 'char', 'boolean', 'string', 'array', 'of', 'pointer', 'to', 'type', 'constant', 'in', 'out', 'div', 'mod', 'and', 'or', 'not'].includes(w);
}
function derefHeap(v, line, state) {
  if (!v) throw new RTError(line, 'NIL pointer dereference');
  if (v.tag === 'ptr' && v.bind && (v.id === null || v.id === undefined)) return { bound: v.bind, val: v.bind.cell.val, boundWrite: (nv) => { v.bind.cell.val = nv; v.bind.cell.assigned = true; } };
  if (v.tag !== 'ptr' || v.id === null) throw new RTError(line, 'NIL pointer dereference');
  const h = state.heap.get(v.id);
  if (!h || state.freed.has(v.id)) throw new RTError(line, 'Use after free');
  return h;
}
function parseCallRest(p, v) {
  // consume ( args ) where v is value or {tag:'callname'}
  next(p); // (
  const args = [];
  if (peek(p) && !(peek(p).kind === 'op' && peek(p).text === ')')) {
    for (;;) {
      args.push(collectArg(p));
      const c = peek(p);
      if (c && c.text === ',' && (c.kind === 'sep' || c.kind === 'op')) { next(p); continue; }
      break;
    }
  }
  const c = peek(p);
  if (!c || c.kind !== 'op' || c.text !== ')') throw new RTError(p.line, "Expected ')'");
  next(p);
  const name = v.tag === 'callname' ? v.name : null;
  if (name === 'len') {
    if (args.length !== 1) throw new RTError(p.line, 'len expects 1 argument');
    const s = args[0];
    if (s.tag !== 'str') throw new RTError(p.line, `len expects string, got ${typeName(s)}`);
    return V.int([...s.v].length);
  }
  if (!name) throw new RTError(p.line, 'Only function calls supported in expressions');
  return callSubExpr(name, args, p);
  function collectArg(p) {
    // parse one full expression but stop at top-level , or )
    const depth = 0;
    const startI = p.i;
    const val = parseOr(p);
    // parseOr stops at , or ) naturally since they're not operators
    return val;
  }
}
function callSubExpr(name, argVals, p) {
  const target = p.state.subprogs.get(name);
  if (!target) throw new RTError(p.line, `Unknown subprogram '${name}'`);
  if (target.kind !== 'function') throw new RTError(p.line, `'${name}' is a procedure, cannot use in expression`);
  // convert evaluated values back to source? No — call engine needs lvalues for out params; functions take all-in so values suffice.
  // type-check function args here (callSubExpr path has values, no source strings)
  const flat = [];
  for (const pr of (target.params || [])) { if (pr.bad) throw new RTError(p.line, `Bad parameter '${pr.raw}'`); for (const nm of pr.names) flat.push({ name: nm, type: pr.type }); }
  if (argVals.length !== flat.length) throw new RTError(p.line, `Wrong argument count for '${name}' (expected ${flat.length}, got ${argVals.length})`);
  for (let i = 0; i < flat.length; i++) checkTypeFits(flat[i].type, argVals[i], `${name}.${flat[i].name}`, p.line, p.state, 'argument');
  // Reuse callSub via literal reconstruction is lossy; instead invoke frame directly:
  return callFunctionVals(target, argVals, p.state, p.env, p.line);
}
function callFunctionVals(target, argVals, state, env, line) {
  if (++state.depth > RECURSION_CAP) throw new RTError(line, `Maximum recursion depth exceeded (${RECURSION_CAP})`);
  state.callLine = line; state.maxDepth = Math.max(state.maxDepth || 0, state.depth); // for stack-overflow reports
  try {
    const flat = [];
    for (const pr of (target.params || [])) { if (pr.bad) throw new RTError(line, `Bad parameter '${pr.raw}'`); for (const nm of pr.names) flat.push({ mode: pr.mode || 'in', name: nm, type: pr.type }); }
    if (argVals.length !== flat.length) throw new RTError(line, `Wrong argument count for '${target.name}' (expected ${flat.length}, got ${argVals.length})`);
    const frame = new Map();
    for (const d of target.decls) {
      if (d.kind === 'const') { frame.set(d.name, { cell: { type: d.type, val: evalConstExpr(d.init, d.line), assigned: true }, kind: 'const' }); continue; }
      if (d.kind === 'typealias' || d.kind === 'struct') continue;
      const desc = state.resolveType(d.type, 0, d.line);
      frame.set(d.name, { cell: { type: canonType(desc, d.type), val: state.defaultVal(desc, d.line), assigned: false }, kind: 'var' });
    }
    for (let i = 0; i < flat.length; i++) frame.set(flat[i].name, { cell: { type: canonType(state.resolveType(flat[i].type, 0, line), flat[i].type), val: cloneVal(argVals[i]), assigned: true }, kind: 'param', mode: flat[i].mode });
    const prevEnv = state.env, prevUnit = state.unit;
    state.env = frame; state.unit = target;
    let ret = null, returned = false;
    try { execNodes(target._tree, state, frame, target); }
    catch (e) { if (e && 'value' in e) { ret = e.value; returned = true; } else throw e; }
    finally { state.env = prevEnv; state.unit = prevUnit; }
    if (!returned) throw new RTError(line, `Function '${target.name}' finished without return`);
    return ret;
  } finally { state.depth--; }
}

// ---------- helpers ----------
function envLookup(env, state, name, line, need) {
  if (env && env.has(name)) return env.get(name);
  if (state.env && state.env !== env && state.env.has(name)) return state.env.get(name);
  if (state.globals && state.globals.has(name)) return state.globals.get(name); // program kamus, visible to subprograms
  return null;
}
function stateRaw(state, n) { return state._raw[n]; }
function stateToks(state, n) { return state._toks[n]; }
function stripComments(raw) {
  let out = '', inStr = false, q = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) { out += c; if (c === '\\') { out += raw[i + 1] || ''; i++; } else if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; q = c; out += c; continue; }
    if (c === '{') break;
    out += c;
  }
  return out;
}
function stripStringsLn(s) {
  return s.replace(/"([^"\\]|\\.)*"/g, '""').replace(/'(\\.|[^'\\])'/g, "'c'");
}
function findBareEq(s) {
  let inS = false, q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inS) { if (c === '\\') i++; else if (c === q) inS = false; continue; }
    if (c === '"' || c === "'") { inS = true; q = c; continue; }
    if (c === '=' && s[i + 1] !== '=') return i;
    if (c === '=' && s[i + 1] === '=') { i++; continue; }
  }
  return -1;
}
function splitArgsTop(s) {
  const out = []; let depth = 0, cur = '', inS = false, q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inS) { cur += c; if (c === '\\') { cur += s[i + 1] || ''; i++; } else if (c === q) inS = false; continue; }
    if (c === '"' || c === "'") { inS = true; q = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += c;
  }
  if (cur !== '' || out.length) out.push(cur);
  return out.map(x => x.trim()).filter(x => x.length || out.length === 1);
}
function splitLabels(s) {
  return splitArgsTop(s);
}
function canonType(desc, raw) {
  if (desc.kind === 'base') return desc.name;
  if (desc.kind === 'subrange') return `integer[${desc.lo}..${desc.hi}]`;
  if (desc.kind === 'pointer') return 'pointer to ' + desc.target;
  if (desc.kind === 'array') return `array[${desc.lo}..${desc.hi}] of ${canonType(desc.elem, '?')}`;
  if (desc.kind === 'struct') return desc.name;
  return raw.trim();
}
function parseFields(fieldsStr) {
  fieldsStr = fieldsStr.trim().replace(/\s*>\s*$/, '');
  return splitArgsTop(fieldsStr).map(f => {
    const m = f.match(/^\s*([a-zA-Z_]\w*)\s*(:?)\s*(.*)$/);
    if (!m) return null;
    if (m[2] !== ':') return { name: m[1], type: m[3].trim() || '', bad: true }; // field needs ':'
    return { name: m[1], type: m[3].trim() };
  }).filter(f => f && f.name);
}
function evalConstBound(s, consts, line) {
  const fail = () => new RTError(line, `Non-constant array bound '${s.trim()}'`);
  let v;
  try { v = evalExpr(s, { subprogs: new Map() }, consts, line); } // no subprograms, only constants in scope
  catch (e) { throw e instanceof RTError ? fail() : e; }
  if (v.tag !== 'int') throw fail();
  return v.v;
}
function evalConstExpr(src, line) {
  const t = src.trim();
  if (/^[+-]?\d+$/.test(t)) return V.int(parseInt(t, 10));
  if (/^0[xX][0-9a-fA-F]+$/.test(t)) return V.int(Number(t));
  if (/^[+-]?(\d+\.\d*|\d*\.\d+)$/.test(t)) return V.real(parseFloat(t));
  if (/^".*"$/.test(t)) return V.str(unescapeStr(t.slice(1, -1)));
  if (/^'(\\.|[^'\\])'$/.test(t)) return V.char(unescapeStr(t.slice(1, -1)));
  if (t === 'true') return V.bool(true);
  if (t === 'false') return V.bool(false);
  throw new RTError(line, `Non-constant initializer '${src}'`);
}
function unescapeStr(s) {
  return s.replace(/\\(.)/g, '$1');
}

module.exports = { runProgram };
