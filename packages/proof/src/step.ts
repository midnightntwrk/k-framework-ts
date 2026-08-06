/**
 * The step protocol: `APRProofStep` and the `APRProofResult` hierarchy
 * (`proof/reachability.py:37-90`), plus the implies family's single-step pair
 * (`proof/implies.py:31-39`).
 *
 * The protocol is the load-bearing design of pyk's prover layer, and its three
 * halves live in three different places on purpose:
 *
 * - `APRProof.getSteps()` is **pure** and repeatable; it produces
 *   {@link APRProofStep} values that reference no proof and no prover.
 * - `Prover.stepProof(step)` is pure with respect to both the proof and the
 *   prover, which is what makes it safe to run concurrently.
 * - `APRProof.commit(result)` is the **only** mutator.
 *
 * Termination is `getSteps()` returning an empty list.
 *
 * # Two shapes that differ from upstream
 *
 * 1. **Results are a discriminated union, not a class hierarchy.** Upstream
 *    `APRProofExtendAndCacheResult` *subclasses* `APRProofExtendResult`, and
 *    `commit`'s `isinstance` chain (`reachability.py:217-243`) tests
 *    `APRProofUseCacheResult` first, then `APRProofExtendResult` — with the
 *    and-cache case nested inside, so it both caches and applies. A union
 *    cannot express "is-a", so `"extend-and-cache"` carries both payloads and
 *    `commit` must do both things for it. Collapsing it into `"extend"` would
 *    silently drop the cached cut step.
 * 2. **The dedup key is explicit.** pyk relies on `APRProofStep` being a frozen
 *    dataclass, so `set[APRProofStep]` dedups steps in
 *    `parallel_advance_proof`. TypeScript has no structural value hashing, so
 *    {@link aprProofStepKey} spells out the key — and, exactly as upstream's
 *    `field(compare=False)` on `prior_loops_cache` (`reachability.py:86`),
 *    leaves the loops cache out of it.
 */

import type { KInner } from "@kframework-ts/kast";
import type { KCFGNode } from "@kframework-ts/kcfg";
import type { KCFGExtendResult } from "@kframework-ts/kcfg/explore";
import type { CSubst } from "@kframework-ts/cterm";

import type { ProofStatus } from "./status.js";

/**
 * One unit of work for an `APRProof` (`reachability.py:77-90`).
 *
 * Immutable data with no reference back to the proof: everything
 * `APRProver.stepProof` needs is copied in, which is what lets a step be
 * queued, deduped, and executed away from the proof that produced it.
 */
export interface APRProofStep {
  /** The pending node to advance. */
  readonly node: KCFGNode;
  /** The proof's target node, for the subsumption check. */
  readonly target: KCFGNode;
  readonly proofId: string;
  /** `bmc_depth`; `undefined` disables bounded model checking for this step. */
  readonly bmcDepth: number | undefined;
  /**
   * The predecessor whose cached extension applies here, if any
   * (`reachability.py:195-198`). Set only when the node has exactly one
   * incoming `Edge` *and* that edge's source has a cached next step.
   */
  readonly useCache: number | undefined;
  /** The `-DEPENDS-MODULE` or `-CIRCULARITIES-MODULE` to execute against. */
  readonly moduleName: string;
  /** Non-zero-depth sources on the shortest path from `init`; empty unless BMC is on. */
  readonly shortestPathToNode: readonly KCFGNode[];
  /**
   * `prior_loops_cache` (`reachability.py:86`), declared `field(compare=False)`
   * upstream and therefore **excluded from {@link aprProofStepKey}**. It is an
   * accumulating memo, not part of the step's identity: two steps that differ
   * only in it are the same work.
   */
  readonly priorLoopsCache: ReadonlyMap<number, readonly number[]>;
  readonly circularity: boolean;
  /** `not kcfg.zero_depth_between(init, node)` (`reachability.py:248-249`). */
  readonly nonzeroDepth: boolean;
  /** `f'{rule_id}-{init}-TO-{target}'` (`reachability.py:210`). */
  readonly circularityRuleId: string;
}

/**
 * A stable value key for {@link APRProofStep}, for dedup in a concurrent driver.
 *
 * **Divergence.** pyk hashes the whole frozen dataclass, so `KCFG.Node`
 * participates by *value* — id, cterm, and attributes. Here nodes are keyed by
 * id alone. Within one `KCFG` an id identifies exactly one node, and the proof
 * id disambiguates across proofs, so the only case the two disagree on is a
 * node whose cterm changed in place (`letNode`) between two step batches:
 * pyk would call that a new step, this key calls it the same one. A concurrent
 * driver refetches steps after every commit, so that window does not arise in
 * practice.
 */
