/**
 * `APRProof` — an all-path reachability proof (`proof/reachability.py:93-713`).
 *
 * All-path reachability logic as introduced by A. Stefanescu and others in
 * "All-Path Reachability Logic" (https://doi.org/10.23638/LMCS-15(2:5)2019),
 * extended with bounded model checking through an optional per-loop iteration
 * bound. There is deliberately no `APRBMCProof`: upstream folded it into this
 * class, and the on-disk `type` is `"APRProof"` either way.
 *
 * Two structural departures from pyk, both documented in the package README:
 *
 * - **Composition, not inheritance.** pyk writes
 *   `class APRProof(Proof, KCFGExploration)`. Here the proof *holds* a
 *   {@link KCFGExploration}; `kcfg`, `logs`, and the terminal helpers are
 *   forwarded, because every CLI that layers interactive graph surgery on a
 *   proof needs them mutable.
 * - **No store handle on the graph.** pyk's constructor reaches into the KCFG
 *   and replaces `kcfg._kcfg_store`. Persistence here lives entirely in
 *   `@kframework-ts/proof/store`, which produces the same `<proofDir>/<id>/kcfg/`
 *   layout without the graph knowing where it came from.
 */

import {
  KCFG,
  edgeToClaim,
  edgeToRule,
  kcfgToRules,
  pathsBetween,
  type KCFGNode,
  type KCFGPath,
  type NodeIdLike,
} from "@kframework-ts/kcfg";
import { extendKcfg, KCFGExploration, type KCFGExtendResult } from "@kframework-ts/kcfg/explore";
import { KCFGMinimizer, type KCFGSemantics } from "@kframework-ts/kcfg/minimize";
import {
  flattenLabel,
  freeVars,
  mlPredToBool,
  removeUselessConstraints,
  type KClaim,
  type KDefinition,
  type KInner,
  type KRule,
} from "@kframework-ts/kast";
import { mlAnd, mlTop } from "@kframework-ts/kast/prelude/ml";
import { claimDependencies, claimIsCircularity, claimIsTrusted, sentenceLabel } from "@kframework-ts/kast";
import type { LogEntry } from "@kframework-ts/kore-rpc";

import { RefutationProof } from "./implies.js";
import { decodeProofLogs, encodeProofLogs } from "./logs.js";
import { baseProofDict, Proof, ProofError, type ProofOptions } from "./proof.js";
import { kcfgFromClaim } from "./rules.js";
import { ProofStatus } from "./status.js";
import type { APRProofResult, APRProofStep } from "./step.js";
import { APRSummary, CompositeSummary, type ProofSummary } from "./summary.js";

/** Node-id-keyed maps accept either a `Map` or a plain object, as JSON gives them. */
export type NodeIdMap<T> = ReadonlyMap<number, T> | Readonly<Record<string | number, T>>;

function asNodeIdMap<T>(source: NodeIdMap<T> | undefined): Map<number, T> {
  const out = new Map<number, T>();
  if (source === undefined) return out;
  const entries: readonly (readonly [string | number, T])[] =
    source instanceof Map ? [...source.entries()] : Object.entries(source);
  for (const [key, value] of entries) {
    const id = typeof key === "number" ? key : Number(key);
    if (!Number.isSafeInteger(id)) throw new ProofError(`Expected an integer node id, got ${JSON.stringify(key)}`);
    out.set(id, value);
  }
  return out;
}

/** Constructor options for {@link APRProof} (`reachability.py:120-137`). */
export interface APRProofOptions extends ProofOptions {
  readonly bmcDepth?: number | undefined;
  readonly bounded?: Iterable<number> | undefined;
  /** Node id → refutation *proof id*; each must also appear among the subproofs. */
  readonly nodeRefutations?: NodeIdMap<string> | undefined;
  readonly circularity?: boolean | undefined;
  /** `_exec_time` (`reachability.py:135`), seconds. */
  readonly execTime?: number | undefined;
  /** In-memory only; never serialized. */
  readonly errorInfo?: Error | undefined;
  readonly priorLoopsCache?: NodeIdMap<Iterable<number>> | undefined;
}

/** An all-path reachability proof over a `KCFG`. */
export class APRProof extends Proof {
  /** The terminal/explorable view; `exploration.kcfg` is the graph itself. */
  readonly exploration: KCFGExploration;
  /** Public and mutable: `logs[nodeId]` is the rewrite trace that produced it. */
  logs: Map<number, readonly LogEntry[]>;
  init: number;
  target: number;
  bmcDepth: number | undefined;
  circularity: boolean;
  /** Node id → the `RefutationProof` currently blocking it. */
  readonly nodeRefutations = new Map<number, RefutationProof>();
  /** `prior_loops_cache` (`reachability.py:115`); persisted as `loops_cache`. */
  priorLoopsCache: Map<number, readonly number[]>;
  /** In-memory only (`reachability.py:114`); never serialized. */
  errorInfo: Error | undefined;

