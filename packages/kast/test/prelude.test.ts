/**
 * Behaviour of `src/prelude/` — the shapes the constructors fold into, and the
 * quirks worth pinning by name.
 *
 * `test/prelude-parity.test.ts` already pins one sample of every constructor
 * against pyk's own `to_dict`; this file covers the *decisions* — fold arity,
 * unit filtering, deduplication, `weak` mode, dispatch, round-trips — where a
 * single sample proves nothing.
 *
 * The `bytesToken` table is transcribed from `KBYTES_TEST_DATA` in
 * `wasm-semantics/pykwasm/src/tests/unit/test_kwasm_ast.py` (NCSA; see
 * `THIRD-PARTY-NOTICES.md`).
 */

import { describe, expect, test } from "bun:test";
import { eq } from "../src/eq.ts";
import { kapply, klabel, ksort, ktoken, kvariable, type KInner } from "../src/inner.ts";
import { BYTES, bytesToken, bytesTokenFromStr, prettyBytes, prettyBytesStr } from "../src/prelude/bytes.ts";
import {
  listEmpty,
  listItem,
  listOf,
  mapEmpty,
  mapItem,
  mapOf,
  rangemapEmpty,
  rangemapItem,
  rangemapOf,
  setEmpty,
  setItem,
  setOf,
} from "../src/prelude/collections.ts";
import { DOTS, GENERATED_TOP_CELL, K, K_ITEM, inj } from "../src/prelude/k.ts";
import { BOOL, FALSE, TRUE, andBool, boolToken, impliesBool, notBool, orBool } from "../src/prelude/kbool.ts";
import { INT, intToken } from "../src/prelude/kint.ts";
import { isBottom, isTop, mlAnd, mlBottom, mlEquals, mlNot, mlOr, mlTop } from "../src/prelude/ml.ts";
import { STRING, prettyString, stringToken } from "../src/prelude/string.ts";
import { token } from "../src/prelude/utils.ts";
// oxlint-disable-next-line import/max-dependencies -- one test file per prelude module would fragment the story
import { a, b, c, expectTerm, x } from "./helpers.ts";

//////////////////////
// k.ts             //
//////////////////////

describe("k", () => {
  test("the three sorts are the bare KAST v4 sorts", () => {
    expect(K).toEqual(ksort("K"));
    expect(K_ITEM).toEqual(ksort("KItem"));
    expect(GENERATED_TOP_CELL).toEqual(ksort("GeneratedTopCell"));
  });

  test("DOTS is a K token, not a label", () => {
    expectTerm(DOTS, ktoken("...", K));
  });

  test("inj carries both sorts as label parameters", () => {
    const term = inj(INT, K_ITEM, x);
    expectTerm(term, kapply(klabel("inj", [INT, K_ITEM]), [x]));
    expect(term.label.params).toEqual([INT, K_ITEM]);
    expect(term.args).toHaveLength(1);
  });
});

//////////////////////
// kbool.ts         //
//////////////////////

