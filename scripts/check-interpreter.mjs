import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const { runProgram } = require('./lang/interpreter.js');

let fails = 0;
const ok = (cond, msg, extra = '') => { if (!cond) { fails++; console.error('FAIL:', msg, extra); } else console.log('ok:', msg); };
const load = (p) => readFileSync(join(root, p), 'utf8');
const run = (f, input = '', opts = {}) => runProgram(load('samples/run/' + f), input, opts);

// exact stdout cases: [file, input, expectedLines]
const good = [
  ['run_hello.pseudo', 'Budi 7', ['Halo Dunia', 'Nama: Budi', 'n: 7']],
  ['run_arith.pseudo', '', ['3 2', '8.5', '17', 'true', 'true']],
  ['run_control.pseudo', '', ['three', 'dua-tiga', 'sum: 10', 'down: 0', 'up: 3']],
  ['run_fact.pseudo', '', ['fact: 120']],
  ['run_swap.pseudo', '', ['20 10', '21']],
  ['run_array.pseudo', '', ['sum: 20']],
  ['run_struct.pseudo', '', ['Aep 20']],
  ['run_string.pseudo', '', ['5', 'b', 'Zbcde']],
  ['run_list.pseudo', '', ['sum: 30', 'count: 2']],
  ['run_subrange.pseudo', '25', ['umur: 25', 'nilai: 35']],
];
for (const [f, input, want] of good) {
  const r = run(f, input);
  ok(!r.staticErrors, `${f} no static gate`, JSON.stringify(r.staticErrors));
  ok(!r.error, `${f} no runtime error`, JSON.stringify(r.error));
  ok(JSON.stringify(r.output) === JSON.stringify(want), `${f} stdout`, `got ${JSON.stringify(r.output)} want ${JSON.stringify(want)}`);
}
const leak = run('run_leak.pseudo');
ok(!leak.error && leak.leaks === 1 && leak.output.some(l => l.includes('never deallocated')), 'run_leak warns', JSON.stringify(leak));

