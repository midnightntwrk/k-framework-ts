/**
 * The outer lexer, held to pyk's own two corpora.
 *
 * Three layers, in the order a failure is easiest to read:
 *
 * 1. **The 125 sublexer cases** extracted from `test_outer_lexer.py`'s inline
 *    tables (`fixtures/pyk-unit/outer-lexer-*.json`).  Each table drives the
 *    *same internal function* upstream's test does — `_maybe_comment`,
 *    `_default`, `_modname`, `_klabel`, `_bubble_or_context`, `_attr` — with a
 *    lookahead and an iterator, and asserts both the tokens and the input left
 *    over.  That "left over" is `la + ''.join(it)` upstream, and
 *    {@link LocationIterator.rest} is the second half of it; reproducing it is
 *    what makes these tests test the *protocol* between the sublexers rather
 *    than just their output.
 * 2. **The 37 golden files** (`fixtures/outer-lexer/*.test`, 9,283 tokens)
 *    through {@link outerLexer} end to end, every token's text, type, line and
 *    column.  `domains-*.test` is K's real `domains.md`, so this is a
 *    production-scale test disguised as a unit test.
 * 3. **The invariant** every one of those tokens must satisfy
 *    (`test_outer_lexer.py:647-651`): a token's recorded location must actually
 *    locate its text in the source.  Run over the lexer's output here, where
 *    `fixtures.test.ts` runs it over the vendored expectations.
 *
 * Then the named contract items that are ours rather than pyk's: the three
 * keywords whose upstream `KeyError` we turn into a real error, and the two
 * states that report an unterminated block comment.
 */

import { describe, expect, test } from "bun:test";
import {
  INIT_LOC,
  KParseError,
  LocationIterator,
  NEXT_STATE_TABLE,
  TOKEN_TYPES,
  UNSUPPORTED_KEYWORDS,
  lexAttr,
  lexBubbleOrContext,
  lexDefault,
  lexKlabel,
  lexModname,
  locAdd,
  maybeComment,
  nextLexerState,
  outerLexer,
  type Loc,
  type Token,
  type TokenType,
} from "../src/lexer.ts";
import {
  OUTER_LEXER,
  OUTER_TOKEN_TYPES,
  listFixtures,
  parseLexerTest,
  readFixture,
  readPykUnitTable,
  tokensWithBadLocations,
  type FixtureToken,
} from "./fixtures.ts";

//////////////////////////////
// Reading the JSON tables  //
//////////////////////////////

/** Narrows JSON to an object without a type assertion, as `fixtures.test.ts` does. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The same, as a throwing accessor. */
function objectAt(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${what} is not an object: ${JSON.stringify(value)}`);
  return value;
}

/** `value` as a string, throwing when it is not one. */
function stringAt(value: unknown, what: string): string {
  if (typeof value !== "string") throw new TypeError(`${what} is not a string: ${JSON.stringify(value)}`);
  return value;
}

/** `value` as a boolean, throwing when it is not one. */
function booleanAt(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${what} is not a boolean: ${JSON.stringify(value)}`);
  return value;
}

/** One of the 45 token-type names, checked against the enum rather than assumed. */
function tokenTypeAt(value: unknown, what: string): TokenType {
  const name = stringAt(value, what);
  const type = TOKEN_TYPES.find((candidate) => candidate === name);
  if (type === undefined) throw new TypeError(`${what} is not a TokenType: ${name}`);
  return type;
}

/**
 * A `Token` as the extractor encodes it: `{text, type, loc: [line, col]}`
 * (`fixtures/pyk-unit/extract-pyk-fixtures.py`, "Encoding").
 */
function tokenAt(value: unknown, what: string): Token {
  const obj = objectAt(value, what);
  const loc = obj["loc"];
  if (!Array.isArray(loc) || loc.length !== 2) {
    throw new TypeError(`${what}.loc is not a [line, col]: ${JSON.stringify(loc)}`);
  }
  const line: unknown = loc[0];
  const col: unknown = loc[1];
  if (typeof line !== "number" || typeof col !== "number") {
    throw new TypeError(`${what}.loc is not a [line, col]: ${JSON.stringify(loc)}`);
  }
  return {
    text: stringAt(obj["text"], `${what}.text`),
    type: tokenTypeAt(obj["type"], `${what}.type`),
    loc: { line, col },
  };
}

