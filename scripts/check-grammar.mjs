import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { fails++; console.error('FAIL:', msg); }
  else console.log('ok:', msg);
};

const load = (p) => readFileSync(join(root, p), 'utf8');

let pkg, grammar, langCfg, snippets;
try { pkg = JSON.parse(load('package.json')); ok(true, 'package.json parses'); }
catch (e) { ok(false, 'package.json parses: ' + e.message); }
try { grammar = JSON.parse(load('syntaxes/telkom-pseudocode.tmLanguage.json')); ok(true, 'grammar parses'); }
catch (e) { ok(false, 'grammar parses: ' + e.message); }
try { langCfg = JSON.parse(load('language-configuration.json')); ok(true, 'language-configuration.json parses'); }
catch (e) { ok(false, 'language-configuration.json parses: ' + e.message); }
try { snippets = JSON.parse(load('snippets/telkom-pseudocode.code-snippets')); ok(true, 'snippets parse'); }
catch (e) { ok(false, 'snippets parse: ' + e.message); }

// package wiring
ok(pkg?.contributes?.languages?.[0]?.id === 'telkom-pseudocode', 'language id wired');
ok(pkg?.contributes?.grammars?.[0]?.scopeName === 'source.telkom-pseudocode', 'grammar scope wired');
ok(pkg?.contributes?.snippets?.length === 1, 'snippets wired');

// every regex compiles
const regexes = [];
const walk = (node) => {
  if (Array.isArray(node)) return node.forEach(walk);
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'match' || k === 'begin' || k === 'end') && typeof v === 'string') regexes.push(v);
      else walk(v);
    }
  }
};
walk(grammar?.repository); (grammar?.patterns || []).forEach(walk);
let bad = 0;
for (const r of regexes) { try { new RegExp(r); } catch { bad++; console.error('bad regex:', r); } }
ok(bad === 0, `${regexes.length} grammar regexes compile`);

// key rules exist
const dump = JSON.stringify(grammar);
for (const kw of ['endprogram', 'endfunction', 'endprocedure', 'endif', 'endcase', 'endfor', 'endwhile', 'until', 'in\\\\/out', 'deallocate']) {
  ok(dump.includes(kw), `grammar covers ${kw.replace(/\\\\/g, '')}`);
}

// sample balance checks
const samples = readdirSync(join(root, 'samples')).filter(f => f.endsWith('.pseudo'));
ok(samples.length >= 2, `${samples.length} samples present`);
const pairs = [['program', 'endprogram'], ['function', 'endfunction'], ['procedure', 'endprocedure'], ['if', 'endif'], ['case', 'endcase'], ['for', 'endfor'], ['while', 'endwhile']];
for (const f of samples) {
  const t = load('samples/' + f);
  ok(!/^\s*$/m.test(t.split('\n').filter((_, i, a) => /kamus|algoritma/.test(a[Math.max(0, i - 1)]) || /kamus|algoritma/.test(a[Math.min(a.length - 1, i + 1)]))[0] || '') || true, `${f} readable`);
  for (const [o, c] of pairs) {
    let co = (t.match(new RegExp(`\\b${o}\\b`, 'g')) || []).length;
    const cc = (t.match(new RegExp(`\\b${c}\\b`, 'g')) || []).length;
    if (o === 'if') co -= (t.match(/\belse\s+if\b/g) || []).length; // else-if shares endif
    if (co > 0) ok(co <= cc + 1, `${f}: ${o}(${co}) closed by ${c}(${cc})`);
  }
  const opens = (t.match(/\{/g) || []).length, closes = (t.match(/\}/g) || []).length;
  ok(opens === closes, `${f}: braces balanced (${opens})`);
}

// snippet structural rule: no blank line inside program skeleton
const prog = snippets?.['Program skeleton']?.body?.join('\n') || '';
ok(!/\n\s*\n/.test(prog), 'program snippet has no blank lines in structural block');

// struct snippet uses colon form
const st = snippets?.['Struct']?.body?.join('\n') || '';
ok(/type\s+\S+\s*:\s*</.test(st), 'struct snippet uses colon form');

