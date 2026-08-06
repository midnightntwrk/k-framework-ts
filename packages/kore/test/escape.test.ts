/**
 * The escape-codec suite.
 *
 * The decode table is `STRING_TEST_DATA`
 * (`k/pyk/src/tests/unit/kore/test_parser.py:156-175`), transcribed verbatim —
 * 18 cases, including the two that exist only to pin hex case-insensitivity
 * (`\x0F`, `\U0001F642`) and the one that exists only to pin astral handling
 * (`\U0001f642`).  pyk drives them through its parser's `string()` production;
 * the parser is a later module, so here they drive `dequoteString` directly,
 * which is what that production calls.
 */

import { describe, expect, test } from "bun:test";
import { bytesDecode, bytesEncode, dequoteBytes, dequoteString, enquoteBytes, enquoteString } from "../src/escape.ts";

/** `test_parser.py:156-175`. `[escaped body, decoded text]`. */
const STRING_TEST_DATA: readonly (readonly [string, string])[] = [
  ["", ""],
  [" ", " "],
  ["foo", "foo"],
  ["\\t", "\t"],
  ["\\n", "\n"],
  ["\\f", "\f"],
  ["\\r", "\r"],
  ["\\\\", "\\"],
  ['\\"', '"'],
  ["\\x80", "\u0080"],
  ["\\x0f", "\u000F"],
  ["\\x0F", "\u000F"],
  ["\\u03b1", "\u03B1"],
  ["\\u03B1", "\u03B1"],
  ["\\U0001f642", "\u{1F642}"],
  ["\\U0001F642", "\u{1F642}"],
  ["\\x80\\x80", "\u0080\u0080"],
  ["a\\u03b1\\x80\\U0001f642b", "a\u03B1\u0080\u{1F642}b"],
];

describe("dequoteString — pyk STRING_TEST_DATA", () => {
  for (const [text, expected] of STRING_TEST_DATA) {
    test(`"${text}"`, () => {
      expect(dequoteString(text)).toBe(expected);
    });
  }
});

describe("enquoteString", () => {
  // The canonical (lowercase-hex) spelling of every decoded value above.  Not
  // the same as re-emitting the input: `\x0F` and `\U0001F642` normalize.
  const cases: readonly (readonly [string, string])[] = [
    ["", ""],
    [" ", " "],
    ["foo", "foo"],
    ["\t", "\\t"],
    ["\n", "\\n"],
    ["\f", "\\f"],
    ["\r", "\\r"],
    ["\\", "\\\\"],
    ['"', '\\"'],
    ["\u0080", "\\x80"],
    ["\u000F", "\\x0f"],
    ["\u03B1", "\\u03b1"],
    ["\u{1F642}", "\\U0001f642"],
    ["a\u03B1\u0080\u{1F642}b", "a\\u03b1\\x80\\U0001f642b"],
    // `dequote.py:112` — the literal range is 32..126 inclusive; 127 (DEL) is
    // not printable and 31 (US) is not either.
    ["\u001F", "\\x1f"],
    [" ~", " ~"],
    ["\u007F", "\\x7f"],
  ];

  for (const [text, expected] of cases) {
    test(JSON.stringify(text), () => {
      expect(enquoteString(text)).toBe(expected);
    });
  }

  test("emits lowercase hex but accepts uppercase", () => {
    expect(enquoteString(dequoteString("\\x0F"))).toBe("\\x0f");
    expect(enquoteString(dequoteString("\\u03B1"))).toBe("\\u03b1");
    expect(enquoteString(dequoteString("\\U0001F642"))).toBe("\\U0001f642");
  });

  test("every pyk case round-trips through both directions", () => {
    for (const [, decoded] of STRING_TEST_DATA) {
      expect(dequoteString(enquoteString(decoded))).toBe(decoded);
    }
  });
});

describe("astral code points are one escape, not two", () => {
  // The JS hazard here: a UTF-16-unit loop would emit
  // `\uD83D\uDE42`, which is two escapes of two illegal (surrogate) values.
  test("U+1F642 encodes as a single \\U escape", () => {
    const smiley = "\u{1F642}";
    expect(smiley.length).toBe(2); // two UTF-16 units...
    expect(Array.from(smiley).length).toBe(1); // ...one code point
    expect(enquoteString(smiley)).toBe("\\U0001f642");
    expect(enquoteString(smiley)).not.toContain("\\ud83d");
  });

  test("U+10FFFF, the largest code point, round-trips", () => {
    const max = "\u{10FFFF}";
    expect(enquoteString(max)).toBe("\\U0010ffff");
    expect(dequoteString("\\U0010ffff")).toBe(max);
  });

  test("mixed BMP/astral text round-trips", () => {
    const s = "a\u{1F642}\u03B1\u{1F600}z";
    expect(dequoteString(enquoteString(s))).toBe(s);
  });
});

