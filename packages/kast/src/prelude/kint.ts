/**
 * `Int` and its operators — pyk `prelude/kint.py`, all 24 wrappers.
 *
 * Every function here is one `KApply` with a fixed label; the labels are the
 * `domains.md` syntax of `INT-SYNTAX`, and the backtick-quoted spellings in the
 * doc comments are how K writes them.
 */

import { kapply, ksort, ktoken, type KApply, type KInner, type KSort, type KToken } from "../inner.js";

/** `prelude/kint.py:12`. */
export const INT: KSort = ksort("Int");

/**
 * `#token(i, "Int")` (`prelude/kint.py:15-24`).
 *
 * K integers are unbounded, so `bigint` is the honest input type; a `number`
 * is accepted for call-site convenience and goes through `BigInt`, which
 * **throws `RangeError` on a non-integer** (pyk would take no float either)
 * and prints large values in full rather than in `1e+21` form.
 */
export function intToken(i: bigint | number): KToken {
  return ktoken(BigInt(i).toString(), INT);
}

/** ``_<Int_`(i1, i2)`` (`prelude/kint.py:27-37`). */
export function ltInt(i1: KInner, i2: KInner): KApply {
  return kapply("_<Int_", [i1, i2]);
}

/** ``_<=Int_`(i1, i2)`` (`prelude/kint.py:40-50`). */
export function leInt(i1: KInner, i2: KInner): KApply {
  return kapply("_<=Int_", [i1, i2]);
}

/** ``_>Int_`(i1, i2)`` (`prelude/kint.py:53-63`). */
export function gtInt(i1: KInner, i2: KInner): KApply {
  return kapply("_>Int_", [i1, i2]);
}

/** ``_>=Int_`(i1, i2)`` (`prelude/kint.py:66-76`). */
export function geInt(i1: KInner, i2: KInner): KApply {
  return kapply("_>=Int_", [i1, i2]);
}

/** ``_==Int_`(i1, i2)`` (`prelude/kint.py:79-89`). */
export function eqInt(i1: KInner, i2: KInner): KApply {
  return kapply("_==Int_", [i1, i2]);
}

/** ``_=/=Int_`(i1, i2)`` (`prelude/kint.py:92-102`). */
export function neqInt(i1: KInner, i2: KInner): KApply {
  return kapply("_=/=Int_", [i1, i2]);
}

/** ``~Int_`(i)`` — bitwise complement (`prelude/kint.py:105-114`). */
export function notInt(i: KInner): KApply {
  return kapply("~Int_", [i]);
}

/** ``_^Int_`(i1, i2)`` (`prelude/kint.py:117-127`). */
export function expInt(i1: KInner, i2: KInner): KApply {
  return kapply("_^Int_", [i1, i2]);
}

/** ``_^%Int__`(i1, i2, i3)`` — `i1 ^ i2 % i3` (`prelude/kint.py:130-141`). */
export function expModInt(i1: KInner, i2: KInner, i3: KInner): KApply {
  return kapply("_^%Int__", [i1, i2, i3]);
}

/** ``_*Int_`(i1, i2)`` (`prelude/kint.py:144-154`). */
export function mulInt(i1: KInner, i2: KInner): KApply {
  return kapply("_*Int_", [i1, i2]);
}

/** ``_/Int_`(i1, i2)`` — division truncating toward zero (`prelude/kint.py:157-167`). */
export function divInt(i1: KInner, i2: KInner): KApply {
  return kapply("_/Int_", [i1, i2]);
}

/** ``_%Int_`(i1, i2)`` — remainder of {@link divInt} (`prelude/kint.py:170-180`). */
export function modInt(i1: KInner, i2: KInner): KApply {
  return kapply("_%Int_", [i1, i2]);
}

/** ``_divInt_`(i1, i2)`` — division flooring toward -infinity (`prelude/kint.py:183-193`). */
export function euclidDivInt(i1: KInner, i2: KInner): KApply {
  return kapply("_divInt_", [i1, i2]);
}

/** ``_modInt_`(i1, i2)`` — remainder of {@link euclidDivInt} (`prelude/kint.py:196-206`). */
export function euclidModInt(i1: KInner, i2: KInner): KApply {
  return kapply("_modInt_", [i1, i2]);
}

/** ``_+Int_`(i1, i2)`` (`prelude/kint.py:209-219`). */
export function addInt(i1: KInner, i2: KInner): KApply {
  return kapply("_+Int_", [i1, i2]);
}

/** ``_-Int_`(i1, i2)`` (`prelude/kint.py:222-232`). */
export function subInt(i1: KInner, i2: KInner): KApply {
  return kapply("_-Int_", [i1, i2]);
}

/** ``_>>Int_`(i1, i2)`` (`prelude/kint.py:235-245`). */
export function rshiftInt(i1: KInner, i2: KInner): KApply {
  return kapply("_>>Int_", [i1, i2]);
}

/** ``_<<Int_`(i1, i2)`` (`prelude/kint.py:248-258`). */
export function lshiftInt(i1: KInner, i2: KInner): KApply {
  return kapply("_<<Int_", [i1, i2]);
}

/** ``_&Int_`(i1, i2)`` (`prelude/kint.py:261-271`). */
export function andInt(i1: KInner, i2: KInner): KApply {
  return kapply("_&Int_", [i1, i2]);
}

/** ``_xorInt_`(i1, i2)`` (`prelude/kint.py:274-284`). */
export function xorInt(i1: KInner, i2: KInner): KApply {
  return kapply("_xorInt_", [i1, i2]);
}

/** ``_|Int_`(i1, i2)`` (`prelude/kint.py:287-297`). */
export function orInt(i1: KInner, i2: KInner): KApply {
  return kapply("_|Int_", [i1, i2]);
}

/** ``minInt`(i1, i2)`` (`prelude/kint.py:300-310`). */
export function minInt(i1: KInner, i2: KInner): KApply {
  return kapply("minInt", [i1, i2]);
}

/** ``maxInt`(i1, i2)`` (`prelude/kint.py:313-323`). */
export function maxInt(i1: KInner, i2: KInner): KApply {
  return kapply("maxInt", [i1, i2]);
}

/** ``absInt`(i)`` (`prelude/kint.py:326-335`). */
export function absInt(i: KInner): KApply {
  return kapply("absInt", [i]);
}
