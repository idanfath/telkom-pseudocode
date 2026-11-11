// Parser: source text -> one syntax tree for the whole file. Never throws on bad code:
// every problem becomes a diagnostic and the parser carries on at the next line, so a
// half-typed file still yields a usable tree for completion, rename and the checker.
//
// The language is line-oriented (one statement or declaration per line), so the parser
// works in two levels: lines are classified and nested into units and blocks, and the
// tokens of each line go through a recursive-descent expression/statement grammar.
'use strict';
const { tokenize, UNIT_OPEN, UNIT_CLOSE, MODES, BASE_TYPES, BUILTIN_FUNCTIONS } = require('./lexer');

/**
 * @typedef {import('./lexer').Token} Token
 * @typedef {{line: number, col: number, endCol: number}} Span
 * @typedef {{line: number, col: number, endCol: number, msg: string, sev: 0|1|2}} Diag  sev: 0 error, 1 warning, 2 info
 *
 * @typedef {object} Program
 * @property {Unit[]} units       in source order
 * @property {Diag[]} diags       syntax diagnostics
 * @property {Token[][]} lines    tokens per line, comments included
 * @property {string[]} rawLines
 *
 * @typedef {object} Unit
 * @property {'program'|'function'|'procedure'} kind
 * @property {string} name
 * @property {Span|null} nameSpan
 * @property {number} startLine   header line
 * @property {number} endLine     line of its end keyword (last line of the file when unclosed)
 * @property {boolean} closed
 * @property {Param[]} params
 * @property {boolean} badParams  the parameter list did not parse
 * @property {TypeNode|null} retType
 * @property {number|null} kamusLine
 * @property {number|null} algoLine
 * @property {Decl[]} decls
 * @property {Stmt[]} body
 * @property {number[]} prototypes lines of subprogram headers written inside kamus (accepted, unused)
 *
 * @typedef {{name: string, span: Span, mode: 'in'|'out'|'in/out'|null, type: TypeNode}} Param
 * @typedef {{kind: 'var'|'const'|'type', name: string, span: Span, type: TypeNode, init?: Expr|null, line: number}} Decl
 *
 * @typedef {{k: 'name', name: string, span: Span}
 *   | {k: 'array', lo: Expr, hi: Expr, elem: TypeNode, span: Span}
 *   | {k: 'subrange', lo: Expr, hi: Expr, span: Span}
 *   | {k: 'pointer', target: TypeNode, span: Span}
 *   | {k: 'struct', fields: {name: string, span: Span, type: TypeNode}[], span: Span}
 *   | {k: 'bad', span: Span}} TypeNode
 *
 * Expressions. `paren` is set when the expression was written inside ( ).
 * @typedef {{k: 'num', value: number, real: boolean, span: Span}
 *   | {k: 'str', value: string, span: Span}
 *   | {k: 'char', value: string, span: Span}
 *   | {k: 'bool', value: boolean, span: Span}
 *   | {k: 'nil', span: Span}
 *   | {k: 'name', name: string, span: Span}
 *   | {k: 'call', name: string, nameSpan: Span, args: Expr[], span: Span}
 *   | {k: 'index', base: Expr, index: Expr, span: Span}
 *   | {k: 'field', base: Expr, name: string, nameSpan: Span, arrow: boolean, span: Span}
 *   | {k: 'addr', operand: Expr, span: Span}
 *   | {k: 'deref', operand: Expr, span: Span}
 *   | {k: 'unary', op: '-'|'not', operand: Expr, span: Span}
 *   | {k: 'binary', op: string, left: Expr, right: Expr, opSpan: Span, span: Span}} Expr
 *
 * Statements. `error` holds the syntax error of a line that only partly parsed: the
 * checker has already reported it, and the runner raises it if the line is reached.
 * @typedef {{k: 'assign', target: Expr, value: Expr, line: number}
 *   | {k: 'call', call: Expr, line: number}
 *   | {k: 'input'|'output'|'allocate'|'deallocate', args: Expr[], span: Span, line: number, error?: string}
 *   | {k: 'return', value: Expr|null, span: Span, line: number, error?: string}
 *   | {k: 'if', branches: {cond: Expr|null, body: Stmt[], line: number, error?: string}[], else: Stmt[]|null, line: number}
 *   | {k: 'case', expr: Expr|null, branches: {labels: Expr[], body: Stmt[], line: number, error?: string}[], else: Stmt[]|null, line: number, error?: string}
 *   | {k: 'for', name: string|null, nameSpan: Span|null, from: Expr|null, to: Expr|null, body: Stmt[], line: number, error?: string}
 *   | {k: 'while', cond: Expr|null, body: Stmt[], line: number, error?: string}
 *   | {k: 'repeat', body: Stmt[], cond: Expr|null, untilLine: number, line: number, error?: string}
 *   | {k: 'bad', line: number, error: string}} Stmt
 */

