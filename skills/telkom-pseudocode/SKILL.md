---
name: telkom-pseudocode
description: Write, read, explain, debug, or convert code using Telkom University's pseudocode standard. Use this skill whenever the user mentions "pseudocode", "pseudo", "kamus", "algoritma", "endprogram", or asks to write/check/explain pseudocode in the Telkom University format. Also trigger when the user asks to convert code (Python, Java, C, etc.) into pseudocode, or vice versa.
---

# Telkom University Pseudocode Skill

<!-- Maintainers: every ```pseudo block is checked by scripts/check-skill.mjs in the telkom-pseudocode repo.
     "pseudo" must pass `tpseudo check`; "pseudo wrong" must fail it; "pseudo fragment" is not checked;
     "kamus" wraps declarations in a program; "name=x" / "uses=x" share declarations between blocks. -->

This follows the general Telkom University course standard (Algoritma Pemrograman, Struktur Data). Course material differs between modules; where it does, or where a rule below is marked ⚠️ Unconfirmed, the lecturer's version wins. Say so when a rule you apply is one of those.

## Check Your Pseudocode

`tpseudo` checks and runs this pseudocode. It comes from the same project as this skill (https://github.com/idanfath/telkom-pseudocode). After writing a whole program, function or procedure, save it to a `.pseudo` file and check it:

```bash
npx telkom-pseudocode check file.pseudo     # or, when installed: tpseudo check file.pseudo
```

Fix every `error` it reports and check again; also read the `warning`s and fix the ones that apply. To see what a program prints, run it with any input on stdin:

```bash
echo "3 4" | npx telkom-pseudocode file.pseudo
```

Exit codes: `0` ok, `1` checker errors, `2` runtime error. Errors look like `file.pseudo:12:3: error: message`.

- Check whole units only, not single statements or templates.
- If neither `tpseudo` nor `npx` works (no Node, no network), skip the check and rely on the rules below.
- If the checker and this skill disagree, tell the user: one of them has a bug.

## Basic Rules

- **Comments**: `{ komentar }`
- **Grouping**: `( )` for expression priority
- **Blocks**: Indentation-based, each control block closed with its keyword (`endif`, `endcase`, `endfor`, `endwhile`, `endprogram`, `endfunction`, `endprocedure`)

## Data Types

| Type | Notes | Operators |
|------|-------|-----------|
| `integer` | Whole numbers. No `^` operator. | `+`, `-`, `*`, `div`, `mod`, comparison |
| `real` | Decimals. No `^` operator. | `+`, `-`, `*`, `/`, comparison |
| `char` | Single char in single quotes `'a'`. Stored as ASCII. | comparison |
| `boolean` | `true` or `false` | comparison, `and`, `or`, `not` |
| `string` | Double quotes `"abc"`. Indexed from 0. | `+` (concat), `==`, `!=` only |

- Comparison operators: `==`, `!=`, `<`, `>`, `<=`, `>=`
- Logical: `and`, `or`, `not`
- String `+` only works between **string and string**. To mix types in output, use separate parameters: `output("Hasil:", 10)` → prints `Hasil: 10`
- String indexing: `s[i]` indexed from 0. ⚠️ Unconfirmed (not yet verified with lecturer): reading `s[i]` yields `char` by default, but coerces to `string` when assigned to a `string`-typed variable. Writing `s[i] = "a"` (string literal) is accepted; `s[i] = 'a'` (char literal) errors on type mismatch.
- Division: `integer / integer` is not allowed (use `div`, same meaning). ⚠️ Unconfirmed: `real div real` is allowed, e.g. `1.5 div 1`.
- Subrange type (Slide 00 Struktur Data p.6): `integer[0..23]` constrains values 0 to 23.

## Program Structure

```pseudo fragment
program <nama_program>
kamus
  { deklarasi variabel, konstanta, tipe data, alias }
algoritma
  { instruksi }
endprogram
```

- Program name: no spaces, no leading digits, not a keyword
- English keywords: `dictionary` instead of `kamus` and `algorithm` instead of `algoritma` are acceptable, but Indonesian (`kamus`, `algoritma`) is preferred
- Variables in `kamus` are **not auto-initialized** — always explicitly set before use
- Multiple vars of same type: `a, b : integer`
- ❌ No blank lines between structural keywords — `program`, `kamus`, `algoritma`, and `endprogram` (same for functions/procedures) must form one continuous, unbroken block.

❌ Wrong:
```pseudo wrong
program foo
kamus
  x : integer

algoritma
  x = 0
endprogram
```

✅ Correct:
```pseudo
program foo
kamus
  x : integer
algoritma
  x = 0
endprogram
```

## Kamus Declarations

```pseudo fragment
{ Constant }
constant PI : real = 3.14

{ Type alias }
type desimal : real

{ Struct — titik dua wajib sebelum kurung sudut }
type Mahasiswa : <
  nama : string,
  umur : integer
>

