import { CSubst, CTerm, csubstEq } from "@kframework-ts/cterm";
import type { KInner } from "@kframework-ts/kast";
import {
  KCFGDictionaryError,
  KCFGInvariantError,
  DuplicateKCFGSuccessorError,
  UnknownKCFGNodeError,
} from "./errors.js";
import { KCFGNode, NodeAttr } from "./node.js";
import {
  cover,
  coverFromDict,
  edge,
  edgeFromDict,
  mergedEdge,
  mergedEdgeFromDict,
  ndbranch,
  ndbranchFromDict,
  split,
  splitFromDict,
  successorTargets,
  successorToDict,
  type Cover,
  type Edge,
  type KCFGSuccessor,
  type MergedEdge,
  type NDBranch,
  type Split,
  type SplitTarget,
} from "./successor.js";
import {
  pathsBetween,
  shortestDistanceBetween,
  shortestPathBetween,
  zeroDepthBetween,
  type KCFGPath,
} from "./traversal.js";
import type { KCFGDict, NodeId, NodeIdLike } from "./types.js";

function record(value: unknown, where: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new KCFGDictionaryError(`Expected object for ${where}`);
  // The structural decoder validates every field it consumes after this check.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as Readonly<Record<string, unknown>>;
}
function array(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new KCFGDictionaryError(`Expected array for ${where}`);
  return value;
}
function positive(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new KCFGDictionaryError(`${where} must be a positive safe integer`);
  return value;
}

/** Mutable graph container holding immutable KCFG values. */
export class KCFG {
  #next = 1;
  readonly #nodes = new Map<NodeId, KCFGNode>();
  readonly #successors = new Map<NodeId, KCFGSuccessor>();
  readonly #aliases = new Map<string, NodeId>();