// exact error cases: [file, input, opts, line1based, msgSub]
const bad = [
  ['err_divzero.pseudo', '', {}, 5, 'Division by zero'],
  ['err_nilderef.pseudo', '', {}, 10, 'NIL pointer dereference'],
  ['err_useafterfree.pseudo', '', {}, 14, 'Use after free'],
  ['err_uninit.pseudo', '', {}, 5, "Uninitialized variable 'x'"],
  ['err_noinput.pseudo', '5', {}, 5, 'Not enough input values'],
  ['err_noreturn.pseudo', '', {}, 5, 'finished without return'],
  ['err_infinite.pseudo', '', { maxSteps: 5000 }, 7, 'Execution limit exceeded'],
  ['err_oob.pseudo', '', {}, 5, 'out of bounds [0..2]'],
  ['err_subrange.pseudo', '', {}, 5, 'out of subrange [0..100]'],
];
// type and arity mistakes are caught by the checker before Run (squiggle in the editor);
// the runner still refuses them when the gate is bypassed: [file, line1based, msgSub]
const caught = [
  ['err_typemismatch.pseudo', 7, "cannot '+'"],
  ['err_arity.pseudo', 5, 'Wrong argument count'],
  ['err_paramtype.pseudo', 5, 'Type mismatch'],
];
for (const [f, ln, sub] of caught) {
  const r = run(f);
  ok(!!r.staticErrors && r.staticErrors.some(d => d.line + 1 === ln && d.msg.includes(sub)), `${f} refused by static gate`, JSON.stringify(r.staticErrors));
  const raw = run(f, '', { ignoreStatic: true });
  ok(!!raw.error && raw.error.line + 1 === ln && raw.error.msg.includes(sub), `${f} runner refuses it too`, JSON.stringify(raw.error));
}
// err_loopvar + err_wrongtype are caught by the static gate first (squiggle in editor)
// (runtime path unreachable via run gate; static assertions below cover them)
{
  const r = runProgram(load('samples/run/err_loopvar.pseudo'), '', {});
  ok(!!r.staticErrors && r.staticErrors.some(d => d.msg.includes("Undeclared loop variable 'i'")), 'err_loopvar refused by static gate');
}
{
  const r = runProgram(load('samples/run/err_wrongtype.pseudo'), '', {});
  ok(!!r.staticErrors && r.staticErrors.some(d => d.msg.includes('Type mismatch')), 'err_wrongtype refused by static gate');
}
// err_constassign is caught by the static gate (const-assign is a static error) — asserted separately
for (const [f, input, opts, ln, sub] of bad) {
  const r = run(f, input, opts);
  ok(!r.staticErrors, `${f} passes static gate`, JSON.stringify(r.staticErrors));
  ok(!!r.error, `${f} errors`, 'expected runtime error');
  if (r.error) {
    ok(r.error.line + 1 === ln, `${f} line ${r.error.line + 1}==${ln}`, r.error.msg);
    ok(r.error.msg.includes(sub), `${f} msg has '${sub}'`, r.error.msg);
  }
}
// static gate: bad.pseudo refuses
{
  const r = runProgram(load('samples/bad.pseudo'), '', {});
  ok(!!r.staticErrors && r.staticErrors.length > 0, 'bad.pseudo refused by static gate');
}
// edge probes (in/out, &addr, chains, errors, empty output, double free, char case, else-if, nested calls)
const edge = [
  ['edge-outparam', ['program t', 'kamus', '  x : integer', 'algoritma', '  fill(x)', '  output(x)', 'endprogram', '', 'procedure fill(out v: integer)', '{ I.S. -', '  F.S. v diisi }', 'algoritma', '  v = 99', 'endprocedure'].join('\n'), '', ['99']],
  ['edge-addr', ['program t', 'kamus', '  x : integer', '  p : pointer to integer', 'algoritma', '  x = 7', '  p = &x', '  output(*p)', '  *p = 9', '  output(x)', 'endprogram'].join('\n'), '', ['7', '9']],
  ['edge-parenchain', ['program t', 'kamus', '  type A : pointer to E', '  type E <', '    v : integer,', '    n : A', '  >', '  p : A', 'algoritma', '  allocate(p)', '  p->v = 3', '  p->n = NIL', '  output((p->n) == NIL)', '  deallocate(p)', 'endprogram'].join('\n'), '', ['true']],
  ['edge-empty-output', ['program t', 'kamus', '  x : integer', 'algoritma', '  x = 1', '  output()', '  output(x)', 'endprogram'].join('\n'), '', ['', '1']],
  ['edge-case-char', ['program t', 'kamus', '  c : char', 'algoritma', "  c = 'b'", '  case c of', "    'a':", '      output(1)', "    'b':", '      output(2)', '    else:', '      output(3)', '  endcase', 'endprogram'].join('\n'), '', ['2']],
  ['edge-elseif', ['program t', 'kamus', '  x : integer', 'algoritma', '  x = 2', '  if x == 1 then', '    output(1)', '  else if x == 2 then', '    output(2)', '  else', '    output(3)', '  endif', 'endprogram'].join('\n'), '', ['2']],
  ['edge-nested', ['program t', 'kamus', '  x : integer', 'algoritma', '  x = add(add(1,2), add(3,4))', '  output(x)', 'endprogram', '', 'function add(a, b: integer) -> integer', 'algoritma', '  return a + b', 'endfunction'].join('\n'), '', ['10']],
];
for (const [name, src, input, want] of edge) {
  const r = runProgram(src, input, { ignoreStatic: true });
  ok(!r.error && JSON.stringify(r.output) === JSON.stringify(want), name, `got ${JSON.stringify(r.output)} err ${JSON.stringify(r.error)}`);
}
const edgeErr = [
  ['edge-str-add', ['program t', 'kamus', '  s : string', 'algoritma', '  s = "a" + 1', '  output(s)', 'endprogram'].join('\n'), 5, 'cannot'],
  ['edge-doublefree', ['program t', 'kamus', '  type A : pointer to E', '  type E <', '    v : integer', '  >', '  p : A', 'algoritma', '  allocate(p)', '  deallocate(p)', '  deallocate(p)', 'endprogram'].join('\n'), 11, 'Double free'],
];
for (const [name, src, ln, sub] of edgeErr) {
  const r = runProgram(src, '', { ignoreStatic: true });
  ok(!!r.error && r.error.line + 1 === ln && r.error.msg.includes(sub), name, JSON.stringify(r.error));
}
// static gate: const reassignment is a static error, never reaches runtime
{
  const r = runProgram(load('samples/run/err_constassign.pseudo'), '', {});
  ok(!!r.staticErrors && r.staticErrors.some(d => d.msg.includes("Cannot assign to constant 'MAX'")), 'err_constassign refused by static gate');
}

// behaviour specs: full static gate + run, exact output
const prog = (kamus, algo, after = '') => `program t\nkamus\n${kamus.replace(/\n$/, '')}\nalgoritma\n${algo}\nendprogram${after ? '\n\n' + after : ''}`;
const spec = (name, src, want, input = '') => {
  const r = runProgram(src, input);
  ok(!r.staticErrors && !r.error && JSON.stringify(r.output) === JSON.stringify(want), name,
    `got ${JSON.stringify(r.output)} err ${JSON.stringify(r.error)} static ${JSON.stringify(r.staticErrors)}`);
};
const specErr = (name, src, ln, sub) => {
  const r = runProgram(src);
  ok(!r.staticErrors && !!r.error && r.error.line + 1 === ln && r.error.msg.includes(sub), name,
    `err ${JSON.stringify(r.error)} static ${JSON.stringify(r.staticErrors)}`);
};

// a mistake the checker reports before Run, and the runner refuses when the gate is bypassed
const specBoth = (name, src, ln, sub) => {
  const r = runProgram(src);
  ok(!!r.staticErrors && r.staticErrors.some(d => d.line + 1 === ln && d.msg.includes(sub)), name + ' (checker)', `static ${JSON.stringify(r.staticErrors)} err ${JSON.stringify(r.error)}`);
  const raw = runProgram(src, '', { ignoreStatic: true });
  ok(!!raw.error && raw.error.line + 1 === ln && raw.error.msg.includes(sub), name + ' (runner)', `err ${JSON.stringify(raw.error)}`);
};

