/**
 * `APRProver` — the all-path reachability step algorithm
 * (`proof/reachability.py:716-943`), plus `APRFailureInfo.from_proof`
 * (`:1008-1040`).
 *
 * Everything here talks to a backend, which is why it lives in the Node-only
 * `@kframework-ts/proof/prove` entry point rather than the pure core.
 *
 * # Divergences from pyk, all deliberate
 *
 * - **No client labelling in `initProof`.** pyk's first act is
 *   `client_label.set(proof.id)` (`reachability.py:777`), a `ContextVar` read
 *   by `KoreClient` when it mints request ids — and pyk documents that it does
 *   *not* propagate into worker threads. `@kframework-ts/kore-rpc` takes the
 *   label as a `KoreClient` construction option instead, so the label is set
 *   where the client is made. The consequence is the design this package
 *   already assumes elsewhere: **one client per proof**. Construct the client
 *   with `{ label: proof.id }` and the server-side logs match pyk's.
 * - **`APRFailureInfo.fromProof` is the free function
 *   {@link aprFailureInfoFromProof}.** A static on the class would put backend
 *   calls in the browser-safe entry point.
 * - **`stepTimeout` is enforced by the serial driver only**, which is also all
 *   upstream does: `kevm_pyk.utils.run_prover` forces a run sequential when a
 *   timeout is set (`utils.py:145-153`), because `parallel_advance_proof` never
 *   wraps a step in a budget. {@link proveClaims} reproduces that.
 *
 * # What the failure report needs from the adapter
 *
 * `KCFGExplore.implicationFailureReason` renders the per-cell explanation from
 * `CTermImplies.failing_cells` and the constraint-level
 * `remaining_implication` (`cterm/symbolic.py:330-359`). Both are computed by
 * the backend adapter, on request:
 * `@kframework-ts/cterm`'s `CTermSymbolic.implies` does so when passed
 * `failureReason: true`, which is exactly what `implicationFailureReason`
 * passes. An adapter that ignores the flag still works — the report degrades
 * to the bare `Matching failed.` line — but a real one produces pyk's full
 * text.
 */

import { CSubst } from "@kframework-ts/cterm";
import { type KFlatModule, type KRule, kflatmodule, kimport, match, Subst } from "@kframework-ts/kast";
import type { KCFGNode } from "@kframework-ts/kcfg";
import type { KCFGExplore, KCFGExtendResult } from "@kframework-ts/kcfg/explore";

import { APRProof } from "./apr.js";
import { APRFailureInfo, type ModelBinding } from "./failure.js";
import { ProofError, type Proof } from "./proof.js";
import type { Prover } from "./prover.js";
import type { APRProofResult, APRProofResultBase, APRProofStep } from "./step.js";
import { readProofData } from "./store.js";

/** Constructor options for {@link APRProver} (`reachability.py:731-757`). */
export interface APRProverOptions {
  /**
   * The module every non-injected request executes against. Defaults to
   * `cterm_symbolic._definition.main_module_name` (`reachability.py:747`),
   * which requires the explorer's adapter to carry a definition.
   */
  readonly mainModuleName?: string;
  /** `execute_depth` — the backend's `max-depth`. */
  readonly executeDepth?: number;
  readonly cutPointRules?: Iterable<string>;
  readonly terminalRules?: Iterable<string>;
  /** Ask the backend for a model of each failing node in the failure report. */
  readonly counterexampleInfo?: boolean;
  /** Skip the full subsumption RPC when the `<k>` cells cannot match. */
  readonly fastCheckSubsumption?: boolean;
  /** Summarise passed subproofs as a single `init => target` rule. */
  readonly directSubproofRules?: boolean;
  /** Assume the antecedent's configuration is defined in subsumption and failure checks. */
  readonly assumeDefined?: boolean;
  /** An extra module to file with the backend and execute against instead of the main one. */
  readonly extraModule?: KFlatModule;
  /** Merge each new step into its single incoming edge — `KCFG.extend`'s `optimize_kcfg`. */
  readonly optimizeKcfg?: boolean;
  /**
   * `step_timeout` — the per-step wall-clock budget in **whole seconds**.
   *
   * Clamped to at least 1 (`reachability.py:757`, `max(1, step_timeout)`) and
   * truncated to a whole number, because upstream's type is `int` and a budget
   * is compared against a socket round trip, not a stopwatch. Leave it unset to
   * disable the policy, which is the default everywhere but Kontrol.
   *
   * Enforced by {@link advanceProof}; see this module's header for why the
   * concurrent driver ignores it.
   */
  readonly stepTimeout?: number;
}

