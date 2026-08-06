# @kframework-ts/k-parser

K's **outer parser** in TypeScript — the reader for `.k` and literate `.md`
definition files. A hand-transcription of the six [pyk] files that make up that
pipeline — `kast/markdown.py`, `kast/outer_lexer.py`, `kast/outer_parser.py`,
`kast/outer_syntax.py`, `kast/_ast_to_kast.py` and `kast/utils.py` (2,045 lines)
— at K **v7.1.337**, plus the `Sentence → KSentence` layer pyk never
implemented. Definition source in, a `@kframework-ts/kast` `KDefinition` out:
no K install, no subprocess, no Python.

> **Unofficial.** This package is not affiliated with, endorsed by, or
> supported by Runtime Verification, Inc. or the K Framework maintainers.

[pyk]: https://github.com/runtimeverification/k/tree/master/pyk

## How this relates to `@kframework-ts/kast`

`kast` owns the thing this package produces: `KDefinition`, `KFlatModule` and
every `KSentence` node here are its types, and it is this package's only
dependency. `kast`'s README says "Not ported: parsing of `.k`/`.md` sources
(outer parsing)" — that sentence is what this package is.

The two packages both contain a file called `parser.ts`, and they parse
different languages:

|             | `k-parser/src/parser.ts`                | `kast/src/parser.ts`                    |
| ----------- | --------------------------------------- | --------------------------------------- |
| reads       | `.k` / `.md` **definition source**      | **textual KAST terms**                  |
| e.g.        | `module IMP syntax Exp ::= … endmodule` | `` `_+Int_`(#token("3","Int"),X:Int) `` |
| produced by | a human                                 | `kast --output kast`                    |
| upstream    | `pyk/kast/outer_parser.py`              | `pyk/kast/parser.py`                    |
| gives you   | `KDefinition`                           | `KInner`                                |

That collision is why this is a separate package rather than a module inside
`kast`. Everything here is exported under its own namespace with pyk's own
class names (`Definition`, `Module`, `Rule`, `Production`, `Terminal`, …); if
you import both packages flat, import this one qualified:

```ts
import * as outer from "@kframework-ts/k-parser";
```

## Read this first

**pyk cannot do half of what this does, and that is the reason it exists.**
`_sentence_to_ksentence` (`_ast_to_kast.py:57-60`) is a `@singledispatch` stub
that raises `AssertionError`, and nothing upstream registers an implementation:
`parse_outer` throws on any definition containing a single rule or production.
That is why every `parse-outer/*.expected.json` fixture upstream has
`"localSentences": []`. So the surface-AST half of this package is a
transcription, and the `outer_syntax → KSentence` half is **net-new** — modelled
on the Java frontend's `KILtoKORE.java` (v7.1.337), which is the code whose
output `kompile --outer-parsed-json` reads. `src/astToKast.ts`'s header
enumerates what it implements and cites the Java line numbers. The Java
frontend is also the cross-check for the grammar itself: its outer grammar is
`k-frontend/src/main/javacc/Outer.jj`, and its own outer-parser tests live at
`k-frontend/src/test/java/org/kframework/parser/outer/`.

**Its oracle is real, independent of pyk — and stale in known ways.**
`fixtures/imp-outer-json/imp.json` is 425 KB of Java-made KAST v4 (89 modules,
802 sentences, 218 `KBubble`s) and the test suite diffs the full conversion
against it under ten **named** normalizations. 75 of the 89 modules are
sentence-for-sentence identical; the other 14 differ because that fixture is an
_input_ to a regression test rather than a regenerated expectation, and predates
K PR #4334 — it encodes `KRegexTerminal` in a shape `ToJson.java:369-371` can no
longer emit, and its locations point into an older `domains.md`. Each of the 14
was inspected and named in `test/astToKast.test.ts`; the two modules that come
from the current `imp.k` match exactly.

**Three pyk crashes are errors here instead.** `import`, `require` and `syntax
priorities` are in pyk's recognition sets but missing from its `_KEYWORDS` map
(`outer_lexer.py:256-271,442-449` against `:112-130`), so pyk dies with a bare
`KeyError` and no position. The same inputs still fail here — the accepted
language is unchanged — but with a `KParseError` saying
`keyword 'import' is recognized but unsupported; use 'imports'`. Every failure
carries a `line:col`, which pyk's `ValueError`s do not.

**Attributes are read leniently by default.** pyk's `KAtt.parse`
(`att.py:421-427`) throws for any key it has no codec for — which includes
`hook`, `label`, `left`, `klabel` and `smt-hook`, so it cannot read K's own
prelude: `[left]` fails on the first production, and four modules of
`domains.md` carry `[haskell]` or `[not-lr1]`. This package instead decodes
attributes with `KAtt.fromDict`'s rules — registered keys get their codec,
everything else keeps its raw text — which is exactly the `KAtt` pyk would build
if it read Java's `compiled.json`, and round-trips to the same JSON. Pass
`{ strictAtts: true }` for literal pyk behaviour, throw included.

**Rule bodies are not parsed.** They stay `KBubble`s, exactly as in Java's
`--outer-parsed-json`. See "What is deliberately not here".

## Install

```sh
npm install @kframework-ts/k-parser   # or: bun add / pnpm add / yarn add
```

One workspace dependency (`@kframework-ts/kast`) and nothing else. ESM only,
with types. Node 20+, Bun 1.3+.

## Scope

- **Markdown fence selection** (`markdown.py`) — `selectCodeBlocks` and the
  selector mini-language (`k & ! symbolic`), including the invariant that the
  output is the same **length** as the input, so every location still refers to
  the original `.md`
- **The outer lexer** (`outer_lexer.py`) — the 7-state machine, bubbles and all:
  rule-label stripping, the backwards attribute scan, the attribute sub-lexer
- **The outer parser** (`outer_parser.py`) — LL(2) recursive descent over the
  `outer_syntax` surface AST (all 24 node types), with `syntaxToDict`, pyk's
  own dataclass-to-JSON encoding of it
- **`Sentence → KSentence`** — productions, priorities, associativities, user
  lists, sort synonyms, lexical syntax, and the five bubble sentences, with the
  **generated** klabels (`_+__IMP-SYNTAX_AExp_AExp_AExp`) that priority
  sentences have to point at
- **`require` slurping** (`kast/utils.py`) — DFS in first-require-first order,
  dedup by resolved path, include-directory search, on an injectable filesystem
- **The `k-parser` CLI** — `parse`, `parse-outer`, `check-k`

## The shape of the library

Two entry points, split by whether anything touches a disk.

```ts
// The root: a pure function of strings, importable in a browser.
import { OuterParser, selectCodeBlocks, syntaxToDict, astToKast, outerLexer } from "@kframework-ts/k-parser";

// The one filesystem-touching module, on its own subpath.
import { parseOuter, slurpDefinitions } from "@kframework-ts/k-parser/slurp";
```

`src/slurp.ts` is the whole of the I/O, and it is opt-in — the inverse of
`@kframework-ts/kompiled`'s `./core` split, where the fs half is the default.
Paths in public signatures are `string`, never `node:path`/`node:fs` types, so
nothing node-shaped reaches a consumer's `.d.ts`. Its `FileSystem` seam
(`readFile` / `isFile` / `resolve`) is three methods with a `node:fs` default:
pass your own and `slurpDefinitions` walks a zip, a virtual filesystem, or a
plain object.

**Generators.** `outerLexer(text)` is a `Generator<Token>` and the attribute
sub-lexer is a `Generator<Token, string>` — pyk's "yields tokens, returns the
lookahead" contract, which `yield*` propagates unchanged. Tokens are produced
lazily; nothing materialises a token list for a 123 KB `domains.md` unless you
ask for one.

**Recursion.** Nothing recurses over unbounded input. The parser is recursive
descent, but its depth is bounded by the _grammar_ — `Definition → Module →
Sentence → PriorityBlock → Production → ProductionItem → Sort`, seven levels
whatever the file, because no node type can contain itself. A definition with a
million sentences is a million siblings, not a million frames. The selector
parser recurses on `!` and parens, bounded by the length of a selector string.

## Version support

**A `.k` file does not say which K wrote it.** There is no version header, no
pragma, nothing — so this package asserts nothing at runtime about its input's K
version, and its own package version deliberately does not encode one (see
[`docs/versioning.md`](../../docs/versioning.md)). What is pinned is the
_transcription_: `src/version.ts` exports `K_RELEASE` and `TRANSCRIBED_FROM`,
the six pyk files this package was ported from with their sha256 at `v7.1.337`.

Ask directly about any K release, including ones published after this package:

```sh
$ npx @kframework-ts/k-parser check-k v7.1.400
```

It fetches every file recorded in `TRANSCRIBED_FROM` at that tag and compares
sha256.

| exit | verdict          | means                                                            |
| ---- | ---------------- | ---------------------------------------------------------------- |
| `0`  | unchanged        | the transcription is current for that release                    |
| `1`  | changed          | a source moved underneath this port — diff it before trusting it |
| `3`  | could not locate | K refactored a path away; **not** a compatibility verdict        |
| `2`  | could not run    | the network, not K                                               |

The same logic is exported as `checkKSources` if you would rather call it than
shell out. Two things it does not prove: hash equality is necessary but not
sufficient, since K can change behaviour through code these files call into;
and after a hard refactor it degrades to "could not locate", which stops
answering rather than answering wrongly.

## Usage

```ts
import { OuterParser, selectCodeBlocks, syntaxToDict } from "@kframework-ts/k-parser";
import { parseOuter } from "@kframework-ts/k-parser/slurp";

// Literate K: fence selection first, gated on the `.md` suffix by every caller
// above it. The result is the same length as the input — unselected characters
// become spaces — so `line:col` still addresses the original file.
declare const literateText: string; // the bytes of imp.md
const source = selectCodeBlocks(literateText, "k"); // or "k & ! symbolic"

// The surface AST: modules, imports, syntax declarations, rule bodies as
// bubbles. The second argument is the file the locations refer to; omit it and
// no node records a source.
const definition = new OuterParser(source, "imp.md").definition();
definition.modules.map((module) => module.name); // ["IMP-SYNTAX", "IMP"]

// pyk's own JSON encoding of that AST, node for node.
syntaxToDict(definition);

// The whole pipeline: parse a file, follow every `require`, convert to a
// `KDefinition` from `@kframework-ts/kast`.
const kdefinition = parseOuter("imp.k", "IMP", { includeDirs: ["include"] });
kdefinition.allModules.length;
kdefinition.mainModule.sentences; // KProduction, KBubble, KSyntaxPriority, …
kdefinition.requires; // always [] — `utils.py:36-37` drops them
```

## The CLI

```sh
$ npx @kframework-ts/k-parser parse imp.k
{"node":"Definition","modules":[{"node":"Module","source":"imp.k","location":[3,1,29,10],"name":"IMP-SYNTAX",…

$ npx @kframework-ts/k-parser parse spec.md --md-selector 'k & ! symbolic'

$ npx @kframework-ts/k-parser parse-outer imp.k -I include | jq .term.mainModule
"IMP"

$ npx @kframework-ts/k-parser check-k v7.1.400
```

- **`parse <file> [--md-selector S]`** prints the `outer_syntax` surface AST of
  **one** file. Requires are listed, never followed, and nothing is converted to
  KAST. Upstream this dump exists only as a test helper (`dump-outer.py`, which
  is vendored in `fixtures/builtin/` and is what the goldens were made with).
- **`parse-outer <file> [--main-module M] [--md-selector S] [-I DIR]…`** is pyk's
  `pyk parse-outer` (`__main__.py:429-444`) — including the `require` walk —
  except that it works on definitions that contain sentences. `--main-module`
  defaults to the file name without its extension, upper-cased, exactly as
  `__main__.py:431` does; `-I`/`--include` repeats and the directories are
  searched in the order given, after the requiring file's own.
- **`check-k <k-release>`** is the drift check above.

Output is one line of JSON on stdout, as pyk's `json.dumps` writes it. Where
pyk's `parse-outer` prints a bare `to_dict()`, this prints the KAST v4 document
`{"format":"KAST","version":4,"term":…}` — the form pyk itself writes when the
output is _used_ (`__main__.py:476-480`, the file `kompilex` hands to `kompile
--outer-parsed-json`), and the form the Java oracle `imp.json` is in.

Exit codes: `0` success, `1` the file could not be read or parsed (the
`KParseError` or the searched-paths message goes to stderr), `2` could not run —
a usage error, which also prints the usage. `check-k` additionally uses `3`, per
the table above.

## What is deliberately not here

Permanently, not "not yet":

- **Inner parsing of bubbles.** Rule bodies stay `KBubble`s, exactly as in
  Java's `--outer-parsed-json`. Parsing them needs the definition's own grammar
  — scanner generation and an Earley parser — which is a different project.
- **The post-parse validation passes** (duplicate-module, bracket and
  regex-range checks — the `[Error] Compiler:` class). The Java frontend does
  those _after_ outer parsing; pyk does not do them at all. A definition that
  parses here can still be rejected by `kompile`, and `fixtures/rarities/`
  vendors 32 files that do exactly that, as the test that this boundary is where
  it should be.
- **`bisonLists`.** The other user-list expansion (`Es ::= Es "," E`,
  `KILtoKORE.java:329-336`) is selected by a `kompile` flag that defaults to
  `false`, and a definition file does not say which way it was compiled — this
  package has no input for that decision. The default expansion is implemented.
- **Regex normalization.** `KRegexTerminal` keeps the regex verbatim; Java runs
  it through `ParseRegex` into an AST and prints it back (`KILtoKORE.java:290`),
  which respells it. Porting a regex parser buys nothing but oracle parity on a
  fixture that is already stale on that exact field.
- **Replicating pyk's crashes as crashes** — see "Read this first".
- **`kompilex`-style prelude splicing.** The CLI writes a KAST v4 document; how
  it reaches `kompile` is the caller's business.

Open, and blocked on work rather than on principle:

- **`Location`/`Source` on syntax sentences.** pyk's parser records them on
  exactly two node types, `Module` (`outer_parser.py:145`) and `StringSentence`
  (`:373`); Java puts both on all 485 productions of `imp.json`. Fixing it means
  diverging `parser.ts` from pyk, which the 88 transcribed parser cases and the
  nine surface-AST goldens currently pin.
- **`f(/* comment */)`** in an argument list, which Java accepts and pyk rejects
  — the one genuine pyk bug found across a 108-file real-world corpus
  (`mir-semantics/…/ty.md:309`). pyk's rejection is transcribed as-is, so the
  goldens diff clean; matching Java is a decision to take with that corpus
  wired up, not before.

## Development

```sh
bun install
bun test              # no K install, no network, nothing outside the repository
bun run check:types
bun run build
```

### Coverage: what the fixtures reach

775 tests, none of which needs K to be installed. A hand-transcription is not
self-verifying, so what is asserted is upstream's own material, vendored under
`fixtures/` and documented file by file in
[`fixtures/PROVENANCE.md`](fixtures/PROVENANCE.md):

- **267 transcribed pyk cases** — every inline parametrized table in
  `test_outer_lexer.py`, `test_outer_parser.py`, `test_markdown.py` and
  `test_ast_to_kast.py`, extracted to JSON by a checked-in script that refuses
  to run against the wrong pyk version, so they are re-syncable at the next K
  release rather than hand-copied.
- **A 9,283-token golden corpus** — the 37 `outer-lexer/*.test` files upstream
  pins its lexer with, including K's whole `domains.md` in chunks, compared
  token for token. Plus the universal invariant ported from
  `test_outer_lexer.py:646-649`: every token's recorded `Loc` must actually
  locate its own text in the source.
- **The 9-file builtin prelude** — K's densest real source (395 hooks, 30 regex
  terminals), each with a surface-AST golden dumped from pyk itself.
