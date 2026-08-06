/**
 * The shared test vocabulary, ported from pyk's `tests/unit/utils.py`.
 *
 * Every transcribed table in `test/` reads through this file, exactly as every
 * pyk table reads through `utils.py`: `a`/`b`/`c` are nullary applications,
 * `x`/`y`/`z` are unsorted variables, `f`/`g`/`h` are labels applied to
 * arguments, and `k` is the `<k>` cell label.
 *
 * # The prelude re-exports at the bottom
 *
 * `utils.py` imports `intToken`, `ltInt`, `geInt` and `mlEqualsTrue` from
 * `pyk.kast.prelude`, and the `match` and `subst` tables reach for `mlTop`,
 * `mlBottom`, `mlEquals`, `mlAnd` and `mlOr`.  Those are re-exported from
 * `src/prelude/` here so every table keeps reading through one file, as pyk's
 * do; nothing in `src/` may import this file.
 */

import { expect } from "bun:test";
import { eq } from "../src/eq.ts";
import { kapply, klabel, kvariable, type KApply, type KInner, type KLabel } from "../src/inner.ts";
import { geInt, intToken, ltInt } from "../src/prelude/kint.ts";
import { mlEqualsTrue } from "../src/prelude/ml.ts";

//////////////////////
// utils.py:16-21   //
//////////////////////

export const a: KApply = kapply("a");
export const b: KApply = kapply("b");
export const c: KApply = kapply("c");

export const x = kvariable("x");
export const y = kvariable("y");
export const z = kvariable("z");

/**
 * `f, g, h = map(KLabel, ('f', 'g', 'h'))`.
 *
 * pyk can spell both `f` (the label) and `f(x)` (the application) with one
 * name because `KLabel.__call__` applies it (`inner.py:105-106`).  A TS
 * function value cannot also be a plain data object, so the label and the
 * applier are separate names: `fLabel` and `f`.
 */
export const fLabel: KLabel = klabel("f");
export const gLabel: KLabel = klabel("g");
export const hLabel: KLabel = klabel("h");
export const kLabel: KLabel = klabel("<k>");

export const f = (...args: readonly KInner[]): KApply => kapply(fLabel, args);
export const g = (...args: readonly KInner[]): KApply => kapply(gLabel, args);
export const h = (...args: readonly KInner[]): KApply => kapply(hLabel, args);
export const k = (...args: readonly KInner[]): KApply => kapply(kLabel, args);

//////////////////////
// Assertions       //
//////////////////////

/**
 * Assert two terms are the same term, twice over.
 *
 * `toEqual` gives a readable structural diff on failure; `eq` is the algebra's
 * own notion of equality, which is what pyk's `assert actual == expected`
 * actually tests.  Asserting both means every table in this suite also
 * exercises `eq`.  Not for very deep terms — `toEqual` recurses.
 */
export function expectTerm(actual: KInner, expected: KInner): void {
  expect(actual).toEqual(expected);
  expect(eq(actual, expected)).toBe(true);
}

/** {@link expectTerm} over a list, length first so a mismatch reports usefully. */
export function expectTerms(actual: readonly KInner[], expected: readonly KInner[]): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((term, i) => {
    const want = expected[i];
    expect(want).toBeDefined();
    if (want !== undefined) expectTerm(term, want);
  });
}

//////////////////////////////////////////////////////////
// The prelude, as `utils.py` imports it                 //
//////////////////////////////////////////////////////////

export { GENERATED_TOP_CELL, K, K_ITEM } from "../src/prelude/k.ts";
export { BOOL, FALSE, TRUE } from "../src/prelude/kbool.ts";
export { INT, geInt, intToken, ltInt } from "../src/prelude/kint.ts";
export { mlAnd, mlBottom, mlEquals, mlEqualsFalse, mlEqualsTrue, mlOr, mlTop } from "../src/prelude/ml.ts";
export { STRING, stringToken } from "../src/prelude/string.ts";

/** `utils.py:24-29`. */
export function ltMl(variable: string, n: number): KApply {
  return mlEqualsTrue(ltInt(kvariable(variable), intToken(n)));
}

export function geMl(variable: string, n: number): KApply {
  return mlEqualsTrue(geInt(kvariable(variable), intToken(n)));
}
