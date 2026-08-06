/**
 * Matching-logic connectives — pyk `prelude/ml.py`.
 *
 * Every ML label is *parametric in its sorts*: `#Top{S}`, `#Equals{S1, S2}`.
 * The parameters are part of the label (`KLabel(name, params)`), never
 * arguments, and they participate in {@link eq} but not in `match`
 * (`inner.py:429`) — so a predicate built at one sort still matches a pattern
 * built at another.
 */

import {
  buildAssoc,
  flattenLabel,
  kapply,
  klabel,
  type KApply,
  type KInner,
  type KSort,
  type KVariable,
} from "../inner.js";
import { GENERATED_TOP_CELL, K, K_ITEM } from "./k.js";
import { BOOL, FALSE, TRUE } from "./kbool.js";

/** `prelude/ml.py:17-18`. */
function isTopApply(term: KInner): boolean {
  return term.node === "KApply" && term.label.name === "#Top";
}

/** `prelude/ml.py:32-33`. */
function isBottomApply(term: KInner): boolean {
  return term.node === "KApply" && term.label.name === "#Bottom";
}

/**
 * Is `term` `#Top` (`prelude/ml.py:21-29`)?
 *
 * With `weak`, a conjunction of `#Top`s counts too: the term is flattened
 * through `#And`, and *all* conjuncts must be weakly top.  The two degenerate
 * cases are pyk's and are transcribed as they stand — a one-element flattening
 * (i.e. any term that is not a `#And`) recurses **without** `weak`, and a
 * zero-argument `#And` flattens to nothing and is therefore vacuously top.
 */
export function isTop(term: KInner, { weak = false }: { readonly weak?: boolean } = {}): boolean {
  if (isTopApply(term)) return true;
  if (!weak) return false;
  const flat = flattenLabel("#And", term);
  const only = flat.length === 1 ? flat[0] : undefined;
  if (only !== undefined) return isTop(only);
  return flat.every((conjunct) => isTop(conjunct, { weak: true }));
}

/**
 * Is `term` `#Bottom` (`prelude/ml.py:36-44`)?
 *
 * The `weak` arm mirrors {@link isTop} except that *any* conjunct being
 * bottom makes the conjunction bottom.  Note it flattens `#And` here too, not
 * `#Or`.
 */
export function isBottom(term: KInner, { weak = false }: { readonly weak?: boolean } = {}): boolean {
  if (isBottomApply(term)) return true;
  if (!weak) return false;
  const flat = flattenLabel("#And", term);
  const only = flat.length === 1 ? flat[0] : undefined;
  if (only !== undefined) return isBottom(only);
  return flat.some((conjunct) => isBottom(conjunct, { weak: true }));
}

/** `#Equals{argSort, sort}(term1, term2)` (`prelude/ml.py:47-53`). */
export function mlEquals(
  term1: KInner,
  term2: KInner,
  argSort: string | KSort = K,
  sort: string | KSort = GENERATED_TOP_CELL,
): KApply {
  return kapply(klabel("#Equals", [argSort, sort]), [term1, term2]);
}

/** `#Equals{Bool, sort}(true, term)` — note the argument order (`prelude/ml.py:56-57`). */
export function mlEqualsTrue(term: KInner, sort: string | KSort = GENERATED_TOP_CELL): KApply {
  return mlEquals(TRUE, term, BOOL, sort);
}

/** `#Equals{Bool, sort}(false, term)` (`prelude/ml.py:60-61`). */
export function mlEqualsFalse(term: KInner, sort: string | KSort = GENERATED_TOP_CELL): KApply {
  return mlEquals(FALSE, term, BOOL, sort);
}

/** `#Top{sort}()` (`prelude/ml.py:64-65`). */
export function mlTop(sort: string | KSort = GENERATED_TOP_CELL): KApply {
  return kapply(klabel("#Top", [sort]));
}

/** `#Bottom{sort}()` (`prelude/ml.py:68-69`). */
export function mlBottom(sort: string | KSort = GENERATED_TOP_CELL): KApply {
  return kapply(klabel("#Bottom", [sort]));
}

/** `#Not{sort}(term)` (`prelude/ml.py:72-73`). */
export function mlNot(term: KInner, sort: string | KSort = GENERATED_TOP_CELL): KApply {
  return kapply(klabel("#Not", [sort]), [term]);
}

/**
 * `#And{sort}` over `conjuncts`, right-nested (`prelude/ml.py:76-77`).
 *
 * `#Top` conjuncts are dropped twice over: by the filter, and by `buildAssoc`
 * skipping anything equal to the unit.  The filter is the wider of the two —
 * it drops `#Top{S}` for *any* `S`, while the unit check is `#Top{sort}`
 * exactly.  Zero surviving conjuncts give `#Top{sort}`; one is returned bare.
 */
export function mlAnd(conjuncts: Iterable<KInner>, sort: string | KSort = GENERATED_TOP_CELL): KInner {
  return buildAssoc(
    mlTop(sort),
    klabel("#And", [sort]),
    [...conjuncts].filter((conjunct) => !isTop(conjunct)),
  );
}

/** `#Or{sort}` over `disjuncts`, `#Bottom` filtered out (`prelude/ml.py:80-81`). */
export function mlOr(disjuncts: Iterable<KInner>, sort: string | KSort = GENERATED_TOP_CELL): KInner {
  return buildAssoc(
    mlBottom(sort),
    klabel("#Or", [sort]),
    [...disjuncts].filter((disjunct) => !isBottom(disjunct)),
  );
}

/** `#Implies{sort}(antecedent, consequent)` (`prelude/ml.py:84-85`). */
export function mlImplies(antecedent: KInner, consequent: KInner, sort: string | KSort = GENERATED_TOP_CELL): KApply {
  return kapply(klabel("#Implies", [sort]), [antecedent, consequent]);
}

/** `#Exists{sort1, sort2}(var, body)` (`prelude/ml.py:88-94`). */
export function mlExists(
  variable: KVariable,
  body: KInner,
  sort1: string | KSort = K_ITEM,
  sort2: string | KSort = GENERATED_TOP_CELL,
): KApply {
  return kapply(klabel("#Exists", [sort1, sort2]), [variable, body]);
}

/** `#Ceil{argSort, sort}(term)` — definedness of `term` (`prelude/ml.py:97-102`). */
export function mlCeil(
  term: KInner,
  argSort: string | KSort = GENERATED_TOP_CELL,
  sort: string | KSort = GENERATED_TOP_CELL,
): KApply {
  return kapply(klabel("#Ceil", [argSort, sort]), [term]);
}
