import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const { analyze } = require('./lang/analyzer.js');

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.error('FAIL:', msg); } else console.log('ok:', msg); };
const load = (p) => readFileSync(join(root, p), 'utf8');
const msgs = (ds) => ds.map(d => d.msg);

// good files: zero errors (warnings/info allowed only for unused)
for (const f of ['samples/hello.pseudo', 'samples/all-constructs.pseudo', 'samples/linkedlist.pseudo']) {
  const ds = analyze(load(f));
  const errs = ds.filter(d => d.sev === 0);
  ok(errs.length === 0, `${f} zero errors (got: ${JSON.stringify(errs.map(e => `L${e.line + 1}:${e.msg}`))})`);
}

// bad file: exact expected errors
const bad = analyze(load('samples/bad.pseudo'));
const bmsgs = msgs(bad);
for (const want of [
  'Duplicate declaration',
  'Undeclared identifier',
  'Mixed-type output',
  "Uses '<-'",
  'array[0..MAX]',
  "'for ... to n'",
  "Unclosed 'if'",
]) ok(bmsgs.some(m => m.includes(want)), `bad.pseudo flags: ${want}`);
ok(!bmsgs.some(m => m.includes('fallback')), 'parser did not fall back');

// edge: unclosed string + stray brace + stray closer
const edge = analyze(['program e', 'kamus', '  x : integer', 'algoritma', '  s = "oops', '  }', '  endif', 'endprogram'].join('\n'));
const emsgs = msgs(edge);
ok(emsgs.some(m => m.includes('Unclosed string')), 'flags unclosed string');
ok(emsgs.some(m => m.includes('Stray')), 'flags stray }/endif');

// else-if conditions are checked like any other expression
const elseIf = (cond) => analyze(['program e', 'kamus', '  x : integer', 'algoritma', '  x = 1', '  if x > 0 then', '    output(x)', `  else if ${cond} then`, '    output(x)', '  endif', 'endprogram'].join('\n'));
{
  const hit = elseIf('zz > 0').find(d => d.msg === "Undeclared identifier 'zz'");
  ok(hit && hit.line === 7 && hit.sev === 0, 'flags undeclared name in else-if');
  ok(elseIf('x > 0').length === 0, 'valid else-if stays clean');
}

// the real '<-' assignment and real mixed-type output are still errors
{
  const one = (kamus, line) => msgs(analyze(['program e', 'kamus', kamus, 'algoritma', line, 'endprogram'].join('\n')));
  ok(one('  z : integer', '  z <- 3').some(m => m.includes("Uses '<-'")), "flags 'z <- 3'");
  ok(one('  type A : pointer to E\n  type E : <\n    info : integer\n  >\n  p : A', '  p->info <- 3').some(m => m.includes("Uses '<-'")), "flags 'p->info <- 3'");
  ok(one('  arr : array[0..2] of integer', '  arr[1] <- 3').some(m => m.includes("Uses '<-'")), "flags 'arr[1] <- 3'");
  ok(one('  x : integer', '  output("Nilai: " + x)').some(m => m.includes('Mixed-type output')), 'flags "label" + integer');
  ok(one('  c : char', '  output("Huruf: " + c)').some(m => m.includes('Mixed-type output')), 'flags "label" + char');
  ok(!one('  s : string', '  output("Halo " + s)').some(m => m.includes('Mixed-type output')), 'string + string is not mixed');
}
// dictionary/algorithm are kamus/algoritma, blank-line rule included
{
  const ds = msgs(analyze('program t\ndictionary\n  x : integer\n\nalgorithm\n  x = 1\nendprogram'));
  ok(ds.some(m => m.includes("Blank line before 'algorithm'")), 'blank line before algorithm flagged');
  ok(!ds.some(m => m.includes('Nested unit') || m.includes('needs a name')), 'dictionary is not a program header');
}

// subprogram headers: allowed as prototypes in kamus, still an error in algoritma
{
  const inAlgo = msgs(analyze('program t\nkamus\n  x : integer\nalgoritma\n  x = 1\n  function f() -> integer\nendprogram'));
  ok(inAlgo.some(m => m.includes('must be declared outside')), 'function header in algoritma is an error');
  const proto = analyze('program t\nkamus\n  x : integer\n  function f(a: integer) -> integer\n  procedure p(in a: integer)\nalgoritma\n  x = 1\n  output(x)\nendprogram');
  ok(proto.filter(d => d.sev === 0).length === 0, 'prototypes in kamus give no errors');
}