// else belongs to the if whose block it closes, not to an inner if already ended by endif
{
  const nested = (a, b) => prog('  a, b : boolean', `  a = ${a}\n  b = ${b}\n  if a then\n    if b then\n      output("inner")\n    endif\n  else\n    output("outer-else")\n  endif\n  output("end")`);
  spec('nested-if: outer false runs outer else', nested(false, true), ['outer-else', 'end']);
  spec('nested-if: inner false skips outer else', nested(true, false), ['end']);
  spec('nested-if: both true runs inner', nested(true, true), ['inner', 'end']);
  spec('if inside case: case else still reached', prog('  x : integer', '  x = 9\n  case x of\n    1:\n      if x > 0 then\n        output("pos")\n      endif\n    else:\n      output("other")\n  endcase'), ['other']);
  spec('if inside case: if does not swallow case else', prog('  x : integer', '  x = 1\n  case x of\n    1:\n      if x > 0 then\n        output("pos")\n      endif\n    else:\n      output("other")\n  endcase'), ['pos']);
  spec('else-if chain after nested if', prog('  x : integer', '  x = 2\n  if x == 1 then\n    if x > 0 then\n      output("a")\n    endif\n  else if x == 2 then\n    if x > 5 then\n      output("b")\n    endif\n    output("c")\n  else\n    output("d")\n  endif'), ['c']);
}

// and/or short-circuit: the skipped operand is neither evaluated nor run
{
  const LIST = '  type Address : pointer to E\n  type E : <\n    info : integer,\n    next : Address\n  >\n  p : Address\n  v : integer';
  spec('short-circuit: skill search reaches end of list', prog(LIST, '  p = NIL\n  v = 1\n  while p != NIL and p->info != v do\n    p = p->next\n  endwhile\n  output(p == NIL)'), ['true']);
  spec('short-circuit: or skips NIL deref', prog(LIST, '  p = NIL\n  if p == NIL or p->info == 1 then\n    output("hit")\n  endif'), ['hit']);
  const SIDE = 'function f() -> boolean\nalgoritma\n  output("SIDE")\n  return true\nendfunction';
  spec('short-circuit: false and f() does not call f', prog('  x : boolean', '  x = false and f()\n  output(x)', SIDE), ['false']);
  spec('short-circuit: true or f() does not call f', prog('  x : boolean', '  x = true or f()\n  output(x)', SIDE), ['true']);
  spec('short-circuit: evaluated when needed', prog('  x : boolean', '  x = true and f()\n  output(x)', SIDE), ['SIDE', 'true']);
  spec('short-circuit: and binds tighter than or', prog('  x : boolean', '  x = false and false or true\n  output(x)'), ['true']);
  spec('short-circuit: or skips a whole and-chain', prog('  x : boolean', '  x = true or f() and f()\n  output(x)', SIDE), ['true']);
  spec('short-circuit: stops at closing paren', prog('  x : boolean', '  x = (true or f()) and false\n  output(x)', SIDE), ['false']);
  spec('short-circuit: skips nested parens and calls', prog('  x : boolean', '  x = false and (f() or g(1, 2))\n  output(x)', SIDE + '\n\nfunction g(a, b: integer) -> boolean\nalgoritma\n  return true\nendfunction'), ['false']);
  spec('short-circuit: stops at argument comma', prog('  x : integer', '  x = g(false and f(), 7)\n  output(x)', SIDE + '\n\nfunction g(a: boolean, b: integer) -> integer\nalgoritma\n  return b\nendfunction'), ['7']);
  specBoth('short-circuit: non-boolean left still errors', prog('  x : boolean', '  x = 1 and true'), 5, 'Non-boolean');
}

// array bounds come from the program's declared constants
{
  const K2 = '  constant MAX : integer = 2\n';
  spec('array bound: MAX is the declared value', prog(K2 + '  a : array[0..MAX] of integer', '  a[2] = 7\n  output(a[2])'), ['7']);
  specErr('array bound: index past declared MAX errors', prog(K2 + '  a : array[0..MAX] of integer', '  a[3] = 7'), 6, 'out of bounds [0..2]');
  specErr('array bound: index 50 is not silently allowed', prog(K2 + '  a : array[0..MAX] of integer', '  a[50] = 7'), 6, 'out of bounds [0..2]');
  specErr('array bound: MAX-1 idiom', prog(K2 + '  a : array[0..MAX-1] of integer', '  a[2] = 7'), 6, 'out of bounds [0..1]');
  specErr('array bound: through a type alias', prog(K2 + '  type T : array[0..MAX-1] of integer\n  a : T', '  a[2] = 7'), 7, 'out of bounds [0..1]');
  specErr('array bound: arithmetic', prog(K2 + '  a : array[1..MAX*2] of integer', '  a[5] = 7'), 6, 'out of bounds [1..4]');
  specBoth('array bound: non-constant is an error at its declaration', prog('  n : integer\n  a : array[0..n] of integer', '  output(1)'), 4, "Non-constant array bound 'n'");
  specBoth('array bound: undeclared MAX has no default', prog('  a : array[0..MAX] of integer', '  output(1)'), 3, "Non-constant array bound 'MAX'");
  spec('array bound: local array uses a global constant', prog(K2 + '  x : integer', '  x = f()\n  output(x)', 'function f() -> integer\nkamus\n  a : array[0..MAX-1] of integer\nalgoritma\n  a[1] = 9\n  return a[1]\nendfunction'), ['9']);
  spec('array bound: constant local to the subprogram', prog('  x : integer', '  x = f()\n  output(x)', 'function f() -> integer\nkamus\n  constant N : integer = 3\n  a : array[0..N-1] of integer\nalgoritma\n  a[2] = 9\n  return a[2]\nendfunction'), ['9']);
}

