// Block parser + symbol tables. Line/token based, no throwing on bad code.
// Produces: {units, diags}. diags: {line, col, endCol, msg, sev} sev 0=error 1=warn 2=info.
const { tokenize } = require('./tokenizer');

const OPENERS = { if: 'endif', case: 'endcase', for: 'endfor', while: 'endwhile', repeat: 'until' };
const CLOSERS = { endif: 'if', endcase: 'case', endfor: 'for', endwhile: 'while', until: 'repeat' };
const UNIT_OPEN = { program: 'endprogram', function: 'endfunction', procedure: 'endprocedure' };
const UNIT_CLOSE = { endprogram: 'program', endfunction: 'function', endprocedure: 'procedure' };
const BASE_TYPES = new Set(['integer', 'real', 'char', 'boolean', 'string']);

function err(line, col, endCol, msg) { return { line, col, endCol, msg, sev: 0 }; }
function warn(line, col, endCol, msg) { return { line, col, endCol, msg, sev: 1 }; }
// whole-line diagnostics skip leading indent so squiggles start at code
function lineSpan(n, rawLines, len) {
  const raw = rawLines[n] || '';
  const col = /^\s*/.exec(raw)[0].length;
  const end = len === undefined ? raw.trimEnd().length : col + len;
  return { col, end: Math.max(end, col + 1) };
}
function lineErr(n, rawLines, msg, len) {
  const { col, end } = lineSpan(n, rawLines, len);
  return err(n, col, end, msg);
}
function lineWarn(n, rawLines, msg, len) {
  const { col, end } = lineSpan(n, rawLines, len);
  return warn(n, col, end, msg);
}

function kwAt(toks, i) { return toks[i] && toks[i].kind === 'keyword' ? toks[i].text : null; }