  readonly #bounded = new Set<number>();
  /**
   * `_next_steps` (`reachability.py:118`) — the extend cache.
   *
   * In memory only. It is deliberately absent from both serialization schemas,
   * so resuming a proof from disk re-executes a cached cut step rather than
   * replaying it. Keyed by the *source* node of the edge whose second
   * extension result was held back.
   */
  readonly #nextSteps = new Map<number, KCFGExtendResult>();
  #execTime: number;

  constructor(
    id: string,
    kcfg: KCFG,
    terminal: Iterable<NodeIdLike>,
    init: NodeIdLike,
    target: NodeIdLike,
    logs: NodeIdMap<readonly LogEntry[]> = new Map(),
    options: APRProofOptions = {},
  ) {
    super(id, options);
    this.exploration = new KCFGExploration(kcfg, terminal);
    this.init = kcfg.resolve(init);
    this.target = kcfg.resolve(target);
    this.bmcDepth = options.bmcDepth;
    for (const nodeId of options.bounded ?? []) this.#bounded.add(nodeId);
    this.logs = asNodeIdMap(logs);
    this.circularity = options.circularity ?? false;
    this.errorInfo = options.errorInfo;
    this.#execTime = options.execTime ?? 0;

    this.priorLoopsCache = new Map();
    for (const [nodeId, loops] of asNodeIdMap(options.priorLoopsCache)) {
      this.priorLoopsCache.set(nodeId, Object.freeze([...loops]));
    }

    // `reachability.py:164-175`. A refutation that is not also a subproof
    // would make the proof unable to explain why it cannot pass.
    const refutations = asNodeIdMap(options.nodeRefutations);
    if (refutations.size > 0) {
      const declared = new Set(this.subproofIds);
      const violators = [...new Set(refutations.values())].filter((proofId) => !declared.has(proofId));
      if (violators.length > 0) {
        throw new ProofError(
          `All node refutations must be included in subproofs, violators are ${violators.join(", ")}`,
        );
      }
      for (const [nodeId, proofId] of refutations) {
        const subproof = this.getSubproof(proofId);
        if (!(subproof instanceof RefutationProof)) {
          throw new ProofError(`Subproof ${proofId} of ${id} must be a RefutationProof to refute node ${nodeId}`);
        }
        this.nodeRefutations.set(nodeId, subproof);
      }
    }
  }

  override get proofType(): string {
    return "APRProof";
  }

  /** The graph itself; mutating it in place is the supported interactive workflow. */
  get kcfg(): KCFG {
    return this.exploration.kcfg;
  }

  //////////////////////////
  // Terminal-node view   //
  //////////////////////////

  get terminalIds(): ReadonlySet<number> {
    return this.exploration.terminalIds;
  }
  get terminal(): readonly KCFGNode[] {
    return this.exploration.terminal;
  }
  get explorable(): readonly KCFGNode[] {
    return this.exploration.explorable;
  }
  isTerminal(nodeId: NodeIdLike): boolean {
    return this.exploration.isTerminal(nodeId);
  }
  isExplorable(nodeId: NodeIdLike): boolean {
    return this.exploration.isExplorable(nodeId);
  }
  addTerminal(nodeId: NodeIdLike): void {
    this.exploration.addTerminal(nodeId);
  }
  removeTerminal(nodeId: NodeIdLike): void {
    this.exploration.removeTerminal(nodeId);
  }
  removeNode(nodeId: NodeIdLike): void {
    this.exploration.removeNode(nodeId);
  }

  /** `KCFGExploration.minimize_kcfg` (`kcfg/exploration.py:111-113`). */
  minimizeKcfg(heuristics?: KCFGSemantics, merge = false): void {
    const minimizer =
      heuristics === undefined ? new KCFGMinimizer(this.kcfg) : new KCFGMinimizer(this.kcfg, heuristics);
    minimizer.minimize(merge);
  }

  //////////////////////////
  // Node classification  //
  //////////////////////////

  /** `APRProof.is_refuted` (`reachability.py:271-272`). */
  isRefuted(nodeId: NodeIdLike): boolean {
    return this.nodeRefutations.has(this.kcfg.resolve(nodeId));
  }

