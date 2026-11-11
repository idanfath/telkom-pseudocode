// Symbol + use checks (BASIC set). Pure function of parse result; no vscode import.
// Returns diags to append. Records type/arity info for Phase-5 typecheck.
const { checkStatement } = require('./syntax');
const { KEYWORDS } = require('./tokenizer');
const BLOCK_CLOSE = { endif: 'if', endcase: 'case', endfor: 'for', endwhile: 'while', until: 'repeat' };
const KEYWORDS_SKIP = new Set([
  'program', 'kamus', 'algoritma', 'endprogram', 'dictionary', 'algorithm',
  'function', 'endfunction', 'procedure', 'endprocedure', 'return',
  'if', 'then', 'else', 'endif', 'case', 'of', 'endcase',
  'for', 'to', 'do', 'endfor', 'while', 'endwhile', 'repeat', 'until',
  'input', 'output', 'allocate', 'deallocate',
  'integer', 'real', 'char', 'boolean', 'string', 'array', 'of', 'pointer', 'to', 'type', 'constant',
  'in', 'out', 'div', 'mod', 'and', 'or', 'not', 'true', 'false', 'NIL', 'len',
]);

function err(line, col, endCol, msg) { return { line, col, endCol, msg, sev: 0 }; }
function warn(line, col, endCol, msg) { return { line, col, endCol, msg, sev: 1 }; }
function info(line, col, endCol, msg) { return { line, col, endCol, msg, sev: 2 }; }