// each name in a grouped parameter list uses the nearest mode written before it
{
  const body = '{ I.S. a\n  F.S. b }\nalgoritma\n';
  spec('param modes: in a, out b writes back b', prog('  a, b : integer', '  a = 3\n  b = 0\n  g(a, b)\n  output(a, b)', `procedure g(in a, out b: integer)\n${body}  a = 9\n  b = 7\nendprocedure`), ['3 7']);
  spec('param modes: out a, in b writes back a only', prog('  a, b : integer', '  a = 3\n  b = 0\n  g(a, b)\n  output(a, b)', `procedure g(out a, in b: integer)\n${body}  a = 7\n  b = 9\nendprocedure`), ['7 0']);
  spec('param modes: mode carries over to later names', prog('  a, b, c : integer', '  a = 1\n  b = 2\n  c = 3\n  g(a, b, c)\n  output(a, b, c)', `procedure g(in a, in/out b, c: integer)\n${body}  a = 9\n  b = 8\n  c = 7\nendprocedure`), ['1 8 7']);
  spec('param modes: skill form in B, C then in/out A', prog('  a, b, c : integer', '  a = 0\n  b = 5\n  c = 2\n  g(b, c, a)\n  output(a)', `procedure g(in B, C: integer, in/out A: integer)\n${body}  A = 10 + B - C\nendprocedure`), ['13']);
  spec('param modes: repeated in/out still swaps', prog('  a, b : integer', '  a = 1\n  b = 2\n  g(a, b)\n  output(a, b)', `procedure g(in/out a, in/out b: integer)\n${body}  a = 8\n  b = 9\nendprocedure`), ['8 9']);
}

// hex literals
{
  spec('hex: literal value', prog('  x : integer', '  x = 0xFF\n  output(x)'), ['255']);
  spec('hex: in arithmetic', prog('  x : integer', '  x = 0x10 + 1\n  output(x)'), ['17']);
  spec('hex: as a constant', prog('  constant H : integer = 0x1F\n  x : integer', '  x = H\n  output(x)'), ['31']);
  spec('hex: decimal literals unaffected', prog('  x : integer\n  r : real', '  x = 10\n  r = 2.5\n  output(x, r)'), ['10 2.5']);
}

// subprograms see the program's kamus (skill: subprogram rule 2), locals shadow it
{
  const F = (body) => `function f() -> integer\nalgoritma\n${body}\nendfunction`;
  spec('globals: function reads global var', prog('  g : integer', '  g = 5\n  output(f())', F('  return g')), ['5']);
  spec('globals: function reads global constant', prog('  constant G : integer = 5\n  x : integer', '  x = f()\n  output(x)', F('  return G')), ['5']);
  spec('globals: procedure writes global var', prog('  g : integer', '  g = 5\n  bump()\n  output(g)', 'procedure bump()\n{ I.S. g\n  F.S. g + 1 }\nalgoritma\n  g = g + 1\nendprocedure'), ['6']);
  spec('globals: local shadows global', prog('  g : integer', '  g = 5\n  output(f(), g)', 'function f() -> integer\nkamus\n  g : integer\nalgoritma\n  g = 1\n  return g\nendfunction'), ['1 5']);
  spec('globals: subprogram written above program', F('  return g') + '\n\n' + prog('  g : integer', '  g = 5\n  output(f())'), ['5']);
}

// arrays as parameters (skill: subprogram rule 4) — copied for in, shared for in/out
{
  const A = '  type myArr : array[0..1] of integer\n  arr : myArr\n';
  const IS = '{ I.S. a\n  F.S. a }\n';
  spec('array param: function reads alias-typed array', prog(A, '  arr[0] = 1\n  arr[1] = 2\n  output(sum(arr))', 'function sum(a: myArr) -> integer\nalgoritma\n  return a[0] + a[1]\nendfunction'), ['3']);
  spec('array param: in-mode is a copy', prog(A, '  arr[0] = 1\n  arr[1] = 2\n  set(arr)\n  output(arr[0])', `procedure set(in a: myArr)\n${IS}algoritma\n  a[0] = 99\nendprocedure`), ['1']);
  spec('array param: in/out writes back', prog(A, '  arr[0] = 1\n  arr[1] = 2\n  set(arr)\n  output(arr[0])', `procedure set(in/out a: myArr)\n${IS}algoritma\n  a[0] = 99\nendprocedure`), ['99']);
  specBoth('array param: different bounds rejected', prog(A + '  big : array[0..2] of integer', '  big[0] = 1\n  output(sum(big))', 'function sum(a: myArr) -> integer\nalgoritma\n  return a[0]\nendfunction'), 8, 'Type mismatch');
  specBoth('array param: whole-array assignment still rejected', prog(A + '  other : myArr', '  arr[0] = 1\n  arr[1] = 2\n  other = arr'), 9, 'Cannot assign array');
}