  /** `APRProof.is_bounded` (`reachability.py:306-307`). */
  isBounded(nodeId: NodeIdLike): boolean {
    return this.#bounded.has(this.kcfg.resolve(nodeId));
  }

  /** `APRProof.is_init` (`reachability.py:290-291`). */
  isInit(nodeId: NodeIdLike): boolean {
    return this.kcfg.resolve(nodeId) === this.kcfg.resolve(this.init);
  }

  /** `APRProof.is_target` (`reachability.py:293-294`). */
  isTarget(nodeId: NodeIdLike): boolean {
    return this.kcfg.resolve(nodeId) === this.kcfg.resolve(this.target);
  }

  /** `APRProof.is_pending` (`reachability.py:274-280`). */
  isPending(nodeId: NodeIdLike): boolean {
    return this.isExplorable(nodeId) && !this.isTarget(nodeId) && !this.isRefuted(nodeId) && !this.isBounded(nodeId);
  }

  /** `APRProof.is_failing` (`reachability.py:296-304`). */
  isFailing(nodeId: NodeIdLike): boolean {
    return (
      this.kcfg.isLeaf(nodeId) &&
      !this.isExplorable(nodeId) &&
      !this.isTarget(nodeId) &&
      !this.isRefuted(nodeId) &&
      !this.kcfg.isVacuous(nodeId) &&
      !this.isBounded(nodeId)
    );
  }

  /** `APRProof.pending` (`reachability.py:259-261`). */
  get pending(): readonly KCFGNode[] {
    return Object.freeze(this.explorable.filter((node) => this.isPending(node.id)));
  }

  /** `APRProof.failing` (`reachability.py:263-265`). */
  get failing(): readonly KCFGNode[] {
    return Object.freeze(this.kcfg.leaves.filter((node) => this.isFailing(node.id)));
  }

  /** `APRProof.bounded` (`reachability.py:267-269`). */
  get bounded(): readonly KCFGNode[] {
    return Object.freeze(this.kcfg.leaves.filter((node) => this.isBounded(node.id)));
  }