const diag = (sev) => (line, col, endCol, msg) => ({ line, col, endCol: Math.max(endCol, col + 1), msg, sev });
const err = diag(0), warn = diag(1), info = diag(2);

class SyntaxErr {
  constructor(tok, msg, atEnd = false) { this.tok = tok; this.msg = msg; this.atEnd = atEnd; }
}

// ---------- token stream ----------
const tokLen = (t) => (t.badCase || t.text).length;
/** @returns {Span} */
const tokSpan = (t) => ({ line: t.line, col: t.col, endCol: t.col + tokLen(t) });
const peek = (P) => P.toks[P.i];
const next = (P) => P.toks[P.i++];
const isKw = (t, w) => !!t && t.kind === 'keyword' && t.text === w;
const isOp = (t, o) => !!t && t.kind === 'op' && t.text === o;
const isSep = (t, s) => !!t && t.kind === 'sep' && t.text === s;
const isWord = (t) => !!t && (t.kind === 'ident' || t.kind === 'keyword' || t.kind === 'constant');
const fail = (P, msg) => { throw new SyntaxErr(peek(P), msg, !peek(P)); };
function expectKw(P, w, msg) { if (!isKw(peek(P), w)) fail(P, msg); return next(P); }
function expectOp(P, o, msg) { if (!isOp(peek(P), o)) fail(P, msg); return next(P); }
function end(P) { const t = peek(P); if (t) throw new SyntaxErr(t, `Unexpected '${t.badCase || t.text}'`); }
/** span from a start token to the last token consumed */
function spanFrom(P, startTok) {
  const last = P.toks[P.i - 1] || startTok;
  return { line: startTok.line, col: startTok.col, endCol: last.line === startTok.line ? last.col + tokLen(last) : startTok.col + tokLen(startTok) };
}
const join = (a, b) => ({ line: a.line, col: a.col, endCol: b.line === a.line ? b.endCol : a.endCol });
const unescapeStr = (s) => s.replace(/\\(.)/g, '$1');

// ---------- expressions ----------
// precedence, loosest first: or, and, not, comparison (one per expression), + -, * / div mod, unary -, postfix
function expr(P) { return orExpr(P); }
function binary(opTok, left, right) {
  return { k: 'binary', op: opTok.text, left, right, opSpan: tokSpan(opTok), span: join(left.span, right.span) };
}
function orExpr(P) {
  let l = andExpr(P);
  while (isKw(peek(P), 'or')) { const op = next(P); l = binary(op, l, andExpr(P)); }
  return l;
}
function andExpr(P) {
  let l = notExpr(P);
  while (isKw(peek(P), 'and')) { const op = next(P); l = binary(op, l, notExpr(P)); }
  return l;
}
function notExpr(P) {
  const t = peek(P);
  if (isKw(t, 'not')) { next(P); const operand = notExpr(P); return { k: 'unary', op: 'not', operand, span: join(tokSpan(t), operand.span) }; }
  return cmpExpr(P);
}
const CMP = new Set(['==', '!=', '<', '>', '<=', '>=']);
function cmpExpr(P) {
  const l = addExpr(P);
  const t = peek(P);
  if (t && t.kind === 'op' && CMP.has(t.text)) { next(P); return binary(t, l, addExpr(P)); }
  return l;
}
function addExpr(P) {
  let l = mulExpr(P);
  while (isOp(peek(P), '+') || isOp(peek(P), '-')) { const op = next(P); l = binary(op, l, mulExpr(P)); }
  return l;
}
function mulExpr(P) {
  let l = unary(P);
  while (isOp(peek(P), '*') || isOp(peek(P), '/') || isKw(peek(P), 'div') || isKw(peek(P), 'mod')) { const op = next(P); l = binary(op, l, unary(P)); }
  return l;
}
function unary(P) {
  const t = peek(P);
  if (isOp(t, '-')) { next(P); const operand = unary(P); return { k: 'unary', op: '-', operand, span: join(tokSpan(t), operand.span) }; }
  return postfix(P);
}
// a primary followed by any number of (args), [index], .field, ->field
function postfix(P) {
  let e = primary(P);
  for (;;) {
    const t = peek(P);
    if (isOp(t, '(')) {
      if (e.k !== 'name' || e.paren) fail(P, "Unexpected '('");
      next(P);
      const args = argList(P);
      const close = expectOp(P, ')', "Missing ')'");
      e = { k: 'call', name: e.name, nameSpan: e.span, args, span: { line: e.span.line, col: e.span.col, endCol: close.col + 1 } };
      continue;
    }
    if (isOp(t, '[')) {
      next(P);
      const index = expr(P);
      const close = expectOp(P, ']', "Missing ']'");
      e = { k: 'index', base: e, index, span: { line: e.span.line, col: e.span.col, endCol: close.col + 1 } };
      continue;
    }
    if (isOp(t, '->') || isOp(t, '.')) {
      next(P);
      const f = peek(P);
      if (!isWord(f)) fail(P, `Missing field name after '${t.text}'`);
      next(P);
      f.asName = true;
      e = { k: 'field', base: e, name: f.badCase || f.text, nameSpan: tokSpan(f), arrow: t.text === '->', span: join(e.span, tokSpan(f)) };
      continue;
    }
    return e;
  }
}
function argList(P) {
  const args = [];
  if (isOp(peek(P), ')')) return args;
  for (;;) {
    args.push(expr(P));
    if (isSep(peek(P), ',')) { next(P); continue; }
    return args;
  }
}
function primary(P) {
  const t = peek(P);
  if (!t) fail(P, 'Incomplete expression');
  const span = tokSpan(t);
  switch (t.kind) {
    case 'number': next(P); return { k: 'num', value: Number(t.text), real: !/^0[xX]/.test(t.text) && t.text.includes('.'), span };
    case 'string': next(P); return { k: 'str', value: unescapeStr(t.text.slice(1, -1)), span };
    case 'char': next(P); return { k: 'char', value: unescapeStr(t.text.slice(1, -1)), span };
    case 'constant': next(P); return t.text === 'NIL' ? { k: 'nil', span } : { k: 'bool', value: t.text === 'true', span };
    case 'ident': next(P); return { k: 'name', name: t.text, span };
    case 'op':
      if (t.text === '(') {
        next(P);
        const e = expr(P);
        const close = expectOp(P, ')', "Missing ')'");
        e.span = { line: t.line, col: t.col, endCol: close.line === t.line ? close.col + 1 : e.span.endCol };
        e.paren = true;
        return e;
      }
      if (t.text === '&') {
        next(P);
        const id = peek(P);
        if (!id || id.kind !== 'ident') fail(P, "'&' needs a variable name");
        next(P);
        return { k: 'addr', operand: { k: 'name', name: id.text, span: tokSpan(id) }, span: join(span, tokSpan(id)) };
      }
      if (t.text === '*') { next(P); const operand = postfix(P); return { k: 'deref', operand, span: join(span, operand.span) }; }
  }
  throw new SyntaxErr(t, `Unexpected '${t.badCase || t.text}'`);
}