describe("kbool", () => {
  test("TRUE and FALSE are Bool tokens defined here, not imported from outer", () => {
    expectTerm(TRUE, ktoken("true", ksort("Bool")));
    expectTerm(FALSE, ktoken("false", ksort("Bool")));
    expect(BOOL).toEqual(ksort("Bool"));
  });

  test("boolToken maps to the two constants", () => {
    expect(boolToken(true)).toBe(TRUE);
    expect(boolToken(false)).toBe(FALSE);
  });

  test("andBool folds right, unit is TRUE", () => {
    expectTerm(andBool([]), TRUE);
    expectTerm(andBool([a]), a);
    expectTerm(andBool([a, b]), kapply("_andBool_", [a, b]));
    expectTerm(andBool([a, b, c]), kapply("_andBool_", [a, kapply("_andBool_", [b, c])]));
  });

  test("andBool drops duplicates, keeping the first occurrence", () => {
    // `unique(items)` (`kbool.py:26` with `utils.py:277-284`) runs *before* the
    // fold, so `[a, b, a]` is `[a, b]` and not `a and b and a`.
    expectTerm(andBool([a, b, a]), andBool([a, b]));
    expectTerm(andBool([a, a, a]), a);
    expectTerm(andBool([a, b, a, c, b]), andBool([a, b, c]));
  });

  test("andBool drops TRUE conjuncts, and collapses to TRUE when all are", () => {
    expectTerm(andBool([a, TRUE, b]), andBool([a, b]));
    expectTerm(andBool([TRUE, TRUE]), TRUE);
    expectTerm(andBool([TRUE]), TRUE);
  });

  test("orBool is the same fold with FALSE as unit", () => {
    expectTerm(orBool([]), FALSE);
    expectTerm(orBool([a]), a);
    expectTerm(orBool([a, b, c]), kapply("_orBool_", [a, kapply("_orBool_", [b, c])]));
    expectTerm(orBool([a, b, a]), orBool([a, b]));
    expectTerm(orBool([a, FALSE, b]), orBool([a, b]));
    expectTerm(orBool([FALSE, FALSE]), FALSE);
  });

  test("orBool does not treat TRUE as its unit (nor andBool FALSE)", () => {
    expectTerm(orBool([a, TRUE]), kapply("_orBool_", [a, TRUE]));
    expectTerm(andBool([a, FALSE]), kapply("_andBool_", [a, FALSE]));
  });

  test("notBool and impliesBool are plain applications", () => {
    expectTerm(notBool(a), kapply("notBool_", [a]));
    expectTerm(impliesBool(a, b), kapply("_impliesBool_", [a, b]));
  });
});

//////////////////////
// kint.ts          //
//////////////////////

describe("kint", () => {
  test("intToken writes the decimal expansion of a big integer", () => {
    // Past 2^53 a `number` cannot even hold the value, which is why `bigint` is
    // the primary input type.
    expect(intToken(2n ** 256n).token).toBe(
      "115792089237316195423570985008687907853269984665640564039457584007913129639936",
    );
    expect(intToken(-(2n ** 64n)).token).toBe("-18446744073709551616");
    expect(intToken(2n ** 256n).sort).toEqual(INT);
  });

  test("intToken accepts a number, but only an integral one", () => {
    expect(intToken(42).token).toBe("42");
    expect(intToken(-0).token).toBe("0");
    // `String(1e21)` is `"1e+21"`; going through `BigInt` keeps K's spelling.
    expect(intToken(1e21).token).toBe("1000000000000000000000");
    expect(() => intToken(1.5)).toThrow(RangeError);
    expect(() => intToken(Number.NaN)).toThrow(RangeError);
  });
});

//////////////////////
// ml.ts            //
//////////////////////

