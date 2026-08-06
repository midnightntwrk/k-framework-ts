/**
 * `ClaimIndex` — a label → `KClaim` map that knows the dependency relation
 * between its entries.  A transcription of `pyk/ktool/claim_index.py` (the
 * whole 188-line file) at K **v7.1.337**.
 *
 * This module is **pure**: no process, no filesystem, no `kompiled` directory.
 * Given a `KFlatModuleList` — whatever produced it — it resolves `depends`
 * attributes, validates them, and answers "which claims, in which order".
 * `src/claim-loader.ts` is the half that has to touch a disk.
 *
 * # The three things it does
 *
 * 1. **Resolve `depends`** ({@link resolveClaimDepends}, `claim_index.py:51-87`).
 *    A `depends(foo)` written inside `module M` means `M.foo` when `foo` alone
 *    is not itself a claim label.  The rewrite is stored back as a
 *    **comma-joined string** in the `depends` attribute, which is the same
 *    encoding `KClaim.dependencies` reads (`kast/outer.py:741-747`), so a
 *    resolved index round-trips through `toDict` unchanged.
 * 2. **Validate** ({@link ClaimIndex} constructor, `:41-49`).  Every key equals
 *    its claim's label, and every dependency names a claim in the index.  Both
 *    are `ValueError` upstream; here both are {@link ClaimIndexError}, with
 *    upstream's message text.
 * 3. **Select** ({@link ClaimIndex.labels}, `:124-179`).  `include`/`exclude`,
 *    optional transitive closure over dependencies, optional topological order.
 *
 * # Two resolution rules that are easy to confuse
 *
 * `_resolve_claim_label` (`:89-103`) is used twice with **different** module
 * names, and the difference is the whole reason two of the upstream test rows
 * behave the way they do:
 *
 * - during {@link resolveClaimDepends}, the qualifier is the **owning module**
 *   of the claim carrying the `depends`;
 * - during {@link ClaimIndex.resolve} — i.e. for everything a caller passes to
 *   `labels()` — the qualifier is the module list's **main module**.
 *
 * So `claim_labels=['dep-1.1']` fails against a `MULTI-CLAIM-SPEC` main module
 * (there is no `MULTI-CLAIM-SPEC.dep-1.1`) even though the claim exists as
 * `MULTI-CLAIM-SPEC-DEPENDENCY-1.dep-1.1`; and `['rep-dep']` picks
 * `MULTI-CLAIM-SPEC.rep-dep` over the identically-named claim in the
 * dependency module.  Both are pinned in `test/claim-index.test.ts`.
 *
 * # Ordering is load-bearing
 *
 * Every list this module returns is order-sensitive, and every order is
 * transcribed rather than invented:
 *
 * - **Index order** is module order, then sentence order within a module
 *   (`:37`).  `Map` preserves insertion order, as Python's `dict` does.
 * - **Closure order** is breadth-first with `pending.pop(0)` (`:163-179`).
 * - **Topological order** is Python `graphlib.TopologicalSorter.static_order()`
 *   (`:181-188`), reimplemented in {@link sortTopologically} down to its
 *   tie-breaking.  See that function for why a plain Kahn's algorithm is *not*
 *   enough.
 *
 * # Deliberate divergences
 *
 * | upstream | here | why |
 * | --- | --- | --- |
 * | `ValueError` | {@link ClaimIndexError} | TypeScript has no `ValueError`; the messages are upstream's verbatim |
 * | `graphlib.CycleError` (a `ValueError`) with the cycle path | {@link ClaimIndexError}, cycle members in {@link ClaimIndexError.cycle} | `_find_cycle`'s DFS reports *a* cycle; we report the nodes that never became ready, which is the same set of suspects without transcribing a private helper |
 * | `__getitem__` raising `KeyError` | {@link ClaimIndex.require} throws, {@link ClaimIndex.get} returns `undefined` | the `KAtt.get`/`KAtt.require` split this monorepo already uses |
 * | `FrozenDict` | a genuinely read-only view (§{@link ClaimIndex.claims}) | `ReadonlyMap` is a type-level claim only; a `Map` handed out stays mutable at runtime |
 */

import {
  Atts,
  attEntry,
  claimDependencies,
  letKClaim,
  letKFlatModuleList,
  moduleClaims,
  moduleMapSentences,
  sentenceLabel,
  type KClaim,
  type KFlatModule,
  type KFlatModuleList,
} from "@kframework-ts/kast";

//////////////////////////////
// Errors                   //
//////////////////////////////

