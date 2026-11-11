// Analysis: syntax tree -> model. One pass over the tree resolves every name, works out
// every type and reports everything that can be known before running: undeclared names,
// type errors, wrong arguments, use before assignment, unused declarations.
//
// The model is what the rest of the extension reads:
//   diagnostics  model.diags
//   runner       model.scopes / model.subs / resolved types
//   completion   model.scopes / model.typeTable / model.typeOf
//   rename       model.refs (every place a declared name is written)
'use strict';
const { parse, err, warn, info } = require('./parser');
const T = require('./types');
const { INT, REAL, CHAR, BOOL, STRING, NIL, UNKNOWN, isUnknown, isInt, isNum, describe } = T;

/**
 * @typedef {import('./parser').Program} Program
 * @typedef {import('./parser').Unit} Unit
 * @typedef {import('./parser').Span} Span
 * @typedef {import('./parser').Diag} Diag
 * @typedef {import('./types').Type} Type
 *
 * A declared name. `refs` lists every place it is written, its declaration included.
 * @typedef {object} Sym
 * @property {'var'|'const'|'param'|'loopvar'|'type'|'sub'|'program'} kind
 * @property {string} name
 * @property {Span[]} refs
 * @property {Unit} [unit]
 * @property {Span} [span]        declaration
 * @property {Type} [type]        var / const / param
 * @property {'in'|'out'|'in/out'} [mode]  param: the mode in effect
 * @property {{type: Type, value: any}} [value]  const
 * @property {boolean} [implicit] loop variable that was never declared (already reported)
 *
 * @typedef {{unit: Unit, syms: Map<string, Sym>, parent: Scope|null}} Scope
 *
 * @typedef {object} Model
 * @property {Program} ast
 * @property {Diag[]} diags                      syntax and semantic diagnostics, sorted
 * @property {Unit|null} program
 * @property {Map<Unit, Scope>} scopes
 * @property {Map<string, Sym & {resolved: Type}>} typeTable   declared type names (one table per file)
 * @property {Map<string, Sym & {params: {name: string, type: Type, mode: string}[], retType: Type}>} subs
 * @property {(Span & {target: Sym})[]} refs
 * @property {(expr: any, unit: Unit) => Type} typeOf   type of an expression in a unit's scope, reporting nothing
 */

/**
 * @param {string} text
 * @returns {Model}
 */