{ Array }
arr : array[0..MAX-1] of integer
data_mhs : array[0..MAX-1] of Mahasiswa

{ Subrange — Slide 00 Struktur Data p.6 }
umur : integer[0..100]

{ Pointer }
type adr : pointer to elmList
p : pointer to integer

{ Access }
arr[i]
data_mhs[i].nama
p->info
```

**Array rules:**
- Index must be integer, `start < end`
- `array[0..MAX]` has size MAX+1 — use `[0..MAX-1]` for MAX elements
- ❌ No direct array-to-array assignment (`arr1 = arr2`)
- ❌ No out-of-bounds access

## Input / Output

```pseudo fragment
input(a, b)        { space-separated input }
output(a, b)       { space-separated output }
output("Halo " + "Dunia")   { string concat }
output("Nilai:", x)          { mixed: prints "Nilai: 42" }
```

## Control Flow

```pseudo fragment
{ If }
if <kondisi> then
  <aksi>
else if <kondisi> then
  <aksi>
else
  <aksi>
endif

{ Case Of — no space before colon, action on indented new line }
case <variabel> of
  <nilai_1>:
    <aksi>
  <nilai_2>:
    <aksi>
  else:
    <aksi>
endcase

{ For — inclusive, runs (end - init + 1) times }
for i = 0 to n-1 do
  <aksi>
endfor

{ While }
while <kondisi> do
  <aksi>
endwhile

{ Repeat Until — runs at least once, stops when condition is true }
repeat
  <aksi>
until <kondisi>
```

**For loop tip:** `for i = 0 to n-1` runs n times. Using `to n` when accessing `arr[i]` risks index out of bounds.

## Functions

- Must `return` a value
- `kamus` section is optional
- Spec in `{ }` after declaration

```pseudo fragment
function <nama>(<p1>: <tipe>, ...) -> <tipe_kembali>
{ ... }
kamus
  { variabel lokal, opsional }
algoritma
  return <nilai>
endfunction
```

Example:
```pseudo
function max(a, b: integer) -> integer
{ Mengembalikan nilai maksimum antara a dan b }
kamus
  result : integer
algoritma
  if a > b then
    result = a
  else
    result = b
  endif
  return result
endfunction

function isEven(n: integer) -> boolean
{ Mengembalikan true jika n genap }
algoritma
  return (n mod 2 == 0)
endfunction
```

## Procedures

- No return value
- Parameters need mode: `in` (pass by value), `out` (output only), or `in/out` (pass by reference)
- Multiple parameters of same mode and type can be grouped: `in B, C: integer, in/out A: integer`
- `kamus` optional
- Must include I.S. / F.S. in spec

```pseudo fragment
procedure <nama>(<mode> <p1>: <tipe>, ...)
{ I.S. ...
  F.S. ... }
kamus
  { variabel lokal, opsional }
algoritma
  <aksi>
endprocedure
```

Example:
```pseudo
procedure swap(in/out a, in/out b: integer)
{ I.S. a dan b memiliki nilai tertentu
  F.S. Nilai a dan b ditukar }
kamus
  temp : integer
algoritma
  temp = a
  a = b
  b = temp
endprocedure

procedure simple_calc(in B, C: integer, in/out A: integer)
{ I.S. B dan C terdefinisi, A siap menerima hasil kalkulasi
  F.S. Nilai A diperbarui }
algoritma
  A = 10 + B - C
endprocedure
```

> ⚠️ **Info — Slide 00 Struktur Data vs Standard:**
> Slide 00 Struktur Data menunjukkan deklarasi prototype prosedur di dalam `kamus` (seperti `procedure simple_calc(I:B,C:integer; O:A:integer)`) dan penulisan terpisah `Input:` / `Output:`. Gaya tersebut tidak konsisten antar modul. Kita memakai gaya standar yang bersih: deklarasi prosedur berdiri sendiri di luar `kamus` dengan sintaks `procedure simple_calc(in B, C: integer, in/out A: integer)`. Konfirmasikan ke dosen pengampu jika dosen secara spesifik mewajibkan penulisan prototype di dalam `kamus`.

## Subprogram Rules

1. Functions and procedures are declared **outside and independent** of the main program block
2. Subprograms can access global variables (declared in main `kamus`)
3. Local variables (in subprogram `kamus`) only accessible within that subprogram
4. When passing arrays with a constant size, use **type alias** for consistency:

```pseudo fragment
program contoh
kamus
  constant MAX : integer = 100
  type myArr : array[0..MAX-1] of integer
  arr : myArr
...
endprogram

