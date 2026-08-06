# @kframework-ts/kore

A TypeScript reader/writer for **K Framework's KORE** — the intermediate
representation `kompile` emits as `definition.kore`, and **KORE-JSON**, the
kore-rpc wire format.

> **Unofficial.** Not affiliated with, endorsed by, or supported by Runtime
> Verification, Inc. or the K Framework maintainers.

## Why this exists

Facilitate working with K's backend-facing representation directly in
TypeScript — alongside `@kframework-ts/kast-json`, which covers the
frontend-facing one. The two formats are independent: nothing here depends on
kast-json, and vice versa.

KORE's authority is split across two repositories, so this package transcribes
from both:

| what                    | authority                                                                 | role                                        |
| ----------------------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| textual grammar         | `haskell-backend` `docs/kore-syntax.md`                                   | the normative BNF                           |
| textual parser/writer   | `k` `pyk/src/pyk/kore/{lexer,parser,syntax}.py`, `pyk/src/pyk/dequote.py` | the transcription sources                   |
| KORE-JSON               | `haskell-backend` `kore-rpc-types/src/Kore/Syntax/Json/Types.hs`          | the normative codec                         |
| KORE-JSON schema        | `haskell-backend` `src/main/json/kore-schema.json`                        | machine oracle, vendored under `fixtures/`  |
| prelude / match / manip | `k` `pyk/src/pyk/kore/{prelude,match,manip}.py`                           | the K-level vocabulary and its destructors  |
| sort & symbol tables    | `k` `pyk/src/pyk/kore/kompiled.py`                                        | subsort lattice, sort inference, injections |

This is a hand-transcription at K **`v7.1.337`** / haskell-backend
**`v0.1.155`** (the submodule commit that K tag pins). A hand-transcription is
not self-verifying, so it is checked against the reference implementations'
own test material, vendored under `fixtures/`: the haskell-backend parser
suite (98 documents with golden outcomes, including negative cases with
positions), the reference JSON codec's golden emissions (41 files), and real
`kompile` output. See `fixtures/PROVENANCE.md`.

```ts
import { K_RELEASE, HASKELL_BACKEND_RELEASE } from "@kframework-ts/kore";
// "v7.1.337", "v0.1.155" — assert these against your own K pin.
```

## Install

```sh
npm install @kframework-ts/kore   # or: bun add / pnpm add / yarn add
```

No runtime dependencies. ESM only, with types. Node 20+, Bun 1.3+.

## Version support

**Textual KORE carries no version marker at all** — a `definition.kore` file
does not say which K wrote it. The grammar has been stable since late 2023;
`check-k` below is how you ask whether that is still true at your K release.

**KORE-JSON is versioned, and only version 1 has ever existed.** The envelope
is `{"format": "KORE", "version": 1, "term": …}`; anything else fails with one
clear message and is never partially read.

### "Does this hold at _my_ K release?" — ask it

```sh
$ npx @kframework-ts/kore check-k v7.1.400
```

It fetches every file recorded in `TRANSCRIBED_FROM` at that release — the
haskell-backend tree is checked at the submodule commit the K tag pins, unless
you pass a second release explicitly — and compares sha256, reporting **two
tiers separately**:

- **format** (the grammar, the reference parser/codec, the pyk sources): a
  diff here means this transcription must be re-verified. This tier decides
  the exit code: 0 unchanged, 1 changed, 3 could not locate, 2 could not run.
- **content** (`ModuleToKORE.java`, which decides what `kompile` _emits_ —
  attributes and axiom vocabulary, not syntax): drift here is advisory and
  printed without affecting the exit code, because it changes routinely while
  the format does not.

The same logic is exported as `checkKoreSources` if you would rather call it
than shell out.

## The shape of the library

One AST, two formats, all of it exported from the package root:

```ts
import {
  parseDefinition,
  parsePattern,
  koreText, // textual KORE
  decodeKoreJson,
  encodeKoreJson, // KORE-JSON
  patternFromJson,
  patternToJson, // pattern-level codec
  enquoteString,
  dequoteString, // the escape codec
  app,
  evar,
  sortApp,
  mlPattern,
  ML_SYMBOLS, // constructors
  bottomUp,
  topDown,
  collect, // traversals
} from "@kframework-ts/kore";

const definition = parseDefinition(await Bun.file("definition.kore").text());
for (const module of definition.modules) {
  for (const sentence of module.sentences) {
    if (sentence.tag === "SymbolDecl") {
      // every node is a discriminated union on `tag`
    }
  }
}
```

The `tag` values are exactly the KORE-JSON tag names (`"App"`, `"EVar"`,
`"Rewrites"`, …), so a decoded JSON pattern and a parsed textual pattern are
the same objects. Two TypeScript names differ from their tags to dodge
globals: the `"String"` node's interface is `KoreString`, and the symbol head
of a declaration is `KoreSymbol`.

### Both are strict; errors carry positions or paths