// array elements, struct fields and pointer fields work anywhere a variable does
{
  const M = '  type M : <\n    a : integer\n  >\n  m : M\n';
  const L = '  type Address : pointer to E\n  type E : <\n    info : integer,\n    next : Address\n  >\n  p : Address\n';
  const INC = 'procedure inc(in/out x: integer)\n{ I.S. x\n  F.S. x + 1 }\nalgoritma\n  x = x + 1\nendprocedure';
  spec('input: into array elements in a loop', prog('  arr : array[0..2] of integer\n  i, s : integer', '  for i = 0 to 2 do\n    input(arr[i])\n  endfor\n  s = arr[0] + arr[1] + arr[2]\n  output(s, arr[2])'), ['6 3'], '1 2 3');
  spec('input: into struct field', prog(M, '  input(m.a)\n  output(m.a)'), ['7'], '7');
  spec('input: into pointer field', prog(L, '  allocate(p)\n  input(p->info)\n  output(p->info)\n  deallocate(p)'), ['7'], '7');
  spec('in/out: array element', prog('  arr : array[0..1] of integer', '  arr[0] = 1\n  arr[1] = 5\n  inc(arr[0])\n  output(arr[0], arr[1])', INC), ['2 5']);
  spec('in/out: struct field', prog(M, '  m.a = 1\n  inc(m.a)\n  output(m.a)', INC), ['2']);
  spec('in/out: pointer field', prog(L, '  allocate(p)\n  p->info = 1\n  inc(p->info)\n  output(p->info)\n  deallocate(p)', INC), ['2']);
  spec('in/out: swap two array elements', prog('  arr : array[0..1] of integer', '  arr[0] = 1\n  arr[1] = 2\n  swap(arr[0], arr[1])\n  output(arr[0], arr[1])', 'procedure swap(in/out a, b: integer)\n{ I.S. a, b\n  F.S. ditukar }\nkamus\n  t : integer\nalgoritma\n  t = a\n  a = b\n  b = t\nendprocedure'), ['2 1']);
  spec('out: into array element', prog('  arr : array[0..1] of integer', '  fill(arr[1])\n  output(arr[1])', 'procedure fill(out v: integer)\n{ I.S. -\n  F.S. v = 9 }\nalgoritma\n  v = 9\nendprocedure'), ['9']);
  specBoth('element types: struct array rejects an integer', prog(M + '  d : array[0..1] of M', '  d[0] = 5'), 9, 'Type mismatch');
  specErr('element types: subrange array enforces range', prog('  d : array[0..1] of integer[0..5]', '  d[0] = 99'), 5, 'out of subrange [0..5]');
  spec('element types: struct array field write', prog(M + '  d : array[0..1] of M', '  d[1].a = 4\n  output(d[1].a)'), ['4']);
  spec('element types: 2D array', prog('  g : array[0..1] of array[0..2] of integer', '  g[1][2] = 8\n  output(g[1][2])'), ['8']);
}

// pointer forms from the skill: parenthesised targets, allocate on fields, &a values
{
  const L = '  type Address : pointer to E\n  type E : <\n    info : integer,\n    next : Address\n  >\n  type List : <\n    first : Address\n  >\n  L : List\n  p, q : Address';
  spec('pointer: (P->info).nim = value', prog('  type I : <\n    nim : integer\n  >\n  type A : pointer to E\n  type E : <\n    info : I\n  >\n  P : A', '  allocate(P)\n  (P->info).nim = 1234\n  output((P->info).nim)\n  deallocate(P)'), ['1234']);
  spec('pointer: (p->next)->info = value', prog(L, '  allocate(p)\n  allocate(q)\n  p->next = q\n  (p->next)->info = 2\n  output(q->info)\n  deallocate(p)\n  deallocate(q)'), ['2']);
  spec('pointer: ((L.first)->next)->info = value', prog(L, '  allocate(p)\n  allocate(q)\n  L.first = p\n  p->next = q\n  ((L.first)->next)->info = 5\n  output(q->info)\n  deallocate(p)\n  deallocate(q)'), ['5']);
  spec('pointer: spaces around ->', prog(L, '  allocate(p)\n  p -> info = 3\n  output(p->info)\n  deallocate(p)'), ['3']);
  spec('pointer: allocate/deallocate a field', prog(L, '  allocate(p)\n  allocate(p->next)\n  (p->next)->info = 1\n  output((p->next)->info)\n  deallocate(p->next)\n  deallocate(p)'), ['1']);
  spec('pointer: allocate a struct field', prog(L, '  allocate(L.first)\n  (L.first)->info = 4\n  output((L.first)->info)\n  deallocate(L.first)'), ['4']);
  spec('pointer: allocate an alias-typed param', prog(L, '  p = NIL\n  m(p)\n  output("done")', 'procedure m(in a: Address)\n{ I.S. a\n  F.S. a }\nalgoritma\n  allocate(a)\n  a->info = 1\n  deallocate(a)\nendprocedure'), ['done']);
  const addr = (name, src, check) => { const r = runProgram(src); ok(!r.staticErrors && !r.error && check(r.output), name, JSON.stringify(r)); };
  const HEX = /^0x[0-9a-f]+$/;
  addr('address: output(&a) prints a hex address', prog('  a : integer', '  a = 1\n  output("Alamat:", &a)'), o => o.length === 1 && /^Alamat: 0x[0-9a-f]+$/.test(o[0]));
  addr('address: skill demo_pointer', prog('  a, b : integer\n  p1, p2 : pointer to integer', '  a = 10\n  p1 = &a\n  p2 = p1\n  *p2 = 25\n  b = *p1\n  output("Nilai a:", a)\n  output("Nilai b:", b)\n  output(&a)\n  output(p1)\n  output(*p1)'),
    o => o[0] === 'Nilai a: 25' && o[1] === 'Nilai b: 25' && HEX.test(o[2]) && o[3] === o[2] && o[4] === '25');
  addr('address: different variables, different addresses', prog('  a, b : integer', '  a = 1\n  b = 2\n  output(&a)\n  output(&b)'), o => HEX.test(o[0]) && HEX.test(o[1]) && o[0] !== o[1]);
  spec('address: &a passed to a pointer parameter', prog('  a : integer', '  a = 1\n  set(&a)\n  output(a)', 'procedure set(in p: pointer to integer)\n{ I.S. p menunjuk integer\n  F.S. nilainya 25 }\nalgoritma\n  *p = 25\nendprocedure'), ['25']);
  spec('address: &a compares equal to a pointer to a', prog('  a : integer\n  p : pointer to integer', '  p = &a\n  output(p == &a)'), ['true']);
  specBoth('address: &a into a non-pointer is a type error', prog('  a, x : integer', '  a = 1\n  x = &a'), 6, 'Type mismatch');
}

