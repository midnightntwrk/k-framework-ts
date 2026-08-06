/** Stable graph analysis and generator-facing KLean definition model. */

import { collectSymbols } from "@kframework-ts/kore";
import type { SymbolDecl } from "@kframework-ts/kore";
import { PRELUDE_FUNCTIONS } from "./prelude.js";
import {
  projectToRewrites,
  type KleanEquation,
  type KleanProjection,
  type KleanProjectionOptions,
} from "./projection.js";
import type { KleanSource } from "./source.js";

/**
 * A projected KORE definition plus the deterministic views generators need.
 *
 * `rewrites` and equation arrays preserve definition order.  Every map is
 * lexical by key; graph SCC lists are dependency-first, then lexical among
 * equally ready components.  This makes byte-stable Lean output possible
 * without asking each generator to rediscover dependencies.
 */
export interface KleanDefinition extends KleanProjection {
  /** Sort -> sorts it depends on for inductive/structure generation. */
  readonly sortDependencies: ReadonlyMap<string, readonly string[]>;
  /** Dependency-first SCCs of {@link sortDependencies}. */
  readonly sortSccs: readonly (readonly string[])[];
  /** Function -> functions it calls in its retained equations. */
  readonly functionDependencies: ReadonlyMap<string, readonly string[]>;
  /** Dependency-first SCCs of {@link functionDependencies}. */
  readonly functionSccs: readonly (readonly string[])[];
  /**
   * Function *and equation* nodes -> what each depends on — pyk `_func_deps`
   * (`klean/k2lean4.py:310-327`).
   *
   * `Func.lean` emits one declaration per equation plus one dispatcher per
   * function, and Lean requires every name to be defined before use, so the
   * ordering that matters is over both kinds of node at once — a function
   * depends on its own equations, and an equation depends on every function it
   * applies.  {@link functionDependencies} collapses equations away and cannot
   * express "this equation must precede that dispatcher".
   */
  readonly functionRuleDependencies: ReadonlyMap<string, readonly string[]>;
  /** Dependency-first SCCs of {@link functionRuleDependencies}; a component of more than one node is a Lean `mutual` block. */
  readonly functionRuleSccs: readonly (readonly string[])[];
  /**
   * Function and equation nodes that Lean must mark `noncomputable` — pyk
   * `K2Lean4.noncomputable` (`klean/k2lean4.py:334-349`).
   *
   * A `def` whose body mentions an `axiom` has no executable code, and Lean
   * rejects it unless it says so.  The seeds are the functions this projection
   * has no equations for and that {@link PRELUDE_FUNCTIONS} does not already
   * define; the property then propagates to every caller.  Generators must
   * re-run {@link propagateNoncomputable} with their own seeds if they
   * axiomatize anything further, because whether an equation *lowers* is not
   * knowable here.
   */
  readonly noncomputableFunctions: ReadonlySet<string>;
}

/** Project a source and add all reusable deterministic analyses. */
export function analyzeKleanDefinition(source: KleanSource, options: KleanProjectionOptions = {}): KleanDefinition {
  return analyzeProjection(projectToRewrites(source, options));
}

/** Add graph analyses to an already projected KORE slice. */
export function analyzeProjection(projection: KleanProjection): KleanDefinition {
  const sortDependencies = sortDependencyGraph(projection);
  const functionDependencies = functionDependencyGraph(projection);
  const functionRuleDependencies = functionRuleDependencyGraph(projection);
  const sortSccs = stableTopologicalSccs(sortDependencies, compareText);
  const functionSccs = stableTopologicalSccs(functionDependencies, compareText);
  const functionRuleSccs = stableTopologicalSccs(functionRuleDependencies, compareText);

  // No diagnostic is raised here on purpose. Whether a function ends up as a
  // Lean `axiom` also depends on whether its equations *lower*, which only
  // `generateFunctions` knows; a warning issued from here was wrong in both
  // directions (it flagged Prelude-defined hooks, and it flagged functions
  // that the matcher lowering does emit as definitions).
  return {
    ...projection,
    sortDependencies,
    sortSccs,
    functionDependencies,
    functionSccs,
    functionRuleDependencies,
    functionRuleSccs,
    noncomputableFunctions: propagateNoncomputable(
      functionRuleDependencies,
      functionRuleSccs,
      structurallyAxiomaticFunctions(projection),
    ),
    diagnostics: projection.diagnostics,
  };
}

/**
 * Sort dependencies used by KLean's inductive/structure emitter.
 *
 * A sort depends on each selected (transitive) subsort for injection
 * constructors, constructor parameter sort, and collection element sort.
 */