describe("ml", () => {
  test("isTop and isBottom ignore the sort parameter", () => {
    expect(isTop(mlTop())).toBe(true);
    expect(isTop(mlTop(K))).toBe(true);
    expect(isTop(mlBottom())).toBe(false);
    expect(isBottom(mlBottom(INT))).toBe(true);
    expect(isBottom(a)).toBe(false);
  });

  test("without weak, a conjunction of tops is not top", () => {
    const conjunction = kapply(klabel("#And", [GENERATED_TOP_CELL]), [mlTop(), mlTop()]);
    expect(isTop(conjunction)).toBe(false);
    expect(isTop(conjunction, { weak: true })).toBe(true);
  });

  test("weak isTop needs every conjunct top, at any nesting", () => {
    const nested = kapply(klabel("#And", [K]), [mlTop(), kapply(klabel("#And", [K]), [mlTop(), mlTop(INT)])]);
    expect(isTop(nested, { weak: true })).toBe(true);
    expect(isTop(kapply(klabel("#And", [K]), [mlTop(), a]), { weak: true })).toBe(false);
  });

  test("weak isBottom needs only one bottom conjunct — and still flattens #And", () => {
    // `ml.py:41` flattens `'#And'` in *both* predicates; a disjunction is not
    // looked into.
    const conjunction = kapply(klabel("#And", [K]), [a, mlBottom(), b]);
    expect(isBottom(conjunction, { weak: true })).toBe(true);
    expect(isBottom(conjunction)).toBe(false);
    const disjunction = kapply(klabel("#Or", [K]), [a, mlBottom()]);
    expect(isBottom(disjunction, { weak: true })).toBe(false);
  });

  test("weak on a non-#And term is the same answer as without it", () => {
    // A term that is not a `#And` flattens to itself, and `ml.py:28` then
    // recurses *without* `weak`.
    expect(isTop(a, { weak: true })).toBe(false);
    expect(isTop(mlTop(), { weak: true })).toBe(true);
    expect(isBottom(a, { weak: true })).toBe(false);
  });

  test("a zero-argument #And is vacuously top and not bottom", () => {
    // `flattenLabel` gives `[]`, and `[].every(…)` is `true` while
    // `[].some(…)` is `false` — pyk's `all`/`any` on an empty generator.
    const empty = kapply(klabel("#And", [K]));
    expect(isTop(empty, { weak: true })).toBe(true);
    expect(isBottom(empty, { weak: true })).toBe(false);
  });

  test("mlAnd folds right and filters #Top at every arity", () => {
    const and = klabel("#And", [GENERATED_TOP_CELL]);
    expectTerm(mlAnd([]), mlTop());
    expectTerm(mlAnd([a]), a);
    expectTerm(mlAnd([a, b]), kapply(and, [a, b]));
    expectTerm(mlAnd([a, b, c]), kapply(and, [a, kapply(and, [b, c])]));
    expectTerm(mlAnd([a, b, c, x]), kapply(and, [a, kapply(and, [b, kapply(and, [c, x])])]));
    expectTerm(mlAnd([a, mlTop(), b]), kapply(and, [a, b]));
    expectTerm(mlAnd([mlTop(), mlTop()]), mlTop());
  });

  test("mlAnd's filter is wider than buildAssoc's unit check", () => {
    // The filter (`ml.py:77`) drops `#Top{S}` for any `S`; `buildAssoc` would
    // only drop one equal to the unit `#Top{GeneratedTopCell}`.
    expectTerm(mlAnd([a, mlTop(K)]), a);
    expectTerm(mlAnd([a, mlTop()], K), a);
  });

  test("mlAnd keeps duplicates — unlike andBool", () => {
    expectTerm(mlAnd([a, a]), kapply(klabel("#And", [GENERATED_TOP_CELL]), [a, a]));
  });

  test("mlOr folds right and filters #Bottom at every arity", () => {
    const or = klabel("#Or", [GENERATED_TOP_CELL]);
    expectTerm(mlOr([]), mlBottom());
    expectTerm(mlOr([a]), a);
    expectTerm(mlOr([a, b]), kapply(or, [a, b]));
    expectTerm(mlOr([a, b, c]), kapply(or, [a, kapply(or, [b, c])]));
    expectTerm(mlOr([a, b, c, x]), kapply(or, [a, kapply(or, [b, kapply(or, [c, x])])]));
    expectTerm(mlOr([a, mlBottom(), b]), kapply(or, [a, b]));
    expectTerm(mlOr([mlBottom(), mlBottom(K)]), mlBottom());
  });

  test("the sort argument may be a string or a KSort", () => {
    expect(eq(mlTop("K"), mlTop(K))).toBe(true);
    expect(eq(mlEquals(x, a, "Int", "K"), mlEquals(x, a, INT, K))).toBe(true);
  });

  test("mlEquals puts the constant first for the True/False variants", () => {
    // `mlEqualsTrue(t)` is `#Equals(true, t)`, not `#Equals(t, true)`
    // (`ml.py:57`).
    const [first] = mlEquals(TRUE, a, BOOL).args;
    expect(first).toEqual(TRUE);
  });

  test("mlNot is unary at the given sort", () => {
    expectTerm(mlNot(a, K), kapply(klabel("#Not", [K]), [a]));
  });
});

//////////////////////
// string.ts        //
//////////////////////

