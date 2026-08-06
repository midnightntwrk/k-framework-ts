/**
 * `src/match.ts` against pyk `kore/match.py`.
 *
 * Two oracles, used together:
 *
 * 1. **pyk itself.**  Every expected value below was produced by running the
 *    reference module at the pinned release, not by reading it.  The script is
 *    reproducible — `pyk/src/pyk/kore/match.py` and `prelude.py` are
 *    byte-identical between the pinned v7.1.337 tree and the installed
 *    `kframework` distribution, so either interpreter yields the same:
 *
 *    ```sh
 *    cd k/pyk/src && PYTHONPATH=. python3 -c '
 *    from pyk.kore.prelude import *
 *    from pyk.kore.syntax import App
 *    import pyk.kore.match as km
 *    a, b, c = App("a"), App("b"), App("c")
 *    print([p.text for p in km.match_list(list_pattern(a, b, c))])
 *    print(km.kore_int(int_dv(-17)))
 *    print([p.text for p in km.args("LblB", "LblA")(App("Lblcfg", (), (
 *        App("LblA", (), (int_dv(1),)),
 *        App("LblB", (), (int_dv(2),)),
 *        App("LblA", (), (int_dv(2),)))))])'
 *    ```
 *
 * 2. **`src/prelude.ts` itself.**  Every decoder here is the inverse of a
 *    builder there, so the round trip `match∘build = id` is asserted for each
 *    collection — a shared misunderstanding of the encoding would survive that,
 *    which is exactly why oracle (1) is also present.
 */

import { describe, expect, test } from "bun:test";

import {
  appOf,
  argAt,
  argNamed,
  argsAt,
  argsNamed,
  caseSymbol,
  injArg,
  koreBool,
  koreBytes,
  koreId,
  koreInt,
  koreListOf,
  KoreMatchError,
  koreMapOf,
  koreRangeMapOf,
  koreSetOf,
  koreStr,
  matchApp,
  matchDv,
  matchInj,
  matchLeftAssoc,
  matchList,
  matchMap,
  matchRangeMap,
  matchSet,
  matchSymbol,
} from "../src/match.ts";
import {
  BOOL,
  boolDv,
  BYTES,
  bytesDv,
  ID,
  inj,
  INT,
  intDv,
  listPattern,
  mapPattern,
  rangemapPattern,
  setPattern,
  SORT_K_ITEM,
  STOP_LIST,
  STOP_MAP,
  STOP_RANGEMAP,
  STOP_SET,
  strDv,
  TRUE,
} from "../src/prelude.ts";
import { app, dv, evar, koreString, koreText, leftAssoc, type Pattern, sortApp } from "../src/syntax.ts";

const a = app("a");
const b = app("b");
const c = app("c");

/** `koreText` of everything, so an expectation is readable as KORE. */
const texts = (ps: Iterable<Pattern>): string[] => [...ps].map((p) => koreText(p));

/**
 * The error `run` threw, narrowed — `instanceof`, not a cast, so a *different*
 * error type is reported here rather than read as the expected one.
 */
function thrownMatchError(run: () => unknown): KoreMatchError {
  try {
    run();
  } catch (error) {
    if (error instanceof KoreMatchError) return error;
    throw error;
  }
  throw new Error("Expected a KoreMatchError, but nothing was thrown");
}

/** `km.app('Lblcfg') >> km.arg('LblB') >> km.arg(0)`, spelled without an operator. */
const readB = (pattern: Pattern): bigint => koreInt(argAt(0)(argNamed("LblB")(appOf("Lblcfg")(pattern))));

describe("matchDv", () => {
  test("a \\dv is returned as itself", () => {
    expect(matchDv(TRUE)).toBe(TRUE);
    expect(matchDv(TRUE, BOOL)).toBe(TRUE);
  });

  test("the sort is compared structurally, not by identity", () => {
    // pyk compares frozen dataclasses; a freshly built sort must match the
    // singleton.
    expect(matchDv(TRUE, sortApp("SortBool"))).toBe(TRUE);
  });

  test("a sort mismatch carries pyk's message", () => {
    // pyk: ValueError: Expected sort SortInt{}, found: SortBool{}
    expect(() => matchDv(TRUE, INT)).toThrow(KoreMatchError);
    expect(() => matchDv(TRUE, INT)).toThrow("Expected sort SortInt{}, found: SortBool{}");
  });

  test("a non-\\dv is a KoreMatchError carrying the pattern", () => {
    const error = thrownMatchError(() => matchDv(a));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.pattern).toBe(a);
  });
});

