import { CSubst } from "@kframework-ts/cterm";
import { KCFGDictionaryError, KCFGInvariantError } from "./errors.js";
import { KCFGNode } from "./node.js";
import type { CoverDict, EdgeDict, MergedEdgeDict, NDBranchDict, SplitDict } from "./types.js";

const frozen = <T>(values: Iterable<T>): readonly T[] => Object.freeze([...values]);
const idSet = (values: readonly KCFGNode[]): boolean => new Set(values.map((value) => value.id)).size === values.length;
function positiveDepth(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new KCFGInvariantError(`Edge depth must be a positive safe integer: ${value}`);
}
function rules(value: Iterable<string>): readonly string[] {
  const result = [...value];
  if (!result.every((rule) => typeof rule === "string")) throw new KCFGInvariantError("Rules must be strings");
  return frozen(result);
}
function dict(value: unknown, where: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new KCFGDictionaryError(`Expected object for ${where}`);
  // The decoder validates every consumed field after this object check.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as Readonly<Record<string, unknown>>;
}
function node(nodes: ReadonlyMap<number, KCFGNode>, id: unknown, where: string): KCFGNode {
  if (typeof id !== "number" || !nodes.has(id)) throw new KCFGDictionaryError(`Unknown ${where} node: ${String(id)}`);
  return nodes.get(id)!;
}

export interface SuccessorBase {
  readonly source: KCFGNode;
  readonly targetIds: readonly number[];
  readonly weight: number;
}
export interface Edge extends SuccessorBase {
  readonly kind: "edge";
  readonly target: KCFGNode;
  readonly targets: readonly KCFGNode[];
  readonly depth: number;
  readonly rules: readonly string[];
}
export interface MergedEdge extends SuccessorBase {
  readonly kind: "merged-edge";
  readonly target: KCFGNode;
  readonly targets: readonly KCFGNode[];
  readonly edges: readonly Edge[];
}
export interface Cover extends SuccessorBase {
  readonly kind: "cover";
  readonly target: KCFGNode;
  readonly targets: readonly KCFGNode[];
  readonly csubst: CSubst;
}
export interface SplitTarget {
  readonly node: KCFGNode;
  readonly csubst: CSubst;
}
export interface Split extends SuccessorBase {
  readonly kind: "split";
  readonly targets: readonly SplitTarget[];
  readonly splits: ReadonlyMap<number, CSubst>;
}
export interface NDBranch extends SuccessorBase {
  readonly kind: "ndbranch";
  readonly targets: readonly KCFGNode[];
  readonly rules: readonly string[];
}
export type KCFGSuccessor = Edge | MergedEdge | Cover | Split | NDBranch;

function common<K extends KCFGSuccessor["kind"]>(
  kind: K,
  source: KCFGNode,
  targets: readonly KCFGNode[],
  weight: number,
): { readonly kind: K; readonly source: KCFGNode; readonly targetIds: readonly number[]; readonly weight: number } {
  return Object.freeze({
    kind,
    source,
    targetIds: frozen(targets.map((target) => target.id).toSorted((a, b) => a - b)),
    weight,
  });
}
export function successorTargets(successor: KCFGSuccessor): readonly KCFGNode[] {
  return successor.kind === "split" ? Object.freeze(successor.targets.map((target) => target.node)) : successor.targets;
}
export function edge(source: KCFGNode, target: KCFGNode, depth: number, ruleIds: Iterable<string> = []): Edge {
  positiveDepth(depth);
  const result = {
    ...common("edge", source, [target], depth),
    target,
    targets: frozen([target]),
    depth,
    rules: rules(ruleIds),
  } as const;
  return Object.freeze(result);
}
export function mergedEdge(source: KCFGNode, target: KCFGNode, members: Iterable<Edge>): MergedEdge {
  const edges = frozen(members);
  if (edges.length === 0) throw new KCFGInvariantError("MergedEdge must contain at least one edge");
  const result = {
    ...common("merged-edge", source, [target], Math.min(...edges.map((member) => member.depth))),
    target,
    targets: frozen([target]),
    edges,
  } as const;
  return Object.freeze(result);
}
export function cover(source: KCFGNode, target: KCFGNode, csubst: CSubst): Cover {
  if (!(csubst instanceof CSubst)) throw new KCFGInvariantError("Cover csubst must be a CSubst");
  const result = { ...common("cover", source, [target], 0), target, targets: frozen([target]), csubst } as const;
  return Object.freeze(result);
}
export function split(source: KCFGNode, branches: Iterable<SplitTarget>): Split {
  const targets = frozen(branches);
  if (targets.length < 2 || !idSet(targets.map((target) => target.node)))
    throw new KCFGInvariantError("Split must have at least two distinct targets");
  if (!targets.every((target) => target.csubst instanceof CSubst))
    throw new KCFGInvariantError("Split csubst must be a CSubst");
  const targetNodes = frozen(targets.map((target) => target.node));
  // A Map cannot be made immutable with Object.freeze.  The public property
  // therefore returns a new map each time; mutating it cannot mutate this value.
  const result: Omit<Split, "splits"> & { readonly splits?: ReadonlyMap<number, CSubst> } = {
    ...common("split", source, targetNodes, 0),
    targets,
  };
  Object.defineProperty(result, "splits", {
    enumerable: true,
    get: () => new Map(targets.map((target) => [target.node.id, target.csubst])),
  });
  // `defineProperty` installs the required defensive getter, which TypeScript
  // cannot reflect into the inferred object type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return Object.freeze(result) as Split;
}
export function ndbranch(source: KCFGNode, targets: Iterable<KCFGNode>, ruleIds: Iterable<string> = []): NDBranch {
  const resolved = frozen(targets);
  if (resolved.length < 2 || !idSet(resolved))
    throw new KCFGInvariantError("NDBranch must have at least two distinct targets");
  const result = { ...common("ndbranch", source, resolved, 1), targets: resolved, rules: rules(ruleIds) } as const;
  return Object.freeze(result);
}
export function replaceSource(successor: KCFGSuccessor, source: KCFGNode): KCFGSuccessor {
  switch (successor.kind) {
    case "edge":
      return edge(source, successor.target, successor.depth, successor.rules);
    case "merged-edge":
      return mergedEdge(source, successor.target, successor.edges);
    case "cover":
      return cover(source, successor.target, successor.csubst);
    case "split":
      return split(source, successor.targets);
    case "ndbranch":
      return ndbranch(source, successor.targets, successor.rules);
  }
  throw new KCFGInvariantError("Unknown KCFG successor kind");
}
export function replaceTarget(successor: KCFGSuccessor, target: KCFGNode): KCFGSuccessor {
  if (!successorTargets(successor).some((candidate) => candidate.id === target.id))
    throw new KCFGInvariantError(`Node ${target.id} is not a target of successor ${successor.source.id}`);
  switch (successor.kind) {
    case "edge":
      return edge(successor.source, target, successor.depth, successor.rules);
    case "merged-edge":
      return mergedEdge(successor.source, target, successor.edges);
    case "cover":
      return cover(successor.source, target, successor.csubst);
    case "split":
      return split(
        successor.source,
        successor.targets.map((branch) => (branch.node.id === target.id ? { ...branch, node: target } : branch)),
      );
    case "ndbranch":
      return ndbranch(
        successor.source,
        successor.targets.map((candidate) => (candidate.id === target.id ? target : candidate)),
        successor.rules,
      );
  }
  throw new KCFGInvariantError("Unknown KCFG successor kind");
}