export function sortDependencyGraph(projection: KleanProjection): ReadonlyMap<string, readonly string[]> {
  const graph = new Map<string, readonly string[]>();
  for (const sort of projection.sorts.keys()) {
    const dependencies = new Set<string>(projection.subsorts.get(sort) ?? []);
    for (const constructor of projection.constructors.get(sort) ?? []) {
      const declaration = projection.symbols.get(constructor);
      if (declaration !== undefined) addParameterSorts(dependencies, declaration, projection);
    }
    const collection = projection.collections.get(sort);
    if (collection !== undefined) {
      const element = projection.symbols.get(collection.element);
      if (element !== undefined) addParameterSorts(dependencies, element, projection);
    }
    dependencies.delete(sort);
    graph.set(sort, [...dependencies].filter((dependency) => projection.sorts.has(dependency)).toSorted(compareText));
  }
  return graph;
}

/** Function-call dependency graph of retained equations. */
export function functionDependencyGraph(projection: KleanProjection): ReadonlyMap<string, readonly string[]> {
  const graph = new Map<string, readonly string[]>();
  for (const [functionName, equations] of projection.equations) {
    const dependencies = new Set<string>();
    for (const { rule } of equations) {
      const patterns = [rule.requires, ...rule.lhs.args, rule.rhs];
      for (const pattern of patterns) {
        if (pattern === undefined) continue;
        for (const symbol of collectSymbols(pattern)) if (projection.equations.has(symbol)) dependencies.add(symbol);
      }
    }
    graph.set(functionName, [...dependencies].toSorted(compareText));
  }
  return graph;
}

/**
 * The stable node name of one function equation — the key both
 * {@link functionRuleDependencyGraph} and `Func.lean` use for it.
 *
 * pyk keys by `rule.uid` alone (`klean/k2lean4.py:308`) because its
 * `FunctionRule` always has one.  Ours is `undefined` for an axiom `kompile`
 * emitted without `UNIQUE'Unds'ID`, so the fallback names the equation by its
 * symbol and position; both spellings are collision-free against a UID.
 */
export function functionRuleNode(symbol: string, equation: KleanEquation, index: number): string {
  return equation.rule.uid ?? `${symbol}#equation${index}`;
}

/**
 * The joint function/equation dependency graph — pyk `_func_deps`
 * (`klean/k2lean4.py:310-327`).
 *
 * Two edge kinds, both pyk's: a function depends on each of its equations, and
 * an equation depends on every projected function symbol occurring in its
 * `requires`, its left-hand-side *arguments*, or its right-hand side.  The head
 * symbol of the left-hand side is deliberately excluded, so a non-recursive
 * function does not become its own dependency.
 *
 * Deviation: pyk transitively closes the relation with `POSet` before running
 * its approximate SCC pass; {@link stableTopologicalSccs} computes exact SCCs
 * from the direct edges, which needs no closure and is the same partition.
 */
export function functionRuleDependencyGraph(projection: KleanProjection): ReadonlyMap<string, readonly string[]> {
  const graph = new Map<string, readonly string[]>();
  for (const [functionName, equations] of projection.equations) {
    const nodes: string[] = [];
    for (const [index, equation] of equations.entries()) {
      const node = functionRuleNode(functionName, equation, index);
      nodes.push(node);
      const dependencies = new Set<string>();
      // Collection functions such as `_List_` can occur on the LHS, hence the
      // arguments are scanned too (pyk `k2lean4.py:321-324`).
      for (const pattern of [equation.rule.requires, ...equation.rule.lhs.args, equation.rule.rhs]) {
        if (pattern === undefined) continue;
        for (const symbol of collectSymbols(pattern)) if (projection.equations.has(symbol)) dependencies.add(symbol);
      }
      graph.set(node, [...dependencies].toSorted(compareText));
    }
    graph.set(functionName, nodes.toSorted(compareText));
  }
  return graph;
}

/**
 * Functions this projection can only emit as an `axiom` on structural grounds
 * — pyk's `noncomputable` seed test (`klean/k2lean4.py:342-344`).
 *
 * A projected function with no retained equation has nothing to define it, so
 * `Func.lean` must assume it.  {@link PRELUDE_FUNCTIONS} are exempt: the
 * Prelude already defines them and `Func.lean` does not emit them at all.
 */
export function structurallyAxiomaticFunctions(projection: KleanProjection): ReadonlySet<string> {
  const result = new Set<string>();
  for (const [functionName, equations] of projection.equations)
    if (equations.length === 0 && !PRELUDE_FUNCTIONS.has(functionName)) result.add(functionName);
  return result;
}

/**
 * Close a `noncomputable` seed set over callers — pyk
 * `K2Lean4.noncomputable` (`klean/k2lean4.py:334-349`).
 *
 * `sccs` must be dependency-first (what {@link stableTopologicalSccs} returns),
 * which is what lets the direct edges stand in for pyk's transitive closure:
 * every dependency outside the component has already been decided, and a whole
 * component is tainted together because its members are mutually recursive.
 */
export function propagateNoncomputable(
  graph: ReadonlyMap<string, readonly string[]>,
  sccs: readonly (readonly string[])[],
  seeds: ReadonlySet<string>,
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const scc of sccs) {
    const tainted =
      scc.some((node) => seeds.has(node)) ||
      scc.some((node) => (graph.get(node) ?? []).some((dependency) => result.has(dependency)));
    if (tainted) for (const node of scc) result.add(node);
  }
  return result;
}

