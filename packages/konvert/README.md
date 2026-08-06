# @kframework-ts/konvert

**KAST ⇄ KORE conversion** in TypeScript — the translation between K's
frontend AST (`compiled.json`, the `@kframework-ts/kast` term algebra) and
matching logic (`definition.kore`, kore-rpc, `@kframework-ts/kore`).

> **Unofficial.** Not affiliated with, endorsed by, or supported by Runtime
> Verification, Inc. or the K Framework maintainers.

## Why this exists

If you talk to the haskell backend over kore-rpc, this is the layer you cannot
avoid. You hold KAST — that is what `compiled.json` is made of and what every
K-level tool manipulates — and the server speaks KORE. `kastToKore` and
`koreToKast` are what pyk's `KPrint` calls on every round trip, and what this
package provides without a K installation, a subprocess, or a Python runtime.

```sh
npm install @kframework-ts/konvert   # or: bun add / pnpm add / yarn add
```

Two workspace dependencies (`@kframework-ts/kast`, `@kframework-ts/kore`) and
nothing else. ESM only, with types. Node 20+, Bun 1.3+.

## The two tiers

The split is the architecture, not an optimisation.

```ts
import { kastToKorePure, koreToKastPure } from "@kframework-ts/konvert";

// No definition. No filesystem. No I/O.
const kast = koreToKastPure(pattern);
```

**Pure** — `kastToKorePure`, `koreToKastPure`. Post-order folds over the term
alone. Enough to pretty-print a kore-rpc response, and enough for anything on
the way _out_ that is already sorted and injected.

```ts
import { readKastDefinitionFromJson } from "@kframework-ts/kast";
import { kastToKore, koreToKast, kruleToKore } from "@kframework-ts/konvert";

const definition = readKastDefinitionFromJson(await readFile("compiled.json", "utf8"));
const pattern = kastToKore(definition, term, { sort: ksort("GeneratedTopCell") });
```

**Definition** — `kastToKore`, `koreToKast`, `kruleToKore`,
`kflatmoduleToKore`. A `KDefinition`, in practice parsed from `compiled.json`,
is the whole extra input.

**None of these reads a `*-kompiled/` directory or a `definition.kore`.** The
asymmetry between the two directions is real and worth knowing: `koreToKast` is
the pure fold plus one pass, because KORE is self-describing. `kastToKore` is a
six-stage pipeline, because a KAST term carries no sorts on its variables, no
injections between subsorts, and spells a K sequence as a node rather than as
the `kseq`/`append`/`dotk` cons chain `prelude.kore` declares.

`kruleToKore` emits one of two entirely different axiom shapes depending on
whether the rule's left-hand side is a function label — a rewrite axiom or a
function equation. `kflatmoduleToKore` is what a kore-rpc `add-module` request
needs.

## What this is transcribed from, and what adjudicates it

A hand-transcription of pyk's `konvert/` at K **`v7.1.337`**. But pyk's
`konvert/` is _itself_ a re-implementation, so where pyk and the original
disagree this package follows a stated verdict rather than pyk by default:

| concern                      | authority                                                                |   L |
| ---------------------------- | ------------------------------------------------------------------------ | --: |
| KAST→KORE, term level        | the anonymous `VisitK` at the tail of `ModuleToKORE.java` (`:2214-2352`) | 139 |
| sort-injection insertion     | `compile/AddSortInjections.java`                                         | 532 |
| **KORE→KAST, term level**    | `parser/kore/parser/KoreToK.scala` — Scala, in k-frontend                | 180 |
| `kseq`/`append`/`dotk`/`inj` | `haskell-backend`'s `prelude.kore`                                       |  61 |

There is no separate term-level KAST→KORE class in Java: `kast --output kore`
is exactly `ExpandMacros → AddSortInjections → ModuleToKORE.convert(K, sb)`.
And neither `ModuleToKORE.convert` nor `KoreToK.scala` has a single unit test
upstream, which is why the fidelity notes below are worth reading rather than
assuming.