// statement + expression syntax is checked before Run
{
  const K = ['  x, y, i : integer', '  b : boolean', '  s : string', '  arr : array[0..2] of integer'].join('\n');
  const errsOf = (body, after = '') => analyze(`program e\nkamus\n${K}\nalgoritma\n${body}\nendprogram${after}`).filter(d => d.sev === 0);
  const bad = [
    ['  if x > 0\n    y = 1\n  endif', "Missing 'then'", 8],
    ['  while x > 0\n    x = x - 1\n  endwhile', "Missing 'do'", 8],
    ['  for i = 0 to 2\n    y = i\n  endfor', "Missing 'do'", 8],
    ['  for i = 0 2 do\n    y = i\n  endfor', "Missing 'to'", 8],
    ['  case x\n    1:\n      y = 1\n  endcase', "Missing 'of'", 8],
    ['  x = (1 +', 'Incomplete expression', 8],
    ['  x = 1 +', 'Incomplete expression', 8],
    ['  x = = 3', "Unexpected '='", 8],
    ['  x = 1 2', "Unexpected '2'", 8],
    ['  x + 1', 'Not a statement', 8],
    ['  output(x', "Missing ')'", 8],
    ['  arr[1 = 2', "Missing ']'", 8],
    ['  if x > 0 then y = 1\n  endif', "Unexpected 'y'", 8],
    ['  x = 1\n  endif x', "Unexpected 'x'", 9],
    ['  input()', 'input needs at least one variable', 8],
    ['  x = 1\n  return x', "'return' is only allowed inside a function", 9],
  ];
  for (const [body, want, line] of bad) {
    const es = errsOf(body);
    const hit = es.find(d => d.msg.includes(want));
    ok(hit && hit.line + 1 === line, `syntax: ${JSON.stringify(body.trim().split('\n')[0])} -> ${want} (got ${JSON.stringify(es.map(d => `L${d.line + 1} ${d.msg}`))})`);
  }
  const proc = (body) => analyze(`program e\nkamus\n  x : integer\nalgoritma\n  x = 1\n  p()\nendprogram\n\nprocedure p()\n{ I.S. -\n  F.S. - }\nalgoritma\n${body}\nendprocedure`).filter(d => d.sev === 0).map(d => d.msg);
  ok(proc('  return 1').some(m => m.includes('Procedures do not return values')), 'syntax: procedure return with value');
  ok(proc('  return').length === 0, 'syntax: bare return in a procedure is fine');
  const fn = (body) => analyze(`program e\nkamus\n  x : integer\nalgoritma\n  x = f()\nendprogram\n\nfunction f() -> integer\nalgoritma\n${body}\nendfunction`).filter(d => d.sev === 0).map(d => d.msg);
  ok(fn('  return').some(m => m.includes('return needs a value')), 'syntax: bare return in a function');
  const good = [
    '  x = -(1 + 2) * 3 div 2 mod 5', '  b = not (x > 1) and (y <= 2 or x != 3)', '  s = "a" + "b"', '  arr[x + 1] = arr[0]',
    '  output()', '  output("n:", x, s[0], len(s))', '  input(x, y)', '  if x > 0 then { c }\n    y = 1\n  else if x < 0 then\n    y = 2\n  else\n    y = 3\n  endif',
    "  case x of\n    1, 2:\n      y = 1\n    else:\n      y = 0\n  endcase", '  for i = 0 to x - 1 do\n    y = y + i\n  endfor', '  repeat\n    x = x + 1\n  until x >= 3 or b',
  ];
  for (const body of good) ok(errsOf(body).length === 0, `syntax ok: ${JSON.stringify(body.trim().split('\n')[0])} (got ${JSON.stringify(errsOf(body).map(d => d.msg))})`);
  const ptr = analyze('program e\nkamus\n  type A : pointer to E\n  type E : <\n    info : integer,\n    next : A\n  >\n  p : A\n  a : integer\n  q : pointer to integer\nalgoritma\n  allocate(p)\n  (p->info) = 1\n  p->next = NIL\n  q = &a\n  *q = 2\n  a = *q + (p->info)\n  deallocate(p)\nendprogram').filter(d => d.sev === 0);
  ok(ptr.length === 0, `syntax ok: pointer forms (got ${JSON.stringify(ptr.map(d => d.msg))})`);
}

