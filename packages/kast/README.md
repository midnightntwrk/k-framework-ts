# @kframework-ts/kast

The KAST **term algebra** in TypeScript — build, compare, match, substitute,
and transform K terms the way [pyk] tools do. A hand-transcription of pyk's
`kast` module (`inner.py`, `outer.py`, `manip.py`, `att.py`, `pretty.py`,
`formatter.py`, `lexer.py`, `parser.py`, `prelude/`, `dequote.py`) at K
**v7.1.337**, speaking KAST **v4**. `src/version.ts` pins every one of them
by sha256.

> **Unofficial.** This package is not affiliated with, endorsed by, or
> supported by Runtime Verification, Inc. or the K Framework maintainers.

[pyk]: https://github.com/runtimeverification/k/tree/master/pyk

## How this relates to `@kframework-ts/kast-json`

They are siblings with zero dependency between them, and they deliberately
differ on both axes:

|                 | `kast-json`                       | `kast` (this package)                 |
| --------------- | --------------------------------- | ------------------------------------- |
| what it is      | reader for a wire format          | in-memory term algebra                |
| KAST version    | v3 and v4 (Java `ToJson`)         | v4 only (K v7.1.337, pyk)             |
| decode contract | total — never throws on a term    | strict — malformed input fails loudly |
| shaped after    | `ToJson.java` / `JsonParser.java` | `pyk/kast/inner.py` and friends       |

A v3 document is **not** a v4 document read leniently — `KSort` changed shape
between them (at K v7.1.320), and each version is read strictly under its own
rules. If you are consuming `krun --output json` or `kompile --emit-json`
output, you want `kast-json`; if you are constructing and transforming terms,
you want this package.

## Scope

- **The inner term algebra** — `KInner` terms (`KApply`, `KToken`,
  `KVariable`, `KSequence`, `KRewrite`, `KAs`, plus `KSort` / `KLabel`);
  structural `eq` / `compare` / `hashOf` (sha256 over the same canonical
  JSON pyk hashes, so hashes agree with pyk); syntactic `match` returning a
  substitution, and `Subst`; stack-based traversals (`bottomUp`, `topDown`,
  `collect`, …); and `isCell`, `KApply.is_cell` (`inner.py:397-400`) as a free
  type guard rather than a property, because a caller holding a `KInner` had to
  narrow before reading it anyway
- **The strict KAST v4 JSON codec** and `{format: "KAST", version: 4}`
  envelope
- **K's string/bytes escape codec** (`dequote.py`)
- **The prelude constructors** (`intToken`, `mlEqualsTrue`, `listOf`, …) via
  subpath imports mirroring pyk: `@kframework-ts/kast/prelude/kint`
- **`manip`** — the evidence-backed term-transformation surface (`freeVars`,
  `splitConfigFrom`, `setCell`, `minimizeTerm`, `pushDownRewrites`, …),
  including the display-layer half `cterm`/`kcfg`/`proof` print through:
  `minimizeRuleLike`, `onAttributes`, `removeSourceMap`, `inlineCellMaps`,
  `replaceRewritesWithImplies`, `noCellRewriteToDots`
- **Attributes** — typed `KAtt` / `Atts` registry, lossless round-trip of
  unknown keys
- **The outer data model and `KDefinition`** — sentences, modules, strict
  reading of `compiled.json` (`readKastDefinition`), `emptyConfig` /
  `initConfig`, `symbols`, `macroRules`, the subsort lattice, and the sort
  inference `konvert` needs (`sortOf`, `sortVars`, `resolveSorts`,
  `leastCommonSupersort`, `addSortParams`, …)
- **Pretty-printing** — `PrettyPrinter` with the patchable symbol table
  downstream pyk tools rely on, plus `Formatter` (`formatter.py`), which
  prints through each production's `format` attribute and inserts brackets
- **The textual KAST reader** (`parseKast`) — the `kast --output kast`
  format
- **Named-module grammar views** — `moduleImportClosure`,
  `moduleLocalProductions`, and `moduleImportSubsortEdges` retain the direct
  declared edges of any module's import closure; `KDefinition.modules` keeps
  its existing meaning as the main module's closure
- **Source user lists** — `classifyUserLists` pairs list declarations by sort,
  never by generated labels, and returns a typed refusal for unsupported
  source shapes. `Atts.USER_LIST` is deliberately closed to `"*" | "+"`, the
  only values K persists in definitions.
- **Production attribution** — `ProductionIndex.forModule` builds a
  closure-scoped label/direct-edge index while keeping `measured` local to the
  named module. Its iterative `productionsUsed(term, expectedSort)` returns
  production identities or a typed refusal (`unknown-label`, arity mismatch,
  missing/ambiguous subsort path, and unsupported term node); callers own any
  report, waiver, or rendering policy.

