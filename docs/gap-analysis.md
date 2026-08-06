# Scope and roadmap

Status: **decision record**. This document defines the intentionally omitted
scope and the work that has a concrete adoption trigger. Package READMEs
describe their fidelity guarantees and deviations; their `version.ts`
manifests (`TRANSCRIBED_FROM`, verified by `check-k` against a K release)
identify the K sources they transcribe. Code cites the section identifiers
(C1–C5, S1–S7); keep them stable.

## The consumer frame (C1–C5)

Every build/skip decision here is judged against who actually consumes this
repo, in order:

- **C1 — the panopticon trace/mutation harness.** Needs per-run attributable
  execution traces (rule identity, label, location, substitution),
  deterministic byte-identical output, machine-readable JSONL, and
  corpus × mutant spawn throughput. Served by `cterm/trace`, `prooftrace`,
  and `ktool`'s kserver/caching/native fast paths.
- **C2 — proof-based oracles.** Spec-driven Starstream through `kcfg`/`proof`:
  everything around a _failing_ proof — rendering, diagnosis, resumption,
  proofs-become-lemmas (`kcfg`'s `toModule`).
- **C3 — the Lean pipeline.** `klean` feeding Nightstream; a generated Lean
  file that does not elaborate is worth nothing.
- **C4 — AI agents as the primary operators.** Machine-readable and
  deterministic output outranks interactive UX; a terminal TUI serves nobody
  here; idempotent re-runs and replayable failure artifacts (`kore-rpc`'s
  bug reports) are requirements, not conveniences.
- **C5 — npm consumers of the published packages.** They get correctness and
  documented fidelity, not feature-parity for its own sake.

## Deliberately not ported (S1–S7)

Parity with pyk is not a reason to build; each entry names the absent need,
not the cost. Revisit an entry only when its stated condition changes.

- **S1. `kdist`.** Solves _distribution_ of kompiled semantics across a plugin
  ecosystem; this workspace has one semantics consumer whose harness owns its
  build directories. Its two good ideas — content-keyed up-to-date checks and
  per-target build locks — are worth stealing into the harness if its
  staleness logic ever proves too weak.
- **S2. `kbuild`.** Dead upstream since 2024; its one surviving export
  (`KVersion`) is ported.
- **S3. The `testing/` fixture tower.** The valuable part (the session-scoped
  memoizing kompiler) is ported in `ktool/testing.ts`; the rest is a pytest
  class-hierarchy idiom that TS expresses as plain helpers. The
  Booster/Haskell-backend server matrix guards a Runtime Verification
  divergence outside this workspace's scope.
- **S4. Dead/superseded upstream:** `_module_to_kore`, legacy `KProve`,
  `KoreServerPool`, `HttpTransport`/`JsonRpcClientFacade`, `telemetry`. None
  serves a consumer requirement in C1–C5 either.
- **S5. The `cli/args` option-mixin framework + TOML profiles.** That
  framework exists because kontrol/kevm ship ~80-flag CLIs to human end
  users. Our operators are agents and TS programs calling libraries; any CLI
  here is a thin bin over a typed options object, and a thing with no
  command-line encoding (a fuzzer's arbitraries) gets no CLI at all.
- **S6. The terminal TUI (`KCFGViewer`/`APRProofViewer`) and
  `prettySegments`.** Interactive terminal navigation serves a human at a
  keyboard mid-proof; C4 says our operator is an agent, and for human review
  a rendered artifact (`dot`, `--show-rules` output) is strictly better.
  Revisit if interactive human proof-debugging becomes a real workflow.
- **S7. `kdep`, GDB/LLDB integration, LSP.** Existing binaries to invoke when
  a dev loop wants them; the LSP serves human editing of `.k` files and its
  data source (`cache.bin`) is Java-serialized anyway.

## Roadmap: work with a named trigger

Each of these is a mechanical port (pyk or kevm-pyk remains the reference, so
nothing decays by waiting) with a concrete trigger:

| item                                                           | build when                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`CustomStep` registry** on `KCFGSemantics`                   | First Starstream/panopticon semantics needing a step the backend can't take. Note: the registry is **kevm-pyk's** invention (`kevm.py:54-84`), not pyk's — pyk's two interface methods and both call sites are fully ported in `kcfg`.                                                 |
| **`kore_exec_covr` equivalent** — the simplification-rule half | First serious symbolic-performance debugging session. The semantic-rule half ("which rules never fired") is already answered by `cterm/trace`'s `traceRuleCounts`; simplification rules emit no `rewrite` log entry at haskell-backend v0.1.155, so only the log-parsing half remains. |
| **`KCFG.readNodeData` + `OptimizedNodeStore`**                 | First proof whose graph is too big to load whole.                                                                                                                                                                                                                                      |
| **pyk-style JSON-RPC _server_** (`rpc/rpc.py`)                 | A concrete consumer wants an oracle-as-a-service endpoint. Zero consumers anywhere today, including RV's tree.                                                                                                                                                                         |
| **`kore.rule.toAxiom` + definition-splicing**                  | Haskell-backend mutation runs bottlenecked on re-kompile. Capping caveat: the graded oracle runs the LLVM interpreter, which must re-`llvm-kompile` regardless.                                                                                                                        |

## Upstream defects awaiting reports

Each defect is pinned by a test or documented deviation in this repository.
File a report with Runtime Verification, then check off the corresponding
item.

- [ ] pyk `kast/manip.py` `no_cell_rewrite_to_dots` is the identity function
      on every input (its guard can never fire; pyk's own test pins the
      no-op). Pinned: `packages/kast/src/manip.ts` + `test/manip.test.ts`.
- [ ] pyk `kore/prelude.py` `kore_to_json` cannot consume `json_to_kore`'s
      own output (`RightAssoc` vs binary-`App` walk). Documented:
      `packages/kore/src/prelude.ts` header (JSON bridge omitted).
- [ ] pyk `proof/proof.py:125` hashes the Python builtin `id`, so
      `Proof.up_to_date` is always `False` and its digest can never gate a
      resume. Documented: `packages/proof/src/digest.ts` header.
- [ ] pyk klean collection matchers emit Lean that fails to elaborate (the
      `split` leftover is typed at the raw hook type, not the collection
      structure). Fixed here via `reboxCollection`:
      `packages/klean/src/matchers.ts`.
- [ ] llvm-backend `docs/proof-trace.md:22-24` prose says terms are delimited
      by a leading `0xffffffffffffffff` sentinel; they begin with their own
      `\x7FKR2` magic (the BNF is right, the prose is not). Documented:
      `packages/prooftrace/src/events.ts` header. Related:
      `pattern_len` in the rich header is a partial count (string patterns
      only), reproduced deliberately for tool parity.
- [ ] pyk's `/dev/stdin`/`/dev/stdout` argv convention (`kore/tools.py`,
      `krun.py`) cannot work from Node/Bun — libuv gives children a
      `socketpair(2)` where CPython gives a `pipe(2)`, so reopening via
      `/proc/self/fd` fails `ENXIO`. Not a pyk bug per se, but worth an
      upstream note that the convention is Python-specific. Fixed here:
      `packages/ktool/src/stdio.ts`.
- [ ] K `kompile` emits KORE with an unbound sort variable for a
      sort-parametric constructor (`syntax {S} KItem ::= box(S)` yields a
      no-junk axiom quantifying over an undeclared `SortS`), which the
      Haskell backend then rejects (exit 113, "Sort variable SortS not
      declared"). Pinned: `packages/klean/fixtures/parametric.k` header.
- [ ] pyk `kore/kompiled.py:234-235` — `is_subsort` returns true
      unconditionally when the target is `SortK`, including for sort
      variables, so `add_injections` at its default sort wraps every axiom
      body (3432 of KWasm's at the axiom's own sort variable `R`) in a
      redundant `inj{_, SortK{}}`. Reproduced faithfully here and pinned:
      `packages/kore/test/wasm-soak.test.ts`.

## Package roadmaps

Tracked in the owning package's ROADMAP, not here:

- `packages/proof/ROADMAP.md` — P0 live circularity claim, **P1 dependent
  claims must load their subproofs** (`APRProof.fromClaim` currently fails
  dependent claims into a verdict), P2 live per-step-timeout row.
- `packages/klean/ROADMAP.md` — differential conformance, parameterized-sort
  correctness, trust manifests, and the KEVM feedback loop.
- `packages/prooftrace/ROADMAP.md` — incremental trace-file streaming and a
  reproducible tracing-overhead benchmark.
- `packages/ktool/ROADMAP.md` — remaining live-K command coverage.
- `packages/kfuzz/ROADMAP.md` — consumer-triggered collection arbitraries and
  direct top-cell template construction.