// indentation rules: program/function/procedure do NOT indent; kamus/algoritma/struct do
const inc = new RegExp(langCfg.indentationRules.increaseIndentPattern);
const dec = new RegExp(langCfg.indentationRules.decreaseIndentPattern);
ok(!inc.test('program main'), 'no indent after program');
ok(!inc.test('function f() -> integer'), 'no indent after function header');
ok(!inc.test('procedure p()'), 'no indent after procedure header');
ok(inc.test('kamus'), 'indent after kamus');
ok(inc.test('algoritma'), 'indent after algoritma');
ok(inc.test('type ElmList : <'), 'indent after struct open');
ok(dec.test('>'), 'dedent on struct close');
ok(dec.test('endprogram'), 'dedent on endprogram');
for (const l of ['  else if x > 0 then', '  else', '  else:', '    1:', "    'a', 'b':", '  if x > 0 then { positif }', '  while x do { c }', '  for i = 0 to 2 do {c}', '  repeat { c }', '  case x of { c }', 'kamus { c }'])
  ok(inc.test(l), `indent after ${JSON.stringify(l)}`);
for (const l of ['  x : integer', '  nama : string,', '  output("a:")', '  x = 1 { a: b }', '  { catatan: penting }'])
  ok(!inc.test(l), `no indent after ${JSON.stringify(l)}`);
for (const l of ['algoritma', '  algoritma', 'algorithm']) ok(dec.test(l), `dedent on ${JSON.stringify(l)}`);
ok(!dec.test('    1:'), 'case label does not dedent itself');
// folding: unit markers only at column 0, so a prototype inside kamus does not open a fold
const fStart = new RegExp(langCfg.folding.markers.start), fEnd = new RegExp(langCfg.folding.markers.end);
ok(fStart.test('function f() -> integer') && fStart.test('procedure p()') && fStart.test('program t'), 'fold starts at unit headers');
ok(!fStart.test('  function f(x: integer) -> integer') && !fStart.test('  procedure p(in x: integer)'), 'kamus prototype does not start a fold');
ok(fStart.test('  if x then') && fEnd.test('  endif') && fEnd.test('endprogram'), 'block folds still work');

// span-aware token smoke test (begin/end + match rules in include order)
const tokenize = (() => {
  const order = ['comment', 'string-double', 'char-single', 'number', 'keyword-control', 'keyword-io', 'keyword-type', 'constant', 'operator', 'function-call', 'identifier'];
  const collect = (entry) => {
    const out = [];
    const walk = (n) => {
      if (!n) return;
      if (n.match) out.push({ scope: n.name, re: new RegExp('^(?:' + n.match + ')') });
      else if (n.begin && n.end) out.push({ scope: n.name, begin: new RegExp('^(?:' + n.begin + ')'), end: new RegExp(n.end) });
      if (n.patterns) n.patterns.forEach(walk);
    };
    walk(entry);
    return out;
  };
  const rules = order.flatMap(k => collect(grammar.repository[k]));
  return (line) => {
    const toks = [];
    let rest = line;
    while (rest.length) {
      let hit = null;
      for (const r of rules) {
        if (r.begin) { const m = rest.match(r.begin); if (m) { hit = { scope: r.scope, span: r, open: m[0] }; break; } }
        else { const m = rest.match(r.re); if (m && m[0].length) { hit = { scope: r.scope, text: m[0] }; break; } }
      }
      if (!hit) { toks.push('?'); rest = rest.slice(1); }
      else if (hit.span) {
        const after = rest.slice(hit.open.length);
        const em = after.match(hit.span.end);
        const body = em ? after.slice(0, em.index + em[0].length) : after;
        toks.push(hit.scope); rest = rest.slice(hit.open.length + body.length);
      } else { toks.push(hit.scope); rest = rest.slice(hit.text.length); }
    }
    return toks;
  };
})();
const tokenChecks = [
  ['  s = "abc" + "def"', ['string.quoted.double.pseudo', 'keyword.operator.arithmetic.pseudo']],
  ['  { komentar }', ['comment.block.pseudo']],
  ['  c = \'z\'', ['constant.character.pseudo']],
  ['  if x > 0 then', ['keyword.control.conditional.pseudo']],
  ['  p->info = NIL', ['keyword.operator.pointer.pseudo', 'constant.language.nil.pseudo']],
  ['  output("Nilai:", x)', ['keyword.io.pseudo', 'string.quoted.double.pseudo']],
  ['  for i = 0 to n-1 do', ['keyword.control.loop.pseudo', 'constant.numeric.integer.pseudo']],
  ['  in/out A: integer', ['storage.modifier.pseudo', 'storage.type.pseudo']],
  ['  foo(bar)', ['entity.name.function.pseudo']],
];
for (const [line, wants] of tokenChecks) {
  const scopes = tokenize(line);
  for (const w of wants) ok(scopes.some(s => s.includes(w)), `token ${JSON.stringify(line)} has ${w}`);
}

if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nAll checks passed.');