/**
 * A claim label could not be resolved, an index is internally inconsistent, or
 * the dependency relation has a cycle — every `ValueError` `claim_index.py`
 * raises, plus `graphlib`'s `CycleError` (which is itself a `ValueError`).
 *
 * `name` is set explicitly: `instanceof` across two copies of a package is
 * unreliable, `error.name` is not.
 */
export class ClaimIndexError extends Error {
  /**
   * The labels involved in a dependency cycle, when that is what went wrong.
   *
   * Present only for the cycle case; `undefined` for every resolution and
   * validation failure.
   */
  readonly cycle: readonly string[] | undefined;

  constructor(message: string, cycle?: readonly string[]) {
    super(message);
    this.name = "ClaimIndexError";
    this.cycle = cycle === undefined ? undefined : Object.freeze([...cycle]);
  }
}

//////////////////////////////
// Label resolution         //
//////////////////////////////

/**
 * `_resolve_claim_label` (`claim_index.py:89-103`): `label` itself if it names
 * a claim, else `<moduleName>.<label>` if *that* does, else an error.
 *
 * `labels` is a `Container[str]` upstream — anything answering `in` — so both
 * a `Set` and the index's own claim map are valid arguments, and both are used.
 */
export function resolveClaimLabel(
  labels: { has(label: string): boolean },
  moduleName: string | undefined,
  label: string,
): string {
  if (labels.has(label)) return label;

  if (moduleName !== undefined) {
    const qualified = `${moduleName}.${label}`;
    if (labels.has(qualified)) return qualified;
  }

  throw new ClaimIndexError(`Claim label not found: ${label}`);
}

/**
 * `_resolve_depends` (`claim_index.py:51-87`): rewrite every claim's `depends`
 * relative to the module the claim belongs to.
 *
 * ```
 * module THIS-MODULE
 *     claim ... [depends(foo,OTHER-MODULE.bar)]
 * endmodule
 * ```
 *
 * becomes `[depends(THIS-MODULE.foo,OTHER-MODULE.bar)]`.
 *
 * The label set is computed over **all** modules in the list first, so a claim
 * may depend on one declared later, or in another module, without qualification
 * — as long as the bare name is globally unique as a label.
 *
 * A claim with no `depends` is returned untouched (`:74-75`), which is why an
 * unlabelled claim never has an attribute added to it here.
 */
export function resolveClaimDepends(moduleList: KFlatModuleList): KFlatModuleList {
  const labels = new Set<string>();
  for (const module of moduleList.modules) {
    for (const claim of moduleClaims(module)) labels.add(sentenceLabel(claim));
  }

  const resolveIn = (moduleName: string, claim: KClaim): KClaim => {
    const depends = claimDependencies(claim);
    if (depends.length === 0) return claim;

    const resolved = depends.map((label) => resolveClaimLabel(labels, moduleName, label));
    return letKClaim(claim, { att: claim.att.update([attEntry(Atts.DEPENDS, resolved.join(","))]) });
  };

  const modules: KFlatModule[] = moduleList.modules.map((module) =>
    moduleMapSentences(module, (claim) => resolveIn(module.name, claim), "KClaim"),
  );

  return letKFlatModuleList(moduleList, { modules });
}

//////////////////////////////
// ClaimIndex               //
//////////////////////////////

/** What {@link ClaimIndex.labels} accepts (`claim_index.py:124-131`). */
export interface ClaimLabelsOptions {
  /** Labels to include.  Omitted (or `undefined`) means *every* label. */
  readonly include?: Iterable<string>;
  /** Labels to exclude.  Takes precedence over {@link ClaimLabelsOptions.include}. */
  readonly exclude?: Iterable<string>;
  /**
   * Close the result transitively over the dependency relation.  Defaults to
   * `true`.
   *
   * Excluded labels are pruned *and* stop the walk: their own dependencies are
   * not pulled in along that path.
   */
  readonly withDepends?: boolean;
  /** Topologically sort the result, dependencies first.  Defaults to `false`. */
  readonly ordered?: boolean;
}

/**
 * A validated label → claim map with a dependency relation
 * (`claim_index.py:19-188`).
 *
 * Build one with {@link ClaimIndex.fromModuleList}; the constructor is the
 * lower-level door, for a caller that already holds resolved claims.
 */