### Sort and production facts

`isInternalSort(sort)` identifies K's reserved grammar namespace: every name
beginning with `#`, plus the pinned v7.1.337 names in
`INTERNAL_SORT_NAMES`. `isBuiltinTokenSort(sort)` tests the separately pinned
v7.1.337 builtin `[token]` roster, exposed as `BUILTIN_TOKEN_SORT_NAMES`.
These are bare-name facts, not a claim that every builtin token sort is
internal.

`definitionTokenFacts(definition)` reports the `[token]` sorts declared by a
definition (from both `KSyntaxSort` and `KProduction`). It coalesces repeated
structurally equal sort values and preserves declaration order. A fact's
`terminals` contains only whole-terminal token productions: regex token sorts
and compound productions deliberately have no invented representative value.

`ProductionIndex.subsortPath(from, to)` finds declared direct-production edges
across the indexed module's import closure. Equal sorts return `[]`; one path
returns its production references; no path returns `no-subsort-path`; and two
or more paths return `ambiguous-subsort` with two witness paths. It terminates
on cyclic graphs and does not use transitive KORE or backend subsort tables,
because those cannot identify the direct production witnesses.

`ProductionIndex.forModule` coalesces duplicate labels only when the
productions are structurally equal under the same rule as
`KDefinition.symbols`; genuinely distinct duplicates return
`duplicate-label`. Unlabelled and token productions are retained in
`excluded` with their reason instead of making index construction fail.

Not ported here: parsing of `.k`/`.md` sources — that is
[`@kframework-ts/k-parser`](../k-parser#readme), which produces this
package's `KDefinition`. Two `KDefinition` members are also absent:
`expandMacros` (pyk does not implement it either — `krun.py:414-415` shells
out to the K binary) and `KDefinition.sentences` (not upstream at v7.1.337;
use `definition.module(name).sentences`). `src/outer.ts`' header carries the
full member-by-member table.

### One deliberate deviation from pyk

`noCellRewriteToDots` (`manip.py:843-865`) does what upstream's docstring
describes — a cell whose two sides are equal collapses to `...` — rather than
what upstream's body does, which is nothing at all: pyk maps its inner
transform over `split_config_from`'s substitution, whose values are never
cells, so its guard never fires and the function is the identity on every
input. `src/manip.ts` and `test/manip.test.ts` pin both sides.

## Usage

```ts
import {
  PrettyPrinter,
  Subst,
  fromDict,
  kapply,
  ksort,
  kvariable,
  match,
  parseKast,
  readKastDefinition,
  toDict,
} from "@kframework-ts/kast";
import { intToken } from "@kframework-ts/kast/prelude/kint";
import { mlEqualsTrue } from "@kframework-ts/kast/prelude/ml";

// Build terms the way pyk code does.
const term = kapply("_+Int_", [intToken(3n), kvariable("X", ksort("Int"))]);

// Match a pattern and extract bindings.
const subst = match(kapply("_+Int_", [kvariable("A"), kvariable("B")]), term);
subst?.get("A"); // KToken "3":Int

// Substitute into a configuration.
new Subst({ X: intToken(7n) }).apply(term);

// KAST v4 JSON, both directions; `kastTerm` unwraps the
// `{format: "KAST", version: 4, term}` envelope K tools emit.
const roundTripped = fromDict(toDict(term));

// Read a `kompile --emit-json` definition and pretty-print with it.
declare const compiledJson: unknown; // JSON.parse of compiled.json
const defn = readKastDefinition(compiledJson);
new PrettyPrinter(defn).print(term);

// The `kast --output kast` textual format.
parseKast('`_+Int_`(#token("3","Int"),X:Int)');
```

The prelude mirrors pyk's layout as subpath imports —
`@kframework-ts/kast/prelude/{k,kbool,kint,ml,string,bytes,collections,utils}`
— because its exports are short, collision-prone names (`K`, `TRUE`, `INT`,
`token`, …) that read best qualified by module.

## The `kast-ts` command

```sh
kast-ts check-k v7.1.400   # is copied behaviour still current at that K release?
```

Exit codes apply to copied behaviour: `0` unchanged, `1` changed, `3` could
not locate, `2` could not run. Content authorities are reported separately as
advisory. See "K compatibility" below.

## K compatibility

`src/version.ts` exports `K_RELEASE` and `TRANSCRIBED_FROM` — copied pyk and
Java behaviour plus K-produced content authorities, each with its sha256 at
`v7.1.337`. `kast-ts check-k` gates trust on copied behaviour and reports content
drift for review. See `docs/versioning.md` at the repo root for how
compatibility with any other K release is checked on demand.
