/** Selection and dependency closure for the KORE slice KLean emits. */

import {
  ATT_LABEL,
  ATT_ASSOC,
  ATT_COMM,
  ATT_CONSTRUCTOR,
  ATT_FUNCTIONAL,
  ATT_IDEM,
  ATT_SIMPLIFICATION,
  ATT_SUBSORT,
  ATT_SYMBOL_OVERLOAD,
  ATT_UNIT,
  attString,
  classifyAxiom,
  collect,
  collectSymbols,
  collectionInfo,
  isConstructorSymbol,
  isFunctionSymbol,
  hasAtt,
  sortKey,
  type Axiom,
  type AxiomClass,
  type CollectionInfo,
  type EquationAxiom,
  type RewriteAxiom,
  type Pattern,
  type SortApp,
  type SortDecl,
  type SymbolDecl,
} from "@kframework-ts/kore";
import type { KleanSource, SourceAxiom } from "./source.js";

/** A non-fatal issue found while extracting a definition slice. */
export interface KleanDiagnostic {
  readonly severity: "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly symbol?: string;
  readonly label?: string;
  readonly uid?: string;
}

/** A forced and classified rewrite retained by the projection. */
export interface KleanRewrite {
  readonly axiom: Axiom;
  readonly rule: RewriteAxiom;
}

/** A forced and classified function equation retained by the projection. */
export interface KleanEquation {
  readonly axiom: Axiom;
  readonly rule: EquationAxiom;
}

/** How rewrite selection was performed and what it chose. */
export interface KleanSelection {
  /** Labels passed by the caller; absent means all rewrites. */
  readonly requestedLabels?: readonly string[];
  /** Chosen labels in definition order (unlabelled rules are omitted). */
  readonly labels: readonly string[];
  /** Chosen UIDs in definition order (rules without one are omitted). */
  readonly uids: readonly string[];
  readonly rewriteCount: number;
  readonly allRewrites: boolean;
}

/**
 * The pyk `project_to_rewrites()` equivalent, before graph analysis.
 *
 * Maps are inserted in lexical key order.  Rule/equation arrays remain in
 * source order because equation priority and K's rule order are semantic input
 * to the later lowering stage.
 */
export interface KleanProjection {
  readonly rewrites: readonly KleanRewrite[];
  readonly equations: ReadonlyMap<string, readonly KleanEquation[]>;
  readonly sorts: ReadonlyMap<string, SortDecl>;
  readonly symbols: ReadonlyMap<string, SymbolDecl>;
  /** Supersort name to its selected proper, transitive subsort names. */
  readonly subsorts: ReadonlyMap<string, readonly string[]>;
  readonly constructors: ReadonlyMap<string, readonly string[]>;
  readonly collections: ReadonlyMap<string, CollectionInfo>;
  readonly selection: KleanSelection;
  readonly diagnostics: readonly KleanDiagnostic[];
}

/** An exact rule label did not select any rewrite rule. */
export class UnknownRuleLabelError extends Error {
  readonly label: string;

  constructor(label: string) {
    super(`No rewrite rule has label ${JSON.stringify(label)}`);
    this.name = "UnknownRuleLabelError";
    this.label = label;
  }
}

/** An exact rule label identifies more than one rewrite rule. */
export class AmbiguousRuleLabelError extends Error {
  readonly label: string;
  readonly uids: readonly string[];

  constructor(label: string, uids: readonly string[]) {
    super(`Rewrite rule label ${JSON.stringify(label)} is ambiguous (${uids.join(", ") || "no UIDs"})`);
    this.name = "AmbiguousRuleLabelError";
    this.label = label;
    this.uids = uids;
  }
}

/** Options for {@link projectToRewrites}. */
export interface KleanProjectionOptions {
  /** Repeated exact labels; omit to retain every rewrite. */
  readonly ruleLabels?: readonly string[];
}