// declaration checks
{
  const at = (src, want) => analyze(src).find(d => d.msg.includes(want));
  const P = (kamus, after = '') => `program t\nkamus\n${kamus}\nalgoritma\n  output(1)\nendprogram${after}`;
  let d = at(P('  x : Foo'), "Unknown type 'Foo'");
  ok(d && d.sev === 0 && d.line === 2, 'unknown type in a variable declaration');
  ok(at(P('  a : array[0..2] of Mhs'), "Unknown type 'Mhs'"), 'unknown array element type');
  ok(at(P('  p : pointer to Node'), "Unknown type 'Node'"), 'unknown pointer target');
  ok(at(P('  type M : <\n    a : Foo\n  >'), "Unknown type 'Foo'"), 'unknown struct field type');
  ok(at(P('  x : integer', '\n\nfunction f(a: Foo) -> Bar\nalgoritma\n  return 1\nendfunction'), "Unknown type 'Foo'"), 'unknown parameter type');
  ok(at(P('  x : integer', '\n\nfunction f(a: integer) -> Bar\nalgoritma\n  return 1\nendfunction'), "Unknown type 'Bar'"), 'unknown return type');
  const known = P('  type Address : pointer to ElmList\n  type ElmList : <\n    info : integer,\n    next : Address\n  >\n  type T : array[0..2] of ElmList\n  a : T\n  u : integer[0..5]\n  q : pointer to integer');
  ok(!analyze(known).some(x => x.msg.includes('Unknown type')), 'forward-declared and alias types are known');

  const two = P('  x : integer', '\n\nfunction f() -> integer\nalgoritma\n  return 1\nendfunction\n\nprocedure f()\n{ I.S. -\n  F.S. - }\nalgoritma\n  output(1)\nendprocedure');
  d = at(two, "Duplicate subprogram 'f'");
  ok(d && d.sev === 0 && d.line === 12, 'duplicate subprogram name');

  ok(at('program if\nkamus\n  x : integer\nalgoritma\n  x = 1\nendprogram', "'if' is a reserved word"), 'reserved word as program name');
  ok(at(P('  to : integer'), "'to' is a reserved word"), 'reserved word as variable name');
  ok(at(P('  type of : integer'), "'of' is a reserved word"), 'reserved word as type name');
  ok(at(P('  x : integer', '\n\nfunction do() -> integer\nalgoritma\n  return 1\nendfunction'), "'do' is a reserved word"), 'reserved word as function name');
  ok(at(P('  x : integer', '\n\nfunction f(then: integer) -> integer\nalgoritma\n  return 1\nendfunction'), "'then' is a reserved word"), 'reserved word as parameter name');

  d = at(P('  x : integer', '\n\nprocedure p(a: integer)\n{ I.S. a\n  F.S. a }\nalgoritma\n  output(a)\nendprocedure'), "Parameter 'a' needs a mode");
  ok(d && d.sev === 1, 'procedure parameter without mode warns');
  ok(!at(P('  x : integer', '\n\nfunction f(a: integer) -> integer\nalgoritma\n  return a\nendfunction'), 'needs a mode'), 'function parameters need no mode');

  d = at('program t\nkamus\n  x : integer\nalgoritma\n  x = 1\nendprogram\nfunction f() -> integer\nalgoritma\n  return 1\nendfunction', 'Missing blank line');
  ok(d && d.sev === 0 && d.line === 6, 'no blank line between units');
  ok(!at(P('  x : integer', '\n\nfunction f() -> integer\nalgoritma\n  return 1\nendfunction'), 'Missing blank line'), 'blank line between units is fine');
}

