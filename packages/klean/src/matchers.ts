/**
 * The function-rule `Matcher` hierarchy — pyk `klean/k2lean4.py:100-217`
 * (the classes), `:689-742` (`_matcher_to_terms`) and `:776-899`
 * (`_func_rule_matchers`), at K `v7.1.337`
 * (`737f5d6295f9f69ffd4ff41ef22f22557387988314b17eacfc5f3ee4cb062dc4`).
 *
 * A K function rule's left-hand side is a *matching-logic* pattern, and Lean's
 * `match` is a *structural* one.  Three families of KORE left-hand sides have
 * no structural counterpart, and each is compiled into a guard that runs
 * before the rule body instead of into the `match` head:
 *
 * - **repeated variables** (`f(X, X)`) — Lean rejects a non-linear pattern, so
 *   the second occurrence is renamed and an {@link EqMatcher} re-imposes the
 *   equality (`k2lean4.py:117-125, 781-824`);
 * - **subsort retractions** (`f(inj{Sub,Super}(P))` where `Sub` itself has
 *   subsorts) — the KORE injection is not one Lean constructor but a whole
 *   family, so the argument is abstracted to a variable and a
 *   {@link SubsortMatcher} runs the `Inj` class's `retr`
 *   (`k2lean4.py:138-147, 827-832`);
 * - **collection hooks** (`f(ListItem(H) L)`, `f(K |-> V M)`, `f(.Map)`, …) —
 *   `SortList`/`SortSet`/`SortMap` are Lean *structures* over an opaque
 *   `coll` field, not inductive types, so the pattern is abstracted and the
 *   Prelude's `ListHook`/`SetHook`/`MapHook` `split`/`size` decides it
 *   (`k2lean4.py:149-217, 833-877`).
 *
 * Without these, every rule using one of the three shapes is undecidable for
 * the emitter, and its whole function degrades to a Lean `axiom` — an
 * unchecked assumption where a definition was intended.
 *
 * Matchers are then *ordered*: a matcher's outputs can be another's inputs
 * (`f(inj{Sub,Super}(ListItem(X) L))` retracts before it splits), so they are
 * grouped into dependency generations and emitted as nested `match` blocks
 * (`k2lean4.py:881-891`).
 *
 * Deviations from pyk, all deliberate:
 *
 * - pyk models the hierarchy as an `abc.ABC` with `@dataclass(frozen=True)`
 *   subclasses; this is a discriminated union, which is how the rest of this
 *   package spells closed variant sets and what lets `matcherTerms` be
 *   exhaustively checked at compile time rather than by
 *   `case _: raise AssertionError` (`k2lean4.py:741-742`).
 * - pyk hardcodes `SortKItem` as the element sort of every `ListHook`/
 *   `SetHook` it instantiates (`k2lean4.py:705, 713, 720, 725`).  We look the
 *   element sort up in the projected collection declaration and fall back to
 *   `SortKItem` only when it is unavailable, which agrees with pyk on every
 *   `List`/`Set` of `KItem` — the only case upstream can currently emit — and
 *   does not silently mistype the others.
 * - pyk orders matchers with `networkx.topological_generations` and lets a
 *   cyclic dependency raise; {@link orderMatchers} is a self-contained Kahn
 *   layering that reports the cycle as a diagnostic, because this package's
 *   contract is that an unsupported input becomes a typed diagnostic and an
 *   auditable axiom, never a thrown generator.
 * - pyk asserts its way through malformed input (`assert isinstance(...)`).
 *   Every such point here returns `undefined` plus a diagnostic instead.
 */

import {
  bottomUp,
  freeOccurrences,
  inferSort,
  patterns as subpatterns,
  withPatterns,
  type App,
  type CollectionInfo,
  type EVar,
  type Pattern,
  type Sort,
  type SymbolDecl,
} from "@kframework-ts/kore";

