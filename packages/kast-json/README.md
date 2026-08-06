# @kframework-ts/kast-json

A TypeScript reader for **K Framework's KAST JSON, versions 3 and 4** — the
serialisation K emits from `krun --output json` and `kompile --emit-json`.

> **Unofficial.** Not affiliated with, endorsed by, or supported by Runtime
> Verification, Inc. or the K Framework maintainers.

## Why this exists

Facilitate working with K concepts directly in Typescript

The project is provided at best-effort, given there is **no published schema**. The only specs is two Java files in the K source tree:

| file                                                                  | role                                                |
| --------------------------------------------------------------------- | --------------------------------------------------- |
| `k-frontend/src/main/java/org/kframework/unparser/ToJson.java`        | the **writer** — authority on what is emitted       |
| `k-frontend/src/main/java/org/kframework/parser/json/JsonParser.java` | the **reader** — authority on what K will read back |

This package implements both supported KAST revisions: v3 as defined at tag
**`v7.1.191`** and v4 as defined at **`v7.1.337`**. It also transcribes the eight lines of
`k-frontend/src/main/scala/org/kframework/kore/ADT.scala` that define a sort's
flat spelling (see below). A hand-transcription is not self-verifying, so the
transcription is checked against **real `kompile` and `krun` output** vendored
under `fixtures/`, plus the K repository's **own checked-in test documents at
both versions** and real `pyk` output under `fixtures/upstream/`. Those
fixtures are the substance of the guarantee; see `fixtures/PROVENANCE.md`.

```ts
import { KAST_VERSIONS, K_RELEASE, TRANSCRIBED_FROM } from "@kframework-ts/kast-json";
// [3, 4], "v7.1.337" — and TRANSCRIBED_FROM records each revision's K
// baseline, so you can assert the one you care about against your own K pin.
```

## Install