function check(parsed, rawLines) {
  const { units, lines } = parsed;
  const diags = [];
  const globals = new Map(); // name -> {decl, assigned:Set(line), usedBeforeAssign:[]}
  const subprograms = new Map(); // name -> unit

  for (const u of units) {
    if (u.kind !== 'program') subprograms.set(u.name, u);
  }

  // program first: its kamus is the global scope, wherever the program sits in the file
  const ordered = [...units.filter(u => u.kind === 'program'), ...units.filter(u => u.kind !== 'program')];
  for (const u of ordered) {
    const scope = new Map(); // name -> {declLine, type, kind, assigned:boolean, assignedLine, usedLines:[]}
    const dupCheck = new Set();
    for (const d of u.decls) {
      if (dupCheck.has(d.name)) diags.push(err(d.line, rawLines[d.line].indexOf(d.name), rawLines[d.line].indexOf(d.name) + d.name.length, `Duplicate declaration '${d.name}'`));
      dupCheck.add(d.name);
      scope.set(d.name, { declLine: d.line, type: d.type, kind: d.kind, assigned: d.kind === 'const' || d.kind === 'typealias' || d.kind === 'struct', used: false });
    }
    // params
    for (const p of (u.params || [])) {
      if (p.bad) { diags.push(err(u.startLine, 0, rawLines[u.startLine].length, `Bad parameter '${p.raw}'`)); continue; }
      for (const nm of p.names) {
        const mode = p.mode || 'in';
        if (!['in', 'out', 'in/out'].includes(mode)) diags.push(err(u.startLine, 0, rawLines[u.startLine].length, `Bad param mode '${mode}'`));
        if (scope.has(nm)) diags.push(err(u.startLine, 0, rawLines[u.startLine].length, `Duplicate param '${nm}'`));
        scope.set(nm, { declLine: u.startLine, type: p.type, kind: 'param', mode, assigned: mode === 'in' || mode === 'in/out', used: false });
      }
    }
    if (u.kind === 'program') for (const [k, v] of scope) globals.set(k, v);

    const bodyLines = u.bodyLines || [];
    const blocks = []; // open block keywords, to know when a line sits directly in a case
    for (const n of bodyLines) {
      const toks = lines[n] || [];
      const raw = rawLines[n];
      checkLineUses(u, n, toks, raw, scope, subprograms, globals, diags);
      if (u.algoLine === undefined || n <= u.algoLine) continue; // outside algoritma: reported by the parser
      const syn = checkStatement(toks, { unitKind: u.kind, inCase: blocks[blocks.length - 1] === 'case' });
      if (syn) diags.push(err(n, syn.col, syn.endCol, syn.msg));
      const first = toks.find(t => t.kind !== 'comment');
      const kw = first && first.kind === 'keyword' ? first.text : null;
      if (['if', 'case', 'for', 'while', 'repeat'].includes(kw)) blocks.push(kw);
      else if (BLOCK_CLOSE[kw] && blocks.lastIndexOf(BLOCK_CLOSE[kw]) !== -1) blocks.length = blocks.lastIndexOf(BLOCK_CLOSE[kw]);
    }
    // decl-type warnings (array bounds live on decl lines, never visited as body)
    for (const d of u.decls) {
      if (/^array/i.test(d.type) && /\b0\s*\.\.\s*MAX(?![\w-])/.test(d.type)) {
        const raw = rawLines[d.line];
        const c = Math.max(0, raw.search(/array/));
        diags.push(warn(d.line, c, c + 5, 'array[0..MAX] holds MAX+1 elements — use [0..MAX-1]'));
      }
      // subrange type (Slide 00 p.6): integer[lo..hi], both bounds required
      const subM = /^integer\s*\[\s*([+-]?\d+)\s*\.\.\s*([+-]?\d+)\s*\]$/.exec(d.type);
      if (subM) {
        const lo = parseInt(subM[1], 10), hi = parseInt(subM[2], 10);
        const raw = rawLines[d.line];
        const c = Math.max(0, raw.search(/integer/));
        if (lo > hi)
          diags.push(err(d.line, c, c + 7, `Subrange lower bound ${lo} exceeds upper bound ${hi}`));
      }
    }
    // never-assigned-but-used handled inline; never-used => info
    for (const [name, s] of scope) {
      if ((s.kind === 'var' || s.kind === 'param') && !s.used && u.kind !== 'program') {
        // skip loop vars? still info
        diags.push(info(s.declLine, rawLines[s.declLine].indexOf(name), rawLines[s.declLine].indexOf(name) + name.length, `'${name}' declared but never used`));
      }
    }
    // procedure I.S./F.S. check: comment within header..kamus/algoritma region
    if (u.kind === 'procedure') {
      const endScan = u.kamusLine !== undefined ? u.kamusLine : (u.algoLine !== undefined ? u.algoLine : u.startLine + 3);
      let blob = '';
      for (let i = u.startLine; i <= Math.min(endScan + 1, rawLines.length - 1); i++) blob += rawLines[i] + '\n';
      if (!/I\.S\./.test(blob) || !/F\.S\./.test(blob))
        diags.push(warn(u.startLine, 0, rawLines[u.startLine].length, 'Procedure spec should include I.S. / F.S.'));
    }
  }
  checkDeclarations(units, rawLines, diags);
  return diags;
}