/** The subsumption/module capabilities `APRProver` needs beyond `KCFGSymbolic`'s core. */
function requireCapability<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new ProofError(`APRProver requires the symbolic adapter to implement ${name}`);
  }
  return value;
}

/** The prover half of all-path reachability, one proof at a time. */
export class APRProver implements Prover<APRProof, APRProofStep, APRProofResult> {
  readonly kcfgExplore: KCFGExplore;
  readonly mainModuleName: string;
  /** Mutable because {@link APRProver.shrinkStep} lowers it (`reachability.py:762-768`). */
  executeDepth: number | undefined;
  readonly cutPointRules: readonly string[];
  readonly terminalRules: readonly string[];
  readonly counterexampleInfo: boolean;
  readonly fastCheckSubsumption: boolean;
  readonly directSubproofRules: boolean;
  readonly assumeDefined: boolean;
  readonly extraModule: KFlatModule | undefined;
  readonly optimizeKcfg: boolean;
  readonly stepTimeout: number | undefined;

  constructor(kcfgExplore: KCFGExplore, options: APRProverOptions = {}) {
    this.kcfgExplore = kcfgExplore;
    const definition = kcfgExplore.symbolic.definition;
    const mainModuleName = options.mainModuleName ?? definition?.mainModuleName;
    if (mainModuleName === undefined) {
      throw new ProofError(
        "APRProver needs a main module name: the symbolic adapter carries no definition, so pass mainModuleName",
      );
    }
    this.mainModuleName = mainModuleName;
    this.executeDepth = options.executeDepth;
    this.cutPointRules = Object.freeze([...(options.cutPointRules ?? [])]);
    this.terminalRules = Object.freeze([...(options.terminalRules ?? [])]);
    this.counterexampleInfo = options.counterexampleInfo ?? false;
    this.fastCheckSubsumption = options.fastCheckSubsumption ?? false;
    this.directSubproofRules = options.directSubproofRules ?? false;
    this.assumeDefined = options.assumeDefined ?? false;
    this.extraModule = options.extraModule;
    this.optimizeKcfg = options.optimizeKcfg ?? false;
    // `max(1, step_timeout) if step_timeout is not None else None`
    // (`reachability.py:757`).
    this.stepTimeout = options.stepTimeout === undefined ? undefined : Math.max(1, Math.trunc(options.stepTimeout));
  }

  /**
   * `APRProver.shrink_step` (`reachability.py:762-768`).
   *
   * Halve the execution depth, floor 1, so the next `extendCterm` asks the
   * backend for less. `false` — the step is already minimal, stop the run —
   * when there is no depth to lower: an unset `executeDepth` means "as far as
   * the backend will go", which cannot be halved.
   */
  shrinkStep(): boolean {
    if (this.executeDepth === undefined || this.executeDepth <= 1) return false;
    this.executeDepth = Math.max(1, Math.floor(this.executeDepth / 2));
    return true;
  }

  /**
   * `APRProver.interrupt` (`reachability.py:770-771`).
   *
   * `KCFGExplore.interrupt` forwards to the adapter's, and
   * `@kframework-ts/cterm`'s `CTermSymbolic` forwards that to
   * `KoreClient.interrupt` — a cancel request on a second connection, which is
   * the interruptible resource pyk's docstring means. An adapter without one
   * makes this a no-op, and a timed-out step then runs until the backend
   * answers by itself.
   */
  interrupt(): void {
    this.kcfgExplore.interrupt();
  }

