import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const { findRenameRanges } = require('./lang/rename.js');

let fails = 0;
const ok = (cond, msg, extra = '') => { if (!cond) { fails++; console.error('FAIL:', msg, extra); } else console.log('ok:', msg); };

const at = (src, line, substr, nth = 0) => {
  const raw = src.split('\n')[line];
  let c = -1;
  for (let i = 0; i <= nth; i++) c = raw.indexOf(substr, c + 1);
  return { line, ch: c + 1, raw };
};

// 1. local var: decl + 2 uses
{
  const src = 'program t\nkamus\n  total : integer\nalgoritma\n  total = 1\n  output(total)\nendprogram';
  const p = at(src, 4, 'total');
  const r = findRenameRanges(src, p.line, p.ch);
  ok(r && r.name === 'total' && r.ranges.length === 3, 'rename-local-var-3', JSON.stringify(r));
}
// 2. shadowed: subprogram local renames alone, program var untouched
{
  const src = 'program t\nkamus\n  x : integer\nalgoritma\n  x = 1\n  output(x)\nendprogram\n\nprocedure p()\nkamus\n  x : integer\nalgoritma\n  x = 2\nendprocedure';
  const p = at(src, 10, 'x');
  const r = findRenameRanges(src, p.line, p.ch);
  ok(r && r.ranges.length === 2 && r.ranges.every(q => q.line >= 8), 'rename-shadow-local', JSON.stringify(r));
}
// 3. keyword under cursor -> null
{
  const src = 'program t\nkamus\n  x : integer\nalgoritma\n  if x > 0 then\n    output(x)\n  endif\nendprogram';
  const r = findRenameRanges(src, 4, 3); // 'if'
  ok(r === null, 'rename-keyword-null');
}
// 4. field after dot -> null
{
  const src = 'program t\nkamus\n  type M : <\n    nama : string\n  >\n  m : M\nalgoritma\n  m.nama = "a"\nendprogram';
  const p = at(src, 7, 'nama');
  const r = findRenameRanges(src, p.line, p.ch);
  ok(r === null, 'rename-field-null', JSON.stringify(r));
}
// 5. builtin -> null
{
  const src = 'program t\nkamus\n  x : integer\nalgoritma\n  output(x)\nendprogram';
  const r = findRenameRanges(src, 4, 3); // 'output'
  ok(r === null, 'rename-builtin-null');
}
// 6. function name: decl + call
{
  const src = 'program t\nkamus\n  x : integer\nalgoritma\n  x = fact(3)\n  output(x)\nendprogram\n\nfunction fact(n: integer) -> integer\nalgoritma\n  return 1\nendfunction';
  const p = at(src, 4, 'fact');
  const r = findRenameRanges(src, p.line, p.ch);
  ok(r && r.name === 'fact' && r.ranges.length === 2, 'rename-func', JSON.stringify(r));
}
// 7. type name: struct decl + annotation + field-type use
{
  const src = 'program t\nkamus\n  type Mahasiswa : <\n    nama : string\n  >\n  m : Mahasiswa\nalgoritma\n  output(1)\nendprogram';
  const p = at(src, 2, 'Mahasiswa');
  const r = findRenameRanges(src, p.line, p.ch);
  ok(r && r.ranges.length === 2, 'rename-type', JSON.stringify(r));
}
// 8. loop var: kamus decl + def + use
{
  const src = 'program t\nkamus\n  i : integer\n  s : integer\nalgoritma\n  for i = 0 to 4 do\n    s = s + i\n  endfor\nendprogram';
  const p = at(src, 5, 'i');
  const r = findRenameRanges(src, p.line, p.ch);
  ok(r && r.ranges.length === 3, 'rename-loopvar', JSON.stringify(r));
}
// 9. in comment -> null
{
  const src = 'program t\nkamus\n  x : integer\nalgoritma\n  { hello x }\n  output(x)\nendprogram';
  const r = findRenameRanges(src, 4, 11);
  ok(r === null, 'rename-comment-null');
}
// 10. old-style struct without colon still parses, error reported elsewhere
{
  const src = 'program t\nkamus\n  type Mahasiswa <\n    nama : string\n  >\n  m : Mahasiswa\nalgoritma\n  output(1)\nendprogram';
  const p = at(src, 5, 'Mahasiswa');
  const r = findRenameRanges(src, p.line, p.ch);
  ok(r && r.ranges.length === 2, 'rename-old-struct-tolerated', JSON.stringify(r));
}