  /** Every bounded node id, including any no longer in the graph. */
  get boundedIds(): ReadonlySet<number> {
    return new Set(this.#bounded);
  }

  /** `APRProof.add_bounded` (`reachability.py:309-310`). */
  addBounded(nodeId: NodeIdLike): void {
    this.#bounded.add(this.kcfg.resolve(nodeId));
  }

  /** `APRProof.own_status` (`reachability.py:365-373`). */
  override get ownStatus(): ProofStatus {
    if (this.admitted) return ProofStatus.PASSED;
    if (this.failing.length > 0) return ProofStatus.FAILED;
    if (this.pending.length > 0) return ProofStatus.PENDING;
    return ProofStatus.PASSED;
  }

  /** `APRProof.can_progress` (`reachability.py:375-377`). */
  override get canProgress(): boolean {
    return this.pending.length > 0;
  }

  //////////////////////////
  // Names and identities //
  //////////////////////////

  /** `APRProof.rule_id` (`reachability.py:251-253`). */
  get ruleId(): string {
    return `APRPROOF-${this.id.toUpperCase()}`;
  }

  /** `APRProof.module_name` (`reachability.py:255-257`). */
  get moduleName(): string {
    return APRProof.makeModuleName(this.id);
  }

  /** `APRProof.circularities_module_name` (`reachability.py:282-284`). */
  get circularitiesModuleName(): string {
    return `${this.moduleName}-CIRCULARITIES-MODULE`;
  }

  /** `APRProof.dependencies_module_name` (`reachability.py:286-288`). */
  get dependenciesModuleName(): string {
    return `${this.moduleName}-DEPENDS-MODULE`;
  }

  /**
   * `APRProof._make_module_name` (`reachability.py:350-354`).
   *
   * Brackets become the literal `bkt`; every run of `_%().:,@` collapses to one
   * `-`. Proof ids are claim labels, which routinely contain all of these.
   */
  static makeModuleName(proofId: string): string {
    return `M-${proofId.toUpperCase().replace(/[[\]]|[_%().:,@]+/gu, (match) => (match === "[" || match === "]" ? "bkt" : "-"))}`;
  }

  /** `APRProof.get_refutation_id` (`reachability.py:574-575`). */
  getRefutationId(nodeId: number): string {
    return `${this.id}.node-infeasible-${nodeId}`;
  }

  //////////////////////////
  // Graph queries        //
  //////////////////////////

  /** `APRProof.nonzero_depth` (`reachability.py:248-249`). */
  nonzeroDepth(node: KCFGNode): boolean {
    return !this.kcfg.zeroDepthBetween(this.init, node.id);
  }

  /** `APRProof.shortest_path_to` (`reachability.py:312-315`). */
  shortestPathTo(nodeId: NodeIdLike): KCFGPath {
    const path = this.kcfg.shortestPathBetween(this.init, nodeId);
    if (path === undefined) throw new ProofError(`No path from ${this.init} to ${String(nodeId)} in proof ${this.id}`);
    return path;
  }

  /**
   * `APRProof.prune` (`reachability.py:317-326`).
   *
   * `init` and `target` are always kept, and the loops cache is scrubbed of
   * pruned ids both as keys and as values.
   */
  prune(nodeId: NodeIdLike, keepNodes: Iterable<NodeIdLike> = []): readonly number[] {
    const pruned = this.exploration.prune(nodeId, [...keepNodes, this.init, this.target]);
    for (const id of pruned) {
      this.#bounded.delete(id);
      this.priorLoopsCache.delete(id);
      for (const [key, loops] of this.priorLoopsCache) {
        if (loops.includes(id)) this.priorLoopsCache.set(key, Object.freeze(loops.filter((loop) => loop !== id)));
      }
    }
    return pruned;
  }

  /**
   * `APRProof.path_constraints` (`reachability.py:501-513`).
   *
   * Walks the shortest path backwards, accumulating each `Split`'s branch
   * predicate and each `Cover`'s constraint (with the cover's substitution
   * applied to everything already collected).
   */
  pathConstraints(finalNodeId: NodeIdLike, sortWith?: KDefinition): KInner {
    let current: KInner = mlTop();
    for (const step of this.shortestPathTo(finalNodeId).toReversed()) {
      if (step.successor.kind === "split") {
        const split = step.successor;
        const branch = split.targets.find((candidate) => candidate.node.id === step.target);
        if (branch === undefined) throw new ProofError(`Split step in proof ${this.id} has no target ${step.target}`);
        current = mlAnd([
          branch.csubst.pred({ ...(sortWith === undefined ? {} : { sortWith }), constraints: false }),
          branch.csubst.constraint,
          current,
        ]);
      }
      if (step.successor.kind === "cover") {
        current = mlAnd([step.successor.csubst.constraint, step.successor.csubst.subst.apply(current)]);
      }
    }
    return mlAnd(flattenLabel("#And", current));
  }

  //////////////////////////
  // Refutations          //
  //////////////////////////

  /**
   * `APRProof.construct_node_refutation` (`reachability.py:672-713`) — the pure
   * half of `refuteNode`.
   *
   * A refutation says "the branch condition that produced this node is
   * unsatisfiable given the constraints that were already in force". Building
   * one means walking back from the node to the nearest branch and turning that
   * branch's own predicate into a `RefutationProof` goal:
   * `preConstraints #Implies (lastConstraint #Equals false)`.
   *
   * The refutation is registered as a **subproof** here — that mutation is
   * upstream's too (`reachability.py:712`) — but it is *not* recorded in
   * {@link APRProof.nodeRefutations}: `refuteNode` in
   * `@kframework-ts/proof/store` does that, after writing it to disk.
   *
   * Returns `undefined`, where pyk logs an error and returns `None`, in four
   * cases:
   *
   * 1. the node already has successors — there is nothing left to refute;
   * 2. the path from `init` is linear, so no branch introduced a condition;
   * 3. the closest branch is an `NDBranch`, which upstream marks "not yet
   *    implemented";
   * 4. the branch's substitution is not the identity, which would make the
   *    branch predicate alone an incomplete description of the branch.
   *
   * Two upstream details are transcribed rather than improved:
   *
   * - The csubst taken is **`targets[0]`'s** — the split's *first* branch, not
   *   the branch this node actually descends from. For the two-way splits a
   *   symbolic backend produces from a single rule pair, and for the multi-way
   *   splits the test suite covers, every branch of the closest split refutes
   *   the same way, so upstream never notices.
   * - `removeUselessConstraints` is seeded with the free variables of the
   *   branch predicate only, so a pre-existing constraint about unrelated
   *   variables is dropped from the refutation goal.
   */
  constructNodeRefutation(node: KCFGNode | NodeIdLike): RefutationProof | undefined {
    const target = this.kcfg.node(typeof node === "object" && node !== null && "id" in node ? node.id : node);
    if (this.kcfg.successors(target.id).length > 0) return undefined;

    const paths = pathsBetween(this.kcfg, this.init, target.id);
    // `single(...)` (`utils.py`), reached from `reachability.py:677`.
    if (paths.length !== 1) {
      throw new ProofError(
        `Expected exactly one path from ${this.init} to ${target.id} in proof ${this.id}, found ${paths.length}`,
      );
    }
    const branchesOnPath = paths[0]!
      .map((step) => step.successor)
      .toReversed()
      .filter((successor) => successor.kind === "split" || successor.kind === "ndbranch");
    const closestBranch = branchesOnPath[0];
    if (closestBranch === undefined) return undefined;
    if (closestBranch.kind !== "split") return undefined;

    const refutedBranchRoot = closestBranch.targets[0];
    if (refutedBranchRoot === undefined) return undefined;
    const csubst = refutedBranchRoot.csubst;
    if (!csubst.subst.isIdentity) return undefined;

    const lastConstraint = mlPredToBool(csubst.constraint);
    const relevantVars = freeVars(lastConstraint);
    const preSplitConstraints = removeUselessConstraints(closestBranch.source.cterm.constraints, relevantVars).map(
      (constraint) => mlPredToBool(constraint),
    );

    const refutation = new RefutationProof(
      this.getRefutationId(target.id),
      preSplitConstraints,
      lastConstraint,
      this.proofDir === undefined ? {} : { proofDir: this.proofDir },
    );
    this.addSubproof(refutation);
    return refutation;
  }

  //////////////////////////
  // Step protocol        //
  //////////////////////////

  /**
   * The extend cache, read-only (`_next_steps`, `reachability.py:118`).
   *
   * Exposed for inspection and for tests that pin its in-memory-only nature;
   * `commit` is the only thing that writes it.
   */
  get nextSteps(): ReadonlyMap<number, KCFGExtendResult> {
    return new Map(this.#nextSteps);
  }

  /**
   * `APRProof.get_steps` (`reachability.py:177-215`) — pure and repeatable.
   *
   * One step per pending node. Three details are easy to lose:
   *
   * - The BMC shortest path **skips zero-depth sources**, so a split's children
   *   do not count as loop iterations.
   * - The module is the circularities module only when the node is at non-zero
   *   depth *and* the proof is a circularity; otherwise it is the depends
   *   module.
   * - `use_cache` comes from `single(kcfg.edges(target_id=node.id))`
   *   (`reachability.py:194-197`), so **more than one incoming edge throws**
   *   and a `Split` predecessor — which contributes zero edges — simply means
   *   no cache.
   */
  getSteps(): readonly APRProofStep[] {
    const target = this.kcfg.node(this.target);
    const circularityRuleId = `${this.ruleId}-${this.init}-TO-${this.target}`;
    const priorLoopsCache: ReadonlyMap<number, readonly number[]> = new Map(this.priorLoopsCache);
    return Object.freeze(
      this.pending.map((node): APRProofStep => {
        const shortestPath: KCFGNode[] = [];
        if (this.bmcDepth !== undefined) {
          for (const step of this.shortestPathTo(node.id).toReversed()) {
            const source = step.successor.source;
            if (!this.kcfg.zeroDepthBetween(source.id, node.id)) shortestPath.push(source);
          }
        }
        const nonzeroDepth = this.nonzeroDepth(node);
        const predecessorEdges = this.kcfg.edges({ target: node.id });
        if (predecessorEdges.length > 1) {
          // `single()` (`utils.py`), reached from `reachability.py:196`.
          throw new ProofError(
            `Node ${node.id} of proof ${this.id} has ${predecessorEdges.length} incoming edges, expected at most one`,
          );
        }
        const predecessorNodeId = predecessorEdges[0]?.source.id;
        return Object.freeze({
          node,
          target,
          proofId: this.id,
          bmcDepth: this.bmcDepth,
          useCache:
            predecessorNodeId !== undefined && this.#nextSteps.has(predecessorNodeId) ? predecessorNodeId : undefined,
          moduleName: nonzeroDepth && this.circularity ? this.circularitiesModuleName : this.dependenciesModuleName,
          shortestPathToNode: Object.freeze(shortestPath),
          priorLoopsCache,
          circularity: this.circularity,
          nonzeroDepth,
          circularityRuleId,
        });
      }),
    );
  }

  /**
   * `APRProof.commit` (`reachability.py:217-243`) — the only mutator.
   *
   * The loops-cache update lands **first**, before any dispatch, exactly as
   * upstream. `"extend-and-cache"` both records the held-back extension and
   * applies the first one, because upstream's and-cache result *is* an extend
   * result (see `step.ts`'s header); caching over an occupied slot is an
   * `assert` upstream and an error here.
   */
  commit(result: APRProofResult): void {
    this.priorLoopsCache.set(result.nodeId, Object.freeze([...result.priorLoopsCacheUpdate]));
    switch (result.kind) {
      case "use-cache": {
        const cached = this.#nextSteps.get(result.cachedNodeId);
        if (cached === undefined) {
          throw new ProofError(
            `Proof ${this.id} has no cached next step for node ${result.cachedNodeId}, required to commit node ${result.nodeId}`,
          );
        }
        this.#nextSteps.delete(result.cachedNodeId);
        this.#applyExtension(result.nodeId, cached, result.optimizeKcfg);
        break;
      }
      case "extend-and-cache":
        if (this.#nextSteps.has(result.nodeId)) {
          throw new ProofError(`Proof ${this.id} already has a cached next step for node ${result.nodeId}`);
        }
        this.#nextSteps.set(result.nodeId, result.extensionToCache);
        this.#applyExtension(result.nodeId, result.extensionToApply, result.optimizeKcfg);
        break;
      case "extend":
        this.#applyExtension(result.nodeId, result.extensionToApply, result.optimizeKcfg);
        break;
      case "subsume":
        this.kcfg.createCover(result.nodeId, this.target, result.csubst);
        break;
      case "terminal":
        this.addTerminal(result.nodeId);
        break;
      case "bounded":
        this.addBounded(result.nodeId);
        break;
    }
  }

  #applyExtension(nodeId: number, extension: KCFGExtendResult, optimizeKcfg: boolean): void {
    // `@kframework-ts/kcfg` is deliberately log-agnostic — `KCFGExtendResult`
    // types its logs as `readonly unknown[]` — but the values are the very
    // `LogEntry` objects `CTermSymbolic.execute` decoded, which is why
    // upstream's `dict[int, tuple[LogEntry, ...]]` can be handed straight to
    // `KCFG.extend` (`reachability.py:224-236`). The map is passed as the
    // wider `KCFGNodeLogs` and gets those same entries back.
    extendKcfg(this.kcfg, this.kcfg.node(nodeId), [extension], { logs: this.logs, optimizeKcfg });
  }

  //////////////////////////
  // Rules and claims     //
  //////////////////////////

  /**
   * `APRProof.as_rule` (`reachability.py:459-463`) — the synthetic depth-0
   * `init => target`.
   *
   * Upstream fabricates `KCFG.Edge(init, target, depth=0, rules=())` to reach
   * `Edge.to_rule`; `@kframework-ts/kcfg`'s `edge()` rejects a non-positive
   * depth, so the bare `{ source, target }` pair its `edgeToRule` accepts
   * (pyk's `EdgeLike` shape) stands in for it.
   */
  asRule(priority = 20): KRule {
    return edgeToRule(this.#initToTarget(), this.ruleId, { priority });
  }

  /** `APRProof.as_claim` (`reachability.py:465-469`). */
  asClaim(): KClaim {
    return edgeToClaim(this.#initToTarget(), this.ruleId);
  }

  /** The `{ source, target }` pair {@link APRProof.asRule} and {@link APRProof.asClaim} share. */
  #initToTarget(): { readonly source: KCFGNode; readonly target: KCFGNode } {
    return { source: this.kcfg.node(this.init), target: this.kcfg.node(this.target) };
  }

  /**
   * `APRProof.as_rules` (`reachability.py:445-457`).
   *
   * A circularity, a passed proof asked for directly, or an admitted proof
   * whose target has no predecessors summarises to the single `init => target`
   * rule; anything else contributes its edges as basic blocks.
   */
  asRules(priority = 20, directRule = false): readonly KRule[] {
    if (
      this.circularity ||
      (this.passed && directRule) ||
      (this.admitted && this.kcfg.predecessors(this.target).length === 0)
    ) {
      return Object.freeze([this.asRule(priority)]);
    }
    return kcfgToRules(this.kcfg, { id: this.ruleId, priority });
  }

  //////////////////////////
  // Execution time       //
  //////////////////////////

  /** `APRProof.exec_time` (`reachability.py:328-330`), seconds. */
  get execTime(): number {
    return this.#execTime;
  }

  /** `APRProof.add_exec_time` (`reachability.py:332-333`). */
  addExecTime(seconds: number): void {
    this.#execTime += seconds;
  }

  /** `APRProof.set_exec_time` (`reachability.py:335-336`). */
  setExecTime(seconds: number): void {
    this.#execTime = seconds;
  }

  /** `APRProof.formatted_exec_time` (`reachability.py:338-348`). */
  formattedExecTime(): string {
    const total = pythonRound(this.execTime);
    const hours = Math.floor(total / 3600);
    const remainder = total - hours * 3600;
    const minutes = Math.floor(remainder / 60);
    const seconds = remainder - minutes * 60;
    const parts: string[] = [];
    if (hours) parts.push(`${hours}h`);
    if (minutes || hours) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.join(" ");
  }

  //////////////////////////
  // Summaries            //
  //////////////////////////

  /** `APRProof.summary` (`reachability.py:535-558`). */
  override get summary(): CompositeSummary {
    return new CompositeSummary([
      new APRSummary({
        id: this.id,
        status: this.status,
        admitted: this.admitted,
        nodes: this.kcfg.nodes.length,
        pending: this.pending.length,
        failing: this.failing.length,
        vacuous: this.kcfg.vacuous.length,
        stuck: this.kcfg.stuck.length,
        terminal: this.kcfg.nodes.filter((node) => this.isTerminal(node.id)).length,
        refuted: this.nodeRefutations.size,
        bmcDepth: this.bmcDepth,
        bounded: this.#bounded.size,
        subproofs: this.subproofIds.length,
        formattedExecTime: this.formattedExecTime(),
      }),
      ...this.subproofs.map((subproof): ProofSummary => subproof.summary),
    ]);
  }

  /** `APRProof.one_line_summary` (`reachability.py:560-572`). */
  override get oneLineSummary(): string {
    const passed = this.kcfg.covers().filter((cover) => cover.target.id === this.target).length;
    return (
      `${super.oneLineSummary}: ${this.kcfg.nodes.length} nodes: ${this.pending.length} pending` +
      `|${passed} passed|${this.failing.length} failing|${this.kcfg.vacuous.length} vacuous` +
      `|${this.nodeRefutations.size} refuted|${this.kcfg.stuck.length} stuck`
    );
  }

  //////////////////////////
  // Serialization        //
  //////////////////////////

  /**
   * `APRProof.dict` (`reachability.py:515-533`) — the *embedded-KCFG* schema.
   *
   * Distinct from `proof.json`: the graph is inline, there is no
   * `execution_time` and no `loops_cache`, and `bounded`/`bmc_depth` sit before
   * `node_refutations` rather than after `logs`.
   */
  override get dict(): Readonly<Record<string, unknown>> {
    const dct: Record<string, unknown> = baseProofDict(this);
    dct["type"] = "APRProof";
    dct["kcfg"] = this.kcfg.toDict();
    dct["terminal"] = sortedTerminalIds(this);
    dct["init"] = this.init;
    dct["target"] = this.target;
    // Upstream writes `list(self._bounded)`, i.e. CPython set-iteration order.
    // For the small positive node ids a proof actually holds that order is
    // ascending, which is what this reproduces; see the README.
    dct["bounded"] = [...this.#bounded].toSorted((a, b) => a - b);
    if (this.bmcDepth !== undefined) dct["bmc_depth"] = this.bmcDepth;
    dct["node_refutations"] = encodeNodeRefutations(this.nodeRefutations);
    dct["circularity"] = this.circularity;
    dct["logs"] = encodeProofLogs(this.logs);
    return dct;
  }

  /**
   * The `proof.json` document (`APRProof.write_proof_data`, `reachability.py:618-649`).
   *
   * Writing it, and the sibling `kcfg/` directory, is
   * `@kframework-ts/proof/store`'s job; the key order lives here with the rest
   * of the schema.
   */
  get proofDataDict(): Readonly<Record<string, unknown>> {
    const dct: Record<string, unknown> = {};
    dct["id"] = this.id;
    dct["subproof_ids"] = [...this.subproofIds];
    dct["admitted"] = this.admitted;
    dct["execution_time"] = this.execTime;
    dct["type"] = "APRProof";
    dct["init"] = this.kcfg.resolve(this.init);
    dct["target"] = this.kcfg.resolve(this.target);
    dct["terminal"] = sortedTerminalIds(this);
    dct["node_refutations"] = encodeNodeRefutations(this.nodeRefutations);
    dct["circularity"] = this.circularity;
    dct["logs"] = encodeProofLogs(this.logs);
    dct["bounded"] = [...this.#bounded].toSorted((a, b) => a - b);
    if (this.bmcDepth !== undefined) dct["bmc_depth"] = this.bmcDepth;
    dct["loops_cache"] = Object.fromEntries([...this.priorLoopsCache].map(([id, loops]) => [String(id), [...loops]]));
    return dct;
  }

  /**
   * `APRProof.from_dict` (`reachability.py:379-416`) — the embedded-KCFG schema.
   *
   * **Divergence, deliberate.** Upstream guards the refutation restore with
   * `if 'node_refutation' in dct` — singular — while the body reads
   * `dct['node_refutations']`, so `from_dict` never restores refutations.
   * `read_proof_data` does it correctly, so only this schema is affected. The
   * intent is unambiguous and is implemented; a test pins both the behavior
   * here and the fact that pyk yields an empty map for the same input.
   */
  static fromDict(value: unknown, options: ProofOptions = {}): APRProof {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ProofError("Expected an object for an APRProof dictionary");
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const dct = value as Readonly<Record<string, unknown>>;
    const id = dct["id"];
    if (typeof id !== "string") throw new ProofError("APRProof dictionary is missing a string id");
    const kcfg = KCFG.fromDict(dct["kcfg"]);
    const subproofIds = readStringArray(dct["subproof_ids"] ?? [], `${id}.subproof_ids`);
    const nodeRefutations = new Map<number, string>();
    for (const [key, proofId] of Object.entries(readObject(dct["node_refutations"] ?? {}, `${id}.node_refutations`))) {
      if (typeof proofId !== "string") throw new ProofError(`${id}.node_refutations[${key}] must be a proof id`);
      nodeRefutations.set(kcfg.resolve(Number(key)), proofId);
    }
    return new APRProof(
      id,
      kcfg,
      readNumberArray(dct["terminal"], `${id}.terminal`),
      readNodeId(dct["init"], `${id}.init`),
      readNodeId(dct["target"], `${id}.target`),
      "logs" in dct ? decodeProofLogs(dct["logs"], `${id}.logs`) : new Map(),
      {
        ...options,
        subproofIds,
        bounded: readNumberArray(dct["bounded"], `${id}.bounded`),
        ...("bmc_depth" in dct ? { bmcDepth: readNodeId(dct["bmc_depth"], `${id}.bmc_depth`) } : {}),
        circularity: dct["circularity"] === true,
        admitted: dct["admitted"] === true,
        nodeRefutations,
      },
    );
  }

  /**
   * `APRProof.from_claim` (`reachability.py:418-443`).
   *
   * The claim's `[trusted]`, `[circularity]`, and `[depends(...)]` attributes
   * become `admitted`, `circularity`, and the subproof ids respectively — so a
   * claim with dependencies needs those subproofs supplied, exactly as any
   * other constructor call does.
   */
  static fromClaim(
    defn: KDefinition,
    claim: KClaim,
    logs: NodeIdMap<readonly LogEntry[]> = new Map(),
    options: APRProofOptions = {},
  ): APRProof {
    const [kcfg, initNode, targetNode] = kcfgFromClaim(defn, claim);
    return new APRProof(sentenceLabel(claim), kcfg, [], initNode, targetNode, logs, {
      ...options,
      circularity: claimIsCircularity(claim),
      admitted: claimIsTrusted(claim),
      subproofIds: options.subproofIds ?? claimDependencies(claim),
    });
  }
}

/** `sorted(node.id for node in kcfg.nodes if is_terminal(node.id))`. */
function sortedTerminalIds(proof: APRProof): readonly number[] {
  return proof.kcfg.nodes
    .filter((node) => proof.isTerminal(node.id))
    .map((node) => node.id)
    .toSorted((a, b) => a - b);
}

/** `{node_id: proof.id}`, string-keyed as JSON requires. */
function encodeNodeRefutations(refutations: ReadonlyMap<number, RefutationProof>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [nodeId, proof] of refutations) out[String(nodeId)] = proof.id;
  return out;
}

/**
 * Python's `round`, which is round-half-to-even, not JavaScript's
 * round-half-up. `round(0.5)` is `0` and `round(1.5)` is `2` upstream, and
 * `formatted_exec_time` is the only place this shows.
 */
function pythonRound(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function readObject(value: unknown, where: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProofError(`Expected an object for ${where}`);
  }
  // The three checks above are the whole structural guarantee this decoder needs.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as Readonly<Record<string, unknown>>;
}

function readStringArray(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new ProofError(`Expected an array of strings for ${where}`);
  }
  return value;
}

function readNumberArray(value: unknown, where: string): readonly number[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "number")) {
    throw new ProofError(`Expected an array of numbers for ${where}`);
  }
  return value;
}

function readNodeId(value: unknown, where: string): number {
  const id = typeof value === "string" ? Number(value) : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new ProofError(`Expected an integer for ${where}`);
  return id;
}