A KORE document is one artifact that either is or is not the thing you
expect. The textual parser throws `KoreSyntaxError` with `line`/`col` (the
reference parser's own negative test corpus asserts our positions match its
goldens). The JSON codec throws with a JSON path, and — like the reference
codec, and unlike kast-json — **rejects unknown fields** on pattern objects.

### Rules this package follows

| Your question                                                  | The answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is `\and{S}()` collapsed to `\top{S}()`?                       | **No.** Arity is preserved, as pyk preserves it. The Haskell _internaliser_ collapses; the codec does not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Is `\left-assoc{}(f{}(a,b,c))` expanded?                       | **No.** It parses to a `LeftAssoc` node, preserved through both formats. (scala-kore eagerly expands; we do not.)                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Can I read two-field `And` JSON (`first`/`second`)?            | Yes — accepted on decode and rewritten to `patterns`, exactly as `Types.hs` `modifyAndOr` does. Output always uses `patterns`.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| What is `MultiOr`?                                             | A JSON-only node (`Types.hs`). Its textual form is a plain n-ary `\or`, so writing it as text drops the `assoc` annotation — documented, tested.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Are `String`/`DV` values restricted to latin-1?                | Only with `{latin1: true}`. The reference decoder enforces it; pyk does not; the default here follows pyk.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| How deep a term can I handle?                                  | Any depth. Parser, writers, codecs and traversals all run on explicit work stacks — 100 000-deep terms are in the test suite. The one thing you must not do is hand such a term to `JSON.stringify` yourself: use `encodeKoreJson`.                                                                                                                                                                                                                                                                                                                                       |
| Those `Lbl'Unds'`-mangled symbol names?                        | `ModuleToKORE.java`'s alphanumeric encoding of K labels. `demangleName("Lbl'Unds'List'Unds'")` gives `"Lbl_List_"`; `mangleName` is the exact inverse. (K's own Java _decoder_ is broken for KORE names — see `src/demangle.ts` — so the decode direction transcribes pyk's.)                                                                                                                                                                                                                                                                                             |
| How do I ask what a definition contains?                       | `indexDefinition(def)` builds sort/symbol/alias tables; `isSubsort(table, a, b)` and `meetSorts(table, a, b)` answer the sort lattice the way pyk's `KoreSortTable` does; `resolveSymbol(index, symbol, sorts)` / `inferSort` / `patternSorts` answer sorts the way its `KoreSymbolTable` does; `classifyAxiom(axiom)` names each axiom's role (`rewrite`, `equation`, `subsort`, `no-junk`, …) and extracts rule parts, including the `--enable-kore-antileft` shape pyk cannot read.                                                                                    |
| A real `definition.kore` is 15–71 MB. Will it fit?             | Parse it with `parseDefinition(text, { lazyAxioms: true })`: each axiom keeps its attributes and records its body as a source span instead of an AST, which is where all the memory was. `indexDefinition` accepts the result and builds exactly the same tables; `forceAxiom(text, axiom)` parses one body when you need it.                                                                                                                                                                                                                                             |
| Where is the KORE prelude?                                     | `@kframework-ts/kore/prelude` — the sorts (`SORT_K`, `BOOL`, …), `inj()`/`kseq()`, `boolDv`/`intDv`/`bytesDv`/`strDv`/`kConfigVar`, the Bool and Int operator symbols (`andBool`, `ltInt`, …), the collection builders (`listPattern`/`setPattern`/`mapPattern`/`rangemapPattern`, cell collections included) and the configuration builders (`generatedTop`, `k`, `topCellInitializer`). A subpath rather than part of the barrel because its names (`BOOL`, `STRING`, `TRUE`, `inj`) collide with `@kframework-ts/kast/prelude/*`, and a converter imports both.        |
| How do I read a value back out of a term the backend returned? | `matchApp`/`matchDv`/`matchInj`, the collection decoders `matchList`/`matchSet`/`matchMap(p, {cell})`/`matchRangeMap`, the domain-value readers `koreInt`/`koreBool`/`koreStr`/`koreBytes`/`koreId`, and a combinator layer for naming a projection once — `appOf`, `argAt`/`argNamed`, `argsAt`/`argsNamed` (**by head symbol**, so a projection survives `kompile` reordering the cells), `koreListOf`/`koreSetOf`/`koreMapOf`/`koreRangeMapOf`, `caseSymbol`. Exported from the package root; a shape mismatch throws `KoreMatchError` carrying the offending subterm. |
| I built a term from `prelude` and the backend rejects it.      | It needs sort injections. `addInjections(indexDefinition(def), term, sort)` inserts them against that definition's sort lattice, or throws `KoreInjectionError` naming the subterm and both sorts. (pyk's `KompiledKore.add_injections`; `sort` defaults to `SortK{}`, as pyk's does.)                                                                                                                                                                                                                                                                                    |

## What is deliberately not here