`zod` is a **peer dependency** — see [API](#api) for why — so install it too.

```sh
npm install @kframework-ts/kast-json zod   # or: bun add / pnpm add / yarn add
```

Requirements:

- ESM only, with types
- Node 20+
- Bun 1.3+

## Version support: v3 and v4, each strictly

`ToJson.version` was `3` from K v7.0.68 through v7.1.319. It became `4` at
**v7.1.320**, in commit `79fae65c1e` ("Handle sort parameters correctly in
JSON Kast format", #4913). That change altered the meaning of an existing
field:

|         | v3                                                                         | v4                                         |
| ------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| `KSort` | `{node, name}`, where `name` **inlines its parameters** — `"Map{Int,Int}"` | `{node, name, params: [...]}`, `name` bare |

A v4 document is therefore not "v3 with extra keys" — the meaning of `name`
changed. This package reads **both versions, each under its own version's
rules**, and reports which one it read; it never reads one version leniently
as the other. Any other version — v2, v5, a string `"3"` — **fails with one
clear message** and is never partially read, the same way K's own `JsonParser`
refuses a version mismatch. To pin a single version, pass an accept list:
`parseTermDocument(text, [3])` is the strict v3-only reader this package used
to be.

How the one `KTerm` shape serves both versions: a v4 sort's structure is
rendered back to the **exact flat v3 spelling** (`MInt{Width}`,
`Map{Int,Int}`) by `flattenSort`, a transcription of `ADT.Sort.toString`
(`ADT.scala:73-80`) — the very function K's v3 writer called to produce those
strings. Equivalent v3 and v4 documents therefore decode to identical terms,
with identical `canonicalKey`s; the fixtures pin this against K's own test
documents, which upstream checks in at both versions. The _definition_ flavour
keeps the structure instead: `KSortJson` carries `params`, `[]` for a v3
document.

Flattening is not lossy: `unflattenSort` is `flattenSort`'s exact inverse, so
a sort's structure is recoverable from the flat spelling wherever this package
hands you one — every `KTerm` sort at either version, and a v3 definition's
`KSortJson.name`.

### "Does this hold at _my_ K release?" — ask it

The package version deliberately does not encode a K version (see
[`docs/versioning.md`](../../docs/versioning.md)). Instead, ask directly about
any K release, including ones published after this package was:

```sh
$ npx @kframework-ts/kast-json check-k v7.1.337
    no   KAST v3 (v7.0.68 – v7.1.295, recorded at v7.1.191)
    no   KAST v3 (v7.1.296 – v7.1.319, recorded at v7.1.296)
  MATCH  KAST v4 (v7.1.320 onward, recorded at v7.1.337)

K v7.1.337 emits KAST v4; this package's transcription is current for it.
```

It fetches the files recorded in `TRANSCRIBED_FROM` (and the `ADT.scala` sort
spelling) at that tag and compares sha256 against every recorded revision.
Exit codes: **0** the release matches a transcribed revision, **1** the
sources changed past every revision, **3** could not locate a path (K
refactored — _not_ a compatibility verdict), **2** could not run. The same
logic is exported as `checkKRevisions` if you would rather call it than shell
out (and the single-baseline core as `checkKSources`).

Two things it does not prove: hash equality is necessary but not sufficient, as
K can change emitted output through code these files call into; and after a hard
refactor it degrades to "could not locate", which stops answering rather than
answering wrongly.

## The two flavours, and their opposite failure policies

KAST JSON is one envelope — `{format: "KAST", version: 3 | 4, term: ...}` —
over two quite different payloads. This package gives them deliberately
opposite contracts.

### Term flavour (`krun --output json`) — **total, never throws**

```ts
import { parseTermDocument, cell, head, token } from "@kframework-ts/kast-json";

const doc = parseTermDocument(await Bun.file("out.json").text());
if (!doc.ok) throw new Error(doc.problem.message); // envelope only
const verdict = cell(doc.term, "verdict"); // "yes" | "absent" | "malformed"
```

`decodeTerm` is **total: it never throws.** An unknown node type, a missing
field, a wrongly-typed field — all of it degrades to an inert `KOther` that
still exposes `args` and `items`, so a traversal passing _through_ an
unmodelled node still reaches the modelled nodes beneath it.

Note: there is no depth limit for parsing.

This helps projects using this library to do error handling themselves on the final result.

Modelled node types: `KApply`, `KToken`, `KSequence`, `KVariable`, `KRewrite`,
`KAs`, `InjectedKLabel` — all seven that `ToJson.toJson(K)` can emit — plus
`KOther`.

### Definition flavour (`kompile --emit-json`) — **fails loudly, with a path**

```ts
import { parseDefinitionDocument, rules, productions, attString } from "@kframework-ts/kast-json";

const doc = parseDefinitionDocument(await Bun.file("compiled.json").text());
if (!doc.ok) throw new Error(doc.problem.message);
// "Not a readable KAST v3 definition: … (at term.modules.7.localSentences.3.att)."

for (const { module, rule } of rules(doc.definition)) {
  console.log(module, attString(rule.att, "label"));
}
```

A definition is one artifact that either is or is not the thing you expect, and
when it is not, the useful answer is a precise path to the offending node.
The definition path is a zod schema.

## Rules this package follows

| Your question                                      | The answer                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| How do I find a subterm?                           | By its KLabel. Never by argument position or printed text.                                 |
| Can I trust the order of a `Map` or a `Set`?       | **No.** They are unordered. Do not depend on the order.                                    |
| Can I trust the order of a `List`?                 | Yes. The order is the data.                                                                |
| Which list reader do I call?                       | `builtinListElements` for K's builtin `List`, `userListElements` for a user-declared list. |
| Where do I read a rule's `Source`?                 | `attSource`. Do not write a recursive search.                                              |
| What happens to a key this package does not model? | It is ignored, not refused.                                                                |

Each rule is below, with the failure it prevents.

### Find a subterm by its KLabel

Do not use the position of an argument. Do not use the printed text.

- The position changes when the grammar changes.
- The printed text changes when a `format(...)` attribute changes.
- The KLabel does not change. It is the only stable interface.

If a read does not find the KLabel, the read returns `undefined`. Test for
`undefined` and stop. Do not accept a term that is only near the correct term.

### A `Map` and a `Set` have no order

The `Map` and the `Set` of K are associative-commutative. Their elements have no
order. The order in a document comes from the backend, and that order is not
stable. The two KAST writers write different orders for the same input. One
writer is also not stable with itself, because `--no-sort-collections` stops the
`sortCollections` pass of `KPrint`.

Therefore these two readers do not return an array:

```ts
const store = mapEntries(cellContent);
// { unordered: true, entries: [ { key, value }, … ] }
```

This package sorts `entries` by its own key, and only to make the output
reproducible. **That order is not K's order. Do not depend on it.**

The `List` of K has an order. Therefore `builtinListElements` and
`userListElements` return an array. For a list, the order is the data.

### Two types of list. Pick by how the list is declared

| The list                             | Call                  | How this package matches the list                 |
| ------------------------------------ | --------------------- | ------------------------------------------------- |
| K's builtin `List`                   | `builtinListElements` | The exact labels `.List`, `_List_` and `ListItem` |
| `syntax Values ::= List{Value, ","}` | `userListElements`    | The cons label that the terminator declares       |

The match on the builtin `List` is exact. An exact match prevents one failure: a
`Set` is read as a `List` and receives an order that the `Set` does not have.

A user-declared list needs a different rule. K puts the name of the declaring
module into the name of the constructor. Therefore the cons label changes when
the module is renamed. K writes the empty list as `.List{"<consLabel>"}_<Sort>`,
so the terminator declares its own cons label. `userListElements` does these
steps:

1. Walk along the spine to the terminator.
2. Read the cons label from the terminator.
3. Make sure that each node on the spine has this cons label.

This package does not guess a label, and it does not match a prefix. Therefore
each separator and each module name is correct. A constructor that has the shape
of a list, but a different cons label, is refused.

### Read the top level of an attribute block

`attString`, `attSource` and `attLocation` do not recurse. Do not write your own
recursive search for `Source`.

The `att.att` of a rule can contain `org.kframework.definition.Production`. This
value is a complete `KProduction` with its own `Source` and `Location`, and
these point to K's built-in files. A recursive search finds those first. It
reports `kast.md` as the source of your rule, and it reports no error. The
fixtures contain this case, and a test holds the behaviour.

### Unknown keys are ignored

This package reads the keys that it needs. It never checks the full set of keys
on a node. K's Java reader does the same, and `pyk` does the same.

You need this rule because the two writers are not identical. `pyk` writes
`"variable": false` on every `KApply`, and the Java writer does not. Both
documents are the same KAST version. The difference is permanent, and a `pyk`
version pin does not remove it.

## API

`zod` is a **peer dependency**, so install it alongside this package. That is
deliberate: the definition-flavour schemas below are exported, and `AttValue`
is typed as `z.ZodType`, so zod is part of this API rather than an internal
detail. A peer dependency is what keeps a consumer and this package on one zod
instance — with two, composing `z.object({ sort: KSortSchema })` can fail an
`instanceof` check and report a type error naming two identical-looking types.

```ts
// identity
KAST_FORMAT, KAST_VERSIONS, K_RELEASE                  // "KAST", [3, 4], "v7.1.337"
TRANSCRIBED_FROM: readonly KastRevision[]              // per-revision K baselines + hashes
SORT_SPELLING_SOURCE                                   // ADT.scala, flattenSort's authority
checkKRevisions(release, fetcher): KRevisionsReport    // which revision does K vX speak?
checkKSources(release, fetcher, sources, recordedAt)   // single-baseline core

// envelope — accept defaults to KAST_VERSIONS; pass [3] or [4] to pin
openEnvelope(doc: unknown, accept?): Envelope          // ok arm carries `version`
openEnvelopeText(text: string, accept?): Envelope
isRecord(u: unknown): u is Record<string, unknown>

// term flavour (total) — v4 sorts arrive flattened to the v3 spelling
parseTermDocument(text: string, accept?): TermDocument // ok arm carries `version`
decodeTerm(u: unknown): KTerm
flattenSort(sort: SortShape): string                   // "Map{Int,Int}", per ADT.scala
unflattenSort(flat: string): StructuredSort | undefined // its exact inverse
children(t) / find(t, label) / findAll(t, label)
cell(t, name): CellRead        // "yes" | "absent" | "malformed"
head(t) / firstArg(t) / token(t)
canonicalKey(t): string        // stable across v3/v4 for equivalent terms

// collections
builtinListElements(t): readonly KTerm[] | undefined   // ordered
userListElements(t):    readonly KTerm[] | undefined   // ordered
mapEntries(t): KMap | undefined                        // UNORDERED
setElements(t): KSet | undefined                       // UNORDERED

// definition flavour (strict) — KSortJson carries `params` ([] for v3)
parseDefinitionDocument(text: string, accept?): DefinitionDocument
modulesOf(def) / rules(def) / productions(def)
attString(att, key) / attSource(att) / attLocation(att)
LOCATION_KEY / SOURCE_KEY / PRODUCTION_KEY
// plus every zod schema: KSortSchema, KLabelSchema, KAttSchema,
// KProductionSchema, SentenceSchema, KFlatModuleSchema, KDefinitionSchema, …
```

Note the module node is **`KFlatModule`**, not `KModule` — `ToJson.toJson(Module)`
calls `mod.flattened()`. There is no `KModule` node in KAST v3, and no
`sentences` key; only `localSentences`, holding the module's _own_ sentences.

## Development

```sh
bun install
bun test              # unit + conformance
bun run check:types   # tsc --noEmit
bun run check:lint    # oxlint --type-aware
bun run fmt           # oxfmt
bun run check         # all of the above
bun run build         # emit dist/ — JS + .d.ts, what npm publishes
```

Tests read only the checked-in fixtures. Therefore the tests need **no K
installation and no network**. This is verified, not asserted.

### Write `.js` in an import, not `.ts`

Inside `src/`, an import of a local file must end in `.js`, and the file it names is a `.ts` file:

```ts
import { decodeTerm } from "./term.js"; // correct — the file is term.ts
import { decodeTerm } from "./term.ts"; // wrong
```

Bun and `tsc` both resolve `./term.js` to `term.ts`, so nothing is rewritten at
build time and the emitted `.d.ts` is correct. Tests are different: they are
never emitted, so `test/` imports `../src/index.ts` with the real extension.

### Where the files go

| Directory   | What it holds                    | Published? |
| ----------- | -------------------------------- | ---------- |
| `src/`      | The transcription. Edit this.    | No         |
| `test/`     | Unit and conformance tests       | No         |
| `fixtures/` | Real `kompile` and `krun` output | No         |
| `dist/`     | Built JS and `.d.ts`             | **Yes**    |

`dist/` is generated and git-ignored. Never edit it. `prepublishOnly` runs
`bun run check` and then `bun run build`, so an unchecked tree cannot reach npm.

The published entry point is compiled JS, not the `.ts` sources, because Node
refuses to strip types for a file under `node_modules`. Source maps carry their
sources inline, so a debugger steps into the transcription and its comments.

### Dependency policy

- **`zod` is a peer dependency** The range starts at the version
  this package is tested against. It does not claim every 4.x release.

## Licensing

Dual licensed under either of

- Apache License, Version 2.0 (`LICENSE-APACHE`)
- MIT license (`LICENSE-MIT`)

at your option. `MIT OR Apache-2.0` is the SPDX expression in `package.json`.

Separately, this package is a close transcription of BSD-3-Clause licensed K
sources, and BSD-3-Clause's terms continue to govern that transcribed material
whichever of the two licenses above you take this package under: its copyright
notice and disclaimer must be retained, and its third clause forbids using the
names of the K copyright holders to endorse anything derived from it. Both
required notices — the University of Illinois one from K's `LICENSE.md` and the
Runtime Verification one from the individual file headers — are carried in
**`THIRD-PARTY-NOTICES.md`**, which ships with the package.