/**
 * Select rewrites and retain their configuration/function/collection closure.
 *
 * This follows pyk's `KoreDefn.project_to_rewrites`: configuration constructors
 * start at `SortGeneratedTopCell`, selected rewrite applications seed the
 * dynamic slice, equations of reachable functions expand it transitively, and
 * collection helpers are pulled in for every reachable collection sort.
 */
export function projectToRewrites(source: KleanSource, options: KleanProjectionOptions = {}): KleanProjection {
  const classified = new Map<SourceAxiom, { readonly axiom: Axiom; readonly kind: AxiomClass }>();
  const positions = new WeakMap<object, number>();
  const classify = (sourceAxiom: SourceAxiom): { readonly axiom: Axiom; readonly kind: AxiomClass } => {
    const cached = classified.get(sourceAxiom);
    if (cached !== undefined) return cached;
    const axiom = source.forceAxiom(sourceAxiom);
    const result = { axiom, kind: classifyAxiom(axiom) };
    classified.set(sourceAxiom, result);
    positions.set(axiom, source.index.axioms.indexOf(sourceAxiom));
    return result;
  };

  const requestedLabels = options.ruleLabels === undefined ? undefined : [...new Set(options.ruleLabels)];
  const selected: KleanRewrite[] = [];
  if (requestedLabels === undefined) {
    for (const axiom of source.index.axioms) {
      if (!mayContainRewriteOrEquation(axiom)) continue;
      const value = classify(axiom);
      if (value.kind.kind === "rewrite") selected.push({ axiom: value.axiom, rule: value.kind });
    }
  } else {
    for (const label of requestedLabels) {
      const matches: KleanRewrite[] = [];
      // Labels are an eagerly indexed axiom attribute.  We only force axiom
      // bodies whose label could actually have been requested.
      for (const sourceAxiom of source.index.axioms) {
        if (attString(sourceAxiom.attrs, ATT_LABEL) !== label) continue;
        if (!mayContainRewriteOrEquation(sourceAxiom)) continue;
        const value = classify(sourceAxiom);
        if (value.kind.kind === "rewrite") matches.push({ axiom: value.axiom, rule: value.kind });
      }
      if (matches.length === 0) throw new UnknownRuleLabelError(label);
      if (matches.length > 1) {
        throw new AmbiguousRuleLabelError(
          label,
          matches.map(({ rule }) => rule.uid ?? "<no UID>"),
        );
      }
      const [match] = matches;
      if (match !== undefined) selected.push(match);
    }
    // pyk filters an ordered tuple using a set, so callers get definition
    // order, not repeated CLI-argument order.
    selected.sort((left, right) => (positions.get(left.axiom) ?? 0) - (positions.get(right.axiom) ?? 0));
  }

  const allEquations = new Map<string, KleanEquation[]>();
  for (const sourceAxiom of source.index.axioms) {
    if (!mayContainRewriteOrEquation(sourceAxiom)) continue;
    const value = classify(sourceAxiom);
    if (value.kind.kind !== "equation" && value.kind.kind !== "owise" && value.kind.kind !== "anywhere") continue;
    const equations = allEquations.get(value.kind.symbol);
    const equation = { axiom: value.axiom, rule: value.kind };
    if (equations === undefined) allEquations.set(value.kind.symbol, [equation]);
    else equations.push(equation);
  }

  const allCollections = collectionIndex(source.index.sorts);
  const allConstructors = constructorIndex(source.index.symbols);
  const relevantSymbols = new Set<string>();
  const pending: string[] = [];
  const enqueue = (symbol: string): void => {
    if (!relevantSymbols.has(symbol)) pending.push(symbol);
  };

  // pyk's `_config_symbols`: breadth/depth does not matter because this is a
  // set; use a sorted worklist below to make diagnostics deterministic.
  const seenConfigSorts = new Set<string>();
  const configSorts = ["SortGeneratedTopCell"];
  for (let sort = configSorts.pop(); sort !== undefined; sort = configSorts.pop()) {
    if (seenConfigSorts.has(sort)) continue;
    seenConfigSorts.add(sort);
    const symbols = [...(allConstructors.get(sort) ?? [])];
    const collection = allCollections.get(sort);
    if (collection !== undefined) {
      if (collection.concat !== undefined) symbols.push(collection.concat);
      symbols.push(collection.element);
      if (collection.unit !== undefined) symbols.push(collection.unit);
    }
    for (const symbol of symbols) {
      enqueue(symbol);
      const decl = source.index.symbols.get(symbol);
      if (decl === undefined) continue;
      for (const name of declaredSortNames(decl)) configSorts.push(name);
    }
  }
  for (const rewrite of selected) for (const symbol of collectSymbols(rewrite.axiom.pattern)) enqueue(symbol);

  const diagnostics: KleanDiagnostic[] = [];
  while (pending.length > 0) {
    pending.sort(compareText);
    const symbol = pending.shift();
    if (symbol === undefined || relevantSymbols.has(symbol)) continue;
    relevantSymbols.add(symbol);
    const declaration = source.index.symbols.get(symbol);
    if (declaration === undefined) {
      diagnostics.push({
        severity: "warning",
        code: "unknown-symbol",
        message: `Pattern refers to undeclared symbol ${JSON.stringify(symbol)}`,
        symbol,
      });
      continue;
    }

    for (const equation of allEquations.get(symbol) ?? []) {
      for (const dependency of collectSymbols(equation.axiom.pattern)) enqueue(dependency);
    }
    for (const sort of declaredSortNames(declaration)) {
      const collection = allCollections.get(sort);
      if (collection === undefined) continue;
      if (collection.concat !== undefined) enqueue(collection.concat);
      enqueue(collection.element);
      if (collection.unit !== undefined) enqueue(collection.unit);
    }
  }

  const symbols = orderedMap(
    [...relevantSymbols].toSorted(compareText).flatMap((name) => {
      const declaration = source.index.symbols.get(name);
      return declaration === undefined ? [] : ([[name, declaration]] as const);
    }),
  );
  const equations = orderedMap(
    [...symbols.keys()].flatMap((symbol) => {
      const declaration = symbols.get(symbol);
      const rules = allEquations.get(symbol);
      if (declaration === undefined || (!isFunctionSymbol(declaration) && rules === undefined)) return [];
      return [[symbol, rules ?? []] as const];
    }),
  );

  const relevantSorts = new Set<string>();
  for (const declaration of symbols.values())
    for (const sort of declaredSortNames(declaration)) relevantSorts.add(sort);
  for (const rules of equations.values()) {
    for (const { rule } of rules) for (const sort of injectionSourceSorts(rule.lhs)) relevantSorts.add(sort);
  }
  const sorts = orderedMap(
    [...relevantSorts].toSorted(compareText).flatMap((name) => {
      const declaration = source.index.sorts.get(name);
      return declaration === undefined ? [] : ([[name, declaration]] as const);
    }),
  );
  const collections = orderedMap(
    [...sorts.keys()].flatMap((sort) => {
      const collection = allCollections.get(sort);
      return collection === undefined ? [] : ([[sort, collection]] as const);
    }),
  );
  const constructors = orderedMap(
    [...sorts.keys()].map(
      (sort) => [sort, [...(allConstructors.get(sort) ?? [])].filter((symbol) => symbols.has(symbol))] as const,
    ),
  );
  const subsorts = projectedSubsorts(source, new Set(sorts.keys()));

  const labels = selected.flatMap(({ rule }) => (rule.label === undefined ? [] : [rule.label]));
  const uids = selected.flatMap(({ rule }) => (rule.uid === undefined ? [] : [rule.uid]));
  const selection: KleanSelection = {
    ...(requestedLabels === undefined ? {} : { requestedLabels }),
    labels,
    uids,
    rewriteCount: selected.length,
    allRewrites: requestedLabels === undefined,
  };
  return { rewrites: selected, equations, sorts, symbols, subsorts, constructors, collections, selection, diagnostics };
}

