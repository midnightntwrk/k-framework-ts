/**
 * Attribute a strict KAST term to the productions of a named definition module.
 *
 * KAST JSON elides sort injections and bracket nodes.  This index reconstructs
 * a unique direct subsort chain when possible; when the declaration graph has
 * two chains it refuses to guess.  The walk is deliberately iterative because
 * parsed programs may be arbitrarily deep.
 */

import { Atts } from "./att.js";
import { eqSort } from "./eq.js";
import { type KInner, type KLabel, type KSort } from "./inner.js";
import { K, K_ITEM } from "./prelude/k.js";
import {
  moduleProductions,
  productionAsSubsort,
  productionArgumentSorts,
  productionIsFunction,
  sameSymbolProduction,
  sortKey,
  type KDefinition,
  type KFlatModule,
  type KProduction,
} from "./outer.js";

/** A production identity suitable for consumers to render in their own policy. */
export type ProductionRef =
  | { readonly kind: "label"; readonly production: KProduction; readonly klabel: string }
  | { readonly kind: "subsort"; readonly production: KProduction; readonly from: KSort; readonly to: KSort }
  | { readonly kind: "bracket"; readonly production: KProduction; readonly sort: KSort };

type SubsortProductionRef = Extract<ProductionRef, { readonly kind: "subsort" }>;

/** Why a production index could not be built, or a term could not be walked. */
export type AttributionFailure =
  | { readonly kind: "no-module"; readonly name: string }
  | { readonly kind: "duplicate-label"; readonly klabel: string }
  | { readonly kind: "unclassified"; readonly production: KProduction }
  | { readonly kind: "unknown-label"; readonly klabel: string }
  | { readonly kind: "arity-mismatch"; readonly klabel: string; readonly declared: number; readonly actual: number }
  | { readonly kind: "no-subsort-path"; readonly from: KSort; readonly to: KSort }
  | {
      readonly kind: "ambiguous-subsort";
      readonly from: KSort;
      readonly to: KSort;
      readonly paths: readonly (readonly ProductionRef[])[];
    }
  | { readonly kind: "unsupported-node"; readonly node: string };

/** A production omitted from the local denominator, with the reason exposed. */
export interface ExcludedProduction {
  readonly production: KProduction;
  readonly reason: "function" | "generated-injection" | "token" | "unclassified";
}

type PathResult = readonly ProductionRef[] | AttributionFailure;
type MeasuredClassification =
  | ProductionRef
  | ExcludedProduction
  | Extract<AttributionFailure, { readonly kind: "unclassified" }>;

/**
 * Closure-scoped label/edge index and module-local production denominator.
 *
 * The index is an extension beyond pyk: pyk keeps only a transitive subsort
 * relation, while attribution must preserve direct edges and ambiguity.
 */
export class ProductionIndex {
  readonly measured: readonly ProductionRef[];
  readonly excluded: readonly ExcludedProduction[];

  readonly #labels: ReadonlyMap<string, ProductionRef>;
  readonly #edges: ReadonlyMap<string, readonly ProductionRef[]>;
  readonly #paths = new Map<string, PathResult>();

  private constructor(
    labels: ReadonlyMap<string, ProductionRef>,
    edges: ReadonlyMap<string, readonly ProductionRef[]>,
    measured: readonly ProductionRef[],
    excluded: readonly ExcludedProduction[],
  ) {
    this.#labels = labels;
    this.#edges = edges;
    this.measured = Object.freeze([...measured]);
    this.excluded = Object.freeze([...excluded]);
  }

