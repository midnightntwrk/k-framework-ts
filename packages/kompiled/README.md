# @kframework-ts/kompiled

A TypeScript reader for **K Framework's `*-kompiled/` directories** — the
output of `kompile`.

> **Unofficial.** Not affiliated with, endorsed by, or supported by Runtime
> Verification, Inc. or the K Framework maintainers.

## Read this first: the directory has no specification

A `*-kompiled/` directory is about twenty files written by three different
toolchains — the Java frontend, the LLVM backend and the Haskell backend — with
no format specification anywhere. The closest thing to one is the `README.md`
that `kompile` copies into every such directory
(`k-frontend/src/main/resources/org/kframework/utils/file/README.md`, written by
`KompileFrontEnd.java:101-107`), and it ends:

> Note 2: the content and the format of these files are subject to change
> without warning and they should not be relied on for automation outside of
> what is already tested on CI.

That is the honest framing for this package, and it is why the package exists in
this shape rather than pretending otherwise:

- everything is pinned to a **named K release** (`v7.1.337`), recorded in
  `src/version.ts` with sha256s of every source it was read from;
- `kompiled check-k <release>` asks whether those files still say the same thing
  at _your_ release;
- the observed layout is recorded as data (`OBSERVED_LAYOUT`), so a directory
  that has grown or lost a file is a _diagnosable_ condition rather than a crash.

The same K README says: _"Users are encouraged to use the PYK library to
efficiently interact with these files."_ This package is the TypeScript answer
to that sentence.

## Install

```sh
npm install @kframework-ts/kompiled   # or: bun add / pnpm add / yarn add
```

Depends on `@kframework-ts/kast` and `@kframework-ts/kore`, nothing else. ESM
only, with types. Node 20+, Bun 1.3+.

## The shape of the library

```ts
import { loadKompiledDefinition, findKompiledDir } from "@kframework-ts/kompiled";

const dir = await findKompiledDir(process.cwd()); // the single *-kompiled here
const kompiled = await loadKompiledDefinition(dir);

kompiled.layout.backend; // "llvm" | "haskell" | …   — already read
kompiled.layout.mainModule; // "IMP"
kompiled.layout.configVars; // ["PGM"]
kompiled.layout.allRules; // UNIQUE_ID → { source, line, column }

kompiled.definition; // compiled.json  → KDefinition   (lazy)
kompiled.definitionHash; // pyk's KPrint.definition_hash
kompiled.prettyPrint(term); // Route A — see below
kompiled.koreDefinition; // definition.kore, axiom bodies unparsed
kompiled.syntaxKore; // syntaxDefinition.kore
kompiled.macrosKore; // macros.kore
```

### Three layers that do not touch each other

This mirrors pyk, where **`KPrint` never uses `KompiledKore`**:

| layer        | file                                                      | needs                 |
| ------------ | --------------------------------------------------------- | --------------------- |
| **metadata** | markers, `allRules.txt`, `configVars.sh`                  | nothing               |
| **KAST**     | `compiled.json`                                           | `@kframework-ts/kast` |
| **KORE**     | `definition.kore`, `syntaxDefinition.kore`, `macros.kore` | `@kframework-ts/kore` |

Each fails on its own if its file is missing. A directory with no
`compiled.json` still gives you the KORE side, and a `--backend kore` directory
with no `definition.kore` still gives you the KAST side.

`konvert` (KAST ↔ KORE conversion) is a **sibling**, never a dependency — it
takes an in-memory `KDefinition`, so it depends on `kast` + `kore` exactly as
this package does. Where a conversion is needed, pass one in:

```ts
const kompiled = await loadKompiledDefinition(dir, { koreToKast });
kompiled.koreToKast(pattern);
```

### One file touches the disk