  /**
   * `APRProver.close` (`reachability.py:759-760`) — a documented no-op.
   *
   * Upstream reaches through two objects it does not own to call
   * `kcfg_explore.cterm_symbolic._kore_client.close()`. In this monorepo the
   * kore-rpc client's lifetime belongs to whoever constructed it — the
   * kore-rpc README is explicit about that — and `KCFGSymbolic` has no `close`
   * to reach. The method stays on the seam so a prover that *does* own a
   * resource has somewhere to release it.
   */
  close(): void {
    // Intentionally empty; see the doc comment.
  }

  /**
   * `APRProver.init_proof` (`reachability.py:773-802`).
   *
   * Three things happen, in order: the optional extra module is filed and
   * becomes the base module; every `APRProof` subproof is read *from disk* and
   * its rules are filed as `M-<ID>-DEPENDS-MODULE`, importing the base module;
   * a circularity additionally gets `M-<ID>-CIRCULARITIES-MODULE`, importing
   * the depends module and holding the single `init => target` rule at
   * priority 20.
   *
   * Then `init` and `target` are marked terminal if the semantics says so —
   * **the one place a prover mutates a proof** outside `commit`.
   *
   * Subproofs are re-read rather than taken from `proof.subproofs` because
   * upstream does (`reachability.py:790-794`): a subproof advanced by another
   * process since this proof was loaded contributes its *current* rules.
   */
  async initProof(proof: APRProof): Promise<void> {
    const symbolic = this.kcfgExplore.symbolic;
    const addModule = requireCapability(symbolic.addModule?.bind(symbolic), "addModule");

    let mainModuleName = this.mainModuleName;
    if (this.extraModule !== undefined) {
      mainModuleName = await addModule(this.extraModule, { nameAsId: true });
    }

    const injectModule = async (moduleName: string, importName: string, sentences: readonly KRule[]): Promise<void> => {
      await addModule(kflatmodule(moduleName, { sentences, imports: [kimport(importName)] }), { nameAsId: true });
    };

    const proofDir = proof.proofDir;
    const subproofs: Proof[] = [];
    if (proofDir !== undefined) {
      for (const subproofId of proof.subproofIds) subproofs.push(await readProofData(proofDir, subproofId));
    }
    const dependenciesAsRules = subproofs
      .filter((subproof): subproof is APRProof => subproof instanceof APRProof)
      .flatMap((subproof) => [...subproof.asRules(20, this.directSubproofRules)]);
    await injectModule(proof.dependenciesModuleName, mainModuleName, dependenciesAsRules);

    if (proof.circularity) {
      await injectModule(proof.circularitiesModuleName, proof.dependenciesModuleName, [proof.asRule(20)]);
    }

    for (const nodeId of [proof.init, proof.target]) {
      if (this.kcfgExplore.semantics.isTerminal(proof.kcfg.node(nodeId).cterm)) proof.addTerminal(nodeId);
    }
  }

