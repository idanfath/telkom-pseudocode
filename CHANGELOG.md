# Changelog

## 0.7.0

Checker:

- Statement and expression syntax is checked before Run, using the runner's own grammar: missing `then` / `do` / `of` / `to`, incomplete or malformed expressions (`x = (1 +`, `x = = 3`, `x + 1` as a statement), missing `)` / `]`, code after `then`, `input()` with no variable. Errors point at the column.
- `return` is checked per unit: not allowed in the program, needs a value in a function, takes none in a procedure.
- Unknown types in variables, arrays, pointers, struct fields, parameters and return types (`x : Foo`).
- Reserved words as names (`program if`, `to : integer`, `function do()`, parameter `then`).
- Duplicate function/procedure names.
- Procedure parameter without `in` / `out` / `in/out`: warning.
- Missing blank line between `endprogram`/`endfunction`/`endprocedure` and the next declaration (skill rule).
- `function` / `procedure` headers inside `kamus` (prototype style from some course material, incl. Slide 00 `I:B,C:integer; O:A:integer`) are accepted and ignored. A subprogram header in `algoritma` is still an error.

Runner:

- `==` / `!=` / `<` … on whole structs or arrays is a type error (was always `true` for structs). Compare fields/elements.
- `mod` truncates like `div` (as in C/Go): `-7 div 3 = -2`, `-7 mod 3 = -1`, so `q * d + r = n` holds. Was floored (`2`). Unconfirmed with lecturer.
- Malformed `for` / `while` / `case` headers and `return` in the program are clean errors even when the static gate is bypassed.

Editor:

- Field completion follows the whole access chain: `p->next->`, `(p->next)->`, `((L.first)->next)->`, `d[i].`, `g[0][1].`, inside calls and conditions.
- Completion offers the current function (recursion), and `algoritma` in a subprogram header or inside `kamus`.
- F2 rename updates constants used in kamus types (`array[0..N-1]`, also in subprogram kamus) and refuses reserved words and builtins as the new name.
- Indentation: `else if … then`, `else:`, case labels and lines ending in a `{ comment }` indent the next line; `algoritma` dedents to `kamus` level.
- Folding: only column-0 `program` / `function` / `procedure` start a fold, so a prototype in `kamus` doesn't.
- Run: Esc at the input box cancels the run; the box is only shown when `input(` is code (not in a comment or string).
- One output channel each for Run and Check File (was a new channel per command).
- Diagnostics for every `.pseudo` file already open at startup, and typing in two files no longer cancels one file's refresh.
- `scripts/check-extension.mjs`: extension wiring tested against a fake `vscode` module.

## 0.6.0

Runner correctness and the skill's own patterns. Programs that ran with wrong results before:

- Nested `if`: an `else` after an inner `endif` now belongs to the outer `if` (also `else:` of an enclosing `case`). Previously the wrong branch ran silently.
- `and` / `or` short-circuit: the skipped side is not evaluated, so `while p != NIL and p->info != v` (skill `search`) reaches the end of a list, and skipped function calls no longer run.
- `array[0..MAX]` uses the declared constant (was hardcoded to 100). Bounds may be constant expressions: `[0..MAX-1]`, `[1..N*2]`; a non-constant or undeclared bound is a runtime error at its declaration.
- Grouped params take the nearest mode: `in a, out b: integer` makes `b` an `out` param (was silently `in`).
- Hex literals `0xFF` evaluate to their value (were 0).

Valid programs that were rejected:

