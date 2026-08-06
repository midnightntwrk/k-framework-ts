/**
 * `src/att.ts`.
 *
 * Upstream is thin here — `pyk/src/tests/unit/kast/test_att.py` is 7 `.pretty`
 * rows and nothing else, transcribed below as `PRETTY_TEST_DATA` — so the rest
 * of this file is written against `att.py` itself: every codec in both
 * directions, the registry, the mapping operations, and the two quirks that
 * decide whether a `compiled.json` survives a round-trip (unknown keys keep
 * their value; a repeated name keeps its *first* key object).
 *
 * Cross-checks against pyk's actual output live in `att-parity.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  ANY_TYPE,
  Atts,
  COLORS_TYPE,
  COLOR_TYPE,
  EMPTY_ATT,
  FORMAT_TYPE,
  INT_TYPE,
  KAtt,
  LOCATION_TYPE,
  NONE_TYPE,
  PATH_TYPE,
  STR_TYPE,
  attEntry,
  attKey,
  attKeys,
  format,
  mapAtt,
  optionalType,
  parseFormat,
  unparseFormat,
  updateAtts,
  type AttEntry,
  type Location,
  type WithKAtt,
} from "../src/att.ts";
import { COLORS, isColor, parseColor, type Color } from "../src/color.ts";
import type { JsonValue } from "../src/json.ts";

////////////////////////////////////////////
// PRETTY_TEST_DATA (test_att.py:16)       //
////////////////////////////////////////////

const PRETTY_TEST_DATA: readonly (readonly [string, readonly AttEntry[], string])[] = [
  ["empty", [], ""],
  ["nullary", [attEntry(Atts.FUNCTION, null)], "[function]"],
  ["two-nullaries", [attEntry(Atts.FUNCTION, null), attEntry(Atts.TOTAL, null)], "[function, total]"],
  ["opt-none", [attEntry(Atts.CONCRETE, null)], "[concrete]"],
  ["opt-some-empty-str", [attEntry(Atts.CONCRETE, "")], '[concrete("")]'],
  ["opt-some-nonempty-str", [attEntry(Atts.CONCRETE, "foo")], '[concrete("foo")]'],
  [
    "multiple",
    [attEntry(Atts.SYMBOL, "foo"), attEntry(Atts.FUNCTION, null), attEntry(Atts.TOTAL, null)],
    '[symbol("foo"), function, total]',
  ],
];

/** Navigate a `JsonValue` without an assertion — the frozen-value tests need it. */
function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function field(value: JsonValue, key: string): JsonValue {
  if (value === null || typeof value !== "object" || isJsonArray(value)) {
    throw new TypeError(`Not an object: ${JSON.stringify(value)}`);
  }
  const child = value[key];
  if (child === undefined) throw new TypeError(`No field ${key}`);
  return child;
}

function element(value: JsonValue, i: number): JsonValue {
  if (!isJsonArray(value)) throw new TypeError(`Not an array: ${JSON.stringify(value)}`);
  const child = value[i];
  if (child === undefined) throw new TypeError(`No element ${i}`);
  return child;
}

describe("pretty (test_att.py)", () => {
  for (const [id, entries, expected] of PRETTY_TEST_DATA) {
    test(id, () => {
      expect(new KAtt(entries).pretty).toBe(expected);
    });
  }
});

////////////////////////////////////////////
// The codecs                              //
////////////////////////////////////////////

describe("NONE_TYPE (att.py:43-56)", () => {
  test("round-trips the empty string", () => {
    expect(NONE_TYPE.fromDict("")).toBeNull();
    expect(NONE_TYPE.toDict(null)).toBe("");
    expect(NONE_TYPE.parse("")).toBeNull();
  });

  test("unparse is null — a nullary attribute prints bare", () => {
    expect(NONE_TYPE.unparse(null)).toBeNull();
  });

  test("rejects a value", () => {
    expect(() => NONE_TYPE.fromDict("x")).toThrow(SyntaxError);
    expect(() => NONE_TYPE.fromDict(null)).toThrow(SyntaxError);
    expect(() => NONE_TYPE.parse("x")).toThrow(TypeError);
  });
});