describe("matchSymbol / matchApp / matchInj / matchLeftAssoc", () => {
  test("matchSymbol compares two names", () => {
    // Returns nothing; the assertion is that it does not throw.
    matchSymbol("a", "a");
    // pyk: ValueError: Expected symbol b, found: a
    expect(() => {
      matchSymbol("a", "b");
    }).toThrow("Expected symbol b, found: a");
  });

  test("matchApp with no symbol accepts any application", () => {
    expect(matchApp(a)).toBe(a);
  });

  test("matchApp rejects the wrong symbol and non-applications", () => {
    expect(() => matchApp(a, "b")).toThrow("Expected symbol b, found: a");
    expect(() => matchApp(TRUE)).toThrow(KoreMatchError);
  });

  test("a \\left-assoc is NOT an application of its head symbol", () => {
    // pyk's `type(pattern) is App` makes this so; a caller must say which shape
    // it means.
    const assoc = leftAssoc("f", [], [a, b]);
    expect(() => matchApp(assoc, "f")).toThrow("Expected an application");
    expect(matchLeftAssoc(assoc, "f")).toBe(assoc);
    expect(() => matchLeftAssoc(a)).toThrow("Expected a \\left-assoc");
  });

  test("matchInj is matchApp at the injection symbol", () => {
    const injected = inj(BOOL, SORT_K_ITEM, TRUE);
    expect(matchInj(injected)).toBe(injected);
    expect(() => matchInj(a)).toThrow("Expected symbol inj, found: a");
  });
});

describe("collection decoders are the inverse of the prelude builders", () => {
  test("matchList — pyk match_list", () => {
    // pyk: ['a{}()', 'b{}()', 'c{}()'] and []
    expect(texts(matchList(listPattern(a, b, c)))).toEqual(["a{}()", "b{}()", "c{}()"]);
    expect(matchList(listPattern())).toEqual([]);
    expect(matchList(STOP_LIST)).toEqual([]);
  });

  test("matchList rejects a different unit symbol", () => {
    // pyk: ValueError: Expected symbol Lbl'Stop'List, found: LblOther
    expect(() => matchList(app("LblOther"))).toThrow("Expected symbol Lbl'Stop'List, found: LblOther");
  });

  test("matchSet — pyk match_set", () => {
    expect(texts(matchSet(setPattern(a, b)))).toEqual(["a{}()", "b{}()"]);
    expect(matchSet(setPattern())).toEqual([]);
    expect(matchSet(STOP_SET)).toEqual([]);
  });

  test("matchMap — pyk match_map", () => {
    // pyk: [['a{}()', 'b{}()'], ['b{}()', 'c{}()']]
    const entries = matchMap(
      mapPattern([
        [a, b],
        [b, c],
      ]),
    );
    expect(entries.map(([k, v]) => [koreText(k), koreText(v)])).toEqual([
      ["a{}()", "b{}()"],
      ["b{}()", "c{}()"],
    ]);
    expect(matchMap(mapPattern([]))).toEqual([]);
    expect(matchMap(STOP_MAP)).toEqual([]);
  });

  test("matchMap with a cell collection — pyk match_map(cell=…)", () => {
    // pyk: map_pattern((a, b), cell='Acct').text is
    //   \left-assoc{}(Lbl'Unds'AcctMap'Unds'{}(LblAcctMapItem{}(a{}(), b{}())))
    const cell = { cell: "Acct" };
    const written = mapPattern([[a, b]], cell);
    expect(koreText(written)).toBe(String.raw`\left-assoc{}(Lbl'Unds'AcctMap'Unds'{}(LblAcctMapItem{}(a{}(), b{}())))`);
    expect(matchMap(written, cell).map(([k, v]) => [koreText(k), koreText(v)])).toEqual([["a{}()", "b{}()"]]);
    expect(koreText(mapPattern([], cell))).toBe("Lbl'Stop'AcctMap{}()");
    expect(matchMap(mapPattern([], cell), cell)).toEqual([]);
  });

  test("a cell map does not decode as a plain map, and vice versa", () => {
    const written = mapPattern([[a, b]], { cell: "Acct" });
    expect(() => matchMap(written)).toThrow("Expected symbol Lbl'Unds'Map'Unds'");
    expect(() => matchMap(mapPattern([[a, b]]), { cell: "Acct" })).toThrow("Expected symbol Lbl'Unds'AcctMap'Unds'");
  });

  test("matchRangeMap — pyk match_rangemap", () => {
    // pyk: [[['a{}()', 'b{}()'], 'c{}()']]
    const entries = matchRangeMap(rangemapPattern([[[a, b], c]]));
    expect(entries.map(([[s, e], v]) => [[koreText(s), koreText(e)], koreText(v)])).toEqual([
      [["a{}()", "b{}()"], "c{}()"],
    ]);
    expect(matchRangeMap(rangemapPattern([]))).toEqual([]);
    expect(matchRangeMap(STOP_RANGEMAP)).toEqual([]);
  });

  test("order and duplicates survive the round trip", () => {
    // A Set decoder returning a JS Set, or a Map decoder returning a JS Map,
    // would silently drop the second `a` — and `_Set_`/`_Map_` are only
    // idempotent/partial *in the semantics*, which is the backend's business.
    expect(texts(matchSet(setPattern(a, a, b)))).toEqual(["a{}()", "a{}()", "b{}()"]);
    expect(
      matchMap(
        mapPattern([
          [a, b],
          [a, c],
        ]),
      ),
    ).toHaveLength(2);
  });
});