import { lowerKoreArgument, lowerKorePattern, type LoweringDefinition, type LoweringDiagnostic } from "./lower.js";
import { leanVariableIdentifier } from "./names.js";

/** The element sort pyk hardcodes for `ListHook`/`SetHook` (`k2lean4.py:705`). */
const DEFAULT_COLLECTION_ELEMENT_SORT = "SortKItem";

/** `X` occurred twice on the left-hand side — pyk `EqMatcher` (`k2lean4.py:116-125`). */
export interface EqMatcher {
  readonly tag: "eq";
  readonly first: EVar;
  readonly second: EVar;
}

/** `inj{subsort, supersort}(pattern)` — pyk `SubsortMatcher` (`k2lean4.py:138-146`). */
export interface SubsortMatcher {
  readonly tag: "subsort";
  readonly variable: EVar;
  readonly subsort: string;
  readonly supersort: string;
  readonly pattern: Pattern;
}

/** `ListItem(p…) L ListItem(s…)` — pyk `ListMatcher` (`k2lean4.py:149-161`). */
export interface ListMatcher {
  readonly tag: "list";
  readonly variable: EVar;
  readonly prefix: readonly Pattern[];
  readonly middle: Pattern;
  readonly suffix: readonly Pattern[];
}

/** `.List` — pyk `EmptyListMatcher` (`k2lean4.py:164-166`). */
export interface EmptyListMatcher {
  readonly tag: "empty-list";
  readonly variable: EVar;
}

/** `SetItem(e) Rest` — pyk `SetMatcher` (`k2lean4.py:169-182`). */
export interface SetMatcher {
  readonly tag: "set";
  readonly variable: EVar;
  readonly elements: readonly Pattern[];
  readonly rest: Pattern;
}

/** `.Set` — pyk `EmptySetMatcher` (`k2lean4.py:185-187`). */
export interface EmptySetMatcher {
  readonly tag: "empty-set";
  readonly variable: EVar;
}

/** `K |-> V Rest` — pyk `MapMatcher` (`k2lean4.py:190-209`). */
export interface MapMatcher {
  readonly tag: "map";
  readonly variable: EVar;
  readonly keySort: string;
  readonly valueSort: string;
  readonly keys: readonly Pattern[];
  readonly values: readonly Pattern[];
  readonly rest: Pattern;
}

/** `.Map` — pyk `EmptyMapMatcher` (`k2lean4.py:212-216`). */
export interface EmptyMapMatcher {
  readonly tag: "empty-map";
  readonly variable: EVar;
  readonly keySort: string;
  readonly valueSort: string;
}

/** One left-hand-side condition Lean's `match` cannot express structurally. */
export type KleanMatcher =
  | EqMatcher
  | SubsortMatcher
  | ListMatcher
  | EmptyListMatcher
  | SetMatcher
  | EmptySetMatcher
  | MapMatcher
  | EmptyMapMatcher;

/** The definition slice matcher extraction and rendering read. */
export interface MatcherDefinition extends LoweringDefinition {
  readonly subsorts: ReadonlyMap<string, readonly string[]>;
  readonly collections: ReadonlyMap<string, CollectionInfo>;
  /** Keyed by function symbol; only membership is read (pyk `defn.functions`). */
  readonly equations: ReadonlyMap<string, unknown>;
}

/**
 * The variables a matcher consumes — pyk `Matcher.inputs` (`k2lean4.py:101-103`).
 *
 * These must already be bound by the enclosing `match` (or by an earlier
 * matcher generation) before this matcher can run.
 */
