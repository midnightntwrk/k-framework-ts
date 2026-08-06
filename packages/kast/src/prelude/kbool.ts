/**
 * `Bool` and its operators — pyk `prelude/kbool.py`.
 *
 * `BOOL` and `TRUE` are defined *here*.  pyk imports them from `outer.py:47-48`
 * (`prelude/kbool.py:7`) purely to dodge a Python import cycle: `outer` needs
 * `TRUE` for `KRule`'s default `requires`, and would import `kbool` for it while
 * `kbool` imports `outer`.  There is no cycle to dodge in this direction — the
 * outer layer will import these — so the hack is not transcribed.
 */

import { hashOf } from "../eq.js";
import {
  buildAssoc,
  kapply,
  klabel,
  ksort,
  ktoken,
  type KApply,
  type KInner,
  type KSort,
  type KToken,
} from "../inner.js";

/** `prelude/kbool.py:16-18` (via `outer.py:47-48` upstream). */
export const BOOL: KSort = ksort("Bool");
export const TRUE: KToken = ktoken("true", BOOL);
export const FALSE: KToken = ktoken("false", BOOL);

/**
 * pyk `utils.unique` (`utils.py:277-284`): first occurrence wins, order kept.
 *
 * Python dedupes on `__hash__`/`__eq__`, which on a frozen dataclass is
 * structural; {@link hashOf} is this package's structural key.
 */
function unique(items: Iterable<KInner>): KInner[] {
  const seen = new Set<string>();
  const result: KInner[] = [];
  for (const item of items) {
    const key = hashOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/** `prelude/kbool.py:21-22`. */
export function boolToken(b: boolean): KToken {
  return b ? TRUE : FALSE;
}

/**
 * `_andBool_` over `items`, right-nested (`prelude/kbool.py:25-26`).
 *
 * Duplicates are dropped before folding, and `buildAssoc` then drops every
 * occurrence of the unit `true` — so `[]` and `[TRUE, TRUE]` both give `TRUE`,
 * and a single conjunct is returned bare.
 */
export function andBool(items: Iterable<KInner>): KInner {
  return buildAssoc(TRUE, klabel("_andBool_"), unique(items));
}

/** `_orBool_` over `items`, unit `false` (`prelude/kbool.py:29-30`). */
export function orBool(items: Iterable<KInner>): KInner {
  return buildAssoc(FALSE, klabel("_orBool_"), unique(items));
}

/** `prelude/kbool.py:33-34`. */
export function notBool(item: KInner): KApply {
  return kapply(klabel("notBool_"), [item]);
}

/** `prelude/kbool.py:37-38`. */
export function impliesBool(antecedent: KInner, consequent: KInner): KApply {
  return kapply(klabel("_impliesBool_"), [antecedent, consequent]);
}
