/**
 * `ImpliesProver` — the one-step prover behind `EqualityProof` and
 * `RefutationProof` (`proof/implies.py:411-470`).
 *
 * The whole algorithm is: simplify both sides, short-circuit the two vacuous
 * cases, otherwise ask the backend one `implies` question. It talks to a
 * backend, so it lives in the Node-only `@kframework-ts/proof/prove` entry
 * point rather than the pure core.
 *
 * # Divergences from pyk, all deliberate
 *
 * - **The prover takes the backend adapter, not the proof.** Upstream is
 *   `ImpliesProver(proof, kcfg_explore, assume_defined)` and then reads the
 *   proof back off the *step* rather than off itself — the field is used only
 *   by `advance_proof`'s bookkeeping. Here, as with `APRProver`, the prover
 *   holds only what it needs to talk to the backend and
 *   {@link advanceProof} is given the proof.
 * - **A `CTermSymbolic`-shaped adapter, not a `KCFGExplore`.** pyk reaches
 *   through `kcfg_explore.cterm_symbolic` for `kast_simplify`, `implies`, and
 *   `_definition.empty_config`. `@kframework-ts/kcfg`'s `KCFGSymbolic` seam
 *   deliberately exposes none of those (it is the *graph* package's seam), so
 *   this prover names its own three-method seam, {@link ImpliesSymbolic},
 *   which `CTermSymbolic` satisfies structurally.
 * - **`initProof` sets no client label** and **`close` is a no-op**, for the
 *   same two reasons `APRProver` documents: the kore-rpc label is a client
 *   construction option here, and the client's lifetime belongs to whoever
 *   made it.
 * - **No `failureInfo`.** Upstream returns a bare `FailureInfo()` marker whose
 *   `implies.py:468-470` TODO defines no payload; an omitted optional method
 *   says the same thing without inventing a value. The observable difference is that a
 *   failed proof's `failureInfo` stays `undefined` instead of becoming an
 *   empty object.
 */

import { CSubst, CTerm } from "@kframework-ts/cterm";
import { Subst, type KDefinition, type KInner } from "@kframework-ts/kast";
import { GENERATED_TOP_CELL } from "@kframework-ts/kast/prelude/k";
import { isBottom, isTop } from "@kframework-ts/kast/prelude/ml";

import type { ImpliesProof } from "./implies.js";
import type { Prover } from "./prover.js";
import { ProofStatus } from "./status.js";
import type { ImpliesProofResult, ImpliesProofStep } from "./step.js";

/** The implication options {@link ImpliesProver} passes down (`implies.py:456-461`). */
export interface ImpliesSymbolicImpliesOptions {
  /** `bind_universally` as this monorepo spells it; see {@link ImpliesProver.stepProof}. */
  readonly bindRhs?: "exists" | "forall" | "none";
  readonly assumeDefined?: boolean;
}

/**
 * The three backend capabilities `ImpliesProver` needs.
 *
 * `@kframework-ts/cterm`'s `CTermSymbolic` satisfies this structurally; the
 * interface exists so this package needs no dependency on that one's class and
 * so a test can drive the prover with a recorded-response fake.
 */
export interface ImpliesSymbolic {
  /** `CTermSymbolic.kast_simplify` — a bare term in, a bare term out. */
  kastSimplify(kast: KInner): Promise<{ readonly kast: KInner }>;
  /** `CTermSymbolic.implies`; only the witness is read. */
  implies(
    antecedent: CTerm,
    consequent: CTerm,
    options?: ImpliesSymbolicImpliesOptions,
  ): Promise<{ readonly csubst?: CSubst | undefined }>;
  /** The definition the dummy configuration is built from (`implies.py:455`). */
  readonly definition: KDefinition;
}

/** Constructor options for {@link ImpliesProver} (`implies.py:417-421`). */
export interface ImpliesProverOptions {
  /** Assume the antecedent's configuration is defined in the implication check. */
  readonly assumeDefined?: boolean;
}

/** The prover half of the implies family: one step, one RPC, one result. */
export class ImpliesProver implements Prover<ImpliesProof, ImpliesProofStep, ImpliesProofResult> {
  readonly symbolic: ImpliesSymbolic;
  readonly assumeDefined: boolean;

  constructor(symbolic: ImpliesSymbolic, options: ImpliesProverOptions = {}) {
    this.symbolic = symbolic;
    this.assumeDefined = options.assumeDefined ?? false;
  }

  /**
   * `ImpliesProver.init_proof` (`implies.py:472-478`) — a documented no-op.
   *
   * Upstream's whole body is `client_label.set(proof.id)`; this monorepo takes
   * that label when the `KoreClient` is constructed. See this module's header.
   */
  initProof(_proof: ImpliesProof): Promise<void> {
    return Promise.resolve();
  }

  /** `ImpliesProver.close` (`implies.py:414-415`) — see the header. */
  close(): void {
    // Intentionally empty; the kore-rpc client's lifetime is the caller's.
  }

  /**
   * `ImpliesProver.step_proof` (`implies.py:424-467`).
   *
   * Four decisions, in order:
   *
   * 1. **The status gate.** Anything but `PENDING` — an admitted proof, or one
   *    whose subproof already failed — produces no results at all, so nothing
   *    is committed and the proof keeps whatever status it had.
   * 2. **Simplify both sides** as bare terms. This is why the prover needs
   *    `kastSimplify` rather than `simplify`: neither side is a configuration.
   * 3. **The two vacuous passes.** An antecedent that simplifies to `#Bottom`
   *    (the constraints are contradictory) or a consequent that simplifies to
   *    `#Top` (the goal is trivially true) both succeed with the *empty*
   *    `CSubst` and no backend call. Upstream logs a warning for each,
   *    because both are usually a sign the claim does not say what its author
   *    meant.
   * 4. **The implication itself.** pyk wraps each simplified side as the sole
   *    constraint of a dummy `GeneratedTopCell` configuration — its own comment
   *    calls this a workaround — because the `implies` endpoint wants
   *    constrained *terms*, not predicates. The dummy is
   *    `definition.emptyConfig(GENERATED_TOP_CELL)` and is deliberately the
   *    same on both sides, so it matches itself and only the constraints
   *    decide the verdict.
   *
   * `bindUniversally` becomes `bindRhs: "forall"`: pyk's flag names the same
   * choice from the other end, and the implies-family constructors hardcode
   * it to `true`.
   */
  async stepProof(step: ImpliesProofStep): Promise<readonly ImpliesProofResult[]> {
    if (step.status !== ProofStatus.PENDING) return Object.freeze([]);

    const simplifiedAntecedent = (await this.symbolic.kastSimplify(step.antecedent)).kast;
    const simplifiedConsequent = (await this.symbolic.kastSimplify(step.consequent)).kast;

    let csubst: CSubst | undefined;
    if (isBottom(simplifiedAntecedent) || isTop(simplifiedConsequent)) {
      csubst = new CSubst(new Subst());
    } else {
      const dummyConfig = this.symbolic.definition.emptyConfig(GENERATED_TOP_CELL);
      const result = await this.symbolic.implies(
        new CTerm(dummyConfig, [simplifiedAntecedent]),
        new CTerm(dummyConfig, [simplifiedConsequent]),
        { bindRhs: step.bindUniversally ? "forall" : "exists", assumeDefined: this.assumeDefined },
      );
      csubst = result.csubst;
    }

    return Object.freeze([Object.freeze({ csubst, simplifiedAntecedent, simplifiedConsequent })]);
  }
}
