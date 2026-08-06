/**
 * The escape-codec suite.
 *
 * The tables are `k/pyk/src/tests/unit/test_dequote.py` transcribed whole: one
 * 22-row base table (`test_dequote.py:12-36`) plus the four derived tables the
 * pytest parametrizations build from it, for 145 cases in total — the same
 * count pytest collects there.  Only the parametrize machinery is left behind.
 *
 * On top of that: the Java frontend's escape cases
 * (`k-frontend/src/test/java/org/kframework/utils/StringUtilTest.java:11-34`),
 * which contribute the two rejections pyk's table has no row for, and the
 * JavaScript-specific surrogate/astral hazards, which no upstream suite can
 * cover because Python has no UTF-16 strings.
 */

import { describe, expect, test } from "bun:test";
import {
  bytesDecode,
  bytesEncode,
  dequoteBytes,
  dequoteString,
  EscapeError,
  enquoteBytes,
  enquoteString,
} from "../src/escape.ts";

/**
 * `BASE_TEST_DATA` (`test_dequote.py:12-36`): `[enquoted, dequoted, encoded]`.
 *
 * Python's `rb'\ '` is a two-byte value, not an escape — the `r` prefix is why
 * rows 8-10 differ from row 11.
 */
const BASE_TEST_DATA: readonly (readonly [string, string, readonly number[]])[] = [
  ["", "", []],
  [" ", " ", [0x20]],
  ["1", "1", [0x31]],
  ["012", "012", [0x30, 0x31, 0x32]],
  ["a", "a", [0x61]],
  ["abc", "abc", [0x61, 0x62, 0x63]],
  ["'", "'", [0x27]],
  ["\\\\ ", "\\ ", [0x5c, 0x20]],
  ["\\\\1", "\\1", [0x5c, 0x31]],
  ["\\\\a", "\\a", [0x5c, 0x61]],
  ["\\\\", "\\", [0x5c]],
  ['\\"', '"', [0x22]],
  ["\\t", "\t", [0x09]],
  ["\\n", "\n", [0x0a]],
  ["\\r", "\r", [0x0d]],
  ["\\f", "\f", [0x0c]],
  ["Hello World!\\n", "Hello World!\n", [0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x57, 0x6f, 0x72, 0x6c, 0x64, 0x21, 0x0a]],
  ["\\r\\n", "\r\n", [0x0d, 0x0a]],
  ["$", "$", [0x24]],
  ["\\x00", "\u0000", [0x00]],
  ["\\x80", "\u0080", [0x80]],
  ["\\x00\\x80", "\u0000\u0080", [0x00, 0x80]],
];

/** `BYTES_ENCODE_TEST_DATA` (`test_dequote.py:39`). */
const BYTES_ENCODE_TEST_DATA: readonly (readonly [string, readonly number[]])[] = BASE_TEST_DATA.map(
  ([, dequoted, encoded]) => [dequoted, encoded],
);

/** `ENQUOTE_BYTES_TEST_DATA` (`test_dequote.py:68`). */
const ENQUOTE_BYTES_TEST_DATA: readonly (readonly [string, string])[] = BASE_TEST_DATA.map(([enquoted, dequoted]) => [
  enquoted,
  dequoted,
]);

/** `DEQUOTE_BYTES_TEST_DATA` (`test_dequote.py:84-89`). */
const DEQUOTE_BYTES_TEST_DATA: readonly (readonly [string, string])[] = [
  ...ENQUOTE_BYTES_TEST_DATA,
  ["\\x0c", "\f"],
  ["\\x24", "$"],
  // `\x` takes exactly two digits, so `80` stays literal text.
  ["\\x4e80", "N80"],
];

