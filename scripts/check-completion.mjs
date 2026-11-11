import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const { getCompletions } = require('./parser/completion.js');

let fails = 0;
const labels = (items) => items.map(i => i.label).sort();
const ok = (cond, msg, extra = '') => { if (!cond) { fails++; console.error('FAIL:', msg, extra); } else console.log('ok:', msg); };
const has = (items, ...ls) => ls.every(l => labels(items).includes(l));
const lacks = (items, ...ls) => ls.every(l => !labels(items).includes(l));

// 1. top of empty file
{
  const items = getCompletions('', 0, 0);
  ok(has(items, 'program', 'function', 'procedure'), 'top-of-empty', labels(items).join(','));
}
// 2. header context: only kamus
{
  const src = 'program t\n  \nkamus\n  x : integer\nalgoritma\n  output(x)\nendprogram';
  const items = getCompletions(src, 1, 2);
  ok(labels(items).join(',') === 'kamus', 'header-only-kamus', labels(items).join(','));
}
// 3. decl context: types, no builtins
{
  const src = 'program t\nkamus\n  type Mahasiswa : <\n    nama : string,\n    umur : integer\n  >\n  umur : \n  m : Mahasiswa\nalgoritma\nendprogram';
  const items = getCompletions(src, 6, 10);
  ok(has(items, 'integer', 'Mahasiswa', 'array', 'pointer'), 'decl-types', labels(items).join(','));
  ok(lacks(items, 'output', 'umur'), 'decl-no-builtins-or-vars', labels(items).join(','));
}
// 4. body partial prefix 'out' -> output + user var outlier
{
  const src = 'program t\nkamus\n  outlier : integer\n  x : integer\nalgoritma\n  out\nendprogram';
  const items = getCompletions(src, 5, 5);
  ok(has(items, 'output', 'outlier'), 'body-prefix-out', labels(items).join(','));
  ok(lacks(items, 'input'), 'body-prefix-filters', labels(items).join(','));
}
// 5. declared function with detail + snippet
{
  const src = 'program t\nkamus\n  x : integer\nalgoritma\n  fa\nendprogram\n\nfunction fact(n: integer) -> integer\nalgoritma\n  return 1\nendfunction';
  const items = getCompletions(src, 4, 4);
  ok(has(items, 'fact'), 'body-has-fact', labels(items).join(','));
  const f = items.find(i => i.label === 'fact');
  ok(f.kind === 'func' && f.detail.includes('-> integer'), 'fact-detail', JSON.stringify(f));
  ok(f.isSnippet && f.insert.includes('${1:'), 'fact-snippet', f.insert);
}
// 6. struct field via .
{
  const src = 'program t\nkamus\n  type Mahasiswa : <\n    nama : string,\n    umur : integer\n  >\n  m : Mahasiswa\nalgoritma\n  m.\nendprogram';
  const items = getCompletions(src, 8, 4);
  ok(has(items, 'nama', 'umur'), 'field-dot', labels(items).join(','));
  ok(items.every(i => i.kind === 'field'), 'field-kind', JSON.stringify(items.map(i => i.kind)));
}
// 7. pointer field via ->
{
  const src = 'program t\nkamus\n  type Address : pointer to ElmList\n  type ElmList : <\n    info : integer,\n    next : Address\n  >\n  p : Address\nalgoritma\n  p->\nendprogram';
  const items = getCompletions(src, 9, 5);
  ok(has(items, 'info', 'next'), 'field-arrow', labels(items).join(','));
}
// 8. in-comment position -> []
{
  const src = 'program t\nkamus\n  x : integer\nalgoritma\n  { hello wo\nendprogram';
  const items = getCompletions(src, 4, 8);
  ok(items.length === 0, 'comment-suppressed', JSON.stringify(items));
}
// 9. in-string position -> []
{
  const src = 'program t\nkamus\n  x : integer\nalgoritma\n  output(\"he\nendprogram';
  const items = getCompletions(src, 4, 12);
  ok(items.length === 0, 'string-suppressed', JSON.stringify(items));
}
// 10. broken unclosed file still yields body vars
{
  const src = 'program t\nkamus\n  total : integer\nalgoritma\n  tot';
  const items = getCompletions(src, 4, 5);
  ok(has(items, 'total'), 'unclosed-body', labels(items).join(','));
}
// 11. globals visible in subprogram + own params
{
  const src = 'program t\nkamus\n  g : integer\nalgoritma\n  output(g)\nendprogram\n\nprocedure fill(out v: integer)\nalgoritma\n  \nendprocedure';
  const items = getCompletions(src, 9, 2);
  ok(has(items, 'g', 'v'), 'subprogram-scope', labels(items).join(','));
}
// 12. loop var
{
  const src = 'program t\nkamus\n  s : integer\nalgoritma\n  for i = 0 to 4 do\n    s = s + i\n  endfor\n  s = \nendprogram';
  const items = getCompletions(src, 7, 6);
  ok(has(items, 'i', 's'), 'loop-var', labels(items).join(','));
}
// 13-19. field completion follows the whole access chain
{
  const K = 'program t\nkamus\n  type A : pointer to E\n  type E : <\n    info : integer,\n    next : A\n  >\n  type M : <\n    a : integer,\n    p : A\n  >\n  type List : <\n    first : A\n  >\n  p : A\n  L : List\n  d : array[0..1] of M\n  g : array[0..1] of array[0..1] of M\nalgoritma\n';
  const at = (expr) => { const src = K + '  ' + expr + '\nendprogram'; return getCompletions(src, src.split('\n').length - 2, expr.length + 2); };
  const fields = (expr) => labels(at(expr)).join(',');
  ok(fields('p->next->') === 'info,next', 'chain: p->next->', fields('p->next->'));
  ok(fields('(p->next)->') === 'info,next', 'chain: (p->next)->', fields('(p->next)->'));
  ok(fields('L.first->') === 'info,next', 'chain: L.first->', fields('L.first->'));
  ok(fields('((L.first)->next)->') === 'info,next', 'chain: ((L.first)->next)->', fields('((L.first)->next)->'));
  ok(fields('d[0].') === 'a,p', 'chain: d[0].', fields('d[0].'));
  ok(fields('d[i + 1].p->') === 'info,next', 'chain: d[i + 1].p->', fields('d[i + 1].p->'));
  ok(fields('g[0][1].') === 'a,p', 'chain: g[0][1].', fields('g[0][1].'));
  ok(fields('output(p->next->in') === 'info', 'chain: inside a call, with prefix', fields('output(p->next->in'));
  ok(fields('if p != NIL and p->') === 'info,next', 'chain: after other words', fields('if p != NIL and p->'));
  ok(fields('p.') === '', 'chain: . on a pointer offers nothing', fields('p.'));
}
// 20. recursion: a function can call itself
{
  const src = 'program t\nkamus\n  x : integer\nalgoritma\n  x = fact(3)\nendprogram\n\nfunction fact(n: integer) -> integer\nalgoritma\n  return n * fa\nendfunction';
  ok(has(getCompletions(src, 9, 15), 'fact'), 'self-recursion offered');
}
// 21-22. algoritma is offered where it can come next
{
  const fn = 'function f() -> integer\n  \nendfunction';
  ok(has(getCompletions(fn, 1, 2), 'kamus', 'algoritma'), 'function header: kamus or algoritma', labels(getCompletions(fn, 1, 2)).join(','));
  const k = 'program t\nkamus\n  x : integer\n  alg\nendprogram';
  ok(has(getCompletions(k, 3, 5), 'algoritma'), 'inside kamus: algoritma', labels(getCompletions(k, 3, 5)).join(','));
}

if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nAll completion checks passed.');