// syntax the skill allows
{
  spec('dictionary/algorithm keywords', 'program t\ndictionary\n  x : integer\nalgorithm\n  x = 1\n  output(x)\nendprogram', ['1']);
  spec('dictionary/algorithm in a function', prog('  x : integer', '  x = f()\n  output(x)', 'function f() -> integer\ndictionary\n  y : integer\nalgorithm\n  y = 4\n  return y\nendfunction'), ['4']);
  spec('nested repeat', prog('  i, j, n : integer', '  i = 0\n  n = 0\n  repeat\n    j = 0\n    repeat\n      j = j + 1\n      n = n + 1\n    until j >= 2\n    i = i + 1\n  until i >= 3\n  output(i, j, n)'), ['3 2 6']);
  spec('repeat inside while inside repeat', prog('  i, j : integer', '  i = 0\n  repeat\n    j = 0\n    while j < 2 do\n      repeat\n        j = j + 1\n      until true\n    endwhile\n    i = i + 1\n  until i >= 2\n  output(i, j)'), ['2 2']);
}

// trailing { comments } never change what a line means
{
  spec('comment: after if ... then', prog('  x : integer', '  x = 1\n  if x > 0 then { positif }\n    output("pos")\n  else if x < 0 then { negatif }\n    output("neg")\n  else { nol }\n    output("nol")\n  endif'), ['pos']);
  spec('comment: after while/for/case headers', prog('  i, s : integer', '  s = 0\n  for i = 1 to 3 do { jumlah }\n    s = s + i\n  endfor { selesai }\n  while s > 5 do { kurangi }\n    s = s - 1\n  endwhile\n  case s of { pilih }\n    5: { lima }\n      output("lima")\n    else: { lain }\n      output("lain")\n  endcase'), ['lima']);
  spec('comment: containing parens after output', prog('  x : integer', '  x = 1\n  output(x) { lihat f(x) }'), ['1']);
  spec('comment: after until', prog('  x : integer', '  x = 0\n  repeat\n    x = x + 1\n  until x >= 2 { dua kali }\n  output(x)'), ['2']);
  spec('comment: after a declaration', prog('  x : integer { penghitung }\n  constant K : integer = 3 { batas }', '  x = K\n  output(x)'), ['3']);
  spec('comment: inside a multi-line struct', prog('  type M : < { mahasiswa }\n    nama : string, { nama lengkap }\n    umur : integer { tahun }\n  >\n  m : M', '  m.nama = "Aep"\n  m.umur = 20\n  output(m.nama, m.umur)'), ['Aep 20']);
  spec('comment: braces inside strings are text', prog('  s : string', '  s = "{bukan komentar}"\n  output(s) { komentar }'), ['{bukan komentar}']);
}

// '<-' is the banned assignment arrow only where an assignment would be
{
  spec('arrow: x<-1 in a condition is less-than minus one', prog('  x : integer', '  x = 0 - 5\n  if x<-1 then\n    output("ok")\n  endif'), ['ok']);
  spec('arrow: a<-1 inside an expression', prog('  a : integer\n  b : boolean', '  a = 0 - 5\n  b = a<-1\n  output(b, a<-1)'), ['true true']);
  spec('arrow: until x<-1', prog('  x : integer', '  x = 0\n  repeat\n    x = x - 1\n  until x<-1\n  output(x)'), ['-2']);
}

// '+' between a string literal and a string variable is concatenation, not mixed output
{
  spec('concat: output("Halo " + s) with s a string', prog('  s : string', '  s = "Budi"\n  output("Halo " + s)'), ['Halo Budi']);
  spec('concat: through a string alias', prog('  type nama : string\n  s : nama', '  s = "Budi"\n  output("Halo " + s)'), ['Halo Budi']);
  spec('concat: string param in a procedure', prog('  s : string', '  s = "Budi"\n  sapa(s)', 'procedure sapa(in n: string)\n{ I.S. n\n  F.S. tercetak }\nalgoritma\n  output("Halo " + n)\nendprocedure'), ['Halo Budi']);
}

