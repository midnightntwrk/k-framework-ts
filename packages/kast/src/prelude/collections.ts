/**
 * The builtin collection sorts and their constructors — pyk
 * `prelude/collections.py`.
 *
 * Every `*Of` builder folds with `buildAssoc`, so an empty input gives the
 * `.Sort` unit and a one-element input gives the bare item — collections are
 * associative-commutative in K, and the term is just one spelling of the value.
 */

import { hashOf } from "../eq.js";
import { buildAssoc, kapply, klabel, ksort, type KInner, type KSort } from "../inner.js";

/** `prelude/collections.py:13-17`. */
export const SET: KSort = ksort("Set");
export const LIST: KSort = ksort("List");
export const MAP: KSort = ksort("Map");
export const RANGEMAP: KSort = ksort("RangeMap");
export const BAG: KSort = ksort("Bag");

/**
 * Deduplicate keyed entries the way Python's `dict(pairs)` does
 * (`prelude/collections.py:53,66`): first occurrence fixes the position, the
 * last value for a key wins.
 *
 * pyk keys on the frozen dataclass's structural hash; {@link hashOf} is the
 * structural key here.
 */
function dedupe<K, V>(entries: Iterable<readonly [K, V]>, keyOf: (key: K) => string): [K, V][] {
  const positions = new Map<string, number>();
  const result: [K, V][] = [];
  for (const [key, value] of entries) {
    const hash = keyOf(key);
    const position = positions.get(hash);
    if (position === undefined) {
      positions.set(hash, result.length);
      result.push([key, value]);
    } else {
      result[position] = [key, value];
    }
  }
  return result;
}

/** `.Set` (`prelude/collections.py:20-21`). */
export function setEmpty(): KInner {
  return kapply(".Set");
}

/** `SetItem(k)` (`prelude/collections.py:24-25`). */
export function setItem(k: KInner): KInner {
  return kapply("SetItem", [k]);
}

/**
 * `_Set_` over the items (`prelude/collections.py:28-29`).
 *
 * Duplicates are **not** removed — pyk does not, and `SetItem(x) SetItem(x)`
 * is a well-formed term that the K rewriter reduces itself.
 */
export function setOf(ks: Iterable<KInner>): KInner {
  return buildAssoc(
    setEmpty(),
    klabel("_Set_"),
    [...ks].map((k) => setItem(k)),
  );
}

/** `.List` (`prelude/collections.py:32-33`). */
export function listEmpty(): KInner {
  return kapply(".List");
}

/** `ListItem(k)` (`prelude/collections.py:36-37`). */
export function listItem(k: KInner): KInner {
  return kapply("ListItem", [k]);
}

/** `_List_` over the items (`prelude/collections.py:40-41`). */
export function listOf(ks: Iterable<KInner>): KInner {
  return buildAssoc(
    listEmpty(),
    klabel("_List_"),
    [...ks].map((k) => listItem(k)),
  );
}

/** `.Map` (`prelude/collections.py:44-45`). */
export function mapEmpty(): KInner {
  return kapply(".Map");
}

/** `k |-> v` (`prelude/collections.py:48-49`). */
export function mapItem(k: KInner, v: KInner): KInner {
  return kapply("_|->_", [k, v]);
}

/**
 * `_Map_` over the entries (`prelude/collections.py:52-54`).
 *
 * A `ReadonlyMap<KInner, KInner>` is accepted, but note that a JS `Map` keys on
 * *identity* while the `dict(ks)` pyk builds keys structurally: two equal-but-
 * distinct key terms are two entries in the input `Map` and one entry here.
 */
export function mapOf(ks: Iterable<readonly [KInner, KInner]>): KInner {
  const entries = dedupe(ks, hashOf);
  return buildAssoc(
    mapEmpty(),
    klabel("_Map_"),
    entries.map(([k, v]) => mapItem(k, v)),
  );
}

/** `.RangeMap` (`prelude/collections.py:57-58`). */
export function rangemapEmpty(): KInner {
  return kapply(".RangeMap");
}

/** `RangeMap:Range(start, end) r|-> v` (`prelude/collections.py:61-62`). */
export function rangemapItem(k: readonly [KInner, KInner], v: KInner): KInner {
  return kapply("_r|->_", [kapply("RangeMap:Range", [k[0], k[1]]), v]);
}

/** `_RangeMap_` over the entries, keyed by range (`prelude/collections.py:65-67`). */
export function rangemapOf(ks: Iterable<readonly [readonly [KInner, KInner], KInner]>): KInner {
  const entries = dedupe(ks, ([start, end]) => `${hashOf(start)}${hashOf(end)}`);
  return buildAssoc(
    rangemapEmpty(),
    klabel("_RangeMap_"),
    entries.map(([k, v]) => rangemapItem(k, v)),
  );
}