// type checking happens before Run: [kamus, statement, expected message]
{
  const LIST = '  type Address : pointer to E\n  type E : <\n    info : integer,\n    next : Address\n  >\n  p : Address\n  e : E';
  const K = '  x : integer\n  r : real\n  b : boolean\n  s : string\n  c : char\n  arr : array[0..2] of integer\n  q : pointer to integer\n' + LIST;
  const SUBS = '\n\nfunction dua(n: integer) -> integer\nalgoritma\n  return n * 2\nendfunction\n\nprocedure isi(out v: integer)\n{ I.S. -\n  F.S. v terisi }\nalgoritma\n  v = 1\nendprocedure';
  const check = (stmt) => analyze(`program t\nkamus\n${K}\nalgoritma\n  x = 1\n  r = 1.5\n  b = true\n  s = "a"\n  c = 'a'\n  arr[0] = 1\n  q = &x\n  p = NIL\n  e.info = 1\n${stmt}\nendprogram${SUBS}`).filter(d => d.sev === 0).map(d => d.msg);
  const wrong = [
    ['  x = "satu"', "Type mismatch in assignment to 'x' (expected integer, got string)"],
    ['  x = r', 'expected integer, got real'],
    ['  b = x', 'expected boolean, got integer'],
    ['  arr[0] = c', "assignment to 'arr[0]'"],
    ['  e.info = s', "assignment to 'e.info'"],
    ['  q = x', "use '&' for an address"],
    ['  x = q', "use '*' to read the value"],
    ['  x = x / 2', "'integer / integer' not allowed"],
    ['  x = s - 1', "cannot '-' string and integer"],
    ['  b = s < s', "cannot '<' string and string"],
    ['  b = x == s', "cannot '==' integer and string"],
    ['  b = not x', "'not' needs a boolean"],
    ['  x = -s', 'cannot negate string'],
    ['  if x then\n  endif', 'Non-boolean condition'],
    ['  repeat\n  until x + 1', 'Non-boolean condition'],
    ['  for x = 1 to r do\n  endfor', 'for bounds must be integers'],
    ['  for r = 1 to 2 do\n  endfor', "Loop variable 'r' must be an integer"],
    ['  x = dua()', "Wrong argument count for 'dua' (expected 1, got 0)"],
    ['  x = dua(s)', "Type mismatch in argument 'dua.n'"],
    ['  x = isi(x)', "'isi' is a procedure"],
    ['  isi(3)', 'Not a variable'],
    ['  isi(r)', "Type mismatch in argument 'isi.v'"],
    ['  x = dua', "'dua' is a function — call it with ( )"],
    ['  x = x(1)', "'x' is a variable, not a function or procedure"],
    ['  x = p.info', "'.' does not work on a pointer — use '->info'"],
    ['  x = e->info', "'->' needs a pointer, but this is a E — use '.info'"],
    ['  x = e.umur', "Unknown field 'umur' in E"],
    ['  x = x[0]', 'Cannot index non-array'],
    ['  x = arr[r]', 'Array index must be integer'],
    ['  x = *x', "'*' needs a pointer"],
    ['  x = len(x)', 'len expects string, got integer'],
    ['  allocate(x)', "allocate expects a pointer variable 'x'"],
    ['  input(arr)', "Cannot input into 'arr'"],
    ['  output(e)', 'Cannot output compound value'],
    ['  case x of\n    "a":\n      output(1)\n  endcase', 'Case label is string, but the case value is integer'],
    ['  x = 2 ^ 3', "There is no '^' operator"],
  ];
  for (const [stmt, want] of wrong) {
    const got = check(stmt);
    ok(got.length === 1 && got[0].includes(want), `type check: ${JSON.stringify(stmt.trim().split('\n')[0])} -> ${want} (got ${JSON.stringify(got)})`);
  }
  const fine = ['  r = x', '  s = c', '  r = x / 2.0', '  x = x div 2', '  b = c < \'z\'', '  b = p == NIL', '  x = *q + p->info + e.info + arr[x] + dua(dua(x))', '  isi(arr[1])', '  isi(e.info)', '  isi(p->info)', '  *q = 3', '  p = e.next', '  input(x, r, c, b, s, arr[0], e.info)'];
  for (const stmt of fine) ok(check(stmt).length === 0, `type check ok: ${stmt.trim()} (got ${JSON.stringify(check(stmt))})`);
  const ret = (body) => analyze(`program t\nkamus\n  x : integer\nalgoritma\n  x = f()\nendprogram\n\nfunction f() -> integer\nalgoritma\n${body}\nendfunction`);
  ok(ret('  return "a"').some(d => d.sev === 0 && d.msg.includes("Type mismatch in return of 'f' (expected integer, got string)")), 'type check: return value');
  ok(ret('  output(1)').some(d => d.sev === 1 && d.msg.includes("Function 'f' never returns")), 'function without return warns');
}