`src/layout.ts` and `src/kompiled.ts` are pure: they take strings somebody else
read. `src/fs.ts` is the whole of the I/O, and it is the only module in this
monorepo that opens a file. If you have the bytes already — from a zip, a
virtual filesystem, an HTTP range reader — build a `KompiledSource` yourself and
construct `KompiledDefinition` directly, importing from the **`/core` subpath**
so `node:fs` never enters your module graph at all:

```ts
import { KompiledDefinition, parseKompiledLayout } from "@kframework-ts/kompiled/core";

const layout = parseKompiledLayout({ mainModule, mainSyntaxModule, backend, timestampMtimeMs });
const kompiled = new KompiledDefinition({ path: "<zip>", layout, read: (a) => zip.get(a) });
```

`@kframework-ts/kompiled/core` is everything the root export has minus
`src/fs.ts`. The root export still includes it, and still works; the subpath is
for consumers that do not tree-shake, or that run somewhere `node:fs` does not
resolve.

`loadKompiledDefinition` is a free function rather than a static
`KompiledDefinition.load` for exactly that reason: a static would drag `node:fs`
into the pure core.

**Nothing is ever written into the kompiled directory.** pyk writes a
`pyk-definition.kore.json` cache there (`kore/kompiled.py:103`) and an import
graph beside it, which is why `kompile` grew
`--read-only-kompiled-directory` to stop it. There is no write path here at all.

## Three traps this package encodes so you do not rediscover them

1. **`timestamp` contains no timestamp.** It is seven bytes —
   `AC ED 00 05 74 00 00`, a Java-serialized empty string. Only its **mtime** is
   the contract, and it is written _last_, so it post-dates every other artifact.
   `layout.timestampMtimeMs` is that mtime; nothing in this package ever opens
   the file.
2. **`compiled.json` is not produced by default.** `emitJson` defaults to
   `false` in the Java frontend and `True` in pyk, so a directory built by a
   plain CLI `kompile` does not have it. Touching `.definition` on such a
   directory throws `MissingCompiledJsonError`, whose message says _re-kompile
   with `--emit-json`_ rather than reporting an ENOENT.
3. **llvm and haskell `compiled.json` differ and must not be mixed.** The module
   sets diverge from the first pipeline step. K's own README warns that mixing
   them "can cause the backends to crash or, worse, give unsound results". (By
   contrast `syntaxDefinition.kore` is byte-identical across the two — verified.)

## `allRules.txt` is not a list of all rules

`Kompile.java:363-381` writes a line only for a sentence that is (a) in the
**main module**, (b) a rule or claim, and (c) carrying _all_ of `Source`,
`Location` and `UNIQUE_ID`. Rules of modules that did not reach the main module,
and anything the frontend synthesised without a source location, are absent.

Treat it as what it is — a `UNIQUE_ID → source location` index — and join it with
the definition when you want the sentence:

```ts
const rule = kompiled.definition.sentenceByUniqueId.get(uniqueId);
```

