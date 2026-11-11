// Rename: findRenameRanges(text, line, char) -> {name, ranges} | null. No VS Code import.
// The analyzer records every place a declared name is written, scope and shadowing
// included, so rename is a lookup: which declaration is under the cursor, and where else
// is it written. Keywords, builtins, fields, strings and comments are never recorded.
'use strict';
const { analyzeProgram } = require('./analyzer');
const { RESERVED } = require('./lexer');

const RESERVED_LOWER = new Set([...RESERVED].map(w => w.toLowerCase()));

function renameRanges(text, line, char) {
  const { refs } = analyzeProgram(text);
  const hit = refs.find(r => r.line === line && char >= r.col && char <= r.endCol);
  if (!hit) return null;
  const seen = new Set();
  const ranges = hit.target.refs
    .filter(r => { const k = `${r.line}:${r.col}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(r => ({ line: r.line, col: r.col, endCol: r.endCol }))
    .sort((a, b) => a.line - b.line || a.col - b.col);
  return { name: hit.target.name, ranges };
}

/** Never throws: any failure means "cannot rename here". */
function findRenameRanges(text, line, char) {
  try {
    return renameRanges(text, line, char);
  } catch {
    return null;
  }
}

/** null if `name` can replace an identifier, else the reason it can't */
function isValidNewName(name) {
  if (!/^[a-zA-Z_]\w*$/.test(name || '')) return 'Invalid name — use letters, digits and underscore, no leading digit.';
  if (RESERVED_LOWER.has(name.toLowerCase())) return `'${name}' is a reserved word — choose another name.`;
  return null;
}

module.exports = { findRenameRanges, renameRanges, isValidNewName };