export function matcherInputs(matcher: KleanMatcher): readonly EVar[] {
  switch (matcher.tag) {
    case "eq":
      return freeVariables([matcher.first, matcher.second]);
    case "set":
      // pyk `SetMatcher._input_patterns` (`k2lean4.py:175-179`): the elements
      // are searched *for*, so they are read, not bound.
      return freeVariables([matcher.variable, ...matcher.elements]);
    case "map":
      // pyk `MapMatcher._input_patterns` (`k2lean4.py:199-203`): keys are read.
      return freeVariables([matcher.variable, ...matcher.keys]);
    case "subsort":
    case "list":
    case "empty-list":
    case "empty-set":
    case "empty-map":
      // pyk `BaseMatcher._input_patterns` (`k2lean4.py:131-132`).
      return freeVariables([matcher.variable]);
  }
  return unreachableMatcher(matcher);
}

/**
 * The variables a matcher binds — pyk `Matcher.outputs` (`k2lean4.py:105-107`).
 */
export function matcherOutputs(matcher: KleanMatcher): readonly EVar[] {
  switch (matcher.tag) {
    case "eq":
    case "empty-list":
    case "empty-set":
    case "empty-map":
      return [];
    case "subsort":
      return freeVariables([matcher.pattern]);
    case "list":
      return freeVariables([...matcher.prefix, matcher.middle, ...matcher.suffix]);
    case "set":
      return freeVariables([matcher.rest]);
    case "map":
      return freeVariables([...matcher.values, matcher.rest]);
  }
  return unreachableMatcher(matcher);
}

/** The `match` scrutinee and the alternative pattern a matcher renders to. */
export interface MatcherTerms {
  readonly scrutinee: string;
  readonly pattern: string;
}

export interface MatcherTermsResult {
  readonly terms: MatcherTerms | undefined;
  readonly diagnostics: readonly LoweringDiagnostic[];
}

/**
 * Render one matcher as a `match <scrutinee> with | <pattern> => …` pair —
 * pyk `_matcher_to_terms` (`k2lean4.py:689-742`).
 */
