# Telkom Pseudocode for VS Code

Syntax highlighting, live diagnostics, dynamic kamus-based completion, and a `.pseudo` runner for Telkom University pseudocode (`.pseudo`, `.tpseudo`).

## Features

- TextMate highlighting: comments `{ }`, strings `".."`, chars `'..'`, integers, reals, hex, keywords (`program/kamus/algoritma/endprogram`, `function/procedure`, `if/case/for/while/repeat`), types, `NIL`, booleans, operators (`div/mod/and/or/not`, `==/!=/<=/>=`, `->`, `&`, `*`, `..`), function calls, `type` names, `->field` properties.
- Language config: `{ }` comment toggle, bracket match/close, indent rules for all blocks, folding on block pairs.
- Snippets: `program`, `function`, `procedure`, `if`, `case`, `for`, `while`, `repeat`, `array`, `struct`, `sll`, `output`.
- Live diagnostics (also `Telkom Pseudocode: Check File`): statement/expression syntax, undeclared names, unknown types, reserved words as names, duplicate declarations and subprograms, `<-`, mixed `output("x" + number)`, `array[0..MAX]`, bare `for ... to n`, blank-line rules, procedure I.S./F.S. and parameter modes.
- `function` / `procedure` headers inside `kamus` (prototype style) are accepted and ignored for now; declare the subprogram itself outside the block.
- Command `Telkom Pseudocode: Run File`: runs the program. Static errors block the run; runtime errors print as `Runtime error at line N: msg`. If the program calls `input(...)`, a box asks for space-separated values.
- Dynamic completion: declared variables (with types), program blocks, builtins, declared functions/procedures. Undeclared `for` loop vars error; wrong-type assignment/argument/return errors.

## Run semantics (deviations documented)

- Every variable, pointers included, must be assigned before it is read (`p = NIL` to start a pointer empty).
- `integer / integer` is an error (use `div`). `real div real` allowed (unconfirmed with lecturer).
- `s[i]` read yields `char`; write with single-char string (unconfirmed).
- Coercions: `int → real`, and `char → string` on assignment to a string variable. Struct assign deep-copies. Array assign always errors; arrays pass as parameters (copied for `in`, shared for `in/out`).
- Array bounds are constant expressions over declared constants: `array[0..MAX-1]`.
- Subprograms see the program's kamus variables and constants; their own kamus shadows them.
- Subrange `integer[0..100]` enforced on assign and input; inverted bounds are a static error.
- `&x` prints as a hex address (stable within a run).
- Whole structs and arrays don't compare (`==`, `<`, …): compare fields / elements.
- `div` and `mod` both truncate toward zero: `-7 div 3 = -2`, `-7 mod 3 = -1` (unconfirmed with lecturer).
- Heap leaks print a warning, not an error. Recursion cap 1000, step cap 500000. Run uses a worker thread, so a long program does not block the editor.

## Unconfirmed rules (implemented as the skill states; check with your lecturer)

- `s[i]` read yields `char`, coerces to `string` on assignment; write with `"a"` ok, `'a'` mismatch.
- `integer / integer` disallowed (use `div`); `real div real` allowed.
- `repeat` runs at least once, stops when condition true.

## Dev

```bash
npm run check   # grammar, diagnostics, runner, completion, rename — zero deps
```

Press `F5` in VS Code to open Extension Development Host, open `samples/*.pseudo`, run `Developer: Inspect Editor Tokens and Scopes` to verify.

## Package

```bash
npm i -g @vscode/vsce && vsce package
```