describe("dequoteString rejects", () => {
  const bad: readonly (readonly [string, string])[] = [
    ["unknown escape", "\\q"],
    ["unknown escape (C-only \\a)", "\\a"],
    ["unknown escape (C-only \\v)", "\\v"],
    ["unknown escape (C-only \\')", "\\'"],
    ["octal, which KORE has no grammar for", "\\101"],
    ["lone trailing backslash", "abc\\"],
    ["truncated \\x", "\\x1"],
    ["truncated \\u", "\\u123"],
    ["truncated \\U", "\\U0001f64"],
    ["non-hex digit in \\x", "\\xg1"],
    ["non-hex digit in \\u", "\\u03z1"],
    ["non-ASCII digit in \\x", "\\x\uFF10\uFF10"],
    ["surrogate in \\u", "\\ud800"],
    ["surrogate in \\U", "\\U0000dfff"],
    ["code point above U+10FFFF", "\\U00110000"],
  ];

  for (const [why, text] of bad) {
    test(`${why}: ${JSON.stringify(text)}`, () => {
      expect(() => dequoteString(text)).toThrow(SyntaxError);
    });
  }

  test("rejection is not scala-kore's silent backslash drop", () => {
    // scala-kore's `unquoteKOREString` would hand back "q" here.
    expect(() => dequoteString("\\q")).toThrow();
  });
});

describe("enquoteString rejects", () => {
  test("unpaired high surrogate", () => {
    expect(() => enquoteString("\uD800")).toThrow(SyntaxError);
  });

  test("unpaired low surrogate", () => {
    expect(() => enquoteString("a\uDFFFb")).toThrow(SyntaxError);
  });
});

describe("bytes variant", () => {
  test("\\x escapes are allowed in both directions", () => {
    expect(dequoteBytes("\\x80")).toBe("\u0080");
    expect(enquoteBytes("\u0080")).toBe("\\x80");
    expect(dequoteBytes('a\\tb\\"c\\\\d\\xff')).toBe('a\tb"c\\d\u00FF');
  });

  test("\\u and \\U are rejected on decode", () => {
    expect(() => dequoteBytes("\\u03b1")).toThrow(SyntaxError);
    expect(() => dequoteBytes("\\U0001f642")).toThrow(SyntaxError);
  });

  test("code points above U+00FF are rejected on encode", () => {
    expect(() => enquoteBytes("\u0100")).toThrow(SyntaxError);
    expect(() => enquoteBytes("\u{1F642}")).toThrow(SyntaxError);
  });

  test("the whole latin-1 range round-trips", () => {
    let s = "";
    for (let i = 0; i <= 0xff; i++) s += String.fromCharCode(i);
    expect(dequoteBytes(enquoteBytes(s))).toBe(s);
  });
});

describe("bytesEncode / bytesDecode", () => {
  test("latin-1, one code unit per byte", () => {
    expect([...bytesEncode("\u0000A\u00FF")]).toEqual([0, 65, 255]);
    expect(bytesDecode(Uint8Array.from([0, 65, 255]))).toBe("\u0000A\u00FF");
  });

  test("rejects anything above U+00FF", () => {
    expect(() => bytesEncode("\u0100")).toThrow(SyntaxError);
    expect(() => bytesEncode("\u{1F642}")).toThrow(SyntaxError);
  });

  test("round-trips every byte", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect([...bytesEncode(bytesDecode(bytes))]).toEqual([...bytes]);
  });

  test("decodes a value larger than the argument limit of String.fromCharCode", () => {
    // `bytesDecode` chunks for exactly this reason; a spread of 200_000
    // arguments would be a RangeError.
    const big = new Uint8Array(200_000).fill(0xfe);
    expect(bytesDecode(big).length).toBe(200_000);
    expect(bytesDecode(big).charCodeAt(199_999)).toBe(0xfe);
  });
});