It is keyed here by the **full** hash, with `layout.allRulesByPrefix` giving
pyk's 12-character view (`ktool/kprint.py:235`) and `lookupRule(layout, hash)`
accepting either. pyk itself is inconsistent about this — `kcovr.py` and
`coverage.py` use the full hash — so the ambiguity is settled rather than
inherited. Joining this index against `kompile --coverage` hit logs is
[`@kframework-ts/kcovr`](../kcovr#readme)'s job, and it parses `allRules.txt`
through this package rather than growing its own reader.

## `configVars.sh` is parsed, never executed

It is a bash script, generated by string concatenation in
`CompiledDefinition.java:81-139` in three fixed forms
(`declaredConfigVar_X='Sort'`, the `declaredConfigVars=( … )` array,
`declaredConfigVarModule_x='M'`). A regex reads all three. Running a script out
of a build directory to learn three variable names is not a trade worth making.

When the file is absent, `kompiled.configVars` re-derives the same information
from `compiled.json` — which is where `CompiledDefinition.java` computed it from
in the first place. Running that derivation against a directory that _does_ have
the file is a cross-artifact oracle, and it is in the test suite.

## Pretty printing: **Route A**, and what that means

K has **two independent `format` languages**, and this package implements the
KAST-level one:

|                  | **Route A — what this does**                       | **Route B — what `krun -o pretty` does**                |
| ---------------- | -------------------------------------------------- | ------------------------------------------------------- |
| input            | `compiled.json` (`--emit-json` only)               | `syntaxDefinition.kore` (always present, ~4.7× smaller) |
| `%N` indexes     | the production's **items** (terminals included)    | the symbol's **arguments**; terminals are pre-inlined   |
| `%c` / `%r`      | dropped                                            | real colour escapes                                     |
| priorities/assoc | `KSyntaxPriority`/`KSyntaxAssociativity` sentences | pre-computed symbol attributes                          |
| authority        | `Formatter.java`, pyk `kast/formatter.py`          | `ModuleToKORE.java` → llvm-backend `printer.cpp`        |

`prettyPrint` is `@kframework-ts/kast`'s `Formatter`, a transcription of pyk's.
**Its output matches pyk's `Formatter`, not `krun`'s** — the two differ visibly
on real semantics, and every `.out` golden in `k-distribution/tests/` was
produced by Route B. (Three of the `krun` goldens vendored in `fixtures/`
happen to match Route A byte for byte; the test suite asserts those, and says
plainly that flat configurations of integers and maps are precisely where the
two languages cannot diverge.)

The two pre-passes are pyk's, with pyk's defaults
(`KPrint.pretty_print`, `ktool/kprint.py:301-312`):

```ts
kompiled.prettyPrint(term); // unalias: true, sortCollections: false
kompiled.prettyPrint(term, { unalias: false }); // the expanded term, not the alias
kompiled.prettyPrint(term, { sortCollections: true }); // what `pyk rpc-print` passes
```

`unalias` folds the term back into the definition's `alias` rules before
printing. It defaults to **on** in both routes upstream: pyk's `unalias=True`,
and the Java unparser's own first stage
(`KPrint.java:203-212` runs `ExpandMacros` in reverse before `AddBrackets` and
`Formatter`). `sortCollections` normalises `Map`/`Set`/`RangeMap` argument
order, and defaults to **off** — but anything comparing against a
`pyk rpc-print` golden needs it on, because that command passes it.

The fidelity ladder, so nothing is over-read:

```text
pretty.ts  <  formatter.py  <  AddBrackets.java  <  sound disambiguation
             ↑ this package
```

The top rung exists nowhere: `AddBrackets.java:25-31` calls its own algorithm
"naive … insufficient for `--output sound`", and `KPrint.java:199-201`'s
`disambiguateForUnparse` is an identity stub. `@kframework-ts/kast`'s
`formatter.ts` header enumerates exactly what `AddBrackets.java` and
`Formatter.java` do that this does not.

A Route B printer is a deliberate non-choice for v1, not an oversight.

## Scale

A real `definition.kore` is 0.55 MB for IMP (the haskell fixture here; 0.48 MB
for llvm), 15 MB for KEVM, 71 MB for Foundry — and a materialised KORE AST
retains roughly **55×** the file's own size. So
**every artifact is lazy**, and `definition.kore` is parsed with
`@kframework-ts/kore`'s `lazyAxioms` mode: each axiom keeps its _attributes_
(which is where `subsort`, `label`, `priority` and `UNIQUE'Unds'ID` live) and
records its body as a source span. The sort table, the symbol table and every
attribute view are fully correct without one body being parsed.

```ts
const index = kompiled.koreDefinition; // axioms are LazyAxiom
const axiom = kompiled.forceKoreAxiom(index.axioms[0]!); // one body, on demand
```

When you only want sorts, symbols or printing tables, read `syntaxKore`
instead — `syntaxDefinition.kore` is the syntax slice, is present for every
backend, and is several times smaller (0.11 MB for IMP: 4.7× against the
haskell `definition.kore`, 4.1× against the llvm one).

## Files this package refuses to read

`compiled.bin` and `cache.bin` are Java `ObjectOutputStream` streams of
`CompiledDefinition` and `HashMap<String,ParseCache>`, dragging in Scala
collections and Guice beans. `haskellDefinition.bin` is a GHC `COMPACT` heap
image locked to a GHC ABI. `interpreter`, `scanner` and `parser_*` are native
binaries, and `dt/` is LLVM decision-tree YAML that even pyk only
existence-checks.

Everything in `compiled.bin` is also in `compiled.json`. These are refused
rather than half-supported. `parsed.txt` / `compiled.txt` / `post-processed.txt`
are `Definition.toString()` debug dumps with no grammar guarantee: readable,
worthless.

## Directory naming is not a contract

`kompile` defaults to `<cwd>/<basename>-kompiled`, but `-o` overrides it
arbitrarily, and pyk's **booster** layout nests a second complete kompiled
directory at `<dir>/llvm-library` — which does not end in `-kompiled` at all.

`findKompiledDir(cwd)` is a convenience for the default case (pyk's
`Kompile.default_directory`), and it refuses rather than guesses when there is
not exactly one match. Anything nested loads with the same functions:

```ts
import { LLVM_LIBRARY_DIR, loadKompiledLayout } from "@kframework-ts/kompiled";
await loadKompiledLayout(join(dir, LLVM_LIBRARY_DIR)); // → backend "llvm"
```

## KAST-JSON version support

**Version 4 only.** K `v7.1.320` and newer emit version 4 at
`ToJson.java:56`; every reader
upstream compares with strict equality, and so does `@kframework-ts/kast`. A v3
`compiled.json` throws `UnsupportedKastVersionError`, whose message names the
version found, the version required, and the release that introduced it. If you
cannot re-kompile, `@kframework-ts/kast-json` reads both versions.

## The CLI

```sh
$ npx @kframework-ts/kompiled info imp-kompiled --artifacts
directory          imp-kompiled
backend            haskell
main module        IMP
syntax module      IMP-SYNTAX
timestamp mtime    2026-08-05T01:51:15.319Z (1785894675319 ms)
config variables   PGM
  $PGM              Pgm
allRules.txt       170 rules (main-module rules carrying Source, Location and UNIQUE_ID only)
…

$ npx @kframework-ts/kompiled check-k v7.1.400
```

`check-k` reports **two tiers separately**:

- **format** — the pyk sources this package's behaviour is transcribed from
  (`ktool/kompile.py`, `ktool/kprint.py`, `kore/kompiled.py`,
  `kast/formatter.py`). This tier decides the exit code: 0 unchanged,
  1 changed, 3 could not locate, 2 could not run.
- **content** — the Java producers and the layout `README.md`. Advisory, and
  printed without affecting the exit code, because the layout has no version
  number and K says it may change without warning.

`checkKompiledSources` is exported if you would rather call it than shell out.

## What is deliberately not here

Permanently, not "not yet":

- **`krun`, `kast` and concrete-syntax parsing** — all need native binaries.
- **`compiled.bin`, `cache.bin`, `haskellDefinition.bin`** and the other binary
  artifacts — refused rather than half-supported; `src/kompiled.ts`'s
  `KompiledArtifact` gives the reasoning per file.
- **Outer parsing of `.k` sources** — that is
  [`@kframework-ts/k-parser`](../k-parser#readme)'s job, not this package's.
- **Sound disambiguation** — unimplemented upstream, so there is nothing to
  transcribe against.
- **Binary KORE** — the llvm-backend's own format.
- **Writing anything**, into the kompiled directory or anywhere else.

Open, and blocked on work rather than on principle:

- **`expandMacros`** — pyk does not implement it either (it shells out to
  `krun`), so the authority is `ExpandMacros.java` and it needs its own corpus.
- **A Route B printer** — see the pretty-printing section.

## Development

```sh
bun install
bun test              # no K install, no network
bun run check:types
bun run build
```

Fixtures are real kompiled directories produced by K `v7.1.337` on this
machine, surrounded by upstream-vendored oracles. Their bytes embed absolute
paths and reproduce only from the same K install and working directory — see
`fixtures/PROVENANCE.md`, which is mandatory reading before regenerating them.

### Coverage: what the fixtures do and do not reach

Two IMP builds (haskell and llvm) are the centre, and IMP is a **toy**: 273
syntax productions, 31 sorts, no macro rule, no overload, no cell collection,
and a `macros.kore` that is ten bytes of comment. Being correct against it is
not the same as being correct about K, and that gap has cost this package a
bug: `macrosKore` sent a non-empty `macros.kore` to a KORE _definition_ parser,
which can never accept one, and no IMP-shaped fixture could show it.

So there is a third directory, and it is **not this package's**: **KWasm**
(`wasm-semantics`' `test.md`, haskell, same K release) at 1784 syntax
productions, 302 sorts, 2062 rules, 13 macro rules, 6 overloads and 6 cell
collections. It lives in `packages/wasm-fixtures` — private, never published —
because `@kframework-ts/konvert` soaks against the same 4.9 MB `compiled.json`
and one owner is better than two copies and six hand-transcribed recipes. This
package takes it as a **dev dependency**; `test/wasm-semantics.test.ts` reads it
through `WASM_HASKELL_KOMPILED_DIR`.

It is vendored **partially** — `compiled.json`, `macros.kore`, `allRules.txt`
and the markers, 5.1 MB — and deliberately without `definition.kore` and
`syntaxDefinition.kore`, which would add 6 MB more. A partial directory is a
shape this package supports on purpose, and the tests assert that each layer
still fails on its own.

KWasm is **NCSA**-licensed, not BSD-3 like everything vendored here — permissive
on the same terms, with its notice and license text carried in
[`packages/wasm-fixtures/THIRD-PARTY-NOTICES.md`](../wasm-fixtures/THIRD-PARTY-NOTICES.md),
beside the bytes.

The KORE half of that fixture is **opt-in**.
[`packages/wasm-fixtures/fixtures/PROVENANCE.md`](../wasm-fixtures/fixtures/PROVENANCE.md)
is the single copy of the 21-second build recipe, and there is a builder for it:

```sh
KFRAMEWORK_TS_K_BIN=…/k-7.1.337/bin \
KFRAMEWORK_TS_RV_CHECKOUTS=…/runtimeverification \
  bun run --cwd packages/wasm-fixtures kompile-soak
```

That turns on `test/wasm-soak.test.ts` — 6824 lazy axioms, the `definition.kore`
↔ `compiled.json` join at ~2000 rules, and the macro-routing claim that needs
both KORE files present — from a content-keyed cache, with no environment
variable set afterwards. `KFRAMEWORK_TS_WASM_KOMPILED=<dir>` still names one
explicitly. Without either, those tests skip and `bun test` keeps its guarantee:
no K install, no network, nothing outside the repository. The suite also asserts
that the built directory hashes to the same definition as the vendored one, so a
build from another K release fails loudly rather than passing weaker
assertions.

The private real-semantics fixture packages complement one another: KWasm
exercises overloads and cell collections, KEVM supplies 264 real aliases, and
KMIR supplies 31 explicit rule priorities across six values. The focused tests
here load each through the same `KompiledDefinition` API while keeping their
multi-megabyte KORE layers reproducible on demand.

## Licensing

Dual licensed under either of

- Apache License, Version 2.0 (`LICENSE-APACHE`)
- MIT license (`LICENSE-MIT`)

at your option. `MIT OR Apache-2.0` is the SPDX expression in `package.json`.

Separately, this package is a close transcription of BSD-3-Clause licensed
sources from the K Framework, and BSD-3-Clause's terms continue to govern that
transcribed material whichever of the two licenses above you take this package
under. Both required notices are carried in **`THIRD-PARTY-NOTICES.md`**, which
ships with the package.