// ---------- types ----------
function parseType(P) {
  const t = peek(P);
  if (!t) fail(P, 'Missing type');
  if (isKw(t, 'array')) {
    next(P);
    expectOp(P, '[', 'Array type needs bounds — use: array[lo..hi] of type');
    const lo = addExpr(P);
    expectOp(P, '..', "Array bounds need '..' — use: array[lo..hi] of type");
    const hi = addExpr(P);
    expectOp(P, ']', "Missing ']' in array type");
    expectKw(P, 'of', "Missing 'of' — use: array[lo..hi] of type");
    const elem = parseType(P);
    return { k: 'array', lo, hi, elem, span: spanFrom(P, t) };
  }
  if (isKw(t, 'pointer')) {
    next(P);
    expectKw(P, 'to', "Missing 'to' — use: pointer to type");
    const target = parseType(P);
    return { k: 'pointer', target, span: spanFrom(P, t) };
  }
  if (t.kind === 'keyword' && BASE_TYPES.includes(t.text)) {
    next(P);
    if (t.text === 'integer' && isOp(peek(P), '[')) {
      next(P);
      const lo = addExpr(P);
      expectOp(P, '..', "Subrange needs '..' — use: integer[lo..hi]");
      const hi = addExpr(P);
      expectOp(P, ']', "Missing ']' in subrange");
      return { k: 'subrange', lo, hi, span: spanFrom(P, t) };
    }
    return { k: 'name', name: t.text, span: tokSpan(t) };
  }
  if (t.kind === 'ident') { next(P); return { k: 'name', name: t.text, span: tokSpan(t) }; }
  throw new SyntaxErr(t, `'${t.badCase || t.text}' is not a type`);
}