/** A list of them. */
function tokensAt(value: unknown, what: string): Token[] {
  if (!Array.isArray(value)) throw new TypeError(`${what} is not an array: ${JSON.stringify(value)}`);
  return value.map((item, index) => tokenAt(item, `${what}[${index}]`));
}

/** The cases of one extracted table, with the table's own name checked. */
function cases(file: string, table: string, expectedCount: number): readonly Record<string, unknown>[] {
  const read = readPykUnitTable(file);
  expect(read.table).toBe(table);
  expect(read.cases).toHaveLength(expectedCount);
  return read.cases;
}

/** A readable test name for a case whose input may be empty or multi-line. */
function caseName(text: string): string {
  return JSON.stringify(text);
}

//////////////////////////////
// Driving a sublexer       //
//////////////////////////////

/**
 * `it = LocationIterator(text); la = next(it, '')` — how every one of pyk's
 * sublexer tests starts.
 */
function start(text: string): [string, LocationIterator] {
  const it = new LocationIterator(text);
  return [it.next(), it];
}

/** `la + ''.join(it)` — the input a sublexer did not consume. */
function remaining(la: string, it: LocationIterator): string {
  return la + it.rest();
}

//////////////////////////////
// The taxonomy             //
//////////////////////////////

describe("TokenType", () => {
  test("is the 45 members of pyk's enum, in declaration order", () => {
    // `fixtures.ts` keeps its own copy so the fixtures stay readable without
    // `src/`; this is the assertion that the two never drift.
    expect(TOKEN_TYPES).toEqual(OUTER_TOKEN_TYPES);
    expect(TOKEN_TYPES).toHaveLength(45);
  });

  test("keeps PLUS, TIMES, QUESTION and TILDE, which nothing parses", () => {
    // Deliberate: they are in the upstream enum and in `_SIMPLE_CHARS`, so a
    // fixture may name them even though `parser.ts` accepts none of the four.
    const kept: TokenType[] = ["PLUS", "TIMES", "QUESTION", "TILDE"];
    for (const type of kept) expect(TOKEN_TYPES).toContain(type);
  });
});

describe("Loc", () => {
  test("starts at (1, 0) — the only time a column is 0", () => {
    expect(INIT_LOC).toEqual({ line: 1, col: 0 });
  });

  test("a newline takes the column after the previous character; the next character takes 1", () => {
    // `outer_lexer.py:65-75`: `col = 0` then `col += 1` for the `\n` itself.
    expect(locAdd(INIT_LOC, "ab")).toEqual({ line: 1, col: 2 });
    expect(locAdd(INIT_LOC, "ab\n")).toEqual({ line: 2, col: 1 });
    expect(locAdd(INIT_LOC, "ab\nc")).toEqual({ line: 2, col: 2 });
    expect(locAdd(INIT_LOC, "\n\n")).toEqual({ line: 3, col: 1 });
  });

  test("the iterator gives a newline the column after the previous character", () => {
    const it = new LocationIterator("a\nb");
    const seen: Loc[] = [];
    for (let i = 0; i < 3; i += 1) {
      it.next();
      seen.push(it.loc);
    }
    expect(seen).toEqual([
      { line: 1, col: 1 }, // 'a'
      { line: 1, col: 2 }, // the '\n' itself — not (2, 0)
      { line: 2, col: 1 }, // 'b'
    ]);
    // Past the end the position stays put: `next(it, '')` never runs the body
    // that would have moved it, which is what puts an `EOF` token on the last
    // real character.
    expect(it.next()).toBe("");
    expect(it.loc).toEqual({ line: 2, col: 1 });
  });

  test("locAdd walks from one character's position to a later one's, over any text", () => {
    // The relation the bubble code depends on: given the position of character
    // `j` and the text from `j` up to `k`, `locAdd` gives the position of
    // character `k` — the same position the iterator reports when it gets
    // there.  (`INIT_LOC` is the one input that is not a character's position,
    // which is why it is stated separately above.)
    const text = "a\nbc\n\nd";
    const it = new LocationIterator(text);
    const positions: Loc[] = [];
    for (let i = 0; i < text.length; i += 1) {
      it.next();
      positions.push(it.loc);
    }
    for (let j = 0; j < text.length; j += 1) {
      for (let k = j + 1; k < text.length; k += 1) {
        expect(locAdd(positions[j]!, text.slice(j, k))).toEqual(positions[k]!);
      }
    }
  });
});