  /** Build an index for `moduleName`, resolving labels and edges through imports. */
  static forModule(definition: KDefinition, moduleName: string): ProductionIndex | AttributionFailure {
    const closure = closureFor(definition, moduleName);
    if ("kind" in closure) return closure;
    const local = definition.allModulesDict.get(moduleName);
    if (local === undefined) return { kind: "no-module", name: moduleName };

    const labels = new Map<string, ProductionRef>();
    const edges = new Map<string, ProductionRef[]>();
    for (const module of closure) {
      for (const production of moduleProductions(module)) {
        if (production.klabel !== undefined) {
          const klabel = production.klabel.name;
          const other = labels.get(klabel);
          if (other !== undefined) {
            if (!sameSymbolProduction(production, other.production)) return { kind: "duplicate-label", klabel };
            continue;
          }
          labels.set(klabel, labelRef(production));
        }
        const edge = productionSubsortRef(production);
        if (edge !== undefined) {
          const outgoing = edges.get(sortKey(edge.from));
          if (outgoing === undefined) edges.set(sortKey(edge.from), [edge]);
          else outgoing.push(edge);
        }
      }
    }

    const measured: ProductionRef[] = [];
    const excluded: ExcludedProduction[] = [];
    for (const production of moduleProductions(local)) {
      const classified = classifyMeasuredProduction(production);
      if ("reason" in classified) {
        excluded.push(Object.freeze({ production, reason: classified.reason }));
      } else if (classified.kind === "unclassified") {
        excluded.push(Object.freeze({ production, reason: "unclassified" }));
      } else {
        measured.push(classified);
      }
    }

    return new ProductionIndex(
      labels,
      new Map([...edges].map(([key, value]) => [key, Object.freeze([...value])])),
      measured,
      excluded,
    );
  }

  /**
   * Find a unique direct-edge path from `from` to `to`, memoized by sort value.
   * Equal sorts need no injection and therefore return an empty path.
   */
  subsortPath(from: KSort, to: KSort): PathResult {
    if (eqSort(from, to)) return EMPTY_PATH;
    const cacheKey = `${sortKey(from)}\u0000${sortKey(to)}`;
    const cached = this.#paths.get(cacheKey);
    if (cached !== undefined) return cached;

    const found: ProductionRef[][] = [];
    const stack: {
      readonly sort: KSort;
      readonly path: readonly ProductionRef[];
      readonly seen: ReadonlySet<string>;
    }[] = [{ sort: from, path: EMPTY_PATH, seen: new Set([sortKey(from)]) }];
    while (stack.length > 0 && found.length < 2) {
      const state = stack.pop();
      if (state === undefined) continue;
      const outgoing = this.#edges.get(sortKey(state.sort)) ?? EMPTY_REFS;
      for (let i = outgoing.length - 1; i >= 0; i--) {
        const edge = outgoing[i];
        if (edge === undefined || edge.kind !== "subsort") continue;
        const path = [...state.path, edge];
        if (eqSort(edge.to, to)) {
          found.push(path);
          if (found.length === 2) break;
          continue;
        }
        const nextKey = sortKey(edge.to);
        if (state.seen.has(nextKey)) continue;
        const seen = new Set([...state.seen, nextKey]);
        stack.push({ sort: edge.to, path, seen });
      }
    }

    const result: PathResult =
      found.length === 0
        ? Object.freeze({ kind: "no-subsort-path" as const, from, to })
        : found.length === 1
          ? Object.freeze(found[0] ?? [])
          : Object.freeze({
              kind: "ambiguous-subsort" as const,
              from,
              to,
              paths: Object.freeze(found.map((path) => Object.freeze([...path]))),
            });
    this.#paths.set(cacheKey, result);
    return result;
  }

