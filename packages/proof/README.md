# @kframework-ts/proof

K Framework proof artifacts — all-path reachability proofs, the implies
family, their summaries, and pyk's proof-data directory format. This is an
unofficial TypeScript transcription of pyk's proof layer at K **v7.1.337**.

> **Unofficial.** This package is not affiliated with, endorsed by, or
> supported by Runtime Verification, Inc. or the K Framework maintainers.

The browser-safe main entry point is the proof _artifact_ layer: a proof's
identity, its subproofs, the status derived from both, node classification
over a `KCFG`, the pure step protocol, and the two serialization schemas. The
Node-only `./store` subpath reads and writes the `<proofDir>/<id>/proof.json` +
`kcfg/` layout that pyk tools exchange across process boundaries — plus node
refutations, which write two proofs to disk in a fixed order — and `./prove`
adds everything that talks to a backend: the `Prover` seam, the serial
`advanceProof` and concurrent `concurrentAdvanceProof` drivers, `APRProver`,
`ImpliesProver`, the `withExplore` session that owns a `kore-rpc` server, and
the `proveClaims` façade a spec file goes into and verdicts come out of. A
fourth subpath, `./show`, renders a proof as text, as a K module, or as DOT.

```ts
import { APRProof } from "@kframework-ts/proof";
import { readProofData, writeProofData } from "@kframework-ts/proof/store";
import { APRProver, advanceProof } from "@kframework-ts/proof/prove";

const proof = await readProofData("proofs", "test%AssertTest.setUp():0");
console.log(proof.status); // "passed"
console.log(proof.summary.lines.join("\n"));

if (proof instanceof APRProof) {
  proof.prune(7); // interactive graph surgery, then persist
  await writeProofData(proof);
}

// Or advance a fresh proof against a running kore-rpc server.
const fresh = APRProof.fromClaim(definition, claim);
await advanceProof(new APRProver(kcfgExplore, { executeDepth: 1 }), fresh);
console.log(fresh.status);
```

Or hand a whole spec file to the façade, which starts the server, loads the
claims, picks the proof kind per claim, resumes whatever is already on disk and
still current, and reports one verdict each:

```ts
import { proveClaims } from "@kframework-ts/proof/prove";

const verdicts = await proveClaims({
  definitionDir: "imp-verification-kompiled",
  specFile: "imp-simple-spec.k",
  specModuleName: "IMP-SIMPLE-SPEC",
  proofDir: "proofs",
  maxWorkers: 4, // one KoreClient per worker, one server for all of them
  explore: { semantics: new MySemantics() }, // see below — the expensive default
});
for (const { id, status } of verdicts) console.log(id, status);
```

`explore.semantics` is where a language's `KCFGSemantics` goes. Without it the
run uses the trivial one — nothing terminal, no loops — and a proof that closes
on `isTerminal` will explore past its own end instead of passing. The `kproof
prove` command has no flag for it, deliberately: pyk's own `pyk prove` runs
`DefaultSemantics` too, and a semantics is code.

The same thing from a shell:

```sh
kproof prove imp-verification-kompiled imp-simple-spec.k \
    --spec-module IMP-SIMPLE-SPEC --proof-dir proofs --workers 4 --failure-info
kproof status proofs IMP-SIMPLE-SPEC.sum-10
kproof show imp-verification-kompiled proofs IMP-SIMPLE-SPEC.sum-10
```

## Re-running a proof

`proveClaims` resumes from `proofDir`, and the resume is **digest-gated**: each
claim's hash — its own, composed with its dependencies' — is recorded in
`<proofDir>/digest`, and a proof is read back only when that digest still
matches. Editing a claim invalidates its stored graph; an unchanged claim can
resume without asking the backend to repeat completed work. This is kevm-pyk's `KClaimJob` mechanism
(`__main__.py:172-231`), not pyk's broken `Proof.up_to_date`; `src/digest.ts`
spells out the difference.

The gate reads a _missing_ digest file as "out of date", so a proof directory
written by pyk, kevm-pyk or Kontrol is re-initialised on first contact. Pass
`digest: false` (`--no-digest`) to resume solely on the presence of a proof
directory.

## Showing a proof

`@kframework-ts/proof/show` is pyk's `proof/show.py` on top of
`@kframework-ts/kcfg/show`: the KCFG rendering, plus what only a proof knows.

```ts
import { CTermShow } from "@kframework-ts/cterm";
import { APRProofNodePrinter, APRProofShow } from "@kframework-ts/proof/show";

const print = kprint.prettyPrint.bind(kprint);
const show = new APRProofShow({
  definition: kprint.definition,
  prettyPrint: print,
  nodePrinter: new APRProofNodePrinter(proof, new CTermShow(print, { minimize: false }), { fullPrinter: true }),
});
console.log(show.show(proof, { toModule: true, minimize: false }).join("\n"));
```