function edgeToDict(successor: Edge): EdgeDict {
  return Object.freeze({
    source: successor.source.id,
    target: successor.target.id,
    depth: successor.depth,
    rules: frozen(successor.rules),
  });
}

export function successorToDict(
  successor: KCFGSuccessor,
): EdgeDict | MergedEdgeDict | CoverDict | SplitDict | NDBranchDict {
  switch (successor.kind) {
    case "edge":
      return edgeToDict(successor);
    case "merged-edge":
      return Object.freeze({
        source: successor.source.id,
        target: successor.target.id,
        edges: frozen(successor.edges.map((member) => edgeToDict(member))),
      });
    case "cover":
      return Object.freeze({
        source: successor.source.id,
        target: successor.target.id,
        csubst: successor.csubst.toDict(),
      });
    case "split":
      return Object.freeze({
        source: successor.source.id,
        targets: frozen(
          successor.targets.map((target) => Object.freeze({ target: target.node.id, csubst: target.csubst.toDict() })),
        ),
      });
    case "ndbranch":
      return Object.freeze({
        source: successor.source.id,
        targets: frozen(successor.targets.map((target) => target.id)),
        rules: frozen(successor.rules),
      });
  }
  throw new KCFGInvariantError("Unknown KCFG successor kind");
}
export function edgeFromDict(value: unknown, nodes: ReadonlyMap<number, KCFGNode>): Edge {
  const d = dict(value, "edge");
  if (typeof d.depth !== "number" || !Array.isArray(d.rules) || !d.rules.every((x) => typeof x === "string"))
    throw new KCFGDictionaryError("Invalid edge dictionary");
  return edge(node(nodes, d.source, "edge source"), node(nodes, d.target, "edge target"), d.depth, d.rules);
}
export function mergedEdgeFromDict(value: unknown, nodes: ReadonlyMap<number, KCFGNode>): MergedEdge {
  const d = dict(value, "merged edge");
  if (!Array.isArray(d.edges)) throw new KCFGDictionaryError("Merged edge dictionary edges must be an array");
  return mergedEdge(
    node(nodes, d.source, "merged edge source"),
    node(nodes, d.target, "merged edge target"),
    d.edges.map((member) => edgeFromDict(member, nodes)),
  );
}
export function coverFromDict(value: unknown, nodes: ReadonlyMap<number, KCFGNode>): Cover {
  const d = dict(value, "cover");
  if (!("csubst" in d)) throw new KCFGDictionaryError("Cover dictionary missing csubst");
  return cover(node(nodes, d.source, "cover source"), node(nodes, d.target, "cover target"), CSubst.fromDict(d.csubst));
}
export function splitFromDict(value: unknown, nodes: ReadonlyMap<number, KCFGNode>): Split {
  const d = dict(value, "split");
  if (!Array.isArray(d.targets)) throw new KCFGDictionaryError("Split dictionary targets must be an array");
  return split(
    node(nodes, d.source, "split source"),
    d.targets.map((entry) => {
      const target = dict(entry, "split target");
      if (!("csubst" in target)) throw new KCFGDictionaryError("Split target missing csubst");
      return { node: node(nodes, target.target, "split target"), csubst: CSubst.fromDict(target.csubst) };
    }),
  );
}
export function ndbranchFromDict(value: unknown, nodes: ReadonlyMap<number, KCFGNode>): NDBranch {
  const d = dict(value, "ndbranch");
  if (!Array.isArray(d.targets) || !Array.isArray(d.rules) || !d.rules.every((x) => typeof x === "string"))
    throw new KCFGDictionaryError("Invalid ndbranch dictionary");
  return ndbranch(
    node(nodes, d.source, "ndbranch source"),
    d.targets.map((id) => node(nodes, id, "ndbranch target")),
    d.rules,
  );
}