// ---------- one statement line ----------
// Block keywords return "line nodes" (if-head, else, end, ...) that parse() nests into blocks.
const END_OF = { endif: 'if', endcase: 'case', endfor: 'for', endwhile: 'while' };
function parseLine(toks, report) {
  const P = { toks, i: 0 };
  const t0 = toks[0];
  const kw = t0.kind === 'keyword' ? t0.text : null;
  let node = null;
  try {
    switch (kw) {
      case 'if':
        node = { k: 'if-head', cond: null }; next(P);
        node.cond = expr(P); expectKw(P, 'then', "Missing 'then' after the if condition"); end(P); return node;
      case 'else':
        next(P);
        if (isKw(peek(P), 'if')) {
          node = { k: 'elseif', cond: null }; next(P);
          node.cond = expr(P); expectKw(P, 'then', "Missing 'then' after the else if condition");
        } else if (isSep(peek(P), ':')) { node = { k: 'case-else' }; next(P); }
        else node = { k: 'else' };
        end(P); return node;
      case 'while':
        node = { k: 'while-head', cond: null }; next(P);
        node.cond = expr(P); expectKw(P, 'do', "Missing 'do' after the while condition"); end(P); return node;
      case 'case':
        node = { k: 'case-head', expr: null }; next(P);
        node.expr = expr(P); expectKw(P, 'of', "Missing 'of' after the case expression"); end(P); return node;
      case 'until':
        node = { k: 'until', cond: null }; next(P);
        node.cond = expr(P); end(P); return node;
      case 'for': {
        node = { k: 'for-head', name: null, nameSpan: null, from: null, to: null }; next(P);
        const v = peek(P);
        if (!v || v.kind !== 'ident') fail(P, 'for needs a loop variable: for i = a to b do');
        next(P); node.name = v.text; node.nameSpan = tokSpan(v);
        expectOp(P, '=', "Missing '=' after the loop variable");
        node.from = expr(P);
        expectKw(P, 'to', "Missing 'to' in for loop");
        node.to = expr(P);
        expectKw(P, 'do', "Missing 'do' after the for range");
        end(P); return node;
      }
      case 'repeat': node = { k: 'repeat-head' }; next(P); end(P); return node;
      case 'endif': case 'endfor': case 'endwhile': case 'endcase':
        node = { k: 'end', word: kw, what: END_OF[kw] }; next(P); end(P); return node;
      case 'return':
        node = { k: 'return', value: null, span: tokSpan(t0) }; next(P);
        if (peek(P)) node.value = expr(P);
        end(P); return node;
      case 'input': case 'output': case 'allocate': case 'deallocate':
        node = { k: kw, args: [], span: tokSpan(t0) }; next(P);
        expectOp(P, '(', `Missing '(' after ${kw}`);
        node.args = argList(P);
        expectOp(P, ')', "Missing ')'");
        if (kw === 'input' && !node.args.length) throw new SyntaxErr(t0, 'input needs at least one variable');
        if ((kw === 'allocate' || kw === 'deallocate') && node.args.length !== 1) throw new SyntaxErr(t0, `${kw} takes exactly one pointer`);
        end(P); return node;
    }
    // case label: 1:   'a', 'b':
    if (isSep(toks[toks.length - 1], ':')) {
      node = { k: 'label', labels: [] };
      node.labels.push(expr(P));
      while (isSep(peek(P), ',')) { next(P); node.labels.push(expr(P)); }
      if (!isSep(peek(P), ':')) fail(P, "Missing ':' after case label");
      next(P); end(P); return node;
    }
    if (declShape(toks) || kw === 'constant' || kw === 'type') throw new SyntaxErr(t0, 'Declaration inside algoritma — move it up into kamus');
    // assignment or call
    const target = postfix(P);
    if (isOp(peek(P), '=')) { next(P); const value = expr(P); end(P); return { k: 'assign', target, value }; }
    if (target.k === 'call' && !target.paren && !peek(P)) return { k: 'call', call: target };
    throw new SyntaxErr(t0, "Not a statement — expected an assignment 'x = ...' or a call");
  } catch (e) {
    if (!(e instanceof SyntaxErr)) throw e;
    report(toks, e);
    node = node || { k: 'bad' };
    node.error = e.msg;
    return node;
  }
}

// name (, name)* : something   — the shape of a variable declaration
function declShape(code) {
  let i = 0;
  for (;;) {
    if (!isWord(code[i])) return false;
    i++;
    if (isSep(code[i], ',')) { i++; continue; }
    return isSep(code[i], ':') && i + 1 < code.length;
  }
}

const STATEMENT_START = new Set(['if', 'else', 'endif', 'case', 'endcase', 'for', 'endfor', 'while', 'endwhile', 'repeat', 'until', 'input', 'output', 'allocate', 'deallocate', 'return']);
const STRUCT_STOP = new Set(['kamus', 'algoritma', 'dictionary', 'algorithm', 'type', 'constant', ...UNIT_OPEN, ...UNIT_CLOSE]);
const BLANK_BEFORE = /^\s*(kamus|algoritma|dictionary|algorithm|endprogram|endfunction|endprocedure)\b/;
const BLANK_AFTER = /^\s*(kamus|algoritma|dictionary|algorithm)\b/;

/**
 * @param {string} text
 * @returns {Program}
 */
