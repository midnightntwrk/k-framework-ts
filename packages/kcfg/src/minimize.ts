/** Pure, pyk-compatible KCFG minimization transformations. */

import { CTerm, CSubst, ctermsAntiUnify } from "@kframework-ts/cterm";
import type { KDefinition } from "@kframework-ts/kast";

import { KCFG } from "./kcfg.js";
import type { KCFGSemantics as KCFGExploreSemantics } from "./semantics.js";
import type { Edge, MergedEdge, Split } from "./successor.js";
import type { NodeIdLike } from "./types.js";

type GeneralEdge = Edge | MergedEdge;

/**
 * The part of the exploration policy branch merging needs — an equivalence
 * relation over states that may be represented by one merged edge.
 *
 * Projected from the single {@link KCFGExploreSemantics} declaration rather
 * than restated, so the two can never drift; a full exploration semantics is
 * accepted here unchanged, and this module stays free of any runtime import.
 */
export type KCFGSemantics = Pick<KCFGExploreSemantics, "isMergeable">;

/** Conservative default policy: branch merging is opt-in. */
export class DefaultKCFGSemantics implements KCFGSemantics {
  isMergeable(_first: CTerm, _second: CTerm): boolean {
    return false;
  }
}

/** Raised when a requested single transformation does not match its required local shape. */
export class KCFGMinimizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KCFGMinimizationError";
  }
}

interface MergeGroupPlan {
  readonly edges: readonly GeneralEdge[];
  readonly mergedSource: CTerm | undefined;
  readonly mergedTarget: CTerm;
  readonly recovery: readonly CSubst[];
}

interface MergePlan {
  readonly split: Split;
  readonly allBranches: boolean;
  readonly groups: readonly MergeGroupPlan[];
  readonly remainingTargetIds: readonly number[];
  readonly sourceSubstitutions: readonly CSubst[];
}

function subset(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...left].every((variable) => right.has(variable));
}

function splitIsSafeToLift(split: Split, predecessor: CTerm): boolean {
  return (
    subset(split.source.freeVars, predecessor.freeVars) &&
    split.targets.every((branch) => subset(branch.node.freeVars, split.source.freeVars))
  );
}

function single<T>(items: readonly T[], description: string): T {
  if (items.length !== 1) {
    throw new KCFGMinimizationError(`Expected exactly one ${description}, found ${items.length}`);
  }
  return items[0]!;
}

function requireCSubstitutions(values: readonly (CSubst | null)[], message: string): readonly CSubst[] {
  if (values.some((value) => value === null)) throw new KCFGMinimizationError(message);
  return values.filter((value): value is CSubst => value !== null);
}

/**
 * Partition a sequence with the same defensive equivalence checks as pyk's
 * `utils.partition`.  Bad semantic heuristics fail before the graph is edited.
 */
function partition<T>(items: readonly T[], equivalent: (first: T, second: T) => boolean): readonly (readonly T[])[] {
  const groups: T[][] = [];
  for (const item of items) {
    let found = false;
    for (const group of groups) {
      const matches = group.map((member) => {
        const forward = equivalent(member, item);
        const backward = equivalent(item, member);
        if (forward !== backward) {
          throw new KCFGMinimizationError("Mergeability must be commutative");
        }
        return forward;
      });
      if (found && matches.some(Boolean)) {
        throw new KCFGMinimizationError("Mergeability placed one edge in multiple equivalence classes");
      }
      if (matches.every(Boolean)) {
        found = true;
        group.push(item);
      } else if (matches.some(Boolean)) {
        throw new KCFGMinimizationError("Mergeability must be transitive");
      }
    }
    if (!found) groups.push([item]);
  }
  return Object.freeze(groups.map((group) => Object.freeze([...group])));
}

/**
 * Mutates a KCFG with pyk's edge/split lifting and optional branch merging.
 * Each public local transformation validates and computes all its new values
 * before it removes a successor or node.
 */
export class KCFGMinimizer {
  readonly kcfg: KCFG;
  readonly semantics: KCFGSemantics;
  readonly kdef: KDefinition | undefined;

  constructor(kcfg: KCFG, semantics: KCFGSemantics = new DefaultKCFGSemantics(), kdef?: KDefinition) {
    this.kcfg = kcfg;
    this.semantics = semantics;
    this.kdef = kdef;
  }

  /** Turn `A -> B -> C` into `A -> C`, concatenating depth and rule IDs. */
  liftEdge(central: NodeIdLike): void {
    const b = this.kcfg.node(central);
    const incoming = single(this.kcfg.edges({ target: b.id }), "incoming edge");
    const outgoing = single(this.kcfg.edges({ source: b.id }), "outgoing edge");
    if (this.kcfg.predecessors(b.id).length !== 1 || this.kcfg.successors(b.id).length !== 1) {
      throw new KCFGMinimizationError(`Node ${b.id} has adjacent non-edge successors`);
    }

    // Compute the sole replacement before removing B; `createEdge` itself is
    // then guaranteed to satisfy the positive-depth graph invariant.
    const depth = incoming.depth + outgoing.depth;
    const rules = [...incoming.rules, ...outgoing.rules];
    this.kcfg.removeNode(b.id);
    this.kcfg.createEdge(incoming.source.id, outgoing.target.id, depth, rules);
  }

