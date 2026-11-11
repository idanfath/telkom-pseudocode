// Runner: walks the analyzed syntax tree. No dependencies.
// runProgram(text, inputText = '', opts = {}) -> {output, error, staticErrors, leaks}
//   opts.maxSteps      step limit (default 500000)
//   opts.ignoreStatic  run even when the checker found errors (tests)
//   opts.onOutput      called with each output line as it is printed
//   opts.readLine      called when input() needs another line; returns a string, or null at end of input
// Never throws: a runtime error comes back as {line, msg} with the output printed so far.
'use strict';
const { analyzeProgram } = require('./analyzer');
const T = require('./types');

const RECURSION_CAP = 1000;
const DEFAULT_STEP_CAP = 500000;
const MAX_ARRAY = 1000000;

class RTError extends Error {
  constructor(line, msg) { super(msg); this.line = line; }
}

/**
 * Values. Scalars are immutable; arrays and structs own their cells and are copied on
 * assignment and when passed by value.
 * @typedef {{tag: 'int'|'real', v: number} | {tag: 'char'|'str', v: string} | {tag: 'bool', v: boolean}
 *   | {tag: 'nil'} | {tag: 'ptr', cell: Cell|null}
 *   | {tag: 'arr', type: any, cells: Cell[]} | {tag: 'struct', type: any, fields: Map<string, Cell>}} Value
 *
 * A cell is one piece of storage: a variable, an array element, a struct field or an
 * allocated block. Pointers point at cells, so &x and allocate(p) work the same way.
 * @typedef {{type: import('./types').Type, val: Value|null, assigned: boolean, isConst?: boolean, temp?: boolean,
 *   addr?: number, heap?: {id: number, freed: boolean}}} Cell
 *
 * Where a name or target expression leads: the cell, the cells it sits inside (a write
 * marks those assigned too), and the character position for s[i].
 * @typedef {{cell: Cell, parents: Cell[], strIndex?: number, index?: number}} Ref
 */
const V = {
  int: (v) => ({ tag: 'int', v }),
  real: (v) => ({ tag: 'real', v: v === 0 ? 0 : v }),
  char: (v) => ({ tag: 'char', v }),
  bool: (v) => ({ tag: 'bool', v }),
  str: (v) => ({ tag: 'str', v }),
};
const NILV = { tag: 'nil' };
const TRUE = V.bool(true), FALSE = V.bool(false);
const EMPTY = [];
const RET_VOID = { value: null };
const isNum = (v) => v.tag === 'int' || v.tag === 'real';
const TAG_NAME = { int: 'integer', real: 'real', char: 'char', bool: 'boolean', str: 'string', nil: 'NIL', ptr: 'pointer', arr: 'array' };
const typeName = (v) => (v.tag === 'struct' ? v.type.name : TAG_NAME[v.tag]);
function describeVal(v) {
  if (v.tag === 'ptr') return v.cell ? `pointer to ${T.describe(v.cell.type)}` : 'pointer';
  if (v.tag === 'arr') return T.describe(v.type);
  return typeName(v);
}
function clone(v) {
  const copy = (c) => ({ type: c.type, val: c.val && clone(c.val), assigned: c.assigned });
  if (v.tag === 'arr') return { tag: 'arr', type: v.type, cells: v.cells.map(copy) };
  if (v.tag === 'struct') { const fields = new Map(); for (const [k, c] of v.fields) fields.set(k, copy(c)); return { tag: 'struct', type: v.type, fields }; }
  return v;
}

function runProgram(text, inputText = '', opts = {}) {
  const output = [];
  try {
    const model = analyzeProgram(text);
    const statics = model.diags.filter(d => d.sev === 0);
    if (statics.length && !opts.ignoreStatic) return { output: [], error: null, staticErrors: statics, leaks: 0 };
    return execute(model, inputText, opts, output);
  } catch (e) {
    if (e instanceof RTError) return { output, error: { line: e.line, msg: e.message }, staticErrors: null, leaks: 0 };
    return { output, error: { line: 0, msg: 'Interpreter crash: ' + (e && e.message) }, staticErrors: null, leaks: 0 };
  }
}