export function matcherTerms(
  definition: MatcherDefinition,
  matcher: KleanMatcher,
  path: readonly string[] = [],
): MatcherTermsResult {
  const diagnostics: LoweringDiagnostic[] = [];
  const concrete = (pattern: Pattern): string | undefined => {
    const result = lowerKorePattern(definition, pattern, { concreteInjections: true }, path);
    diagnostics.push(...result.diagnostics);
    return result.term;
  };
  const concreteArgument = (pattern: Pattern): string | undefined => {
    const result = lowerKoreArgument(definition, pattern, { concreteInjections: true }, path);
    diagnostics.push(...result.diagnostics);
    return result.term;
  };
  const list = (elements: readonly Pattern[]): string | undefined => {
    const items = elements.map((element) => concrete(element));
    return items.some((item) => item === undefined) ? undefined : `[${items.join(", ")}]`;
  };
  const variable = leanVariableIdentifier(matcher.tag === "eq" ? matcher.first.name : matcher.variable.name);

  switch (matcher.tag) {
    case "eq": {
      const other = leanVariableIdentifier(matcher.second.name);
      return { terms: { scrutinee: `${variable} == ${other}`, pattern: "true" }, diagnostics };
    }
    case "subsort": {
      const inner = concreteArgument(matcher.pattern);
      return {
        terms:
          inner === undefined
            ? undefined
            : {
                scrutinee: `(@retr ${matcher.subsort} ${matcher.supersort}) ${variable}`,
                pattern: `some ${inner}`,
              },
        diagnostics,
      };
    }
    case "list": {
      const element = collectionElementSorts(definition, matcher.variable)[0] ?? DEFAULT_COLLECTION_ELEMENT_SORT;
      const prefix = list(matcher.prefix);
      const middle = concrete(matcher.middle);
      const suffix = list(matcher.suffix);
      const split = `(ListHook ${element}).split ${variable}.coll ${matcher.prefix.length} ${matcher.suffix.length}`;
      return {
        terms:
          prefix === undefined || middle === undefined || suffix === undefined
            ? undefined
            : {
                scrutinee: reboxCollection(
                  definition,
                  matcher.variable,
                  split,
                  "(p, m, s)",
                  (boxed) => `(p, ${boxed}, s)`,
                  "m",
                ),
                pattern: `some (${prefix}, ${middle}, ${suffix})`,
              },
        diagnostics,
      };
    }
    case "empty-list": {
      const element = collectionElementSorts(definition, matcher.variable)[0] ?? DEFAULT_COLLECTION_ELEMENT_SORT;
      return { terms: { scrutinee: `(ListHook ${element}).size ${variable}.coll`, pattern: "0" }, diagnostics };
    }
    case "set": {
      const element = collectionElementSorts(definition, matcher.variable)[0] ?? DEFAULT_COLLECTION_ELEMENT_SORT;
      const elements = list(matcher.elements);
      const rest = concreteArgument(matcher.rest);
      const split = `(SetHook ${element}).split ${variable}.coll ${elements}`;
      return {
        terms:
          elements === undefined || rest === undefined
            ? undefined
            : {
                scrutinee: reboxCollection(definition, matcher.variable, split, "r", (boxed) => boxed, "r"),
                pattern: `some ${rest}`,
              },
        diagnostics,
      };
    }
    case "empty-set": {
      const element = collectionElementSorts(definition, matcher.variable)[0] ?? DEFAULT_COLLECTION_ELEMENT_SORT;
      return { terms: { scrutinee: `(SetHook ${element}).size ${variable}.coll`, pattern: "0" }, diagnostics };
    }
    case "map": {
      const keys = list(matcher.keys);
      const values = list(matcher.values);
      const rest = concrete(matcher.rest);
      const split = `(MapHook ${matcher.keySort} ${matcher.valueSort}).split ${variable}.coll ${keys}`;
      return {
        terms:
          keys === undefined || values === undefined || rest === undefined
            ? undefined
            : {
                scrutinee: reboxCollection(
                  definition,
                  matcher.variable,
                  split,
                  "(vs, r)",
                  (boxed) => `(vs, ${boxed})`,
                  "r",
                ),
                pattern: `some (${values}, ${rest})`,
              },
        diagnostics,
      };
    }
    case "empty-map":
      return {
        terms: {
          scrutinee: `(MapHook ${matcher.keySort} ${matcher.valueSort}).size ${variable}.coll`,
          pattern: "0",
        },
        diagnostics,
      };
  }
  return unreachableMatcher(matcher);
}

export interface FunctionRuleMatchers {
  /** The rewritten left-hand-side arguments Lean's `match` head consumes. */
  readonly args: readonly Pattern[];
  /** Matcher dependency generations, producers before consumers. */
  readonly generations: readonly (readonly KleanMatcher[])[];
  readonly diagnostics: readonly LoweringDiagnostic[];
}

/**
 * Compile a function-rule left-hand side into `match` arguments plus ordered
 * matchers — pyk `_func_rule_matchers` (`k2lean4.py:776-899`).
 *
 * The three passes are pyk's, in pyk's order, and the order is load-bearing:
 * repeated variables are renamed *before* collection/injection abstraction so
 * that a repeated variable buried inside an abstracted collection is still
 * seen, and abstraction is bottom-up so that a nested shape is abstracted
 * before the shape containing it.
 *
 * `freshPrefix` exists only so callers can keep pyk's two disjoint generators
 * (`Var'Unds'Pat{i}` for abstraction, `Var'Unds'Uniq{i}` for renaming) without
 * this module owning the naming policy.
 */
export function functionRuleMatchers(definition: MatcherDefinition, lhs: App): FunctionRuleMatchers {
  const diagnostics: LoweringDiagnostic[] = [];
  const matchers: KleanMatcher[] = [];

  const renamed = renameRepeatedVariables(lhs);
  matchers.push(...equalityMatchers(renamed.classes));

  const abstracted = abstractMatchers(definition, renamed.pattern, matchers, diagnostics);
  if (abstracted.tag !== "App") {
    // pyk `assert isinstance(pattern, App)` (`k2lean4.py:896`).  Unreachable
    // for a well-formed function rule: abstraction never replaces the head.
    diagnostics.push({
      code: "unsupported-pattern",
      message: "Function-rule left-hand side stopped being an application while abstracting matchers",
      path: ["lhs"],
    });
    return { args: [], generations: [], diagnostics };
  }

  const ordered = orderMatchers(matchers);
  diagnostics.push(...ordered.diagnostics);
  return { args: abstracted.args, generations: ordered.generations, diagnostics };
}