// reading and assignment order
{
  const P = (body) => analyze(`program t\nkamus\n  x, y : integer\nalgoritma\n${body}\nendprogram`).map(d => d.msg);
  ok(P('  input(x)\n  y = x\n  output(y)').length === 0, 'input assigns its variables (no use-before-assign warning)');
  ok(P('  y = x\n  x = 1\n  output(y)').some(m => m === "'x' may be used before assignment"), 'reading before any assignment warns');
  ok(P('  x = 1\n  output(x)').some(m => m === "'y' declared but never used"), 'unused program variable is noted');
  const viaSub = analyze('program t\nkamus\n  g : integer\nalgoritma\n  isi()\n  output(g)\nendprogram\n\nprocedure isi()\n{ I.S. -\n  F.S. g terisi }\nalgoritma\n  g = 1\nendprocedure');
  ok(viaSub.length === 0, 'a global assigned by a subprogram is not flagged', JSON.stringify(viaSub));
}

// mistakes that used to cascade are reported once
{
  const E = (src) => analyze(src).filter(d => d.sev === 0).map(d => `L${d.line + 1} ${d.msg}`);
  const upper = E('PROGRAM t\nKAMUS\n  x : Integer\nALGORITMA\n  x = 1\n  Output(x)\nENDPROGRAM');
  ok(upper.length === 6 && upper.every(m => m.includes('Keywords are lowercase')) && upper[0] === "L1 Keywords are lowercase — write 'program', not 'PROGRAM'", 'uppercase keywords: one clear message each', JSON.stringify(upper));
  const nested = E('program t\nkamus\n  x : integer\nalgoritma\n  x = dua()\n  function dua() -> integer\n  algoritma\n    return 2\n  endfunction\n  output(x)\nendprogram');
  ok(nested.length === 1 && nested[0] === 'L6 Subprogram must be declared outside program block', 'function inside the program block: one error', JSON.stringify(nested));
  const inKamus = E('program t\nkamus\n  x : integer\n  x = 1\n  output(x)\nendprogram');
  ok(inKamus.length === 2 && inKamus[0].includes('Assignment inside kamus') && inKamus[1].includes("Statement inside kamus — add 'algoritma'"), 'statements in kamus say where they belong', JSON.stringify(inKamus));
  ok(E('program t\nkamus\n  x : integer\nalgoritma\n  y : integer\n  x = 1\nendprogram').join() === 'L5 Declaration inside algoritma — move it up into kamus', 'declaration in algoritma');
  ok(E('program t\nkamus\n  type A : <\n    a : A\n  >\nalgoritma\n  output(1)\nendprogram')[0].includes("Struct 'A' contains itself"), 'struct containing itself');
  ok(E('program t\nkamus\n  type B : C\n  type C : B\nalgoritma\n  output(1)\nendprogram')[0].includes('defined in terms of itself'), 'cyclic type alias');
  ok(E('program t\nkamus\n  a : array[5..2] of integer\nalgoritma\n  output(1)\nendprogram')[0].includes('Array lower bound 5 exceeds upper bound 2'), 'inverted array bounds');
  ok(E('program t\nkamus\n  constant N : integer = 3\n  constant M : integer = N * 2\n  a : array[1..M] of integer\nalgoritma\n  a[6] = N\nendprogram').length === 0, 'constant expressions over earlier constants');
  ok(E('program a\nalgoritma\n  output(1)\nendfunction')[0].includes("'endfunction' does not match 'program a'"), 'mismatched end keyword');
}

if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nAll diagnostics checks passed.');
