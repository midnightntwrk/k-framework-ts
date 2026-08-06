# KLean roadmap

`@kframework-ts/klean` generates deterministic Lean 4 projects for full and
selected KORE projections. IMP projections build with the pinned Lean 4.30.0
toolchain. Intentional hook axioms are part of KLean's shallow embedding and do
not by themselves represent unfinished lowering.

## Current conformance boundaries

The matcher lowering implements repeated left-hand-side variables, subsort
retractions, List/Set/Map and empty-collection hooks, dependency-ordered SCCs
with `mutual` blocks, Option-monad hoisting for nested calls, `noncomputable`
propagation, and sort-parameter binders. Full IMP and the selected
`IMP-SYNTAX._%_1-cool` projection build with `BEq` and `DecidableEq` enabled.
The matcher fixture kompiles and builds with no axiomatized functions beyond
the intentionally open collection hooks.

Two deviations from Python KLean are intentional correctness fixes:

1. A collection `split` leftover is bound at its K collection sort, rather
   than at the hook's raw list type. The raw type makes a Lean project fail to
   elaborate when a rule uses the leftover.
2. `noncomputable` propagation includes the prelude's
   `ListHook`/`SetHook`/`MapHook`, which are themselves `noncomputable`. It is
   insufficient to infer that property only from axiomatized K functions.

Termination of a genuinely recursive `mutual` component remains a consumer
boundary. Lean accepts structural recursion over a K inductive sort; a
non-structural definition needs the handwritten-extension policy in P2.

## P1: differential and focused conformance

- Compare normalized TypeScript and pinned Python KLean output for `Sorts.lean`,
  `Inj.lean`, `Func.lean`, and `Rewrite.lean`. Normalize declaration order:
  Python uses approximate SCC numbering, while this package uses exact SCCs
  with a lexical tie-break.
- Add focused fixtures for nested cells, conditional functions, builtin Int,
  and custom K labels.
- Prefer minimal fixtures derived from matching K/LLVM backend proof cases over
  copying a large backend corpus into the npm package.
- Preserve exact rule-selection and lazy-forcing cardinality checks.

`fixtures/matchers.k` covers list/set/map functions, repeated variables, mutual
recursion, subsort retractions, and non-recursive functions. The opt-in KWasm
soak exercises generation at scale but does not replace focused matcher
fixtures: its equations do not reach the collection matcher branches.

### KWasm scale evidence

The opt-in `test/wasm-soak.test.ts` runs the full generator over KWasm's 5.3 MB
`definition.kore`: 6,824 axioms, 302 sorts, and 1,732 symbols. It is supplied
by the private `@kframework-ts/wasm-fixtures` dev dependency, so the npm package
does not vendor the definition. The lane skips without a K install and never
runs `lake build`.

The check pins byte-identical generation in about half a second and 876 KB of
Lean output: 206 of 302 sorts, 743 of 1,732 symbols, all 201 selected rewrites
(200 lowered), 605 retained equations, 84 axiomatized functions, and exactly
21 diagnostics. Those diagnostics cover only the two unsupported token sorts
`SortFloat` and `SortWasmStringToken`.

The corpus establishes two structural coverage boundaries. Its 44
sort-parameterized axioms are 42 `simplification` and two `functional`, both
filtered before rule lowering, and it contains no non-ground `\dv`; therefore
it cannot reach the parameterized injection or domain-value branches. Its 605
equations yield 12 `eq` and six `subsort` matchers and no collection matcher:
the nine collection sorts occur only through whole-axiomatized hook symbols.
Focused fixtures, rather than a larger corpus, cover those branches.

### Parametric conformance boundary

`fixtures/parametric.k` exercises instantiated parameterized sorts in
injections and domain values. It demonstrates the open correctness gap that P2
must close: `src/sorts.ts` drops sort arguments, emits a reference such as
`SortMInt`, and neither declares the parameterized sort nor emits a diagnostic.
Two different `MInt` widths can therefore collide under one Lean name, and the
generated project cannot elaborate.

The fixture reaches the injection branch with
`inj{SortMInt{Sort32{}}, SortKItem{}}` in a plain rewrite and the domain-value
branch with `\dv{SortMInt{Sort32{}}}("0p32")` in a rewrite side condition and
`…("1p32")` in a function equation. It pins this generated dangling reference
until P2 replaces it with a declared Lean sort or a structured diagnostic.

This gap is also why the fixture has **no `lake build` lane and cannot have
one**: any definition that reaches these branches necessarily carries a
parametric sort into the configuration-reachable slice, so the generated
project never elaborates. Pinning the dangling reference means fixing the sort
emitter breaks this file rather than passing silently.

The fixture also pins two upstream K constraints relevant to this area:

- plain rules over sort-parametric productions are monomorphized, so sort
  variables do not reach these lowering branches. Only a symbol declaration
  and its `functional` totality axiom retain the sort variable, and the latter
  is pre-filtered; and
- a sort-parametric constructor can make `kompile` emit an unbound sort
  variable (`Sort variable SortS not declared`), which the Haskell backend
  rejects with exit status 113. This looks like an upstream defect; it is
  recorded rather than worked around.

Run the focused live check with:

```sh
KFRAMEWORK_TS_K_BIN=…/k-7.1.337/bin \
  bun test packages/klean/test/parametric-conformance.test.ts
```

The upstream references for everything in this section are:

- `pyk/src/pyk/klean/k2lean4.py`
- `pyk/src/pyk/klean/model.py`
- `pyk/src/pyk/klean/generate.py`
- `pyk/src/pyk/kore/internal.py`
- `pyk/src/tests/integration/klean/test_generate.py`

## P2: strengthen the trust manifest and extension policy

- Record a deterministic `definition.kore` hash and every generation option.
- Report structured reasons for each axiomatic function and unsupported item,
  instead of requiring consumers to join text diagnostics to the manifest.
- Emit parameterized sorts correctly, or reject them with a structured
  diagnostic before writing a non-elaborating project.
- Define an external import/override policy for handwritten hook
  implementations and termination proofs.
- Keep handwritten proof code outside generated files so regeneration remains
  clean.

Exit criterion: a successful Lean build can be audited to determine exactly
which semantics were generated, axiomatized, skipped, or overridden. A
non-elaborating projection must fail generation with a precise diagnostic.

## P3: KEVM feedback loop

Generate a small opcode-summary slice from a pinned current KEVM definition,
build it without modifying generated files, and verify that handwritten proof
extensions compose through the supported policy. Use
`inspirations/runtimeverification/evm-equivalence` as an acceptance reference,
not a byte-exact golden: its K and Lean versions differ from this package's pins
and copied artifacts require provenance and license review.

## Verification

The hermetic package gate does not require Lean:

```sh
bun run --cwd packages/klean check
```

The KWasm scale check is opt-in and does not require Lean. It skips without a
locally built complete kompiled directory:

```sh
bun run --cwd packages/wasm-fixtures kompile-soak   # once, needs kompile
bun test packages/klean/test/wasm-soak.test.ts
```

The complete acceptance gate builds full and selected IMP projects and the
matcher fixture:

```sh
KLEAN_RUN_LAKE=1 bun test packages/klean/test/imp-conformance.test.ts
KLEAN_RUN_LAKE=1 bun test packages/klean/test/matcher-conformance.test.ts
```
