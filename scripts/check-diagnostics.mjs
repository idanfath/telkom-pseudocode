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

if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nAll diagnostics checks passed.');