describe("_NEXT_STATE", () => {
  test("is the 35 rows of the upstream table", () => {
    expect(NEXT_STATE_TABLE).toHaveLength(35);
  });

  test("has no (DEFAULT, KW_ENDMODULE) row — endmodule outside a bubble is sticky", () => {
    expect(nextLexerState("DEFAULT", "KW_ENDMODULE")).toBeUndefined();
    expect(nextLexerState("BUBBLE", "KW_ENDMODULE")).toBe("DEFAULT");
  });

  test("has no (MODNAME, KW_PRIVATE/KW_PUBLIC) row — visibility keeps MODNAME armed", () => {
    expect(nextLexerState("MODNAME", "KW_PRIVATE")).toBeUndefined();
    expect(nextLexerState("MODNAME", "KW_PUBLIC")).toBeUndefined();
    expect(nextLexerState("MODNAME", "MODNAME")).toBe("DEFAULT");
  });

  test("ATTR is on neither side of the table", () => {
    // Entering is `(DEFAULT, LBRACK)`; leaving is unconditional, in the loop.
    expect(NEXT_STATE_TABLE.filter(([from, , to]) => from === "ATTR" || to === "ATTR")).toEqual([
      ["DEFAULT", "LBRACK", "ATTR"],
    ]);
  });
});

//////////////////////////////
// The extracted tables     //
//////////////////////////////

describe("_maybe_comment (COMMENT_TEST_DATA)", () => {
  for (const testCase of cases("outer-lexer-comment.json", "COMMENT_TEST_DATA", 9)) {
    const text = stringAt(testCase["text"], "text");
    const expectedSuccess = booleanAt(testCase["expectedSuccess"], "expectedSuccess");
    const expectedConsumed = stringAt(testCase["expectedConsumedText"], "expectedConsumedText");
    const expectedRemaining = stringAt(testCase["expectedRemaining"], "expectedRemaining");

    test(caseName(text), () => {
      const [la, it] = start(text);
      const [success, consumed, rest] = maybeComment(la, it);
      expect(success).toBe(expectedSuccess);
      expect(consumed).toBe(expectedConsumed);
      expect(remaining(rest, it)).toBe(expectedRemaining);
    });
  }
});

describe("_default (DEFAULT_TEST_DATA)", () => {
  for (const testCase of cases("outer-lexer-default.json", "DEFAULT_TEST_DATA", 28)) {
    const text = stringAt(testCase["text"], "text");
    const expectedToken = tokenAt(testCase["expectedToken"], "expectedToken");
    const expectedRemaining = stringAt(testCase["expectedRemaining"], "expectedRemaining");

    test(caseName(text), () => {
      const [la, it] = start(text);
      const [actual, rest] = lexDefault(la, it);
      expect(actual).toEqual(expectedToken);
      expect(remaining(rest, it)).toBe(expectedRemaining);
    });
  }
});

describe("_modname (MODNAME_TEST_DATA)", () => {
  for (const testCase of cases("outer-lexer-modname.json", "MODNAME_TEST_DATA", 10)) {
    const text = stringAt(testCase["text"], "text");
    const expectedToken = tokenAt(testCase["expectedToken"], "expectedToken");
    const expectedRemaining = stringAt(testCase["expectedRemaining"], "expectedRemaining");

    test(caseName(text), () => {
      const [la, it] = start(text);
      const [actual, rest] = lexModname(la, it);
      expect(actual).toEqual(expectedToken);
      expect(remaining(rest, it)).toBe(expectedRemaining);
    });
  }
});