describe("optionalType (att.py:59-81)", () => {
  const OPT_STR = optionalType(STR_TYPE);

  test("the empty string is absence, in every direction", () => {
    expect(OPT_STR.fromDict("")).toBeNull();
    expect(OPT_STR.toDict(null)).toBe("");
    expect(OPT_STR.parse("")).toBeNull();
    expect(OPT_STR.unparse(null)).toBeNull();
  });

  test("anything else delegates", () => {
    expect(OPT_STR.fromDict("foo")).toBe("foo");
    expect(OPT_STR.toDict("foo")).toBe("foo");
    expect(OPT_STR.parse("foo")).toBe("foo");
    expect(OPT_STR.unparse("foo")).toBe('"foo"');
  });

  test("wraps any codec, not just strings", () => {
    const optInt = optionalType(INT_TYPE);
    expect(optInt.fromDict("")).toBeNull();
    expect(optInt.fromDict("7")).toBe(7);
    expect(optInt.unparse(7)).toBe("7");
  });
});

describe("ANY_TYPE (att.py:84-114)", () => {
  test("scalars pass through", () => {
    expect(ANY_TYPE.fromDict("foo")).toBe("foo");
    expect(ANY_TYPE.fromDict(42)).toBe(42);
    expect(ANY_TYPE.fromDict(true)).toBe(true);
    expect(ANY_TYPE.fromDict(null)).toBeNull();
  });

  test("arrays and objects are deep-frozen", () => {
    const value = ANY_TYPE.fromDict({ a: ["b", { c: 1 }] });
    expect(value).toEqual({ a: ["b", { c: 1 }] });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(field(value, "a"))).toBe(true);
    expect(Object.isFrozen(element(field(value, "a"), 1))).toBe(true);
  });

  test("freezing does not reach back into the caller's document", () => {
    const input = { a: ["b"] };
    const value = ANY_TYPE.fromDict(input);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.a)).toBe(false);
    expect(value).not.toBe(input);
  });

  test("toDict is the identity — a frozen array is still JSON", () => {
    const value = ANY_TYPE.fromDict(["a", "b"]);
    expect(ANY_TYPE.toDict(value)).toBe(value);
    expect(JSON.stringify(ANY_TYPE.toDict(value))).toBe('["a","b"]');
  });

  test("unparse is Python's str()", () => {
    expect(ANY_TYPE.unparse("foo")).toBe("foo");
    expect(ANY_TYPE.unparse("")).toBe("");
    expect(ANY_TYPE.unparse(42)).toBe("42");
    expect(ANY_TYPE.unparse(true)).toBe("True");
    expect(ANY_TYPE.unparse(false)).toBe("False");
    expect(ANY_TYPE.unparse(null)).toBe("None");
    expect(ANY_TYPE.unparse(["a"])).toBe("('a',)");
    expect(ANY_TYPE.unparse(["a", "b"])).toBe("('a', 'b')");
    expect(ANY_TYPE.unparse([])).toBe("()");
    expect(ANY_TYPE.unparse({ a: 1 })).toBe("FrozenDict({'a': 1})");
    expect(ANY_TYPE.unparse({})).toBe("FrozenDict({})");
    expect(ANY_TYPE.unparse(["it's"])).toBe('("it\'s",)');
  });

  test("parse throws (att.py:95-96)", () => {
    expect(() => ANY_TYPE.parse("foo")).toThrow(TypeError);
    expect(() => ANY_TYPE.parse("foo")).toThrow(/Attempted to parse: 'foo'/u);
  });

  test("rejects a non-JSON value", () => {
    expect(() => ANY_TYPE.fromDict(Number.NaN)).toThrow(SyntaxError);
    expect(() => ANY_TYPE.fromDict(Symbol("s"))).toThrow(SyntaxError);
    expect(() => ANY_TYPE.fromDict(() => 1)).toThrow(SyntaxError);
  });
});

