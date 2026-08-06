/**
 * Transcribed from `pyk/src/tests/unit/kast/test_match.py` at K v7.1.337 —
 * all 17 cases (14 matching, 3 not).
 *
 * The tables read `(term, pattern)` and the assertion is
 * `pattern.match(term)` — note the swap, which is upstream's and is preserved
 * here so the rows transcribe line for line.
 */

import { describe, expect, test } from "bun:test";
import { kapply, kas, klabel, ksequence, ktoken, kvariable, match, type KInner } from "../src/inner.ts";
import { a, b, c, expectTerm, f, g, h, mlBottom, mlTop, x, y, z } from "./helpers.ts";

/////////////////////////////////////////
// MATCH_TEST_DATA (test_match.py:20)   //
/////////////////////////////////////////

const MATCH_TEST_DATA: readonly (readonly [KInner, KInner])[] = [
  [a, a],
  [a, x],
  [f(a), x],
  [f(a), f(a)],
  [f(a), f(x)],
  [f(a, b), f(x, y)],
  [f(a, b, c), f(x, y, z)],
  [f(g(h(a))), f(x)],
  [f(g(h(x))), f(x)],
  [f(a, g(b, h(c))), f(x, y)],
  [ksequence([a, x]), ksequence([y])],
  [ksequence([a, b, x]), ksequence([a, y])],
  [ksequence([f(a), b, x]), ksequence([f(z), y])],
  [ksequence([f(a), b, c, x]), ksequence([f(z), y])],
];

describe("match and subst", () => {
  MATCH_TEST_DATA.forEach(([term, pattern], i) => {
    test(String(i), () => {
      const subst = match(pattern, term);
      expect(subst).not.toBeNull();
      if (subst === null) return;
      expectTerm(subst.apply(pattern), term);
    });
  });
});

////////////////////////////////////////////
// NO_MATCH_TEST_DATA (test_match.py:47)   //
////////////////////////////////////////////

const NO_MATCH_TEST_DATA: readonly (readonly [KInner, KInner])[] = [
  [f(x, x), f(x, a)],
  [mlTop(), mlBottom()],
  [ksequence([a, b, c]), ksequence([x, x])],
];

describe("no match", () => {
  NO_MATCH_TEST_DATA.forEach(([term, pattern], i) => {
    test(String(i), () => {
      expect(match(pattern, term)).toBeNull();
    });
  });
});

///////////////////////////////////////////////////////
// Not upstream: the four quirks, each as its own row //
///////////////////////////////////////////////////////

describe("pyk match semantics", () => {
  test("a pattern variable ignores its sort", () => {
    // `inner.py:352-353` — `KVariable.match` never inspects the sort.
    const subst = match(kvariable("V", "Int"), kapply("someString"));
    expect(subst?.get("V")).toEqual(kapply("someString"));
  });

  test("KToken compares token text, not sort", () => {
    // `inner.py:287-291` — the branch tests `term.token == self.token` only.
    expect(match(ktoken("1", "Int"), ktoken("1", "String"))).not.toBeNull();
    expect(match(ktoken("1", "Int"), ktoken("2", "Int"))).toBeNull();
  });

  test("KApply compares label.name and arity, not label.params", () => {
    // `inner.py:429` — `term.label.name == self.label.name`, no params.
    const pattern = kapply(klabel("inj", ["A", "B"]), [x]);
    const term = kapply(klabel("inj", ["C", "D"]), [a]);
    expect(match(pattern, term)?.get("x")).toEqual(a);
    // Arity, on the other hand, must agree.
    expect(match(kapply("f", [x]), kapply("f", [a, b]))).toBeNull();
  });

  test("KSequence binds a trailing pattern variable to the remaining tail", () => {
    // `inner.py:649-662`, and the tail is wrapped in a `KSequence`.
    const subst = match(ksequence([a, x]), ksequence([a, b, c]));
    expect(subst?.get("x")).toEqual(ksequence([b, c]));
  });

  test("KAs in pattern position throws", () => {
    // `inner.py:473-474`.
    expect(() => match(kas(x, y), a)).toThrow("KAs does not support pattern matching");
  });

  test("KAs in term position is matched like any other node", () => {
    expect(match(x, kas(a, y))?.get("x")).toEqual(kas(a, y));
  });

  test("conflicting bindings union to null", () => {
    // `inner.py:216-221` — `Subst.union` answers `None`, and `_combine_matches`
    // propagates it.
    expect(match(f(x, x), f(a, b))).toBeNull();
  });
});