describe("_klabel (KLABEL_TEST_DATA)", () => {
  for (const testCase of cases("outer-lexer-klabel.json", "KLABEL_TEST_DATA", 19)) {
    const text = stringAt(testCase["text"], "text");
    const expectedToken = tokenAt(testCase["expectedToken"], "expectedToken");
    const expectedRemaining = stringAt(testCase["expectedRemaining"], "expectedRemaining");

    test(caseName(text), () => {
      const [la, it] = start(text);
      const [actual, rest] = lexKlabel(la, it);
      expect(actual).toEqual(expectedToken);
      expect(remaining(rest, it)).toBe(expectedRemaining);
    });
  }
});

describe("_bubble_or_context (BUBBLE_TEST_DATA)", () => {
  for (const testCase of cases("outer-lexer-bubble.json", "BUBBLE_TEST_DATA", 42)) {
    const text = stringAt(testCase["text"], "text");
    const expectedTokens = tokensAt(testCase["expectedTokens"], "expectedTokens");
    const expectedRemaining = stringAt(testCase["expectedRemaining"], "expectedRemaining");

    test(caseName(text), () => {
      const [la, it] = start(text);
      const [actual, rest] = lexBubbleOrContext(la, it);
      expect(actual).toEqual(expectedTokens);
      expect(remaining(rest, it)).toBe(expectedRemaining);
    });
  }
});

describe("_bubble_or_context, context=True (CONTEXT_TEST_DATA)", () => {
  for (const testCase of cases("outer-lexer-context.json", "CONTEXT_TEST_DATA", 2)) {
    const text = stringAt(testCase["text"], "text");
    const expectedTokens = tokensAt(testCase["expectedTokens"], "expectedTokens");
    const expectedRemaining = stringAt(testCase["expectedRemaining"], "expectedRemaining");

    test(caseName(text), () => {
      const [la, it] = start(text);
      const [actual, rest] = lexBubbleOrContext(la, it, true);
      expect(actual).toEqual(expectedTokens);
      expect(remaining(rest, it)).toBe(expectedRemaining);
    });
  }
});

describe("_attr (ATTR_TEST_DATA)", () => {
  for (const testCase of cases("outer-lexer-attr.json", "ATTR_TEST_DATA", 15)) {
    const text = stringAt(testCase["text"], "text");
    const expectedTokens = tokensAt(testCase["expectedTokens"], "expectedTokens");
    const expectedRemaining = stringAt(testCase["expectedRemaining"], "expectedRemaining");

    test(caseName(text), () => {
      // Driven exactly as `test_attr` drives it: pull tokens until the
      // generator is done, and read the lookahead off the return value.
      const [la, it] = start(text);
      const generator = lexAttr(la, it);
      const actual: Token[] = [];
      let rest = "";
      for (;;) {
        const step = generator.next();
        if (step.done === true) {
          rest = step.value;
          break;
        }
        actual.push(step.value);
      }
      expect(actual).toEqual(expectedTokens);
      expect(remaining(rest, it)).toBe(expectedRemaining);
    });
  }
});

//////////////////////////////
// The golden files         //
//////////////////////////////

/** A lexed token in the shape `tokensWithBadLocations` wants. */
function asFixtureToken(t: Token): FixtureToken {
  return { text: t.text, type: t.type, loc: t.loc };
}

describe("outerLexer over the 37 golden files", () => {
  const names = listFixtures(OUTER_LEXER, ".test");

  test("there are 37 of them", () => {
    expect(names).toHaveLength(37);
  });

  for (const name of names) {
    test(name, () => {
      const golden = parseLexerTest(readFixture(OUTER_LEXER, name));
      const actual = [...outerLexer(golden.text)];

      // Compared as whole lists: a missing token shows up as a diff at the
      // point it went missing rather than as 400 shifted mismatches.
      expect(actual.map((t) => asFixtureToken(t))).toEqual([...golden.tokens]);

      // The stream always ends with EOF, and nothing follows it.
      expect(actual.at(-1)?.type).toBe("EOF");
    });
  }

  test("9,283 tokens in total", () => {
    let total = 0;
    for (const name of names) total += [...outerLexer(parseLexerTest(readFixture(OUTER_LEXER, name)).text)].length;
    expect(total).toBe(9283);
  });

  test("every token's location locates its text (test_outer_lexer.py:647-651)", () => {
    for (const name of names) {
      const golden = parseLexerTest(readFixture(OUTER_LEXER, name));
      const tokens = [...outerLexer(golden.text)].map((t) => asFixtureToken(t));
      expect({ [name]: tokensWithBadLocations({ text: golden.text, tokens }) }).toEqual({ [name]: [] });
    }
  });
});