`APRProofNodePrinter` appends `init`, `target`, `pending`, `refuted`,
`terminal` and `bounded` to a node's attributes, and **removes `stuck`** once
the node is terminal or bounded — the graph cannot know that, the proof can.
`prettySegments` adds a trailing `Target Node:` segment while anything is still
pending; `show` names the module `SUMMARY-<ID>` (upper-cased, underscores
hyphenated); `dot` adds a ` ???` edge from each pending node and a ` false`
edge from each stuck node to the target; `dump` writes `<id>.json` — the
`proof.json` _schema_, not the proof-data directory — beside a `<id>_cfg`
KCFG dump.

`kproof show <definition-dir> <proof-dir> <id>` is the command form. It differs
from pyk's `exec_show` in one respect, deliberately: upstream reaches showing
by re-running the prover with `max_iterations = 0`, which needs a spec file and
a server to re-print a proof that is already on disk. This loads the stored
proof and renders it. The defaults match `exec_show`'s (`minimize=False`,
`full_printer=True`, module included); `--dot`, `--node`, `--node-delta`,
`--omit-cell`, `--minimize`, `--no-full-printer` and `--no-module` adjust them.

One flag has no upstream counterpart: `--show-rules` (`{ showRules: true }` on
the library call) names the rules each edge fired under its `(N steps)` label.
pyk prints no rule labels anywhere in `KCFGShow`, so this is deliberate new
output; it is off by default, which is why every golden above is unchanged.

```text
├─ 12 (pending)
│
│  (3 steps)
│  rules:
│      IMP.assignment:imp.k:142
│      IMP.while:imp.k:158
└─ 13 (leaf, stuck)
```

## Current scope

- `ProofStatus` and the status composition over subproofs, `admitted`
  short-circuiting before the subproofs are consulted.
- `Proof`: id, `proofDir`, subproofs, `admitted`, summaries.
- `APRProof`: the public first-class constructor, node classification
  (`pending`/`failing`/`bounded`/`refuted`), `pathConstraints`, `prune`,
  `minimizeKcfg`, module-name and rule-id derivation, `asRule`/`asClaim`/
  `asRules`, `formattedExecTime`, and `fromClaim`. The sentence building those
  three delegate to — `Edge.to_rule`, `KCFG.to_rules` — is
  `@kframework-ts/kcfg`'s `edgeToRule`/`edgeToClaim`/`kcfgToRules`, not a copy
  here; `edgeToRule` accepts the bare `{ source, target }` pair `as_rule` needs
  because upstream fabricates a depth-0 edge there. `KCFG.from_claim` is the
  one direction that stays in this package (`src/rules.ts`), because it takes a
  `KDefinition` and a `KClaim`.
- `ImpliesProof`, `EqualityProof`, `RefutationProof`, including
  `EqualityProof.fromClaim`, `RefutationProof.toClaim`, and the family's
  single-step protocol (`getSteps`/`commit`).
- **Node refutations**: `APRProof.constructNodeRefutation` (the split walk, the
  four refusal conditions, and useless-constraint pruning) in the pure core,
  with `refuteNode`/`unrefuteNode` on `./store` because they write.
- `APRSummary`, `EqualitySummary`, `RefutationSummary`, `CompositeSummary`, and
  `APRFailureInfo`'s data and rendering.
- Both dictionary schemas — the embedded-KCFG `dict` and the proof-data
  `proof.json` — and the directory reader/writer over `@kframework-ts/kcfg/store`.
- The **step protocol**: `APRProof.getSteps()` (pure), the immutable
  `APRProofStep` with its loops-cache-free dedup key `aprProofStepKey`, the
  `APRProofResult` union, and `APRProof.commit()` as the sole mutator —
  including the in-memory extend cache, which is never serialized.
- On `./prove`: the `Prover` seam, `advanceProof` with `maxIterations`,
  `failFast`, `maintenanceRate`, a progress callback and the **per-step
  timeout/shrink policy** (`stepTimeout` → interrupt → unwind → `shrinkStep`,
  retry or stop), `APRProver`
  (BMC bounding, terminal marking, terminality-gated subsumption with the
  optional fast pre-filter, cut-rule assembly, circularity handling, the extend
  cache, module injection in `initProof`, depth-halving `shrinkStep` and
  `interrupt`), `ImpliesProver` (the status gate,
  `kastSimplify` of both sides, the `#Bottom`/`#Top` vacuous short-circuits,
  and the dummy-configuration implication check), and
  `aprFailureInfoFromProof`.