function parse(text) {
  const { lines, unclosedComment } = tokenize(text);
  const rawLines = text.split(/\r?\n/);
  const diags = [];
  if (unclosedComment) {
    const n = rawLines.length - 1;
    diags.push(err(n, 0, Math.max(1, rawLines[n].length), "Unclosed '{' comment"));
  }
  // unclosed string per line = error token already; surface them
  lines.forEach((toks, n) => toks.forEach(t => {
    if (t.kind === 'error' && t.text.startsWith('"')) diags.push(err(n, t.col, rawLines[n].length, 'Unclosed string literal'));
  }));
  // stray } outside comment
  lines.forEach((toks, n) => toks.forEach(t => {
    if (t.kind === 'error' && t.text === '}') diags.push(err(n, t.col, t.col + 1, "Stray '}' outside comment"));
  }));

  const units = []; // {kind,name,startLine,endLine,params,retType,decls,scopes,bodyLines}
  let cur = null; // current unit
  const consumed = new Set(); // struct-span lines to skip
  const blockStack = []; // {kw,line,unit}
  const unitStackDepth = () => blockStack.filter(b => b.unitBoundary).length;
  let seenKamus = false, seenAlgo = false;

  const closeUnit = (endLine, closer) => {
    if (!cur) { diags.push(err(endLine, 0, closer.length, `Stray '${closer}' with no open unit`)); return; }
    cur.endLine = endLine;
    // drain blocks opened inside unit
    while (blockStack.length && !blockStack[blockStack.length - 1].unitBoundary) {
      const b = blockStack.pop();
      diags.push(lineErr(b.line, rawLines, `Unclosed '${b.kw}' (reached '${closer}')`));
    }
    if (blockStack.length && blockStack[blockStack.length - 1].unitBoundary) blockStack.pop();
    units.push(cur);
    cur = null; seenKamus = false; seenAlgo = false;
  };

  rawLines.forEach((raw, n) => {
    if (consumed.has(n)) return; // inside multi-line struct span
    const toks = lines[n];
    const words = toks.filter(t => t.kind === 'keyword').map(t => t.text);
    const first = words[0];
    // blank-line structural rule
    if (/^\s*$/.test(raw)) {
      const prev = rawLines[n - 1] || '', next = rawLines[n + 1] || '';
      if (/^\s*(kamus|algoritma|dictionary|algorithm|endprogram|endfunction|endprocedure)\b/.test(next))
        diags.push(lineErr(n + 1, rawLines, `Blank line before '${next.trim().split(/\s/)[0]}'`));
      if (/^\s*(kamus|algoritma|dictionary|algorithm)\b/.test(prev))
        diags.push(err(n, 0, 1, `Blank line after '${prev.trim()}' breaks structural block`));
      return;
    }
    if (toks.length && toks.every(t => t.kind === 'comment')) return; // comment-only line
    const code = blankComments(raw, toks); // declarations are read from this: same columns, no comments
    // unit openers (also cover dictionary/algorithm as aliases)
    const uline = raw.trim();
    if (/^program\b/.test(uline)) { // 'dictionary' is the English 'kamus', not a program header
      if (cur) { diags.push(lineErr(n, rawLines, `Nested unit: close '${cur.kind}' first`)); }
      const m = uline.match(/^program\s+([a-zA-Z_]\w*)/);
      if (!m) diags.push(lineErr(n, rawLines, 'Program needs a name'));
      cur = { kind: 'program', name: m ? m[1] : '?', startLine: n, endLine: n, params: [], retType: null, decls: [], bodyStart: n };
      seenKamus = false; seenAlgo = false;
      blockStack.push({ kw: '__unit', line: n, unitBoundary: true });
      return;
    }
    // Some course material declares subprogram prototypes inside kamus. Accepted, not used yet;
    // the real subprogram is still declared on its own outside the block.
    if (/^(function|procedure)\b/.test(uline) && cur && cur.kamusLine !== undefined && !seenAlgo) {
      (cur.prototypeLines = cur.prototypeLines || []).push(n);
      return;
    }
    if (/^function\b/.test(uline)) {
      if (unitStackDepth() > 0 || cur) diags.push(lineErr(n, rawLines, 'Subprogram must be declared outside program block'));
      const m = uline.match(/^function\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*([a-zA-Z_]\w*))?/);
      if (!m) diags.push(lineErr(n, rawLines, 'Bad function header'));
      cur = { kind: 'function', name: m ? m[1] : '?', startLine: n, endLine: n, params: parseParams(m ? m[2] : ''), retType: m ? (m[3] || null) : null, decls: [], bodyStart: n, rawParams: m ? m[2] : '' };
      if (cur && !cur.retType) diags.push(lineErr(n, rawLines, 'Function needs return type (-> TYPE)'));
      seenKamus = false; seenAlgo = false;
      blockStack.push({ kw: '__unit', line: n, unitBoundary: true });
      return;
    }
    if (/^procedure\b/.test(uline)) {
      if (unitStackDepth() > 0 || cur) diags.push(lineErr(n, rawLines, 'Subprogram must be declared outside program block'));
      const m = uline.match(/^procedure\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)/);
      if (!m) diags.push(lineErr(n, rawLines, 'Bad procedure header'));
      cur = { kind: 'procedure', name: m ? m[1] : '?', startLine: n, endLine: n, params: parseParams(m ? m[2] : '', true), retType: null, decls: [], bodyStart: n, rawParams: m ? m[2] : '' };
      diags.push(...checkISFS(n, raw, toks));
      seenKamus = false; seenAlgo = false;
      blockStack.push({ kw: '__unit', line: n, unitBoundary: true });
      return;
    }
    // unit closers
    if (first === 'endprogram' || first === 'endfunction' || first === 'endprocedure') {
      closeUnit(n, first);
      return;
    }
    if (!cur) { diags.push(lineErr(n, rawLines, 'Statement outside any program/function/procedure')); return; }
    // lines with no keywords are still statements (assignments, calls on bare idents)
    if (!first) {
      if (!seenAlgo && cur.kamusLine !== undefined && n > cur.kamusLine) {
        const am = code.match(/^\s*[a-zA-Z_]\w*(\s*\[[^\]]*\]|\s*->[a-zA-Z_]\w*|\s*\.[a-zA-Z_]\w*)*\s*=(?!=)/);
        if (/:/.test(code)) { parseDecl(code, n, toks, cur, diags, rawLines); return; }
        if (am) { diags.push(lineErr(n, rawLines, 'Assignment inside kamus — move below algoritma')); return; }
        cur.bodyLines = cur.bodyLines || [];
        cur.bodyLines.push(n);
        return;
      }
      if (!seenAlgo && cur.kamusLine === undefined && n > cur.startLine && /:/.test(code)) { parseDecl(code, n, toks, cur, diags, rawLines); return; }
      cur.bodyLines = cur.bodyLines || [];
      cur.bodyLines.push(n);
      return;
    }
    // kamus/algoritma markers
    if (first === 'kamus' || first === 'dictionary') {
      if (seenKamus) diags.push(lineErr(n, rawLines, "Duplicate 'kamus' in unit"));
      seenKamus = true; cur.kamusLine = n; return;
    }
    if (first === 'algoritma' || first === 'algorithm') {
      if (seenAlgo) diags.push(lineErr(n, rawLines, "Duplicate 'algoritma' in unit"));
      seenAlgo = true; cur.algoLine = n; return;
    }
    // block openers
    if (first === 'if' || first === 'case' || first === 'for' || first === 'while' || first === 'repeat') {
      blockStack.push({ kw: first, line: n, unitBoundary: false });
      cur.bodyLines = cur.bodyLines || [];
      cur.bodyLines.push(n);
      return;
    }
    // block closers
    if (CLOSERS[first]) {
      cur.bodyLines = cur.bodyLines || [];
      cur.bodyLines.push(n);
      const want = CLOSERS[first];
      // find matching opener above unit boundary
      let idx = blockStack.length - 1;
      while (idx >= 0 && !blockStack[idx].unitBoundary && blockStack[idx].kw !== want &&
        !(want === 'if' && false)) idx--;
      if (idx < 0 || blockStack[idx].unitBoundary) {
        diags.push(lineErr(n, rawLines, `Stray '${first}' with no open '${want}'`));
      } else {
        // any blocks opened after idx are unclosed
        while (blockStack.length - 1 > idx) {
          const b = blockStack.pop();
          diags.push(lineErr(b.line, rawLines, `Unclosed '${b.kw}'`));
        }
        blockStack.pop();
      }
      return;
    }
    if (first === 'else') {
      // must be inside an if (else-if chains share the same if) or a case (else: branch)
      if (/^\s*else\s+if\b/.test(raw)) { // else-if: still inside open if, but its condition is code
        cur.bodyLines = cur.bodyLines || [];
        cur.bodyLines.push(n);
        return;
      }
      const inner = [...blockStack].reverse().find(b => !b.unitBoundary && (b.kw === 'if' || b.kw === 'case'));
      if (!inner) diags.push(lineErr(n, rawLines, "'else' outside 'if'/'case'"));
      return;
    }
    // kamus declaration lines (before algoritma) vs body statements
    // multi-line struct: "type X : <" ... ">" — slurp whole span as one decl
    if (!seenAlgo) {
      const structOpen = code.trim().match(/^type\s+([a-zA-Z_]\w*)\s*(:?)\s*<\s*(.*)$/);
      if (structOpen && !code.includes('>')) {
        if (!structOpen[2]) diags.push(lineErr(n, rawLines, `Struct 'type ${structOpen[1]}' needs ':' — use 'type ${structOpen[1]} : < ... >'`));
        let j = n + 1, fields = structOpen[3];
        const fieldLine = (k) => blankComments(rawLines[k], lines[k]).trim();
        while (j < rawLines.length && !fieldLine(j).includes('>')) { fields += ' ' + fieldLine(j); j++; }
        if (j < rawLines.length) fields += ' ' + fieldLine(j);
        else { diags.push(lineErr(n, rawLines, `Unclosed struct 'type ${structOpen[1]}' — missing '>'`)); }
        for (const fl of fields.split(',')) {
          const seg = fl.replace(/>.*$/, '').trim();
          if (seg && !/^[a-zA-Z_]\w*\s*:/.test(seg))
            diags.push(lineErr(n, rawLines, `Struct field '${seg.slice(0, 20)}' needs ':' — use 'name : type'`));
        }
        cur.decls.push({ name: structOpen[1], type: 'struct', kind: 'struct', line: n, fields });
        for (let k = n + 1; k <= j && k < rawLines.length; k++) consumed.add(k);
        return;
      }
      if (cur.kamusLine !== undefined && n > cur.kamusLine) { parseDecl(code, n, toks, cur, diags, rawLines); return; }
    }
    if (!seenAlgo && cur.kamusLine === undefined) {
      // statement before kamus marker: still treat decl-ish? mark missing kamus lazily
      if (/:/.test(code)) { parseDecl(code, n, toks, cur, diags, rawLines); return; }
    }
    if (seenAlgo) {
      cur.bodyLines = cur.bodyLines || [];
      cur.bodyLines.push(n);
    } else if (cur.kamusLine === undefined) {
      cur.bodyLines = cur.bodyLines || [];
      cur.bodyLines.push(n);
    }
  });

  if (cur) {
    diags.push(lineErr(cur.startLine, rawLines, `Unclosed '${cur.kind} ${cur.name}'`));
    while (blockStack.length && !blockStack[blockStack.length - 1].unitBoundary) {
      const b = blockStack.pop();
      diags.push(lineErr(b.line, rawLines, `Unclosed '${b.kw}'`));
    }
    units.push(cur);
  }
  // post-pass: statements only valid inside algoritma — flag body lines in units with no algoritma marker
  // ponytail: block openers included too — without algoritma the whole executable section is misplaced
  for (const u of units) {
    if (u.algoLine === undefined && (u.bodyLines || []).length) {
      for (const n of u.bodyLines) {
        diags.push(lineErr(n, rawLines, 'Executable statement outside algoritma — add kamus/algoritma markers'));
      }
    }
  }
  return { units, diags, lines };
}