//////////////////////////////
// Deliberate deviations    //
//////////////////////////////

/** The {@link KParseError} `run` throws, or a failure if it throws nothing. */
function thrownBy(run: () => void): KParseError {
  try {
    run();
  } catch (error) {
    if (error instanceof KParseError) return error;
    throw error;
  }
  throw new Error("expected a KParseError, nothing was thrown");
}

describe("the three keywords upstream crashes on", () => {
  test("the deviation list is exactly those three", () => {
    expect([...UNSUPPORTED_KEYWORDS]).toEqual([
      ["import", "imports"],
      ["require", "requires"],
      ["priorities", "priority"],
    ]);
  });

  test("'import' — KeyError upstream (_DEFAULT_KEYWORDS at outer_lexer.py:261)", () => {
    const error = thrownBy(() => void [...outerLexer("import FOO")]);
    expect(error.description).toBe("keyword 'import' is recognized but unsupported; use 'imports'");
    expect(error.message).toBe("1:1: keyword 'import' is recognized but unsupported; use 'imports'");
    expect([error.line, error.col]).toEqual([1, 1]);
  });

  test("'require' — KeyError upstream (_DEFAULT_KEYWORDS at outer_lexer.py:266)", () => {
    const error = thrownBy(() => void [...outerLexer('  require "domains.md"')]);
    expect(error.description).toBe("keyword 'require' is recognized but unsupported; use 'requires'");
    expect([error.line, error.col]).toEqual([1, 3]);
  });

  test("'syntax priorities' — KeyError upstream (_SYNTAX_KEYWORDS at outer_lexer.py:446)", () => {
    const error = thrownBy(() => void [...outerLexer("syntax priorities a > b")]);
    expect(error.description).toBe("keyword 'priorities' is recognized but unsupported; use 'priority'");
    expect([error.line, error.col]).toEqual([1, 8]);
  });

  test("the supported spellings still lex", () => {
    expect([...outerLexer("imports FOO")].map((t) => t.type)).toEqual(["KW_IMPORTS", "MODNAME", "EOF"]);
    expect([...outerLexer('requires "domains.md"')].map((t) => t.type)).toEqual(["KW_REQUIRES", "STRING", "EOF"]);
    expect([...outerLexer("syntax priority a > b")].map((t) => t.type)).toEqual([
      "KW_SYNTAX",
      "KW_PRIORITY",
      "KLABEL",
      "GT",
      "KLABEL",
      "EOF",
    ]);
  });
});

describe("errors carry a position pyk does not have", () => {
  test("'Unterminated block comment' in KLABEL state (outer_lexer.py:587)", () => {
    const error = thrownBy(() => void [...outerLexer("syntax priority a /* oops")]);
    expect(error.description).toBe("Unterminated block comment");
    expect(error.name).toBe("KParseError");
    expect(error).toBeInstanceOf(SyntaxError);
  });

  test("'Unterminated block comment' in BUBBLE state (outer_lexer.py:711)", () => {
    const error = thrownBy(() => void [...outerLexer("rule x /* oops")]);
    expect(error.description).toBe("Unterminated block comment");
    expect(error.message).toBe(`${error.line}:${error.col}: Unterminated block comment`);
  });

  test("a lone '/' is not an unterminated comment — only `len(consumed) > 1` is", () => {
    // `_maybe_comment` came back with just `['/']`, so the failure is reported
    // against the character *after* it, which is what upstream interpolates.
    expect(thrownBy(() => void [...outerLexer("module / M")]).description).toBe("Unexpected character: ' '");
    // And in a bubble the same `/` is ordinary text.
    expect([...outerLexer("rule /")].map((t) => t.text)).toEqual(["rule", "/", ""]);
  });

  test("Unexpected character / end of file / token keep pyk's wording", () => {
    expect(thrownBy(() => void [...outerLexer("module %")]).description).toBe("Unexpected character: '%'");
    expect(thrownBy(() => void [...outerLexer('requires "a')]).description).toBe("Unexpected end of file");
    expect(thrownBy(() => void [...outerLexer("syntax foo")]).description).toBe("Unexpected token: foo");
  });
});