/**
 * Rename every repeated variable occurrence apart — pyk `rename_outputs`
 * (`k2lean4.py:781-810`).
 *
 * Top-down and left to right: the first occurrence of a variable keeps its
 * name and opens an equivalence class; each later occurrence is renamed to a
 * fresh `Var'Unds'Uniq{i}` and joins that class.  Three positions are skipped
 * because they are *read* rather than *bound* by the matcher that will consume
 * them, and renaming them would silently drop the constraint:
 * `SetItem`'s element (`k2lean4.py:800-801`) and a map item's key
 * (`k2lean4.py:802-807`).
 */
export function renameRepeatedVariables(pattern: Pattern): {
  readonly pattern: Pattern;
  readonly classes: ReadonlyMap<string, readonly EVar[]>;
} {
  const used = new Set(freeOccurrences(pattern).keys());
  const classes = new Map<string, EVar[]>();
  const byVariable = new Map<string, string>();
  let nextName = 0;

  const rename = (node: Pattern): Pattern => {
    if (node.tag === "EVar") {
      const key = variableKey(node);
      const existing = byVariable.get(key);
      if (existing === undefined) {
        byVariable.set(key, key);
        classes.set(key, [node]);
        return node;
      }
      let fresh = `Var'Unds'Uniq${nextName}`;
      nextName += 1;
      while (used.has(fresh)) {
        fresh = `Var'Unds'Uniq${nextName}`;
        nextName += 1;
      }
      used.add(fresh);
      const replacement: EVar = { ...node, name: fresh };
      classes.get(existing)?.push(replacement);
      return replacement;
    }
    if (node.tag === "App") {
      if (node.symbol === "LblSetItem") return node;
      if (node.args.length === 2 && node.sorts.length === 0 && isMapItemSymbol(node.symbol)) {
        const [key, value] = node.args;
        if (key !== undefined && value !== undefined) return { ...node, args: [key, rename(value)] };
      }
    }
    return withPatterns(
      node,
      subpatterns(node).map((child) => rename(child)),
    );
  };

  return { pattern: rename(pattern), classes };
}

/** pyk `eq_matchers` (`k2lean4.py:812-824`): one matcher per extra occurrence. */
function equalityMatchers(classes: ReadonlyMap<string, readonly EVar[]>): readonly EqMatcher[] {
  const result: EqMatcher[] = [];
  for (const occurrences of classes.values()) {
    const [representative, ...rest] = occurrences;
    if (representative === undefined) continue;
    for (const other of rest) result.push({ tag: "eq", first: representative, second: other });
  }
  return result;
}

/**
 * Abstract collection and injection shapes out of the left-hand side —
 * pyk `abstract_matchers` (`k2lean4.py:826-879`), applied bottom-up.
 */
