/**
 * Transcribed from `pyk/src/tests/unit/kast/test_kast.py` at K v7.1.337.
 *
 * pyk collects 79 cases there.  36 are transcribed below; the other 43 do not
 * exist for this package, in two groups:
 *
 * - **21 varargs rows** — `test_klabel_init_multiple_values`,
 *   `test_klabel_init_unkown_keyword`, and the `KApply` / `KSequence` pairs of
 *   the same.  Every one of them asserts the exact `TypeError` message that
 *   `KLabel('f', *params, params=params)` produces, i.e. it tests the
 *   `isinstance`-sniffing constructor overloads (`inner.py:63-93`, `364-390`,
 *   `581-611`) that this package deliberately does not have: our constructors
 *   take an array and TypeScript rejects the other spellings at compile time.
 *   The surviving `*_init` rows are transcribed in full.
 * - **22 outer rows** — `test_defn_module_names` (1),
 *   `test_production_is_prefix` (11) and `test_default_format` (10) need
 *   `KDefinition` / `KProduction` / `Format`, which arrived with the outer
 *   layer.  They are **transcribed in
 *   `test/outer.test.ts`**, beside the rest of that layer's tables, rather
 *   than here.
 */

import { describe, expect, test } from "bun:test";
import { compare, lt } from "../src/eq.ts";
import {
  buildAssoc,
  kapply,
  klabel,
  ksequence,
  ksort,
  ktoken,
  kvariable,
  letKVariable,
  type KInner,
  type KSort,
} from "../src/inner.ts";
import { fromDict, toDict, type JsonObject } from "../src/json.ts";
import { BOOL, INT, STRING, expectTerm, fLabel, x, y, z } from "./helpers.ts";

//////////////////////////////////////////
// KVARIABLE_TEST_DATA (test_kast.py:24) //
//////////////////////////////////////////

const KVARIABLE_TEST_DATA: readonly (readonly [string, KInner, JsonObject])[] = [
  ["no-sort", kvariable("Foo"), { node: "KVariable", name: "Foo" }],
  [
    "sort",
    kvariable("Foo", ksort("Int")),
    { node: "KVariable", name: "Foo", sort: { node: "KSort", name: "Int", params: [] } },
  ],
];

describe("kvariable to_dict", () => {
  for (const [id, variable, dct] of KVARIABLE_TEST_DATA) {
    test(id, () => {
      expectTerm(fromDict(dct), variable);
      expect(toDict(variable)).toEqual(dct);
    });
  }
});

//////////////////////////////////////////////
// KVARIABLE_LET_TEST_DATA (test_kast.py:52) //
//////////////////////////////////////////////

const KVARIABLE_LET_TEST_DATA: readonly (readonly [string, KInner, KInner])[] = [
  ["let-changes-sort", letKVariable(kvariable("Foo", STRING), { sort: INT }), kvariable("Foo", INT)],
  ["let-can-set-sort", letKVariable(kvariable("Foo"), { sort: STRING }), kvariable("Foo", STRING)],
];

describe("kvariable let", () => {
  for (const [id, variable, expected] of KVARIABLE_LET_TEST_DATA) {
    test(id, () => {
      expectTerm(variable, expected);
      // pyk's own assertion is the round trip, not the `let` result.
      expectTerm(fromDict(toDict(variable)), expected);
    });
  }

  // Not upstream: pyk needed a separate `KVariable.let_sort` (`inner.py:340`)
  // because `let(sort=None)` means "keep".  Here the changes object is read
  // with `Object.hasOwn`, so one function both sets and clears.
  test("let-can-clear-sort", () => {
    expectTerm(letKVariable(kvariable("Foo", STRING), { sort: undefined }), kvariable("Foo"));
  });
});

////////////////////////////////////////
// KLABEL_TEST_DATA (test_kast.py:73)  //
////////////////////////////////////////

const KLABEL_TEST_DATA: readonly (readonly KSort[])[] = [[], [BOOL], [BOOL, INT], [BOOL, INT, STRING]];

describe("klabel init", () => {
  KLABEL_TEST_DATA.forEach((params, i) => {
    test(String(i), () => {
      const label = klabel("f", params);
      expect(label.name).toBe("f");
      expect(label.params).toEqual(params);
    });
  });

  // Not upstream: the one piece of pyk's constructor sniffing that *is* term
  // algebra rather than Python affordance — a `str` parameter is a sort name
  // (`inner.py:91`).
  test("string params are coerced to sorts", () => {
    expect(klabel("f", ["Bool", INT]).params).toEqual([BOOL, INT]);
  });
});

////////////////////////////////////////
// KAPPLY_TEST_DATA (test_kast.py:126) //
////////////////////////////////////////

const KAPPLY_TEST_DATA: readonly (readonly KInner[])[] = [[], [x], [x, y], [x, y, z]];