//////////////////////////////
// Named contract items     //
//////////////////////////////

/** Just the `[text, type]` pairs, which is what most of these are about. */
function lexed(text: string): [string, TokenType][] {
  return [...outerLexer(text)].map((t) => [t.text, t.type]);
}

describe("bubble termination", () => {
  test("a keyword needs whitespace or a comment on both sides", () => {
    expect(lexed("rule arule")).toEqual([
      ["rule", "KW_RULE"],
      ["arule", "BUBBLE"],
      ["", "EOF"],
    ]);
    expect(lexed("rule cash rules")).toEqual([
      ["rule", "KW_RULE"],
      ["cash rules", "BUBBLE"],
      ["", "EOF"],
    ]);
  });

  test("a comment counts as the follower (runtimeverification/k#3501)", () => {
    expect(lexed("rule cash rule/**/s")).toEqual([
      ["rule", "KW_RULE"],
      ["cash", "BUBBLE"],
      ["rule", "KW_RULE"],
      ["s", "BUBBLE"],
      ["", "EOF"],
    ]);
  });

  test("interior comments survive in bubble text, flanking ones do not", () => {
    expect(lexed("rule hello/*2*/world")).toEqual([
      ["rule", "KW_RULE"],
      ["hello/*2*/world", "BUBBLE"],
      ["", "EOF"],
    ]);
    expect(lexed("rule /*1*/ hello /*2*/")).toEqual([
      ["rule", "KW_RULE"],
      ["hello", "BUBBLE"],
      ["", "EOF"],
    ]);
  });

  test("'alias' terminates a bubble only in CONTEXT state", () => {
    expect(lexed("context alias x")).toEqual([
      ["context", "KW_CONTEXT"],
      ["alias", "KW_ALIAS"],
      ["x", "BUBBLE"],
      ["", "EOF"],
    ]);
    expect(lexed("rule alias x")).toEqual([
      ["rule", "KW_RULE"],
      ["alias x", "BUBBLE"],
      ["", "EOF"],
    ]);
  });
});

describe("rule labels", () => {
  test("[label]: is four tokens with individually computed locations", () => {
    expect([...outerLexer("rule [foo]: x")].slice(1, 5)).toEqual([
      { text: "[", type: "LBRACK", loc: { line: 1, col: 6 } },
      { text: "foo", type: "RULE_LABEL", loc: { line: 1, col: 7 } },
      { text: "]", type: "RBRACK", loc: { line: 1, col: 10 } },
      { text: ":", type: "COLON", loc: { line: 1, col: 11 } },
    ]);
  });

  test("'_' is not a label character, so [my_rule]: stays bubble text", () => {
    expect(lexed("rule [my_rule]: x")).toEqual([
      ["rule", "KW_RULE"],
      ["[my_rule]: x", "BUBBLE"],
      ["", "EOF"],
    ]);
  });
});

describe("bubble attributes", () => {
  test("the trailing [..] is re-lexed and split off, the prefix rstripped", () => {
    expect(lexed("rule x \t [foo, bar(1)]")).toEqual([
      ["rule", "KW_RULE"],
      ["x", "BUBBLE"],
      ["[", "LBRACK"],
      ["foo", "ATTR_KEY"],
      [",", "COMMA"],
      ["bar", "ATTR_KEY"],
      ["(", "LPAREN"],
      ["1", "ATTR_CONTENT"],
      [")", "RPAREN"],
      ["]", "RBRACK"],
      ["", "EOF"],
    ]);
  });

  test("a [ that does not end the bubble is bubble text", () => {
    expect(lexed("rule x [foo] y")).toEqual([
      ["rule", "KW_RULE"],
      ["x [foo] y", "BUBBLE"],
      ["", "EOF"],
    ]);
  });
});