// Applies a rename the way the editor would, so a wrong range shows up as broken source.
const renamed = (src, line, ch, to) => {
  const r = findRenameRanges(src, line, ch);
  if (!r) return null;
  const ls = src.split('\n');
  for (const q of [...r.ranges].sort((a, b) => b.line - a.line || b.col - a.col))
    ls[q.line] = ls[q.line].slice(0, q.col) + to + ls[q.line].slice(q.endCol);
  return ls.join('\n');
};
const same = (got, want, msg) => ok(got === want, msg, `\ngot:\n${got}\nwant:\n${want}`);

// 11-14. a name that is also a substring of a keyword must not edit the keyword
same(
  renamed('program t\nkamus\n  x : integer\nalgoritma\n  p(x)\nendprogram\n\nprocedure p(in a: integer)\n{ I.S. a\n  F.S. a }\nalgoritma\n  output(a)\nendprocedure', 7, 10, 'cetak'),
  'program t\nkamus\n  x : integer\nalgoritma\n  cetak(x)\nendprogram\n\nprocedure cetak(in a: integer)\n{ I.S. a\n  F.S. a }\nalgoritma\n  output(a)\nendprocedure',
  'rename-procedure-p-keeps-keyword');
same(
  renamed('program t\nkamus\n  x : integer\nalgoritma\n  x = f()\nendprogram\n\nfunction f() -> integer\nalgoritma\n  return 1\nendfunction', 7, 9, 'satu'),
  'program t\nkamus\n  x : integer\nalgoritma\n  x = satu()\nendprogram\n\nfunction satu() -> integer\nalgoritma\n  return 1\nendfunction',
  'rename-function-f-keeps-keyword');
same(
  renamed('program t\nkamus\n  type e : integer\n  x : e\nalgoritma\n  x = 1\nendprogram', 2, 7, 'Elemen'),
  'program t\nkamus\n  type Elemen : integer\n  x : Elemen\nalgoritma\n  x = 1\nendprogram',
  'rename-type-e-keeps-keyword');
same(
  renamed('program t\nkamus\n  o : integer\nalgoritma\n  for o = 0 to 1 do\n    output(o)\n  endfor\nendprogram', 2, 2, 'idx'),
  'program t\nkamus\n  idx : integer\nalgoritma\n  for idx = 0 to 1 do\n    output(idx)\n  endfor\nendprogram',
  'rename-loopvar-o-keeps-keyword');

// 15. else-if conditions are uses like any other
same(
  renamed('program t\nkamus\n  x : integer\nalgoritma\n  x = 1\n  if x > 5 then\n    x = 2\n  else if x > 0 then\n    x = 3\n  endif\nendprogram', 2, 2, 'nilai'),
  'program t\nkamus\n  nilai : integer\nalgoritma\n  nilai = 1\n  if nilai > 5 then\n    nilai = 2\n  else if nilai > 0 then\n    nilai = 3\n  endif\nendprogram',
  'rename-includes-else-if-condition');

// 16-17. constants used in kamus types (array bounds, subprogram kamus) rename with the constant
same(
  renamed('program t\nkamus\n  constant N : integer = 3\n  type T : array[0..N-1] of integer\n  arr : array[0..N-1] of integer\nalgoritma\n  output(N)\nendprogram\n\nfunction f() -> integer\nkamus\n  a : array[0..N] of integer\nalgoritma\n  return N\nendfunction', 2, 11, 'MAX'),
  'program t\nkamus\n  constant MAX : integer = 3\n  type T : array[0..MAX-1] of integer\n  arr : array[0..MAX-1] of integer\nalgoritma\n  output(MAX)\nendprogram\n\nfunction f() -> integer\nkamus\n  a : array[0..MAX] of integer\nalgoritma\n  return MAX\nendfunction',
  'rename-constant-in-array-bounds');
same(
  renamed('program t\nkamus\n  n : integer\n  function g(n: integer) -> integer\nalgoritma\n  n = 1\nendprogram', 2, 2, 'jumlah'),
  'program t\nkamus\n  jumlah : integer\n  function g(n: integer) -> integer\nalgoritma\n  jumlah = 1\nendprogram',
  'rename-skips-kamus-prototype-params');

// 18. new names: identifiers only, never reserved words or builtins
const { isValidNewName } = require('./lang/rename.js');
ok(isValidNewName('jumlah_2') === null, 'new name: identifier ok');
ok(/reserved/.test(isValidNewName('if') || ''), 'new name: reserved word rejected', isValidNewName('if'));
ok(/reserved/.test(isValidNewName('output') || ''), 'new name: builtin rejected');
ok(/reserved/.test(isValidNewName('len') || ''), 'new name: len rejected');
ok(/letters/.test(isValidNewName('2x') || ''), 'new name: leading digit rejected');

if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nAll rename checks passed.');