describe("kapply init", () => {
  KAPPLY_TEST_DATA.forEach((args, i) => {
    test(String(i), () => {
      const term = kapply("f", args);
      expect(term.label).toEqual(klabel("f"));
      expect(term.args).toEqual(args);
    });
  });

  test("a KLabel may be passed instead of a name", () => {
    expectTerm(kapply(fLabel, [x]), kapply("f", [x]));
  });
});

///////////////////////////////////////////
// KSEQUENCE_TEST_DATA (test_kast.py:176) //
///////////////////////////////////////////

const KSEQUENCE_TEST_DATA: readonly (readonly KInner[])[] = [[], [x], [x, y], [x, y, z]];

describe("ksequence init", () => {
  KSEQUENCE_TEST_DATA.forEach((items, i) => {
    test(String(i), () => {
      expect(ksequence(items).items).toEqual(items);
    });
  });
});

/////////////////////////////////////////////
// BUILD_ASSOC_TEST_DATA (test_kast.py:246) //
/////////////////////////////////////////////

/**
 * `_0 = token('0')`, and `token` dispatches on the Python type: `'0'` is a
 * `str`, so this is `stringToken('0')` — a **String** token whose text
 * includes the quotes (`prelude/string.py:10`), not an `Int` token.
 */
const zeroToken = ktoken('"0"', STRING);

const BUILD_ASSOC_TEST_DATA: readonly (readonly [readonly KInner[], KInner])[] = [
  [[zeroToken], zeroToken],
  [[x], x],
  [[x, zeroToken], x],
  [[zeroToken, x], x],
  [[x, y], kapply(fLabel, [x, y])],
  [[zeroToken, x, y], kapply(fLabel, [x, y])],
  [[x, zeroToken, y], kapply(fLabel, [x, y])],
  [[x, y, zeroToken], kapply(fLabel, [x, y])],
  [[x, y, z], kapply(fLabel, [x, kapply(fLabel, [y, z])])],
  [[zeroToken, x, y, z], kapply(fLabel, [x, kapply(fLabel, [y, z])])],
  [[x, zeroToken, y, z], kapply(fLabel, [x, kapply(fLabel, [y, z])])],
  [[x, y, zeroToken, z], kapply(fLabel, [x, kapply(fLabel, [y, z])])],
  [[x, y, z, zeroToken], kapply(fLabel, [x, kapply(fLabel, [y, z])])],
  [[zeroToken, x, zeroToken, y, zeroToken, z, zeroToken], kapply(fLabel, [x, kapply(fLabel, [y, z])])],
];

describe("buildAssoc", () => {
  BUILD_ASSOC_TEST_DATA.forEach(([items, expected], i) => {
    test(String(i), () => {
      expectTerm(buildAssoc(zeroToken, fLabel, items), expected);
    });
  });
});

//////////////////////////////////////////////
// KAST_COMPARE_TEST_DATA (test_kast.py:274) //
//////////////////////////////////////////////

const KAST_COMPARE_TEST_DATA: readonly (readonly [KInner, KInner, boolean])[] = [
  [kvariable("X", ksort("Int")), kvariable("X", ksort("Int")), false],
  [kvariable("X", ksort("Int")), kvariable("X"), false],
  [kvariable("X"), kvariable("X", ksort("Int")), true],
  [kvariable("X", ksort("Int")), kvariable("Y", ksort("Int")), true],
  [kvariable("X", ksort("Int")), kvariable("Y"), true],
  [kvariable("X"), kvariable("Y", ksort("Int")), true],
];

describe("total ordering", () => {
  KAST_COMPARE_TEST_DATA.forEach(([left, right, expected], i) => {
    test(String(i), () => {
      expect(lt(left, right)).toBe(expected);
    });
  });

  /**
   * Not upstream, and the one place we knowingly differ: pyk's
   * `KVariable.__lt__` answers `self.sort is None`, so two *equal* unsorted
   * variables compare `True` in both directions (`inner.py:310-317`).  A
   * three-way comparator cannot express that, so equal terms compare `0`.
   */
  test("equal unsorted variables compare equal, where pyk's `<` says True both ways", () => {
    expect(compare(kvariable("X"), kvariable("X"))).toBe(0);
  });

  /**
   * Not upstream: `kast.py:42` falls back to comparing *class names* when the
   * node kinds differ, and our `node` tags are exactly those class names.
   */
  test("different node kinds order by class name", () => {
    // KApply < KAs < KRewrite < KSequence < KToken < KVariable, whatever the
    // fields say: `kapply("z")` still precedes `kvariable("a")`.
    expect(compare(kapply("z"), kvariable("a"))).toBe(-1);
    expect(compare(ksequence([]), ktoken("t", INT))).toBe(-1);
    expect(compare(ktoken("t", INT), ksequence([]))).toBe(1);
  });
});