describe("string", () => {
  const ROUND_TRIP = [
    "",
    "hello",
    'a"b',
    "a\\b",
    "tab\there",
    "line\nbreak",
    "héllo ☃ \u{1D11E}",
    "\u0000\u001F\u007F",
  ];

  test("stringToken quotes and escapes; prettyString inverts it", () => {
    for (const value of ROUND_TRIP) {
      const term = stringToken(value);
      expect(term.sort).toEqual(STRING);
      expect(term.token.startsWith('"')).toBe(true);
      expect(term.token.endsWith('"')).toBe(true);
      expect(prettyString(term)).toBe(value);
    }
  });

  test("the token text is the K literal, escapes and all", () => {
    expect(stringToken("hello").token).toBe('"hello"');
    expect(stringToken('a"b').token).toBe('"a\\"b"');
    expect(stringToken("\t").token).toBe('"\\t"');
    expect(stringToken("☃").token).toBe('"\\u2603"');
  });

  test("prettyString rejects the wrong sort and an unquoted token", () => {
    expect(() => prettyString(ktoken('"a"', INT))).toThrow(TypeError);
    expect(() => prettyString(ktoken("a", STRING))).toThrow(TypeError);
    expect(() => prettyString(ktoken('"', STRING))).toThrow(TypeError);
  });
});

//////////////////////
// bytes.ts         //
//////////////////////

/** `KBYTES_TEST_DATA` (`test_kwasm_ast.py:5-16`). */
const KBYTES_TEST_DATA: readonly (readonly [string, Uint8Array, string])[] = [
  ["binary", new Uint8Array([0x0, 0x41, 0xff]), 'b"\\x00A\\xff"'],
  ["empty", new Uint8Array([]), 'b""'],
  ["WASM", new Uint8Array([0x57, 0x41, 0x53, 0x4d]), 'b"WASM"'],
  [
    "foo-high-then-low",
    new Uint8Array([0x66, 0x6f, 0x6f, 0xaa, 0x01, 0x62, 0x61, 0x72, 0x62, 0x61, 0x7a]),
    'b"foo\\xaa\\x01barbaz"',
  ],
  [
    "foo-split",
    new Uint8Array([0x66, 0x6f, 0x6f, 0xaa, 0x62, 0x61, 0x72, 0x01, 0x62, 0x61, 0x7a]),
    'b"foo\\xaabar\\x01baz"',
  ],
  ["alphabet", new Uint8Array(Array.from({ length: 26 }, (_, i) => 0x61 + i)), 'b"abcdefghijklmnopqrstuvwxyz"'],
  [
    // `0x11223344556677889900AABBCCDDEEFF` big-endian: 0x22 is `"` and must be
    // escaped, 0x33-0x77 are printable, the rest are `\xNN`.
    "16-byte-word",
    new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0x00, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]),
    'b"\\x11\\"3DUfw\\x88\\x99\\x00\\xaa\\xbb\\xcc\\xdd\\xee\\xff"',
  ],
];

describe("bytes", () => {
  for (const [id, value, expected] of KBYTES_TEST_DATA) {
    test(`bytesToken ${id}`, () => {
      const term = bytesToken(value);
      expect(term.token).toBe(expected);
      expect(term.sort.name).toBe("Bytes");
    });
  }

  test("prettyBytes inverts bytesToken", () => {
    for (const [, value] of KBYTES_TEST_DATA) {
      expect(prettyBytes(bytesToken(value))).toEqual(value);
    }
  });

  test("prettyBytesStr gives the latin-1 string bytesTokenFromStr took", () => {
    const pretty = "foo\u00AA\u0001bar";
    expect(prettyBytesStr(bytesTokenFromStr(pretty))).toBe(pretty);
    expect(bytesTokenFromStr(pretty)).toEqual(bytesToken(prettyBytes(bytesTokenFromStr(pretty))));
  });

  test("a byte value above latin-1 is not a Bytes token", () => {
    expect(() => bytesTokenFromStr("☃")).toThrow();
  });

  test("prettyBytesStr rejects the wrong sort and a malformed token", () => {
    expect(() => prettyBytesStr(ktoken('b""', STRING))).toThrow(TypeError);
    expect(() => prettyBytesStr(ktoken('"ab"', BYTES))).toThrow(TypeError);
    expect(() => prettyBytesStr(ktoken('b"', BYTES))).toThrow(TypeError);
  });
});