describe("INT_TYPE (att.py:117-129)", () => {
  test("reads decimal digits out of a JSON string", () => {
    expect(INT_TYPE.fromDict("42")).toBe(42);
    expect(INT_TYPE.fromDict("0")).toBe(0);
    expect(INT_TYPE.fromDict("-1")).toBe(-1);
    expect(INT_TYPE.parse("+7")).toBe(7);
  });

  test("writes it back as a string", () => {
    expect(INT_TYPE.toDict(42)).toBe("42");
    expect(INT_TYPE.unparse(-1)).toBe("-1");
  });

  test("rejects what is not an integer", () => {
    expect(() => INT_TYPE.fromDict("1.5")).toThrow(SyntaxError);
    expect(() => INT_TYPE.fromDict("")).toThrow(SyntaxError);
    expect(() => INT_TYPE.fromDict("0x10")).toThrow(SyntaxError);
    expect(() => INT_TYPE.fromDict(42)).toThrow(SyntaxError);
    expect(() => INT_TYPE.parse("nope")).toThrow(TypeError);
  });

  test("rejects what a double could not hold — Python's ints are unbounded", () => {
    expect(() => INT_TYPE.fromDict("9007199254740993")).toThrow(SyntaxError);
  });
});

describe("STR_TYPE (att.py:132-144)", () => {
  test("round-trips", () => {
    expect(STR_TYPE.fromDict("foo")).toBe("foo");
    expect(STR_TYPE.toDict("foo")).toBe("foo");
    expect(STR_TYPE.parse("foo")).toBe("foo");
  });

  test("unparse quotes but does not escape (att.py:142-143)", () => {
    expect(STR_TYPE.unparse("foo")).toBe('"foo"');
    expect(STR_TYPE.unparse("")).toBe('""');
    expect(STR_TYPE.unparse('a"b')).toBe('"a"b"');
  });

  test("rejects a non-string", () => {
    expect(() => STR_TYPE.fromDict(1)).toThrow(SyntaxError);
  });
});