export function aprProofStepKey(step: APRProofStep): string {
  return JSON.stringify([
    step.proofId,
    step.node.id,
    step.target.id,
    step.bmcDepth ?? null,
    step.useCache ?? null,
    step.moduleName,
    step.shortestPathToNode.map((node) => node.id),
    step.circularity,
    step.nonzeroDepth,
    step.circularityRuleId,
  ]);
}

/** The fields every result carries (`APRProofResult`, `reachability.py:37-41`). */
export interface APRProofResultBase {
  /** The node the step was taken from. */
  readonly nodeId: number;
  /** `prior_loops_cache_update` — written to the cache before dispatch. */
  readonly priorLoopsCacheUpdate: readonly number[];
  /** `optimize_kcfg`, carried on the result because the prover owns the flag. */
  readonly optimizeKcfg: boolean;
}

/** `APRProofExtendResult` (`reachability.py:44-48`). */
export interface APRProofExtendResult extends APRProofResultBase {
  readonly kind: "extend";
  readonly extensionToApply: KCFGExtendResult;
}

/**
 * `APRProofExtendAndCacheResult` (`reachability.py:51-56`).
 *
 * Upstream this *is* an `APRProofExtendResult`; here the union member repeats
 * `extensionToApply` and `commit` must apply it as well as cache the second.
 */
export interface APRProofExtendAndCacheResult extends APRProofResultBase {
  readonly kind: "extend-and-cache";
  readonly extensionToApply: KCFGExtendResult;
  readonly extensionToCache: KCFGExtendResult;
}

/** `APRProofUseCacheResult` (`reachability.py:59-63`). */
export interface APRProofUseCacheResult extends APRProofResultBase {
  readonly kind: "use-cache";
  readonly cachedNodeId: number;
}

/** `APRProofSubsumeResult` (`reachability.py:66-68`). */
export interface APRProofSubsumeResult extends APRProofResultBase {
  readonly kind: "subsume";
  readonly csubst: CSubst;
}

/** `APRProofTerminalResult` (`reachability.py:71-72`). */
export interface APRProofTerminalResult extends APRProofResultBase {
  readonly kind: "terminal";
}

/** `APRProofBoundedResult` (`reachability.py:75-76`). */
export interface APRProofBoundedResult extends APRProofResultBase {
  readonly kind: "bounded";
}

/** Everything `APRProver.stepProof` can produce and `APRProof.commit` accepts. */
export type APRProofResult =
  | APRProofExtendResult
  | APRProofExtendAndCacheResult
  | APRProofUseCacheResult
  | APRProofSubsumeResult
  | APRProofTerminalResult
  | APRProofBoundedResult;

//////////////////////////
// The implies family   //
//////////////////////////

/**
 * The single step an implies-family proof ever takes
 * (`ImpliesProofStep`, `implies.py:31-33`).
 *
 * **Divergence, deliberate.** Upstream's step is `ImpliesProofStep(proof)` — a
 * frozen dataclass whose only field is the proof object itself, which
 * `ImpliesProver.step_proof` then reads (`implies.py:424-470`). That breaks the
 * protocol's own rule that a step references neither proof nor prover, and it
 * is safe upstream only because the proof takes exactly one step in its life.
 * Here the step carries the data instead:
 *
 * - `antecedent`/`consequent`/`bindUniversally` are what the prover simplifies
 *   and checks;
 * - {@link ImpliesProofStep.status} is the proof's status **at the moment
 *   `getSteps()` ran**, because upstream re-reads `step.proof.status` inside
 *   `step_proof` and returns no results unless it is `PENDING`. Nothing can
 *   change that status between the two calls in the serial driver — only
 *   `commit` mutates a proof, and a batch of one has nothing before it — so
 *   the snapshot is faithful, and it keeps the step self-contained for a
 *   concurrent one.
 *
 * `proofId` and `proofType` are carried for diagnostics; upstream logs both
 * from the proof object.
 */
export interface ImpliesProofStep {
  readonly proofId: string;
  /** `type(step.proof).__name__` (`implies.py:425`). */
  readonly proofType: string;
  readonly antecedent: KInner;
  readonly consequent: KInner;
  readonly bindUniversally: boolean;
  /** The proof's status when the step was produced; see the interface note. */
  readonly status: ProofStatus;
}

/**
 * `ImpliesProofResult` (`implies.py:36-39`).
 *
 * `csubst` absent means the implication did not hold — that is what makes the
 * proof `FAILED` once committed. The two simplified sides are typed as
 * present, where upstream types them `KInner | None`: its only producer always
 * sets both (`implies.py:463-467`), and a result that omitted them would make
 * a committed proof claim it can still progress.
 */
export interface ImpliesProofResult {
  readonly csubst: CSubst | undefined;
  readonly simplifiedAntecedent: KInner;
  readonly simplifiedConsequent: KInner;
}