export class ClaimIndex {
  /**
   * The claims, keyed by label, in module-then-sentence order.
   *
   * A genuinely read-only view, not the backing `Map`: `claims.set` does not
   * exist and the object is frozen.  pyk gets this from `FrozenDict`; a
   * `ReadonlyMap`-typed `Map` would be a promise the runtime does not keep, and
   * an index whose entries can be swapped out has stopped being validated.
   */
  readonly claims: ReadonlyMap<string, KClaim>;

  /**
   * The module list's main module, or `undefined` — the qualifier
   * {@link ClaimIndex.resolve} uses.
   */
  readonly mainModuleName: string | undefined;

  readonly #claims: ReadonlyMap<string, KClaim>;

  /**
   * `ClaimIndex.__init__` (`claim_index.py:24-31`) — validates, then freezes.
   *
   * @throws {ClaimIndexError} when a key disagrees with its claim's label, or a
   *   dependency names a claim that is not in the map.
   */
  constructor(claims: Iterable<readonly [string, KClaim]>, mainModuleName?: string) {
    // Copied before validation, so a caller mutating their own map afterwards
    // cannot invalidate an index that was checked.
    const copy = new Map(claims);
    validateClaims(copy);
    this.#claims = copy;
    this.claims = frozenMapView(copy);
    this.mainModuleName = mainModuleName;
    Object.freeze(this);
  }

  /**
   * `ClaimIndex.from_module_list` (`claim_index.py:33-39`) — resolve `depends`,
   * then index every claim of every module by its label.
   *
   * A later claim with the same label silently wins over an earlier one, as it
   * does in the upstream dict comprehension.  That is not hypothetical: two
   * claims named `rep-dep` in different modules keep distinct labels only
   * because K qualifies them.
   *
   * @throws {ClaimIndexError} from either the `depends` resolution or the
   *   validation that follows it.
   */
  static fromModuleList(moduleList: KFlatModuleList): ClaimIndex {
    const resolved = resolveClaimDepends(moduleList);
    const claims = new Map<string, KClaim>();
    for (const module of resolved.modules) {
      for (const claim of moduleClaims(module)) claims.set(sentenceLabel(claim), claim);
    }
    return new ClaimIndex(claims, resolved.mainModule);
  }

  /** `len(index)` (`claim_index.py:108-109`). */
  get size(): number {
    return this.#claims.size;
  }

  /** Whether `label` is a key **verbatim** — no resolution, unlike {@link ClaimIndex.get}. */
  hasLabel(label: string): boolean {
    return this.#claims.has(label);
  }

  /**
   * The claim `label` resolves to, or `undefined`.
   *
   * `__getitem__` (`claim_index.py:111-116`) resolves first and turns a failed
   * resolution into a `KeyError`; this is that, with the failure spelled as an
   * absent value.  {@link ClaimIndex.require} is the throwing half.
   */
  get(label: string): KClaim | undefined {
    try {
      return this.#claims.get(this.resolve(label));
    } catch {
      return undefined;
    }
  }

  /**
   * The claim `label` resolves to.
   *
   * @throws {ClaimIndexError} when `label` resolves to nothing.
   */
  require(label: string): KClaim {
    const claim = this.#claims.get(this.resolve(label));
    // Unreachable while `resolve` only returns keys, which it does by
    // construction; the throw is here so the return type is not a lie.
    if (claim === undefined) throw new ClaimIndexError(`Claim not found: ${label}`);
    return claim;
  }

  /**
   * Iterating yields `[label, claim]` pairs.
   *
   * pyk iterates *keys* (`ClaimIndex` is a `Mapping`); a JavaScript `Map`
   * iterates entries, and matching the language beats matching the port —
   * the same call `KAtt` makes.  {@link ClaimIndex.claims} `.keys()` is the
   * key iterator.
   */
  [Symbol.iterator](): IterableIterator<[string, KClaim]> {
    return this.#claims.entries();
  }