  static fromDict(value: unknown): KCFG {
    try {
      const d = record(value, "KCFG dictionary");
      const graph = new KCFG();
      const nodes = d.nodes === undefined ? [] : array(d.nodes, "KCFG dictionary.nodes");
      for (const nodeValue of nodes) graph.addNode(KCFGNode.fromDict(nodeValue));
      const maxId = Math.max(0, ...graph.nodes.map((node) => node.id));
      graph.#next = positive(d.next === undefined ? maxId + 1 : d.next, "KCFG next");
      if (graph.#next <= maxId) throw new KCFGDictionaryError("KCFG next must exceed every node id");
      const entries: readonly [keyof KCFGDict, (value: unknown) => KCFGSuccessor][] = [
        ["edges", (entry) => edgeFromDict(entry, graph.#nodes)],
        ["merged_edges", (entry) => mergedEdgeFromDict(entry, graph.#nodes)],
        ["covers", (entry) => coverFromDict(entry, graph.#nodes)],
        ["splits", (entry) => splitFromDict(entry, graph.#nodes)],
        ["ndbranches", (entry) => ndbranchFromDict(entry, graph.#nodes)],
      ];
      for (const [key, decode] of entries)
        for (const entry of d[key] === undefined ? [] : array(d[key], `KCFG dictionary.${key}`))
          graph.addSuccessor(decode(entry));
      if (d.aliases !== undefined) {
        const aliases = record(d.aliases, "KCFG dictionary.aliases");
        for (const [alias, id] of Object.entries(aliases)) graph.addAlias(alias, positive(id, `Alias ${alias}`));
      }
      return graph;
    } catch (error) {
      if (error instanceof KCFGDictionaryError) throw error;
      throw new KCFGDictionaryError("Invalid KCFG dictionary", error);
    }
  }
  static fromJson(text: string): KCFG {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new KCFGDictionaryError("Invalid KCFG JSON", error);
    }
    return KCFG.fromDict(value);
  }
  toDict(): KCFGDict {
    const grouped = {
      edges: [] as unknown[],
      merged_edges: [] as unknown[],
      covers: [] as unknown[],
      splits: [] as unknown[],
      ndbranches: [] as unknown[],
    };
    for (const successor of this.#successors.values()) {
      switch (successor.kind) {
        case "edge":
          grouped.edges.push(successorToDict(successor));
          break;
        case "merged-edge":
          grouped.merged_edges.push(successorToDict(successor));
          break;
        case "cover":
          grouped.covers.push(successorToDict(successor));
          break;
        case "split":
          grouped.splits.push(successorToDict(successor));
          break;
        case "ndbranch":
          grouped.ndbranches.push(successorToDict(successor));
          break;
      }
    }
    const aliases: Record<string, number> = {};
    for (const [name, id] of [...this.#aliases].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      aliases[name] = id;
    const result: Record<string, unknown> = { next: this.#next };
    if (this.#nodes.size > 0) result.nodes = this.nodes.map((node) => node.toDict());
    for (const [key, values] of Object.entries(grouped)) if (values.length > 0) result[key] = values;
    if (Object.keys(aliases).length > 0) result.aliases = aliases;
    return Object.freeze(result);
  }
  toJson(): string {
    return JSON.stringify(this.toDict());
  }
  get next(): number {
    return this.#next;
  }
  get nodes(): readonly KCFGNode[] {
    return Object.freeze([...this.#nodes.values()].toSorted((a, b) => a.id - b.id));
  }
  get roots(): readonly KCFGNode[] {
    return Object.freeze(this.nodes.filter((node) => this.isRoot(node.id)));
  }
  /** pyk-compatible spelling of {@link roots}. */ get root(): readonly KCFGNode[] {
    return this.roots;
  }
  get leaves(): readonly KCFGNode[] {
    return Object.freeze(this.nodes.filter((node) => this.isLeaf(node.id)));
  }
  get vacuous(): readonly KCFGNode[] {
    return Object.freeze(this.nodes.filter((node) => this.isVacuous(node.id)));
  }
  get stuck(): readonly KCFGNode[] {
    return Object.freeze(this.nodes.filter((node) => this.isStuck(node.id)));
  }
  get covered(): readonly KCFGNode[] {
    return Object.freeze(this.nodes.filter((node) => this.isCovered(node.id)));
  }
  get uncovered(): readonly KCFGNode[] {
    return Object.freeze(this.nodes.filter((node) => !this.isCovered(node.id)));
  }

  resolve(idLike: NodeIdLike): NodeId {
    if (typeof idLike === "number") {
      if (this.#nodes.has(idLike)) return idLike;
    } else if (typeof idLike === "string" && idLike.startsWith("@")) {
      const id = this.#aliases.get(idLike.slice(1));
      if (id !== undefined) return id;
      throw new UnknownKCFGNodeError(`Unknown alias: ${idLike}`);
    } else throw new UnknownKCFGNodeError(`Unknown node: ${idLike}`);
    throw new UnknownKCFGNodeError(`Unknown node: ${idLike}`);
  }
  getNode(idLike: NodeIdLike): KCFGNode | undefined {
    try {
      return this.#nodes.get(this.resolve(idLike));
    } catch (error) {
      if (error instanceof UnknownKCFGNodeError) return undefined;
      throw error;
    }
  }
  node(idLike: NodeIdLike): KCFGNode {
    return this.#nodes.get(this.resolve(idLike))!;
  }
  addNode(node: KCFGNode): void {
    if (!(node instanceof KCFGNode)) throw new KCFGInvariantError("Can only add KCFGNode values");
    if (node.id === Number.MAX_SAFE_INTEGER)
      throw new KCFGInvariantError("Node id leaves no safe integer available for KCFG next");
    if (this.#nodes.has(node.id)) throw new KCFGInvariantError(`Node with id already exists: ${node.id}`);
    this.#nodes.set(node.id, node);
    if (node.id >= this.#next) this.#next = node.id + 1;
  }
  createNode(cterm: CTerm, attrs: Iterable<NodeAttr | string> = []): KCFGNode {
    if (this.#next === Number.MAX_SAFE_INTEGER)
      throw new KCFGInvariantError("KCFG has exhausted safe integer node ids");
    const node = new KCFGNode(this.#next++, cterm, attrs);
    this.#nodes.set(node.id, node);
    return node;
  }
  replaceNode(node: KCFGNode): void {
    if (!this.#nodes.has(node.id)) throw new UnknownKCFGNodeError(`Unknown node: ${node.id}`);
    this.#nodes.set(node.id, node);
    this.refreshReferences(node.id);
  }
  letNode(
    id: NodeIdLike,
    update: { readonly cterm?: CTerm; readonly attrs?: Iterable<NodeAttr | string> } = {},
  ): KCFGNode {
    const node = this.node(id).let(update);
    this.replaceNode(node);
    return node;
  }
  removeNode(idLike: NodeIdLike): void {
    const id = this.resolve(idLike);
    this.#successors.forEach((successor, source) => {
      if (this.successorReferences(successor).includes(id)) this.#successors.delete(source);
    });
    this.#nodes.delete(id);
    for (const [alias, node] of this.#aliases) if (node === id) this.#aliases.delete(alias);
  }
  private refreshReferences(id: number): void {
    for (const [source, successor] of this.#successors) {
      if (this.successorReferences(successor).includes(id))
        this.#successors.set(source, this.canonicalSuccessor(successor));
    }
  }
  private successorReferences(successor: KCFGSuccessor): readonly number[] {
    const references = [successor.source.id, ...successorTargets(successor).map((target) => target.id)];
    if (successor.kind === "merged-edge") {
      for (const member of successor.edges) references.push(member.source.id, member.target.id);
    }
    return references;
  }

  successor(id: NodeIdLike): KCFGSuccessor | undefined {
    return this.#successors.get(this.resolve(id));
  }
  successors(id: NodeIdLike): readonly KCFGSuccessor[] {
    const successor = this.successor(id);
    return Object.freeze(successor === undefined ? [] : [successor]);
  }
  predecessors(idLike: NodeIdLike): readonly KCFGSuccessor[] {
    const id = this.resolve(idLike);
    return Object.freeze(
      [...this.#successors.values()].filter((successor) =>
        successorTargets(successor).some((target) => target.id === id),
      ),
    );
  }
  private insertSuccessor(successor: KCFGSuccessor): void {
    if (this.successorReferences(successor).some((id) => !this.#nodes.has(id)))
      throw new KCFGInvariantError("Successor references an unknown node");
    const canonical = this.canonicalSuccessor(successor);
    if (
      canonical.kind === "split" &&
      canonical.targets.some((branch) => {
        const derived = canonical.source.cterm.matchWithConstraint(branch.node.cterm);
        return derived === null || !csubstEq(branch.csubst, derived);
      })
    )
      throw new KCFGInvariantError(`Split target or substitution does not correspond to source ${canonical.source.id}`);
    if (this.#successors.has(canonical.source.id))
      throw new DuplicateKCFGSuccessorError(`Node already has a successor: ${canonical.source.id}`);
    if (
      canonical.weight === 0 &&
      successorTargets(canonical).some((target) => this.zeroDepthDirected(target.id, canonical.source.id))
    )
      throw new KCFGInvariantError(`Adding successor would create a zero-depth cycle: ${canonical.source.id}`);
    this.#successors.set(canonical.source.id, canonical);
  }
  private canonicalSuccessor(successor: KCFGSuccessor): KCFGSuccessor {
    const source = this.node(successor.source.id);
    switch (successor.kind) {
      case "edge":
        return edge(source, this.node(successor.target.id), successor.depth, successor.rules);
      case "merged-edge":
        return mergedEdge(
          source,
          this.node(successor.target.id),
          successor.edges.map((member) =>
            edge(this.node(member.source.id), this.node(member.target.id), member.depth, member.rules),
          ),
        );
      case "cover":
        return cover(source, this.node(successor.target.id), successor.csubst);
      case "split":
        return split(
          source,
          successor.targets.map((branch) => ({ node: this.node(branch.node.id), csubst: branch.csubst })),
        );
      case "ndbranch":
        return ndbranch(
          source,
          successor.targets.map((target) => this.node(target.id)),
          successor.rules,
        );
    }
    throw new KCFGInvariantError("Unknown KCFG successor kind");
  }
  private zeroDepthDirected(from: number, to: number): boolean {
    if (from === to) return true;
    const seen = new Set([from]);
    const pending = [from];
    while (pending.length) {
      const id = pending.pop()!;
      const successor = this.#successors.get(id);
      if (successor === undefined || successor.weight !== 0) continue;
      for (const target of successorTargets(successor)) {
        if (target.id === to) return true;
        if (!seen.has(target.id)) {
          seen.add(target.id);
          pending.push(target.id);
        }
      }
    }
    return false;
  }
  addSuccessor(successor: KCFGSuccessor): void {
    this.insertSuccessor(successor);
  }
  createEdge(source: NodeIdLike, target: NodeIdLike, depth: number, rules: Iterable<string> = []): Edge {
    const value = edge(this.node(source), this.node(target), depth, rules);
    this.addSuccessor(value);
    return value;
  }
  createMergedEdge(source: NodeIdLike, target: NodeIdLike, members: Iterable<Edge | MergedEdge>): MergedEdge {
    const flattened: Edge[] = [];
    for (const member of members) flattened.push(...(member.kind === "merged-edge" ? member.edges : [member]));
    const value = mergedEdge(this.node(source), this.node(target), flattened);
    this.addSuccessor(value);
    return value;
  }
  createCover(source: NodeIdLike, target: NodeIdLike, csubst?: CSubst): Cover {
    const sourceNode = this.node(source);
    const targetNode = this.node(target);
    if (csubst !== undefined) {
      const value = cover(sourceNode, targetNode, csubst);
      this.addSuccessor(value);
      return value;
    }
    const derived = targetNode.cterm.matchWithConstraint(sourceNode.cterm);
    if (derived === null) throw new KCFGInvariantError(`No matching between ${sourceNode.id} and ${targetNode.id}`);
    const value = cover(sourceNode, targetNode, derived);
    this.addSuccessor(value);
    return value;
  }
  createSplit(source: NodeIdLike, targets: Iterable<readonly [NodeIdLike, CSubst] | SplitTarget>): Split {
    const sourceNode = this.node(source);
    const branches: SplitTarget[] = [];
    for (const item of targets) {
      const branch =
        "node" in item
          ? { node: this.node(item.node.id), csubst: item.csubst }
          : { node: this.node(item[0]), csubst: item[1] };
      if (sourceNode.cterm.matchWithConstraint(branch.node.cterm) === null)
        throw new KCFGInvariantError(`Split target ${branch.node.id} does not match source ${sourceNode.id}`);
      branches.push(branch);
    }
    const value = split(sourceNode, branches);
    this.addSuccessor(value);
    return value;
  }
  createSplitByNodes(source: NodeIdLike, targets: Iterable<NodeIdLike>): Split | undefined {
    const sourceNode = this.node(source);
    const branches: SplitTarget[] = [];
    for (const target of targets) {
      const node = this.node(target);
      const csubst = sourceNode.cterm.matchWithConstraint(node.cterm);
      if (csubst === null) return undefined;
      branches.push({ node, csubst });
    }
    return this.createSplit(sourceNode.id, branches);
  }
  createNDBranch(source: NodeIdLike, targets: Iterable<NodeIdLike>, rules: Iterable<string> = []): NDBranch {
    const value = ndbranch(
      this.node(source),
      [...targets].map((target) => this.node(target)),
      rules,
    );
    this.addSuccessor(value);
    return value;
  }
  removeSuccessor(source: NodeIdLike): void {
    const id = this.resolve(source);
    if (!this.#successors.delete(id)) throw new KCFGInvariantError(`Node has no successor: ${id}`);
  }
  edge(source: NodeIdLike, target: NodeIdLike): Edge | undefined {
    const successor = this.successor(source);
    return successor?.kind === "edge" && successor.target.id === this.resolve(target) ? successor : undefined;
  }
  mergedEdge(source: NodeIdLike, target: NodeIdLike): MergedEdge | undefined {
    const successor = this.successor(source);
    return successor?.kind === "merged-edge" && successor.target.id === this.resolve(target) ? successor : undefined;
  }
  cover(source: NodeIdLike, target: NodeIdLike): Cover | undefined {
    const successor = this.successor(source);
    return successor?.kind === "cover" && successor.target.id === this.resolve(target) ? successor : undefined;
  }
  removeEdge(source: NodeIdLike, target: NodeIdLike): void {
    const successor = this.successor(source);
    if (successor?.kind !== "edge" || successor.target.id !== this.resolve(target))
      throw new KCFGInvariantError(`Edge does not exist`);
    this.removeSuccessor(source);
  }
  removeCover(source: NodeIdLike, target: NodeIdLike): void {
    const successor = this.successor(source);
    if (successor?.kind !== "cover" || successor.target.id !== this.resolve(target))
      throw new KCFGInvariantError(`Cover does not exist`);
    this.removeSuccessor(source);
  }
  edges(filter: { readonly source?: NodeIdLike; readonly target?: NodeIdLike } = {}): readonly Edge[] {
    return this.filterKind("edge", filter);
  }
  mergedEdges(filter: { readonly source?: NodeIdLike; readonly target?: NodeIdLike } = {}): readonly MergedEdge[] {
    return this.filterKind("merged-edge", filter);
  }
  covers(filter: { readonly source?: NodeIdLike; readonly target?: NodeIdLike } = {}): readonly Cover[] {
    return this.filterKind("cover", filter);
  }
  splits(filter: { readonly source?: NodeIdLike; readonly target?: NodeIdLike } = {}): readonly Split[] {
    return this.filterKind("split", filter);
  }
  ndbranches(filter: { readonly source?: NodeIdLike; readonly target?: NodeIdLike } = {}): readonly NDBranch[] {
    return this.filterKind("ndbranch", filter);
  }
  generalEdges(
    filter: { readonly source?: NodeIdLike; readonly target?: NodeIdLike } = {},
  ): readonly (Edge | MergedEdge)[] {
    return Object.freeze([...this.edges(filter), ...this.mergedEdges(filter)]);
  }
  edgeLikes(
    filter: { readonly source?: NodeIdLike; readonly target?: NodeIdLike } = {},
  ): readonly (Edge | MergedEdge | Cover)[] {
    return Object.freeze([...this.edges(filter), ...this.mergedEdges(filter), ...this.covers(filter)]);
  }
  private filterKind<T extends KCFGSuccessor["kind"]>(
    kind: T,
    filter: { readonly source?: NodeIdLike; readonly target?: NodeIdLike },
  ): readonly Extract<KCFGSuccessor, { kind: T }>[] {
    const source = filter.source === undefined ? undefined : this.resolve(filter.source);
    const target = filter.target === undefined ? undefined : this.resolve(filter.target);
    return Object.freeze(
      [...this.#successors.values()].filter(
        (successor): successor is Extract<KCFGSuccessor, { kind: T }> =>
          successor.kind === kind &&
          (source === undefined || successor.source.id === source) &&
          (target === undefined || successorTargets(successor).some((node) => node.id === target)),
      ),
    );
  }

  addAlias(alias: string, id: NodeIdLike): void {
    if (typeof alias !== "string" || alias.length === 0 || alias.includes("@"))
      throw new KCFGInvariantError("Alias must be non-empty and may not contain '@'");
    if (this.#aliases.has(alias)) throw new KCFGInvariantError(`Duplicate alias: ${alias}`);
    this.#aliases.set(alias, this.resolve(id));
  }
  removeAlias(alias: string): void {
    if (!this.#aliases.delete(alias)) throw new KCFGInvariantError(`Alias does not exist: ${alias}`);
  }
  aliases(id: NodeIdLike): readonly string[] {
    const node = this.resolve(id);
    return Object.freeze(
      [...this.#aliases]
        .filter(([, value]) => value === node)
        .map(([alias]) => alias)
        .toSorted(),
    );
  }
  isRoot(id: NodeIdLike): boolean {
    return this.predecessors(id).length === 0;
  }
  isLeaf(id: NodeIdLike): boolean {
    return this.successors(id).length === 0;
  }
  isCovered(id: NodeIdLike): boolean {
    return this.successor(id)?.kind === "cover";
  }
  isVacuous(id: NodeIdLike): boolean {
    return this.node(id).hasAttr(NodeAttr.VACUOUS);
  }
  isStuck(id: NodeIdLike): boolean {
    return this.node(id).hasAttr(NodeAttr.STUCK);
  }
  isSplit(id: NodeIdLike): boolean {
    return this.successor(id)?.kind === "split";
  }
  isNDBranch(id: NodeIdLike): boolean {
    return this.successor(id)?.kind === "ndbranch";
  }
  addAttr(id: NodeIdLike, attr: NodeAttr | string): void {
    this.replaceNode(this.node(id).addAttr(attr));
  }
  removeAttr(id: NodeIdLike, attr: NodeAttr | string): void {
    this.replaceNode(this.node(id).removeAttr(attr));
  }
  discardAttr(id: NodeIdLike, attr: NodeAttr | string): void {
    this.replaceNode(this.node(id).discardAttr(attr));
  }
  addVacuous(id: NodeIdLike): void {
    this.addAttr(id, NodeAttr.VACUOUS);
  }
  removeVacuous(id: NodeIdLike): void {
    this.removeAttr(id, NodeAttr.VACUOUS);
  }
  discardVacuous(id: NodeIdLike): void {
    this.discardAttr(id, NodeAttr.VACUOUS);
  }
  addStuck(id: NodeIdLike): void {
    this.addAttr(id, NodeAttr.STUCK);
  }
  removeStuck(id: NodeIdLike): void {
    this.removeAttr(id, NodeAttr.STUCK);
  }
  discardStuck(id: NodeIdLike): void {
    this.discardAttr(id, NodeAttr.STUCK);
  }
  splitOnConstraints(source: NodeIdLike, constraints: Iterable<KInner>): readonly number[] {
    const values = [...constraints];
    if (values.length < 2) throw new KCFGInvariantError("Split must have at least two constraints");
    const node = this.node(source);
    const targets = values.map((constraint) => this.createNode(node.cterm.addConstraint(constraint)));
    this.createSplit(
      node.id,
      targets.map((target) => {
        const csubst = node.cterm.matchWithConstraint(target.cterm);
        if (csubst === null) throw new KCFGInvariantError("Fresh split target did not match source");
        return [target.id, csubst] as const;
      }),
    );
    return Object.freeze(targets.map((target) => target.id));
  }
  reachableNodes(source: NodeIdLike, options: { readonly reverse?: boolean } = {}): ReadonlySet<KCFGNode> {
    const start = this.node(source);
    const result = new Set<KCFGNode>();
    const pending = [start];
    while (pending.length) {
      const node = pending.pop()!;
      if (result.has(node)) continue;
      result.add(node);
      if (options.reverse) pending.push(...this.predecessors(node.id).map((successor) => successor.source));
      else pending.push(...this.successors(node.id).flatMap(successorTargets));
    }
    return result;
  }
  prune(source: NodeIdLike, keepNodes: Iterable<NodeIdLike> = []): readonly number[] {
    const removable = this.reachableNodes(source);
    const keep = new Set([...keepNodes].map((id) => this.resolve(id)));
    const removed: number[] = [];
    for (const node of removable)
      if (!keep.has(node.id)) {
        this.removeNode(node.id);
        removed.push(node.id);
      }
    return Object.freeze(removed);
  }
  pathsBetween(source: NodeIdLike, target: NodeIdLike): readonly KCFGPath[] {
    return pathsBetween(this, source, target);
  }
  shortestPathBetween(source: NodeIdLike, target: NodeIdLike): KCFGPath | undefined {
    return shortestPathBetween(this, source, target);
  }
  shortestDistanceBetween(first: NodeIdLike, second: NodeIdLike): number | undefined {
    return shortestDistanceBetween(this, first, second);
  }
  zeroDepthBetween(first: NodeIdLike, second: NodeIdLike): boolean {
    return zeroDepthBetween(this, first, second);
  }
  static pathLength(path: Iterable<KCFGSuccessor | { readonly successor: KCFGSuccessor }>): number {
    let total = 0;
    for (const item of path) total += "successor" in item ? item.successor.weight : item.weight;
    return total;
  }
}