//////////////////////
// collections.ts   //
//////////////////////

describe("collections", () => {
  test("the *Of builders fold right and unit-collapse", () => {
    expectTerm(setOf([]), setEmpty());
    expectTerm(setOf([a]), setItem(a));
    expectTerm(setOf([a, b]), kapply("_Set_", [setItem(a), setItem(b)]));
    expectTerm(listOf([]), listEmpty());
    expectTerm(listOf([a, b]), kapply("_List_", [listItem(a), listItem(b)]));
    expectTerm(mapOf([]), mapEmpty());
    expectTerm(
      mapOf([
        [a, b],
        [b, c],
      ]),
      kapply("_Map_", [mapItem(a, b), mapItem(b, c)]),
    );
    expectTerm(rangemapOf([]), rangemapEmpty());
  });

  test("setOf keeps duplicate items", () => {
    expectTerm(setOf([a, a]), kapply("_Set_", [setItem(a), setItem(a)]));
  });

  test("mapOf deduplicates keys structurally, last value winning at the first position", () => {
    // pyk builds a `dict` first (`collections.py:53`), which keys on the
    // frozen dataclass's structural hash — two distinct-but-equal key objects
    // are one entry.
    const key = kapply("a");
    expectTerm(
      mapOf([
        [key, b],
        [b, b],
        [kapply("a"), c],
      ]),
      kapply("_Map_", [mapItem(a, c), mapItem(b, b)]),
    );
  });

  test("rangemapItem wraps the bounds in RangeMap:Range", () => {
    expectTerm(
      rangemapItem([intToken(1), intToken(2)], a),
      kapply("_r|->_", [kapply("RangeMap:Range", [intToken(1), intToken(2)]), a]),
    );
  });

  test("rangemapOf deduplicates on the whole range", () => {
    const one = intToken(1);
    const two = intToken(2);
    const three = intToken(3);
    expectTerm(
      rangemapOf([
        [[one, two], a],
        [[two, three], b],
        [[one, two], c],
      ]),
      kapply("_RangeMap_", [rangemapItem([one, two], c), rangemapItem([two, three], b)]),
    );
  });
});

//////////////////////
// utils.ts         //
//////////////////////

describe("token", () => {
  test("dispatches on the host type", () => {
    expectTerm(token(true), TRUE);
    expectTerm(token(false), FALSE);
    expectTerm(token(7), ktoken("7", INT));
    expectTerm(token(-7n), ktoken("-7", INT));
    expectTerm(token("a"), ktoken('"a"', STRING));
    expectTerm(token(new Uint8Array([0x00, 0xff])), ktoken('b"\\x00\\xff"', BYTES));
  });

  test("a boolean is a Bool, never an Int", () => {
    // pyk has to test `bool` before `int` (`utils.py:15-18`) because Python's
    // `bool` subclasses `int`; the mapping this pins is the same either way.
    expect(token(true).sort).toEqual(BOOL);
    expect(token(1).sort).toEqual(INT);
  });

  test("a big integer keeps full precision", () => {
    expect(token(2n ** 128n).token).toBe("340282366920938463463374607431768211456");
  });

  test("a Uint8Array subclass is still Bytes", () => {
    expect(token(Buffer.from([0x41])).token).toBe('b"A"');
  });

  test("anything else throws", () => {
    // The signature already rules these out; the guard is for JS callers, so
    // the call has to go around the type system to be reached at all.
    for (const value of [null, undefined, {}, []]) {
      expect(() => {
        Reflect.apply(token, undefined, [value]);
      }).toThrow(TypeError);
    }
  });
});

//////////////////////
// helpers          //
//////////////////////

describe("the test vocabulary reads the real prelude", () => {
  test("variables and terms compose as before", () => {
    const term: KInner = mlEquals(kvariable("X"), intToken(1), INT);
    expect(term.node).toBe("KApply");
    expect(eq(term, mlEquals(kvariable("X"), ktoken("1", ksort("Int")), ksort("Int")))).toBe(true);
  });
});