describe("attribute lexing", () => {
  test("a dotted key is one token, and key() yields no content", () => {
    expect(lexed("syntax Foo [org.kframework.attributes.Location, bar()]")).toEqual([
      ["syntax", "KW_SYNTAX"],
      ["Foo", "ID_UPPER"],
      ["[", "LBRACK"],
      ["org.kframework.attributes.Location", "ATTR_KEY"],
      [",", "COMMA"],
      ["bar", "ATTR_KEY"],
      ["(", "LPAREN"],
      [")", "RPAREN"],
      ["]", "RBRACK"],
      ["", "EOF"],
    ]);
  });

  test("content is a balanced-paren scan; a quoted value is a STRING", () => {
    expect(lexed('syntax Foo [smt-hook((and #1 #2)), klabel("x")]')).toEqual([
      ["syntax", "KW_SYNTAX"],
      ["Foo", "ID_UPPER"],
      ["[", "LBRACK"],
      ["smt-hook", "ATTR_KEY"],
      ["(", "LPAREN"],
      ["(and #1 #2)", "ATTR_CONTENT"],
      [")", "RPAREN"],
      [",", "COMMA"],
      ["klabel", "ATTR_KEY"],
      ["(", "LPAREN"],
      ['"x"', "STRING"],
      [")", "RPAREN"],
      ["]", "RBRACK"],
      ["", "EOF"],
    ]);
  });

  test("a key may carry a <cell> suffix", () => {
    expect(lexed("syntax Foo [format<k>]")).toContainEqual(["format<k>", "ATTR_KEY"]);
  });
});

describe("strings", () => {
  test("quotes and escapes stay raw, and only five escapes are accepted", () => {
    expect(lexed(String.raw`requires "a\nb\\c\"d"`)).toEqual([
      ["requires", "KW_REQUIRES"],
      [String.raw`"a\nb\\c\"d"`, "STRING"],
      ["", "EOF"],
    ]);
    expect(thrownBy(() => void lexed(String.raw`requires "\x41"`)).description).toBe("Unexpected character: 'x'");
  });

  test("a regex terminal keeps its r prefix", () => {
    expect(lexed('syntax Foo ::= r"[a-z]+"')).toContainEqual(['r"[a-z]+"', "REGEX"]);
  });
});

describe("the state machine", () => {
  test("MODNAME survives a visibility keyword", () => {
    expect(lexed("imports private FOO imports public BAR")).toEqual([
      ["imports", "KW_IMPORTS"],
      ["private", "KW_PRIVATE"],
      ["FOO", "MODNAME"],
      ["imports", "KW_IMPORTS"],
      ["public", "KW_PUBLIC"],
      ["BAR", "MODNAME"],
      ["", "EOF"],
    ]);
  });

  test("ATTR returns to DEFAULT unconditionally, bypassing the table", () => {
    expect(lexed("syntax Foo [bar] syntax Baz")).toEqual([
      ["syntax", "KW_SYNTAX"],
      ["Foo", "ID_UPPER"],
      ["[", "LBRACK"],
      ["bar", "ATTR_KEY"],
      ["]", "RBRACK"],
      ["syntax", "KW_SYNTAX"],
      ["Baz", "ID_UPPER"],
      ["", "EOF"],
    ]);
  });
});

describe("upstream quirks kept on purpose", () => {
  test("a block comment eats the character after it in _skip_ws_and_comments", () => {
    // `outer_lexer.py:314-318` calls `next(it, '')` again after a successful
    // comment. Every block comment in the 37 goldens is followed by a space,
    // so this is invisible there — and pinned here instead.
    expect(lexed("module/**/MFOO")).toEqual([
      ["module", "KW_MODULE"],
      ["FOO", "MODNAME"],
      ["", "EOF"],
    ]);
  });

  test("_klabel keeps a comment as token text when non-whitespace follows it", () => {
    expect(lexed("syntax priority /*c*/foo")).toEqual([
      ["syntax", "KW_SYNTAX"],
      ["priority", "KW_PRIORITY"],
      ["/*c*/foo", "KLABEL"],
      ["", "EOF"],
    ]);
  });
});