- **The concurrent driver** `concurrentAdvanceProof`, with `ProverPool`: N
  slots, one prover — and therefore one `KoreClient` — per slot, created
  lazily and closed at the end; step dedup through an explicit key function
  (`aprProofStepKey` for an `APRProof`); commits serialized on the main loop in
  first-completed order; the same `maintenanceRate` flush and `failFast` stop
  the serial driver has.
- **The session and the façade**: `withExplore` stands up `KPrint` + a
  `kore-rpc` server (or connects to one on a given port) + `KoreClient` +
  `CTermSymbolic` + `KCFGExplore` and tears them down again, and hands out
  extra explorers over the same server for concurrent runs;
  `initializeAprProof` is the definedness-plus-simplify preamble both big pyk
  consumers write and pyk does not; `proveClaims` loads a spec file's claims,
  picks `EqualityProof` or `APRProof` per claim, resumes from `proofDir` by
  default **behind the digest gate**, runs `initializeAprProof` only on a proof
  that is starting rather than resuming, selects the serial or concurrent
  driver, and captures a crash into the verdict and `APRProof.errorInfo`
  instead of aborting the batch.
- **The digest gate** on `./prove`: `claimHash` (byte-identical to
  `hash_str(json.dumps(claim.to_dict(), sort_keys=True))`), `claimDigests`
  (`init_claim_jobs` plus `KClaimJob.digest`, dependency closure included), and
  the locked `<proofDir>/digest` read/write pair.
- **The show layer** on `./show`: `APRProofNodePrinter`'s proof-aware node
  attributes, `APRProofShow`'s segments, `SUMMARY-<ID>` module, target edges
  and dump — over `@kframework-ts/kcfg/show`'s `KCFGShow`/`NodePrinter` and
  `@kframework-ts/cterm`'s `CTermShow`. The DOT emitter is plain text; there
  is no `graphviz` dependency anywhere in the chain.
