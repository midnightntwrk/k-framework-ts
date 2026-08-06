/**
 * The lexer suite.
 *
 * The acceptance bar is pyk's own table, transcribed verbatim:
 * `k/pyk/src/tests/unit/kore/test_lexer.py` — 14 token-sequence cases
 * (`PASS_TEST_DATA`, `test_lexer.py:11-28`) and 7 rejection cases
 * (`test_lexer.py:39`).  Everything after that tests the one thing pyk's lexer
 * does not have and ours does: positions, including the `\r` policy this
 * package had to choose (see the header of `src/lexer.ts`).
 */

import { describe, expect, test } from "bun:test";
import { KoreLexer, koreLexer, KoreSyntaxError, TOKEN_TYPES, type TokenType } from "../src/lexer.ts";

/** Token types only, in order, `EOF` included — what pyk's `test_lexer_success` compares. */
function types(text: string): TokenType[] {
  return [...koreLexer(text)].map((token) => token.type);
}

//////////////////////
// Taxonomy         //
//////////////////////

describe("token taxonomy", () => {
  test("has pyk's 45 members", () => {
    // `lexer.py:11-56` is `EOF = 0` followed by 44 `auto()`s: `EOF`, `COMMA`,
    // `COLON`, `WALRUS`, the six brackets, `STRING`, `ID`, `SYMBOL_ID` and
    // `SET_VAR_ID` make 14, plus 20 `ML_*` and 11 `KW_*`.
    expect(TOKEN_TYPES).toHaveLength(45);
    expect(new Set(TOKEN_TYPES).size).toBe(45);
  });

  test("20 ML connectives and 11 keywords", () => {
    expect(TOKEN_TYPES.filter((t) => t.startsWith("ML_"))).toHaveLength(20);
    expect(TOKEN_TYPES.filter((t) => t.startsWith("KW_"))).toHaveLength(11);
  });
});

//////////////////////
// pyk's table      //
//////////////////////

/** `test_lexer.py:11-28` `PASS_TEST_DATA`, in order. */
const PASS_TEST_DATA: readonly (readonly [string, TokenType[]])[] = [
  ["", []],
  [" ", []],
  ["//", []],
  ["/**/", []],
  ["/*///***/", []],
  ["/* comment */", []],
  ["xyz", ["ID"]],
  ["x-y'z", ["ID"]],
  ["   xyz\n", ["ID"]],
  ["\\xyz", ["SYMBOL_ID"]],
  ["@xyz", ["SET_VAR_ID"]],
  ["module", ["KW_MODULE"]],
  ["a b c", ["ID", "ID", "ID"]],
  ["sort Map{K, V} []", ["KW_SORT", "ID", "LBRACE", "ID", "COMMA", "ID", "RBRACE", "LBRACK", "RBRACK"]],
];

describe("pyk PASS_TEST_DATA", () => {
  test.each(PASS_TEST_DATA)("%j", (text, expected) => {
    expect(types(text)).toEqual([...expected, "EOF"]);
  });
});

/** `test_lexer.py:39` — the seven inputs pyk's lexer raises on. */
const FAIL_TEST_DATA: string[] = ["-a", "'a", "*", "/*", "\\", "@", "\\@"];

describe("pyk failure table", () => {
  test.each(FAIL_TEST_DATA)("%j is rejected", (text) => {
    expect(() => types(text)).toThrow(KoreSyntaxError);
  });
});

describe("failure detail", () => {
  test("an unknown character names itself", () => {
    // pyk: `Unexpected character: -`. Ours adds the position, in the reference
    // parser's own spelling (`fixtures/parser/test-exception-5.kore.golden`).
    expect(() => types("-a")).toThrow("1:1: unexpected character '-'");
  });

  test("an unterminated block comment is an end-of-input error", () => {
    expect(() => types("/*")).toThrow("1:3: unexpected end of input");
  });

  test("a lone backslash wants a letter", () => {
    expect(() => types("\\")).toThrow("1:2: unexpected end of input");
    expect(() => types("\\@")).toThrow("1:2: unexpected character '@'");
  });

  test("`/` must introduce a comment", () => {
    // `test-exception-27.kore.golden`: the position is the character *after*
    // the slash, not the slash.
    expect(() => types("/a")).toThrow("1:2: unexpected character 'a'");
  });
});

//////////////////////
// Strings          //
//////////////////////

describe("string literals", () => {
  test("are captured raw, quotes included", () => {
    // pyk `_string` (`lexer.py:213-223`): no decoding here.
    const [token] = [...koreLexer(String.raw`"a\n\x41α\U0001f642\"\\"`)];
    expect(token?.type).toBe("STRING");
    expect(token?.text).toBe(String.raw`"a\n\x41α\U0001f642\"\\"`);
  });

  test("hex escapes have exact widths", () => {
    // `test-string-5.kore` passes upstream: `\x77` is `w`, and `77` is two more
    // characters of the literal.
    expect(types(String.raw`"\x7777"`)).toEqual(["STRING", "EOF"]);
  });

  test("an unknown escape is rejected at the escape character", () => {
    // `test-string-4.kore.golden`: `test-string-4.kore:1:10: unexpected character '0'`.
    expect(() => types(String.raw`("\07777")`)).toThrow("1:4: unexpected character '0'");
  });

  test("a truncated hex escape is rejected at the missing digit", () => {
    expect(() => types(String.raw`"\u03"`)).toThrow("1:6: unexpected character '\"'");
  });

  test("a raw newline may not appear in a literal", () => {
    // `test-exception-3.kore.golden`: the reference stops at the newline rather
    // than running to end of input, which is why this validation lives in the
    // lexer and not in `dequoteString`.
    expect(() => types('"X:S []\n')).toThrow("1:8: unexpected character '\\n'");
  });

  test("a raw carriage return may not appear in a literal either", () => {
    expect(() => types('"X\r"')).toThrow("1:3: unexpected character '\\r'");
  });

  test("an unterminated literal at end of input is an end-of-input error", () => {
    expect(() => types('"abc')).toThrow("1:5: unexpected end of input");
  });
});