/** `ENQUOTE_STRING_TEST_DATA` (`test_dequote.py:105-112`). */
const ENQUOTE_STRING_TEST_DATA: readonly (readonly [string, string])[] = [
  ...ENQUOTE_BYTES_TEST_DATA,
  ["\\u03b1", "\u03B1"], // α
  ["\\u4e80", "\u4E80"], // 亀
  ["\\U0001f642", "\u{1F642}"], // 🙂 — one code point, two UTF-16 units
  ["\\u6b66\\u5929\\u8001\\u5e2b", "\u6B66\u5929\u8001\u5E2B"], // 武天老師
  ["a\\n\\u03b1\\n", "a\n\u03B1\n"],
];

/** `DEQUOTE_STRING_TEST_DATA` (`test_dequote.py:128-132`). */
const DEQUOTE_STRING_TEST_DATA: readonly (readonly [string, string])[] = [
  ...DEQUOTE_BYTES_TEST_DATA,
  ["\\u0024", "$"],
  ["\\U00000024", "$"],
];

describe("bytesEncode — test_encode_bytes", () => {
  for (const [dequoted, expected] of BYTES_ENCODE_TEST_DATA) {
    test(JSON.stringify(dequoted), () => {
      expect([...bytesEncode(dequoted)]).toEqual([...expected]);
    });
  }
});

describe("bytesDecode — test_decode_bytes", () => {
  for (const [expected, encoded] of BYTES_ENCODE_TEST_DATA) {
    test(JSON.stringify(expected), () => {
      expect(bytesDecode(Uint8Array.from(encoded))).toBe(expected);
    });
  }
});

describe("enquoteBytes — test_enquote_bytes", () => {
  for (const [expected, dequoted] of ENQUOTE_BYTES_TEST_DATA) {
    test(JSON.stringify(expected), () => {
      expect(enquoteBytes(dequoted)).toBe(expected);
    });
  }
});

describe("dequoteBytes — test_dequote_bytes", () => {
  for (const [enquoted, expected] of DEQUOTE_BYTES_TEST_DATA) {
    test(JSON.stringify(enquoted), () => {
      expect(dequoteBytes(enquoted)).toBe(expected);
    });
  }
});

describe("enquoteString — test_enquote_string", () => {
  for (const [expected, dequoted] of ENQUOTE_STRING_TEST_DATA) {
    test(JSON.stringify(expected), () => {
      expect(enquoteString(dequoted)).toBe(expected);
    });
  }
});

describe("dequoteString — test_dequote_string", () => {
  for (const [enquoted, expected] of DEQUOTE_STRING_TEST_DATA) {
    test(JSON.stringify(enquoted), () => {
      expect(dequoteString(enquoted)).toBe(expected);
    });
  }
});

describe("code points, not UTF-16 units", () => {
  // A `charCodeAt` loop would emit `\uD83D\uDE42` here: two escapes of two
  // values that are not characters.  pyk's table pins the correct spelling
  // (`test_dequote.py:109`), and Python cannot express the wrong one.
  test("an astral code point is one \\U escape", () => {
    const smiley = "\u{1F642}";
    expect(smiley.length).toBe(2);
    expect(Array.from(smiley).length).toBe(1);
    expect(enquoteString(smiley)).toBe("\\U0001f642");
    expect(enquoteString(smiley)).not.toContain("\\ud83d");
  });

  test("U+10FFFF, the largest code point, round-trips", () => {
    expect(enquoteString("\u{10FFFF}")).toBe("\\U0010ffff");
    expect(dequoteString("\\U0010ffff")).toBe("\u{10FFFF}");
  });

  test("BMP and astral text mix", () => {
    const s = "a\u{1F642}\u03B1\u{1F600}z";
    expect(enquoteString(s)).toBe("a\\U0001f642\\u03b1\\U0001f600z");
    expect(dequoteString(enquoteString(s))).toBe(s);
  });

  test("every pyk string case round-trips", () => {
    for (const [, decoded] of ENQUOTE_STRING_TEST_DATA) {
      expect(dequoteString(enquoteString(decoded))).toBe(decoded);
    }
  });

  test("every pyk bytes case round-trips", () => {
    for (const [, decoded] of ENQUOTE_BYTES_TEST_DATA) {
      expect(dequoteBytes(enquoteBytes(decoded))).toBe(decoded);
      expect(bytesDecode(bytesEncode(decoded))).toBe(decoded);
    }
  });
});