describe("LOCATION_TYPE (att.py:147-168)", () => {
  test("reads a JSON array of four integers", () => {
    expect(LOCATION_TYPE.fromDict([1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
  });

  test("writes a fresh array back", () => {
    const value: Location = [1, 2, 3, 4];
    const dict = LOCATION_TYPE.toDict(value);
    expect(dict).toEqual([1, 2, 3, 4]);
    expect(dict).not.toBe(value);
  });

  test("unparse is comma-separated and unquoted", () => {
    expect(LOCATION_TYPE.unparse([1, 2, 3, 4])).toBe("1,2,3,4");
  });

  test("parse is a full match on four unsigned integers", () => {
    expect(LOCATION_TYPE.parse("12,3,12,40")).toEqual([12, 3, 12, 40]);
    expect(() => LOCATION_TYPE.parse("1,2,3")).toThrow(TypeError);
    expect(() => LOCATION_TYPE.parse("1,2,3,4,5")).toThrow(TypeError);
    expect(() => LOCATION_TYPE.parse(" 1,2,3,4")).toThrow(TypeError);
    expect(() => LOCATION_TYPE.parse("1,2,3,-4")).toThrow(TypeError);
    expect(() => LOCATION_TYPE.parse("a,b,c,d")).toThrow(TypeError);
  });

  test("rejects a malformed array", () => {
    expect(() => LOCATION_TYPE.fromDict([1, 2, 3])).toThrow(SyntaxError);
    expect(() => LOCATION_TYPE.fromDict([1, 2, 3, 4, 5])).toThrow(SyntaxError);
    expect(() => LOCATION_TYPE.fromDict([1, 2, 3, "4"])).toThrow(SyntaxError);
    expect(() => LOCATION_TYPE.fromDict([1, 2, 3, 4.5])).toThrow(SyntaxError);
    expect(() => LOCATION_TYPE.fromDict("1,2,3,4")).toThrow(SyntaxError);
  });

  test("the error names the offending element", () => {
    expect(() => LOCATION_TYPE.fromDict([1, 2, 3, "4"], "att.loc")).toThrow(/at att\.loc\.3/u);
  });
});

describe("PATH_TYPE (att.py:171-185)", () => {
  // str(PurePosixPath(text)), checked against pyk in att-parity.test.ts.
  const NORMALIZATION: readonly (readonly [string, string])[] = [
    ["/home/k/imp.k", "/home/k/imp.k"],
    ["a//b/./c/", "a/b/c"],
    ["./a/../b", "a/../b"],
    ["", "."],
    [".", "."],
    ["/", "/"],
    ["///", "/"],
    ["//", "//"],
    ["//srv//x", "//srv/x"],
    ["///srv/x", "/srv/x"],
    ["a/", "a"],
    ["./", "."],
  ];

  for (const [input, expected] of NORMALIZATION) {
    test(`normalizes ${JSON.stringify(input)}`, () => {
      expect(PATH_TYPE.fromDict(input)).toBe(expected);
      expect(PATH_TYPE.parse(input)).toBe(expected);
      expect(PATH_TYPE.toDict(input)).toBe(expected);
    });
  }

  test("unparse quotes", () => {
    expect(PATH_TYPE.unparse("/a/b.k")).toBe('"/a/b.k"');
  });

  test("rejects a non-string", () => {
    expect(() => PATH_TYPE.fromDict(["/a"])).toThrow(SyntaxError);
  });
});

////////////////////////////////////////////
// Format (att.py:188-229)                 //
////////////////////////////////////////////

describe("parseFormat (att.py:197-210)", () => {
  const TOKENS: readonly (readonly [string, readonly string[]])[] = [
    ["", []],
    ["abc", ["abc"]],
    ["a b", ["a b"]],
    ["%1", ["%1"]],
    ["%12", ["%12"]],
    ["%c", ["%c"]],
    ["%%", ["%%"]],
    ["%1 + %2", ["%1", " + ", "%2"]],
    ["%%%12%c%1 x", ["%%", "%12", "%c", "%1", " x"]],
    ["a%%b", ["a", "%%", "b"]],
    ["%n%i%d", ["%n", "%i", "%d"]],
    ["%1%2", ["%1", "%2"]],
    ["%,%r", ["%,", "%r"]],
    // Python's `\d` is every Unicode decimal digit, and Python iterates code
    // points — `\p{Nd}` under `u` is what reproduces both.
    ["%١", ["%١"]],
    ["%\u{1F600}", ["%\u{1F600}"]],
  ];

  for (const [input, tokens] of TOKENS) {
    test(`tokenizes ${JSON.stringify(input)}`, () => {
      const parsed = parseFormat(input);
      expect(parsed.tokens).toEqual(tokens);
      expect(unparseFormat(parsed)).toBe(input);
    });
  }

  test("a dangling % is the one failure the grammar has", () => {
    expect(() => parseFormat("%")).toThrow(TypeError);
    expect(() => parseFormat("a%")).toThrow(TypeError);
    expect(() => parseFormat("%1%")).toThrow(TypeError);
    expect(() => parseFormat("%")).toThrow(/Incomplete escape sequence/u);
  });

  test("the pattern keeps no state between calls", () => {
    expect(parseFormat("%1 + %2").tokens).toEqual(parseFormat("%1 + %2").tokens);
    expect(() => parseFormat("a%")).toThrow(TypeError);
    expect(parseFormat("abc").tokens).toEqual(["abc"]);
  });

  test("format() takes tokens as they are", () => {
    expect(format().tokens).toEqual([]);
    expect(format(["%1", "x"]).tokens).toEqual(["%1", "x"]);
    expect(unparseFormat(format(["%1", "x"]))).toBe("%1x");
  });
});

describe("FORMAT_TYPE (att.py:218-229)", () => {
  test("round-trips through the wire string", () => {
    const value = FORMAT_TYPE.fromDict("%1 + %2");
    expect(value.tokens).toEqual(["%1", " + ", "%2"]);
    expect(FORMAT_TYPE.toDict(value)).toBe("%1 + %2");
    expect(FORMAT_TYPE.parse("%1 + %2").tokens).toEqual(value.tokens);
  });

  test("unparse fixes att.py:212, which prints a bound method", () => {
    expect(FORMAT_TYPE.unparse(FORMAT_TYPE.parse("%1 + %2"))).toBe('"%1 + %2"');
    expect(FORMAT_TYPE.unparse(format())).toBe('""');
  });

  test("a bad format string fails with the document position", () => {
    expect(() => FORMAT_TYPE.fromDict("a%", "att.format")).toThrow(SyntaxError);
    expect(() => FORMAT_TYPE.fromDict("a%", "att.format")).toThrow(/at att\.format/u);
    expect(() => FORMAT_TYPE.fromDict(1)).toThrow(SyntaxError);
  });
});

////////////////////////////////////////////
// Colors (att.py:232-257, color.py)       //
////////////////////////////////////////////

describe("colors", () => {
  test("the table is K's, entire", () => {
    expect(COLORS.length).toBe(181);
    expect(new Set(COLORS).size).toBe(181);
    expect(COLORS[0]).toBe("AliceBlue");
    expect(COLORS.at(-1)).toBe("YellowOrange");
  });

  test("lookup is byte-for-byte, so casing matters", () => {
    expect(isColor("red")).toBe(true);
    expect(isColor("Red")).toBe(false);
    expect(isColor("RED")).toBe(false);
    expect(isColor("Grey")).toBe(true);
    expect(isColor("grey")).toBe(false);
    expect(isColor("gray")).toBe(true);
    expect(isColor("Gray")).toBe(false);
    expect(isColor("DarkGray")).toBe(true);
    expect(isColor("")).toBe(false);
    expect(() => parseColor("Blue")).toThrow(TypeError);
  });

  test("COLOR_TYPE round-trips, unquoted", () => {
    expect(COLOR_TYPE.fromDict("LightSteelBlue")).toBe("LightSteelBlue");
    expect(COLOR_TYPE.toDict("red")).toBe("red");
    expect(COLOR_TYPE.unparse("red")).toBe("red");
    expect(COLOR_TYPE.parse("red")).toBe("red");
    expect(() => COLOR_TYPE.fromDict("nope")).toThrow(SyntaxError);
    expect(() => COLOR_TYPE.fromDict(1)).toThrow(SyntaxError);
    expect(() => COLOR_TYPE.parse("nope")).toThrow(TypeError);
  });

  test("COLORS_TYPE strips every space, not just the ones around commas", () => {
    expect(COLORS_TYPE.fromDict(" red , blue ,LightGray")).toEqual(["red", "blue", "LightGray"]);
    expect(COLORS_TYPE.parse("Light Steel Blue")).toEqual(["LightSteelBlue"]);
  });

  test("COLORS_TYPE writes one comma-separated string", () => {
    const value: readonly Color[] = ["red", "blue"];
    expect(COLORS_TYPE.toDict(value)).toBe("red,blue");
    expect(COLORS_TYPE.unparse(value)).toBe("red,blue");
  });

  test("an empty list is not a thing — '' parses to one empty color name", () => {
    expect(() => COLORS_TYPE.parse("")).toThrow(TypeError);
    expect(() => COLORS_TYPE.fromDict("")).toThrow(SyntaxError);
    expect(() => COLORS_TYPE.fromDict("red,nope")).toThrow(SyntaxError);
  });
});

////////////////////////////////////////////
// The registry (att.py:288-375)           //
////////////////////////////////////////////

describe("Atts", () => {
  test("keys() is name-indexed, cached, and complete", () => {
    const keys = attKeys();
    expect(keys).toBe(attKeys());
    expect(keys.size).toBe(Object.keys(Atts).length);
    expect(keys.get("symbol")).toBe(Atts.SYMBOL);
    expect(keys.get("org.kframework.attributes.Location")).toBe(Atts.LOCATION);
    expect(keys.get("UNIQUE_ID")).toBe(Atts.UNIQUE_ID);
    expect(keys.get("nope")).toBeUndefined();
  });

  test("a key's name is not its registry spelling", () => {
    expect(Atts.ALIAS_REC.name).toBe("alias-rec");
    expect(Atts.SMTLEMMA.name).toBe("smt-lemma");
    expect(Atts.LOCATION.name).toBe("org.kframework.attributes.Location");
    expect(Atts.SOURCE.name).toBe("org.kframework.attributes.Source");
    expect(Atts.PRODUCTION.name).toBe("org.kframework.definition.Production");
    expect(Atts.SORT.name).toBe("org.kframework.kore.Sort");
    expect(Atts.UNIQUE_ID.name).toBe("UNIQUE_ID");
  });

  test("keys are equal by name — a rebuilt key finds the same entry", () => {
    const att = new KAtt([attEntry(Atts.SYMBOL, "foo")]);
    expect(att.get(attKey("symbol", STR_TYPE))).toBe("foo");
    expect(att.has(attKey("symbol", ANY_TYPE))).toBe(true);
  });

  test("the value type follows the key", () => {
    const att = KAtt.fromDict({
      node: "KAtt",
      att: {
        symbol: "foo",
        function: "",
        concrete: "c",
        index: "3",
        "org.kframework.attributes.Location": [1, 2, 3, 4],
        "org.kframework.attributes.Source": "/a/b.k",
        color: "red",
        colors: "red,blue",
        label: "l",
      },
    });

    // Each annotation is an assertion the type-checker makes, not the runtime.
    const symbol: string | undefined = att.get(Atts.SYMBOL);
    const nullary: null | undefined = att.get(Atts.FUNCTION);
    const concrete: string | null | undefined = att.get(Atts.CONCRETE);
    const index: number | undefined = att.get(Atts.INDEX);
    const location: Location | undefined = att.get(Atts.LOCATION);
    const source: string | undefined = att.get(Atts.SOURCE);
    const color: Color | undefined = att.get(Atts.COLOR);
    const colors: readonly Color[] | undefined = att.get(Atts.COLORS);
    const label: JsonValue | undefined = att.get(Atts.LABEL);

    expect(symbol).toBe("foo");
    expect(nullary).toBeNull();
    expect(concrete).toBe("c");
    expect(index).toBe(3);
    expect(location).toEqual([1, 2, 3, 4]);
    expect(source).toBe("/a/b.k");
    expect(color).toBe("red");
    expect(colors).toEqual(["red", "blue"]);
    expect(label).toBe("l");
  });
});

////////////////////////////////////////////
// KAtt (att.py:380-452)                   //
////////////////////////////////////////////

describe("KAtt", () => {
  const SYMBOL_FOO = attEntry(Atts.SYMBOL, "foo");
  const FUNCTION = attEntry(Atts.FUNCTION, null);

  test("is empty by default, and EMPTY_ATT is one of those", () => {
    expect(new KAtt().size).toBe(0);
    expect(EMPTY_ATT.size).toBe(0);
    expect(EMPTY_ATT.pretty).toBe("");
    expect(EMPTY_ATT.toDict()).toEqual({ node: "KAtt", att: {} });
    expect([...EMPTY_ATT]).toEqual([]);
  });

  test("keeps insertion order", () => {
    const att = new KAtt([FUNCTION, SYMBOL_FOO, attEntry(Atts.TOTAL, null)]);
    expect([...att.keys()].map((key) => key.name)).toEqual(["function", "symbol", "total"]);
    expect([...att].map((entry) => entry.key.name)).toEqual(["function", "symbol", "total"]);
    expect([...att.entries()].map((entry) => entry.value)).toEqual([null, "foo", null]);
  });

  test("a repeated name keeps the first key object and the last value (att.py:389)", () => {
    const anyLabel = attKey("label", ANY_TYPE);
    const strLabel = attKey("label", STR_TYPE);
    const att = new KAtt([attEntry(anyLabel, "a"), attEntry(strLabel, "b")]);

    expect(att.size).toBe(1);
    expect(att.get(anyLabel)).toBe("b");
    expect([...att.keys()][0]).toBe(anyLabel);
    // The surviving key decides the encoding: ANY prints bare, STR would quote.
    expect(att.pretty).toBe("[label(b)]");
  });

  test("get, has and require", () => {
    const att = new KAtt([SYMBOL_FOO, FUNCTION]);
    expect(att.get(Atts.SYMBOL)).toBe("foo");
    expect(att.get(Atts.TOTAL)).toBeUndefined();
    expect(att.has(Atts.FUNCTION)).toBe(true);
    expect(att.has(Atts.TOTAL)).toBe(false);
    expect(att.require(Atts.SYMBOL)).toBe("foo");
    expect(att.require(Atts.FUNCTION)).toBeNull();
    expect(() => att.require(Atts.TOTAL)).toThrow(TypeError);
  });

  test("a present nullary attribute is null, an absent one is undefined", () => {
    const att = new KAtt([FUNCTION]);
    expect(att.get(Atts.FUNCTION)).toBeNull();
    expect(att.get(Atts.TOTAL)).toBeUndefined();
    expect(att.has(Atts.FUNCTION)).toBe(true);
  });

  describe("fromDict / toDict", () => {
    test("round-trips a known key", () => {
      const dict = { node: "KAtt", att: { symbol: "foo", function: "" } };
      expect(KAtt.fromDict(dict).toDict()).toEqual(dict);
    });

    test("an unknown key survives, as an ANY key (att.py:412)", () => {
      const dict = { node: "KAtt", att: { "my-att": "value", "my-list": ["a", "b"], "my-obj": { a: 1 } } };
      const att = KAtt.fromDict(dict);

      expect(att.size).toBe(3);
      expect(att.get(attKey("my-att", ANY_TYPE))).toBe("value");
      expect([...att.keys()].every((key) => key.type === ANY_TYPE)).toBe(true);
      expect(att.toDict()).toEqual(dict);
    });

    test("the node field is not required, and extra fields are ignored", () => {
      expect(KAtt.fromDict({ att: { symbol: "foo" } }).get(Atts.SYMBOL)).toBe("foo");
      expect(KAtt.fromDict({ node: "KAtt", att: {}, extra: 1 }).size).toBe(0);
    });

    test("a malformed document names its position", () => {
      expect(() => KAtt.fromDict({ node: "KAtt" })).toThrow(/missing the field "att"/u);
      expect(() => KAtt.fromDict({ att: [] })).toThrow(/at att\.att/u);
      expect(() => KAtt.fromDict("nope")).toThrow(SyntaxError);
      expect(() => KAtt.fromDict({ att: { index: "x" } })).toThrow(/at att\.att\.index/u);
      expect(() => KAtt.fromDict({ att: { index: "x" } }, "module.att")).toThrow(/at module\.att\.att\.index/u);
    });

    test("toDict emits the wire form of each value, not the value", () => {
      const att = new KAtt([
        attEntry(Atts.INDEX, 7),
        attEntry(Atts.LOCATION, [1, 2, 3, 4]),
        attEntry(Atts.COLORS, ["red", "blue"]),
        FUNCTION,
      ]);
      expect(att.toDict()).toEqual({
        node: "KAtt",
        att: { index: "7", "org.kframework.attributes.Location": [1, 2, 3, 4], colors: "red,blue", function: "" },
      });
    });
  });

  describe("parse", () => {
    test("reads K's textual attribute values", () => {
      const att = KAtt.parse({ symbol: "foo", function: "", "org.kframework.attributes.Location": "1,2,3,4" });
      expect(att.get(Atts.SYMBOL)).toBe("foo");
      expect(att.get(Atts.FUNCTION)).toBeNull();
      expect(att.get(Atts.LOCATION)).toEqual([1, 2, 3, 4]);
    });

    test("takes pairs as well as a record", () => {
      const att = KAtt.parse([
        ["symbol", "foo"],
        ["function", ""],
      ]);
      expect(att.pretty).toBe('[symbol("foo"), function]');
    });

    test("throws for every ANY-typed key, registered or not (att.py:95-96)", () => {
      expect(() => KAtt.parse({ label: "foo" })).toThrow(TypeError);
      expect(() => KAtt.parse({ "my-att": "foo" })).toThrow(TypeError);
      expect(() => KAtt.parse({ hook: "MAP.concat" })).toThrow(/not supported/u);
    });
  });

  describe("pretty", () => {
    test("empty is the empty string, not []", () => {
      expect(new KAtt().pretty).toBe("");
    });

    test("singleton", () => {
      expect(new KAtt([SYMBOL_FOO]).pretty).toBe('[symbol("foo")]');
      expect(new KAtt([FUNCTION]).pretty).toBe("[function]");
    });

    test("multi, in insertion order", () => {
      expect(new KAtt([SYMBOL_FOO, FUNCTION, attEntry(Atts.INDEX, 3)]).pretty).toBe(
        '[symbol("foo"), function, index(3)]',
      );
    });

    test("an ANY value prints unquoted, an empty one prints as ()", () => {
      expect(new KAtt([attEntry(Atts.LABEL, "foo")]).pretty).toBe("[label(foo)]");
      expect(new KAtt([attEntry(Atts.LABEL, "")]).pretty).toBe("[label()]");
    });
  });

  describe("update / discard / dropSource", () => {
    const BASE = new KAtt([SYMBOL_FOO, FUNCTION]);

    test("update overwrites in place and appends the rest", () => {
      const updated = BASE.update([attEntry(Atts.SYMBOL, "bar"), attEntry(Atts.TOTAL, null)]);
      expect(updated.get(Atts.SYMBOL)).toBe("bar");
      expect([...updated.keys()].map((key) => key.name)).toEqual(["symbol", "function", "total"]);
      expect(BASE.get(Atts.SYMBOL)).toBe("foo");
      expect(BASE.size).toBe(2);
    });

    test("update with nothing is a copy", () => {
      const updated = BASE.update([]);
      expect(updated).not.toBe(BASE);
      expect(updated.equals(BASE)).toBe(true);
    });

    test("discard drops by name and tolerates a miss", () => {
      expect(BASE.discard([Atts.FUNCTION]).pretty).toBe('[symbol("foo")]');
      expect(BASE.discard([attKey("symbol", ANY_TYPE)]).pretty).toBe("[function]");
      expect(BASE.discard([Atts.TOTAL]).equals(BASE)).toBe(true);
      expect(BASE.discard([Atts.SYMBOL, Atts.FUNCTION]).size).toBe(0);
      expect(BASE.size).toBe(2);
    });

    test("dropSource drops Source and Location, and nothing else", () => {
      const att = BASE.update([attEntry(Atts.SOURCE, "/a/b.k"), attEntry(Atts.LOCATION, [1, 2, 3, 4])]);
      expect(att.size).toBe(4);
      expect(att.dropSource().equals(BASE)).toBe(true);
      expect(EMPTY_ATT.dropSource().size).toBe(0);
    });
  });

  test("equals is structural and order-insensitive", () => {
    const a = new KAtt([SYMBOL_FOO, FUNCTION]);
    const b = new KAtt([FUNCTION, SYMBOL_FOO]);
    expect(a.equals(a)).toBe(true);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(new KAtt([SYMBOL_FOO]))).toBe(false);
    expect(a.equals(new KAtt([attEntry(Atts.SYMBOL, "bar"), FUNCTION]))).toBe(false);
    expect(
      new KAtt([attEntry(Atts.LOCATION, [1, 2, 3, 4])]).equals(new KAtt([attEntry(Atts.LOCATION, [1, 2, 3, 4])])),
    ).toBe(true);
  });
});

////////////////////////////////////////////
// WithKAtt (att.py:457-467)               //
////////////////////////////////////////////

interface Sentence extends WithKAtt {
  readonly body: string;
}

/** What the outer phase will pass: the node's own `let` copier, curried to `att`. */
function letAtt(node: Sentence, att: KAtt): Sentence {
  return { body: node.body, att };
}

describe("WithKAtt", () => {
  const node: Sentence = { body: "rule", att: new KAtt([attEntry(Atts.SYMBOL, "foo")]) };

  test("mapAtt rebuilds the node around a new KAtt", () => {
    const mapped = mapAtt(node, (att) => att.discard([Atts.SYMBOL]), letAtt);
    expect(mapped.body).toBe("rule");
    expect(mapped.att.size).toBe(0);
    expect(node.att.size).toBe(1);
  });

  test("updateAtts adds entries", () => {
    const updated = updateAtts(node, [attEntry(Atts.FUNCTION, null)], letAtt);
    expect(updated.att.pretty).toBe('[symbol("foo"), function]');
    expect(node.att.pretty).toBe('[symbol("foo")]');
  });
});
