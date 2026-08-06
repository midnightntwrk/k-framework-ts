/** Source identity for the pyk proof transcription. */

/** The K release every source in {@link TRANSCRIBED_FROM} was read at. */
export const K_RELEASE = "v7.1.337" as const;

/** Commit named by {@link K_RELEASE}, retained for checkout identification. */
export const K_COMMIT = "4a46d1231473b599c699160132fd6e76a5c46406" as const;

/** A pyk implementation or unit-test source used by this package. */
export interface ProofTranscribedSource {
  /** Path within the runtimeverification/k tree. */
  readonly path: string;
  /** Lowercase sha256 of the file at {@link K_RELEASE}. */
  readonly sha256: string;
  /** Line count at the recorded release, for a human-scale cross-check. */
  readonly lines: number;
  /** Whether this was implementation code or a behavioral oracle. */
  readonly tier: "transcription" | "test-oracle";
  /** Why this source is relevant to the public package. */
  readonly why: string;
}

/**
 * The pyk proof sources this package transcribes or uses as its behavioral
 * oracle.
 *
 * The slice covers the whole proof layer this package ships: proof identity and
 * status composition, `APRProof` node classification and both of its
 * serialization schemas, the implies family, the summaries, the step protocol,
 * **both** drivers — `advance_proof` and `parallel_advance_proof`/`_ProverPool`
 * — `APRProver` with its module injection, `APRFailureInfo.from_proof`,
 * `ImpliesProver`, and node refutations. `prove_rpc.py` is listed because
 * `proveClaims` reproduces its per-claim decisions (functional-claim detection,
 * resume-if-on-disk, prover selection) even though the class itself is
 * deliberately not ported; drift there is drift in this package's façade.
 *
 * `show.py` is listed: `src/show.ts` transcribes it. `tui.py` is out of scope
 * permanently — it is a `textual` application — and intentionally does not
 * appear.
 *
 * **Two sources cannot be listed here**, both in
 * `runtimeverification/evm-semantics` rather than in K:
 *
 * - `kevm_pyk.utils`'s `initialize_apr_proof`, `run_prover` and the
 *   `legacy_explore` source function (`kevm-pyk/src/kevm_pyk/utils.py:101-188`, `:329-360`,
 *   `:351-420`), which `initializeAprProof`, `proveClaims` and `withExplore`
 *   follow — including `run_prover`'s rule that a `step_timeout` forces the run
 *   sequential (`utils.py:145-153`).
 * - `kevm_pyk.__main__`'s `KClaimJob`/`init_claim_jobs` and the resume decision
 *   they gate (`kevm-pyk/src/kevm_pyk/__main__.py:172-231`, `:290-307`,
 *   `:359`), which `src/digest.ts` transcribes. pyk's own
 *   `Proof.digest`/`up_to_date` is a *different*, broken mechanism and is
 *   deliberately not ported — see `digest.ts`'s header.
 *
 * This manifest — and the `check-k` command over it — is defined against one
 * repository at one K release, and evm-semantics has its own release cadence,
 * so those citations stay in the code and in the README rather than becoming
 * hashes that would silently mean something else. See `src/facade.ts`'s and
 * `src/digest.ts`'s headers for the exact line ranges.
 */