- **Validity checking** (`kore-syntax.md` §Validity — arity agreement, sort
  scoping, import topology). The parser accepts anything grammatical; the
  vendored corpus marks which fixtures the reference _verifier_ rejects, so
  a future checker has its suite waiting.
- **Binary KORE** (the llvm-backend format) and **kore-rpc** transport. KAST↔KORE
  conversion lives in `@kframework-ts/konvert`.
- **pyk's JSON↔KORE bridge** (`kore/prelude.py:269-388` — `SORT_JSON`,
  `json_to_kore`, `kore_to_json`). Two reasons: `SortJSON`/`LblJSONs` are
  declared by the K standard library's `JSON` module, which a semantics opts
  into, not by `prelude.kore` — every other name in `prelude.ts` is universal —
  and pyk's read half cannot read pyk's own write half
  (`json_to_kore` emits `\right-assoc{}(LblJSONs{}(…))`; `_iter_json_list`
  walks binary applications, so `kore_to_json(json_to_kore([1]))` raises).
  Build it beside the consumer that needs it, against that consumer's terms.
- **pyk's `Chainable` `>>` operator** over the `match` combinators. It exists
  to give Python a composition operator; `(p) => argAt(0)(appOf(s)(p))` needs
  none.
- **Arithmetic on `Int`.** `prelude.ts` carries the six comparisons pyk carries
  (`eqInt`, `neInt`, `gtInt`, `geInt`, `ltInt`, `leInt`) and no `+Int`/`*Int`:
  pyk does not vouch for those spellings and neither does this package.

### Module by module, against pyk's `kore` package

| pyk module      |     | here                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `syntax.py`     | ✅  | `src/syntax.ts` — the AST, constructors, traversals, textual writer                                                                                                                                                                                                                                                                                                                                                             |
| `lexer.py`      | ✅  | `src/lexer.ts`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `parser.py`     | ✅  | `src/parser.ts`, plus a `lazyAxioms` mode pyk has no equivalent of                                                                                                                                                                                                                                                                                                                                                              |
| `../dequote.py` | ✅  | `src/escape.ts`                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `manip.py`      | ✅  | `src/manip.ts` — all five functions                                                                                                                                                                                                                                                                                                                                                                                             |
| `match.py`      | ✅  | `src/match.ts` — all matchers, decoders and combinators (see the `>>` note above)                                                                                                                                                                                                                                                                                                                                               |
| `prelude.py`    | ⚠️  | `src/prelude.ts` — everything but the JSON bridge (above)                                                                                                                                                                                                                                                                                                                                                                       |
| `kompiled.py`   | ⚠️  | the two tables are `indexDefinition`'s output (`src/definition.ts`), sort resolution is `src/symbols.ts`, `add_injections` is `src/inject.ts`. The `pyk-definition.kore.json` **cache** (`KompiledKore.load`/`write`/`to_dict`/`from_dict`) is not ported: it is a pickling optimisation for a slow Python parser, and it is `KompiledKore.load`'s mtime comparison that decides staleness — a policy a caller here should own. |
| `internal.py`   | ⚠️  | `Collection` is `collectionInfo`; `KoreDefn`'s tables are `KoreDefinitionIndex`. Its **projection/slicing** operations (`project_to_symbols`, `project_to_rewrites`, `filter_rewrites`) — the KLean definition-pruning pipeline — are not ported.                                                                                                                                                                               |
| `rule.py`       | ❌  | axiom→`Rule` internalisation and `to_axiom`. `classifyAxiom` (`src/definition.ts`) answers the read direction this package needed, including the `--enable-kore-antileft` shape pyk cannot read; the write direction has no consumer yet.                                                                                                                                                                                       |
| `rpc.py`        | ❌  | the kore-rpc JSON-RPC client. Transport belongs with a client package.                                                                                                                                                                                                                                                                                                                                                          |
| `pool.py`       | ❌  | the `KoreServer` process pool. Same.                                                                                                                                                                                                                                                                                                                                                                                            |
| `tools.py`      | ❌  | `PrintOutput`/`kore_print`, which shells out to `kore-print`.                                                                                                                                                                                                                                                                                                                                                                   |

## Development

```sh
bun install
bun test              # unit + conformance; no K install, no network
bun run check:types
bun run build
```

Conventions are the monorepo's: `.js` import specifiers inside `src/`, `.ts`
in tests; fixtures are byte-exact upstream copies that the formatter is
configured never to touch.

## Licensing

Dual licensed under either of

- Apache License, Version 2.0 (`LICENSE-APACHE`)
- MIT license (`LICENSE-MIT`)

at your option. `MIT OR Apache-2.0` is the SPDX expression in `package.json`.

Separately, this package is a close transcription of BSD-3-Clause licensed
sources from the K Framework and the haskell-backend, and BSD-3-Clause's
terms continue to govern that transcribed material whichever of the two
licenses above you take this package under. Both required notices are carried
in **`THIRD-PARTY-NOTICES.md`**, which ships with the package.