function addParameterSorts(target: Set<string>, declaration: SymbolDecl, projection: KleanProjection): void {
  for (const sort of declaration.paramSorts) {
    if (sort.tag === "SortApp" && projection.sorts.has(sort.name)) target.add(sort.name);
  }
}

/** A comparator for maps keyed by ordinary KORE/Lean identifiers. */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Strongly connected components, lexical internally and lexical by component.
 *
 * Targets absent from the input map are treated as leaves.  The iterative
 * Kosaraju implementation is safe for the very deep graphs generated by large
 * K definitions.
 */
export function stableSccs<T extends string | number>(
  graph: ReadonlyMap<T, Iterable<T>>,
  compare: (left: T, right: T) => number = defaultCompare,
): readonly (readonly T[])[] {
  return components(graph, compare).toSorted((left, right) => compare(left[0]!, right[0]!));
}

/**
 * SCCs in dependency-first topological order with lexical tie-breaking.
 *
 * If `A -> B` means "A depends on B", `B` appears before `A`.  This is the
 * ordering Lean's `mutual` blocks and noncomputable propagation need.
 */
export function stableTopologicalSccs<T extends string | number>(
  graph: ReadonlyMap<T, Iterable<T>>,
  compare: (left: T, right: T) => number = defaultCompare,
): readonly (readonly T[])[] {
  const groups = components(graph, compare);
  const groupOf = new Map<T, number>();
  groups.forEach((group, index) => group.forEach((node) => groupOf.set(node, index)));
  const dependencies = groups.map(() => new Set<number>());
  const dependents = groups.map(() => new Set<number>());
  for (const [node, edges] of graph) {
    const from = groupOf.get(node);
    if (from === undefined) continue;
    for (const edge of edges) {
      const to = groupOf.get(edge);
      if (to === undefined || to === from) continue;
      dependencies[from]!.add(to);
      dependents[to]!.add(from);
    }
  }

  const ready: number[] = [];
  dependencies.forEach((edges, index) => {
    if (edges.size === 0) ready.push(index);
  });
  const result: (readonly T[])[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => compare(groups[left]![0]!, groups[right]![0]!));
    const index = ready.shift();
    if (index === undefined) break;
    result.push(groups[index]!);
    for (const dependent of dependents[index]!) {
      const edges = dependencies[dependent]!;
      edges.delete(index);
      if (edges.size === 0) ready.push(dependent);
    }
  }
  return result;
}

/** Flatten {@link stableTopologicalSccs}; cycles remain lexical within a group. */
export function stableTopologicalOrder<T extends string | number>(
  graph: ReadonlyMap<T, Iterable<T>>,
  compare: (left: T, right: T) => number = defaultCompare,
): readonly T[] {
  return stableTopologicalSccs(graph, compare).flatMap((component) => component);
}

/** Short spelling for {@link stableTopologicalOrder}. */
export const topologicalOrder = stableTopologicalOrder;

function components<T extends string | number>(
  graph: ReadonlyMap<T, Iterable<T>>,
  compare: (left: T, right: T) => number,
): T[][] {
  const adjacency = new Map<T, T[]>();
  const nodes = new Set<T>();
  for (const [node, edges] of graph) {
    nodes.add(node);
    const ordered = [...edges];
    adjacency.set(node, ordered);
    for (const edge of ordered) nodes.add(edge);
  }
  for (const node of nodes) if (!adjacency.has(node)) adjacency.set(node, []);
  for (const edges of adjacency.values()) edges.sort(compare);

  const finished: T[] = [];
  const seen = new Set<T>();
  for (const root of [...nodes].toSorted(compare)) {
    if (seen.has(root)) continue;
    seen.add(root);
    const stack: { readonly node: T; next: number }[] = [{ node: root, next: 0 }];
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const edges = adjacency.get(frame.node)!;
      const next = edges[frame.next];
      if (next !== undefined) {
        frame.next += 1;
        if (!seen.has(next)) {
          seen.add(next);
          stack.push({ node: next, next: 0 });
        }
        continue;
      }
      stack.pop();
      finished.push(frame.node);
    }
  }

  const reverse = new Map<T, T[]>();
  for (const node of nodes) reverse.set(node, []);
  for (const [node, edges] of adjacency) for (const edge of edges) reverse.get(edge)!.push(node);
  for (const edges of reverse.values()) edges.sort(compare);
  const assigned = new Set<T>();
  const result: T[][] = [];
  for (let index = finished.length - 1; index >= 0; index -= 1) {
    const root = finished[index];
    if (root === undefined || assigned.has(root)) continue;
    const group: T[] = [];
    const stack = [root];
    assigned.add(root);
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      group.push(node);
      for (const previous of reverse.get(node)!) {
        if (!assigned.has(previous)) {
          assigned.add(previous);
          stack.push(previous);
        }
      }
    }
    group.sort(compare);
    result.push(group);
  }
  return result;
}

function defaultCompare<T extends string | number>(left: T, right: T): number {
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}
