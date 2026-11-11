// Static syntax for one algoritma line: statement shape + expression grammar.
// The expression grammar mirrors the runner's (interpreter.js parseOr..parsePrimary), so a
// line accepted here does not fail with a parse error at Run time.
// checkStatement(toks, ctx) -> null | {col, endCol, msg}
//   toks: the line's tokens (comments included; they are ignored)
//   ctx:  { unitKind: 'program'|'function'|'procedure', inCase: boolean }

// words the runner never reads as a variable name (interpreter.js isReservedWord)
const RESERVED = new Set([
  'program', 'kamus', 'algoritma', 'endprogram', 'function', 'endfunction', 'procedure', 'endprocedure',
  'return', 'if', 'then', 'else', 'endif', 'case', 'of', 'endcase', 'for', 'to', 'do', 'endfor', 'while',
  'endwhile', 'repeat', 'until', 'input', 'output', 'allocate', 'deallocate', 'integer', 'real', 'char',
  'boolean', 'string', 'array', 'pointer', 'type', 'constant', 'in', 'out', 'div', 'mod', 'and', 'or', 'not',
]);
const CMP = new Set(['==', '!=', '<', '>', '<=', '>=']);

class SyntaxErr { constructor(tok, msg, atEnd) { this.tok = tok; this.msg = msg; this.atEnd = atEnd; } }

function checkStatement(lineToks, ctx = {}) {
  const toks = lineToks.filter(t => t.kind !== 'comment');
  if (!toks.length) return null;
  // already reported elsewhere: tokenizer errors (unclosed string, stray '}') and the '<-' arrow
  if (toks.some(t => t.kind === 'error' || (t.kind === 'op' && t.text === '<-'))) return null;
  const P = { toks, i: 0 };
  try {
    statement(P, ctx);
    return null;
  } catch (e) {
    if (!(e instanceof SyntaxErr)) throw e;
    const last = toks[toks.length - 1];
    if (e.atEnd || !e.tok) return { col: last.col + last.text.length, endCol: last.col + last.text.length + 1, msg: e.msg };
    return { col: e.tok.col, endCol: e.tok.col + e.tok.text.length, msg: e.msg };
  }
}

// ---------- token helpers ----------
const peek = (P) => P.toks[P.i];
const next = (P) => P.toks[P.i++];
const isKw = (t, w) => t && t.kind === 'keyword' && t.text === w;
const isOp = (t, o) => t && t.kind === 'op' && t.text === o;
const isSep = (t, s) => t && t.kind === 'sep' && t.text === s;
const fail = (P, msg) => { throw new SyntaxErr(peek(P), msg, !peek(P)); };
function expectKw(P, w, msg) { if (!isKw(peek(P), w)) fail(P, msg); next(P); }
function expectOp(P, o, msg) { if (!isOp(peek(P), o)) fail(P, msg); next(P); }
function end(P) { const t = peek(P); if (t) throw new SyntaxErr(t, `Unexpected '${t.text}'`); }

// ---------- statements ----------
function statement(P, ctx) {
  const t = peek(P);
  const kw = t.kind === 'keyword' ? t.text : null;
  switch (kw) {
    case 'if': next(P); expr(P); expectKw(P, 'then', "Missing 'then' after the if condition"); return end(P);
    case 'else':
      next(P);
      if (isKw(peek(P), 'if')) { next(P); expr(P); expectKw(P, 'then', "Missing 'then' after the else if condition"); }
      else if (isSep(peek(P), ':')) next(P); // case else:
      return end(P);
    case 'while': next(P); expr(P); expectKw(P, 'do', "Missing 'do' after the while condition"); return end(P);
    case 'case': next(P); expr(P); expectKw(P, 'of', "Missing 'of' after the case expression"); return end(P);
    case 'until': next(P); expr(P); return end(P);
    case 'for': {
      next(P);
      const v = peek(P);
      if (!v || v.kind !== 'ident') fail(P, 'for needs a loop variable: for i = a to b do');
      next(P);
      expectOp(P, '=', "Missing '=' after the loop variable");
      expr(P);
      expectKw(P, 'to', "Missing 'to' in for loop");
      expr(P);
      expectKw(P, 'do', "Missing 'do' after the for range");
      return end(P);
    }
    case 'repeat': case 'endif': case 'endfor': case 'endwhile': case 'endcase':
      next(P); return end(P);
    case 'return': {
      next(P);
      const hasValue = !!peek(P);
      if (ctx.unitKind === 'program') throw new SyntaxErr(t, "'return' is only allowed inside a function or procedure");
      if (ctx.unitKind === 'procedure' && hasValue) throw new SyntaxErr(t, 'Procedures do not return values — use a bare return');
      if (ctx.unitKind === 'function' && !hasValue) throw new SyntaxErr(t, 'return needs a value in a function');
      if (hasValue) expr(P);
      return end(P);
    }
    case 'input': case 'output': case 'allocate': case 'deallocate': {
      next(P);
      expectOp(P, '(', `Missing '(' after ${kw}`);
      const n = args(P);
      expectOp(P, ')', "Missing ')'");
      if (kw === 'input' && n === 0) throw new SyntaxErr(t, 'input needs at least one variable');
      if ((kw === 'allocate' || kw === 'deallocate') && n !== 1) throw new SyntaxErr(t, `${kw} takes exactly one pointer`);
      return end(P);
    }
  }
  // case label line: 1:   'a', 'b':   (only directly inside a case)
  const last = P.toks[P.toks.length - 1];
  if (ctx.inCase && isSep(last, ':')) {
    expr(P);
    while (isSep(peek(P), ',')) { next(P); expr(P); }
    if (!isSep(peek(P), ':')) fail(P, "Missing ':' after case label");
    next(P);
    return end(P);
  }
  // assignment or call: target = expr | name(args)
  const shape = postfixShape(P);
  if (isOp(peek(P), '=')) { next(P); expr(P); return end(P); }
  if (shape.endsWithCall && !peek(P)) return;
  throw new SyntaxErr(P.toks[0], "Not a statement — expected an assignment 'x = ...' or a call");
}