// Replace { comment } tokens with spaces so columns still line up with the raw line.
function blankComments(raw, toks) {
  let s = raw || '';
  for (const t of toks || []) {
    if (t.kind === 'comment') s = s.slice(0, t.col) + ' '.repeat(t.text.length) + s.slice(t.col + t.text.length);
  }
  return s.replace(/\s+$/, '');
}

function parseParams(src, isProc) {
  if (!src.trim()) return []; // zero params is legal: function f() -> T
  // Commas separate BOTH params and grouped names: "in B, C: integer" = one param, two names.
  // Rule: accumulate segments until one contains ':', then flush as a param.
  const segs = splitTop(src, ',');
  const out = [];
  let buf = [];
  const flush = (seg) => {
    let t = [...buf, seg].join(',').trim();
    buf = [];
    if (!t) return;
    // Each name takes the nearest mode written before it: "in a, b, out c: T" -> a,b in; c out.
    const colon = t.indexOf(':');
    const type = t.slice(colon + 1).trim();
    const groups = [];
    for (const part of t.slice(0, colon).split(',')) {
      const m = part.trim().match(/^(?:(in\/out|in|out)\s+)?([a-zA-Z_]\w*)$/);
      if (!m || !type) { out.push({ raw: t, bad: true }); return; }
      const last = groups[groups.length - 1];
      if (last && (!m[1] || m[1] === last.mode)) last.names.push(m[2]);
      else groups.push({ mode: m[1] || null, names: [m[2]] });
    }
    for (const g of groups) out.push({ mode: g.mode || (isProc ? null : 'in'), names: g.names, type, raw: t });
  };
  for (const s of segs) {
    if (s.includes(':')) flush(s);
    else buf.push(s);
  }
  if (buf.length) out.push({ raw: buf.join(','), bad: true });
  return out;
}

