# Changelog

## Unreleased

- The agent skill (`skills/telkom-pseudocode/SKILL.md`) lives in this repo. Install it with `npx skills add idanfath/telkom-pseudocode`, as a Claude Code plugin (`/plugin install telkom-pseudocode --marketplace idanfath/telkom-pseudocode`), or upload `telkom-pseudocode-skill.zip` to claude.ai.
- The skill tells the assistant to check whole programs with `npx telkom-pseudocode check` and fix what it reports, and that the lecturer's version wins where course material differs.
- `npm run check` checks every example in the skill against the checker (`scripts/check-skill.mjs`).
- README: the structure rule is "no blank lines between `program` / `kamus` / `algoritma` / `endprogram`" (it read as if blank lines were required).

## 0.9.1

- Fixed: the standalone `tpseudo` executables from 0.9.0 crashed with `ModuleNotFound ... run-worker.js` on any machine but the one that built them. The runner's worker is now bundled into the executable.

## 0.9.0

- `tpseudo`, a command line runner: `tpseudo file.pseudo` checks and runs a file in any terminal (input from the keyboard or a pipe), `tpseudo check` reports problems. Exit codes tell checker errors, runtime errors and success apart. Not included in the extension package.
- Released three ways: on npm (`npm i -g telkom-pseudocode` or `npx telkom-pseudocode`), as standalone executables built with Bun (`npm run build:bin`), and alongside the `.vsix`.
- The project is renamed from `telkom-pseudocode-vscode` to `telkom-pseudocode`, since it is now the checker, runner, extension and command line together.

## 0.8.0

The checker, runner, completion and rename were rewritten on one shared syntax tree (`lang/`). Before, each of them re-read the source text with its own rules.

Run:

- Programs run in a terminal. Output appears as it is printed, and `input(...)` waits for a typed line when the program reaches it (was: one box asking for every value before the run). `Ctrl+C` stops a running program.
- A `string` that is the last variable of an `input(...)` takes the rest of its line, so names with spaces can be read. Values may be spread over several lines.
- Fixed: a `for` loop that never ran, followed by a read of its variable, crashed the runner.
- A `real` variable assigned an integer holds a real, so `r = 1` then `r / 2` works.
- `deallocate` of a pointer to a variable (`p = &a`) is its own error, not "NIL pointer dereference".
- Runtime errors and "done" no longer open a popup; they are in the terminal.

Checker:

- Type errors are reported while typing instead of at Run: wrong-type assignments, arguments, return values and case labels, non-boolean conditions and `and` / `or` / `not` operands, `integer / integer`, arithmetic on the wrong types, comparing structs or arrays, wrong argument counts, unknown fields, indexing a non-array, passing a constant or an expression to an `out` / `in/out` parameter, calling a procedure inside an expression.
- `.` on a pointer and `->` on a struct say which one to use. Assigning a variable to a pointer suggests `&` or `*`.
- Fixed: `input(x)` was flagged with "'x' may be used before assignment".
- Array bounds that are not constants, and `lo > hi`, are errors at the declaration.
- Uppercase keywords (`PROGRAM`, `Integer`, `nil`) are reported once each with the spelling to use (was: "Statement outside any program" on every line).
- `^` gets its own message (there is no power operator).
- A function written inside the program block is reported once and still checked (was: a cascade of errors).
- A function with no `return` at all is a warning. Unused variables are reported for the program too, not only subprograms.
- A struct that contains itself by value, a type alias defined in terms of itself, duplicate fields and duplicate parameters are errors.
- Declarations inside `algoritma` and statements inside `kamus` say where they belong.
- Constants may be constant expressions over earlier constants: `constant M : integer = N * 2`.

Editor:

- Completion and rename read the same model as the checker, so they agree with it about scopes and types. Completion shows resolved types.
- F2 opens on the word under the cursor.

Internal:

- `parser/` and `diagnostics.js` are gone; see the table in the README for `lang/`.
- `scripts/check-robustness.mjs`: about 3000 damaged versions of the samples must not crash the checker, runner, completion or rename.
- Tests for mistakes that moved from runtime to the checker assert both: the checker reports them, and the runner still refuses them when the checker is bypassed.

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
