/**
 * Inserting the sort injections a KORE term needs to be well-sorted — pyk
 * `KompiledKore.add_injections` (`kompiled.py:121-162`).
 *
 * `prelude.ts` builds terms out of symbol names and domain values and knows
 * nothing about sorts: `k(kseq([intDv(1)]))` writes
 * `Lbl'-LT-'k'-GT-'{}(kseq{}(\dv{SortInt{}}("1"), dotk{}()))`, which the backend
 * rejects, because `kseq`'s first argument is a `SortKItem{}` and `SortInt{}` is
 * only a *subsort* of it.  {@link addInjections} walks the term against a
 * definition and wraps each subterm in `inj{actual, expected}(…)` wherever the
 * two differ — the last step between "assembled from `prelude.ts`" and "can be
 * sent to kore-rpc".
 *
 * # Why this is its own module
 *
 * pyk hangs the function off `KompiledKore`, the object holding its sort table
 * and its symbol table (`kompiled.py:39-43`).  This package has no such object:
 * `indexDefinition` (`definition.ts`) already produces both tables, and the two
 * halves of `KompiledKore`'s behaviour are free functions over them —
 * `isSubsort`/`meetSorts` in `definition.ts`, `resolveSymbol`/`inferSort`/
 * `patternSorts` in `symbols.ts`.  `symbols.ts` would be the natural home, but
 * its stated contract is *"Nothing here throws"* — every question it answers can
 * honestly have no answer — and this function's whole job is to **fail loudly**
 * when a term cannot be made well-sorted.  A term you meant to send to a backend
 * that silently comes back `undefined` is worse than a message naming the
 * subterm.  Hence one small module with the opposite contract, stated here.
 *
 * The gap triage that asked for this asked for it "at the KORE level"; this is
 * that, one module over from where pyk keeps it.
 */

import { isSubsort, type LazyKoreDefinitionIndex } from "./definition.js";
import { INJ, SORT_K } from "./prelude.js";
import { inferSort, patternSorts } from "./symbols.js";
import { app, koreText, type Pattern, type Sort, patterns, withPatterns } from "./syntax.js";

/**
 * A term could not be made well-sorted — pyk's `ValueError`
 * (`kompiled.py:162`), plus the two cases pyk reaches by `assert` or by
 * `KeyError` instead.
 *
 * The fields say which of the three happened without parsing the message:
 * `actualSort` is `undefined` exactly when the subterm's own sort could not be
 * inferred at all (an undeclared symbol, a `\left-assoc`), and `expectedSort` is
 * `undefined` exactly when it was the subterm's *children* whose expected sorts
 * were unknown.
 */
export class KoreInjectionError extends TypeError {
  /** The subterm that could not be placed. */
  readonly pattern: Pattern;
  /** Its inferred sort, if it had one. */
  readonly actualSort: Sort | undefined;
  /** The sort the context requires of it, if that was known. */
  readonly expectedSort: Sort | undefined;

  constructor(message: string, pattern: Pattern, actualSort?: Sort, expectedSort?: Sort) {
    super(message);
    this.name = "KoreInjectionError";
    this.pattern = pattern;
    this.actualSort = actualSort;
    this.expectedSort = expectedSort;
  }
}

/**
 * `pattern` at `sort`, injected if it is not already there — pyk
 * `KompiledKore._inject` (`kompiled.py:153-162`).
 *
 * Three cases, pyk's: the sorts agree and the term is returned untouched; the
 * actual sort is a subsort and the term is wrapped in
 * `inj{actual, expected}(…)`; otherwise it is an error.  Sorts are compared by
 * KORE text, this package's structural sort identity (`definition.ts`'s
 * `sortKey`).
 */
function injectInto(index: LazyKoreDefinitionIndex, pattern: Pattern, sort: Sort): Pattern {
  const actual = inferSort(index, pattern);
  if (actual === undefined) {
    throw new KoreInjectionError(`Cannot infer the sort of: ${koreText(pattern)}`, pattern, undefined, sort);
  }
  if (koreText(actual) === koreText(sort)) return pattern;
  if (isSubsort(index, actual, sort)) return app(INJ, [actual, sort], [pattern]);
  throw new KoreInjectionError(
    `Sort ${koreText(actual)} is not a subsort of ${koreText(sort)}: ${koreText(pattern)}`,
    pattern,
    actual,
    sort,
  );
}

/**
 * Insert every sort injection `pattern` needs to sit at `sort` — pyk
 * `KompiledKore.add_injections` (`kompiled.py:121-151`).
 *
 * Bottom-up: each subterm is first placed at the sort its parent's declaration
 * requires of it (`patternSorts`), then the rebuilt parent is placed at the sort
 * *its* parent requires.  `sort` defaults to `SortK{}`, as pyk's does
 * (`kompiled.py:122-123`) — every sort is a subsort of `SortK{}`
 * (`kompiled.py:234-235`), so the default injects the top of the term into `K`
 * rather than leaving it alone.  Pass the sort you actually want if that is not
 * what you meant: `addInjections(index, term, SORT_GENERATED_TOP_CELL)`.
 *
 * The walk is iterative — depth is bounded by the heap, as everywhere else in
 * this package — where pyk hand-rolls a five-slot flat stack for the same
 * reason (`kompiled.py:125-151`).
 *
 * @throws {KoreInjectionError} if any subterm's sort cannot be inferred, if any
 *   node's children have no known expected sorts (an undeclared head symbol, an
 *   arity disagreement with the declaration, or a `\left-assoc`/`\right-assoc`,
 *   all of which make pyk raise or assert), or if an inferred sort is not a
 *   subsort of the required one.
 */
export function addInjections(index: LazyKoreDefinitionIndex, pattern: Pattern, sort: Sort = SORT_K): Pattern {
  interface Frame {
    readonly node: Pattern;
    /** The sort the context requires of `node`. */
    readonly sort: Sort;
    /** The sorts `node`'s children must have — same length as `kids`. */
    readonly kidSorts: readonly Sort[];
    readonly kids: readonly Pattern[];
    readonly done: Pattern[];
  }

  const frame = (node: Pattern, at: Sort): Frame => {
    const kidSorts = patternSorts(index, node);
    if (kidSorts === undefined) {
      throw new KoreInjectionError(
        `Cannot determine the argument sorts of: ${koreText(node)}`,
        node,
        inferSort(index, node),
        at,
      );
    }
    return { node, sort: at, kidSorts, kids: patterns(node), done: [] };
  };

  const stack: Frame[] = [frame(pattern, sort)];
  for (;;) {
    const current = stack.at(-1);
    if (current === undefined) throw new TypeError("Unreachable: empty injection stack");

    const position = current.done.length;
    const kid = current.kids[position];
    if (kid !== undefined) {
      // `kidSorts` is the same length as `kids` — `patternSorts`' contract — so
      // this lookup is defined whenever `kid` is.
      const kidSort = current.kidSorts[position];
      if (kidSort === undefined) {
        throw new KoreInjectionError(
          `Cannot determine the sort of argument ${position} of: ${koreText(current.node)}`,
          current.node,
          inferSort(index, current.node),
          current.sort,
        );
      }
      stack.push(frame(kid, kidSort));
      continue;
    }

    stack.pop();
    const rebuilt = injectInto(index, withPatterns(current.node, current.done), current.sort);
    const parent = stack.at(-1);
    if (parent === undefined) return rebuilt;
    parent.done.push(rebuilt);
  }
}