function splitTop(s, delim) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '<' || ch === '[' || ch === '(') depth++;
    if (ch === '>' || ch === ']' || ch === ')') depth--;
    if (ch === delim && depth === 0) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseDecl(raw, n, toks, unit, diags, rawLines) {
  const line = raw.trim();
  if (!line || line.startsWith('{')) return;
  let m;
  if ((m = line.match(/^constant\s+([a-zA-Z_]\w*)\s*:\s*(.+?)\s*=\s*(.+)$/))) {
    unit.decls.push({ name: m[1], type: m[2].trim(), kind: 'const', line: n, init: m[3].trim() });
    return;
  }
  if ((m = line.match(/^type\s+([a-zA-Z_]\w*)\s*:\s*<\s*([\s\S]*?)\s*>$/))) {
    for (const fl of m[2].split(',')) {
      const seg = fl.trim();
      if (seg && !/^[a-zA-Z_]\w*\s*:/.test(seg))
        diags.push(err(n, raw.indexOf(seg.slice(0, 10)), raw.indexOf(seg.slice(0, 10)) + 1, `Struct field '${seg.slice(0, 20)}' needs ':' — use 'name : type'`));
    }
    unit.decls.push({ name: m[1], type: 'struct', kind: 'struct', line: n, fields: m[2] });
    return;
  }
  if ((m = line.match(/^type\s+([a-zA-Z_]\w*)\s*:\s*(.+)$/))) {
    unit.decls.push({ name: m[1], type: m[2].trim(), kind: 'typealias', line: n });
    return;
  }
  if ((m = line.match(/^type\s+([a-zA-Z_]\w*)\s*<\s*([\s\S]*?)\s*>$/))) {
    diags.push(err(n, raw.indexOf(m[1]), raw.indexOf(m[1]) + m[1].length, `Struct 'type ${m[1]}' needs ':' — use 'type ${m[1]} : < ... >'`));
    unit.decls.push({ name: m[1], type: 'struct', kind: 'struct', line: n, fields: m[2] });
    return;
  }
  if ((m = line.match(/^(.+?)\s*:\s*(array\s*\[.+?\]|array\s*\[.+|pointer\s+to\s+.+|integer\s*\[[^\]]*\]|integer|real|char|boolean|string|[a-zA-Z_]\w*)\s*$/))) {
    const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
    const badName = names.find(x => !/^[a-zA-Z_]\w*$/.test(x));
    if (badName) { diags.push(err(n, raw.indexOf(badName), raw.indexOf(badName) + badName.length, `Bad variable name '${badName}'`)); return; }
    for (const v of names) unit.decls.push({ name: v, type: m[2].trim(), kind: 'var', line: n });
    return;
  }
  // not a decl: report — either a body statement misplaced in kamus, or garbage
  if (/^\s*[a-zA-Z_]\w*\s*(<-|=(?!=))/.test(raw)) {
    diags.push(lineErr(n, rawLines, 'Assignment inside kamus — move below algoritma'));
    return;
  }
  diags.push(lineErr(n, rawLines, `Not a declaration: '${line.slice(0, 30)}'`));
}

function checkISFS(n, raw, toks) {
  // lookahead impossible here; check comment on header line or next lines handled by caller? keep simple: header-line only warn
  return [];
}

module.exports = { parse, OPENERS, CLOSERS, BASE_TYPES };