  /** Lift every currently eligible edge chain once. */
  liftEdges(): boolean {
    let lifted = false;
    for (const node of this.kcfg.nodes) {
      const incoming = this.kcfg.edges({ target: node.id });
      const outgoing = this.kcfg.edges({ source: node.id });
      if (incoming.length === 1 && outgoing.length === 1 && this.kcfg.predecessors(node.id).length === 1) {
        this.liftEdge(node.id);
        lifted = true;
      }
    }
    return lifted;
  }

  /**
   * Turn `A -> B -split-> C_i` into `A -split-> A_i -> C_i`.
   * The split is only moved when its conditions introduce no variables outside
   * A's constrained term.
   */
  liftSplitEdge(central: NodeIdLike): void {
    const b = this.kcfg.node(central);
    const incoming = single(this.kcfg.edges({ target: b.id }), "incoming edge");
    const outgoing = single(this.kcfg.splits({ source: b.id }), "outgoing split");
    if (this.kcfg.predecessors(b.id).length !== 1 || this.kcfg.successors(b.id).length !== 1) {
      throw new KCFGMinimizationError(`Node ${b.id} has adjacent successors outside an edge/split pair`);
    }
    if (!splitIsSafeToLift(outgoing, incoming.source.cterm)) {
      throw new KCFGMinimizationError(`Split at node ${b.id} introduces fresh variables and cannot be lifted`);
    }

    const lifted = outgoing.targets.map((branch) => branch.csubst.apply(incoming.source.cterm));
    const substitutions = requireCSubstitutions(
      lifted.map((cterm) => incoming.source.cterm.matchWithConstraint(cterm)),
      `Lifted split targets do not match node ${incoming.source.id}`,
    );

    this.kcfg.removeNode(b.id);
    const targets = lifted.map((cterm) => this.kcfg.createNode(cterm));
    for (let index = 0; index < targets.length; index++) {
      this.kcfg.createEdge(targets[index]!.id, outgoing.targets[index]!.node.id, incoming.depth, incoming.rules);
    }
    this.kcfg.createSplit(
      incoming.source.id,
      targets.map((target, index) => [target.id, substitutions[index]!] as const),
    );
  }

  /** Fuse `A -split-> B -split-> C_i` into one split from A. */
  liftSplitSplit(central: NodeIdLike): void {
    const b = this.kcfg.node(central);
    const incoming = single(this.kcfg.splits({ target: b.id }), "incoming split");
    const outgoing = single(this.kcfg.splits({ source: b.id }), "outgoing split");
    if (this.kcfg.predecessors(b.id).length !== 1 || this.kcfg.successors(b.id).length !== 1) {
      throw new KCFGMinimizationError(`Node ${b.id} has adjacent successors outside a split pair`);
    }
    if (!splitIsSafeToLift(outgoing, incoming.source.cterm)) {
      throw new KCFGMinimizationError(`Split at node ${b.id} introduces fresh variables and cannot be fused`);
    }

    const targetIds = [
      ...incoming.targets.filter((branch) => branch.node.id !== b.id).map((branch) => branch.node.id),
      ...outgoing.targets.map((branch) => branch.node.id),
    ];
    if (new Set(targetIds).size !== targetIds.length) {
      throw new KCFGMinimizationError("Fused split would contain duplicate targets");
    }
    const substitutions = requireCSubstitutions(
      targetIds.map((id) => incoming.source.cterm.matchWithConstraint(this.kcfg.node(id).cterm)),
      `Fused split targets do not match node ${incoming.source.id}`,
    );

    this.kcfg.removeNode(b.id);
    this.kcfg.createSplit(
      incoming.source.id,
      targetIds.map((id, index) => [id, substitutions[index]!] as const),
    );
  }

  /** Repeatedly perform edge-to-split lifts followed by split-to-split fusions. */
  liftSplits(): boolean {
    let lifted = false;
    let progress = true;
    while (progress) {
      progress = false;
      for (const node of this.kcfg.nodes) {
        const predecessor = this.kcfg.predecessors(node.id);
        const successor = this.kcfg.successor(node.id);
        if (
          predecessor.length === 1 &&
          predecessor[0]!.kind === "edge" &&
          successor?.kind === "split" &&
          splitIsSafeToLift(successor, predecessor[0]!.source.cterm)
        ) {
          this.liftSplitEdge(node.id);
          lifted = true;
          progress = true;
          break;
        }
      }
    }

    progress = true;
    while (progress) {
      progress = false;
      for (const node of this.kcfg.nodes) {
        const predecessor = this.kcfg.predecessors(node.id);
        const successor = this.kcfg.successor(node.id);
        if (
          predecessor.length === 1 &&
          predecessor[0]!.kind === "split" &&
          successor?.kind === "split" &&
          splitIsSafeToLift(successor, predecessor[0]!.source.cterm)
        ) {
          this.liftSplitSplit(node.id);
          lifted = true;
          progress = true;
          break;
        }
      }
    }
    return lifted;
  }

