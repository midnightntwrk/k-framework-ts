/**
 * The KAST v4 codec.  Not transcribed from a pyk table — `test_kast.py` covers
 * only the two `KVariable` `to_dict` rows (which live in `kast.test.ts`) — so
 * every case here is written against `inner.py`'s `to_dict` / `from_dict`
 * directly, one named test per documented quirk plus a round-trip sweep.
 */

import { describe, expect, test } from "bun:test";
import { eq, hashOf } from "../src/eq.ts";
import { kapply, kas, klabel, krewrite, ksequence, ksort, ktoken, kvariable, type KInner } from "../src/inner.ts";
import { fromDict, fromJson, kastTerm, kastTermToDict, labelFromDict, sortFromDict, toDict } from "../src/json.ts";
import { INT, STRING, a, b, c, expectTerm, f, g, x, y, z } from "./helpers.ts";

/** Every node kind, plus parametric sorts, parametric labels, and unicode. */
const VOCABULARY: readonly (readonly [string, KInner])[] = [
  ["nullary apply", a],
  ["unsorted variable", x],
  ["sorted variable", kvariable("V", INT)],
  ["token", ktoken("1", INT)],
  ["token with a parametric sort", ktoken("x", ksort("Map", [ksort("Int"), ksort("String")]))],
  ["token with unicode", ktoken('"héllo ☃ 𝄞"', STRING)],
  ["apply with args", f(a, b, c)],
  ["apply with a parametric label", kapply(klabel("inj", [ksort("Int"), ksort("KItem")]), [x])],
  ["nested apply", f(g(x, y), kapply("h", [z]))],
  ["empty sequence", ksequence([])],
  ["sequence", ksequence([a, b, x])],
  ["rewrite", krewrite(f(x), g(y))],
  ["as", kas(f(x), y)],
  ["everything at once", f(ksequence([krewrite(kas(a, x), ktoken("0", INT))]), kvariable("W", ksort("K")))],
];

describe("round trip", () => {
  for (const [id, term] of VOCABULARY) {
    test(id, () => {
      expectTerm(fromDict(toDict(term)), term);
      // Through actual JSON text as well, so nothing survives on object identity.
      expectTerm(fromJson(JSON.stringify(toDict(term))), term);
    });
  }
});

describe("codec details", () => {
  test("KApply emits arity and variable:false", () => {
    // `inner.py:406-413`.  Neither key is read back (`arity` is redundant with
    // `args`, `variable` is pyk-only), but both are emitted so that a `to_dict`
    // here is byte-comparable with a `to_dict` there.
    expect(toDict(f(a, b))).toEqual({
      node: "KApply",
      label: { node: "KLabel", name: "f", params: [] },
      args: [
        { node: "KApply", label: { node: "KLabel", name: "a", params: [] }, args: [], arity: 0, variable: false },
        { node: "KApply", label: { node: "KLabel", name: "b", params: [] }, args: [], arity: 0, variable: false },
      ],
      arity: 2,
      variable: false,
    });
  });

  test("KSequence emits arity", () => {
    // `inner.py:634-635`.
    expect(toDict(ksequence([a, b]))).toMatchObject({ node: "KSequence", arity: 2 });
    expect(toDict(ksequence([]))).toEqual({ node: "KSequence", items: [], arity: 0 });
  });

  test("KVariable omits the sort key entirely when unsorted", () => {
    // `inner.py:327-332` — absent, not null.
    const dct = toDict(kvariable("Foo"));
    expect(Object.hasOwn(dct, "sort")).toBe(false);
    expect(dct).toEqual({ node: "KVariable", name: "Foo" });
  });

  test("KSort.fromDict tolerates a missing params", () => {
    // `inner.py:43` reads it with `d.get('params', ())`.
    expect(sortFromDict({ node: "KSort", name: "Int" })).toEqual(ksort("Int"));
    expect(sortFromDict({ name: "Int" })).toEqual(ksort("Int"));
  });

  test("KLabel.fromDict requires params, where KSort does not", () => {
    // `inner.py:110` reads it with `d['params']`, which raises `KeyError`.
    // The asymmetry is upstream's.
    expect(() => labelFromDict({ node: "KLabel", name: "f" })).toThrow(/missing the field "params"/u);
  });

  test("unknown keys are ignored on read", () => {
    const term = fromDict({
      node: "KApply",
      label: { node: "KLabel", name: "f", params: [], future: 1 },
      args: [{ node: "KVariable", name: "x", somethingNew: true }],
      arity: 99,
      variable: true,
      alsoNew: [1, 2, 3],
    });
    // `arity: 99` and `variable: true` disagree with `args`; the array is the
    // data and the counts are a claim about it.
    expectTerm(term, f(x));
  });

  test("KSequence flattens through fromDict", () => {
    // `inner.py:631-632` builds with `KSequence(items=terms)`, which splices.
    const nested = {
      node: "KSequence",
      arity: 2,
      items: [{ node: "KSequence", arity: 2, items: [toDict(a), toDict(b)] }, toDict(x)],
    };
    expectTerm(fromDict(nested), ksequence([a, b, x]));
    expect(toDict(fromDict(nested))).toMatchObject({ arity: 3 });
  });

  test("sort parameters round-trip as structure, not as a flat name", () => {
    // The whole of the v3 -> v4 break (`version.ts`).
    const sort = ksort("Map", [ksort("Int"), ksort("Set", [ksort("String")])]);
    expect(toDict(ktoken("t", sort))).toEqual({
      node: "KToken",
      token: "t",
      sort: {
        node: "KSort",
        name: "Map",
        params: [
          { node: "KSort", name: "Int", params: [] },
          { node: "KSort", name: "Set", params: [{ node: "KSort", name: "String", params: [] }] },
        ],
      },
    });
  });
});

