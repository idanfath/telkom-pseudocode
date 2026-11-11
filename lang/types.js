// Resolved types, shared by the checker (static) and the runner (dynamic), so both apply
// the same rules about what fits where.
'use strict';

/**
 * @typedef {{k: 'int'} | {k: 'real'} | {k: 'char'} | {k: 'bool'} | {k: 'string'}
 *   | {k: 'subrange', lo: number, hi: number}
 *   | {k: 'array', lo: number|null, hi: number|null, elem: Type, boundError?: {line: number, msg: string}}
 *   | {k: 'pointer', target: Type}
 *   | {k: 'struct', name: string, fields: Map<string, Type>}
 *   | {k: 'nil'}
 *   | {k: 'unknown'}} Type
 * 'nil' is the type of the literal NIL. 'unknown' stands in after an error and fits
 * everything, so one mistake is reported once.
 */

const INT = Object.freeze({ k: 'int' });
const REAL = Object.freeze({ k: 'real' });
const CHAR = Object.freeze({ k: 'char' });
const BOOL = Object.freeze({ k: 'bool' });
const STRING = Object.freeze({ k: 'string' });
const NIL = Object.freeze({ k: 'nil' });
const UNKNOWN = Object.freeze({ k: 'unknown' });
const BASE = { integer: INT, real: REAL, char: CHAR, boolean: BOOL, string: STRING };

const isUnknown = (t) => t.k === 'unknown';
const isInt = (t) => t.k === 'int' || t.k === 'subrange';
const isNum = (t) => isInt(t) || t.k === 'real';
const isCompound = (t) => t.k === 'array' || t.k === 'struct';
/** types input() can read into */
const isSimple = (t) => isNum(t) || t.k === 'char' || t.k === 'bool' || t.k === 'string';

/** Same type: what an in/out parameter needs. Structs are the same only by name. */
function sameType(a, b, depth = 0) {
  if (a === b || isUnknown(a) || isUnknown(b)) return true;
  if (isInt(a) && isInt(b)) return true;
  if (a.k !== b.k) return false;
  if (a.k === 'array') return a.lo === b.lo && a.hi === b.hi && sameType(a.elem, b.elem, depth + 1);
  if (a.k === 'pointer') return depth > 8 || sameType(a.target, b.target, depth + 1);
  return a.k !== 'struct';
}

/** A value of type `from` may be stored where `to` is declared (argument, return, assignment). */
function assignable(to, from) {
  if (sameType(to, from)) return true;
  if (to.k === 'real' && isInt(from)) return true;
  return to.k === 'pointer' && from.k === 'nil';
}

/** Two values may be compared with == / != */
function comparable(a, b) {
  if (isUnknown(a) || isUnknown(b)) return true;
  if (isCompound(a) || isCompound(b)) return false;
  const ptr = (t) => t.k === 'pointer' || t.k === 'nil';
  if (ptr(a) || ptr(b)) return ptr(a) && ptr(b);
  return (isNum(a) && isNum(b)) || a.k === b.k;
}

function describe(t) {
  switch (t.k) {
    case 'int': return 'integer';
    case 'bool': return 'boolean';
    case 'subrange': return `integer[${t.lo}..${t.hi}]`;
    case 'array': return `array[${t.lo ?? '?'}..${t.hi ?? '?'}] of ${describe(t.elem)}`;
    case 'pointer': return `pointer to ${t.target.k === 'pointer' ? 'pointer' : describe(t.target)}`;
    case 'struct': return t.name;
    case 'nil': return 'NIL';
    default: return t.k;
  }
}

module.exports = { INT, REAL, CHAR, BOOL, STRING, NIL, UNKNOWN, BASE, isUnknown, isInt, isNum, isCompound, isSimple, sameType, assignable, comparable, describe };