function sum(arr: myArr) -> integer
...
endfunction
```

## Pointer & Dynamic Memory

- **Declaration**: `<var> : pointer to <type>` atau alias `type Address : pointer to ElmList` (alias `Address` atau `adr` umum dipakai)
- **Address-of (`&`)**: Mendapatkan alamat memori variabel (e.g. `p = &a`)
- **Dereference (`*`)**: Mengakses atau mengubah nilai pada alamat yang ditunjuk (e.g. `*p = 10`, `val = *p`)
- **Assignment**: Selalu gunakan `=` (alasan resmi materi Telkom: `<-` diubah menjadi `=` untuk menghindari ambiguitas dengan panah pointer `->`)
- **Pointer-to-Pointer**: `p2 = p1` menyalin alamat; `*p2 = *p1` menyalin nilai target
- **Null Value**: `NIL` (pointer kosong / belum menunjuk alamat valid)
- **Arrow Operator (`->`)**: Mengakses field dari record/struct yang ditunjuk pointer (e.g. `p->info`, `p->next`)
- **Nested Field Access**: Jika `info` berupa struct/record, gunakan tanda kurung:
  ```pseudo fragment
  (P->info).nim = 1234
  (P->info).nama = "Aep"
  ```
- **Chained Pointer Access**: Ekspresi pointer berantai memakai tanda kurung:
  ```pseudo fragment
  (P->next)->info
  ((L.first)->next)->info
  ```
- **Alokasi & Dealokasi**:
  - `allocate(p)` — mengalokasikan memori dinamis untuk pointer `p`
  - `deallocate(p)` — membebaskan memori dinamis yang ditunjuk `p`. Catatan: operasi delete pada linked list hanya *unhook* node dari list; node masih berstatus *lost/memory leak* di RAM sampai di-`deallocate(p)`.

Example:
```pseudo
program demo_pointer
kamus
  a, b : integer
  p1, p2 : pointer to integer
algoritma
  a = 10
  p1 = &a
  p2 = p1
  *p2 = 25
  b = *p1

  output("Nilai a:", a)      { prints 25 }
  output("Nilai b:", b)      { prints 25 }
  output("Alamat a:", &a)    { prints hex address, e.g. 0x2024 }
  output("Isi p1:", p1)      { prints hex address }
  output("Nilai *p1:", *p1)  { prints 25 }
endprogram
```

## Abstract Data Type (ADT)

- Memisahkan spesifikasi konseptual (**deklarasi data & operasi**) dari **implementasi** (information hiding & reusability)
- **Singly Linked List (SLL) Structure**:
```pseudo kamus name=sll
type Infotype : integer
type Address : pointer to ElmList
type ElmList : <
  info : Infotype,
  next : Address
>
type List : <
  first : Address
>
```
- **Doubly Linked List (DLL) Structure**:
```pseudo kamus uses=sll
type ElmListDLL : <
  info : Infotype,
  next : Address,
  prev : Address
>
type ListDLL : <
  first : Address,
  last : Address
>
```

- **Pola Primitif Dasar**:
```pseudo uses=sll
procedure Create_List(in/out L : List)
{ I.S. -
  F.S. Pointer first dari List L bernilai NIL }
algoritma
  L.first = NIL
endprocedure

function New_Element(data : Infotype) -> Address
{ Mengembalikan pointer ke elemen baru teralokasi }
kamus
  p : Address
algoritma
  allocate(p)
  p->info = data
  p->next = NIL
  return p
endfunction

function search(L : List, v : Infotype) -> Address
{ Mengembalikan pointer ke elemen berisi v jika ditemukan, atau NIL jika tidak ada }
kamus
  p : Address
algoritma
  p = L.first
  while p != NIL and p->info != v do
    p = p->next
  endwhile
  return p
endfunction
```

## Recursion

- Always include a **base case**
- Tail-end recursion is valid but not recommended unless explicitly required

```pseudo
function factorial(n: integer) -> integer
{ Base case: n == 0 }
algoritma
  if n == 0 then
    return 1
  endif
  return n * factorial(n - 1)
endfunction
```

## Built-in Functions

- `len(s : string) -> integer` — returns length of string `s`

## Common Mistakes to Avoid

| ❌ Wrong | ✅ Correct |
|---------|-----------|
| `arr1 = arr2` | Copy element by element with a loop |
| `output("Nilai: " + x)` where x is integer | `output("Nilai:", x)` |
| Using uninitialized variable | Initialize in `algoritma` before use |
| `array[0..MAX]` for MAX elements | `array[0..MAX-1]` |
| `for i = 0 to n` when accessing `arr[i]` | `for i = 0 to n-1` |
| Declaring function inside program block | Declare independently, outside program |
| `^` for exponentiation | Implement manually or use recursion |
| Empty line between `kamus` and `algoritma` (or anywhere between `program`/`function`/`procedure`, `kamus`, `algoritma`, and their closing keyword) | Keep all structural keywords in one unbroken block — no blank lines between them |
| No blank line separating `end*` from the next `program`/`function`/`procedure` declaration | Always add a blank line after `endprogram`, `endfunction`, or `endprocedure` before the next declaration |
| `p = a` when p is pointer and a is normal variable | `p = &a` to assign address, or `*p = a` to assign value |
| `p.info` when p is a pointer | `p->info` (dot `.` only for direct struct, `->` for pointer to struct) |
| `<-` for assignment | Use `=` consistently |

