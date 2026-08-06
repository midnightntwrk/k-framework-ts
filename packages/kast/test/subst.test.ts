/**
 * Transcribed from `pyk/src/tests/unit/kast/test_subst.py` at K v7.1.337.
 *
 * pyk collects 47 cases there.  35 are transcribed below (compose 11, union 7,
 * apply 7, unapply 7, `from_pred` 3); the other 12 —
 * `test_extract_subst` (11) and `test_propagate_subst` (1) — test
 * `manip.extract_subst`, and are transcribed at the bottom of
 * `test/manip.test.ts` with the rest of that module's tables.
 */

import { describe, expect, test } from "bun:test";
import { Subst, kapply, ktoken, kvariable, type KInner } from "../src/inner.ts";
import {
  INT,
  a,
  b,
  c,
  expectTerm,
  f,
  g,
  h,
  intToken,
  mlAnd,
  mlEquals,
  mlEqualsTrue,
  mlOr,
  x,
  y,
  z,
} from "./helpers.ts";

/** A `Subst` as a plain record, which is what pyk's `dict(subst)` produces. */
type Bindings = Readonly<Record<string, KInner>>;

/////////////////////////////////////////
// COMPOSE_TEST_DATA (test_subst.py:22) //
/////////////////////////////////////////

const COMPOSE_TEST_DATA: readonly (readonly [Bindings, Bindings, Bindings])[] = [
  [{}, {}, {}],
  [{ x }, {}, {}],
  [{}, { x }, {}],
  [{ x: y }, {}, { x: y }],
  [{}, { x: y }, { x: y }],
  [{ y: x }, { x: y }, { y: x }],
  [{ x: z }, { x: y }, { x: y }],
  [{ y: z }, { x: y }, { x: z, y: z }],
  [{ x: y }, { x: f(x) }, { x: f(y) }],
  [{ x: f(x) }, { x: f(x) }, { x: f(f(x)) }],
  [{ y: f(z) }, { x: f(y) }, { x: f(f(z)), y: f(z) }],
];

describe("Subst.compose", () => {
  COMPOSE_TEST_DATA.forEach(([subst1, subst2, expected], i) => {
    test(String(i), () => {
      expect(new Subst(subst1).compose(new Subst(subst2)).minimize().toRecord()).toEqual(expected);
    });
  });
});

///////////////////////////////////////
// UNION_TEST_DATA (test_subst.py:47) //
///////////////////////////////////////

const UNION_TEST_DATA: readonly (readonly [Bindings, Bindings, Bindings | null])[] = [
  [{}, {}, {}],
  [{ x }, {}, { x }],
  [{}, { x }, { x }],
  [{ x, y }, { x }, { x, y }],
  [{ x, y }, { z }, { x, y, z }],
  [{ x }, { x: y }, null],
  [{ x, y }, { x: y }, null],
];

describe("Subst.union", () => {
  UNION_TEST_DATA.forEach(([subst1, subst2, expected], i) => {
    test(String(i), () => {
      const actual = new Subst(subst1).union(new Subst(subst2));
      if (expected === null) expect(actual).toBeNull();
      else expect(actual?.toRecord()).toEqual(expected);
    });
  });
});

///////////////////////////////////////
// APPLY_TEST_DATA (test_subst.py:71) //
///////////////////////////////////////

const APPLY_TEST_DATA: readonly (readonly [KInner, Bindings, KInner])[] = [
  [a, {}, a],
  [x, {}, x],
  [a, { x: b }, a],
  [x, { x: a }, a],
  [f(x), { x: f(x) }, f(f(x))],
  [f(a, g(x, a)), { x: b }, f(a, g(b, a))],
  [f(g(h(x, y, z))), { x: a, y: b, z: c }, f(g(h(a, b, c)))],
];

describe("Subst.apply", () => {
  APPLY_TEST_DATA.forEach(([pattern, subst, expected], i) => {
    test(String(i), () => {
      expectTerm(new Subst(subst).apply(pattern), expected);
    });
  });
});

/////////////////////////////////////////
// UNAPPLY_TEST_DATA (test_subst.py:89) //
/////////////////////////////////////////

const UNAPPLY_TEST_DATA: readonly (readonly [KInner, Bindings, KInner])[] = [
  [a, {}, a],
  [a, { x: a }, x],
  [y, { x: y }, x],
  [f(a), { x: f(a) }, x],
  [f(f(a)), { x: f(a) }, f(x)],
  [f(x), { x: f(a) }, f(x)],
  [f(x), { x: f(x) }, x],
];

describe("Subst.unapply", () => {
  UNAPPLY_TEST_DATA.forEach(([term, subst, expected], i) => {
    test(String(i), () => {
      expectTerm(new Subst(subst).unapply(term), expected);
    });
  });
});

///////////////////////////////////////////////////
// ML_SUBST_FROM_PRED_TEST_DATA (test_subst.py:165)//
///////////////////////////////////////////////////

const ML_SUBST_FROM_PRED_TEST_DATA: readonly (readonly [string, KInner, Bindings | null])[] = [
  [
    "positive",
    mlAnd([mlEquals(kvariable("X"), intToken(1), INT), mlEquals(kvariable("Y"), intToken(2), INT)]),
    { X: intToken(1), Y: intToken(2) },
  ],
  [
    "wrong-connective",
    mlOr([mlEquals(kvariable("X"), intToken(1), INT), mlEquals(kvariable("Y"), intToken(2), INT)]),
    null,
  ],
  [
    "not-subst",
    mlAnd([
      mlEquals(kvariable("X"), intToken(1), INT),
      mlEquals(kvariable("Y"), intToken(2), INT),
      mlEqualsTrue(kapply("_==K_", [kvariable("Y"), intToken(2)])),
    ]),
    null,
  ],
];

describe("Subst.fromPred", () => {
  for (const [id, pred, expected] of ML_SUBST_FROM_PRED_TEST_DATA) {
    test(id, () => {
      if (expected === null) expect(() => Subst.fromPred(pred)).toThrow();
      else expect(Subst.fromPred(pred).toRecord()).toEqual(expected);
    });
  }
});

///////////////////////////////////////////////////////
// Not upstream: `Subst.pred` has no test in pyk at all //
///////////////////////////////////////////////////////

describe("Subst.pred", () => {
  test("an empty substitution is true:Bool", () => {
    // `inner.py:762-763`.
    expectTerm(new Subst().pred, ktoken("true", "Bool"));
  });

  test("identity bindings are dropped", () => {
    expectTerm(new Subst({ x }).pred, new Subst().pred);
  });

  test("conjuncts are joined left-nested by _andBool_", () => {
    // `reduce(KLabel('_andBool_'), conjuncts)` with no initial value
    // (`inner.py:765`) is a left fold.
    const subst = new Subst({ x: a, y: b, z: c });
    expectTerm(
      subst.pred,
      kapply("_andBool_", [
        kapply("_andBool_", [kapply("_==K_", [x, a]), kapply("_==K_", [y, b])]),
        kapply("_==K_", [z, c]),
      ]),
    );
  });
});

describe("Subst.minimize and isIdentity", () => {
  test("identity bindings only", () => {
    expect(new Subst({ x, y }).isIdentity).toBe(true);
    expect(new Subst({ x: a }).isIdentity).toBe(false);
    expect(new Subst({ x, y: a }).minimize().toRecord()).toEqual({ y: a });
  });
});
