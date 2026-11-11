// Rename support (vscode-free): findRenameRanges(text, line, char) -> {name, ranges} | null.
// Renames: kamus vars/consts, type names, params, loop vars, function/procedure names.
// Scope-aware: local unit first, globals of main program; shadowed locals rename separately.
// Never renames: keywords, builtins, fields after ./->, contents of strings/comments/chars.
const { tokenize, KEYWORDS } = require('./tokenizer');
const { parse } = require('./parser');

const BUILTINS = new Set(['input', 'output', 'allocate', 'deallocate', 'len']);
const KEYWORDS_SKIP = new Set([
  'program', 'kamus', 'algoritma', 'endprogram', 'dictionary', 'algorithm',
  'function', 'endfunction', 'procedure', 'endprocedure', 'return',
  'if', 'then', 'else', 'endif', 'case', 'of', 'endcase',
  'for', 'to', 'do', 'endfor', 'while', 'endwhile', 'repeat', 'until',
  'integer', 'real', 'char', 'boolean', 'string', 'array', 'of', 'pointer', 'to', 'type', 'constant',
  'in', 'out', 'div', 'mod', 'and', 'or', 'not', 'true', 'false', 'NIL', 'len',
]);

function findRenameRanges(text, line, char) {
  try { return rename(text, line, char); } catch { return null; }
}

function rename(text, rawLine, rawChar) {
  const rawLines = text.split(/\r?\n/);
  if (rawLine < 0 || rawLine >= rawLines.length) return null;
  const raw = rawLines[rawLine];
  const col = Math.max(0, Math.min(rawChar, raw.length));
  const { lines: tokLines } = tokenize(text);
  // reject inside strings/comments/chars/errors
  for (const t of tokLines[rawLine] || []) {
    if ((t.kind === 'comment' || t.kind === 'string' || t.kind === 'char' || t.kind === 'error') &&
      col > t.col && col < t.col + t.text.length) return null;
  }
  // find ident token under cursor
  const toks = tokLines[rawLine] || [];
  let hit = null;
  for (const t of toks) {
    if (t.kind === 'ident' && col >= t.col && col <= t.col + t.text.length) { hit = t; break; }
  }
  if (!hit) return null;
  const name = hit.text;
  if (KEYWORDS_SKIP.has(name) || BUILTINS.has(name)) return null;
  // reject field access position: prev non-space significant token is . or ->
  const pre = raw.slice(0, hit.col);
  if (/(->|\.)\s*$/.test(pre)) return null;
  // reject function-call position? No — subprogram names ARE renamable (decl + calls).
  const { units } = parse(text);
  if (!units.length) return null;

  const unit = unitAt(units, rawLines, rawLine);
  // case A: subprogram name (decl header or call site)
  const sub = units.find(u => (u.kind === 'function' || u.kind === 'procedure') && u.name === name &&
    (u.startLine === rawLine || isCallSite(raw, hit, name)));
  if (sub && (rawLine === sub.startLine || isCallSite(raw, hit, name))) {
    if (isDeclHeaderName(rawLines[sub.startLine], name, sub.kind)) {
      return { name, ranges: collectSubprogramRanges(sub, rawLines, tokLines) };
    }
  }
  const targetSub = units.find(u => (u.kind === 'function' || u.kind === 'procedure') && u.name === name);
  if (targetSub && isCallSite(raw, hit, name)) {
    if (isDeclHeaderName(rawLines[targetSub.startLine], name, targetSub.kind)) {
      return { name, ranges: collectSubprogramRanges(targetSub, rawLines, tokLines) };
    }
  }
  // case B: unit's own header name under cursor on its decl line
  if (unit && rawLine === unit.startLine && isDeclHeaderName(raw, name, unit.kind)) {
    if (unit.kind === 'program') return { name, ranges: [{ line: rawLine, col: hit.col, endCol: hit.col + name.length }] };
    return { name, ranges: collectSubprogramRanges(unit, rawLines, tokLines) };
  }
  // case C: variable-like (decl, param, loop var)
  return renameVariable(name, unit, units, rawLines, tokLines);
}