describe("domain-value readers", () => {
  test("koreBool — pyk kore_bool", () => {
    expect(koreBool(boolDv(true))).toBe(true);
    expect(koreBool(boolDv(false))).toBe(false);
    // pyk: ValueError: Invalid Boolean domain value: \dv{SortBool{}}("yes")
    expect(() => koreBool(dv(BOOL, koreString("yes")))).toThrow(
      String.raw`Invalid Boolean domain value: \dv{SortBool{}}("yes")`,
    );
  });

  test("koreInt returns bigint — pyk kore_int returns an unbounded int", () => {
    // pyk: km.kore_int(int_dv(-17)) == -17
    expect(koreInt(intDv(-17))).toBe(-17n);
    // The deviation that matters: a 256-bit word is exact, where Number would
    // round. `intDv` round-trips it.
    const big = 2n ** 255n - 1n;
    expect(koreInt(intDv(big))).toBe(big);
    expect(koreInt(intDv(0))).toBe(0n);
  });

  test("koreInt accepts exactly a decimal literal", () => {
    expect(koreInt(dv(INT, koreString("+7")))).toBe(7n);
    expect(koreInt(dv(INT, koreString("-0")))).toBe(0n);
    for (const bad of ["", "1.5", "twelve", "0x10", " 12 ", "1_000", "1e3"]) {
      // `BigInt("")` is `0n` and `BigInt("0x10")` is `16n`; Python's `int()`
      // takes `" 12 "` and `"1_000"`. None of them is a KORE Int literal, and
      // silently decoding one is worse than either language's default.
      expect(() => koreInt(dv(INT, koreString(bad)))).toThrow("Invalid Int domain value");
    }
  });

  test("koreStr — pyk kore_str, on already-unescaped characters", () => {
    // pyk: km.kore_str(str_dv('a\nb')) == 'a\nb'
    expect(koreStr(strDv("a\nb"))).toBe("a\nb");
  });

  test("koreId — pyk kore_id", () => {
    expect(koreId(dv(ID, koreString("foo")))).toBe("foo");
    expect(() => koreId(strDv("foo"))).toThrow("Expected sort SortId{}, found: SortString{}");
  });

  test("koreBytes is the exact inverse of bytesDv — pyk kore_bytes", () => {
    // pyk: list(km.kore_bytes(bytes_dv(bytes([0, 65, 128, 255])))) == [0, 65, 128, 255]
    const bytes = Uint8Array.from([0x00, 0x41, 0x80, 0xff]);
    expect([...koreBytes(bytesDv(bytes))]).toEqual([0, 65, 128, 255]);
    expect(() => koreBytes(dv(BYTES, koreString("Ā")))).toThrow();
  });

  test("every reader checks the sort", () => {
    expect(() => koreBool(intDv(1))).toThrow("Expected sort SortBool{}");
    expect(() => koreInt(TRUE)).toThrow("Expected sort SortInt{}");
    expect(() => koreStr(intDv(1))).toThrow("Expected sort SortString{}");
    expect(() => koreBytes(strDv("x"))).toThrow("Expected sort SortBytes{}");
  });
});

