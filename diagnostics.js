// diagnostics.js — vscode-free analyze(), thin vscode wiring in extension.js.
// analyze(text) -> [{line,col,endCol,msg,sev}] sev 0 error,1 warn,2 info.
// Never throws: parser errors become diags; unexpected crash -> fallback regex pass.
const { parse } = require('./parser/parser');
const { check } = require('./parser/symbols');

function analyze(text) {
  try {
    const parsed = parse(text);
    const rawLines = text.split(/\r?\n/);
    const useDiags = check(parsed, rawLines);
    return dedupe([...parsed.diags, ...useDiags]);
  } catch (e) {
    return fallback(text);
  }
}

function dedupe(diags) {
  const seen = new Set();
  return diags.filter(d => {
    const k = `${d.line}:${d.col}:${d.msg}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.line - b.line || a.col - b.col);
}

// ponytail: regex fallback so users still get signal if parser crashes; remove if it ever fires in practice.
function fallback(text) {
  const diags = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, n) => {
    if (/<-/.test(line)) diags.push({ line: n, col: line.indexOf('<-'), endCol: line.indexOf('<-') + 2, msg: "Uses '<-' — use '=' for assignment", sev: 0 });
    if (/output\s*\([^)]*"[^"]*"\s*\+\s*\w+/.test(line)) diags.push({ line: n, col: line.indexOf('+'), endCol: line.indexOf('+') + 1, msg: 'Mixed-type output with \'+\' — use comma', sev: 0 });
  });
  diags.push({ line: 0, col: 0, endCol: 1, msg: 'Parser fallback active (please report file)', sev: 1 });
  return diags;
}

module.exports = { analyze };