//////////////////////
// Positions        //
//////////////////////

/** `line:col` of every token but the terminal `EOF`. */
function positions(text: string): string[] {
  return [...koreLexer(text)].filter((t) => t.type !== "EOF").map((t) => `${t.line}:${t.col}`);
}

describe("positions", () => {
  test("start at 1:1", () => {
    expect(positions("a")).toEqual(["1:1"]);
  });

  test("advance one column per character", () => {
    expect(positions("a bb  ccc")).toEqual(["1:1", "1:3", "1:7"]);
  });

  test("reset on a newline", () => {
    expect(positions("a\nbb\n\nc")).toEqual(["1:1", "2:1", "4:1"]);
  });

  test("count a tab as one column", () => {
    // A divergence from Alex, which advances to the next 8-column tab stop
    // (`Lexer.x:271`); see the header of `src/lexer.ts`. Only
    // `fixtures/parser/test-scanner-1.kore` contains tabs and it parses
    // cleanly, so no asserted position depends on the choice.
    expect(positions("\ta\tb")).toEqual(["1:2", "1:4"]);
  });

  test("skip over a line comment", () => {
    expect(positions("a // comment\nb")).toEqual(["1:1", "2:1"]);
  });

  test("skip over a block comment, newlines inside it included", () => {
    expect(positions("a /* one\ntwo */ b")).toEqual(["1:1", "2:8"]);
  });

  test("address a token's first character", () => {
    const tokens = [...koreLexer("  sort Map{K}")];
    expect(tokens.map((t) => [t.type, t.line, t.col])).toEqual([
      ["KW_SORT", 1, 3],
      ["ID", 1, 8],
      ["LBRACE", 1, 11],
      ["ID", 1, 12],
      ["RBRACE", 1, 13],
      ["EOF", 1, 14],
    ]);
  });

  test("survive a multi-line definition", () => {
    const text = "[]\n\nmodule M\n  sort S{} []\nendmodule []\n";
    const sortToken = [...koreLexer(text)].find((t) => t.type === "KW_SORT");
    expect(sortToken).toEqual({ type: "KW_SORT", text: "sort", line: 4, col: 3 });
  });
});

//////////////////////
// CRLF             //
//////////////////////

describe("CRLF", () => {
  // The decision, documented in the header of `src/lexer.ts`: `\r` is ordinary
  // whitespace and does not start a line — Alex's `alexMove` (`Lexer.x:270-274`)
  // treats it the same way. scala-kore crashes on CRLF input; pyk has no notion
  // of lines to get wrong.
  const lf = "module M\n  sort S{} []\nendmodule []\n";
  const crlf = lf.replaceAll("\n", "\r\n");

  test("lexes identically to LF", () => {
    expect(types(crlf)).toEqual(types(lf));
  });

  test("reports identical positions to LF", () => {
    expect(positions(crlf)).toEqual(positions(lf));
  });

  test("a lone CR separates tokens without starting a line", () => {
    // Nobody emits classic-Mac line endings; this pins the behaviour rather
    // than endorsing it. The columns keep counting through the `\r`.
    expect(positions("a\rb")).toEqual(["1:1", "1:3"]);
  });
});

//////////////////////
// Streaming        //
//////////////////////

describe("KoreLexer", () => {
  test("keeps returning EOF once exhausted", () => {
    const lexer = new KoreLexer("a");
    expect(lexer.next().type).toBe("ID");
    expect(lexer.next().type).toBe("EOF");
    expect(lexer.next().type).toBe("EOF");
  });

  test("classifies `\\`-prefixed heads", () => {
    // pyk `_symbol_or_ml_conn` (`lexer.py:182-197`): the ML table first, then
    // `SYMBOL_ID`. `\\ands` is not `\\and`.
    expect(types("\\and \\ands \\left-assoc \\right-assoc")).toEqual([
      "ML_AND",
      "SYMBOL_ID",
      "ML_LEFT_ASSOC",
      "ML_RIGHT_ASSOC",
      "EOF",
    ]);
  });

  test("recognises keywords only as whole identifiers", () => {
    expect(types("sort sorts hooked-sort hooked-sorts")).toEqual(["KW_SORT", "ID", "KW_HOOKED_SORT", "ID", "EOF"]);
  });

  test("splits `:` from `:=`", () => {
    expect(types(": := ::=")).toEqual(["COLON", "WALRUS", "COLON", "WALRUS", "EOF"]);
  });

  test("is not confused by `constructor` and friends", () => {
    // Every table in the lexer is a `Map`: `{}['constructor']` is `Object`, and
    // four vendored fixtures declare a symbol called `constructor`.
    expect(types("constructor toString valueOf")).toEqual(["ID", "ID", "ID", "EOF"]);
  });
});