function abstractMatchers(
  definition: MatcherDefinition,
  pattern: Pattern,
  matchers: KleanMatcher[],
  diagnostics: LoweringDiagnostic[],
): Pattern {
  let nextName = 0;
  const fresh = (sort: string): EVar => {
    const variable: EVar = {
      tag: "EVar",
      name: `Var'Unds'Pat${nextName}`,
      sort: { tag: "SortApp", name: sort, sorts: [] },
    };
    nextName += 1;
    return variable;
  };

  return bottomUp(pattern, (node) => {
    if (node.tag !== "App") return node;

    if (node.symbol === "inj" && node.sorts.length === 2 && node.args.length === 1) {
      const [from, to] = node.sorts;
      const [inner] = node.args;
      if (
        from?.tag === "SortApp" &&
        to?.tag === "SortApp" &&
        inner !== undefined &&
        (definition.subsorts.get(from.name)?.length ?? 0) > 0 &&
        freeOccurrences(inner).size > 0
      ) {
        const variable = fresh(to.name);
        matchers.push({ tag: "subsort", variable, subsort: from.name, supersort: to.name, pattern: inner });
        return variable;
      }
      return node;
    }

    if (node.symbol === "Lbl'Unds'List'Unds'" && node.sorts.length === 0 && node.args.length === 2) {
      const [left, right] = node.args;
      if (left?.tag === "App" && left.symbol === "LblListItem" && left.args.length === 1 && right !== undefined) {
        const [head] = left.args;
        if (head !== undefined) {
          const variable = fresh("SortList");
          matchers.push({ tag: "list", variable, prefix: [head], middle: right, suffix: [] });
          return variable;
        }
      }
      if (right?.tag === "App" && right.symbol === "LblListItem" && right.args.length === 1 && left !== undefined) {
        const [last] = right.args;
        if (last !== undefined) {
          const variable = fresh("SortList");
          matchers.push({ tag: "list", variable, prefix: [], middle: left, suffix: [last] });
          return variable;
        }
      }
      return node;
    }

    if (node.symbol === "Lbl'Stop'List") {
      const variable = fresh("SortList");
      matchers.push({ tag: "empty-list", variable });
      return variable;
    }

    if (node.symbol === "Lbl'Unds'Set'Unds'" && node.sorts.length === 0 && node.args.length === 2) {
      const [left, rest] = node.args;
      if (left?.tag === "App" && left.symbol === "LblSetItem" && left.args.length === 1 && rest !== undefined) {
        const [element] = left.args;
        if (element !== undefined) {
          const variable = fresh("SortSet");
          matchers.push({ tag: "set", variable, elements: [element], rest });
          return variable;
        }
      }
      return node;
    }

    if (node.symbol === "Lbl'Stop'Set") {
      const variable = fresh("SortSet");
      matchers.push({ tag: "empty-set", variable });
      return variable;
    }

    if (node.sorts.length === 0 && node.args.length === 2 && isMapConcatSymbol(node.symbol)) {
      const [item, rest] = node.args;
      if (item?.tag === "App" && item.args.length === 2 && item.sorts.length === 0 && isMapItemSymbol(item.symbol)) {
        // pyk `sort = f'Sort{map_symbol[9:-6]}'` (`k2lean4.py:862`).
        const sort = `Sort${node.symbol.slice("Lbl'Unds'".length, -"'Unds'".length)}`;
        const element = collectionElementSortNames(definition, sort);
        const [key, value] = item.args;
        const [keySort, valueSort] = element;
        if (key !== undefined && value !== undefined && rest !== undefined) {
          if (keySort === undefined || valueSort === undefined) {
            diagnostics.push({
              code: "unsupported-pattern",
              message: `Map matcher on ${sort} has no projected key/value element sorts`,
              path: ["lhs"],
            });
            return node;
          }
          const variable = fresh(sort);
          matchers.push({ tag: "map", variable, keySort, valueSort, keys: [key], values: [value], rest });
          return variable;
        }
      }
      return node;
    }

    if (isMapUnitSymbol(node.symbol)) {
      const sort = `Sort${node.symbol.slice("Lbl'Stop'".length)}`;
      const [keySort, valueSort] = collectionElementSortNames(definition, sort);
      if (keySort === undefined || valueSort === undefined) {
        diagnostics.push({
          code: "unsupported-pattern",
          message: `Empty-map matcher on ${sort} has no projected key/value element sorts`,
          path: ["lhs"],
        });
        return node;
      }
      const variable = fresh(sort);
      matchers.push({ tag: "empty-map", variable, keySort, valueSort });
      return variable;
    }

    return node;
  });
}