/**
 * Whether an axiom body could affect KLean's rewrite/equation slice.
 *
 * These attributes decide their classifier result without reading a body:
 * subsort/no-confusion/totality/algebraic axioms and simplifications are never
 * a rewrite or a function equation.  On IMP this avoids forcing 527 of 726
 * lazy axiom bodies.  Everything else remains deliberately conservative — in
 * particular UID-less rules and antileft forms are still forced.
 */
function mayContainRewriteOrEquation(axiom: SourceAxiom): boolean {
  return !DEFINITELY_NON_RULE_ATTRIBUTES.some((attribute) => hasAtt(axiom.attrs, attribute));
}

const DEFINITELY_NON_RULE_ATTRIBUTES = [
  ATT_SUBSORT,
  ATT_CONSTRUCTOR,
  ATT_FUNCTIONAL,
  ATT_ASSOC,
  ATT_COMM,
  ATT_IDEM,
  ATT_UNIT,
  ATT_SYMBOL_OVERLOAD,
  ATT_SIMPLIFICATION,
] as const;

function collectionIndex(sorts: ReadonlyMap<string, SortDecl>): ReadonlyMap<string, CollectionInfo> {
  return orderedMap(
    [...sorts.entries()]
      .flatMap(([name, declaration]) => {
        const collection = collectionInfo(declaration);
        return collection === undefined ? [] : ([[name, collection]] as const);
      })
      .toSorted(([left], [right]) => compareText(left, right)),
  );
}