function parse(text) {
  const { lines, unclosedComment } = tokenize(text);
  const rawLines = text.split(/\r?\n/);
  /** @type {Diag[]} */
  const diags = [];
  /** @type {Unit[]} */
  const units = [];
  const stack = []; // open units, innermost last
  const consumed = new Set(); // lines swallowed by a multi-line struct
  const top = () => stack[stack.length - 1] || null;

  const lineErr = (n, msg) => {
    const raw = rawLines[n] || '';
    const col = raw.length - raw.trimStart().length;
    diags.push(err(n, col, raw.trimEnd().length, msg));
  };
  const tokErr = (t, msg) => diags.push(err(t.line, t.col, t.col + tokLen(t), msg));
  const report = (toks, e) => {
    if (toks.some(t => t.kind === 'error')) return; // the token pass below already reported this line
    const last = toks[toks.length - 1];
    if (e.atEnd || !e.tok) { const c = last ? last.col + tokLen(last) : 0; diags.push(err(last ? last.line : 0, c, c + 1, e.msg)); }
    else tokErr(e.tok, e.msg);
  };

  // --- token-level problems ---
  if (unclosedComment) {
    let open = null;
    for (const toks of lines) for (const t of toks) if (t.kind === 'comment' && t.text.startsWith('{') && !t.text.endsWith('}')) open = t;
    if (open) tokErr(open, "Unclosed '{' comment");
  }
  for (const toks of lines) for (const t of toks) {
    if (t.kind !== 'error') continue;
    if (t.text.startsWith('"')) tokErr(t, 'Unclosed string literal');
    else if (t.text === '}') tokErr(t, "Stray '}' outside comment");
    else if (t.text === "'") tokErr(t, "Bad char literal — a char is one character in single quotes: 'a'");
    else if (t.text === '^') tokErr(t, "There is no '^' operator — multiply in a loop or use recursion");
    else tokErr(t, `Unexpected character '${t.text}'`);
  }
  // --- blank-line rule: program / kamus / algoritma / end* form one unbroken block ---
  rawLines.forEach((raw, n) => {
    if (!/^\s*$/.test(raw)) return;
    const prev = rawLines[n - 1] || '', nextRaw = rawLines[n + 1] || '';
    if (BLANK_BEFORE.test(nextRaw)) lineErr(n + 1, `Blank line before '${nextRaw.trim().split(/\s/)[0]}'`);
    if (BLANK_AFTER.test(prev)) diags.push(err(n, 0, 1, `Blank line after '${prev.trim().split(/\s/)[0]}' breaks structural block`));
  });

  // a name where one is expected; a reserved word is accepted (and reported) so parsing can go on
  function nameTok(P, what) {
    const t = peek(P);
    if (!isWord(t)) return null;
    next(P);
    if (t.kind !== 'ident' || BUILTIN_FUNCTIONS.includes(t.text)) {
      tokErr(t, `'${t.text}' is a reserved word — choose another ${what} name`);
      t.asName = true;
    }
    return t;
  }

  // --- units ---
  function openUnit(kind, n, code) {
    const parent = top();
    if (parent) lineErr(n, kind === 'program' ? `Nested unit: close '${parent.kind}' first` : 'Subprogram must be declared outside program block');
    /** @type {any} */
    const u = {
      kind, name: '?', nameSpan: null, startLine: n, endLine: n, closed: false, params: [], badParams: false, retType: null,
      kamusLine: null, algoLine: null, decls: [], body: [], prototypes: [], phase: 'header', frames: [],
    };
    const usage = kind === 'function' ? 'function name(a: type) -> type' : 'procedure name(in a: type)';
    const P = { toks: code, i: 1 };
    try {
      const nt = nameTok(P, kind);
      if (!nt) fail(P, kind === 'program' ? 'Program needs a name' : `Bad ${kind} header — use: ${usage}`);
      u.name = nt.badCase || nt.text;
      u.nameSpan = tokSpan(nt);
      if (kind !== 'program') {
        expectOp(P, '(', `Bad ${kind} header — use: ${usage}`);
        parseParams(P, u);
        if (kind === 'function') {
          if (!isOp(peek(P), '->')) fail(P, 'Function needs return type (-> TYPE)');
          next(P);
          u.retType = parseType(P);
        } else if (isOp(peek(P), '->')) fail(P, 'Procedures have no return type — use a function, or an out parameter');
      }
      end(P);
    } catch (e) {
      if (!(e instanceof SyntaxErr)) throw e;
      report(code, e);
    }
    units.push(u);
    stack.push(u);
  }
  // in a, b: integer, in/out c: real — each name takes the nearest mode written before it in its group
  function parseParams(P, u) {
    if (isOp(peek(P), ')')) { next(P); return; }
    try {
      for (;;) {
        const pending = [];
        let mode = null;
        for (;;) {
          const m = peek(P);
          if (m && m.kind === 'keyword' && MODES.includes(m.text)) { mode = m.text; next(P); }
          const nt = nameTok(P, 'parameter');
          if (!nt) fail(P, 'Bad parameter — use: (in a, b: integer, in/out c: real)');
          pending.push({ name: nt.badCase || nt.text, span: tokSpan(nt), mode });
          if (isSep(peek(P), ',')) { next(P); continue; }
          break;
        }
        if (!isSep(peek(P), ':')) fail(P, "Parameter needs a type — use 'name: type'");
        next(P);
        const type = parseType(P);
        for (const p of pending) u.params.push({ ...p, type });
        if (isSep(peek(P), ',')) { next(P); continue; }
        break;
      }
      expectOp(P, ')', "Missing ')' after the parameters");
    } catch (e) {
      u.badParams = true;
      throw e;
    }
  }
  function drainFrames(u, closer) {
    while (u.frames.length) {
      const f = u.frames.pop();
      lineErr(f.line, closer ? `Unclosed '${f.kind}' (reached '${closer}')` : `Unclosed '${f.kind}'`);
    }
  }
  function closeUnit(n, code) {
    const closer = code[0].text;
    if (!stack.length) { lineErr(n, `Stray '${closer}' with no open unit`); return; }
    let idx = stack.length - 1;
    while (idx >= 0 && 'end' + stack[idx].kind !== closer) idx--;
    if (idx < 0) {
      const u = top();
      lineErr(n, `'${closer}' does not match '${u.kind} ${u.name}' — use 'end${u.kind}'`);
      idx = stack.length - 1;
    }
    while (stack.length - 1 > idx) {
      const inner = stack.pop();
      lineErr(inner.startLine, `Unclosed '${inner.kind} ${inner.name}' (reached '${closer}')`);
      drainFrames(inner, closer);
      inner.endLine = n - 1;
    }
    const u = stack.pop();
    drainFrames(u, closer);
    u.endLine = n;
    u.closed = true;
    if (code.length > 1) tokErr(code[1], `Unexpected '${code[1].badCase || code[1].text}'`);
  }
  function marker(u, n, code, which) {
    if (which === 'kamus') {
      if (u.kamusLine !== null) lineErr(n, "Duplicate 'kamus' in unit");
      else if (u.phase === 'algo') lineErr(n, `'${code[0].text}' must come before 'algoritma'`);
      else { u.kamusLine = n; u.phase = 'kamus'; }
    } else {
      if (u.algoLine !== null) lineErr(n, "Duplicate 'algoritma' in unit");
      else u.algoLine = n;
      u.phase = 'algo';
    }
    if (code.length > 1) tokErr(code[1], `Unexpected '${code[1].badCase || code[1].text}'`);
  }

  // --- kamus ---
  function declLine(u, n, code) {
    const kw = code[0].kind === 'keyword' ? code[0].text : null;
    const P = { toks: code, i: 0 };
    try {
      if (declShape(code)) return varDecl(u, n, P);
      if (kw === 'constant') return constDecl(u, n, P);
      if (kw === 'type') return typeDecl(u, n, P);
    } catch (e) {
      if (!(e instanceof SyntaxErr)) throw e;
      report(P.toks, e);
      return;
    }
    if (kw && STATEMENT_START.has(kw)) {
      lineErr(n, "Statement inside kamus — add 'algoritma' before the instructions");
      u.phase = 'algo';
      stmtLine(u, n, code);
    } else if (code.some(t => t.kind === 'op' && (t.text === '=' || t.text === '<-'))) lineErr(n, 'Assignment inside kamus — move below algoritma');
    else lineErr(n, `Not a declaration: '${rawLines[n].trim().slice(0, 30)}'`);
  }
  function varDecl(u, n, P) {
    const names = [];
    for (;;) {
      names.push(nameTok(P, 'variable'));
      if (isSep(peek(P), ',')) { next(P); continue; }
      break;
    }
    const colon = next(P);
    let type = { k: 'bad', span: tokSpan(colon) };
    try { type = parseType(P); end(P); }
    catch (e) { if (!(e instanceof SyntaxErr)) throw e; report(P.toks, e); }
    for (const nt of names) u.decls.push({ kind: 'var', name: nt.badCase || nt.text, span: tokSpan(nt), type, line: n });
  }
  function constDecl(u, n, P) {
    const usage = 'Bad constant — use: constant NAME : type = value';
    next(P);
    const nt = nameTok(P, 'constant');
    if (!nt) fail(P, usage);
    const d = { kind: 'const', name: nt.badCase || nt.text, span: tokSpan(nt), type: { k: 'bad', span: tokSpan(nt) }, init: null, line: n };
    u.decls.push(d);
    if (!isSep(peek(P), ':')) fail(P, usage);
    next(P);
    d.type = parseType(P);
    expectOp(P, '=', 'Constant needs a value — use: constant NAME : type = value');
    d.init = expr(P);
    end(P);
  }
  function typeDecl(u, n, P) {
    next(P);
    const nt = nameTok(P, 'type');
    if (!nt) fail(P, 'Bad type declaration — use: type Name : ...');
    const name = nt.badCase || nt.text, span = tokSpan(nt);
    let colon = false;
    if (isSep(peek(P), ':')) { next(P); colon = true; }
    if (isOp(peek(P), '<')) {
      if (!colon) diags.push(err(n, span.col, span.endCol, `Struct 'type ${name}' needs ':' — use 'type ${name} : < ... >'`));
      const lt = next(P);
      u.decls.push({ kind: 'type', name, span, type: { k: 'struct', fields: structFields(n, P, name), span: tokSpan(lt) }, line: n });
      return;
    }
    const d = { kind: 'type', name, span, type: { k: 'bad', span }, line: n };
    u.decls.push(d);
    if (!colon) fail(P, `Type '${name}' needs ':' — use 'type ${name} : ...'`);
    d.type = parseType(P);
    end(P);
  }
  // fields of 'type X : < a : T, b : U >', usually spread over the following lines
  function structFields(n, P, name) {
    const isGt = (t) => isOp(t, '>');
    const toks = P.toks.slice(P.i);
    P.i = P.toks.length;
    let closed = toks.some(isGt);
    for (let j = n + 1; !closed && j < rawLines.length; j++) {
      const code = lines[j].filter(t => t.kind !== 'comment');
      const k0 = code[0];
      if (k0 && k0.kind === 'keyword' && STRUCT_STOP.has(k0.text) && !isSep(code[1], ':')) break; // ran into the next declaration
      consumed.add(j);
      toks.push(...code);
      closed = code.some(isGt);
    }
    if (!closed) lineErr(n, `Unclosed struct 'type ${name}' — missing '>'`);
    const gt = toks.findIndex(isGt);
    const F = { toks: gt === -1 ? toks : toks.slice(0, gt), i: 0 };
    const skipField = () => { while (peek(F) && !isSep(peek(F), ',')) next(F); if (peek(F)) next(F); };
    const fields = [];
    while (peek(F)) {
      const ft = next(F);
      if (!isWord(ft)) { tokErr(ft, `Unexpected '${ft.text}' in struct — fields look like 'name : type'`); skipField(); continue; }
      ft.asName = true;
      const fname = ft.badCase || ft.text;
      if (!isSep(peek(F), ':')) { tokErr(ft, `Struct field '${fname}' needs ':' — use 'name : type'`); skipField(); continue; }
      next(F);
      let type = { k: 'bad', span: tokSpan(ft) };
      try { type = parseType(F); }
      catch (e) { if (!(e instanceof SyntaxErr)) throw e; report(F.toks, e); skipField(); fields.push({ name: fname, span: tokSpan(ft), type }); continue; }
      fields.push({ name: fname, span: tokSpan(ft), type });
      if (isSep(peek(F), ',')) { next(F); continue; }
      if (peek(F)) tokErr(peek(F), "Missing ',' between struct fields");
    }
    if (gt !== -1 && toks[gt + 1]) tokErr(toks[gt + 1], `Unexpected '${toks[gt + 1].text}'`);
    return fields;
  }

  // --- algoritma ---
  function stmtLine(u, n, code) {
    for (const t of code) if (isOp(t, '<-')) diags.push(err(n, t.col, t.col + 2, "Uses '<-' — use '=' for assignment"));
    const toks = code.map(t => (isOp(t, '<-') ? { ...t, text: '=' } : t)); // read it as the assignment it means
    place(u, parseLine(toks, report), n);
  }
  // nest a parsed line into the unit's open blocks
  function place(u, node, n) {
    const frames = u.frames;
    const topF = () => frames[frames.length - 1];
    const find = (...kinds) => { for (let i = frames.length - 1; i >= 0; i--) if (kinds.includes(frames[i].kind)) return i; return -1; };
    const popTo = (i) => { while (frames.length - 1 > i) { const f = frames.pop(); lineErr(f.line, `Unclosed '${f.kind}'`); } };
    const append = (stmt) => {
      stmt.line = n;
      const f = topF();
      if (!f) u.body.push(stmt);
      else if (f.body) f.body.push(stmt);
      else lineErr(n, "Expected a case label first, like '1:'");
    };
    const open = (kind, stmt, body) => { append(stmt); frames.push({ kind, node: stmt, body, line: n }); };
    const close = (kind, word) => {
      const i = find(kind);
      if (i < 0) { lineErr(n, `Stray '${word}' with no open '${kind}'`); return null; }
      popTo(i);
      return frames.pop();
    };
    const elseBody = (f) => {
      if (f.node.else) lineErr(n, "Duplicate 'else'");
      f.node.else = [];
      f.body = f.node.else;
    };
    switch (node.k) {
      case 'if-head': { const s = { k: 'if', branches: [{ cond: node.cond, body: [], line: n, error: node.error }], else: null }; open('if', s, s.branches[0].body); break; }
      case 'elseif': {
        const i = find('if');
        if (i < 0) { lineErr(n, "'else if' outside 'if'"); break; }
        popTo(i);
        const f = topF();
        if (f.node.else) lineErr(n, "'else if' after 'else'");
        const br = { cond: node.cond, body: [], line: n, error: node.error };
        f.node.branches.push(br);
        f.body = br.body;
        break;
      }
      case 'else': {
        const i = find('if', 'case');
        if (i < 0) { lineErr(n, "'else' outside 'if'/'case'"); break; }
        popTo(i);
        if (topF().kind === 'case') lineErr(n, "In a case, write 'else:' (with a colon)");
        elseBody(topF());
        break;
      }
      case 'case-else': {
        const i = find('case');
        if (i < 0) { lineErr(n, "'else:' outside 'case'"); break; }
        popTo(i);
        elseBody(topF());
        break;
      }
      case 'label': {
        const i = find('case');
        if (i < 0) { lineErr(n, "Case label outside 'case'"); break; }
        popTo(i);
        const f = topF();
        if (f.node.else) lineErr(n, "Case label after 'else:'");
        const br = { labels: node.labels, body: [], line: n, error: node.error };
        f.node.branches.push(br);
        f.body = br.body;
        break;
      }
      case 'case-head': open('case', { k: 'case', expr: node.expr, branches: [], else: null, error: node.error }, null); break;
      case 'for-head': { const s = { k: 'for', name: node.name, nameSpan: node.nameSpan, from: node.from, to: node.to, body: [], error: node.error }; open('for', s, s.body); break; }
      case 'while-head': { const s = { k: 'while', cond: node.cond, body: [], error: node.error }; open('while', s, s.body); break; }
      case 'repeat-head': { const s = { k: 'repeat', body: [], cond: null, untilLine: -1, error: node.error }; open('repeat', s, s.body); break; }
      case 'until': {
        const f = close('repeat', 'until');
        if (f) { f.node.cond = node.cond; f.node.untilLine = n; if (node.error) f.node.error = node.error; }
        break;
      }
      case 'end': close(node.what, node.word); break;
      default: append(node);
    }
  }

  // --- the lines ---
  for (let n = 0; n < rawLines.length; n++) {
    if (consumed.has(n)) continue;
    const code = lines[n].filter(t => t.kind !== 'comment');
    if (!code.length) continue;
    const kw = code[0].kind === 'keyword' ? code[0].text : null;
    const u = top();
    if (kw && UNIT_OPEN.includes(kw)) {
      if (kw !== 'program' && u && u.phase === 'kamus') { u.prototypes.push(n); continue; } // prototype style: accepted, unused
      openUnit(kw, n, code);
      continue;
    }
    if (kw && UNIT_CLOSE.includes(kw)) { closeUnit(n, code); continue; }
    if (!u) { lineErr(n, 'Statement outside any program/function/procedure'); continue; }
    if (kw === 'kamus' || kw === 'dictionary') { marker(u, n, code, 'kamus'); continue; }
    if (kw === 'algoritma' || kw === 'algorithm') { marker(u, n, code, 'algoritma'); continue; }
    if (u.phase === 'kamus') declLine(u, n, code);
    else if (u.phase === 'algo') stmtLine(u, n, code);
    else if (declShape(code) || kw === 'constant' || kw === 'type') { lineErr(n, "Declaration outside kamus — add 'kamus' above it"); declLine(u, n, code); }
    else { lineErr(n, 'Executable statement outside algoritma — add kamus/algoritma markers'); stmtLine(u, n, code); }
  }
  while (stack.length) {
    const u = stack.pop();
    lineErr(u.startLine, `Unclosed '${u.kind} ${u.name}'`);
    drainFrames(u, null);
    u.endLine = rawLines.length - 1;
  }
  for (const toks of lines) for (const t of toks) {
    if (t.badCase && !t.asName) tokErr(t, `Keywords are lowercase — write '${t.text}', not '${t.badCase}'`);
  }
  for (const u of units) { delete u.frames; delete u.phase; }
  return { units, diags, lines, rawLines };
}

/** Parse a token slice as one expression; null when it is not one. Used by completion. */
function parseExprTokens(toks) {
  try {
    const P = { toks, i: 0 };
    const e = expr(P);
    return peek(P) ? null : e;
  } catch (e) {
    if (e instanceof SyntaxErr) return null;
    throw e;
  }
}

module.exports = { parse, parseExprTokens, err, warn, info, tokLen };