export const TRANSCRIBED_FROM: readonly ProofTranscribedSource[] = [
  {
    path: "pyk/src/pyk/proof/proof.py",
    sha256: "98d9d61a40ff1d2e0f948cdf305c7f7f590c240bc9b50b6863101bca50ab62fb",
    lines: 638,
    tier: "transcription",
    why: "Proof identity, subproof composition, status derivation, summary machinery, the proof-data directory contract, the `Prover` seam including its per-step timeout/shrink/interrupt policy (`:464-479`, `:522-568`), and both drivers: the serial `advance_proof` and the concurrent `parallel_advance_proof`/`_ProverPool` pair (`:324-479`).",
  },
  {
    path: "pyk/src/pyk/proof/reachability.py",
    sha256: "dfc1f86ef0e8cae44c5833efd4b0d613ee90ff4d7747e0663d3c575b0191fd30",
    lines: 1079,
    tier: "transcription",
    why: "APRProof node classification, the step protocol (`get_steps`/`commit`, `APRProofStep`, the `APRProofResult` hierarchy), `APRProver` with its module injection, `step_timeout` clamp, `shrink_step` and `interrupt` (`:757-771`), module-name derivation, both serialization schemas, APRSummary, and APRFailureInfo.",
  },
  {
    path: "pyk/src/pyk/proof/implies.py",
    sha256: "41e9a5c4f0428bd59ff1eaad88b4e6eea0b7e43943f90f277bcc11a591059b0d",
    lines: 478,
    tier: "transcription",
    why: "ImpliesProof antecedent/consequent encoding, its single-step protocol, EqualityProof and RefutationProof accessors, their dictionary codec, and ImpliesProver.",
  },
  {
    path: "pyk/src/pyk/proof/prove_rpc.py",
    sha256: "d820f1562a227e5352bfc16071c18fb2ab4fa6a1a2a1050326f96e7fe00d7c91",
    lines: 109,
    tier: "transcription",
    why: "The per-claim decisions `proveClaims` reproduces: functional-claim detection via the definition's function symbols, EqualityProof-versus-APRProof selection, resume-if-the-proof-directory-exists, and the max-iterations short circuit. The class itself is not ported — it has no downstream users — but its behaviour is the façade's contract.",
  },
  {
    path: "pyk/src/pyk/proof/show.py",
    sha256: "b31675dc6714137dedb100d4e7efef7d4e5799c7f04d50657e21ca864a8f655b",
    lines: 112,
    tier: "transcription",
    why: "`APRProofNodePrinter`'s proof-aware node attributes (init/target/pending/refuted/terminal/bounded, and the removal of `stuck` once terminal or bounded), `APRProofShow`'s trailing Target Node segment, the `SUMMARY-<ID>` module name, the pending/stuck target edges in the graph, and the `<id>.json` dump.",
  },
  {
    path: "pyk/src/tests/unit/test_proof.py",
    sha256: "7f136d7f168dff9c13104e8e724ab0f7b66821ab44e1092347b1ddc120e35447",
    lines: 500,
    tier: "test-oracle",
    why: "Disk round-trips, subproof-composition rows, minimization and terminals, module-name vectors, summaries, and the failure-info golden.",
  },
  {
    path: "pyk/src/tests/integration/proof/test_simple.py",
    sha256: "1daeabbf6d1024affefeaa0faf2cb0e18850d49936ca9308e9741ab0351a2c1e",
    lines: 78,
    tier: "test-oracle",
    why: "Terminal-node marking at execute depth 1 — the second rung of the live-K ladder.",
  },
  {
    path: "pyk/src/tests/integration/proof/test_non_det.py",
    sha256: "4e698c945ee0aaed064095d2347d15eeb6ba42133c54e9ce5bd4bfe830601d76",
    lines: 135,
    tier: "test-oracle",
    why: "The non-deterministic branch shape, and the source of the inline K definition vendored as fixtures/live-k/non-det.k.",
  },
  {
    path: "pyk/src/tests/integration/proof/test_refute_node.py",
    sha256: "eea06c22a5f189e039eb58e883ba94f5562a6730d777f457b476e29315c4cdd8",
    lines: 340,
    tier: "test-oracle",
    why: "refute_node/unrefute_node round trips, the refusal conditions, useless-constraint pruning, the exact RefutationProof.to_claim KClaim golden, and the proof-directory round trip of node refutations.",
  },
  {
    path: "pyk/src/tests/integration/proof/test_implies_proof.py",
    sha256: "3d8c90157c05193c34bd723495e8829c737225e7b66fb95c97041a83a7fca040",
    lines: 221,
    tier: "test-oracle",
    why: "The five pure-logic ImpliesProof rows — including both vacuous short-circuits and the universal-versus-existential binding pair — and the twelve EqualityProof.from_claim rows with their expected statuses.",
  },
  {
    path: "pyk/src/tests/integration/proof/test_imp.py",
    sha256: "bfd3baafada2ace565f8f612a87f2276b1d4cf73b37f1cf7eaecec02030e2c6f",
    lines: 1615,
    tier: "test-oracle",
    why: "The all-path reachability rows (statuses and leaf counts, including the cut-rule and dependency pairs), the exact path-constraint string, the fail-fast leaf/pending/terminal counts, the no-progress-on-reload contract, and the failure-info row.",
  },
  {
    path: "pyk/src/tests/integration/proof/test_goto.py",
    sha256: "fa4e77c8d0dad273854c5b1012fd3dfdb054fdabff3474e90745af219ec2fdc9",
    lines: 128,
    tier: "test-oracle",
    why: "The only end-to-end bounded-model-checking row upstream: GotoSemantics' is_loop/same_loop, bmc_depth 1, and the resulting leaf count. Transcribed and skipped — its first subsumption check is an SMT query the pinned backend cancels rather than answers, upstream pyk included; test_imp.py's APRBMC rows carry the bmc_depth coverage.",
  },
  {
    path: "pyk/src/tests/integration/proof/test_cell_map.py",
    sha256: "e4a61cb8c7e5e55164089e93859b0e8aabc317aeac2c7aac1d3ae480ecccf43e",
    lines: 154,
    tier: "test-oracle",
    why: "The cell-collection proving row, which is where assume_defined on the initial node is load-bearing rather than optional.",
  },
  {
    path: "pyk/src/tests/integration/proof/test_prove_rpc.py",
    sha256: "9b1fa7fd27df601d8ff58bd1fa266cd2f1c4dad15af107be18fc3579c37ed9e6",
    lines: 211,
    tier: "test-oracle",
    why: "The spec-file-to-verdicts oracle, retargeted at `proveClaims`: which claims become EqualityProofs, which become APRProofs, and what a second run over the same proof directory does.",
  },
];
