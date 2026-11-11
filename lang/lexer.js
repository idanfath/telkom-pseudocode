// Lexer. Line-oriented: a token never spans lines (a { comment } can, as one token per line).
// This file holds the only list of reserved words in the project.
'use strict';

/**
 * @typedef {'comment'|'string'|'char'|'number'|'keyword'|'constant'|'ident'|'op'|'sep'|'error'} TokenKind
 * @typedef {object} Token
 * @property {TokenKind} kind
 * @property {string} text      canonical text (keywords are always lowercase here)
 * @property {number} line      0-based
 * @property {number} col       0-based
 * @property {string} [badCase] original spelling when a keyword was written in the wrong case
 */

const UNIT_OPEN = ['program', 'function', 'procedure'];
const UNIT_CLOSE = ['endprogram', 'endfunction', 'endprocedure'];
const SECTION = ['kamus', 'algoritma', 'dictionary', 'algorithm'];
const STATEMENT = [
  'return', 'if', 'then', 'else', 'endif', 'case', 'of', 'endcase', 'for', 'to', 'do', 'endfor',
  'while', 'endwhile', 'repeat', 'until', 'input', 'output', 'allocate', 'deallocate',
];
const BASE_TYPES = ['integer', 'real', 'char', 'boolean', 'string'];
const TYPE_WORDS = [...BASE_TYPES, 'array', 'pointer', 'type', 'constant'];
const MODES = ['in', 'out', 'in/out'];
const WORD_OPS = ['div', 'mod', 'and', 'or', 'not'];
const CONSTANTS = ['true', 'false', 'NIL'];
const BUILTIN_FUNCTIONS = ['len'];

const KEYWORDS = new Set([...UNIT_OPEN, ...UNIT_CLOSE, ...SECTION, ...STATEMENT, ...TYPE_WORDS, ...MODES, ...WORD_OPS]);
/** Every word a user-chosen name may not be. */
const RESERVED = new Set([...KEYWORDS, ...CONSTANTS, ...BUILTIN_FUNCTIONS]);
// lowercase spelling -> canonical spelling, to recognise PROGRAM / Kamus / nil
const BY_LOWER = new Map([...KEYWORDS, ...CONSTANTS].map(w => [w.toLowerCase(), w]));

const OPS2 = ['==', '!=', '<=', '>=', '->', '..', '<-'];

/**
 * @param {string} line
 * @param {number} lineNo
 * @param {{inComment: boolean}} state carried across lines for multi-line comments
 * @returns {Token[]}
 */
function tokenizeLine(line, lineNo, state) {
  /** @type {Token[]} */
  const toks = [];
  let i = 0;
  const push = (kind, text, col, extra) => toks.push({ kind, text, line: lineNo, col, ...extra });
  while (i < line.length) {
    const ch = line[i];
    if (state.inComment) {
      const end = line.indexOf('}', i);
      if (end === -1) { push('comment', line.slice(i), i); i = line.length; }
      else { push('comment', line.slice(i, end + 1), i); i = end + 1; state.inComment = false; }
      continue;
    }
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === '{') {
      const end = line.indexOf('}', i);
      if (end === -1) { push('comment', line.slice(i), i); state.inComment = true; i = line.length; }
      else { push('comment', line.slice(i, end + 1), i); i = end + 1; }
      continue;
    }
    if (ch === '}') { push('error', '}', i); i++; continue; }
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
    const rest = line.slice(i);
    const chm = rest.match(/^'(\\.|[^'\\])'/);
    if (chm) { push('char', chm[0], i); i += chm[0].length; continue; }
    if (ch === "'") { push('error', "'", i); i++; continue; }
    const num = rest.match(/^0[xX][0-9a-fA-F]+|^\d+\.\d+|^\d+/);
    if (num) { push('number', num[0], i); i += num[0].length; continue; }
    const word = rest.match(/^in\/out\b|^[a-zA-Z_]\w*/);
    if (word) {
      const w = word[0];
      const canon = KEYWORDS.has(w) || CONSTANTS.includes(w) ? w : BY_LOWER.get(w.toLowerCase());
      if (!canon) push('ident', w, i);
      else push(CONSTANTS.includes(canon) ? 'constant' : 'keyword', canon, i, canon === w ? undefined : { badCase: w });
      i += w.length;
      continue;
    }
    const op2 = line.slice(i, i + 2);
    // 'x<-1' in a condition is '<' then '-'; only an assignment-shaped line has the '<-' arrow
    if (op2 === '<-' && !isAssignArrow(line, i)) { push('op', '<', i); i++; continue; }
    if (OPS2.includes(op2)) { push('op', op2, i); i += 2; continue; }
    if ('=<>+-*/&()[].'.includes(ch)) { push('op', ch, i); i++; continue; }
    if (':,;'.includes(ch)) { push('sep', ch, i); i++; continue; }
    push('error', ch, i); i++;
  }
  return toks;
}

// '<-' at column i is the (banned) assignment arrow when everything before it is just a
// target: z, arr[i], p->info, *p. After 'if' / 'until' / 'output(' / '=' it is a comparison.
function isAssignArrow(line, i) {
  const pre = line.slice(0, i);
  const fw = pre.match(/^\s*([a-zA-Z_]\w*)/);
  if (fw && KEYWORDS.has(fw[1])) return false;
  return /^\s*\*?\s*[a-zA-Z_(][\w\s.[\]()>-]*$/.test(pre);
}

/**
 * @param {string} text
 * @returns {{lines: Token[][], unclosedComment: boolean}}
 */
function tokenize(text) {
  const state = { inComment: false };
  const lines = text.split(/\r?\n/).map((l, n) => tokenizeLine(l, n, state));
  return { lines, unclosedComment: state.inComment };
}

module.exports = {
  tokenize, tokenizeLine,
  KEYWORDS, RESERVED, BASE_TYPES, BUILTIN_FUNCTIONS, UNIT_OPEN, UNIT_CLOSE, SECTION, STATEMENT, MODES,
};