function execute(model, inputText, opts, output) {
  const { subs, scopes, program } = model;
  const rawLines = model.ast.rawLines;
  const stepCap = opts.maxSteps || DEFAULT_STEP_CAP;
  const src = (span) => (rawLines[span.line] || '').slice(span.col, span.endCol);
  let steps = 0, depth = 0, maxDepth = 0, callLine = 0;
  let heapSeq = 0, addrSeq = 0;
  const heap = [];
  /** @type {Map<string, Ref>} */
  let globals = new Map();

  const tick = (line) => { if (++steps > stepCap) throw new RTError(line, 'Execution limit exceeded (possible infinite loop)'); };
  const emit = (line) => { output.push(line); if (opts.onOutput) opts.onOutput(line); };

  // ---------- storage ----------
  /** @returns {Cell} */
  function newCell(type, line) {
    return { type, val: defaultVal(type, line), assigned: false };
  }
  function defaultVal(type, line) {
    if (type.k === 'array') {
      if (type.boundError) throw new RTError(type.boundError.line, type.boundError.msg);
      if (type.hi - type.lo + 1 > MAX_ARRAY) throw new RTError(line, `Array too large (${type.hi - type.lo + 1} elements)`);
      const cells = [];
      for (let i = type.lo; i <= type.hi; i++) cells.push(newCell(type.elem, line));
      return { tag: 'arr', type, cells };
    }
    if (type.k === 'struct') {
      const fields = new Map();
      for (const [name, ft] of type.fields) fields.set(name, newCell(ft, line));
      return { tag: 'struct', type, fields };
    }
    return null;
  }
  function constVal({ type, value }) {
    if (T.isInt(type)) return V.int(value);
    if (type.k === 'real') return V.real(value);
    if (type.k === 'bool') return value ? TRUE : FALSE;
    return type.k === 'char' ? V.char(value) : V.str(String(value));
  }
  // the variables and constants a unit declares in its kamus
  function makeFrame(u) {
    /** @type {Map<string, Ref>} */
    const frame = new Map();
    const syms = scopes.get(u).syms;
    for (const d of u.decls) {
      const sym = syms.get(d.name);
      if (d.dup || d.kind === 'type' || !sym) continue;
      if (d.kind === 'var') frame.set(d.name, { cell: newCell(sym.type, d.line), parents: EMPTY });
      else if (!sym.value) throw new RTError(d.line, `Non-constant initializer for '${d.name}'`);
      else frame.set(d.name, { cell: { type: sym.type, val: constVal(sym.value), assigned: true, isConst: true }, parents: EMPTY });
    }
    return frame;
  }
  const write = (r, v) => {
    r.cell.val = v;
    r.cell.assigned = true;
    for (const p of r.parents) p.assigned = true;
  };
  // The value must fit the declared type. Returns it, converted where the language allows (integer -> real).
  function checkFits(type, v, what, name, line) {
    const bad = () => new RTError(line, `Type mismatch in ${what} '${name}' (expected ${T.describe(type)}, got ${describeVal(v)})`);
    switch (type.k) {
      case 'int': if (v.tag !== 'int') throw bad(); return v;
      case 'subrange':
        if (v.tag !== 'int') throw bad();
        if (v.v < type.lo || v.v > type.hi) throw new RTError(line, `Value ${v.v} out of subrange [${type.lo}..${type.hi}] for '${name}'`);
        return v;
      case 'real': if (v.tag === 'int') return V.real(v.v); if (v.tag !== 'real') throw bad(); return v;
      case 'char': if (v.tag !== 'char') throw bad(); return v;
      case 'bool': if (v.tag !== 'bool') throw bad(); return v;
      case 'string': if (v.tag !== 'str') throw bad(); return v;
      case 'pointer':
        if (v.tag === 'nil') return v;
        if (v.tag !== 'ptr' || (v.cell && !T.sameType(type.target, v.cell.type))) throw bad();
        return v;
      case 'array': if (v.tag !== 'arr' || !T.sameType(type, v.type)) throw bad(); return v;
      case 'struct': if (v.tag !== 'struct' || v.type !== type) throw bad(); return v;
    }
    return v; // unknown type (only reachable with ignoreStatic)
  }

  // ---------- names, targets ----------
  /** @returns {Ref} */
  function binding(e, env) {
    const b = env.get(e.name) || globals.get(e.name);
    if (!b) throw new RTError(e.span.line, `Undeclared identifier '${e.name}'`);
    return b;
  }
  const refable = (e) => e.k === 'name' || e.k === 'index' || e.k === 'field' || e.k === 'deref';
  // the cell a pointer expression points at
  function pointee(e, env) {
    const line = e.span.line;
    let v, never = false;
    if (refable(e)) {
      const r = refOf(e, env);
      if (r.strIndex !== undefined) throw new RTError(line, 'A character is not a pointer');
      v = r.cell.val;
      never = !r.cell.assigned;
    } else v = evalExpr(e, env);
    if (!v || v.tag === 'nil' || (v.tag === 'ptr' && !v.cell))
      throw new RTError(line, never ? `NIL pointer dereference ('${src(e.span)}' was never assigned)` : 'NIL pointer dereference');
    if (v.tag !== 'ptr') throw new RTError(line, `Cannot dereference ${typeName(v)}`);
    if (v.cell.heap && v.cell.heap.freed) throw new RTError(line, 'Use after free');
    return v.cell;
  }
  /** @returns {Ref} */
  function refOf(e, env) {
    const line = e.span.line;
    switch (e.k) {
      case 'name': return binding(e, env);
      case 'index': {
        const b = refOf(e.base, env);
        const idx = evalExpr(e.index, env);
        const bv = b.cell.val;
        if (b.strIndex !== undefined) throw new RTError(line, 'Cannot index a character');
        if (!bv) throw new RTError(line, `Uninitialized variable '${src(e.base.span)}'`);
        if (bv.tag === 'str') {
          if (idx.tag !== 'int') throw new RTError(line, 'String index must be integer');
          const len = [...bv.v].length;
          if (idx.v < 0 || idx.v >= len) throw new RTError(line, `String index ${idx.v} out of bounds (len ${len})`);
          return { cell: b.cell, parents: b.parents, strIndex: idx.v };
        }
        if (bv.tag !== 'arr') throw new RTError(line, 'Cannot index non-array');
        if (idx.tag !== 'int') throw new RTError(line, 'Array index must be integer');
        const { lo, hi } = bv.type;
        if (idx.v < lo || idx.v > hi) throw new RTError(line, `Array index ${idx.v} out of bounds [${lo}..${hi}]`);
        return { cell: bv.cells[idx.v - lo], parents: [...b.parents, b.cell], index: idx.v };
      }
      case 'field': {
        let owner, parents;
        if (e.arrow) { owner = pointee(e.base, env); parents = [owner]; }
        else {
          const b = refOf(e.base, env);
          if (b.strIndex !== undefined) throw new RTError(line, `Cannot access field '${e.name}' of non-struct`);
          owner = b.cell;
          parents = [...b.parents, b.cell];
        }
        const sv = owner.val;
        if (!sv || sv.tag !== 'struct') throw new RTError(line, `Cannot access field '${e.name}' of non-struct`);
        const cell = sv.fields.get(e.name);
        if (!cell) throw new RTError(line, `Unknown field '${e.name}'`);
        return { cell, parents };
      }
      case 'deref': return { cell: pointee(e.operand, env), parents: EMPTY };
    }
    // any other expression: a temporary holding its value, e.g. f(x).field
    return { cell: { type: T.UNKNOWN, val: evalExpr(e, env), assigned: true, temp: true }, parents: EMPTY };
  }

  // ---------- expressions ----------
  /** @returns {Value} */
  function evalExpr(e, env) {
    const line = e.span.line;
    switch (e.k) {
      case 'num': return e.val || (e.val = e.real ? V.real(e.value) : V.int(e.value));
      case 'str': return e.val || (e.val = V.str(e.value));
      case 'char': return e.val || (e.val = V.char(e.value));
      case 'bool': return e.value ? TRUE : FALSE;
      case 'nil': return NILV;
      case 'name': {
        const b = binding(e, env);
        if (!b.cell.assigned) throw new RTError(line, `Uninitialized variable '${e.name}'`);
        return b.cell.val;
      }
      case 'index': case 'field': case 'deref': {
        const r = refOf(e, env);
        if (r.strIndex !== undefined) return V.char([...r.cell.val.v][r.strIndex]);
        if (!r.cell.assigned) {
          throw new RTError(line, e.k === 'index' ? `Uninitialized array element [${r.index}]`
            : e.k === 'field' ? `Uninitialized variable '${e.name}'` : `Uninitialized value at '${src(e.span)}'`);
        }
        return r.cell.val;
      }
      case 'addr': {
        const b = binding(e.operand, env);
        if (b.cell.isConst) throw new RTError(line, `Cannot take address of constant '${e.operand.name}'`);
        return { tag: 'ptr', cell: b.cell };
      }
      case 'unary': {
        const v = evalExpr(e.operand, env);
        if (e.op === 'not') { if (v.tag !== 'bool') throw new RTError(line, 'Non-boolean condition'); return v.v ? FALSE : TRUE; }
        if (!isNum(v)) throw new RTError(line, `Type mismatch: cannot negate ${typeName(v)}`);
        return v.tag === 'int' ? V.int(-v.v) : V.real(-v.v);
      }
      case 'binary': return evalBinary(e, env);
      case 'call': {
        const sub = subs.get(e.name);
        if (!sub) return builtin(e, env);
        if (sub.unit.kind !== 'function') throw new RTError(line, `'${e.name}' is a procedure, cannot use in expression`);
        return invoke(sub, e, env);
      }
    }
    throw new RTError(line, 'Cannot evaluate this expression');
  }
  function evalBinary(e, env) {
    const line = e.span.line, op = e.op;
    const a = evalExpr(e.left, env);
    if (op === 'and' || op === 'or') { // short-circuit: the right side runs only when it can change the answer
      if (a.tag !== 'bool') throw new RTError(line, `Non-boolean operand for '${op}'`);
      if (a.v === (op === 'or')) return a;
      const b = evalExpr(e.right, env);
      if (b.tag !== 'bool') throw new RTError(line, `Non-boolean operand for '${op}'`);
      return b;
    }
    const b = evalExpr(e.right, env);
    const mismatch = () => new RTError(line, `Type mismatch: cannot '${op}' ${typeName(a)} and ${typeName(b)}`);
    const numeric = isNum(a) && isNum(b);
    const real = a.tag === 'real' || b.tag === 'real';
    switch (op) {
      case '+':
        if (a.tag === 'str' && b.tag === 'str') return V.str(a.v + b.v);
        if (!numeric) throw mismatch();
        return real ? V.real(a.v + b.v) : V.int(a.v + b.v);
      case '-': if (!numeric) throw mismatch(); return real ? V.real(a.v - b.v) : V.int(a.v - b.v);
      case '*': if (!numeric) throw mismatch(); return real ? V.real(a.v * b.v) : V.int(a.v * b.v);
      case '/':
        if (a.tag === 'int' && b.tag === 'int') throw new RTError(line, "Type mismatch: 'integer / integer' not allowed — use div");
        if (!numeric) throw mismatch();
        if (b.v === 0) throw new RTError(line, 'Division by zero');
        return V.real(a.v / b.v);
      case 'div':
        if (!numeric) throw mismatch();
        if (b.v === 0) throw new RTError(line, 'Division by zero');
        return real ? V.real(a.v / b.v) : V.int(Math.trunc(a.v / b.v)); // real div real: unconfirmed with lecturer
      case 'mod':
        if (!numeric) throw mismatch();
        if (b.v === 0) throw new RTError(line, 'Modulo by zero');
        return real ? V.real(a.v % b.v) : V.int(a.v % b.v); // truncates like div, so q * d + r = n
    }
    // comparisons
    if (a.tag === 'struct' || b.tag === 'struct') throw new RTError(line, `Type mismatch: cannot '${op}' struct values — compare field by field`);
    if (a.tag === 'arr' || b.tag === 'arr') throw new RTError(line, `Type mismatch: cannot '${op}' arrays — compare element by element`);
    if (op === '==' || op === '!=') {
      const ptr = (v) => v.tag === 'ptr' || v.tag === 'nil';
      let eq;
      if (ptr(a) || ptr(b)) {
        if (!ptr(a) || !ptr(b)) throw mismatch();
        eq = (a.cell || null) === (b.cell || null);
      } else if (numeric || a.tag === b.tag) eq = a.v === b.v;
      else throw mismatch();
      return eq === (op === '==') ? TRUE : FALSE;
    }
    let x, y;
    if (numeric) { x = a.v; y = b.v; }
    else if (a.tag === 'char' && b.tag === 'char') { x = a.v.codePointAt(0); y = b.v.codePointAt(0); }
    else throw mismatch();
    return (op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y) ? TRUE : FALSE;
  }
  function builtin(e, env) {
    const line = e.span.line;
    if (e.name !== 'len') throw new RTError(line, `Unknown subprogram '${e.name}'`);
    if (e.args.length !== 1) throw new RTError(line, 'len expects 1 argument');
    const s = evalExpr(e.args[0], env);
    if (s.tag !== 'str') throw new RTError(line, `len expects string, got ${typeName(s)}`);
    return V.int([...s.v].length);
  }

  // ---------- calls ----------
  function invoke(sub, e, env) {
    const line = e.span.line, u = sub.unit, name = u.name;
    if (++depth > RECURSION_CAP) { depth--; throw new RTError(line, `Maximum recursion depth exceeded (${RECURSION_CAP})`); }
    callLine = line;
    if (depth > maxDepth) maxDepth = depth;
    try {
      if (u.badParams) throw new RTError(line, `Bad parameter list in '${name}'`);
      if (e.args.length !== sub.params.length) throw new RTError(line, `Wrong argument count for '${name}' (expected ${sub.params.length}, got ${e.args.length})`);
      const frame = makeFrame(u);
      for (let i = 0; i < sub.params.length; i++) {
        const p = sub.params[i], a = e.args[i], label = `${name}.${p.name}`;
        if (p.mode === 'in') { // by value: a copy
          const v = checkFits(p.type, evalExpr(a, env), 'argument', label, line);
          frame.set(p.name, { cell: { type: p.type, val: clone(v), assigned: true }, parents: EMPTY });
          continue;
        }
        // out, in/out: the parameter is the caller's own storage
        const r = refable(a) ? refOf(a, env) : null;
        if (!r || r.strIndex !== undefined) throw new RTError(line, `Argument '${label}' is ${p.mode} — pass a variable`);
        if (r.cell.isConst) throw new RTError(line, `Cannot pass constant '${src(a.span)}' as ${p.mode} argument`);
        if (!T.sameType(p.type, r.cell.type)) throw new RTError(line, `Type mismatch in argument '${label}' (expected ${T.describe(p.type)}, got ${T.describe(r.cell.type)})`);
        if (p.mode === 'out') { r.cell.val = defaultVal(r.cell.type, line); r.cell.assigned = false; }
        frame.set(p.name, { cell: r.cell, parents: r.parents });
      }
      const sig = execBlock(u.body, frame, u);
      if (u.kind !== 'function') return null;
      if (!sig || sig.value === null) throw new RTError(line, `Function '${name}' finished without return`);
      return sig.value;
    } finally {
      depth--;
    }
  }

  // ---------- statements ----------
  function truth(e, env, line) {
    if (!e) throw new RTError(line, 'Missing condition');
    const v = evalExpr(e, env);
    if (v.tag !== 'bool') throw new RTError(line, 'Non-boolean condition');
    return v.v;
  }
  // returns undefined, or {value} when a return statement ran
  function execBlock(stmts, env, unit) {
    for (let i = 0; i < stmts.length; i++) {
      const r = execStmt(stmts[i], env, unit);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  function execStmt(s, env, unit) {
    const line = s.line;
    switch (s.k) {
      case 'if':
        tick(line);
        for (const br of s.branches) {
          if (br.error) throw new RTError(br.line, br.error);
          if (truth(br.cond, env, br.line)) return execBlock(br.body, env, unit);
        }
        return s.else ? execBlock(s.else, env, unit) : undefined;
      case 'while':
        for (;;) {
          tick(line);
          if (s.error) throw new RTError(line, s.error);
          if (!truth(s.cond, env, line)) return undefined;
          const r = execBlock(s.body, env, unit);
          if (r !== undefined) return r;
        }
      case 'repeat':
        if (s.untilLine < 0) throw new RTError(line, "repeat without 'until'");
        for (;;) {
          tick(line);
          const r = execBlock(s.body, env, unit);
          if (r !== undefined) return r;
          tick(s.untilLine);
          if (s.error) throw new RTError(s.untilLine, s.error);
          if (truth(s.cond, env, s.untilLine)) return undefined;
        }
      case 'for': {
        tick(line);
        if (s.error) throw new RTError(line, s.error);
        const a = evalExpr(s.from, env), b = evalExpr(s.to, env);
        if (a.tag !== 'int' || b.tag !== 'int') throw new RTError(line, 'for bounds must be integers');
        const v = env.get(s.name) || globals.get(s.name);
        if (!v) throw new RTError(line, `Undeclared loop variable '${s.name}' — declare it in kamus`);
        if (v.cell.isConst) throw new RTError(line, `Cannot assign to constant '${s.name}'`);
        write(v, checkFits(v.cell.type, a, 'assignment to', s.name, line)); // a loop that never runs still leaves i = start
        for (let i = a.v; i <= b.v; i++) {
          tick(line);
          write(v, checkFits(v.cell.type, V.int(i), 'assignment to', s.name, line));
          const r = execBlock(s.body, env, unit);
          if (r !== undefined) return r;
        }
        return undefined;
      }
      case 'case': {
        tick(line);
        if (s.error) throw new RTError(line, s.error);
        const v = evalExpr(s.expr, env);
        for (const br of s.branches) {
          if (br.error) throw new RTError(br.line, br.error);
          for (const lab of br.labels) {
            const lv = evalExpr(lab, env);
            const same = isNum(v) && isNum(lv) ? v.v === lv.v : v.tag === lv.tag && v.v === lv.v;
            if (same) return execBlock(br.body, env, unit);
          }
        }
        return s.else ? execBlock(s.else, env, unit) : undefined;
      }
    }
    // simple statements
    tick(line);
    if (s.error) throw new RTError(line, s.error);
    switch (s.k) {
      case 'assign': assign(s, env); return undefined;
      case 'call': {
        const sub = subs.get(s.call.name);
        if (sub) invoke(sub, s.call, env);
        else builtin(s.call, env);
        return undefined;
      }
      case 'output': {
        const parts = [];
        for (const a of s.args) {
          const f = format(evalExpr(a, env));
          if (f === null) throw new RTError(line, 'Cannot output compound value (print elements)');
          parts.push(f);
        }
        emit(parts.join(' '));
        return undefined;
      }
      case 'input': input(s, env); return undefined;
      case 'allocate': {
        const r = refOf(s.args[0], env), name = src(s.args[0].span);
        if (r.cell.type.k !== 'pointer' || r.cell.temp || r.strIndex !== undefined) throw new RTError(line, `allocate expects a pointer variable '${name}'`);
        const cell = newCell(r.cell.type.target, line);
        cell.heap = { id: ++heapSeq, freed: false };
        heap.push(cell);
        write(r, { tag: 'ptr', cell });
        return undefined;
      }
      case 'deallocate': {
        const r = refOf(s.args[0], env), name = src(s.args[0].span);
        if (r.cell.type.k !== 'pointer' || r.strIndex !== undefined) throw new RTError(line, `deallocate expects a pointer variable '${name}'`);
        const v = r.cell.val;
        if (!v || v.tag !== 'ptr' || !v.cell) throw new RTError(line, 'NIL pointer dereference');
        if (!v.cell.heap) throw new RTError(line, `Cannot deallocate '${name}' — it points to a variable, not to allocated memory`);
        if (v.cell.heap.freed) throw new RTError(line, 'Double free of pointer');
        v.cell.heap.freed = true;
        return undefined;
      }
      case 'return':
        if (unit.kind === 'program') throw new RTError(line, "'return' is only allowed inside a function or procedure");
        if (unit.kind === 'procedure') {
          if (s.value) throw new RTError(line, 'Procedures do not return values');
          return RET_VOID;
        }
        if (!s.value) throw new RTError(line, `return needs a value in function '${unit.name}'`);
        return { value: checkFits(unit.sub ? unit.sub.retType : T.UNKNOWN, evalExpr(s.value, env), 'return of', unit.name, line) };
    }
    throw new RTError(line, 'Cannot execute this line');
  }
  function assign(s, env) {
    const line = s.line;
    let v = evalExpr(s.value, env);
    const r = refable(s.target) ? refOf(s.target, env) : null;
    const name = src(s.target.span);
    if (!r) throw new RTError(line, `Cannot assign to '${name}'`);
    if (r.cell.isConst) throw new RTError(line, `Cannot assign to constant '${name}'`);
    if (r.strIndex !== undefined) { // s[i] = "x"
      if (v.tag !== 'str' || [...v.v].length !== 1) throw new RTError(line, 'Type mismatch in string element assignment (expected single character string)');
      const chars = [...r.cell.val.v];
      chars[r.strIndex] = v.v;
      write(r, V.str(chars.join('')));
      return;
    }
    const type = r.cell.type;
    if (type.k === 'array' || v.tag === 'arr') throw new RTError(line, 'Cannot assign array — copy element by element');
    if (v.tag === 'char' && type.k === 'string') v = V.str(v.v); // unconfirmed with lecturer
    write(r, clone(checkFits(type, v, 'assignment to', name, line)));
  }
  function format(v) {
    switch (v.tag) {
      case 'bool': return v.v ? 'true' : 'false';
      case 'int': case 'real': return String(v.v);
      case 'char': case 'str': return v.v;
      case 'nil': return 'NIL';
      case 'ptr':
        if (!v.cell) return 'NIL';
        if (v.cell.addr === undefined) v.cell.addr = v.cell.heap ? 0x1000 + 16 * v.cell.heap.id : 0x7ffc2000 + 4 * addrSeq++;
        return '0x' + v.cell.addr.toString(16);
    }
    return null; // array, struct
  }

  // ---------- input ----------
  // Values are separated by spaces and may come on one line or several. A string that is
  // the last variable of an input(...) takes the rest of its line, so names can have spaces.
  const pending = inputText ? inputText.split(/\r?\n/) : [];
  let buf = '';
  function refill() {
    const l = pending.length ? pending.shift() : opts.readLine ? opts.readLine() : null;
    if (l === null || l === undefined) return false;
    buf = l;
    return true;
  }
  function nextToken() {
    for (;;) {
      const m = buf.match(/^\s*(\S+)/);
      if (m) { buf = buf.slice(m[0].length); return m[1]; }
      if (!refill()) return null;
    }
  }
  function restOfLine() {
    for (;;) {
      const t = buf.trim();
      if (t) { buf = ''; return t; }
      if (!refill()) return null;
    }
  }
  function input(s, env) {
    const line = s.line;
    s.args.forEach((a, i) => {
      const name = src(a.span);
      const r = refable(a) ? refOf(a, env) : null;
      if (!r || r.strIndex !== undefined) throw new RTError(line, `Cannot input into '${name}'`);
      if (r.cell.isConst) throw new RTError(line, `Cannot assign to constant '${name}'`);
      const type = r.cell.type;
      const tok = type.k === 'string' && i === s.args.length - 1 ? restOfLine() : nextToken();
      if (tok === null) throw new RTError(line, `Not enough input values for '${name}'`);
      write(r, parseInput(tok, type, name, line));
    });
  }
  function parseInput(tok, type, name, line) {
    const invalid = (what) => new RTError(line, `Invalid input '${tok}' for ${what} '${name}'`);
    switch (type.k) {
      case 'int': case 'subrange':
        if (!/^[+-]?\d+$/.test(tok)) throw invalid('integer');
        return checkFits(type, V.int(parseInt(tok, 10)), 'input', name, line);
      case 'real': if (!/^[+-]?(\d+\.\d*|\d*\.\d+|\d+)$/.test(tok)) throw invalid('real'); return V.real(parseFloat(tok));
      case 'bool': if (tok !== 'true' && tok !== 'false') throw invalid('boolean'); return tok === 'true' ? TRUE : FALSE;
      case 'char': if ([...tok].length !== 1) throw invalid('char'); return V.char(tok);
      case 'string': case 'unknown': return V.str(tok);
    }
    throw new RTError(line, `Cannot input into '${name}' (${T.describe(type)}) — read it one field or element at a time`);
  }

  // ---------- run ----------
  if (!program) return { output, error: { line: 0, msg: 'No program block found' }, staticErrors: null, leaks: 0 };
  try {
    globals = makeFrame(program);
    execBlock(program.body, globals, program);
  } catch (e) {
    // the JS stack can run out before RECURSION_CAP on the main thread (the worker runner has a bigger one)
    if (e instanceof RangeError && /call stack/i.test(e.message)) throw new RTError(callLine, `Recursion too deep: ran out of stack after ${maxDepth} nested calls`);
    throw e;
  }
  const leaks = heap.filter(c => !c.heap.freed).length;
  if (leaks) emit(`Warning: ${leaks} heap allocation(s) never deallocated`);
  return { output, error: null, staticErrors: null, leaks };
}

module.exports = { runProgram };