// Names and types declared anywhere in the file: reserved words, unknown types,
// duplicate subprograms, procedure parameter modes, blank line between units.
function checkDeclarations(units, rawLines, diags) {
  const typeNames = new Set();
  for (const u of units) for (const d of u.decls) if (d.kind === 'struct' || d.kind === 'typealias') typeNames.add(d.name);
  const unknownIn = (t) => {
    t = String(t || '').trim();
    let m;
    if (!t || /^(integer|real|char|boolean|string)$/i.test(t) || /^integer\s*\[.*\]$/i.test(t)) return null;
    if ((m = t.match(/^array\s*\[[^\]]*\]\s*of\s+(.+)$/i))) return unknownIn(m[1]);
    if ((m = t.match(/^pointer\s+to\s+(.+)$/i))) return unknownIn(m[1]);
    if (/^[a-zA-Z_]\w*$/.test(t)) return typeNames.has(t) ? null : t;
    return null; // malformed type text: reported by the declaration parser
  };
  // column of `word` on line n (after `from`), as a squiggle range
  const span = (n, word, from = 0) => {
    const raw = rawLines[n] || '';
    const re = new RegExp(`\\b${word}\\b`, 'g');
    re.lastIndex = Math.max(0, from);
    const m = re.exec(raw);
    const c = m ? m.index : 0;
    return [c, c + (m ? word.length : Math.max(1, raw.length))];
  };
  const reserved = (n, name, what, from) => {
    if (KEYWORDS.has(name)) { const [c, e] = span(n, name, from); diags.push(err(n, c, e, `'${name}' is a reserved word — choose another ${what} name`)); }
  };
  const unknownType = (n, t) => {
    const bad = unknownIn(t);
    if (!bad) return;
    // struct fields span several lines: find the line that names the type
    let line = n;
    for (let k = n; k < Math.min(rawLines.length, n + 50); k++) {
      const colon = (rawLines[k] || '').indexOf(':');
      if (colon >= 0 && new RegExp(`\\b${bad}\\b`).test(rawLines[k].slice(colon))) { line = k; break; }
    }
    const [c, e] = span(line, bad, (rawLines[line] || '').indexOf(':'));
    diags.push(err(line, c, e, `Unknown type '${bad}' — declare it with 'type ${bad} : ...'`));
  };
  const seenSub = new Set();
  for (const u of units) {
    reserved(u.startLine, u.name, u.kind === 'program' ? 'program' : u.kind, (rawLines[u.startLine] || '').search(/\b(program|function|procedure)\b/) + u.kind.length);
    if (u.kind !== 'program') {
      if (seenSub.has(u.name)) { const [c, e] = span(u.startLine, u.name, u.kind.length); diags.push(err(u.startLine, c, e, `Duplicate subprogram '${u.name}'`)); }
      seenSub.add(u.name);
    }
    if (u.startLine > 0 && /^\s*(endprogram|endfunction|endprocedure)\b/.test(rawLines[u.startLine - 1] || '')) {
      const prev = rawLines[u.startLine - 1].trim().split(/\s/)[0];
      const [c, e] = span(u.startLine, u.kind);
      diags.push(err(u.startLine, c, e, `Missing blank line between '${prev}' and this ${u.kind}`));
    }
    const hdr = rawLines[u.startLine] || '';
    for (const p of u.params || []) {
      if (p.bad) continue;
      for (const nm of p.names) {
        reserved(u.startLine, nm, 'parameter', hdr.indexOf('('));
        if (u.kind === 'procedure' && !p.mode) {
          const [c, e] = span(u.startLine, nm, hdr.indexOf('('));
          diags.push(warn(u.startLine, c, e, `Parameter '${nm}' needs a mode: in, out or in/out`));
        }
      }
      unknownType(u.startLine, p.type);
    }
    if (u.kind === 'function' && u.retType) unknownType(u.startLine, u.retType);
    for (const d of u.decls) {
      reserved(d.line, d.name, d.kind === 'struct' || d.kind === 'typealias' ? 'type' : 'variable', 0);
      if (d.kind === 'struct') {
        for (const f of String(d.fields || '').replace(/>\s*$/, '').split(',')) {
          const m = f.match(/^\s*[a-zA-Z_]\w*\s*:\s*(.+?)\s*$/);
          if (m) unknownType(d.line, m[1]);
        }
      } else unknownType(d.line, d.type);
    }
  }
}

function lookup(name, scope, globals) {
  if (scope.has(name)) return scope.get(name);
  if (globals.has(name)) return globals.get(name);
  return null;
}