/**
 * `StringUtilTest.StringUtilUnquote` (`StringUtilTest.java:11-34`), minus the
 * surrounding quotes it passes to `unquoteKString`.
 */
describe("Java frontend: StringUtilTest", () => {
  const accepted: readonly (readonly [string, string])[] = [
    ["\\n", "\n"],
    ["\\r", "\r"],
    ["\\f", "\f"],
    ["\\t", "\t"],
    ["\\x20", " "],
    ["\\u0020", " "],
    ["\\U00000020", " "],
  ];

  for (const [enquoted, expected] of accepted) {
    test(`accepts ${JSON.stringify(enquoted)}`, () => {
      expect(dequoteString(enquoted)).toBe(expected);
    });
  }

  // pyk agrees on the first (`chr()` raises above U+10FFFF) and not on the
  // second, whose lone surrogate `chr()` produces happily — see the divergence
  // note in `src/escape.ts`.
  test("rejects \\U00110000, out of range", () => {
    expect(() => dequoteString("\\U00110000")).toThrow(EscapeError);
  });

  test("rejects \\U0000d801, a surrogate", () => {
    expect(() => dequoteString("\\U0000d801")).toThrow(EscapeError);
  });
});

describe("dequote rejects", () => {
  const bad: readonly (readonly [string, string])[] = [
    ["unknown escape", "\\q"],
    ["C-only \\a", "\\a"],
    ["C-only \\v", "\\v"],
    ["C-only \\b", "\\b"],
    ["C-only \\'", "\\'"],
    ["octal, which K has no grammar for", "\\101"],
    ["lone trailing backslash", "abc\\"],
    ["truncated \\x", "\\x1"],
    ["truncated \\u", "\\u123"],
    ["truncated \\U", "\\U0001f64"],
    ["non-hex digit in \\x", "\\xg1"],
    ["non-hex digit in \\u", "\\u03z1"],
    ["non-ASCII digit in \\x", "\\x\uFF10\uFF10"],
    ["high surrogate", "\\ud800"],
    ["low surrogate", "\\U0000dfff"],
    ["above U+10FFFF", "\\Uffffffff"],
  ];

  for (const [why, text] of bad) {
    test(`${why}: ${JSON.stringify(text)}`, () => {
      expect(() => dequoteString(text)).toThrow(EscapeError);
      expect(() => dequoteBytes(text)).toThrow(EscapeError);
    });
  }

  test("an unknown escape is rejected, not silently unbackslashed", () => {
    expect(() => dequoteString("\\q")).toThrow("Unexpected escape sequence: \\q");
  });

  test("bytes mode additionally rejects \\u and \\U", () => {
    expect(dequoteString("\\u03b1")).toBe("\u03B1");
    expect(dequoteString("\\U0001f642")).toBe("\u{1F642}");
    expect(() => dequoteBytes("\\u03b1")).toThrow("Unicode escape sequence not allowed: \\u");
    expect(() => dequoteBytes("\\U0001f642")).toThrow("Unicode escape sequence not allowed: \\U");
  });
});

describe("enquote rejects", () => {
  test("an unpaired high surrogate", () => {
    expect(() => enquoteString("\uD800")).toThrow(EscapeError);
  });

  test("an unpaired low surrogate", () => {
    expect(() => enquoteString("a\uDFFFb")).toThrow(EscapeError);
  });

  test("bytes mode rejects anything above U+00FF", () => {
    expect(() => enquoteBytes("\u0100")).toThrow(EscapeError);
    expect(() => enquoteBytes("\u{1F642}")).toThrow(EscapeError);
    expect(() => enquoteBytes("\u03B1")).toThrow("Unicode character not allowed");
  });
});