/**
 * The combinator layer.  `cfg` is the term every case below projects out of; it
 * deliberately has two `LblA` arguments, because first-occurrence-wins is a
 * behaviour of pyk's that a one-`LblA` term could not observe.
 */
describe("combinators", () => {
  const one = intDv(1);
  const two = intDv(2);
  const cfg = app("Lblcfg", [], [app("LblA", [], [one]), app("LblB", [], [two]), app("LblA", [], [two])]);

  test("appOf is matchApp curried", () => {
    expect(appOf("Lblcfg")(cfg)).toBe(cfg);
    expect(appOf()(cfg)).toBe(cfg);
    expect(() => appOf("Lblnope")(cfg)).toThrow("Expected symbol Lblnope, found: Lblcfg");
  });

  test("argAt is positional", () => {
    expect(koreText(argAt(1)(cfg))).toBe(String.raw`LblB{}(\dv{SortInt{}}("2"))`);
    // pyk: ValueError: Argument index is out of range
    expect(() => argAt(9)(cfg)).toThrow("Argument index is out of range");
  });

  test("a negative index is out of range here, where pyk would index from the end", () => {
    // pyk's guard is `len(app.args) <= id`, so `arg(-1)` silently returns the
    // last argument. Silently decoding the wrong argument is the failure mode
    // worth refusing.
    expect(() => argAt(-1)(cfg)).toThrow("Argument index is out of range");
  });

  test("argNamed finds the first argument with that head symbol", () => {
    // pyk: km.arg('LblB')(cfg).text == 'LblB{}(\\dv{SortInt{}}("2"))'
    expect(koreText(argNamed("LblB")(cfg))).toBe(String.raw`LblB{}(\dv{SortInt{}}("2"))`);
    expect(koreText(argNamed("LblA")(cfg))).toBe(String.raw`LblA{}(\dv{SortInt{}}("1"))`);
    // pyk: ValueError: No matching argument found for symbol: LblZ
    expect(() => argNamed("LblZ")(cfg)).toThrow("No matching argument found for symbol: LblZ");
  });

  test("argsAt returns the arguments in the order asked for", () => {
    // pyk: [p.text for p in km.args(2, 0)(cfg)]
    //   == ['LblA{}(\\dv{SortInt{}}("2"))', 'LblA{}(\\dv{SortInt{}}("1"))']
    expect(texts(argsAt(2, 0)(cfg))).toEqual([
      String.raw`LblA{}(\dv{SortInt{}}("2"))`,
      String.raw`LblA{}(\dv{SortInt{}}("1"))`,
    ]);
    // pyk: list(km.args()(cfg)) == []
    expect(argsAt()(cfg)).toEqual([]);
  });

  test("argsNamed reads cells by name, order-insensitively", () => {
    // The whole point: a projection that survives `kompile` reordering cells.
    // pyk: [p.text for p in km.args('LblB', 'LblA')(cfg)]
    //   == ['LblB{}(\\dv{SortInt{}}("2"))', 'LblA{}(\\dv{SortInt{}}("1"))']
    expect(texts(argsNamed("LblB", "LblA")(cfg))).toEqual([
      String.raw`LblB{}(\dv{SortInt{}}("2"))`,
      String.raw`LblA{}(\dv{SortInt{}}("1"))`,
    ]);
    expect(argsNamed()(cfg)).toEqual([]);
  });

  test("argsNamed repeats a repeated request, as pyk's output comprehension does", () => {
    expect(texts(argsNamed("LblA", "LblA")(cfg))).toEqual([
      String.raw`LblA{}(\dv{SortInt{}}("1"))`,
      String.raw`LblA{}(\dv{SortInt{}}("1"))`,
    ]);
  });

  test("argsNamed names every missing symbol", () => {
    // pyk: ValueError: No matching arguments found for symbols: LblY, LblZ
    // (pyk's set iteration order is arbitrary; ours is request order.)
    expect(() => argsNamed("LblZ", "LblY")(cfg)).toThrow("No matching arguments found for symbols: LblZ, LblY");
  });

  test("injArg strips exactly one injection", () => {
    // pyk: km.inj(inj(BOOL, SORT_K_ITEM, TRUE)).text == '\\dv{SortBool{}}("true")'
    expect(koreText(injArg(inj(BOOL, SORT_K_ITEM, TRUE)))).toBe(String.raw`\dv{SortBool{}}("true")`);
    const doubled = inj(sortApp("SortA"), SORT_K_ITEM, inj(sortApp("SortB"), sortApp("SortA"), TRUE));
    expect(koreText(injArg(doubled))).toBe(String.raw`inj{SortB{}, SortA{}}(\dv{SortBool{}}("true"))`);
    expect(() => injArg(a)).toThrow("Expected symbol inj, found: a");
  });

  test("koreListOf / koreSetOf / koreMapOf / koreRangeMapOf", () => {
    // pyk: [1, 2] / [1] / [[1, 'x']] / [[[1, 2], 'y']]
    expect(koreListOf(koreInt)(listPattern(intDv(1), intDv(2)))).toEqual([1n, 2n]);
    expect(koreSetOf(koreInt)(setPattern(intDv(1)))).toEqual([1n]);
    expect(koreMapOf(koreInt, koreStr)(mapPattern([[intDv(1), strDv("x")]]))).toEqual([[1n, "x"]]);
    expect(koreRangeMapOf(koreInt, koreStr)(rangemapPattern([[[intDv(1), intDv(2)], strDv("y")]]))).toEqual([
      [[1n, 2n], "y"],
    ]);
  });

  test("koreMapOf forwards the cell to matchMap", () => {
    const written = mapPattern([[intDv(1), strDv("x")]], { cell: "Acct" });
    expect(koreMapOf(koreInt, koreStr, { cell: "Acct" })(written)).toEqual([[1n, "x"]]);
  });

  test("a decoder failure inside a collection propagates, it does not become undefined", () => {
    expect(() => koreListOf(koreInt)(listPattern(TRUE))).toThrow("Expected sort SortInt{}");
  });

  test("caseSymbol dispatches on the head symbol, first match winning", () => {
    // pyk: km.case_symbol(('LblX', …), ('Lblcfg', …))(cfg) == 'cfg'
    const decode = caseSymbol<string>([
      ["LblX", () => "x"],
      ["Lblcfg", () => "cfg"],
    ]);
    expect(decode(cfg)).toBe("cfg");
    expect(
      caseSymbol<string>([
        ["Lblcfg", () => "first"],
        ["Lblcfg", () => "second"],
      ])(cfg),
    ).toBe("first");
  });

  test("caseSymbol falls back, or throws when there is nothing to fall back to", () => {
    // pyk: 'd', and otherwise ValueError: No match found for: App(...)
    expect(caseSymbol<string>([["LblX", () => "x"]], () => "d")(cfg)).toBe("d");
    expect(() => caseSymbol<string>([["LblX", () => "x"]])(cfg)).toThrow("No match found for symbol: Lblcfg");
  });

  test("a projection composes without a chaining operator", () => {
    expect(readB(cfg)).toBe(2n);
  });
});

describe("error diagnostics", () => {
  test("a long pattern is named by tag and size, not inlined whole", () => {
    // pyk inlines a `repr()` of the entire term, which for a real configuration
    // is thousands of unreadable characters. The term is on the error instead.
    const long = app(
      "Lblverylongsymbolname",
      [],
      Array.from({ length: 40 }, () => evar("SomeVariable", INT)),
    );
    const error = thrownMatchError(() => matchDv(long));
    expect(error.message).toContain("App (");
    expect(error.message.length).toBeLessThan(120);
    expect(error.pattern).toBe(long);
  });

  test("KoreMatchError is a TypeError named KoreMatchError", () => {
    const error = new KoreMatchError("boom");
    expect(error.name).toBe("KoreMatchError");
    expect(error).toBeInstanceOf(TypeError);
    expect(error.pattern).toBeUndefined();
  });
});