export interface OrderedMatchers {
  readonly generations: readonly (readonly KleanMatcher[])[];
  readonly diagnostics: readonly LoweringDiagnostic[];
}

/**
 * Layer matchers so that every producer precedes its consumers — pyk
 * `order_matchers` (`k2lean4.py:881-891`).
 *
 * pyk builds `i -> j` whenever `j` reads a variable `i` binds and asks
 * `networkx` for `topological_generations`.  This is the same layering by
 * Kahn's algorithm, keeping the input order inside a generation so output is
 * byte-stable, and reporting a dependency cycle as a diagnostic instead of
 * raising the way `networkx` would.
 */
export function orderMatchers(matchers: readonly KleanMatcher[]): OrderedMatchers {
  const producedBy = matchers.map((matcher) => new Set(matcherOutputs(matcher).map((v) => variableKey(v))));
  const consumes = matchers.map((matcher) => matcherInputs(matcher).map((v) => variableKey(v)));
  const predecessors = matchers.map((_, index) => {
    const result = new Set<number>();
    for (const name of consumes[index] ?? [])
      for (const [other, produced] of producedBy.entries())
        if (other !== index && produced.has(name)) result.add(other);
    return result;
  });

  const generations: KleanMatcher[][] = [];
  const remaining = new Set(matchers.map((_, index) => index));
  while (remaining.size > 0) {
    const ready = [...remaining].filter((index) =>
      [...(predecessors[index] ?? [])].every((predecessor) => !remaining.has(predecessor)),
    );
    if (ready.length === 0) {
      return {
        generations,
        diagnostics: [
          {
            code: "unsupported-pattern",
            message: "Function-rule matchers have a cyclic input/output dependency and cannot be ordered",
            path: ["lhs"],
          },
        ],
      };
    }
    for (const index of ready) remaining.delete(index);
    generations.push(
      ready.map((index) => {
        const matcher = matchers[index];
        if (matcher === undefined) throw new Error("Ordered matcher index is out of range");
        return matcher;
      }),
    );
  }
  return { generations, diagnostics: [] };
}

/**
 * Put the leftover collection a hook `split` returns back inside its Lean
 * structure, so the KORE variable bound to it has the sort KORE gave it.
 *
 * **Deviation from pyk, required for the output to elaborate.** A K collection
 * sort is generated as `structure SortMap where coll : List (K × V)`
 * (`k2lean4.py:378-393`), but the Prelude's
 * `split : List (K × V) → List K → Option (List V × List (K × V))` works on the
 * bare `coll` field.  pyk matches the raw result directly
 * (`k2lean4.py:728-735`), so a rule such as `f((K |-> V) M) => M` binds `M` at
 * `List (SortKItem × SortKItem)` and Lean rejects the right-hand side with
 * "application type mismatch … has type List (SortKItem × SortKItem) but is
 * expected to have type SortMap".  It never surfaced upstream because the only
 * shipped fixture ignores the leftover.
 *
 * Mapping the structure constructor over the `Option` before matching keeps
 * pyk's pattern shape and fixes the type; when the leftover is unused the two
 * spellings are equivalent, and when the collection sort is not a structure
 * this falls back to pyk's exact output.
 */
function reboxCollection(
  definition: MatcherDefinition,
  variable: EVar,
  split: string,
  binder: string,
  rebuild: (boxed: string) => string,
  bound: string,
): string {
  const sort = variable.sort.tag === "SortApp" ? variable.sort.name : undefined;
  const fields = sort === undefined ? undefined : definition.structures?.get(sort);
  const [field] = fields ?? [];
  if (sort === undefined || fields?.length !== 1 || field === undefined) return split;
  return `(${split}).map (fun ${binder} => ${rebuild(`({ ${field.name} := ${bound} } : ${sort})`)})`;
}