describe("EscapeError positions", () => {
  const cases: readonly (readonly [string, () => unknown, number])[] = [
    ["bad hex digit points at the digit", () => dequoteString("ab\\xg1"), 4],
    ["unknown escape points at the letter", () => dequoteString("ab\\q"), 3],
    ["a bad code point value points at its backslash", () => dequoteString("ab\\U00110000"), 2],
    ["an incomplete escape points past the end", () => dequoteString("ab\\"), 3],
    ["an incomplete code point points past the end", () => dequoteString("ab\\x1"), 5],
    ["a rejected character points at the character", () => enquoteBytes("ab\u0100"), 2],
    // Astral text ahead of the failure shifts the index by two units, not one.
    ["indices are UTF-16 units", () => enquoteString("\u{1F642}\uD800"), 2],
    ["latin-1 encoding points at the code unit", () => bytesEncode("ab\u0100"), 2],
  ];

  for (const [why, thunk, position] of cases) {
    test(why, () => {
      expect(thunk).toThrow(EscapeError);
      try {
        thunk();
      } catch (e) {
        expect(e).toBeInstanceOf(EscapeError);
        if (e instanceof EscapeError) {
          expect(e.position).toBe(position);
          expect(e.name).toBe("EscapeError");
        }
      }
    });
  }
});

describe("boundaries of the literal range", () => {
  // `dequote.py:112` — 32..126 inclusive pass through; 31 (US) and 127 (DEL)
  // do not.
  const cases: readonly (readonly [string, string])[] = [
    ["\u001F", "\\x1f"],
    [" ", " "],
    ["~", "~"],
    ["\u007F", "\\x7f"],
    ["\u00FF", "\\xff"],
    ["\u0100", "\\u0100"],
    ["\uFFFF", "\\uffff"],
    ["\u{10000}", "\\U00010000"],
  ];

  for (const [text, expected] of cases) {
    test(JSON.stringify(text), () => {
      expect(enquoteString(text)).toBe(expected);
    });
  }
});

describe("bytesEncode / bytesDecode", () => {
  test("latin-1, one code unit per byte", () => {
    expect([...bytesEncode("\u0000A\u00FF")]).toEqual([0, 65, 255]);
    expect(bytesDecode(Uint8Array.from([0, 65, 255]))).toBe("\u0000A\u00FF");
  });

  test("rejects anything above U+00FF", () => {
    expect(() => bytesEncode("\u0100")).toThrow(EscapeError);
    expect(() => bytesEncode("\u03B1")).toThrow(EscapeError);
    // Not paired up first: the surrogate halves are what the check sees.
    expect(() => bytesEncode("\u{1F642}")).toThrow(EscapeError);
  });

  test("every byte round-trips", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect([...bytesEncode(bytesDecode(bytes))]).toEqual([...bytes]);
  });

  test("the whole latin-1 alphabet survives the bytes codec", () => {
    const s = bytesDecode(Uint8Array.from({ length: 256 }, (_, i) => i));
    expect(dequoteBytes(enquoteBytes(s))).toBe(s);
  });

  test("decodes a value larger than the argument limit of String.fromCharCode", () => {
    // `bytesDecode` chunks for exactly this reason; spreading 200_000
    // arguments would be a `RangeError`.
    const big = new Uint8Array(200_000).fill(0xfe);
    expect(bytesDecode(big).length).toBe(200_000);
    expect(bytesDecode(big).codePointAt(199_999)).toBe(0xfe);
  });
});

describe("hex case", () => {
  test("decoding accepts both cases", () => {
    expect(dequoteString("\\x0F")).toBe("\u000F");
    expect(dequoteString("\\u03B1")).toBe("\u03B1");
    expect(dequoteString("\\U0001F642")).toBe("\u{1F642}");
  });

  test("encoding emits lowercase", () => {
    expect(enquoteString(dequoteString("\\x0F"))).toBe("\\x0f");
    expect(enquoteString(dequoteString("\\u03B1"))).toBe("\\u03b1");
    expect(enquoteString(dequoteString("\\U0001F642"))).toBe("\\U0001f642");
  });
});
