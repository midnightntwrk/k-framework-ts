/**
 * The textual-KAST lexer.
 *
 * `TEST_DATA` is pyk's `tests/unit/kast/test_lexer.py:13-61` transcribed row for
 * row — same 32 inputs in the same order, same expected token lists, with pyk's
 * implicit trailing `Token('', EOF)` added by the runner exactly as
 * `test_lexer.py:67` adds it.
 *
 * Everything after that describes behaviour pyk's table does not reach: the
 * positions this lexer adds, the error messages it raises (upstream has no
 * lexical-error cases at all), and the one deliberate divergence documented in
 * `src/lexer.ts`'s header.
 */

import { describe, expect, test } from "bun:test";
import { KastSyntaxError, lexKast, TOKEN_TYPES, type TokenType } from "../src/lexer.ts";

/** `(text, type)` pairs, in pyk's `Token` field order. */
type Expected = readonly (readonly [string, TokenType])[];

/** What `list(lexer(text))` compares against: the tokens, then `EOF`. */
function lex(text: string): (readonly [string, TokenType])[] {
  return lexKast(text).map((token) => [token.text, token.type] as const);
}

const EOF = ["", "EOF"] as const;

/** Run `body`, returning whatever it threw. The narrowing form `toThrow` cannot express. */
function catchError(body: () => unknown): unknown {
  try {
    body();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a throw, got none");
}

//////////////////////////////
// test_lexer.py:13-61      //
//////////////////////////////

const TEST_DATA: readonly (readonly [string, Expected])[] = [
  ["", []],
  ["\n", []],
  ["(", [["(", "LPAREN"]]],
  [")", [[")", "RPAREN"]]],
  [",", [[",", "COMMA"]]],
  ["~>", [["~>", "KSEQ"]]],
  [".K", [[".K", "DOTK"]]],
  [".KList", [[".KList", "DOTKLIST"]]],
  ["``", [["``", "KLABEL"]]],
  ["`\\x`", [["`\\x`", "KLABEL"]]],
  ["`\\``", [["`\\``", "KLABEL"]]],
  ["`foo`", [["`foo`", "KLABEL"]]],
  ['""', [['""', "STRING"]]],
  ['"\\x"', [['"\\x"', "STRING"]]],
  ['"\\""', [['"\\""', "STRING"]]],
  ['"foo"', [['"foo"', "STRING"]]],
  ["foo", [["foo", "ID"]]],
  ["#foo", [["#foo", "ID"]]],
  ["#token", [["#token", "TOKEN"]]],
  ["fO0", [["fO0", "ID"]]],
  ["_", [["_", "VARIABLE"]]],
  ["?_", [["?_", "VARIABLE"]]],
  ["X", [["X", "VARIABLE"]]],
  ["?X", [["?X", "VARIABLE"]]],
  ["_X", [["_X", "VARIABLE"]]],
  ["?_X", [["?_X", "VARIABLE"]]],
  ["Foo", [["Foo", "VARIABLE"]]],
  ["?Foo", [["?Foo", "VARIABLE"]]],
  ["_Foo", [["_Foo", "VARIABLE"]]],
  ["?_Foo", [["?_Foo", "VARIABLE"]]],
  [
    "X:Int",
    [
      ["X", "VARIABLE"],
      [":", "COLON"],
      ["Int", "SORT"],
    ],
  ],
  [
    '`_+_`(#token("1", "Int"), X)',
    [
      ["`_+_`", "KLABEL"],
      ["(", "LPAREN"],
      ["#token", "TOKEN"],
      ["(", "LPAREN"],
      ['"1"', "STRING"],
      [",", "COMMA"],
      ['"Int"', "STRING"],
      [")", "RPAREN"],
      [",", "COMMA"],
      ["X", "VARIABLE"],
      [")", "RPAREN"],
    ],
  ],
];

describe("test_lexer.py", () => {
  for (const [text, output] of TEST_DATA) {
    test(JSON.stringify(text), () => {
      expect(lex(text)).toEqual([...output, EOF]);
    });
  }
});

//////////////////////////////
// The token taxonomy       //
//////////////////////////////

describe("token types", () => {
  test("there are exactly 14, in lexer.py's order", () => {
    // `lexer.py:12-26`.
    expect(TOKEN_TYPES).toEqual([
      "EOF",
      "LPAREN",
      "RPAREN",
      "COMMA",
      "COLON",
      "KSEQ",
      "DOTK",
      "DOTKLIST",
      "TOKEN",
      "ID",
      "VARIABLE",
      "SORT",
      "KLABEL",
      "STRING",
    ]);
  });

  test("SORT is reachable only right after a COLON", () => {
    // `_STATE` (`lexer.py:263-265`): the state resets to DEFAULT after every
    // other token, so the second `Int` here is a VARIABLE, not a SORT.
    expect(lex("X:Int~>Int")).toEqual([
      ["X", "VARIABLE"],
      [":", "COLON"],
      ["Int", "SORT"],
      ["~>", "KSEQ"],
      ["Int", "VARIABLE"],
      EOF,
    ]);
  });

  test("a sort must start with an uppercase letter", () => {
    // The SORT sublexer has exactly one entry (`lexer.py:259`).
    expect(() => lex("X:int")).toThrow("1:3: Unexpected character: 'i'");
  });

  test("#token is the only reserved ID", () => {
    // `lexer.py:159-161`.
    expect(lex("#tokens")).toEqual([["#tokens", "ID"], EOF]);
    expect(lex("#toke")).toEqual([["#toke", "ID"], EOF]);
  });

  test("an ID's tail excludes the variable characters", () => {
    // `_ID_CHARS` (`lexer.py:144`) has neither `_` nor `'`, while
    // `_VARIABLE_CHARS` (`lexer.py:164`) has both.  So `foo_bar` is an ID
    // followed by a VARIABLE, and a trailing `'` is not lexable at all.
    // A lowercase letter after `_` does not continue the variable either
    // (`lexer.py:194-202` only takes `[A-Z]` there), so this is three tokens.
    // pyk gets `foo` `_` `ar`: the discard below eats the `b`.
    expect(lex("foo_bar")).toEqual([["foo", "ID"], ["_", "VARIABLE"], ["bar", "ID"], EOF]);
    expect(lex("Foo_bar'")).toEqual([["Foo_bar'", "VARIABLE"], EOF]);
    expect(() => lex("foo'")).toThrow('Unexpected character: "\'"');
  });
});

//////////////////////////////
// Positions                 //
//////////////////////////////

describe("positions", () => {
  test("every token carries the 1-based position of its first character", () => {
    // An addition to pyk, which has no positions at all.
    const tokens = lexKast('`_+_`(#token("1", "Int"), X)').map((t) => [t.text, t.line, t.col]);
    expect(tokens).toEqual([
      ["`_+_`", 1, 1],
      ["(", 1, 6],
      ["#token", 1, 7],
      ["(", 1, 13],
      ['"1"', 1, 14],
      [",", 1, 17],
      ['"Int"', 1, 19],
      [")", 1, 24],
      [",", 1, 25],
      ["X", 1, 27],
      [")", 1, 28],
      ["", 1, 29],
    ]);
  });

  test("only a newline starts a new line", () => {
    const tokens = lexKast("a\n  b\r\n c").map((t) => [t.text, t.line, t.col]);
    expect(tokens).toEqual([
      ["a", 1, 1],
      ["b", 2, 3],
      ["c", 3, 2],
      ["", 3, 3],
    ]);
  });

  test("a CRLF file lexes identically to the same file with LF endings", () => {
    expect(lex("a(.KList)\r\n~>\r\nb(.KList)")).toEqual(lex("a(.KList)\n~>\nb(.KList)"));
  });

  test("the error carries line, col and pyk's bare message", () => {
    const thrown = catchError(() => lex("a(.KList)\n~> ="));
    expect(thrown).toBeInstanceOf(KastSyntaxError);
    if (!(thrown instanceof KastSyntaxError)) return;
    expect(thrown.line).toBe(2);
    expect(thrown.col).toBe(4);
    expect(thrown.description).toBe("Unexpected character: '='");
    expect(thrown.message).toBe("2:4: Unexpected character: '='");
    expect(thrown).toBeInstanceOf(SyntaxError);
  });
});

//////////////////////////////
// Errors                    //
//////////////////////////////

/**
 * pyk's table has no failing input, so these were run against pyk itself: every
 * `description` below is the `ValueError` message pyk raises, verbatim.
 */
describe("errors", () => {
  const CASES: readonly (readonly [string, string])[] = [
    // `_unexpected_char(actual)` — `lexer.py:51-54, 86-88`.
    ["=", "Unexpected character: '='"],
    ["<", "Unexpected character: '<'"],
    ["\\", "Unexpected character: '\\\\'"],
    ["{", "Unexpected character: '{'"],
    ["0", "Unexpected character: '0'"],
    ["'", 'Unexpected character: "\'"'],
    // `_kseq` — `lexer.py:135-141`.
    ["~x", "Expected '>', got: 'x'"],
    ["~", "Expected '>', got: <EOF>"],
    // `_dotk_or_dotklist` — `lexer.py:218-232`. `.KA` is the case the `_SEP`
    // trick gives up, and `lexer.py:212-214` says so.
    [".x", "Expected 'K', got: 'x'"],
    [".", "Expected 'K', got: <EOF>"],
    [".KA", "Expected 'L', got: 'A'"],
    [".KLis", "Expected 't', got: <EOF>"],
    [".KLista", "Unexpected character: 'a'"],
    // `_variable` state 0 — `lexer.py:183-189`.
    ["?x", "Unexpected character: 'x'"],
    ["?", "Unexpected character: ''"],
    // `_delimited` — `lexer.py:112-113, 123-124`.
    ['"', "Unexpected end of file"],
    ['"abc', "Unexpected end of file"],
    ['"abc\\', "Unexpected end of file"],
    ["`", "Unexpected end of file"],
    ["`abc", "Unexpected end of file"],
  ];

  for (const [text, description] of CASES) {
    test(`${JSON.stringify(text)} → ${description}`, () => {
      const thrown = catchError(() => lex(text));
      expect(thrown).toBeInstanceOf(KastSyntaxError);
      if (!(thrown instanceof KastSyntaxError)) return;
      expect(thrown.description).toBe(description);
    });
  }
});

//////////////////////////////
// Divergence from pyk       //
//////////////////////////////

/**
 * `lexer.py:194-202` discards one character of lookahead after a `_` or `?_`
 * that is not followed by an uppercase letter.  We do not; see `src/lexer.ts`'s
 * header for why.  Each case below records what pyk does in the comment.
 */
describe("a bare `_` does not eat the character after it", () => {
  test("f(_) is a term here and a truncated stream in pyk", () => {
    // pyk: `f ( _ <EOF>` — the `)` is gone, and the parser then fails.
    expect(lex("f(_)")).toEqual([["f", "ID"], ["(", "LPAREN"], ["_", "VARIABLE"], [")", "RPAREN"], EOF]);
  });

  test("_~>X is a sequence here and a lexical error in pyk", () => {
    // pyk: the `~` is discarded, leaving `>` — `Unexpected character: '>'`.
    expect(lex("_~>X")).toEqual([["_", "VARIABLE"], ["~>", "KSEQ"], ["X", "VARIABLE"], EOF]);
  });

  test("_,X keeps its comma", () => {
    // pyk: `_ X <EOF>`.
    expect(lex("_,X")).toEqual([["_", "VARIABLE"], [",", "COMMA"], ["X", "VARIABLE"], EOF]);
  });

  test("?_ behaves the same way, from state 0", () => {
    // pyk: `?_ X <EOF>`.
    expect(lex("?_,X")).toEqual([["?_", "VARIABLE"], [",", "COMMA"], ["X", "VARIABLE"], EOF]);
  });

  test("the streams agree wherever pyk discards whitespace", () => {
    // `lexer.py:199-200` fires here too, but on the space, which the main loop
    // would have skipped anyway.
    expect(lex("_ ~> X")).toEqual([["_", "VARIABLE"], ["~>", "KSEQ"], ["X", "VARIABLE"], EOF]);
  });

  test("__ is two variables, not one", () => {
    // pyk: `_ <EOF>` — the second `_` vanishes and `__` parses as `_`.
    expect(lex("__")).toEqual([["_", "VARIABLE"], ["_", "VARIABLE"], EOF]);
  });

  test("nothing changes when an uppercase letter follows", () => {
    expect(lex("_Foo,X")).toEqual([["_Foo", "VARIABLE"], [",", "COMMA"], ["X", "VARIABLE"], EOF]);
  });
});
