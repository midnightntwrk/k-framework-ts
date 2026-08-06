# Proof roadmap

`@kframework-ts/proof` provides proof objects, pyk-compatible proof-data
serialization, provers, drivers, a façade, rendering, and a CLI. This roadmap
tracks intended work. The package README's "Boundaries and non-goals" section
defines excluded scope: the hashed flat-file store, `Proof.digest` /
`up_to_date`, `ProveRpc`'s shape, and the terminal TUI.

## P0: prove a circularity claim live, as a consumer would

The circularity machinery is implemented and fake-tested — `initProof` injects
the `-DEPENDS-MODULE`/`-CIRCULARITIES-MODULE` pair, `getSteps` routes by
`nonzeroDepth`, `stepProof` forces `executeDepth` to 1 at depth zero and adds
the circularity cut rule — but no live test drives a `[circularity]` claim to
`PASSED` end to end. The acceptance criterion is a downstream project that
depends on `@kframework-ts/proof` alone, supplies its own `KCFGSemantics` (a
real `isTerminal`, loop hooks), and proves a looping claim without touching
pyk.

Exit criteria:

- A live-K test proves a summation-style `[circularity]` claim (upstream
  models: `imp-semantics/examples/specs/imp-sum-spec.k`, or the sum claims in
  pyk's `imp-simple-spec.k`), asserting the injected module routing was used.
- The test's semantics implements `isTerminal` and the loop hooks rather than
  stubbing them — the consumer-shaped wiring, not the harness-shaped one.

## P1: dependent claims must load their subproofs

`APRProof.fromClaim` sets `subproofIds` from the claim's `depends` attribute
without supplying the subproofs themselves, so `proveClaims` over a claim that
depends on another currently fails into that one claim's verdict instead of
proving the dependency first (or reading it from the proof directory). The
digest gate in `src/digest.ts` tolerates unloaded dependencies by contributing
their labels to the digest rather than raising; loading the subproofs remains
the required fix.

Exit criteria:

- `proveClaims` over a two-claim spec where one claim `depends` on the other
  completes with both verdicts, proving the dependency first.
- A live-K row covering the same, including the resume path (dependency
  already proved and on disk).

## P2: a live row for the per-step timeout

The policy (`step_timeout`, `shrink_step`, `interrupt`,
`_StepShrunk`/`_StepExhausted`; `proof.py:464-479`, `:522-568`, `:595-635`,
`reachability.py:757-771`) is ported and unit-tested against a prover whose
steps hang until the test releases them, which pins the ordering
(interrupt → unwind → shrink), the retry, and the exhausted stop. What no test
covers is the _backend_ half: that `KoreClient.interrupt` really does make a
running `execute` return promptly, so a timed-out step unwinds instead of
holding the budget open until the server finishes anyway.

Exit criterion: a live row that starts a proof whose first `execute` is known
to run long (the `test_goto.py` nonlinear-SMT query is the obvious candidate,
since the solver already refuses it), sets `stepTimeout: 1`, and asserts the
run returns having shrunk rather than having waited.

The policy is pinned to K v7.1.337 (#4930); `kproof check-k` flags changes to
`proof.py`.

## P1: the `CustomStep` idiom and `test_custom_step.py`

pyk's `tests/integration/proof/test_custom_step.py` (definition inline in the
Python file) is the one proof-suite oracle not yet ported. It exercises
`KCFGSemantics.canMakeCustomStep`/`customStep` returning a cut `Step` — the
extension mechanism KEVM's `CustomStep` registry (`kevm_pyk/kevm.py:54-67`)
and all four Kontrol cheatcode steps are built on. `@kframework-ts/kcfg`'s
semantics seam already carries both hooks; nothing in this monorepo exercises
them against a live backend.

Exit criteria: the ported suite's CFG-equality rows pass live, and the
registry idiom (pattern + exec function table) is documented with a working
example in this package or `@kframework-ts/kcfg`.

## P2: differential show goldens

Every show-layer golden is self-generated: pyk asserts on none of its show
output, so the frozen fixtures catch regressions here but are not evidence
that pyk emits the same bytes (the README's conformance section states this
limitation). Follow-up: run pinned pyk's `APRProofShow`/`KCFGShow` over the
same stored proofs the goldens use — the vendored Kontrol directories are
already both-sides-readable — and freeze pyk's output next to ours, making the
goldens differential rather than self-referential.

## P2: re-enable the goto BMC row

`test/live-goto.test.ts` is transcribed whole and skipped: its first
subsumption check asks Z3 a nonlinear question with a division and the solver
is canceled — upstream pyk fails identically on the same install (transcript
in the file header). BMC coverage comes from the two ported `test_imp.py` BMC
rows meanwhile. Re-check when the haskell-backend or its Z3 handling moves;
the port needs no changes, only un-skipping.

## Optional breadth, if ever wanted

- `test_mini_kevm.py` — booster-only, the largest definition in pyk's proof
  suite; adds `ensures`-constraint coverage over hashed storage.
- k-distribution's `map-symbolic-tests-haskell/` and `set-symbolic-tests/`
  (~285 one-claim specs over two shared definitions) — a bulk `kprove`-level
  sweep that tests the backend more than this package.

## Verification

The hermetic package gate needs no K installation:

```sh
bun run --cwd packages/proof check
```

The complete acceptance gate runs every live suite against the pinned K
(remember stale `dist/` is what live tests import from siblings):

```sh
bun run build
KFRAMEWORK_TS_K_BIN=<k-v7.1.337-bin-dir> bun test packages/proof/test
```