/** `Lbl'Unds'<Name>Map'Unds'` — pyk's map-concat test (`k2lean4.py:854-861`). */
function isMapConcatSymbol(symbol: string): boolean {
  return symbol.startsWith("Lbl'Unds'") && symbol.endsWith("Map'Unds'");
}

/** `_|->_` or `<Name>CellMapItem` — pyk (`k2lean4.py:802-807, 857-860`). */
function isMapItemSymbol(symbol: string): boolean {
  return symbol === "Lbl'UndsPipe'-'-GT-Unds'" || (symbol.startsWith("Lbl") && symbol.endsWith("CellMapItem"));
}

/** `Lbl'Stop'<Name>Map` — pyk's empty-map test (`k2lean4.py:869-871`). */
function isMapUnitSymbol(symbol: string): boolean {
  return symbol.startsWith("Lbl'Stop'") && symbol.endsWith("Map");
}

/** The parameter sorts of a collection sort's `element` symbol. */
function collectionElementSortNames(definition: MatcherDefinition, sort: string): readonly (string | undefined)[] {
  const collection = definition.collections.get(sort);
  if (collection === undefined) return [];
  return elementParameterSorts(definition.symbols.get(collection.element));
}

function collectionElementSorts(definition: MatcherDefinition, variable: EVar): readonly (string | undefined)[] {
  return variable.sort.tag === "SortApp" ? collectionElementSortNames(definition, variable.sort.name) : [];
}

function elementParameterSorts(declaration: SymbolDecl | undefined): readonly (string | undefined)[] {
  return (declaration?.paramSorts ?? []).map((sort) => plainSortName(sort));
}

/** A sort usable as a Lean type name: a parameterless `SortApp` or a `SortVar`. */
export function plainSortName(sort: Sort): string | undefined {
  if (sort.tag === "SortVar") return sort.name;
  return sort.tag === "SortApp" && sort.sorts.length === 0 ? sort.name : undefined;
}

/**
 * Whether a Lean `match` on this argument alone is exhaustive — pyk
 * `_is_exhaustive` (`k2lean4.py:756-774`).
 *
 * Only when it is not does the rule need pyk's `| _, … => none` fallback
 * alternative; emitting one anyway makes Lean reject the definition as having
 * an unreachable alternative.
 */
export function isExhaustive(definition: MatcherDefinition, pattern: Pattern): boolean {
  switch (pattern.tag) {
    case "EVar":
      return true;
    case "DV":
      return false;
    case "App": {
      // pyk: a collection function such as `_List_` can occur on the LHS and
      // is never a constructor pattern (`k2lean4.py:762-765`).
      if (definition.equations.has(pattern.symbol)) return false;
      const sort = inferSort(definition.symbols, pattern);
      if (sort?.tag !== "SortApp") return false;
      const constructors = definition.constructors.get(sort.name)?.length ?? 0;
      const subsorts = definition.subsorts.get(sort.name)?.length ?? 0;
      return constructors + subsorts === 1 && pattern.args.every((arg) => isExhaustive(definition, arg));
    }
    default:
      return false;
  }
}

function freeVariables(items: readonly Pattern[]): readonly EVar[] {
  const result = new Map<string, EVar>();
  for (const item of items)
    for (const occurrences of freeOccurrences(item).values())
      for (const occurrence of occurrences) result.set(variableKey(occurrence), occurrence);
  return [...result.values()];
}

/** pyk keys variables by the frozen `EVar` dataclass, i.e. by name *and* sort. */
function variableKey(variable: EVar): string {
  return `${variable.name}\u0000${sortKeyText(variable.sort)}`;
}

function sortKeyText(sort: Sort): string {
  return sort.tag === "SortVar" ? `SortVar:${sort.name}` : `${sort.name}(${sort.sorts.map(sortKeyText).join(",")})`;
}

function unreachableMatcher(value: never): never {
  throw new TypeError(`Unknown KLean matcher variant: ${JSON.stringify(value)}`);
}