- **The Java oracle** — `imp.json`, diffed under ten named normalizations, with
  the 75-of-89 residual pinned by module name so it cannot silently grow.

Real-world semantics are exercised only **opt-in**: `test/corpus-soak.test.ts`
outer-parses KEVM, KMIR (under both of its conditional selectors), KWasm,
kontrol's `cheatcodes.md` and pl-tutorial in place when
`KFRAMEWORK_TS_RV_CHECKOUTS` points at a directory of their checkouts —
roughly 130 parses, green except a four-entry allowlist of pyk-faithful
rejections (KMIR's `f(/* comment */)` and three pre-7.x pl-tutorial files,
each verified to fail identically under pyk). A default `bun test` reads
nothing outside the repository, so its largest input stays the 188 KB builtin
prelude. The `imp.json` oracle is also weaker than its size suggests: only its
two `imp.k` modules are current, and the 87 prelude modules are diffed against
a snapshot that has drifted.

## Licensing

Dual licensed under either of

- Apache License, Version 2.0 (`LICENSE-APACHE`)
- MIT license (`LICENSE-MIT`)

at your option. `MIT OR Apache-2.0` is the SPDX expression in `package.json`.

Separately, this package is a close transcription of BSD-3-Clause licensed
sources from the K Framework, and its fixtures are BSD-3-Clause files vendored
verbatim from that repository. BSD-3-Clause's terms continue to govern that
material whichever of the two licenses above you take this package under. The
required notices are carried in **`THIRD-PARTY-NOTICES.md`**, which ships with
the package.
