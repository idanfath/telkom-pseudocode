// Tokenizer: line-oriented. Shared by diagnostics now, typecheck later.
// Token: {kind, text, line, col}. line 0-based.
const KEYWORDS = new Set([
  'program', 'kamus', 'algoritma', 'endprogram', 'dictionary', 'algorithm',
  'function', 'endfunction', 'procedure', 'endprocedure', 'return',
  'if', 'then', 'else', 'endif', 'case', 'of', 'endcase',
  'for', 'to', 'do', 'endfor', 'while', 'endwhile', 'repeat', 'until',
  'input', 'output', 'allocate', 'deallocate',
  'integer', 'real', 'char', 'boolean', 'string', 'array', 'of', 'pointer', 'to', 'type', 'constant',
  'in', 'out', 'div', 'mod', 'and', 'or', 'not', 'true', 'false', 'NIL',
]);
const KEYWORD_RE = /^(in\/out|endprogram|endfunction|endprocedure|endcase|endif|endfor|endwhile|dictionary|algorithm|program|kamus|algoritma|function|procedure|return|if|then|else|case|of|for|to|do|while|repeat|until|input|output|allocate|deallocate|integer|real|char|boolean|string|array|pointer|type|constant|div|mod|and|or|not|true|false|NIL)\b/;

function tokenizeLine(line, lineNo, state) {
  const toks = [];
  let i = 0;
  const push = (kind, text, col) => toks.push({ kind, text, line: lineNo, col });
  while (i < line.length) {
    const ch = line[i];
    // inside multiline comment
    if (state.inComment) {
      const end = line.indexOf('}', i);
      if (end === -1) { push('comment', line.slice(i), i); i = line.length; }
      else { push('comment', line.slice(i, end + 1), i); i = end + 1; state.inComment = false; }
      continue;
    }
    if (ch === ' ' || ch === '\t') { i++; continue; }
    // comment start
    if (ch === '{') {
      const end = line.indexOf('}', i);
      if (end === -1) { push('comment', line.slice(i), i); state.inComment = true; i = line.length; }
      else { push('comment', line.slice(i, end + 1), i); i = end + 1; }
      continue;
    }
    // stray close brace outside comment
    if (ch === '}') { push('error', '}', i); i++; continue; }
    // string
    if (ch === '"') {
      let j = i + 1, closed = false;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === '"') { closed = true; break; }
        j++;
      }
      if (closed) { push('string', line.slice(i, j + 1), i); i = j + 1; }
      else { push('error', line.slice(i), i); i = line.length; }
      continue;
    }
    // char
    const chm = line.slice(i).match(/^'(\\.|[^'\\])'/);
    if (chm) { push('char', chm[0], i); i += chm[0].length; continue; }
    if (ch === "'") { push('error', "'", i); i++; continue; }
    // hex
    const hex = line.slice(i).match(/^0[xX][0-9a-fA-F]+/);
    if (hex) { push('number', hex[0], i); i += hex[0].length; continue; }
    // number (real before int)
    const num = line.slice(i).match(/^\d+\.\d+|^\d+/);
    if (num) { push('number', num[0], i); i += num[0].length; continue; }
    // keyword / ident
    const kw = line.slice(i).match(KEYWORD_RE);
    if (kw) { push(kw[1] === 'NIL' || kw[1] === 'true' || kw[1] === 'false' ? 'constant' : 'keyword', kw[1], i); i += kw[1].length; continue; }
    const id = line.slice(i).match(/^[a-zA-Z_]\w*/);
    if (id) { push('ident', id[0], i); i += id[0].length; continue; }
    // multi-char operators longest first
    const op2 = line.slice(i, i + 2);
    // 'x<-1' in a condition is '<' then '-'; only an assignment-shaped line has the '<-' arrow
    if (op2 === '<-' && !isAssignArrow(line, i)) { push('op', '<', i); i++; continue; }
    if (['==', '!=', '<=', '>=', '->', '..', '<-'].includes(op2)) { push('op', op2, i); i += 2; continue; }
    if ('=<>+-*/&():,;.[]'.includes(ch)) { push(ch === ':' || ch === ',' || ch === ';' ? 'sep' : 'op', ch, i); i++; continue; }
    push('error', ch, i); i++;
  }
  return toks;
}

// '<-' at col i is an (old-style) assignment arrow when everything before it is just a
// target: z, arr[i], p->info, *p. After 'if'/'until'/'output('/'=' it is a comparison.
function isAssignArrow(line, i) {
  const pre = line.slice(0, i);
  const fw = pre.match(/^\s*([a-zA-Z_]\w*)/);
  if (fw && KEYWORDS.has(fw[1])) return false;
  return /^\s*\*?\s*[a-zA-Z_][\w\s.[\]()>-]*$/.test(pre);
}

function tokenize(text) {
  const lines = text.split(/\r?\n/);
  const state = { inComment: false };
  const out = lines.map((l, n) => tokenizeLine(l, n, state));
  return { lines: out, unclosedComment: state.inComment };
}

module.exports = { tokenize, tokenizeLine, KEYWORDS };