describe("strict failures carry a JSON path", () => {
  test("an unknown node", () => {
    expect(() => fromDict({ node: "InjectedKLabel", label: { node: "KLabel", name: "f", params: [] } })).toThrow(
      /Unknown KAST node "InjectedKLabel" \(at term\.node\)/u,
    );
  });

  test("a missing field", () => {
    expect(() => fromDict({ node: "KApply", label: { node: "KLabel", name: "f", params: [] } })).toThrow(
      /KApply is missing the field "args" \(at term\)/u,
    );
  });

  test("the path names the offending subterm", () => {
    expect(() =>
      fromDict({
        node: "KApply",
        label: { node: "KLabel", name: "f", params: [] },
        args: [toDict(a), { node: "KToken", token: "1" }],
      }),
    ).toThrow(/KToken is missing the field "sort" \(at term\.args\.1\)/u);
  });

  test("the path reaches into a sort's parameters", () => {
    expect(() =>
      fromDict({
        node: "KToken",
        token: "1",
        sort: { node: "KSort", name: "Map", params: [{ node: "KSort" }] },
      }),
    ).toThrow(/KSort is missing the field "name" \(at term\.sort\.params\.0\)/u);
  });

  test("a malformed sort on a variable is an error, not an unsorted variable", () => {
    // `inner.py:322-324` keys on the *presence* of the key.
    expect(() => fromDict({ node: "KVariable", name: "x", sort: 7 })).toThrow(
      /Expected an object, got 7 \(at term\.sort\)/u,
    );
  });

  test("a non-object is not a term", () => {
    expect(() => fromDict("KApply")).toThrow(/Expected an object, got "KApply" \(at term\)/u);
    expect(() => fromDict(null)).toThrow(/Expected an object, got null \(at term\)/u);
  });
});

describe("envelope", () => {
  test("accepts format KAST version 4 and hands back the raw term", () => {
    const doc = { format: "KAST", version: 4, term: toDict(f(x)) };
    expectTerm(fromDict(kastTerm(doc)), f(x));
  });

  test("tolerates extra envelope keys", () => {
    expect(kastTerm({ format: "KAST", version: 4, term: toDict(a), extra: 1 })).toEqual(toDict(a));
  });

  test("rejects a wrong format", () => {
    expect(() => kastTerm({ format: "KORE", version: 4, term: {} })).toThrow(/Invalid format.*\(at format\)/u);
  });

  test("rejects version 3 — a v3 document is not a lenient v4 document", () => {
    expect(() => kastTerm({ format: "KAST", version: 3, term: {} })).toThrow(/Invalid version.*got 3 \(at version\)/u);
  });

  test('rejects the string "4"', () => {
    expect(() => kastTerm({ format: "KAST", version: "4", term: {} })).toThrow(/Invalid version/u);
  });

  test("rejects a missing term", () => {
    expect(() => kastTerm({ format: "KAST", version: 4 })).toThrow(/missing the field "term"/u);
  });

  test("kastTermToDict is the inverse", () => {
    const doc = kastTermToDict(f(x, y));
    expect(doc).toMatchObject({ format: "KAST", version: 4 });
    expectTerm(fromDict(kastTerm(doc)), f(x, y));
  });
});

/** `f(f(f(... x ...)))`, `depth` applications deep. */
function deepChain(depth: number): KInner {
  let term: KInner = kvariable("x");
  for (let i = 0; i < depth; i++) term = kapply("f", [term]);
  return term;
}

describe("depth", () => {
  test("a 100k-deep term round-trips without a RangeError", () => {
    const term = deepChain(100_000);
    // `toEqual` recurses, so `eq` is the only assertion that can run here.
    expect(eq(fromDict(toDict(term)), term)).toBe(true);
  });

  test("a 100k-deep term hashes without a RangeError", () => {
    expect(hashOf(deepChain(100_000))).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("a 100k-wide sequence flattens without blowing the argument limit", () => {
    // `ksequence` must not splice with `push(...items)`.
    const wide = ksequence(Array.from({ length: 100_000 }, () => a));
    expect(ksequence([wide, b]).items.length).toBe(100_001);
  });
});