- **The `kproof` CLI**: `prove` (exit code = the number of proofs that did not
  pass, as pyk's `exec_prove`), `show`, `status`, and `check-k`.

There is deliberately **no `APRBMCProof`**. Upstream folded bounded model
checking into `APRProof` (`bmcDepth`, `bounded`, the loops cache) and the
on-disk `type` is `"APRProof"` either way.

`kcfg` and `logs` are public and mutable. Every CLI built on pyk layers
interactive graph surgery on a loaded proof — prune, split on constraints,
re-step a node, let-node, minimize — and then writes it back, so the graph is
not hidden behind the proof.

## Boundaries and non-goals

The main entry point has no filesystem, network, process, or K-installation
dependency; persistence is isolated in `./store`.

This completes the package's planned core _and_ its display layer: proof
objects and both schemas, the store, both drivers, both provers, the timeout
policy, the digest gate, failure info, the session, the façade, the show layer,
and the CLI. Remaining work is tracked in [ROADMAP.md](ROADMAP.md); the
headline item is a permanent exclusion:

- **The TUI is never coming.** `tui.py` is a `textual` application; a terminal
  UI is not what this package is for. `APRProofShow.prettySegments` still
  returns the addressable segments a TUI would need, because they are how any
  consumer maps printed text back to a node or edge.

One smaller gap is named in code: `APRProver.close()` and
`ImpliesProver.close()` are documented no-ops, because the kore-rpc client's
lifetime belongs to its constructor here. The concurrent driver's own provers
are the exception — the façade builds them with a `close()` that releases the
client the session handed out, which is what `_ProverPool.close` does upstream.

`aprFailureInfoFromProof` produces pyk's full failure text — the per-cell
`antecedent #Implies consequent` block and the remaining implication — as long
as the injected adapter computes them; `@kframework-ts/cterm`'s
`CTermSymbolic.implies` does, when asked for a failure reason, which is what
`KCFGExplore.implicationFailureReason` asks for. An adapter that ignores the
request degrades the report to the bare `Matching failed.` line.

**Not here at all, by decision:**

- **The legacy hashed flat-file store.** `<proofDir>/<sha256(id)>.json`,
  `Proof.write_proof`, and `Proof.read_proof` have no downstream users. The
  dictionary codec they were built on _is_ ported — the unit oracle and the
  subproof-composition tests are written against it — but not the store.
- **`Proof.digest` and `Proof.up_to_date`.** `up_to_date` is broken upstream:
  it hashes the Python builtin `id`, not `self.id` (`proof.py:125`), so it is
  always `false` and pyk always rewrites. Not porting it preserves the
  observable behavior; "fixing" it would _skip_ writes pyk performs. It is also
  not the mechanism anyone means by "digest-gated resume" — that is kevm-pyk's
  `KClaimJob`, which _is_ ported, on `./prove`. See `src/digest.ts`.
- **`ProveRpc` the class.** Zero downstream users; every real tool wires
  claim-loading → `fromClaim` → prover itself. Its _decisions_ are ported —
  `proveClaims` makes the same ones, and `prove_rpc.py` is in
  `TRANSCRIBED_FROM` so drift there shows up — but not its shape: the façade
  here is modelled on `kevm_pyk.utils.run_prover`, which is what consumers
  actually copy, so it takes a batch, never aborts on one claim's crash, and
  shares one server across the batch instead of opening a context per claim.
- **`tui.py`.** A `textual` terminal UI, out permanently — see above.

## Divergences from pyk

Everything here is deliberate, and every item is pinned by a test.

| what                                                                                               | why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subproofs are supplied to the constructor, not read inside it.                                     | `Proof.__init__` (`proof.py:74-76`) does recursive disk I/O; a JavaScript constructor cannot await. `readProofData` resolves the whole forest and hands the objects in. Passing `subproofIds` without the matching `subproofs` is an error, not a silent partial construction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `APRProof` _holds_ a `KCFGExploration` rather than inheriting from it.                             | pyk uses multiple inheritance (`Proof`, `KCFGExploration`); TypeScript has none, and composition is what the sibling package's API expects. `kcfg`, `terminal*`, `prune` and friends are forwarded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| No `Proof`/`Prover` class hierarchy.                                                               | Upstream's type parameters exist only so `parallel_advance_proof` can be written once. Nothing downstream subclasses either, so `Prover` is a plain interface and `advanceProof` a free function.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `APRProofResult` is a discriminated union; `extend-and-cache` both caches and applies.             | Upstream `APRProofExtendAndCacheResult` _subclasses_ `APRProofExtendResult`, and `commit`'s `isinstance` chain (`reachability.py:217-243`) relies on that. A union has no is-a, so the and-cache member repeats `extensionToApply` and `commit` performs both halves. Collapsing it into `extend` would silently drop the cut step.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Step dedup keys nodes by id, not by value.                                                         | pyk hashes the frozen `APRProofStep`, so `KCFG.Node` participates by value. `aprProofStepKey` uses the node id, which identifies a node within one `KCFG`, plus the proof id. The two disagree only for a node whose cterm was replaced in place between batches — a window a driver that refetches steps after each commit never opens.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `APRProver.initProof` sets no client label.                                                        | pyk's `client_label` is a `ContextVar` set per proof and read by `KoreClient`; `@kframework-ts/kore-rpc` takes the label at client construction instead. Construct one client per proof with `{ label: proof.id }` and the server-side logs match.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `APRFailureInfo.from_proof` is the free function `aprFailureInfoFromProof` on `./prove`.           | It calls the backend two or three times per failing node. A static on the class would drag those calls into the browser-safe entry point.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `fromDict` restores `node_refutations`.                                                            | Upstream's guard tests the singular key `'node_refutation'` while the body reads `'node_refutations'` (`reachability.py:390`), so `from_dict` never restores them. `read_proof_data` does it correctly, so only that one schema is affected. The intent is unambiguous; the test pins both our behavior and pyk's observed empty result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `RefutationProof`'s antecedent gains an `#Equals(true, ·)` wrapper on every disk round trip.       | Not a divergence — upstream behavior, confirmed against pyk, and pinned. `pre_constraints` returns the wrappers the constructor built, and `from_dict` feeds them back through the constructor. Semantically inert, structurally visible.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `bounded` is sorted in _both_ schemas.                                                             | `write_proof_data` sorts; `dict` writes `list(self._bounded)`, i.e. CPython set-iteration order. For the small positive node ids a proof holds, that order is ascending — verified against pyk — so sorting reproduces it and is deterministic besides.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Integer-keyed maps (`logs`, `node_refutations`, `loops_cache`) are written in ascending key order. | Python dictionaries preserve insertion order; JavaScript objects reorder integer-like keys ascending and `JSON.stringify` follows. Node ids are inserted ascending in every observed artifact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The implies-family step carries data, not the proof.                                               | Upstream's `ImpliesProofStep` holds the `ImpliesProof` itself and `ImpliesProver.step_proof` reads it back out (`implies.py:31-33`, `:424-470`) — which contradicts the protocol's own rule that a step references neither proof nor prover, and is safe there only because such a proof takes exactly one step. Here the step carries the antecedent, the consequent, `bindUniversally`, and a snapshot of the status the prover's gate tests. Nothing can change that status between `getSteps()` and `stepProof()` in the serial driver.                                                                                                                                                                                                                                                                                       |
| `ImpliesProver` takes a `CTermSymbolic`-shaped adapter, not a proof and a `KCFGExplore`.           | Upstream is `ImpliesProver(proof, kcfg_explore)` and reaches through to `cterm_symbolic` for `kast_simplify`, `implies`, and `empty_config`. `@kframework-ts/kcfg`'s `KCFGSymbolic` seam exposes none of those on purpose, so this prover names its own three-method `ImpliesSymbolic` seam, which `CTermSymbolic` satisfies structurally — and, like `APRProver`, takes the proof from `advanceProof` rather than holding it.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `refuteNode`/`unrefuteNode` are free functions on `./store`.                                       | Both are `APRProof` methods upstream, and both write proof directories (`reachability.py:651-670`). The construction they wrap, `constructNodeRefutation`, is pure and remains on the class; filesystem operations belong to `./store` alongside `readSubproofData`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A non-pending implies-family proof would advance forever.                                          | `ImpliesProof.getSteps()` offers a step whenever either side is unsimplified, but the prover declines it unless the proof is `PENDING`, and only a result mutates the proof — so an admitted proof, or one with a failed subproof, re-offers the same step indefinitely. Upstream has the identical loop (`proof.py:597-612`); it is documented rather than "fixed", and `maxIterations` bounds it.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ImpliesProver` supplies no `failureInfo`.                                                         | Upstream returns a bare `FailureInfo()` marker with a `TODO` (`implies.py:468-470`). The optional method is simply absent, so a failed implies-family proof's `failureInfo` stays `undefined` rather than becoming an empty object.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| The soundness warning is a value, not a log line.                                                  | `EqualityProof`/`RefutationProof` log it on every construction upstream. This package has no logger; the text is exported as `IMPLIES_SOUNDNESS_WARNING` and repeated below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The concurrent driver is an async pool, not a thread pool.                                         | `step_proof` is JSON-RPC-bound, so N in-flight promises do what `_ProverPool`'s N threads do (`proof.py:400-479`) — one prover per pool _slot_ instead of per thread, made on that slot's first task, closed at the end. Commits are serialized on the main loop either way, which upstream also relies on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Step dedup takes an explicit key function.                                                         | pyk hashes the frozen `APRProofStep`, with the loops cache excluded by `field(compare=False)`. TypeScript has no structural hashing, so `concurrentAdvanceProof` takes `stepKey`; pass `aprProofStepKey`, which excludes the same field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A worker's exception propagates after the pool drains, and there is no cancellation.               | `future.result()` re-raises inside the `with` blocks, so the executor still shuts down waiting and the provers still close. The `finally` here awaits every in-flight step for the same reason — a promise cannot be interrupted, and `Prover.interrupt` is not part of this seam yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `proveClaims` is a batch, and one crashing claim does not stop it.                                 | `ProveRpc._prove_claim_rpc` lets an exception escape; `run_prover` catches it into `proof.error_info` and returns `False` (`kevm_pyk/utils.py:181-187`). The façade follows `run_prover`, and additionally reports the error on the verdict rather than only on the one proof kind that carries the field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| One backend session serves the whole batch.                                                        | `ProveRpc` opens a fresh explore context per claim (`prove_rpc.py:112`). Module injection is named per proof (`M-<ID>-DEPENDS-MODULE`), so sharing a session is safe, and a concurrent run needs one client per _prover_ rather than per claim anyway.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `initializeAprProof` is here at all.                                                               | It is `kevm_pyk.utils.initialize_apr_proof` (`utils.py:329-348`), not pyk: both big consumers implement it and pyk does not. Its `booster_only_simplify=False` pin is transcribed, and so is the guard message that says `#Bottom` while testing for `#Top`. `proveClaims` runs it only on a proof that is _starting_, so a resumed proof is never re-initialised over its own graph. Upstream gates on `reinit or not up_to_date` (`__main__.py:359`), a proxy for the same thing that misses the case where the digest matches but no proof directory exists; the gate here is "no stored proof was read", which agrees with upstream wherever upstream is right.                                                                                                                                                               |
| The timeout policy's two private exceptions become one callback.                                   | `_StepShrunk`/`_StepExhausted` (`proof.py:464-479`) never escape `advance_proof`; they exist to carry a fact to a `_LOGGER.warning`. This package has no logger, so `advanceProof` takes an `onStepTimeout` callback carrying the same two facts — the budget, and whether the prover shrank — and the control flow is unchanged. `proveClaims` reports them as `notice` progress events, which `kproof prove` writes to stderr.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Prover.stepTimeout`/`shrinkStep`/`interrupt` are optional interface members.                      | Upstream they are a base-class attribute and two default methods (`proof.py:522-547`); there is no `Prover` base class here, so a prover that implements none of them gets upstream's defaults — no budget, no shrink, no interrupt. `advanceProof` reads `stepTimeout` once before the loop, as `proof.py:597` decides once whether to build an executor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A timed-out step is raced, not abandoned.                                                          | Upstream does not abandon it either: `_execute_step` interrupts and then `wait([future])`s for the step to unwind before the prover is reused (`proof.py:566-568`). Here the step promise is raced against a timer, `interrupt()` is called, and the original promise is still awaited before `shrinkStep`. `APRProver.interrupt` reaches `KoreClient.interrupt`; an adapter without one leaves the step running until the backend answers, which is upstream's behaviour in that case too.                                                                                                                                                                                                                                                                                                                                       |
| Digest-gated resume is kevm-pyk's, and its dependency order is sorted.                             | pyk's `Proof.digest`/`up_to_date` is a different, broken thing (see the non-goals). The mechanism ported is `KClaimJob` (`__main__.py:172-231`): the claim hash is byte-identical to upstream's, and the digest file is `json.dumps(..., indent=4)` character for character. Dependency digests are concatenated **sorted** where upstream uses `frozenset` order, and an unloaded dependency label contributes the label rather than raising upstream's `ValueError` — `includeDependencies: false` is reachable here and a batch must survive it.                                                                                                                                                                                                                                                                               |
| `kproof prove`'s exit code is a count.                                                             | pyk's `exec_prove` exits with the number of proofs that did not pass (`__main__.py:290`), which collides with the usage code `2`. Kept, because scripts read it; usage errors say so on stderr and a run that could not start exits `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `APRProofShow` takes an options object, not `(definition, node_printer)`.                          | Upstream builds `PrettyPrinter(defn)` inside `KCFGShow`. Here the printer is an injected callable — `{ definition }`, `{ prettyPrint }`, or both — mirroring `KCFGExplore`'s existing seam. It is what lets the whole layer be tested with a stub printer and no kompiled definition, and it keeps `KPrint` composition at the CLI and test edge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `dot` returns DOT text, not a `graphviz.Digraph`.                                                  | pyk delegates to the `graphviz` package. This monorepo takes no rendering dependency, so the emitter writes the document itself: same nodes, same labels, same attribute classes, same edge label padding — including pyk's `1 steps` for a depth-1 edge and the single-space ` ???` / ` false` target labels. Node ids are formatted as text, which upstream's `Digraph` call does not do and which a parseable DOT file requires. Labels always quote and escape, where `graphviz` leaves bare ids unquoted and embeds real newlines.                                                                                                                                                                                                                                                                                           |
| `pretty_segments` yields objects, not tuples.                                                      | `{ id, lines }` instead of `(id, lines)`. The ids themselves are byte-for-byte pyk's, because they are the only stable handle this output has.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `showRules` names the rules an edge fired. **Beyond pyk, and opt-in.**                             | `KCFGShow` renders an edge as `(N steps)` and never a rule label, though `KCFG.Edge` has always carried `rules` — which is exactly the fact a reader wants when a proof fails on the edge after it. `@kframework-ts/kcfg/show` adds the option and it reaches `APRProofShow.prettySegments`/`pretty`/`show` unchanged; `kproof show --show-rules` is the command form. It defaults to **off** here for the same reason it does there, and for one more: the failure report proper, `APRFailureInfo.print`, is transcribed line for line from `reachability.py:1042-1079` and pinned by an _upstream_ golden, so adding to it would be a parity break rather than a house deviation. Every other rendered surface in this package is likewise a straight transcription with frozen goldens; `false` keeps all of them byte-stable. |
| `kproof show` loads from disk instead of re-proving.                                               | `exec_show` is `exec_prove` with `max_iterations = 0` and `show_kcfg = True` (`__main__.py:293-296`), so upstream needs a spec file and a server to re-print a proof that is already stored. This loads the proof and renders it; the rendering defaults are `exec_show`'s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Byte parity

Documents match pyk's exactly — same keys, same values, same order. **Bytes**
differ in one way only: Python's `json.dumps` separates with `", "` and `": "`
where `JSON.stringify` uses `","` and `":"`. This is verified rather than
asserted: `test/kontrol-fixtures.test.ts` rewrites two real Kontrol proof
directories and checks every output file against the SHA-256 of what pyk at
v7.1.337 writes for the same input, compacted. Nothing else differs.

Reading a _Kontrol-written_ directory and writing it back additionally adds
`execution_time` and `loops_cache` (unconditional in pyk at this release, and
absent from those older files) and drops the empty `covers`/`splits`/
`ndbranches`/`aliases` keys from `kcfg.json` (`to_dict_no_nodes` filters falsy
values at this release). Current pyk does both too.

### Filesystem hazard, inherited

Proof ids are used **verbatim** as directory names (`proof.py:113`). Claim
labels routinely contain `.`, `%`, `(`, `)`, and `:` — Kontrol's are literally
`test%Contract.f(uint256):0` — and nothing sanitises them. That is the format,
so this package reproduces it; a caller that must support Windows has to map
ids to paths itself.

### The soundness caveat, verbatim

> Building an EqualityProof that has known soundness issues: See
> https://github.com/runtimeverification/haskell-backend/issues/3605.

Upstream logs this on every `EqualityProof` and `RefutationProof`
construction. It is exported here as `IMPLIES_SOUNDNESS_WARNING`.

## Conformance status

The hermetic suite has three layers:

1. **The upstream unit oracle.** `pyk/src/tests/unit/test_proof.py` is ported
   whole — all nineteen rows, same names: four disk round-trips, the seven
   subproof-composition rows, minimization and terminals, the module-name
   vectors, the exact `APRFailureInfo.print()` golden, and the three summary
   rows.
2. **Generated pyk documents.** `fixtures/pinned-pyk-proof.json` stores the
   exact JSON _text_ pyk wrote for seven scenarios, so both schemas are checked
   key-order-first, along with the rendered summaries, the
   round-half-to-even `formattedExecTime` vectors, `fromClaim` on both proof
   kinds, and the two upstream quirks above.
3. **Real Kontrol data.** Two complete proof directories — one passing, one
   failing — read, classified, and summarised against Kontrol's own
   `foundry list` golden, then rewritten and compared byte-for-byte with pyk's
   own rewrite of the same input.

Plus three lanes that need no fixtures:

4. **The fake-backend prover suites** (`test/prover.test.ts`,
   `test/implies-prover.test.ts`, `test/refutation.test.ts`). Every
   `APRProofResult` variant — bounded, terminal, subsume with and without the
   fast pre-filter, extend, extend-and-cache, use-cache — driven through
   `stepProof`, `getSteps` and `commit` against a recorded-response
   `KCFGSymbolic`; the `advanceProof` loop's batch-before-refetch ordering,
   `maxIterations`, `failFast` and maintenance cadence; the timeout policy
   driven by a prover whose steps hang until the test's `interrupt` releases
   them — interrupt-then-unwind-then-shrink ordering, the shrink retry, the
   exhausted stop with no failure info, the read-once budget — plus
   `APRProver`'s clamp, depth halving and `interrupt` forwarding; and
   `initProof`'s module names, import chain and rule priorities. Alongside it: the implies
   family's step gate, both vacuous short-circuits, the dummy configuration and
   its universal/existential binding; every refusal branch of
   `constructNodeRefutation` plus the refute/unrefute disk round trip; and the
   composed failure report, failing-cell block and all.
5. **The concurrency and façade unit suites** (`test/parallel.test.ts`,
   `test/facade.test.ts`, `test/cli.test.ts`). The pool is driven by a prover
   whose steps block on gates the test releases, so overlap is _asserted_:
   `maxWorkers` steps in flight and never more, a step never run twice however
   often `getSteps` re-offers it, deterministic termination when the frontier
   stops shrinking, `failFast` mid-flight, the maintenance cadence, one prover
   per slot plus one for the main loop with every one closed, a slot that never
   builds a prover, and an exploding step propagating after the pool drains —
   plus one row driving a real `APRProof` through `aprProofStepKey`. Then
   `initializeAprProof`'s call order, its pinned `boosterOnly: false`, and both
   guards; the functional-claim detection; and every `kproof prove` and
   `kproof status` flag mapping, offline.

   `test/digest.test.ts` is in this lane but has a real oracle: the four
   hashes it freezes were produced by running the **pinned pyk tree** over the
   dicts `sentenceToDict` emits, so `claimHash` and `KClaimJob.digest`'s
   composition are checked against upstream's own numbers rather than against
   themselves. The digest file's bytes are pinned against
   `json.dumps(..., indent=4)` the same way.

6. **The opt-in live-K suites**, skipped unless `KFRAMEWORK_TS_K_BIN` names the
   pinned K install:
   - `test/live-k.test.ts` — the seven-line `<k> 0 => 1 </k>` proof from
     `k-distribution`, pyk's `test_simple.py` terminal-node marking, pyk's
     `test_non_det.py` branch shape, all six rows of `test_refute_node.py`
     including its exact `RefutationProof.to_claim` `KClaim` golden, and
     `test_implies_proof.py`'s five pure-logic rows plus its twelve
     `EqualityProof.fromClaim` rows. One extra test with no upstream
     counterpart pins the failure _reason_ a real backend produces.
   - `test/live-imp.test.ts` — `test_imp.py`'s proof slices: six
     `test_all_path_reachability_prove` rows (statuses and leaf counts, with a
     cut rule and both halves of the dependency pair), two
     `test_all_path_bmc_reachability_prove` rows (`bmcDepth` 1 passing by
     bounding, 2 failing),`test_collect_path_constraints`' exact string,
     `test_fail_fast`'s two runs, `test_proof_no_progress_on_reload`, and a
     `test_failure_info` row.
   - `test/live-goto.test.ts` — `test_goto.py`'s BMC row, ported whole and
     **skipped**: its first subsumption check asks Z3 a nonlinear question with
     a division, and the solver is canceled rather than answering. That is the
     backend, not the port — upstream pyk fails identically on the same install,
     and the file records the transcript. BMC itself is covered by the two IMP
     rows above.
   - `test/live-cell-map.test.ts` — `test_cell_map.py`'s cell-collection proof.
   - `test/live-facade.test.ts` — `proveClaims` over the whole
     `IMP-FUNCTIONAL-SPEC` module in one call, an APR batch that resumes from
     disk with a call-counting adapter proving the backend was never touched,
     the digest gate driven by editing a proved claim's body from `3 + 4` to
     `4 + 3` (same label, same verdict, different text: re-initialised, then
     resumed again on the third run), a `maxWorkers: 2` run, and `kproof prove`
     - `kproof status` end to end.
   - `test/live-show.test.ts` — a proved IMP claim rendered through a real
     `KPrint`, frozen, and re-printed by `kproof show` for byte equality with
     the library's own output. It has no upstream counterpart: see below.

   `test_custom_step.py` is deferred; it needs the `CustomStep` registry idiom
   on `KCFGSemantics`, which nothing in this monorepo exercises yet.

7. **The show layer**, in `test/show.test.ts`: every `APRProofNodePrinter`
   attribute including both `stuck`-removal branches, the conditional
   `Target Node:` segment, the `SUMMARY-<ID>` name, the two target edge
   families in DOT, and the dump layout — plus three goldens rendered from the
   _real_ vendored Kontrol proof.

   **These goldens are self-generated, and that is a real limitation.** pyk
   asserts on none of its show output — `exec_show` prints and nothing checks —
   so there is no upstream oracle for any of it. What is frozen here catches
   regressions in this implementation; it is not evidence that pyk would emit
   the same bytes. Establishing that would mean running pyk over the same
   graphs, which is follow-up work this package does not claim to have done.
   The `stubPrint` printer used by the hermetic goldens is likewise a
   structural stand-in, not `PrettyPrinter`; the live suite is where a real
   printer is composed in.

Origins and per-file hashes are in `fixtures/PROVENANCE.md`.

## Version identity and source drift

```ts
import { K_RELEASE, TRANSCRIBED_FROM, checkProofSources } from "@kframework-ts/proof";

console.log(K_RELEASE); // "v7.1.337"
```

`TRANSCRIBED_FROM` names the pyk implementations and test oracles used here,
including an exact SHA-256 at the pinned release. One source it deliberately
cannot name is `kevm_pyk.utils` — `run_prover`, `initialize_apr_proof` and
`legacy_explore`, which `proveClaims`, `initializeAprProof` and `withExplore`
follow — because it lives in `runtimeverification/evm-semantics` on its own
release cadence, and this manifest is defined against one repository at one K
release. Those citations stay in the code and in `src/facade.ts`'s header
instead. `checkProofSources` is pure:
give it a fetcher to compare those paths against any K tag without making the
library itself network-dependent. The same three-outcome check is exposed as a
command:

```sh
kproof check-k v7.1.337
```

It exits `0` when every source is unchanged, `1` when one changed, `3` when K
moved a source path, and `2` if it could not run. A moved path is explicitly
not a compatibility verdict.

The package is ESM-only, supports Node 20+ and Bun 1.3+, and is dual-licensed
under MIT or Apache-2.0. See `THIRD-PARTY-NOTICES.md` for the BSD-3-Clause
notices carried from K/pyk and Kontrol.