function analyzeProgram(text) {
  const ast = parse(text);
  const { units, rawLines, lines } = ast;
  /** @type {Diag[]} */
  const diags = [...ast.diags];
  const typeTable = new Map();
  const subs = new Map();
  const scopes = new Map();
  const refs = [];
  let quiet = false; // model.typeOf: answer without reporting or recording

  const error = (span, msg) => { if (!quiet) diags.push(err(span.line, span.col, span.endCol, msg)); };
  const warning = (span, msg) => { if (!quiet) diags.push(warn(span.line, span.col, span.endCol, msg)); };
  const note = (span, msg) => { if (!quiet) diags.push(info(span.line, span.col, span.endCol, msg)); };
  const ref = (span, target) => { if (!quiet) { target.refs.push(span); refs.push({ ...span, target }); } };
  const src = (span) => (rawLines[span.line] || '').slice(span.col, span.endCol);
  const lineSpan = (n) => { const raw = rawLines[n] || ''; const col = raw.length - raw.trimStart().length; return { line: n, col, endCol: Math.max(raw.trimEnd().length, col + 1) }; };
  const lookup = (scope, name) => scope.syms.get(name) || (scope.parent ? scope.parent.syms.get(name) : undefined);

  const program = units.find(u => u.kind === 'program') || null;
  for (const u of units) scopes.set(u, { unit: u, syms: new Map(), parent: null });
  for (const u of units) if (u !== program && program) scopes.get(u).parent = scopes.get(program);
  // the program's kamus is the global scope, wherever the program sits in the file
  const ordered = program ? [program, ...units.filter(u => u !== program)] : units;

  // ---------- pass 1: names ----------
  for (const u of units) {
    if (u.nameSpan) {
      if (u.kind === 'program') {
        if (u !== program) error(u.nameSpan, 'Only one program per file');
        ref(u.nameSpan, { kind: 'program', name: u.name, refs: [], unit: u });
      } else {
        const sub = { kind: 'sub', name: u.name, refs: [], unit: u, span: u.nameSpan, params: [], retType: UNKNOWN };
        if (subs.has(u.name)) error(u.nameSpan, `Duplicate subprogram '${u.name}'`);
        else subs.set(u.name, sub);
        u.sub = sub;
        ref(u.nameSpan, sub);
      }
    }
    const seen = new Set();
    for (const p of u.params) {
      if (seen.has(p.name)) { error(p.span, `Duplicate parameter '${p.name}'`); p.dup = true; }
      seen.add(p.name);
    }
    for (const d of u.decls) {
      if (seen.has(d.name) || (d.kind === 'type' && typeTable.has(d.name))) { error(d.span, `Duplicate declaration '${d.name}'`); d.dup = true; continue; }
      seen.add(d.name);
      if (d.kind !== 'type') continue;
      const entry = { kind: 'type', name: d.name, refs: [], unit: u, span: d.span, node: d.type, resolved: undefined, resolving: false };
      if (d.type.k === 'struct') entry.resolved = { k: 'struct', name: d.name, fields: new Map() };
      typeTable.set(d.name, entry);
      ref(d.span, entry);
    }
  }

  // ---------- types ----------
  const pointers = []; // pointer targets resolve late, so 'pointer to X' may come before X
  function resolveEntry(entry) {
    if (entry.resolved) return entry.resolved;
    if (entry.resolving) { error(entry.span, `Type '${entry.name}' is defined in terms of itself`); return (entry.resolved = UNKNOWN); }
    entry.resolving = true;
    const t = resolveType(entry.node, scopes.get(entry.unit));
    entry.resolving = false;
    return entry.resolved || (entry.resolved = t);
  }
  /** @returns {Type} */
  function resolveType(node, scope) {
    if (!node) return UNKNOWN;
    if (!node._ty) node._ty = resolveNode(node, scope);
    return node._ty;
  }
  function resolveNode(node, scope) {
    switch (node.k) {
      case 'name': {
        if (T.BASE[node.name]) return T.BASE[node.name];
        const entry = typeTable.get(node.name);
        if (!entry) { error(node.span, `Unknown type '${node.name}' — declare it with 'type ${node.name} : ...'`); return UNKNOWN; }
        ref(node.span, entry);
        return resolveEntry(entry);
      }
      case 'array': {
        const bound = (e) => {
          const v = constEval(e, scope);
          if (v && isInt(v.type)) return v.value;
          error(e.span, `Non-constant array bound '${src(e.span)}'`);
          return null;
        };
        const lo = bound(node.lo), hi = bound(node.hi);
        const t = { k: 'array', lo, hi, elem: resolveType(node.elem, scope) };
        if (lo === null || hi === null) {
          const bad = lo === null ? node.lo : node.hi;
          t.boundError = { line: bad.span.line, msg: `Non-constant array bound '${src(bad.span)}'` };
        } else if (lo > hi) error(node.span, `Array lower bound ${lo} exceeds upper bound ${hi}`);
        if (node.lo.k === 'num' && node.lo.value === 0 && node.hi.k === 'name' && !node.hi.paren)
          warning(node.span, `array[0..${node.hi.name}] holds ${node.hi.name}+1 elements — use [0..${node.hi.name}-1]`);
        return t;
      }
      case 'subrange': {
        const lo = constEval(node.lo, scope), hi = constEval(node.hi, scope);
        if (!lo || !hi || !isInt(lo.type) || !isInt(hi.type)) { error(node.span, 'Subrange bounds must be integer constants — use: integer[lo..hi]'); return INT; }
        if (lo.value > hi.value) error(node.span, `Subrange lower bound ${lo.value} exceeds upper bound ${hi.value}`);
        return { k: 'subrange', lo: lo.value, hi: hi.value };
      }
      case 'pointer': {
        const t = { k: 'pointer' };
        let target;
        Object.defineProperty(t, 'target', { get: () => target || (target = resolveType(node.target, scope)) });
        pointers.push(t);
        return t;
      }
      default: return UNKNOWN; // 'bad': the parser reported it. 'struct' only occurs as a type declaration.
    }
  }

  // value of a constant expression (literals, declared constants, arithmetic), or null
  function constEval(e, scope) {
    if (!e) return null;
    switch (e.k) {
      case 'num': return { type: e.real ? REAL : INT, value: e.value };
      case 'str': return { type: STRING, value: e.value };
      case 'char': return { type: CHAR, value: e.value };
      case 'bool': return { type: BOOL, value: e.value };
      case 'name': {
        const sym = lookup(scope, e.name);
        if (!sym) return null;
        ref(e.span, sym);
        sym.used = true;
        return sym.kind === 'const' ? sym.value || null : null;
      }
      case 'unary': {
        const v = constEval(e.operand, scope);
        return e.op === '-' && v && isNum(v.type) ? { type: v.type, value: -v.value } : null;
      }
      case 'binary': {
        const a = constEval(e.left, scope), b = constEval(e.right, scope);
        if (!a || !b || !isNum(a.type) || !isNum(b.type)) return null;
        const real = a.type.k === 'real' || b.type.k === 'real';
        const num = (value) => ({ type: real ? REAL : INT, value });
        switch (e.op) {
          case '+': return num(a.value + b.value);
          case '-': return num(a.value - b.value);
          case '*': return num(a.value * b.value);
          case 'div': return b.value === 0 ? null : num(real ? a.value / b.value : Math.trunc(a.value / b.value));
          case 'mod': return b.value === 0 ? null : num(a.value % b.value);
          case '/': return real && b.value !== 0 ? num(a.value / b.value) : null;
        }
        return null;
      }
      default: return null;
    }
  }

  // ---------- pass 2: declarations ----------
  for (const u of ordered) { // constants first: array bounds anywhere in the file may use them
    const scope = scopes.get(u);
    for (const d of u.decls) {
      if (d.kind !== 'const' || d.dup) continue;
      const type = resolveType(d.type, scope);
      const sym = { kind: 'const', name: d.name, refs: [], unit: u, span: d.span, type, value: undefined, assigned: true, used: false };
      scope.syms.set(d.name, sym);
      ref(d.span, sym);
      if (!d.init) continue;
      const v = constEval(d.init, scope);
      if (!v) { error(d.init.span, `Non-constant initializer '${src(d.init.span)}'`); continue; }
      if (!T.assignable(type, v.type)) { error(d.init.span, `Type mismatch in constant '${d.name}' (expected ${describe(type)}, got ${describe(v.type)})`); continue; }
      sym.value = { type: isUnknown(type) ? v.type : type, value: v.value };
    }
  }
  for (const entry of typeTable.values()) {
    if (entry.node.k !== 'struct') { resolveEntry(entry); continue; }
    const scope = scopes.get(entry.unit);
    for (const f of entry.node.fields) {
      if (entry.resolved.fields.has(f.name)) { error(f.span, `Duplicate field '${f.name}'`); continue; }
      entry.resolved.fields.set(f.name, resolveType(f.type, scope));
    }
  }
  for (const u of ordered) {
    const scope = scopes.get(u);
    for (const p of u.params) {
      const type = resolveType(p.type, scope);
      if (p.dup) continue;
      const mode = u.kind === 'function' ? 'in' : p.mode || 'in'; // functions take every parameter by value
      if (u.kind === 'procedure' && !p.mode) warning(p.span, `Parameter '${p.name}' needs a mode: in, out or in/out`);
      const sym = { kind: 'param', name: p.name, refs: [], unit: u, span: p.span, type, mode, assigned: mode !== 'out', used: false };
      scope.syms.set(p.name, sym);
      ref(p.span, sym);
      if (u.sub) u.sub.params.push({ name: p.name, type, mode });
    }
    if (u.sub && u.retType) u.sub.retType = resolveType(u.retType, scope);
    for (const d of u.decls) {
      if (d.kind !== 'var' || d.dup) continue;
      const sym = { kind: 'var', name: d.name, refs: [], unit: u, span: d.span, type: resolveType(d.type, scope), assigned: false, used: false };
      scope.syms.set(d.name, sym);
      ref(d.span, sym);
    }
  }
  for (let i = 0; i < pointers.length; i++) void pointers[i].target; // report unknown targets
  for (const entry of typeTable.values()) { // a struct holding itself by value has no size
    if (entry.node.k !== 'struct') continue;
    const inside = (t, depth) => depth < 20 && (t === entry.resolved
      || (t.k === 'array' && inside(t.elem, depth + 1))
      || (t.k === 'struct' && [...t.fields.values()].some(f => inside(f, depth + 1))));
    for (const [name, ft] of entry.resolved.fields) {
      if (!inside(ft, 0)) continue;
      error(entry.span, `Struct '${entry.name}' contains itself in field '${name}' — use 'pointer to ${entry.name}' for the link`);
      entry.resolved.fields.set(name, UNKNOWN);
    }
  }

  // ---------- expressions ----------
  /** @returns {Type} */
  function typeOf(e, cx) {
    if (!e) return UNKNOWN;
    const t = infer(e, cx);
    if (!quiet) e.ty = t;
    return t;
  }
  // how: 'read' | 'write' (assigned to, in whole or in part) | 'addr'
  function useName(e, cx, how) {
    const sym = lookup(cx.scope, e.name);
    if (!sym) {
      const sub = subs.get(e.name);
      error(e.span, sub ? `'${e.name}' is a ${sub.unit.kind} — call it with ( )` : `Undeclared identifier '${e.name}'`);
      return null;
    }
    ref(e.span, sym);
    if (quiet) return sym;
    sym.used = true;
    // a subprogram cannot know in which order the program assigns its own variables
    if (how === 'read') { if (!sym.assigned && sym.unit === cx.unit) warning(e.span, `'${e.name}' may be used before assignment`); }
    else sym.assigned = true;
    return sym;
  }
  function fieldType(e, bt) {
    if (isUnknown(bt)) return UNKNOWN;
    let st = bt;
    if (e.arrow) {
      if (bt.k !== 'pointer') { error(e.span, bt.k === 'struct' ? `'->' needs a pointer, but this is a ${bt.name} — use '.${e.name}'` : `'->' needs a pointer, but this is ${describe(bt)}`); return UNKNOWN; }
      st = bt.target;
      if (isUnknown(st)) return UNKNOWN;
    } else if (bt.k === 'pointer') { error(e.span, `'.' does not work on a pointer — use '->${e.name}'`); return UNKNOWN; }
    if (st.k !== 'struct') { error(e.span, `Cannot access field '${e.name}' of non-struct (${describe(st)})`); return UNKNOWN; }
    const ft = st.fields.get(e.name);
    if (!ft) { error(e.nameSpan, `Unknown field '${e.name}' in ${st.name}`); return UNKNOWN; }
    return ft;
  }
  function indexType(e, bt, cx) {
    const it = typeOf(e.index, cx);
    if (!isUnknown(it) && !isInt(it)) error(e.index.span, `${bt.k === 'string' ? 'String' : 'Array'} index must be integer`);
    if (bt.k === 'string') return CHAR;
    if (bt.k === 'array') return bt.elem;
    if (!isUnknown(bt)) error(e.base.span, `Cannot index non-array (${describe(bt)})`);
    return UNKNOWN;
  }
  function infer(e, cx) {
    switch (e.k) {
      case 'num': return e.real ? REAL : INT;
      case 'str': return STRING;
      case 'char': return CHAR;
      case 'bool': return BOOL;
      case 'nil': return NIL;
      case 'name': { const s = useName(e, cx, 'read'); return s ? s.type : UNKNOWN; }
      case 'call': return checkCall(e, cx, false);
      case 'index': return indexType(e, typeOf(e.base, cx), cx);
      case 'field': return fieldType(e, typeOf(e.base, cx));
      case 'addr': {
        const s = useName(e.operand, cx, 'addr');
        if (!s) return UNKNOWN;
        if (s.kind === 'const') { error(e.span, `Cannot take address of constant '${s.name}'`); return UNKNOWN; }
        return { k: 'pointer', target: s.type };
      }
      case 'deref': {
        const t = typeOf(e.operand, cx);
        if (t.k === 'pointer') return t.target;
        if (!isUnknown(t)) error(e.span, `'*' needs a pointer, but this is ${describe(t)}`);
        return UNKNOWN;
      }
      case 'unary': {
        const t = typeOf(e.operand, cx);
        if (e.op === 'not') { if (!isUnknown(t) && t.k !== 'bool') error(e.span, `Type mismatch: 'not' needs a boolean (got ${describe(t)})`); return BOOL; }
        if (isNum(t)) return t.k === 'real' ? REAL : INT;
        if (!isUnknown(t)) error(e.span, `Type mismatch: cannot negate ${describe(t)}`);
        return UNKNOWN;
      }
      case 'binary': return binaryType(e, typeOf(e.left, cx), typeOf(e.right, cx), cx);
    }
    return UNKNOWN;
  }
  function binaryType(e, lt, rt, cx) {
    const op = e.op;
    const unk = isUnknown(lt) || isUnknown(rt);
    const mismatch = (result) => { if (!unk) error(e.span, `Type mismatch: cannot '${op}' ${describe(lt)} and ${describe(rt)}`); return result; };
    const numeric = isNum(lt) && isNum(rt);
    const real = lt.k === 'real' || rt.k === 'real';
    switch (op) {
      case 'and': case 'or':
        for (const [t, side] of [[lt, e.left], [rt, e.right]])
          if (!isUnknown(t) && t.k !== 'bool') error(side.span, `Non-boolean operand for '${op}' (got ${describe(t)})`);
        return BOOL;
      case '+':
        if (lt.k === 'string' && rt.k === 'string') return STRING;
        if (numeric) return real ? REAL : INT;
        if (!unk && cx.inOutput && (lt.k === 'string' || rt.k === 'string')) { error(e.opSpan, 'Mixed-type output with \'+\' — use comma: output("label:", x)'); return UNKNOWN; }
        return mismatch(UNKNOWN);
      case '-': case '*':
        return numeric ? (real ? REAL : INT) : mismatch(UNKNOWN);
      case '/':
        if (isInt(lt) && isInt(rt)) { error(e.opSpan, "Type mismatch: 'integer / integer' not allowed — use div"); return INT; }
        return numeric ? REAL : mismatch(UNKNOWN);
      case 'div': case 'mod':
        return numeric ? (real ? REAL : INT) : mismatch(UNKNOWN);
      case '==': case '!=': case '<': case '>': case '<=': case '>=': {
        if (lt.k === 'struct' || rt.k === 'struct') error(e.span, `Type mismatch: cannot '${op}' struct values — compare field by field`);
        else if (lt.k === 'array' || rt.k === 'array') error(e.span, `Type mismatch: cannot '${op}' arrays — compare element by element`);
        else if (op === '==' || op === '!=') { if (!T.comparable(lt, rt)) mismatch(BOOL); }
        else if (!unk && !numeric && !(lt.k === 'char' && rt.k === 'char')) mismatch(BOOL);
        return BOOL;
      }
    }
    return UNKNOWN;
  }
  function checkCall(e, cx, asStatement) {
    const inOutput = cx.inOutput;
    cx.inOutput = false;
    try {
      const sub = subs.get(e.name);
      if (!sub && e.name === 'len') {
        const ts = e.args.map(a => typeOf(a, cx));
        if (ts.length !== 1) error(e.span, 'len expects 1 argument');
        else if (!isUnknown(ts[0]) && ts[0].k !== 'string') error(e.args[0].span, `len expects string, got ${describe(ts[0])}`);
        return INT;
      }
      if (!sub) {
        for (const a of e.args) typeOf(a, cx);
        error(e.nameSpan, lookup(cx.scope, e.name) ? `'${e.name}' is a variable, not a function or procedure` : `Undeclared identifier '${e.name}'`);
        return UNKNOWN;
      }
      ref(e.nameSpan, sub);
      if (!asStatement && sub.unit.kind === 'procedure') error(e.nameSpan, `'${e.name}' is a procedure, cannot use in expression`);
      if (sub.unit.badParams || e.args.length !== sub.params.length) {
        if (!sub.unit.badParams) error(e.span, `Wrong argument count for '${e.name}' (expected ${sub.params.length}, got ${e.args.length})`);
        for (const a of e.args) typeOf(a, cx);
        return sub.retType;
      }
      sub.params.forEach((p, i) => {
        const a = e.args[i];
        const wrong = (got) => error(a.span, `Type mismatch in argument '${e.name}.${p.name}' (expected ${describe(p.type)}, got ${describe(got)})`);
        if (p.mode === 'in') {
          const t = typeOf(a, cx);
          if (!T.assignable(p.type, t)) wrong(t);
          return;
        }
        const tg = target(a, cx, `${p.mode} argument`);
        if (tg.bad) return;
        if (tg.constant) error(a.span, `Cannot pass constant '${tg.constant.name}' as ${p.mode} argument`);
        else if (tg.strElem) error(a.span, `Cannot pass a string element as ${p.mode} argument`);
        else if (!T.sameType(p.type, tg.type)) wrong(tg.type);
      });
      return sub.retType;
    } finally {
      cx.inOutput = inOutput;
    }
  }
  // An expression that is stored into: a name, an array element, a field, *p.
  // Returns its type; `constant` when the storage belongs to a constant.
  function target(e, cx, what) {
    const done = (r) => { if (!quiet) e.ty = r.type; return r; };
    switch (e.k) {
      case 'name': {
        const s = useName(e, cx, 'write');
        return done({ type: s ? s.type : UNKNOWN, constant: s && s.kind === 'const' ? s : null });
      }
      case 'index': {
        const b = target(e.base, cx, what); // writing an element counts as assigning the array
        const type = indexType(e, b.type, cx);
        return done({ type, constant: b.constant, strElem: b.type.k === 'string' });
      }
      case 'field': {
        if (e.arrow) return done({ type: fieldType(e, typeOf(e.base, cx)), constant: null }); // the pointer itself is only read
        const b = target(e.base, cx, what);
        return done({ type: fieldType(e, b.type), constant: b.constant });
      }
      case 'deref': return done({ type: typeOf(e, cx), constant: null });
    }
    typeOf(e, cx);
    error(e.span, `Not a variable — ${what} needs a name, an array element or a field`);
    return { type: UNKNOWN, constant: null, bad: true };
  }

  // ---------- statements ----------
  function condition(e, cx) {
    const t = typeOf(e, cx);
    if (e && !isUnknown(t) && t.k !== 'bool') error(e.span, `Non-boolean condition (got ${describe(t)})`);
  }
  function block(stmts, cx) { for (const s of stmts) statement(s, cx); }
  function statement(s, cx) {
    switch (s.k) {
      case 'assign': {
        const vt = typeOf(s.value, cx); // the value first: 'x = x + 1' reads x before it writes it
        const tg = target(s.target, cx, 'an assignment');
        const tt = tg.type, name = src(s.target.span);
        if (tg.constant) { error(s.target.span, `Cannot assign to constant '${tg.constant.name}'`); break; }
        if (tg.bad || isUnknown(tt) || isUnknown(vt)) break;
        if (tg.strElem) { if (vt.k !== 'string') error(s.value.span, 'Type mismatch in string element assignment (expected single character string)'); break; }
        if (tt.k === 'array' || vt.k === 'array') { error({ ...s.target.span, endCol: s.value.span.endCol }, 'Cannot assign array — copy element by element'); break; }
        if (T.assignable(tt, vt) || (tt.k === 'string' && vt.k === 'char')) break; // char -> string: unconfirmed with lecturer
        let hint = '';
        if (tt.k === 'pointer' && T.sameType(tt.target, vt)) hint = ` — use '&' for an address, or '*${name} = ...' to store through the pointer`;
        else if (vt.k === 'pointer' && T.sameType(vt.target, tt)) hint = " — use '*' to read the value a pointer points to";
        error(s.value.span, `Type mismatch in assignment to '${name}' (expected ${describe(tt)}, got ${describe(vt)})${hint}`);
        break;
      }
      case 'call': checkCall(s.call, cx, true); break;
      case 'input':
        for (const a of s.args) {
          const tg = target(a, cx, 'input');
          if (tg.constant) error(a.span, `Cannot assign to constant '${tg.constant.name}'`);
          else if (!tg.bad && !tg.strElem && !isUnknown(tg.type) && !T.isSimple(tg.type))
            error(a.span, `Cannot input into '${src(a.span)}' (${describe(tg.type)}) — read it one field or element at a time`);
        }
        break;
      case 'output':
        for (const a of s.args) {
          cx.inOutput = true;
          const t = typeOf(a, cx);
          cx.inOutput = false;
          if (T.isCompound(t)) error(a.span, 'Cannot output compound value (print elements)');
        }
        break;
      case 'allocate': case 'deallocate': {
        const a = s.args[0];
        if (!a) break;
        const t = s.k === 'allocate' ? target(a, cx, 'allocate').type : typeOf(a, cx);
        if (!isUnknown(t) && t.k !== 'pointer') error(a.span, `${s.k} expects a pointer variable '${src(a.span)}'`);
        break;
      }
      case 'return': {
        const kind = cx.unit.kind;
        const vt = s.value ? typeOf(s.value, cx) : null;
        if (kind === 'program') error(s.span, "'return' is only allowed inside a function or procedure");
        else if (kind === 'procedure') { if (s.value) error(s.span, 'Procedures do not return values — use a bare return'); }
        else if (!s.value) { if (!s.error) error(s.span, 'return needs a value in a function'); }
        else if (cx.unit.sub && !T.assignable(cx.unit.sub.retType, vt))
          error(s.value.span, `Type mismatch in return of '${cx.unit.name}' (expected ${describe(cx.unit.sub.retType)}, got ${describe(vt)})`);
        break;
      }
      case 'if':
        for (const br of s.branches) { condition(br.cond, cx); block(br.body, cx); }
        if (s.else) block(s.else, cx);
        break;
      case 'while': condition(s.cond, cx); block(s.body, cx); break;
      case 'repeat': block(s.body, cx); condition(s.cond, cx); break;
      case 'for': {
        for (const e of [s.from, s.to]) { const t = typeOf(e, cx); if (e && !isUnknown(t) && !isInt(t)) error(e.span, 'for bounds must be integers'); }
        if (s.name) {
          let sym = lookup(cx.scope, s.name);
          if (!sym) {
            error(s.nameSpan, `Undeclared loop variable '${s.name}' — declare it in kamus`);
            sym = { kind: 'loopvar', name: s.name, refs: [], unit: cx.unit, span: s.nameSpan, type: INT, implicit: true, assigned: true, used: true };
            cx.scope.syms.set(s.name, sym); // so its uses in the body are not reported again
          }
          ref(s.nameSpan, sym);
          sym.assigned = true; sym.used = true;
          if (sym.kind === 'const') error(s.nameSpan, `Cannot assign to constant '${s.name}'`);
          else if (!isUnknown(sym.type) && !isInt(sym.type)) error(s.nameSpan, `Loop variable '${s.name}' must be an integer`);
          if (s.from && s.from.k === 'num' && s.from.value === 0 && s.to && s.to.k === 'name' && !s.to.paren && indexesWith(s.body, s.name))
            warning(s.to.span, `'for ... to ${s.to.name}' risks out-of-bounds on arr[${s.name}] — prefer 'to ${s.to.name}-1'`);
        }
        block(s.body, cx);
        break;
      }
      case 'case': {
        const t = typeOf(s.expr, cx);
        if (s.expr && T.isCompound(t)) error(s.expr.span, 'case needs a simple value, not a struct or array');
        for (const br of s.branches) {
          for (const lab of br.labels) { const lt = typeOf(lab, cx); if (!T.isCompound(t) && !T.comparable(t, lt)) error(lab.span, `Case label is ${describe(lt)}, but the case value is ${describe(t)}`); }
          block(br.body, cx);
        }
        if (s.else) block(s.else, cx);
        break;
      }
    }
  }

  // ---------- pass 3: bodies ----------
  // subprograms first, so the program knows which of its variables they assign
  for (const u of [...units.filter(x => x !== program), ...(program ? [program] : [])]) {
    block(u.body, { unit: u, scope: scopes.get(u), inOutput: false });
    if (u.kind === 'function' && u.nameSpan && u.closed && !someStmt(u.body, s => s.k === 'return'))
      warning(u.nameSpan, `Function '${u.name}' never returns — add 'return <value>'`);
    if (u.kind === 'procedure') { // the spec comment between the header and kamus/algoritma
      const until = u.kamusLine ?? u.algoLine ?? u.startLine + 3;
      let spec = '';
      for (let n = u.startLine; n <= Math.min(until, lines.length - 1); n++) for (const t of lines[n]) if (t.kind === 'comment') spec += t.text + '\n';
      if (!/I\.S\./.test(spec) || !/F\.S\./.test(spec)) warning(lineSpan(u.startLine), 'Procedure spec should include I.S. / F.S.');
    }
    const prev = u.startLine > 0 ? (rawLines[u.startLine - 1] || '').trim().split(/\s/)[0] : '';
    if (/^(endprogram|endfunction|endprocedure)$/.test(prev)) error(lineSpan(u.startLine), `Missing blank line between '${prev}' and this ${u.kind}`);
  }
  for (const scope of scopes.values()) for (const sym of scope.syms.values()) {
    if ((sym.kind === 'var' || sym.kind === 'param') && !sym.used) note(sym.span, `'${sym.name}' declared but never used`);
  }

  const model = {
    ast, program, scopes, typeTable, subs, refs,
    diags: dedupe(diags),
    typeOf(e, unit) {
      quiet = true;
      try { return typeOf(e, { unit, scope: scopes.get(unit), inOutput: false }); }
      finally { quiet = false; }
    },
  };
  return model;
}