function checkLineUses(u, n, toks, raw, scope, subprograms, globals, diags) {
  // <- rule
  for (const t of toks) {
    if (t.kind === 'op' && t.text === '<-') diags.push(err(n, t.col, t.col + 2, "Uses '<-' — use '=' for assignment"));
  }
  // mixed output concat: output("label" + x) where x is declared non-string.
  // "a" + s with s a string is concatenation; fields/calls/indexes are left to the runner.
  if (/\boutput\s*\(/.test(raw)) {
    for (const m of raw.matchAll(/"(?:[^"\\]|\\.)*"\s*\+\s*([a-zA-Z_]\w*)(?!\s*(?:\(|\[|\.|->))/g)) {
      const bt = baseTypeOf(m[1], scope, globals);
      if (!bt || bt === 'string') continue;
      const c = m.index + m[0].indexOf('+');
      diags.push(err(n, c, c + 1, "Mixed-type output with '+' — use comma: output(\"label:\", x)"));
    }
  }
  // array[0..MAX] literal
  if (/\barray\s*\[\s*0\s*\.\.\s*MAX\s*\]/.test(raw)) {
    const c = raw.search(/array/);
    diags.push(warn(n, c, c + 5, 'array[0..MAX] holds MAX+1 elements — use [0..MAX-1]'));
  }
  // assignment target: ident ( [expr] | -> f | . f )* = ...
  const code = stripStrings(raw);
  const assignM = code.match(/^\s*([a-zA-Z_]\w*(?:\s*(?:\[[^\]]*\]|->\s*[a-zA-Z_]\w*|\.\s*[a-zA-Z_]\w*))*)\s*=(?!=)/);
  let assignedName = null;
  if (assignM) {
    assignedName = assignM[1].match(/[a-zA-Z_]\w*/)[0];
    const base = lookup(assignedName, scope, globals);
    if (!base) {
      const c = raw.indexOf(assignedName);
      diags.push(err(n, c, c + assignedName.length, `Undeclared identifier '${assignedName}'`));
    } else if (base.kind === 'const') {
      const c = raw.indexOf(assignedName);
      diags.push(err(n, c, c + assignedName.length, `Cannot assign to constant '${assignedName}'`));
      base.used = true;
    } else { base.assigned = true; base.used = true; if (base.assignedLine === undefined) base.assignedLine = n; }
  }
  // static wrong-type: bare literal assigned to an incompatible base type.
  // Conservative: only bare literals vs plain base/subrange types. Chained targets
  // (p->v, m.n, arr[i]), aliases, and expressions are enforced by the runner.
  if (assignM && assignedName) {
    const base = lookup(assignedName, scope, globals);
    if (base && base.kind !== 'const' && !/->|\./.test(assignM[1]) && !/\[/.test(assignM[1])) {
      const rhs = code.slice(assignM.index + assignM[0].length).trim();
      const lit = rhs === '""' ? 'string'
        : /^'c'$/.test(rhs) ? 'char'
        : /^(true|false)$/.test(rhs) ? 'boolean'
        : /^\d+$/.test(rhs) ? 'int'
        : /^\d+\.\d+$/.test(rhs) ? 'real'
        : null;
      const bt = (base.type || '').toLowerCase();
      const sub = /^integer\s*\[.*\]$/.test(bt) ? 'integer' : bt;
      if (lit && ['integer', 'real', 'char', 'boolean', 'string'].includes(sub)) {
        const bad = (lit === 'string' && sub !== 'string')
          || (lit === 'int' && !['integer', 'real'].includes(sub)) // int -> real allowed
          || (lit === 'real' && sub !== 'real')
          || (lit === 'char' && !['char', 'string'].includes(sub)) // 'a' fits a 1-char string
          || (lit === 'boolean' && sub !== 'boolean');
        if (bad) {
          const eq = raw.indexOf('=');
          const c = eq < 0 ? 0 : eq + 1;
          diags.push(err(n, c, raw.length, `Type mismatch: cannot assign ${lit} value to '${assignedName}' (${base.type})`));
        }
      }
    }
  }
  // for-loop var must be declared in kamus — no implicit loop vars
  const forM = code.match(/^\s*for\s+([a-zA-Z_]\w*)\s*=\s*(.+?)\s+to\s+(.+?)\s+do/);
  if (forM) {
    const v = forM[1];
    const base = lookup(v, scope, globals);
    if (!base) {
      const from = raw.indexOf('for') + 3;
      const c = Math.max(0, raw.indexOf(v, from < 0 ? 0 : from));
      diags.push(err(n, c, c + v.length, `Undeclared loop variable '${v}' — declare it in kamus`));
      scope.set(v, { declLine: n, type: 'integer', kind: 'loopvar', assigned: true, used: true }); // avoid cascade
    } else { base.assigned = true; base.used = true; }
    if (/^\s*n\s*$/.test(forM[3]) || /\bto\s+n\b(?!\s*-)/.test(code))
      diags.push(warn(n, raw.indexOf('to'), raw.indexOf('to') + 2, "'for ... to n' risks out-of-bounds on arr[i] — prefer 'to n-1'"));
  }
  // collect identifier uses (skip decl keywords handled; skip property after -> or .)
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== 'ident') continue;
    const prev = toks[i - 1];
    if (prev && prev.kind === 'op' && (prev.text === '->' || prev.text === '.')) continue; // field name
    if (KEYWORDS_SKIP.has(t.text)) continue;
    // skip function name in decl header lines (already handled) and skip type names
    // call detection: next non-space char is '('
    const after = raw.slice(t.col + t.text.length).match(/^\s*\(/);
    if (after) {
      if (!subprograms.has(t.text) && !['input', 'output', 'len', 'allocate', 'deallocate'].includes(t.text)) {
        const base = lookup(t.text, scope, globals);
        if (!base) diags.push(err(n, t.col, t.col + t.text.length, `Undeclared identifier '${t.text}'`));
        else { base.used = true; if (!base.assigned && base.kind !== 'const') diags.push(warn(n, t.col, t.col + t.text.length, `'${t.text}' may be used before assignment`)); }
      } else if (subprograms.has(t.text)) {
        const target = subprograms.get(t.text);
        const expected = (target.params || []).reduce((a, p) => a + (p.names ? p.names.length : 0), 0);
        const callArgs = raw.slice(raw.indexOf('(', t.col) + 1);
        const given = splitArgs(callArgs);
        // record for phase-5; basic: only flag gross mismatch when expected known and no nesting
        if (!/[()]/.test(given.join('')) && given.filter(s => s.trim()).length !== expected && expected > 0) {
          // soft: warn only, arity rules tighten in phase 5
        }
        const base = lookup(t.text, scope, globals);
        if (base) base.used = true;
      }
      continue;
    }
    // skip left-side assignment base (already marked)
    if (assignedName === t.text && toks.findIndex(x => x.kind === 'op' && x.text === '=') > i - 3) {
      // still need declared check done; skip use-before-assign on write target
      continue;
    }
    // skip 'for' loop var def position
    if (forM && forM[1] === t.text && t.col < raw.indexOf('=')) continue;
    const base = lookup(t.text, scope, globals);
    if (!base) {
      diags.push(err(n, t.col, t.col + t.text.length, `Undeclared identifier '${t.text}'`));
    } else {
      base.used = true;
      if (!base.assigned && base.kind !== 'const' && base.kind !== 'typealias' && !(base.kind === 'param' && (base.mode === 'in' || base.mode === 'in/out'))) {
        // out-param read counts as use-before-write
        diags.push(warn(n, t.col, t.col + t.text.length, `'${t.text}' may be used before assignment`));
      }
    }
  }
}

// declared base type of a variable, following type aliases; null when unknown
function baseTypeOf(name, scope, globals) {
  const s = lookup(name, scope, globals);
  let t = s && s.kind !== 'typealias' ? s.type : null;
  for (let k = 0; k < 10 && t; k++) {
    const lt = String(t).trim().toLowerCase();
    if (/^(integer|real|char|boolean|string)$/.test(lt)) return lt;
    if (/^integer\s*\[/.test(lt)) return 'integer';
    const a = lookup(String(t).trim(), scope, globals);
    t = a && a.kind === 'typealias' ? a.type : null;
  }
  return null;
}

function stripStrings(s) {
  return s.replace(/"([^"\\]|\\.)*"/g, '""').replace(/'(\\.|[^'\\])'/g, "'c'");
}

function splitArgs(s) {
  // take until matching close of first paren
  let depth = 0, cur = '', out = [];
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') { if (depth === 0) break; depth--; }
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

module.exports = { check };