- Subprograms read and write the program's kamus variables and constants (skill subprogram rule 2), also when written above the program.
- Arrays as parameters (skill rule 4): copied for `in`, shared for `in/out`; bounds must match. Whole-array assignment is still an error.
- Array elements, struct fields and pointer fields work as `input(...)` targets, `in/out`/`out` arguments, and `allocate`/`deallocate` targets: `input(arr[i])`, `swap(arr[0], arr[1])`, `allocate(p->next)`.
- Array element types are kept: struct arrays, subrange arrays (range enforced) and 2D arrays.
- Parenthesised targets: `(P->info).nim = 1234`, `((L.first)->next)->info = 5`; spaces around `->`.
- `&a` is a pointer value: `output(&a)` prints a hex address, `p == &a`, `f(&a)` to a pointer param.
- `dictionary` / `algorithm` accepted as `kamus` / `algoritma` (was read as a second program).
- Nested `repeat ... until`.
- Trailing `{ comments }` on `if ... then`, `case` labels, loop headers, declarations, struct lines, and after `output(...)`.
- `if x<-1 then` is a comparison; `z <- 3` is still flagged.
- `output("Halo " + s)` with `s` a string is concatenation, not a mixed-output error.
- `t = s[i]` with `t` a string gives a 1-char string (skill, unconfirmed); `s[i] = 'a'` stays an error.
- Run executes on a worker thread: recursion reaches the 1000 cap (was a stack crash near 500), and a long run no longer freezes VS Code. Out of stack in-process is now a clean, located error that keeps earlier output.

Editor:

- F2 rename no longer edits keywords when renaming `p`, `f`, `e`, `o`, … (e.g. `procedure p` became `cetakrocedure p`).
- F2 rename and diagnostics include `else if` conditions (undeclared names there are now flagged).

## 0.5.0

- F2 rename: scope-aware multi-edit for variables, params, loop vars, subprogram names, type names. Keywords/builtins/fields/strings/comments excluded.
- Indent: `program`/`function`/`procedure` no longer indent next line; `kamus`/`algoritma`/`type X : <` indent; `>` dedents.
- Struct requires colon: `type X : < ... >`; old `type X <` flags error (runner still tolerates). Struct fields also require `:`.
- Run button restored in editor title bar (play icon) + Ctrl+F5.
- `scripts/check-rename.mjs`, indent regression tests in `check-grammar.mjs`.

## 0.4.0

- Strictness: undeclared `for` loop var errors (static squiggle + `Undeclared loop variable 'i'` at runtime).
- Type errors enforced: wrong-type assignment (incl. struct fields, array elements, `p->f`, aliases, subranges), wrong-type `in` argument, `in/out` lvalue declared type, function return type. `int → real` still allowed; `NIL` fits any pointer.
- Static literal check: bare literal vs declared base type squiggles in the editor (expressions/chains enforced by runner).
- Dynamic completion from kamus: variables (typed), program blocks, builtins (`allocate`, `output`, `input`), declared function/procedure names.
- Fixtures: `err_loopvar`, `err_wrongtype`, `err_paramtype`.

- Run button in editor title bar (play icon) + Ctrl+F5 shortcut for `.pseudo` files.

## 0.3.1

- Subrange type `integer[lo..hi]` (Slide 00 Struktur Data p.6): decl parsing, inverted-bounds static error, runtime range check on assign/input.
- `samples/run/run_subrange.pseudo`, `err_subrange.pseudo`.

## 0.3.0

- Runner: `Telkom Pseudocode: Run File` — tree-walk interpreter with static gate, input box, output channel, `Runtime error at line N: msg`.
- Covers: expr/types/control/subprograms (in/out/in-out, recursion 1000, step cap), arrays/structs/strings, heap pointers (`&`, `*`, `->`, allocate/deallocate, NIL/use-after-free/double-free errors, leak warning).
- `parser/interpreter.js`, `samples/run/*.pseudo` (22 fixtures), `scripts/check-interpreter.mjs`.

## 0.2.0

- Live diagnostics (parser-based): undeclared identifiers, use-before-assign, duplicate declarations, `<-`, mixed `+` output, `array[0..MAX]`, bare `for to n`, unclosed/stray blocks, procedure I.S./F.S. hint. Triggers on open/type/save.
- New `parser/` (tokenizer, block parser, symbol checks), `diagnostics.js`, `samples/bad.pseudo`, `scripts/check-diagnostics.mjs`.
- `checkFile` command now reports live diagnostics.

## 0.1.0

- TextMate grammar, language config, snippets, check command, samples, check script.