  /**
   * `ClaimIndex.resolve` (`claim_index.py:118-119`) — exact match, else
   * `<mainModule>.<label>`.
   *
   * @throws {ClaimIndexError} when neither names a claim.
   */
  resolve(label: string): string {
    return resolveClaimLabel(this.#claims, this.mainModuleName, label);
  }

  /**
   * `ClaimIndex.resolve_all` (`claim_index.py:121-122`).
   *
   * Note the order of operations, which is upstream's and is observable:
   * `unique()` deduplicates the labels **as written**, and only then are they
   * resolved.  Passing both `dep` and `MULTI-CLAIM-SPEC.dep` therefore yields
   * the resolved label *twice*.
   */
  resolveAll(labels: Iterable<string>): string[] {
    return unique(labels).map((label) => this.resolve(label));
  }

  /**
   * `ClaimIndex.labels` (`claim_index.py:124-161`) — the selection front door.
   *
   * @throws {ClaimIndexError} when an entry of `include` or `exclude` does not
   *   resolve, or when `ordered` is set and the dependency relation has a
   *   cycle.
   */
  labels(options: ClaimLabelsOptions = {}): string[] {
    // `include if include is not None else self.claims`: iterating the index
    // yields its keys in insertion order, so "everything" is index order.
    const include = options.include === undefined ? [...this.#claims.keys()] : this.resolveAll(options.include);
    const exclude = options.exclude === undefined ? [] : this.resolveAll(options.exclude);
    const withDepends = options.withDepends ?? true;

    let labels: string[];
    if (withDepends) {
      labels = this.closeDependencies(include, exclude);
    } else {
      const excluded = new Set(exclude);
      labels = include.filter((label) => !excluded.has(label));
    }

    return options.ordered === true ? this.sortTopologically(labels) : labels;
  }

  /**
   * `_close_dependencies` (`claim_index.py:163-179`) — breadth-first closure
   * with `prune` pre-seeded into the done set.
   *
   * Pre-seeding is what makes an excluded label prune a whole *subtree*: it is
   * never appended to the result, and — because the walk stops there — its own
   * dependencies are not queued **on that path**.  They can still arrive via
   * another path, which is upstream's behaviour and is pinned in the tests.
   */
  closeDependencies(labels: Iterable<string>, prune: Iterable<string> = []): string[] {
    const res: string[] = [];
    const pending = [...labels];
    const done = new Set(prune);

    // `pending.pop(0)` upstream — BFS.  `shift()` is the same operation; the
    // queues here are claim-sized, so its O(n) does not matter.
    for (let label = pending.shift(); label !== undefined; label = pending.shift()) {
      if (done.has(label)) continue;

      res.push(label);
      // Direct indexing, not `resolve`: dependencies were resolved at
      // construction and validated to be keys.
      const claim = this.#claims.get(label);
      if (claim === undefined) throw new ClaimIndexError(`Claim not found: ${label}`);
      pending.push(...claimDependencies(claim));
      done.add(label);
    }

    return res;
  }

  /**
   * `_sort_topologically` (`claim_index.py:181-188`) — dependencies first.
   *
   * The graph is built by iterating **the index**, not `labels`, and keeping
   * the entries whose key is in `labels` (`:185-187`).  That is not a detail:
   * the resulting key order is what decides ties in {@link staticOrder}, so a
   * graph built in `labels` order would produce a different — equally valid,
   * but different — permutation.
   *
   * @throws {ClaimIndexError} when the relation has a cycle.
   */
  sortTopologically(labels: readonly string[]): string[] {
    const labelSet = new Set(labels);
    const graph = new Map<string, readonly string[]>();
    for (const [label, claim] of this.#claims) {
      if (!labelSet.has(label)) continue;
      graph.set(
        label,
        claimDependencies(claim).filter((dep) => labelSet.has(dep)),
      );
    }
    return staticOrder(graph);
  }
}

//////////////////////////////
// Internals                //
//////////////////////////////

/** `ClaimIndex._validate` (`claim_index.py:41-49`). */
function validateClaims(claims: ReadonlyMap<string, KClaim>): void {
  for (const [label, claim] of claims) {
    const actual = sentenceLabel(claim);
    if (actual !== label) {
      throw new ClaimIndexError(`Claim label mismatch, expected: ${label}, found: ${actual}`);
    }

    for (const depend of claimDependencies(claim)) {
      if (!claims.has(depend)) throw new ClaimIndexError(`Invalid dependency label: ${depend}`);
    }
  }
}

/** `unique` (`pyk/utils.py:277-284`) — first occurrence wins, order kept. */
function unique(iterable: Iterable<string>): string[] {
  const seen = new Set<string>();
  const res: string[] = [];
  for (const elem of iterable) {
    if (seen.has(elem)) continue;
    seen.add(elem);
    res.push(elem);
  }
  return res;
}

/**
 * A `ReadonlyMap` that is read-only at runtime too — the `FrozenDict`
 * (`pyk/utils.py:52-86`) analogue this package needs.
 *
 * Only the read half of the `Map` protocol is forwarded, and the object is
 * frozen, so neither `set`/`delete`/`clear` nor a reassigned method exists.
 * `FrozenDict.__hash__` has no counterpart and is not needed: nothing here uses
 * an index as a key.
 */
function frozenMapView<K, V>(map: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  // Annotated rather than inferred so the iterator return types come from the
  // running TypeScript's own `ReadonlyMap`, whatever it calls them.
  const view: ReadonlyMap<K, V> = {
    get size(): number {
      return map.size;
    },
    get: (key) => map.get(key),
    has: (key) => map.has(key),
    keys: () => map.keys(),
    values: () => map.values(),
    entries: () => map.entries(),
    forEach: (callback, thisArg) => {
      map.forEach((value, key) => {
        callback.call(thisArg, value, key, map);
      });
    },
    [Symbol.iterator]: () => map.entries(),
  };
  return Object.freeze(view);
}

/**
 * `graphlib.TopologicalSorter(graph).static_order()` — CPython's
 * `Lib/graphlib.py`, reimplemented so the *order*, not just the validity, is
 * reproduced.
 *
 * `graph` maps each node to its **predecessors** (a claim to the claims it
 * depends on), which is the direction upstream builds it in
 * (`claim_index.py:183-187`) and the direction `TopologicalSorter` documents.
 *
 * # Why the tie-breaking needs transcribing
 *
 * Any Kahn's algorithm produces *a* valid order.  `static_order` produces one
 * particular order, and pinning it is the only way a golden test means
 * anything.  Three rules do it:
 *
 * 1. **Node discovery order.**  `TopologicalSorter.__init__` calls
 *    `add(node, *predecessors)` for each graph entry in dict order, and `add`
 *    creates the node info for `node` *first*, then for each predecessor in
 *    turn.  So a predecessor that appears only as a predecessor is discovered
 *    at the position of its first successor, not at the front.
 * 2. **The initial ready list** is every zero-predecessor node **in that
 *    discovery order** (`prepare`), and `get_ready` hands the whole batch back
 *    in that order.
 * 3. **Newly-ready nodes are appended** as `done()` walks each finished node's
 *    `successors` list, which was built in `add`-call order.  So the batch
 *    order of one level determines the batch order of the next.
 *
 * Duplicated predecessors are counted twice upstream (`npredecessors +=
 * len(predecessors)` and one `successors.append` each), so they cancel out —
 * transcribed as-is rather than deduplicated, since a claim *can* name the same
 * dependency twice.
 *
 * @throws {ClaimIndexError} when some node never becomes ready, i.e. there is a
 *   cycle.  Upstream raises `graphlib.CycleError` (a `ValueError`) carrying one
 *   cycle found by DFS; we carry every node still blocked, which is a superset
 *   of that cycle and needs no private helper transcribed.
 */
export function staticOrder(graph: ReadonlyMap<string, readonly string[]>): string[] {
  interface NodeInfo {
    npredecessors: number;
    readonly successors: string[];
  }

  const info = new Map<string, NodeInfo>();
  const nodeInfo = (node: string): NodeInfo => {
    let existing = info.get(node);
    if (existing === undefined) {
      existing = { npredecessors: 0, successors: [] };
      info.set(node, existing);
    }
    return existing;
  };

  // `add(node, *predecessors)` per graph entry, in graph order.
  for (const [node, predecessors] of graph) {
    const nodeinfo = nodeInfo(node);
    nodeinfo.npredecessors += predecessors.length;
    for (const pred of predecessors) nodeInfo(pred).successors.push(node);
  }

  // `prepare()`: the ready list is discovery-ordered, which is `info`'s order.
  let ready: string[] = [];
  for (const [node, nodeinfo] of info) {
    if (nodeinfo.npredecessors === 0) ready.push(node);
  }

  const order: string[] = [];
  while (ready.length > 0) {
    // `get_ready()` returns the whole batch, `done(*batch)` then releases
    // successors in batch order.
    const batch = ready;
    ready = [];
    for (const node of batch) {
      order.push(node);
      const nodeinfo = info.get(node);
      if (nodeinfo === undefined) continue;
      for (const successor of nodeinfo.successors) {
        const successorInfo = info.get(successor);
        if (successorInfo === undefined) continue;
        successorInfo.npredecessors -= 1;
        if (successorInfo.npredecessors === 0) ready.push(successor);
      }
    }
  }

  if (order.length !== info.size) {
    const emitted = new Set(order);
    const cycle = [...info.keys()].filter((node) => !emitted.has(node));
    throw new ClaimIndexError(`Cycle detected in claim dependencies: ${cycle.join(", ")}`, cycle);
  }

  return order;
}
