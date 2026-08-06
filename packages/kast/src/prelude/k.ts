/**
 * The sorts and injection every K definition has — pyk `prelude/k.py`.
 */

import { kapply, klabel, ksort, ktoken, type KApply, type KInner, type KSort, type KToken } from "../inner.js";

/** `prelude/k.py:13-15`. */
export const K: KSort = ksort("K");
export const K_ITEM: KSort = ksort("KItem");
export const GENERATED_TOP_CELL: KSort = ksort("GeneratedTopCell");

/** The elision token a pretty-printed, abstracted cell shows (`prelude/k.py:17`). */
export const DOTS: KToken = ktoken("...", K);

/**
 * `inj{fromSort, toSort}(term)` — the sort injection (`prelude/k.py:20-21`).
 *
 * pyk declares the return type `KInner`; it is always a `KApply`.
 */
export function inj(fromSort: KSort, toSort: KSort, term: KInner): KApply {
  return kapply(klabel("inj", [fromSort, toSort]), [term]);
}
