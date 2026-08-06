/**
 * Sort resolution over a definition's symbol declarations: what sort a pattern
 * has, and what sorts its children must have.
 *
 * Transcribed from pyk `kore/kompiled.py:278-331` (`KoreSymbolTable.resolve`,
 * `.infer_sort`, `.pattern_sorts`), with pyk's class replaced by free functions
 * over the table `indexDefinition` already built — the convention
 * `definition.ts` set with `subsorts(from, …)`.  There is no second index to
 * construct: `KoreDefinitionIndex.symbols` *is* `KoreSymbolTable._symbol_table`,
 * built by the same last-declaration-wins rule.
 *
 * # The ML connectives are not applications here
 *
 * pyk chains `ML_SYMBOL_DECLS` (`syntax.py:1993-2012`) into its table so that
 * `\and`, `\equals` and friends resolve like any other symbol.  This package
 * models them as their own pattern *tags*, so no `App.symbol` in a parsed term
 * is ever an ML head and there would be nothing for those declarations to
 * resolve — `definition.ts` makes the same argument about the index itself.
 * {@link patternSorts} therefore answers the ML cases structurally, which is
 * also **more** than pyk can do: its eleven declarations cover
 * `\top \bottom \not \and \or \implies \iff \ceil \floor \equals \in` and stop,
 * so pyk raises `Undeclared symbol` for `\next`, `\rewrites`, `\mu` and `\nu`,
 * and its binary `\and`/`\or` declarations trip its own
 * `assert len(sorts) == len(pattern.patterns)` (`kompiled.py:330`) on the n-ary
 * conjunctions a real `definition.kore` is full of.  Both are answered here.
 *
 * # Answers or `undefined`
 *
 * Per `definition.ts`'s contract, and where pyk raises `ValueError`: an
 * undeclared symbol, a sort-parameter count that does not match the
 * declaration's, or a pattern whose sort is not recoverable.  Nothing here
 * throws.
 */

import type { LazyKoreDefinitionIndex } from "./definition.js";
import type { Pattern, Sort, SymbolDecl } from "./syntax.js";

/** Symbol declarations by name — the type of {@link LazyKoreDefinitionIndex.symbols}. */
export type SymbolTable = ReadonlyMap<string, SymbolDecl>;

/** A symbol's signature, with its sort parameters instantiated. */
export interface SymbolSignature {
  /** The sort an application of the symbol has. */
  readonly sort: Sort;
  /** The sorts its arguments must have, in order. */
  readonly paramSorts: readonly Sort[];
}

function tableOf(from: LazyKoreDefinitionIndex | SymbolTable): SymbolTable {
  return "symbols" in from ? from.symbols : from;
}

/**
 * The signature of `symbol` at the sort arguments `sorts` — pyk
 * `KoreSymbolTable.resolve` (`kompiled.py:278-301`).
 *
 * **Top-level substitution only**, as pyk's is (`kompiled.py:293-296`): a sort
 * variable is replaced where it *is* the sort, not where it occurs inside one,
 * so `symbol foo{S}(SortList{S}) : S` resolves its result sort and leaves the
 * inner `S` of the parameter alone.  Every symbol `kompile` emits is either
 * parameterless or `inj{From, To}`, so the limitation has never bitten upstream;
 * it is documented rather than fixed because fixing it would make this function
 * disagree with the reference on a case the reference cannot express anyway.
 *
 * `undefined` where pyk raises `ValueError`: `symbol` is undeclared, or `sorts`
 * does not have exactly as many elements as the declaration has sort variables.
 */
export function resolveSymbol(
  from: LazyKoreDefinitionIndex | SymbolTable,
  symbol: string,
  sorts: readonly Sort[] = [],
): SymbolSignature | undefined {
  const decl = tableOf(from).get(symbol);
  if (decl === undefined) return undefined;

  const { vars } = decl.symbol;
  if (vars.length !== sorts.length) return undefined;
  // The copy is not an optimization missed: returning `decl.paramSorts` itself
  // would hand out the *declaration's* array inside a frozen wrapper, so
  // `sig.paramSorts.push(…)` would edit the parsed definition for every later
  // caller. The parametric path below already builds a fresh array (`.map`);
  // this makes the two paths agree, frozen result included.
  if (vars.length === 0) {
    return Object.freeze({ sort: decl.sort, paramSorts: Object.freeze([...decl.paramSorts]) });
  }

  const bySortVar = new Map<string, Sort>();
  for (const [i, sortVar] of vars.entries()) {
    const sort = sorts[i];
    if (sort !== undefined) bySortVar.set(sortVar.name, sort);
  }
  const substitute = (sort: Sort): Sort => (sort.tag === "SortVar" ? (bySortVar.get(sort.name) ?? sort) : sort);

  return Object.freeze({
    sort: substitute(decl.sort),
    paramSorts: Object.freeze(decl.paramSorts.map(substitute)),
  });
}