  /**
   * `APRProver.step_proof` (`reachability.py:828-941`).
   *
   * The order of the five decisions is load-bearing:
   *
   * 1. **BMC bounding.** Only when the node is a loop head; the prior-loop
   *    chain is walked over the step's shortest path with the loops cache, and
   *    strictly *more* than `bmcDepth` prior loops bounds the node.
   * 2. **Terminality.** The node's and the target's are computed together.
   * 3. **Subsumption, gated on terminality agreeing** (`:863`). This is the
   *    easiest rule in the algorithm to lose: a terminal node is never checked
   *    against a non-terminal target, and vice versa. A successful subsumption
   *    returns the terminal result *as well*, so the terminal set stays right.
   * 4. **Cut rules and depth.** A circularity at non-zero depth cuts at its own
   *    rule so subsumption gets a chance; a circularity at *zero* depth forces
   *    `executeDepth` to 1 so progress is recorded as early as possible.
   * 5. **The cache, then the backend.** A cache hit returns without any RPC.
   *    Otherwise `extendCterm` yields at most two results; two results at
   *    non-zero depth become an extend-and-cache, anything else discards the
   *    second.
   */
  async stepProof(step: APRProofStep): Promise<readonly APRProofResult[]> {
    const semantics = this.kcfgExplore.semantics;

    let priorLoops: readonly number[] = [];
    if (step.bmcDepth !== undefined && semantics.isLoop(step.node.cterm)) {
      for (const node of step.shortestPathToNode) {
        if (semantics.sameLoop(node.cterm, step.node.cterm)) {
          const cached = step.priorLoopsCache.get(node.id);
          if (cached !== undefined) {
            priorLoops = Object.freeze([...cached, node.id]);
            break;
          }
        }
      }
      if (priorLoops.length > step.bmcDepth) {
        return Object.freeze([{ ...this.#base(step, priorLoops), kind: "bounded" as const }]);
      }
    }

    const isTerminal = semantics.isTerminal(step.node.cterm);
    const targetIsTerminal = semantics.isTerminal(step.target.cterm);
    const terminalResult: readonly APRProofResult[] = isTerminal
      ? Object.freeze([{ ...this.#base(step, priorLoops), kind: "terminal" as const }])
      : Object.freeze([]);

    if (isTerminal === targetIsTerminal) {
      const csubst = await this.checkSubsume(step.node, step.target);
      if (csubst !== undefined) {
        return Object.freeze([
          ...terminalResult,
          { ...this.#base(step, priorLoops), kind: "subsume" as const, csubst },
        ]);
      }
    }

    if (isTerminal) return terminalResult;

    const cutRules = [...this.cutPointRules];
    if (step.circularity && step.nonzeroDepth) cutRules.push(step.circularityRuleId);

    let executeDepth = this.executeDepth;
    if (step.circularity && !step.nonzeroDepth) executeDepth = 1;

    if (step.useCache !== undefined) {
      return Object.freeze([
        { ...this.#base(step, priorLoops), kind: "use-cache" as const, cachedNodeId: step.useCache },
      ]);
    }

    const extendResults = await this.kcfgExplore.extendCterm(step.node.cterm, step.node.id, {
      ...(executeDepth === undefined ? {} : { executeDepth }),
      cutPointRules: cutRules,
      terminalRules: this.terminalRules,
      module: step.moduleName,
    });

    // `assert len(extend_results) <= 2` (`reachability.py:925`).
    if (extendResults.length > 2 || extendResults.length === 0) {
      throw new ProofError(
        `Expected one or two extension results for node ${step.node.id} of proof ${step.proofId}, got ${extendResults.length}`,
      );
    }
    const first: KCFGExtendResult = extendResults[0]!;
    const second = extendResults[1];
    if (second !== undefined && step.nonzeroDepth) {
      return Object.freeze([
        {
          ...this.#base(step, priorLoops),
          kind: "extend-and-cache" as const,
          extensionToApply: first,
          extensionToCache: second,
        },
      ]);
    }
    return Object.freeze([{ ...this.#base(step, priorLoops), kind: "extend" as const, extensionToApply: first }]);
  }

  /** `APRProver.failure_info` (`reachability.py:943-946`). */
  failureInfo(proof: APRProof): Promise<APRFailureInfo> {
    return aprFailureInfoFromProof(proof, this.kcfgExplore, {
      counterexampleInfo: this.counterexampleInfo,
      assumeDefined: this.assumeDefined,
    });
  }

  /**
   * `APRProver._may_subsume` (`reachability.py:809-814`) — the cheap pre-filter.
   *
   * Both `<k>` cells present and the target's failing to match the node's is
   * the only case that skips the RPC.
   */
  maySubsume(node: KCFGNode, targetNode: KCFGNode): boolean {
    const nodeKCell = node.cterm.tryCell("K_CELL");
    const targetKCell = targetNode.cterm.tryCell("K_CELL");
    if (nodeKCell !== undefined && targetKCell !== undefined && match(targetKCell, nodeKCell) === null) return false;
    return true;
  }

  /** `APRProver._check_subsume` (`reachability.py:816-826`). */
  async checkSubsume(node: KCFGNode, targetNode: KCFGNode): Promise<CSubst | undefined> {
    if (this.fastCheckSubsumption && !this.maySubsume(node, targetNode)) return undefined;
    const symbolic = this.kcfgExplore.symbolic;
    const implies = requireCapability(symbolic.implies?.bind(symbolic), "implies");
    const result = await implies(node.cterm, targetNode.cterm, { assumeDefined: this.assumeDefined });
    // `KCFGSymbolic` keeps `csubst` opaque on purpose (`kcfg/explore.ts`), so
    // the concrete type is recovered here rather than asserted.
    return result.csubst instanceof CSubst ? result.csubst : undefined;
  }

  #base(step: APRProofStep, priorLoops: readonly number[]): APRProofResultBase {
    return { nodeId: step.node.id, priorLoopsCacheUpdate: priorLoops, optimizeKcfg: this.optimizeKcfg };
  }
}

/** Options for {@link aprFailureInfoFromProof} (`reachability.py:1008-1010`). */
export interface APRFailureInfoOptions {
  readonly counterexampleInfo?: boolean;
  readonly assumeDefined?: boolean;
}

/**
 * `APRFailureInfo.from_proof` (`reachability.py:1007-1040`).
 *
 * Two backend round trips per failing node — the node and the target are each
 * simplified before the implication is re-checked for its failure reason — plus
 * one more when `counterexampleInfo` asks for a model. The target is
 * re-simplified inside the loop exactly as upstream does it; that is redundant
 * work, and it is transcribed rather than hoisted so the request trace matches.
 *
 * See this module's header for what the failure reason currently contains.
 */
export async function aprFailureInfoFromProof(
  proof: APRProof,
  kcfgExplore: KCFGExplore,
  options: APRFailureInfoOptions = {},
): Promise<APRFailureInfo> {
  const counterexampleInfo = options.counterexampleInfo ?? false;
  const assumeDefined = options.assumeDefined ?? false;
  const target = proof.kcfg.node(proof.target);
  const pendingNodes = proof.pending.map((node) => node.id);
  const failing = proof.failing;
  const pathConditions = new Map<number, string>();
  const failureReasons = new Map<number, string>();
  const models = new Map<number, readonly ModelBinding[]>();

  for (const node of failing) {
    const nodeCterm = (await kcfgExplore.symbolic.simplify(node.cterm)).cterm;
    const targetCterm = (await kcfgExplore.symbolic.simplify(target.cterm)).cterm;
    const [, reason] = await kcfgExplore.implicationFailureReason(nodeCterm, targetCterm, assumeDefined);
    failureReasons.set(node.id, reason);
    pathConditions.set(node.id, kcfgExplore.prettyPrint(proof.pathConstraints(node.id)));
    if (counterexampleInfo) {
      const getModel = kcfgExplore.symbolic.getModel?.bind(kcfgExplore.symbolic);
      const modelResult = await getModel?.(node.cterm);
      const substitution = modelResult?.model;
      if (substitution instanceof Subst) {
        const bindings: ModelBinding[] = [];
        for (const [variable, term] of substitution) bindings.push([variable, kcfgExplore.prettyPrint(term)]);
        models.set(node.id, bindings);
      }
    }
  }

  return new APRFailureInfo({
    failingNodes: failing.map((node) => node.id),
    pendingNodes,
    pathConditions,
    failureReasons,
    models,
  });
}