// function/procedure headers inside kamus (some course material): accepted, no effect yet
{
  const SUB = 'function delete(x: integer) -> integer\nalgoritma\n  return x - 1\nendfunction\n\nprocedure cetak(in x: integer)\n{ I.S. x\n  F.S. tercetak }\nalgoritma\n  output(x)\nendprocedure';
  spec('kamus prototype: function and procedure headers', prog('  a : integer\n  function delete(x: integer) -> integer\n  procedure cetak(in x: integer)', '  a = delete(5)\n  cetak(a)', SUB), ['4']);
  spec('kamus prototype: Slide 00 style', prog('  a : integer\n  procedure simple_calc(I:B,C:integer; O:A:integer)', '  a = 1\n  output(a)'), ['1']);
  spec('kamus prototype: inside a function kamus', prog('  a : integer', '  a = f()\n  output(a)', 'function f() -> integer\nkamus\n  function g(x: integer) -> integer\nalgoritma\n  return 2\nendfunction'), ['2']);
}

// whole structs and arrays don't compare; div and mod agree (both truncate, as in C/Go)
{
  const M = '  type M : <\n    a : integer\n  >\n  m, n : M';
  specBoth('compare: struct == struct is an error', prog(M, '  m.a = 1\n  n.a = 2\n  output(m == n)'), 10, 'compare field by field');
  specBoth('compare: array == array is an error', prog('  a, b : array[0..1] of integer', '  a[0] = 1\n  b[0] = 1\n  output(a == b)'), 7, 'compare element by element');
  spec('compare: fields still compare', prog(M, '  m.a = 1\n  n.a = 1\n  output(m.a == n.a)'), ['true']);
  spec('div/mod: signs and the identity q*d + r = n', prog('  q, r : integer', '  q = (0 - 7) div 3\n  r = (0 - 7) mod 3\n  output(q, r, q * 3 + r)\n  q = 7 div (0 - 3)\n  r = 7 mod (0 - 3)\n  output(q, r)\n  output(7 div 3, 7 mod 3)'), ['-2 -1 -7', '-2 1', '2 1']);
}
// without the static gate (ignoreStatic), malformed headers and misplaced return are clean errors
{
  const raw = (src) => runProgram(src, '', { ignoreStatic: true });
  const e1 = raw(prog('  x : integer', '  x = 0\n  while x < 1\n    x = 1\n  endwhile'));
  ok(e1.error && e1.error.line + 1 === 6 && e1.error.msg.includes("Missing 'do'"), 'raw run: while without do', JSON.stringify(e1.error));
  const e2 = raw(prog('  x : integer', '  x = 1\n  output(x)\n  return 1'));
  ok(e2.error && e2.error.line + 1 === 7 && e2.error.msg.includes("'return' is only allowed"), 'raw run: return in program', JSON.stringify(e2.error));
}

// s[i] reads a char; assigning it to a string variable makes a 1-char string (skill, unconfirmed).
// Writing s[i] = 'a' (char literal) stays a type error.
{
  spec('string index: t = s[0] with t a string', prog('  s, t : string', '  s = "abc"\n  t = s[0]\n  output(t, len(t))'), ['a 1']);
  spec('string index: c = s[1] with c a char', prog('  s : string\n  c : char', '  s = "abc"\n  c = s[1]\n  output(c)'), ['b']);
  spec('string index: char literal into a string variable', prog('  t : string', "  t = 'x'\n  output(t)"), ['x']);
  specBoth("string index: s[0] = 'Z' is still a type error", prog('  s : string', "  s = \"abc\"\n  s[0] = 'Z'"), 6, 'Type mismatch');
  spec('string index: s[0] = "Z" writes', prog('  s : string', '  s = "abc"\n  s[0] = "Z"\n  output(s)'), ['Zbc']);
}

// deep recursion: the worker runner (used by the extension) reaches the 1000-level cap;
// the in-process runner reports a clean, located error and keeps earlier output
{
  const { runInWorker } = require('./lang/run-worker.js');
  const deep = (n) => prog('  x : integer', `  output("start")\n  x = s(${n})\n  output(x)`, 'function s(n: integer) -> integer\nalgoritma\n  if n == 0 then\n    return 0\n  endif\n  return n + s(n - 1)\nendfunction');
  const w900 = await runInWorker(deep(900));
  ok(!w900.error && JSON.stringify(w900.output) === JSON.stringify(['start', '405450']), 'worker: recursion 900 deep', JSON.stringify(w900));
  const w2000 = await runInWorker(deep(2000));
  ok(w2000.error && w2000.error.msg.includes('Maximum recursion depth exceeded (1000)') && w2000.output[0] === 'start', 'worker: cap reported cleanly', JSON.stringify(w2000.error));
  const wIn = await runInWorker(prog('  n : integer', '  input(n)\n  output(n * 2)'), '21');
  ok(!wIn.error && wIn.output[0] === '42', 'worker: passes input through', JSON.stringify(wIn));
  const wStatic = await runInWorker(load('samples/bad.pseudo'));
  ok(!!wStatic.staticErrors && wStatic.staticErrors.length > 0, 'worker: static gate still applies');
  const main = runProgram(deep(5000));
  ok(main.error && /recursion too deep/i.test(main.error.msg) && main.error.line + 1 === 15 && main.output[0] === 'start', 'in-process: stack overflow is a clean error', JSON.stringify(main.error) + JSON.stringify(main.output));
}