/**
 * The sort of a pattern — pyk `KoreSymbolTable.infer_sort`
 * (`kompiled.py:303-311`).
 *
 * Two cases, pyk's: a pattern that carries a sort has it (`WithSort`, i.e. every
 * variable and every ML pattern but `\mu`/`\nu`), and an application takes the
 * result sort of its declaration.
 *
 * `undefined` for a `\left-assoc`/`\right-assoc` (sugar with no sort of its own
 * — its head symbol's would be the sort of the *expansion*), a bare `String`
 * (only ever a `\dv`'s literal), a `\mu`/`\nu` (pyk raises; the sort is the
 * bound set variable's, but pyk's `WithSort` deliberately excludes fixpoints and
 * following it keeps the two implementations comparable), and an application of
 * an undeclared symbol.
 */
export function inferSort(from: LazyKoreDefinitionIndex | SymbolTable, pattern: Pattern): Sort | undefined {
  switch (pattern.tag) {
    case "App":
      return resolveSymbol(from, pattern.symbol, pattern.sorts)?.sort;
    case "String":
    case "LeftAssoc":
    case "RightAssoc":
    case "Mu":
    case "Nu":
      return undefined;
    default:
      // Every remaining tag is one of pyk's `WithSort`s: `EVar`, `SVar`, the ML
      // connectives, the quantifiers, the predicates (whose `sort` is the
      // *result* sort, `opSort` being the argument's), `\next`, `\rewrites`,
      // `\dv` — and `MultiOr`, which is a `\or` in every respect but its
      // spelling.
      return pattern.sort;
  }
}

/**
 * The sorts this pattern's direct children must have — pyk
 * `KoreSymbolTable.pattern_sorts` (`kompiled.py:313-331`).
 *
 * Parallel to `patterns(pattern)` and the same length, which is pyk's closing
 * assertion (`kompiled.py:330`) made into the contract.  The ML cases are
 * answered from the pattern's own sorts rather than from a declaration — see the
 * module header — and `\and`/`\or`/`\or`-as-`MultiOr` repeat their sort once per
 * operand, so an n-ary conjunction is handled where pyk's binary declaration
 * would assert.
 *
 * `undefined` rather than a wrong answer for the shapes that have no honest one:
 * an application of an undeclared symbol (or one given the wrong number of sort
 * parameters), an application whose argument count disagrees with its
 * declaration's — `f{}()` declared and `f{}(X, Y)` written is exactly where
 * pyk's `assert len(sorts) == len(pattern.patterns)` (`kompiled.py:330`) fires,
 * and the same-length contract above is the whole point of the function — and
 * `\left-assoc`/`\right-assoc`, whose arguments are the operands of an
 * *expansion* of the head symbol and are not its parameters.
 */
export function patternSorts(
  from: LazyKoreDefinitionIndex | SymbolTable,
  pattern: Pattern,
): readonly Sort[] | undefined {
  switch (pattern.tag) {
    // pyk `kompiled.py:315-316`: a `\dv`'s literal is not a child.
    case "DV":
    case "EVar":
    case "SVar":
    case "String":
    case "Top":
    case "Bottom":
      return [];
    // pyk `kompiled.py:318-319`: `MLQuant`, whose one child is the body.
    case "Exists":
    case "Forall":
      return [pattern.sort];
    case "Not":
    case "Next":
      return [pattern.sort];
    case "Implies":
    case "Iff":
    case "Rewrites":
      return [pattern.sort, pattern.sort];
    case "And":
    case "Or":
    case "MultiOr":
      return pattern.patterns.map(() => pattern.sort);
    // `\ceil{S, T}(P)` and `\floor` take one argument of the *first* sort;
    // `\equals{S, T}(L, R)` and `\in` take two.  `sort` is the result sort in
    // all four and is not a child's sort.
    case "Ceil":
    case "Floor":
      return [pattern.opSort];
    case "Equals":
    case "In":
      return [pattern.opSort, pattern.opSort];
    // pyk raises here (`\mu`/`\nu` are not in `ML_SYMBOL_DECLS`); the body has
    // the bound set variable's sort, which is the only sort in the pattern.
    case "Mu":
    case "Nu":
      return [pattern.var.sort];
    case "App": {
      const paramSorts = resolveSymbol(from, pattern.symbol, pattern.sorts)?.paramSorts;
      // The declaration's arity is not the pattern's arity on malformed input,
      // and answering with the declaration's would break the same-length
      // contract the doc states.
      if (paramSorts === undefined || paramSorts.length !== pattern.args.length) return undefined;
      return paramSorts;
    }
    case "LeftAssoc":
    case "RightAssoc":
      return undefined;
    default:
      // Unreachable: the switch covers all 25 `Pattern` tags, and `tsc` checks
      // that it does. The arm exists because every path must return a value.
      return undefined;
  }
}