function constructorIndex(symbols: ReadonlyMap<string, SymbolDecl>): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>();
  for (const [name, declaration] of symbols) {
    if (!isConstructorSymbol(declaration) || declaration.sort.tag !== "SortApp") continue;
    const constructors = result.get(declaration.sort.name);
    if (constructors === undefined) result.set(declaration.sort.name, [name]);
    else constructors.push(name);
  }
  return orderedMap(
    [...result.entries()]
      .map(([sort, constructors]) => [sort, constructors.toSorted(compareText)] as const)
      .toSorted(([left], [right]) => compareText(left, right)),
  );
}

function declaredSortNames(declaration: SymbolDecl): readonly string[] {
  const result: string[] = [];
  if (declaration.sort.tag === "SortApp") result.push(declaration.sort.name);
  for (const sort of declaration.paramSorts) if (sort.tag === "SortApp") result.push(sort.name);
  return result;
}

function injectionSourceSorts(pattern: Pattern): readonly string[] {
  const result = new Set<string>();
  collect(pattern, (node) => {
    if (node.tag === "App" && node.symbol === "inj") {
      const [from] = node.sorts;
      if (from?.tag === "SortApp") result.add(from.name);
    }
  });
  return [...result].toSorted(compareText);
}

function projectedSubsorts(source: KleanSource, selected: ReadonlySet<string>): ReadonlyMap<string, readonly string[]> {
  const result: (readonly [string, readonly string[]])[] = [];
  for (const sort of [...selected].toSorted(compareText)) {
    const declaration = source.index.sorts.get(sort);
    if (declaration === undefined) continue;
    const sortApplication: SortApp = { tag: "SortApp", name: sort, sorts: declaration.vars };
    const children = source.index.sortTable.image.get(sortKey(sortApplication));
    const names = [...(children ?? [])]
      .map((key) => source.index.sortTable.sorts.get(key))
      .flatMap((value) => (value?.tag === "SortApp" && selected.has(value.name) ? [value.name] : []))
      .toSorted(compareText);
    result.push([sort, names]);
  }
  return orderedMap(result);
}

function orderedMap<T>(entries: Iterable<readonly [string, T]>): ReadonlyMap<string, T> {
  return new Map(entries);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