function isCallSite(raw, tok, name) {
  const after = raw.slice(tok.col + name.length).match(/^\s*\(/);
  return !!after;
}

function isDeclHeaderName(raw, name, kind) {
  const t = raw.trim();
  if (kind === 'program') return new RegExp(`^(program|dictionary)\\s+${name}\\b`).test(t);
  if (kind === 'function') return new RegExp(`^function\\s+${name}\\b`).test(t);
  if (kind === 'procedure') return new RegExp(`^procedure\\s+${name}\\b`).test(t);
  return false;
}

function collectSubprogramRanges(sub, rawLines, tokLines) {
  const ranges = [];
  pushFirstWord(ranges, rawLines[sub.startLine], sub.startLine, sub.name);
  // all call sites "(...)" across file where callee === sub.name
  for (let n = 0; n < rawLines.length; n++) {
    for (const t of tokLines[n] || []) {
      if (t.kind !== 'ident' || t.text !== sub.name) continue;
      if (n === sub.startLine && isDeclHeaderName(rawLines[n], sub.name, sub.kind)) continue; // counted
      const after = rawLines[n].slice(t.col + t.text.length).match(/^\s*\(/);
      if (after) ranges.push({ line: n, col: t.col, endCol: t.col + t.text.length });
    }
  }
  return dedupeRanges(ranges);
}

// Whole-word match: indexOf would hit the 'p' in 'procedure' or the 'e' in 'type'.
function pushFirstWord(ranges, raw, line, name) {
  const [c] = wordCols(raw || '', name);
  if (c !== undefined) ranges.push({ line, col: c, endCol: c + name.length });
}

// --- variable rename ---
function renameVariable(name, unit, units, rawLines, tokLines) {
  if (!unit) return null;
  // is it a type name?
  const isType = units.some(u => (u.decls || []).some(d => (d.kind === 'struct' || d.kind === 'typealias') && d.name === name));
  if (isType) return renameType(name, units, rawLines, tokLines);
  // determine defining scope: local unit first (decl/param/loop), else main program globals
  const prog = units.find(u => u.kind === 'program');
  const localDecl = (unit.decls || []).find(d => d.name === name && (d.kind === 'var' || d.kind === 'const'));
  const localParam = (unit.params || []).some(p => !p.bad && (p.names || []).includes(name));
  const localLoop = hasLoopVar(unit, rawLines, name);
  let owner = null; // unit that owns the binding visible at cursor
  if (localDecl || localParam || localLoop) owner = unit;
  else if (prog && prog !== unit && (prog.decls || []).some(d => d.name === name && (d.kind === 'var' || d.kind === 'const'))) owner = prog;
  else if (unit.kind === 'program') return null; // undeclared here: let diagnostics handle it
  else return null;
  return collectVarRanges(name, owner, units, rawLines, tokLines);
}

function hasLoopVar(unit, rawLines, name) {
  for (const n of unit.bodyLines || []) {
    const m = (rawLines[n] || '').match(/^\s*for\s+([a-zA-Z_]\w*)\s*=/);
    if (m && m[1] === name) return true;
  }
  return false;
}

function renameType(name, units, rawLines, tokLines) {
  const ranges = [];
  for (const u of units) {
    for (const d of u.decls || []) {
      if ((d.kind === 'struct' || d.kind === 'typealias') && d.name === name) pushFirstWord(ranges, rawLines[d.line], d.line, name);
    }
    for (const p of u.params || []) {
      if (p.bad || !p.type) continue;
      // type refs inside param type string: word-boundary search
      for (const mm of matchAllWord(p.raw || `${p.names.join(',')}: ${p.type}`, name)) {
        const hdr = rawLines[u.startLine] || '';
        const base = hdr.indexOf(p.raw || '');
        if (base >= 0) {
          let k = base;
          for (const seg of matchAllWord(p.raw || '', name)) {
            void seg;
          }
          void k;
        }
      }
      // simpler: search header line for `: <type>` occurrences of the name
      const hdr = rawLines[u.startLine] || '';
      for (const c of wordCols(hdr, name)) {
        // only count if inside parens region of header
        const lp = hdr.indexOf('('), rp = hdr.lastIndexOf(')');
        if (lp >= 0 && c > lp && (rp < 0 || c < rp)) ranges.push({ line: u.startLine, col: c, endCol: c + name.length });
      }
    }
    // return type of functions
    if (u.kind === 'function' && u.retType === name) {
      const hdr = rawLines[u.startLine] || '';
      const arrow = hdr.indexOf('->');
      const c = arrow >= 0 ? hdr.indexOf(name, arrow) : -1;
      if (c >= 0) ranges.push({ line: u.startLine, col: c, endCol: c + name.length });
    }
  }
  // annotation uses: decl lines `x : Name`, struct fields, pointer/array targets
  for (let n = 0; n < rawLines.length; n++) {
    for (const t of tokLines[n] || []) {
      if (t.kind !== 'ident' || t.text !== name) continue;
      if (isDeclHeaderName(rawLines[n], name, unitKindAt(units, n))) continue;
      // skip if this token is the struct/typealias decl name already counted
      if (isTypeDeclLine(rawLines[n], name)) continue;
      if (/(->|\.)\s*$/.test(rawLines[n].slice(0, t.col))) continue; // field
      const after = rawLines[n].slice(t.col + t.text.length).match(/^\s*\(/);
      if (after) continue; // call site, not a type
      // accept only type-annotation positions: after ':' or inside type context
      if (isTypePosition(rawLines[n], t.col)) ranges.push({ line: n, col: t.col, endCol: t.col + t.text.length });
    }
  }
  if (!ranges.length) return null;
  return { name, ranges: dedupeRanges(ranges) };
}

function unitKindAt(units, n) {
  const u = units.find(x => x.startLine === n);
  return u ? u.kind : null;
}

function isTypeDeclLine(raw, name) {
  return new RegExp(`^\\s*type\\s+${name}\\b`).test(raw);
}

function isTypePosition(raw, col) {
  // after a ':' on the same decl/field/param segment, or inside <...> / array-of / pointer-to
  const segStart = Math.max(raw.lastIndexOf(',', col), raw.lastIndexOf('<', col), raw.lastIndexOf(':', col), 0);
  const seg = raw.slice(segStart, col);
  if (/:\s*$/.test(seg)) return true; // `x : Name`
  if (/:\s*[a-zA-Z_]\w*(\s*,\s*[a-zA-Z_]\w*)*\s*$/.test(raw.slice(0, col))) return true; // grouped `a, b : Na|me`
  if (/\b(pointer\s+to|of)\s+[a-zA-Z_]\w*$/.test(raw.slice(0, col))) return true;
  if (/<[^>]*$/.test(raw.slice(0, col)) && !/->/.test(raw.slice(Math.max(0, col - 5), col))) return true; // inside struct <...>
  return false;
}

function matchAllWord(s, name) {
  const out = [];
  const re = new RegExp(`\\b${name}\\b`, 'g');
  let m;
  while ((m = re.exec(s))) out.push(m.index);
  return out;
}

function wordCols(raw, name) {
  const out = [];
  const re = new RegExp(`\\b${name}\\b`, 'g');
  let m;
  while ((m = re.exec(raw))) out.push(m.index);
  return out;
}

function collectVarRanges(name, owner, units, rawLines, tokLines) {
  const ranges = [];
  // decl line(s) in owner
  for (const d of owner.decls || []) {
    if (d.name !== name) continue;
    for (const c of wordCols(rawLines[d.line] || '', name)) {
      // decl name is before ':' — first occurrence
      if (c <= (rawLines[d.line] || '').indexOf(':')) { ranges.push({ line: d.line, col: c, endCol: c + name.length }); break; }
    }
  }
  // param names in owner header
  for (const p of owner.params || []) {
    if (p.bad || !(p.names || []).includes(name)) continue;
    const hdr = rawLines[owner.startLine] || '';
    for (const c of wordCols(hdr, name)) {
      const lp = hdr.indexOf('('), rp = hdr.lastIndexOf(')');
      if (lp >= 0 && c > lp && (rp < 0 || c < rp)) { ranges.push({ line: owner.startLine, col: c, endCol: c + name.length }); break; }
    }
  }
  // loop var def in owner
  for (const n of owner.bodyLines || []) {
    const m = (rawLines[n] || '').match(/^\s*for\s+([a-zA-Z_]\w*)\s*=/);
    if (m && m[1] === name) pushFirstWord(ranges, rawLines[n], n, name);
  }
  // uses: owner body + (if owner is program) subprogram bodies that don't shadow
  const scopes = owner.kind === 'program' ? units : [owner];
  for (const u of scopes) {
    if (u.kind === 'program' && owner.kind === 'program' && u !== owner) continue;
    if (u !== owner) {
      // shadowed in this unit? skip its body
      const sh = (u.decls || []).some(d => d.name === name) ||
        (u.params || []).some(p => !p.bad && (p.names || []).includes(name)) ||
        hasLoopVar(u, rawLines, name);
      if (sh) continue;
    }
    for (const n of [...(u.bodyLines || []), ...kamusTypeLines(u, rawLines)]) {
      const typeFrom = (u.bodyLines || []).includes(n) ? -1 : (rawLines[n] || '').indexOf(':'); // kamus: uses sit after ':'
      for (const t of tokLines[n] || []) {
        if (t.kind !== 'ident' || t.text !== name) continue;
        if (t.col <= typeFrom) continue; // the declared name itself, counted with the declaration
        const prev = tokPrev(tokLines[n], t);
        if (prev && prev.kind === 'op' && (prev.text === '->' || prev.text === '.')) continue; // field
        const after = rawLines[n].slice(t.col + t.text.length).match(/^\s*\(/);
        if (after && isSubprogram(units, name)) continue; // call to same-named subprogram, not the var
        ranges.push({ line: n, col: t.col, endCol: t.col + name.length });
      }
    }
  }
  if (!ranges.length) return null;
  return { name, ranges: dedupeRanges(ranges) };
}

// kamus lines that can mention a constant in a type: 'arr : array[0..N-1] of T', struct fields.
// Prototype headers in kamus are skipped: their parameters are a separate scope.
function kamusTypeLines(u, rawLines) {
  const from = u.kamusLine !== undefined ? u.kamusLine + 1 : u.startLine + 1;
  const to = u.algoLine !== undefined ? u.algoLine : u.endLine;
  const out = [];
  for (let n = from; n < to; n++) {
    const raw = rawLines[n] || '';
    if (/^\s*(function|procedure)\b/.test(raw) || raw.indexOf(':') < 0) continue;
    out.push(n);
  }
  return out;
}

// null if `name` can replace an identifier, else the reason it can't
function isValidNewName(name) {
  if (!/^[a-zA-Z_]\w*$/.test(name || '')) return 'Invalid name — use letters, digits and underscore, no leading digit.';
  if (KEYWORDS_SKIP.has(name) || BUILTINS.has(name) || KEYWORDS.has(name)) return `'${name}' is a reserved word — choose another name.`;
  return null;
}

function tokPrev(lineToks, t) {
  const i = lineToks.indexOf(t);
  return i > 0 ? lineToks[i - 1] : null;
}

function isSubprogram(units, name) {
  return units.some(u => (u.kind === 'function' || u.kind === 'procedure') && u.name === name);
}

function unitAt(units, rawLines, n) {
  let best = null;
  for (const u of units) {
    if (u.startLine <= n && (!best || u.startLine > best.startLine)) best = u;
  }
  if (!best) return null;
  if (n <= (best.endLine === undefined ? best.startLine : best.endLine)) return best;
  return best; // lenient: still attribute to nearest unit above
}

function dedupeRanges(rs) {
  const seen = new Set();
  return rs.filter(r => {
    const k = `${r.line}:${r.col}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.line - b.line || a.col - b.col);
}

module.exports = { findRenameRanges, isValidNewName };