// ---------- tree walking helpers ----------
function someStmt(stmts, pred) {
  for (const s of stmts) {
    if (pred(s)) return true;
    if (s.body && someStmt(s.body, pred)) return true;
    if (s.branches && s.branches.some(b => someStmt(b.body, pred))) return true;
    if (s.else && someStmt(s.else, pred)) return true;
  }
  return false;
}
function someExpr(e, pred) {
  if (!e) return false;
  if (pred(e)) return true;
  return someExpr(e.base, pred) || someExpr(e.index, pred) || someExpr(e.operand, pred) || someExpr(e.left, pred) || someExpr(e.right, pred)
    || (e.args || []).some(a => someExpr(a, pred));
}
const stmtExprs = (s) => [s.target, s.value, s.call, s.cond, s.from, s.to, s.expr, ...(s.args || []), ...(s.branches || []).flatMap(b => [b.cond, ...(b.labels || [])])];
// is `name` used as an array index somewhere in these statements?
function indexesWith(stmts, name) {
  const isIdx = (e) => e.k === 'index' && e.index.k === 'name' && e.index.name === name;
  return someStmt(stmts, s => stmtExprs(s).some(e => someExpr(e, isIdx)));
}

function dedupe(diags) {
  const seen = new Set();
  return diags.filter(d => {
    const k = `${d.line}:${d.col}:${d.msg}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.line - b.line || a.col - b.col);
}

/**
 * Every diagnostic for a source text. Never throws.
 * @param {string} text
 * @returns {Diag[]}
 */
function analyze(text) {
  try {
    return analyzeProgram(text).diags;
  } catch (e) {
    return [warn(0, 0, 1, `Checker stopped unexpectedly (${e && e.message}) — please report this file`)];
  }
}

module.exports = { analyze, analyzeProgram };