// ---------- expressions (same precedence as the runner) ----------
function expr(P) { orExpr(P); }
function orExpr(P) { andExpr(P); while (isKw(peek(P), 'or')) { next(P); andExpr(P); } }
function andExpr(P) { notExpr(P); while (isKw(peek(P), 'and')) { next(P); notExpr(P); } }
function notExpr(P) { if (isKw(peek(P), 'not')) { next(P); return notExpr(P); } cmpExpr(P); }
function cmpExpr(P) { addExpr(P); const t = peek(P); if (t && t.kind === 'op' && CMP.has(t.text)) { next(P); addExpr(P); } }
function addExpr(P) { mulExpr(P); while (isOp(peek(P), '+') || isOp(peek(P), '-')) { next(P); mulExpr(P); } }
function mulExpr(P) {
  unary(P);
  while (isOp(peek(P), '*') || isOp(peek(P), '/') || isKw(peek(P), 'div') || isKw(peek(P), 'mod')) { next(P); unary(P); }
}
function unary(P) { if (isOp(peek(P), '-')) { next(P); return unary(P); } postfixShape(P); }
// primary followed by calls / indexes / field steps; reports whether it ended with a call
function postfixShape(P) {
  const head = primary(P);
  let endsWithCall = false;
  for (;;) {
    const t = peek(P);
    if (isOp(t, '(')) {
      if (!head.callable) fail(P, `Unexpected '('`);
      next(P); args(P); expectOp(P, ')', "Missing ')'"); endsWithCall = true; continue;
    }
    if (isOp(t, '[')) { next(P); expr(P); expectOp(P, ']', "Missing ']'"); endsWithCall = false; continue; }
    if (isOp(t, '->') || isOp(t, '.')) {
      next(P);
      const f = peek(P);
      if (!f || (f.kind !== 'ident' && f.kind !== 'keyword')) fail(P, `Missing field name after '${t.text}'`);
      next(P); endsWithCall = false; continue;
    }
    return { endsWithCall };
  }
}
function args(P) {
  if (isOp(peek(P), ')')) return 0;
  let n = 0;
  for (;;) {
    expr(P); n++;
    if (isSep(peek(P), ',')) { next(P); continue; }
    return n;
  }
}
function primary(P) {
  const t = peek(P);
  if (!t) fail(P, 'Incomplete expression');
  if (t.kind === 'number' || t.kind === 'string' || t.kind === 'char' || t.kind === 'constant') { next(P); return {}; }
  if (isOp(t, '(')) { next(P); expr(P); expectOp(P, ')', "Missing ')'"); return {}; }
  if (isOp(t, '&')) {
    next(P);
    if (!peek(P) || peek(P).kind !== 'ident') fail(P, "'&' needs a variable name");
    next(P); return {};
  }
  if (isOp(t, '*')) { next(P); postfixShape(P); return {}; }
  if (t.kind === 'ident' || (t.kind === 'keyword' && !RESERVED.has(t.text))) { next(P); return { callable: true }; }
  throw new SyntaxErr(t, `Unexpected '${t.text}'`);
}

module.exports = { checkStatement };