```ts
import { K_RELEASE } from "@kframework-ts/konvert"; // "v7.1.337"
```

### "Does this hold at _my_ K release?" — ask it

```sh
$ npx @kframework-ts/konvert check-k v7.1.400
```

It fetches every file recorded in `TRANSCRIBED_FROM` at that release and
compares sha256, reporting **two tiers separately**:

- **format** — the four pyk `konvert/*.py` files this package transcribes. A
  diff here means the transcription must be re-verified. This tier decides the
  exit code: 0 unchanged, 1 changed, 3 could not locate, 2 could not run.
- **content** — `ModuleToKORE.java` and `KoreToK.scala`, the originals pyk
  re-implements. They adjudicate every disagreement, but they also change
  routinely for reasons unrelated to the 139 lines that matter. Advisory,
  printed without affecting the exit code.

The same logic is exported as `checkKonvertSources` if you would rather call it
than shell out.

## Fidelity: where this deliberately differs from pyk

Every item is documented again in the source, at the code that does it
(`src/pure.ts`'s header is the index). Read this section before treating a
difference from pyk as a bug in this package.

1. **Mangling goes through `@kframework-ts/kore`'s `mangleName`.** pyk's
   `munge` passes characters with no mnemonic through raw — producing symbols
   no KORE lexer accepts — and applies the `'Kywd'` keyword suffix in its
   module path but not its term path. Java does both, uniformly, from one
   static method used for labels, variables _and_ sorts. **This package ships
   no mangling code of its own**; `mangleName`/`demangleName` cover pyk's
   `_utils.py` as a strict superset.
2. **Sort names are mangled on the way out and _not_ unmangled on the way
   back.** Both references are asymmetric here; the asymmetry is reproduced and
   written down rather than quietly "fixed". Harmless for real, alphanumeric
   sort names.
3. **Set variables work.** `@X` becomes the KORE set variable `@Var<munged>`
   and back — the `@` precedes the `Var` prefix, as `ModuleToKORE.java` emits.
   pyk has no set-variable handling and turns `@X` into the _element_ variable
   `Var'-AT-'X`, which is a different kind of variable.
4. **The `Var` prefix is checked before it is stripped.** pyk slices `name[3:]`
   blind, which corrupts every variable not spelled `Var…` — including the `R`
   sort parameter of every function-equation axiom.
5. **`Lbl` is stripped once, not recursively.** Here pyk is right and Java is
   not: Java's `extractKLabel` recurses, so a K label literally spelled `Lblah`
   comes back as `ah`.
6. **Parametric labels are general.** pyk hardcodes the single symbol `Lblite`
   and raises on every other parameterized symbol; the sort parameters are
   simply kept here, which is what Java does and is less code.
7. **`\forall`, `\floor` and `\rewrites` decode**, and a bare string literal
   becomes a `KString` token. pyk raises on all four; `KoreToK.scala` — which
   is what `kore-print` runs, i.e. what pyk's own CLI fallback shells out to —
   supports all four. `\iff` and `\in` still raise (both references agree), and
   so do `\mu`/`\nu`/`\next`. The `\rewrites` half costs the pure tier its
   symmetry — see below.
8. **`\and`/`\or` operands are assoc-flattened**, which normalizes a
   left-nested conjunction to the right-nested spelling K's pretty-printer
   expects. For the right-nested chains a `definition.kore` actually contains,
   this is the identity.
9. **String/Bytes detection is by `hook` attribute**, as Java's is, not by the
   literal sort names `String`/`Bytes` as pyk's is. `kastToKore`/`koreToKast`
   read the map from the definition; the pure tier takes it as an optional
   argument defaulting to pyk's hardcoded pair, so it stays definition-free.
10. **Java's `SortVariable → SortK` fallback is not copied.** It is silently
    lossy. pyk raises; so does this.
11. **An empty `KSequence` is a term, not a falsy value** — see below.

#### The `\rewrites` asymmetry

`koreToKastPure` can produce a term `kastToKorePure` refuses:

```ts
const kast = koreToKastPure(parsePattern("\\rewrites{SortFoo{}}(VarX : SortFoo{}, VarY : SortFoo{})"));
// KRewrite(X:Foo, Y:Foo)
kastToKorePure(kast); // throws: Unsupported KInner: KRewrite
```

Neither reference has this shape. pyk raises in **both** directions, so the
question never comes up. Java is symmetric, but only because its `KRewrite`
carries the input ours cannot: `ModuleToKORE.apply(KRewrite)`
(`ModuleToKORE.java:2325-2333`) reads the result sort out of the node's own
`Att.SORT()` attribute, and `\rewrites{S}` cannot be written without an `S`.
`@kframework-ts/kast`'s `KRewrite` is `{node, lhs, rhs}` — there is nowhere to
put that sort, which is also why the decode drops it, exactly as
`KoreToK.scala:159-160` does. (`KAs` and `KSequence` are rejected by the same
`Unsupported KInner` for the same reason — Java encodes both off `Att.SORT()`
too — but neither is reachable, because nothing in `koreToKastPure` emits a
`KAs`, and `KSequence` is what `replaceKsequenceByKapply` exists to remove.)

Recovering the sort means asking a definition for it (`sortOf` on the two
sides), which makes it a definition-tier concern by construction — and that is
where it already lives. `kruleToKore` splits a rule's `KRewrite` into an
explicit lhs/rhs pair, sorts each, and hands the pure fold two sort-carrying
terms; **no rewrite ever reaches `kastToKorePure` as a `KRewrite`**. So the
asymmetry costs nothing on the paths this package is for. It is documented
rather than removed because the alternative is to stop decoding `\rewrites` at
all, which would make `koreToKastPure` strictly worse than `kore-print` for no
gain.

#### The empty-`KSequence` unit

`mlAnd`/`mlOr` are `@kframework-ts/kast`'s `buildAssoc`, and pyk's
`build_assoc` (`kast/inner.py:912-932`) writes `if not res` and
`return res or unit`. `KSequence` defines `__len__`, so **`KSequence([])` is
falsy in Python**: pyk drops an empty-sequence operand, and returns the _unit_
when it is the only one. `@kframework-ts/kast` tests `=== null`, which is what
the code means. Two consequences are visible from this package:

- `koreToKastPure(\or{SortK{}}(VarV1, dotk{}()))` is `#Or{K}(V1, .K)` here and
  **`V1`** under pyk — pyk silently discards a disjunct.
- `kruleToKore` on a rule whose RHS is an empty `KSequence` at a sort other
  than `K` **throws** the contract's `Sort K is not a subsort of …`, where pyk
  emits `\top{Sort…{}}()` — an axiom saying the function equals _anything_.

Ours is kept in both cases. Such a rule is ill-sorted to begin with (`.K` is at
sort `K`, and K's own frontend rejects it where a `KItem` is required, so no
`kompile` output contains one), so the only question is what to do with input
that should not exist — and a refusal that names the two sorts is strictly
better than an axiom that quietly asserts nothing. It is also exactly the
failure the `kast`-CLI fallback below is built to catch.

And one place where pyk is followed _against_ Java on purpose:

> **Token escaping is a two-layer strip/re-add, not a verbatim reuse.** A KAST
> token carries K-level quoting and a KORE `\dv` carries KORE-level quoting;
> pyk strips one and lets the writer add the other, while Java reuses the K
> layer verbatim with only `escapeNonASCII` on top. Both are valid KORE and
> they are **not byte-equal**: a K token `"\x41"` becomes
> `\dv{SortString{}}("\x41")` under Java and `\dv{SortString{}}("A")` here.
> The normalizing behaviour round-trips, so it is the one taken — and it is
> where any diff against a `kast --output kore` golden will show up.

### Failure is part of the contract

`kastToKore` throws `Sort X is not a subsort of Y` when an injection is not
legal. That is exactly the exception pyk's `KPrint` catches to fall back to
shelling out to the `kast` CLI, so a consumer wiring up the same fallback
matches on it. Java has **no** subsort check at that point: it emits the
injection unconditionally and lets the backend's validator complain, so a term
that fails here is one Java would happily turn into possibly-invalid KORE. The
guard is kept because it makes the failure legible.

`kruleToKore` throws `Do not know how to convert AttEntry to Kore` for any
attribute outside the six translatable kinds (`label`, `priority`,
`simplification`, `symbolic`, `concrete`, `smt-lemma`). An attribute that
reached KORE without a defined meaning would be silently ignored by the
backend, which is worse than a refusal.

## Not implemented: `moduleToKore`

Generating a whole `definition.kore` from a `KDefinition` — pyk's
`_module_to_kore.py`, 1,483 lines, and Java's `ModuleToKORE.java`, 2,353 — is
**not** in this package. It has zero runtime callers in pyk, and it arrives at
an admittedly approximate fidelity that upstream states in writing:

> This function is an approximation, i.e. there might be cases where it produces
> a different result to what would be expected based on kompile's output. These
> discrepancies should be analyzed and fixed.
>
> — `_module_to_kore.py:719-722`, on `simplified_module`

> Java compatibility: remove rules for polymorphic function labels. […] Remove
> this pass (and re-enable the rules) once Java correctly handles polymorphic
> function rules in its dependency analysis.
>
> — `_module_to_kore.py:1263-1274`, on `DiscardPolymorphicSentences`

Two further facts cap what any port could promise here, so they are recorded
rather than chased. Upstream's live pipeline **discards** `format`, `color`,
`colors`, `left` and `right`, so `module_to_kore`'s output is not
attribute-complete against a real `definition.kore` — the passes that would add
them are dead code in pyk. And byte-identical output is unreachable _in
principle_: `SortHead.compare` in k-frontend compares `this` against `this`, so
sort declarations emit in Scala hash-trie order, deterministic for identical
input and unreproducible from semantics.

## How this is tested

pyk's own `konvert` unit suite is 51 lines and tests only `munge`/`unmunge`;
everything else upstream is an integration test that kompiles at test time. The
only thing making those tests "integration" is the `compiled.json`, so it was
produced once with a real K v7.1.337 toolchain and vendored — see
`fixtures/PROVENANCE.md`, which records the release, the commit, the nix store
path, and every exact invocation.

| corpus                                     | cases                                                     |
| ------------------------------------------ | --------------------------------------------------------- |
| string/bytes escaping tables               | 32, plus the layer-separation assertions                  |
| `munge-tests`, read from the vendored file | 428, plus the divergences above                           |
| `regression-new` KORE→KAST goldens         | 6 files across 4 upstream directories                     |
| `test_simple_proofs.py`                    | 47 + 29 + 12 + 1 + 12                                     |
| `test_cell_map.py`                         | 3 + 3                                                     |
| `StringUtilTest.decodeKoreString`          | 2                                                         |
| `mir-semantics-295.json`                   | soak: 377 KB of real KORE-JSON, no definition             |
| KWasm, **opt-in** (see below)              | soak: 3880 rule sides and 2062 rules, _with_ a definition |

The `regression-new` goldens are the only **third-party** oracle for the
reverse direction — their expected side is `KoreToK.scala`'s output, not pyk's
and not ours. One of the four is a committed KAST golden that our re-derivation
matches byte for byte, which is what makes the other three trustworthy.

Every `simple-proofs` and `cell-map` case is additionally replayed against the
**llvm** build of the same definition. pyk's test kompiler leaves the backend
unset, which resolves to llvm, so that is the definition upstream's cases
actually run against, and the two builds are not the same (67 modules vs 60).

### The definition-ful soak, and why it is opt-in

Every vendored definition here is a **hand-written test definition**:
`simple-proofs.k` and `cell-map.k`, ~50 sorts each, written by pyk to exercise
one thing at a time. The `mir-semantics-295.json` soak is real input but carries
_no definition_, so nothing that needs a sort lattice runs on it.

`test/wasm-soak.test.ts` closes that: it points the same functions at **KWasm**,
a real semantics with 1784 syntax productions, 302 sorts, 2062 rules, 6
overloads and 6 cell collections. The artifact belongs to
[`packages/wasm-fixtures`](../wasm-fixtures#readme) — private, never published,
and the single owner of the KWasm bytes, the pin, the census and the build
recipe — which this package takes as its only dev dependency. What that soak
wants is the **complete** kompiled directory, another 6 MB of KORE on top of a
4.9 MB `compiled.json`, so the bytes are built on demand rather than committed:

```sh
KFRAMEWORK_TS_K_BIN=…/k-7.1.337/bin \
KFRAMEWORK_TS_RV_CHECKOUTS=…/runtimeverification \
  bun run --cwd packages/wasm-fixtures kompile-soak
```

21 seconds, once per machine; afterwards `wasmSoakDir()` finds it in a
content-keyed cache with nothing exported, and `KFRAMEWORK_TS_WASM_KOMPILED`
still names a directory explicitly. Without either the file skips entirely and
`bun test` needs no K install, no network, and nothing outside the repository.
The recipe lives in exactly one place,
[`packages/wasm-fixtures/fixtures/PROVENANCE.md`](../wasm-fixtures/fixtures/PROVENANCE.md).

The soak's first assertion is that the directory it found hashes to the same
definition as the vendored `compiled.json` — the same `WASM_DEFINITION_HASH`
`@kframework-ts/kompiled`'s soak checks — so a build from another K release or
another `wasm-semantics` commit fails loudly instead of quietly satisfying the
counts below.

What it measures, on real input rather than on a table:

- **3561 of 3880** rule sides convert with `kastToKore`; the 8 % that do not
  fall into four classes, all of them reachable from IMP as well.
- `kastToKore ∘ koreToKast` is the **identity on all 3561** patterns. The other
  composition is not — `koreToKast ∘ kastToKore` fixes only 2577 — because KORE
  puts a sort on every variable and KAST need not, so the round trip _adds_
  information. The KORE side is where the fixed point is.
- `kruleToKore` converts **1580 of 2062** rules. 415 of the 482 failures are
  `Do not know how to convert AttEntry to Kore`, i.e. pyk's six-entry attribute
  table (`_kast_to_kore.py:335-351`), which this package transcribes exactly —
  `projection` alone accounts for 320. Nothing at IMP scale suggests that a
  fifth of a real definition is out of reach of that function; this is how that
  became a number rather than an impression.

There is deliberately **no equality oracle against K's own `definition.kore`**.
It was tried: joining every rule to the axiom with the same `UNIQUE_ID` gives 0
matches out of 1539, because `_krule_to_kore` drops `UNIQUE_ID`, `Source`,
`Location` and `Production` and spells a trivially-true `requires` differently
from `ModuleToKORE`. pyk is not reproducing the frontend, and neither is this.

## Recursion

Nothing recurses over term depth. Both folds, the sort-injection pass, the
`\and`/`\or` flattening and every traversal run on explicit work stacks — pyk
wrote its versions that way to survive CPython's recursion limit, and the
reason transfers unchanged: real configurations nest deeper than a JS engine's
default stack, and a `RangeError` is not an acceptable outcome of converting a
term.

Two functions do recurse, and neither recursion is over a term: `sortToKast`
descends a sort's own parameters (`Map{Int, List{K}}`), and `varNameToKast`
peels the leading `@`s off a set-variable name. Both are bounded by data a
`kompile`d definition keeps to one or two levels deep.

## License

MIT OR Apache-2.0. See `THIRD-PARTY-NOTICES.md` for the BSD-3-Clause notices
that travel with a transcription of K's sources.