  /** Attribute a term and every elided injection it requires to productions. */
  productionsUsed(term: KInner, expectedSort: KSort): ReadonlySet<ProductionRef> | AttributionFailure {
    const used = new Set<ProductionRef>();
    const pending: { readonly term: KInner; readonly expected: KSort }[] = [{ term, expected: expectedSort }];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) continue;
      const { term: node, expected } = current;
      switch (node.node) {
        case "KToken": {
          const failure = this.#recordInjection(used, node.sort, expected);
          if (failure !== undefined) return failure;
          break;
        }
        case "KApply": {
          const production = this.#labels.get(node.label.name);
          if (production === undefined) return { kind: "unknown-label", klabel: node.label.name };
          const resolved = resolveProductionSorts(production.production, node.label);
          if ("kind" in resolved) return resolved;
          const [resultSort, argumentSorts] = resolved;
          const injectionFailure = this.#recordInjection(used, resultSort, expected);
          if (injectionFailure !== undefined) return injectionFailure;
          used.add(production);
          if (node.args.length !== argumentSorts.length) {
            return {
              kind: "arity-mismatch",
              klabel: node.label.name,
              declared: argumentSorts.length,
              actual: node.args.length,
            };
          }
          for (let i = node.args.length - 1; i >= 0; i--) {
            const child = node.args[i];
            const childExpected = argumentSorts[i];
            if (child === undefined || childExpected === undefined) continue;
            pending.push({ term: child, expected: childExpected });
          }
          break;
        }
        case "KSequence": {
          const injectionFailure = this.#recordInjection(used, K, expected);
          if (injectionFailure !== undefined) return injectionFailure;
          for (let i = node.items.length - 1; i >= 0; i--) {
            const item = node.items[i];
            if (item !== undefined) pending.push({ term: item, expected: K_ITEM });
          }
          break;
        }
        case "KVariable":
        case "KAs":
        case "KRewrite":
          return { kind: "unsupported-node", node: node.node };
      }
    }
    return used;
  }

  #recordInjection(used: Set<ProductionRef>, from: KSort, to: KSort): AttributionFailure | undefined {
    const path = this.subsortPath(from, to);
    if (isAttributionFailure(path)) return path;
    for (const production of path) used.add(production);
    return undefined;
  }
}

const EMPTY_PATH: readonly ProductionRef[] = Object.freeze([]);
const EMPTY_REFS: readonly ProductionRef[] = Object.freeze([]);

function closureFor(definition: KDefinition, moduleName: string): readonly KFlatModule[] | AttributionFailure {
  const modules: KFlatModule[] = [];
  const queue = [moduleName];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || seen.has(name)) continue;
    const module = definition.allModulesDict.get(name);
    if (module === undefined) return { kind: "no-module", name };
    seen.add(name);
    modules.push(module);
    for (const imported of module.imports) queue.push(imported.name);
  }
  return Object.freeze(modules);
}

function labelRef(production: KProduction): ProductionRef {
  const klabel = production.klabel;
  if (klabel === undefined) throw new TypeError("Expected a labeled production");
  return Object.freeze({ kind: "label" as const, production, klabel: klabel.name });
}

function productionSubsortRef(production: KProduction): SubsortProductionRef | undefined {
  const pair = productionAsSubsort(production);
  if (pair === undefined) return undefined;
  const [to, from] = pair;
  return Object.freeze({ kind: "subsort" as const, production, from, to });
}

function classifyMeasuredProduction(production: KProduction): MeasuredClassification {
  if (production.att.has(Atts.BRACKET)) {
    return Object.freeze({ kind: "bracket" as const, production, sort: production.sort });
  }
  const edge = productionSubsortRef(production);
  if (edge !== undefined) {
    if (eqSort(edge.to, K_ITEM)) return { production, reason: "generated-injection" };
    return edge;
  }
  if (productionIsFunction(production)) return { production, reason: "function" };
  if (production.klabel !== undefined) return labelRef(production);
  if (production.att.has(Atts.TOKEN)) return { production, reason: "token" };
  return { kind: "unclassified", production };
}

function resolveProductionSorts(
  production: KProduction,
  label: KLabel,
): readonly [KSort, readonly KSort[]] | AttributionFailure {
  if (production.params.length !== label.params.length) {
    return {
      kind: "arity-mismatch",
      klabel: label.name,
      declared: production.params.length,
      actual: label.params.length,
    };
  }
  const substitutions = new Map<string, KSort>();
  for (let i = 0; i < production.params.length; i++) {
    const parameter = production.params[i];
    const argument = label.params[i];
    if (parameter !== undefined && argument !== undefined) substitutions.set(sortKey(parameter), argument);
  }
  const resolve = (sort: KSort): KSort => substitutions.get(sortKey(sort)) ?? sort;
  return [resolve(production.sort), Object.freeze(productionArgumentSorts(production).map((sort) => resolve(sort)))];
}

function isAttributionFailure(value: PathResult): value is AttributionFailure {
  return !Array.isArray(value);
}