// regressions and behaviour added with the tree-walking runner
{
  spec('for: a loop that never runs leaves its variable at the start value', prog('  i : integer', '  for i = 3 to 1 do\n    output(i)\n  endfor\n  output(i)'), ['3']);
  spec('for: the variable keeps its last value', prog('  i : integer', '  for i = 1 to 2 do\n    output(i)\n  endfor\n  output(i)'), ['1', '2', '2']);
  spec('input: a string as the last variable takes the rest of its line', prog('  n : integer\n  s : string', '  input(n, s)\n  output(s, n)'), ['Budi Santoso 7'], '7 Budi Santoso');
  spec('input: values spread over lines', prog('  a, b : integer\n  s : string', '  input(s)\n  input(a, b)\n  output(s, a + b)'), ['Budi Santoso 7'], 'Budi Santoso\n3\n4');
  spec('input: a string that is not last is one word', prog('  n : integer\n  s : string', '  input(s, n)\n  output(s, n)'), ['Budi 7'], 'Budi 7');
  spec('real: an integer stored in a real variable is a real', prog('  r : real', '  r = 1\n  output(r / 2)'), ['0.5']);
  spec('struct: assignment copies, fields included', prog('  type M : <\n    a : integer,\n    v : array[0..1] of integer\n  >\n  m, n : M', '  m.a = 1\n  m.v[0] = 5\n  n = m\n  n.a = 2\n  n.v[0] = 6\n  output(m.a, m.v[0], n.a, n.v[0])'), ['1 5 2 6']);
  spec('struct: in parameter is a copy, in/out is shared', prog('  type M : <\n    a : integer\n  >\n  m : M', '  m.a = 1\n  byValue(m)\n  output(m.a)\n  byRef(m)\n  output(m.a)', 'procedure byValue(in x: M)\n{ I.S. x\n  F.S. tidak berubah }\nalgoritma\n  x.a = 9\nendprocedure\n\nprocedure byRef(in/out x: M)\n{ I.S. x\n  F.S. x.a = 9 }\nalgoritma\n  x.a = 9\nendprocedure'), ['1', '9']);
  spec('pointer: pointer to pointer, *p2 = *p1', prog('  a, b : integer\n  p1, p2 : pointer to integer\n  pp : pointer to pointer to integer', '  a = 1\n  b = 2\n  p1 = &a\n  p2 = &b\n  *p2 = *p1\n  pp = &p1\n  output(b, p1 == p2, **pp)'), ['1 false 1']);
  spec('pointer: NIL prints as NIL', prog('  p : pointer to integer', '  p = NIL\n  output(p, p == NIL)'), ['NIL true']);
  spec('return: leaves nested loops', prog('  x : integer', '  x = cari(3)\n  output(x, cari(9))', 'function cari(v: integer) -> integer\nkamus\n  i : integer\nalgoritma\n  for i = 0 to 5 do\n    while true do\n      if i == v then\n        return i * 2\n      endif\n      i = i + 0\n      if true then\n        x = 0\n      endif\n      return 0 - 1\n    endwhile\n  endfor\n  return 0 - 2\nendfunction'), ['-1 -1']);
  specErr('out parameter starts unassigned', prog('  x : integer', '  x = 1\n  f(x)', 'procedure f(out v: integer)\n{ I.S. -\n  F.S. v }\nalgoritma\n  output(v)\n  v = 1\nendprocedure'), 13, "Uninitialized variable 'v'");
  specErr('deallocate of a pointer to a variable', prog('  a : integer\n  p : pointer to integer', '  a = 1\n  p = &a\n  deallocate(p)'), 8, 'points to a variable');
  specErr('uninitialized array element', prog('  a : array[0..1] of integer\n  x : integer', '  a[0] = 1\n  x = a[1]'), 7, 'Uninitialized array element [1]');
  specErr('uninitialized field', prog('  type M : <\n    a : integer,\n    b : integer\n  >\n  m : M\n  x : integer', '  m.a = 1\n  x = m.b'), 11, "Uninitialized variable 'b'");
  const typed = runProgram(prog('  n : integer', '  input(n)'), 'Budi');
  ok(typed.error && typed.error.line + 1 === 5 && typed.error.msg === "Invalid input 'Budi' for integer 'n'", 'invalid input for an integer', JSON.stringify(typed.error));
}

// live output and on-demand input (what the terminal uses)
{
  const { startRun } = require('./lang/run-worker.js');
  const events = [];
  const answers = ['Budi Santoso', '20'];
  const result = await new Promise((resolve) => {
    const run = startRun(prog('  s : string\n  n : integer', '  output("Nama?")\n  input(s)\n  output("Umur?")\n  input(n)\n  output("Halo", s, n + 1)'), {
      onOutput: (l) => events.push('out ' + l),
      onNeedInput: () => { events.push('need'); setTimeout(() => run.sendLine(answers.shift()), 5); },
      onDone: resolve,
    });
  });
  ok(JSON.stringify(events) === JSON.stringify(['out Nama?', 'need', 'out Umur?', 'need', 'out Halo Budi Santoso 21']) && !result.error, 'interactive: output and input interleave in program order', JSON.stringify(events));
  const killed = await new Promise((resolve) => {
    const run = startRun(prog('  n : integer', '  n = 0\n  while true do\n    n = n + 0\n  endwhile'), { onOutput() {}, onNeedInput() {}, onDone: resolve }, { maxSteps: 1e12 });
    setTimeout(() => run.kill(), 50);
  });
  ok(killed === null, 'interactive: an endless program can be killed');
}

if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nAll interpreter checks passed.');