  private mergePlan(split: Split): MergePlan | undefined {
    const candidates = split.targets.flatMap((branch) => {
      const successors = this.kcfg.generalEdges({ source: branch.node.id });
      if (successors.length !== 1) return [];
      const predecessors = this.kcfg.predecessors(branch.node.id);
      // Rewriting a shared branch would silently discard another path.  pyk's
      // intended local pattern has this exact, one-predecessor shape.
      if (predecessors.length !== 1 || predecessors[0]!.source.id !== split.source.id) return [];
      return [successors[0]!];
    });
    if (candidates.length < 2) return undefined;

    const partitions = partition(candidates, (first, second) =>
      this.semantics.isMergeable(first.target.cterm, second.target.cterm),
    );
    const mergeable = partitions.filter((group) => group.length > 1);
    if (mergeable.length === 0) return undefined;

    const allBranches = partitions.length === 1 && candidates.length === split.targets.length;
    const groups: MergeGroupPlan[] = mergeable.map((edges) => {
      const antiUnifyOptions = this.kdef === undefined ? { keepValues: true } : { keepValues: true, kdef: this.kdef };
      const [mergedTarget, recovery] = ctermsAntiUnify(
        edges.map((edge) => edge.target.cterm),
        antiUnifyOptions,
      );
      const mergedSource = allBranches
        ? undefined
        : ctermsAntiUnify(
            edges.map((edge) => edge.source.cterm),
            antiUnifyOptions,
          )[0];
      return { edges, mergedSource, mergedTarget, recovery };
    });

    const mergedSourceIds = new Set(mergeable.flatMap((group) => group.map((edge) => edge.source.id)));
    const remainingTargetIds = split.targets.map((branch) => branch.node.id).filter((id) => !mergedSourceIds.has(id));
    const splitTargets = [
      ...remainingTargetIds.map((id) => this.kcfg.node(id).cterm),
      ...groups.map((group) => group.mergedSource ?? split.source.cterm),
    ];
    const sourceSubstitutions = allBranches
      ? []
      : requireCSubstitutions(
          splitTargets.map((cterm) => split.source.cterm.matchWithConstraint(cterm)),
          `Merged split targets do not match node ${split.source.id}`,
        );
    return { split, allBranches, groups, remainingTargetIds, sourceSubstitutions };
  }

  private applyMerge(plan: MergePlan): void {
    // All anti-unifications and matching checks were completed by mergePlan.
    // Deleting successors first leaves every original member node available for
    // the resulting MergedEdge's provenance members.
    this.kcfg.removeSuccessor(plan.split.source.id);
    for (const group of plan.groups) for (const edge of group.edges) this.kcfg.removeSuccessor(edge.source.id);

    if (plan.allBranches) {
      const group = plan.groups[0]!;
      const mergedTarget = this.kcfg.createNode(group.mergedTarget);
      this.kcfg.createMergedEdge(plan.split.source.id, mergedTarget.id, group.edges);
      this.kcfg.createSplit(
        mergedTarget.id,
        group.edges.map((edge, index) => [edge.target.id, group.recovery[index]!] as const),
      );
      return;
    }

    const mergedSourceIds: number[] = [];
    for (const group of plan.groups) {
      const mergedSource = this.kcfg.createNode(group.mergedSource!);
      const mergedTarget = this.kcfg.createNode(group.mergedTarget);
      mergedSourceIds.push(mergedSource.id);
      this.kcfg.createMergedEdge(mergedSource.id, mergedTarget.id, group.edges);
      this.kcfg.createSplit(
        mergedTarget.id,
        group.edges.map((edge, index) => [edge.target.id, group.recovery[index]!] as const),
      );
    }
    const targetIds = [...plan.remainingTargetIds, ...mergedSourceIds];
    this.kcfg.createSplit(
      plan.split.source.id,
      targetIds.map((id, index) => [id, plan.sourceSubstitutions[index]!] as const),
    );
  }

  /** Merge every currently eligible set of split branches once. */
  mergeNodes(): boolean {
    let merged = false;
    const splitSources = this.kcfg.splits().map((split) => split.source.id);
    for (const source of splitSources) {
      const split = this.kcfg.successor(source);
      if (split?.kind !== "split") continue;
      const plan = this.mergePlan(split);
      if (plan === undefined) continue;
      this.applyMerge(plan);
      merged = true;
    }
    return merged;
  }

  /** Minimize lifting to a fixed point, then optionally merge branches to a fixed point. */
  minimize(merge = false): void {
    let progress = true;
    while (progress) {
      progress = this.liftEdges();
      progress = this.liftSplits() || progress;
    }
    if (!merge) return;
    while (this.mergeNodes()) {
      // Merging can expose another independent eligible split.
    }
  }
}
