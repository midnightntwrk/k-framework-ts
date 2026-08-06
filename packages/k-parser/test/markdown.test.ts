/**
 * `src/markdown.ts`, against every oracle the corpus provides.
 *
 * Four kinds of test, in order:
 *
 * 1. **pyk's own tables** (`fixtures/pyk-unit/markdown-*.json`, 46 cases): the
 *    selector grammar, its evaluation, and info-string parsing, extracted from
 *    `test_markdown.py` rather than hand-copied, so they re-sync at the next K
 *    release.
 * 2. **The 16 golden `.test` files**, read through `test/fixtures.ts`: 12 for
 *    `codeBlocks` and 4 for `selectCodeBlocks` end to end, the latter comparing
 *    the blanked output byte for byte.
 * 3. **The length-preservation invariant** over K's whole 9-file prelude — the
 *    one property everything downstream depends on, since it is what makes a
 *    lexer position in the blanked text address the original `.md`.
 * 4. **The named contract items**: the three missing-`f` messages we fix, the
 *    one-character-atom quirk at `markdown.py:221`, the two vendored rarities
 *    that throw, and the fence edge cases the goldens leave implicit.
 *
 * The module's three behavioural contract items are covered by, respectively,
 * "blanks, never extracts" plus the prelude invariant; "the fence pattern";
 * and "the one-character-atom quirk".
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  MarkdownError,
  SelectorParser,
  codeBlocks,
  evalSelector,
  parseSelector,
  parseTags,
  selectCodeBlocks,
  selectorLexer,
  type Selector,
} from "../src/markdown.ts";
import {
  BUILTIN,
  MARKDOWN_CODE_BLOCKS,
  MARKDOWN_SELECT,
  RARITIES,
  listFixtures,
  parseCodeBlocksTest,
  parseSelectTest,
  readFixture,
  readPykUnitTable,
} from "./fixtures.ts";

/////////////////////////////////////////
// Reading the extracted pyk tables    //
/////////////////////////////////////////

// The tables type their case values as `unknown` on purpose — each has its own
// shape — so every field goes through a throwing accessor rather than a cast.
// A table that stopped carrying a field fails here by name.

function str(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new TypeError(`${field} is not a string: ${JSON.stringify(value)}`);
  return value;
}

function bool(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") throw new TypeError(`${field} is not a boolean: ${JSON.stringify(value)}`);
  return value;
}

function strings(record: Record<string, unknown>, field: string): string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${field} is not a string array: ${JSON.stringify(value)}`);
  }
  return value.filter((item) => typeof item === "string");
}

describe("pyk unit tables", () => {
  describe("selector parsing (PARSER_TEST_DATA)", () => {
    const table = readPykUnitTable("markdown-selector-parse.json");

    test("the table is the 20 cases PROVENANCE.md records", () => {
      expect(table.cases).toHaveLength(20);
    });

    for (const kase of table.cases) {
      const text = str(kase, "kText");
      test(`parses ${JSON.stringify(text)}`, () => {
        // The fixture encodes `{node, …}` records, which is exactly the shape
        // `Selector` has — that is why it has that shape. Widened to `unknown`
        // so the comparison is structural rather than an assignability check
        // against a type the fixture does not have to satisfy statically.
        const parsed: unknown = new SelectorParser(text).parse();
        expect(parsed).toEqual(kase["expected"]);
      });
    }
  });

  describe("selector evaluation (EVAL_TEST_DATA)", () => {
    const table = readPykUnitTable("markdown-selector-eval.json");

    test("the table is the 23 cases PROVENANCE.md records", () => {
      expect(table.cases).toHaveLength(23);
    });

    for (const [index, kase] of table.cases.entries()) {
      const text = str(kase, "text");
      const atoms = strings(kase, "atoms");
      test(`${index}: ${JSON.stringify(text)} against {${atoms.join(", ")}}`, () => {
        expect(evalSelector(parseSelector(text), new Set(atoms))).toBe(bool(kase, "expected"));
      });
    }
  });

  describe("info strings (PARSE_TAGS_TEST_DATA)", () => {
    const table = readPykUnitTable("markdown-parse-tags.json");

    test("the table is the 3 cases PROVENANCE.md records", () => {
      expect(table.cases).toHaveLength(3);
    });

    for (const kase of table.cases) {
      const text = str(kase, "text");
      test(`parses ${JSON.stringify(text)}`, () => {
        // The extractor sorts the expected set; a `Set` has no order to compare.
        expect([...parseTags(text)].toSorted()).toEqual(strings(kase, "expected"));
      });
    }
  });
});

/////////////////////////////////////////
// The golden `.test` files            //
/////////////////////////////////////////

describe("markdown-code-blocks goldens", () => {
  const names = listFixtures(MARKDOWN_CODE_BLOCKS, ".test");

  test("all 12 files are read", () => {
    expect(names).toHaveLength(12);
  });

  for (const name of names) {
    test(name, () => {
      const golden = parseCodeBlocksTest(readFixture(MARKDOWN_CODE_BLOCKS, name));
      expect([...codeBlocks(golden.text)]).toEqual([...golden.blocks]);
    });
  }

  test("the 12 files hold 11 blocks between them", () => {
    const total = names
      .map((name) => [...codeBlocks(parseCodeBlocksTest(readFixture(MARKDOWN_CODE_BLOCKS, name)).text)].length)
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(11);
  });
});

describe("markdown-select goldens", () => {
  const names = listFixtures(MARKDOWN_SELECT, ".test");

  test("all 4 files are read", () => {
    expect(names).toHaveLength(4);
  });

  for (const name of names) {
    test(name, () => {
      const golden = parseSelectTest(readFixture(MARKDOWN_SELECT, name));
      const actual = selectCodeBlocks(golden.text, golden.selector);
      expect(actual).toBe(golden.expected);
      expect(actual).toHaveLength(golden.text.length);
    });
  }

  test("no-selector.test and with-selector.test differ only in the first block", () => {
    const all = parseSelectTest(readFixture(MARKDOWN_SELECT, "no-selector.test"));
    const foo = parseSelectTest(readFixture(MARKDOWN_SELECT, "with-selector.test"));
    expect(all.selector).toBeNull();
    expect(foo.selector).toBe("foo");
    // The untagged block survives under `null` and is blanked under `foo`.
    expect(selectCodeBlocks(all.text, null)).toContain("Urna porttitor");
    expect(selectCodeBlocks(foo.text, "foo")).not.toContain("Urna porttitor");
  });
});

/////////////////////////////////////////
// The length-preservation invariant   //
/////////////////////////////////////////

describe("length preservation over K's prelude", () => {
  const names = listFixtures(BUILTIN, ".md");

  test("all 8 literate prelude files are read", () => {
    expect(names).toHaveLength(8);
  });

  for (const name of names) {
    test(`${name} keeps its length under both selectors`, () => {
      const text = readFixture(BUILTIN, name);
      expect(selectCodeBlocks(text, "k")).toHaveLength(text.length);
      expect(selectCodeBlocks(text, null)).toHaveLength(text.length);
      // Nothing but the blanking may differ: every line count is untouched.
      expect(selectCodeBlocks(text, "k").split("\n")).toHaveLength(text.split("\n").length);
    });
  }

  test("domains.md is 123,428 bytes in and 123,428 bytes out", () => {
    const path = `${BUILTIN}/domains.md`;
    expect(readFileSync(path).byteLength).toBe(123_428);
    const text = readFileSync(path, "utf8");
    const selected = selectCodeBlocks(text, "k");
    expect(Buffer.byteLength(selected, "utf8")).toBe(123_428);
    // And it did select something: the first module survives on its own line,
    // line 39 of the original file, where the `.md` has it.
    expect(selected.split("\n")[38]).toBe("module DOMAINS-SYNTAX");
  });

  test("every prelude block is tagged `k`, so `k` and `null` select the same text", () => {
    for (const name of names) {
      const text = readFixture(BUILTIN, name);
      expect(selectCodeBlocks(text, "k")).toBe(selectCodeBlocks(text, null));
    }
  });
});

/////////////////////////////////////////
// The two vendored rarities           //
/////////////////////////////////////////

describe("rarities", () => {
  const selectors = readFixture(RARITIES, "markdownSelectors", "test.md");
  const errorLocation = readFixture(RARITIES, "checks", "markdownErrorLocation.md");

  test('markdownSelectors/test.md: `startFrom="0"` is not a `.tag`', () => {
    // pyk's behaviour, kept deliberately: Java ignores the extra pandoc
    // attribute (`fixtures/PROVENANCE.md`, divergence 1). The message is the
    // fixed one — `markdown.py:83` prints the uninterpolated f-string.
    expect(() => selectCodeBlocks(selectors, "k")).toThrow(MarkdownError);
    expect(() => selectCodeBlocks(selectors, "k")).toThrow("Expected '.', found: 's'");
    expect(() => parseTags('{.k .discard .numberLines startFrom="0"}')).toThrow("Expected '.', found: 's'");
  });

  test("markdownSelectors/test.md: it throws for every selector, and for none", () => {
    // `parse_tags` runs on every block before any selector is evaluated
    // (`markdown.py:34`), so the definition's own `(k|keep) & !discard`
    // selector fails on it too.
    expect(() => selectCodeBlocks(selectors, null)).toThrow(MarkdownError);
    expect(() => selectCodeBlocks(selectors, "(k | keep) & !discard")).toThrow(MarkdownError);
  });

  test("markdownSelectors/test.md: `codeBlocks` reads it anyway, module split and all", () => {
    // `code_blocks` never calls `parse_tags` (`markdown.py:61`). The point of
    // the file: `module TEST` opens in the first block and closes in the last.
    const blocks = [...codeBlocks(selectors)];
    expect(blocks.map((block) => block.info)).toEqual([
      "k",
      "{.k}",
      "{.discard}",
      "{.keep}",
      "{.k .keep}",
      '{.k .discard .numberLines startFrom="0"}',
      "{.keep .discard}",
      "k",
    ]);
    expect(blocks[0]?.code).toContain("module TEST\n");
    expect(blocks.at(-1)?.code).toBe("endmodule");
  });

  test("checks/markdownErrorLocation.md: `` ``` { not used `` is not a tag", () => {
    // Divergence 2: Java treats an uninterpretable info string as "not
    // selected" and carries on to the compiler, as its `.out` shows.
    expect(() => selectCodeBlocks(errorLocation, "k")).toThrow(MarkdownError);
    expect(() => selectCodeBlocks(errorLocation, "k")).toThrow("Invalid tag: ' { not used'");
  });

  test("checks/markdownErrorLocation.md: five blocks, the sixth fence unterminated", () => {
    const blocks = [...codeBlocks(errorLocation)];
    expect(blocks.map((block) => block.info)).toEqual(["k", "{.a .b}", "{.k .x}", " { not used", "k"]);
    // The indented fence keeps its indentation inside the code.
    expect(blocks[0]?.code).toContain(" // keep indentation");
    // ```{.y .k} at the end of the file never closes, so it is not a block.
    expect(errorLocation).toContain("```{.y .k}");
  });
});

/////////////////////////////////////////
// The fixed missing-`f` messages      //
/////////////////////////////////////////

describe("deviation: the three missing-`f` messages are interpolated", () => {
  test("markdown.py:77 — `Expected '}', found: …`", () => {
    // pyk raises the literal string `Expected '}', found: {text[-1]!r}`.
    expect(() => parseTags("{.k")).toThrow("Expected '}', found: 'k'");
    expect(() => parseTags("{")).toThrow("Expected '}', found: '{'");
  });

  test("markdown.py:83 — `Expected '.', found: …`", () => {
    // pyk raises the literal string `Expected '.', found: {tag[0]!r}`.
    expect(() => parseTags("{k}")).toThrow("Expected '.', found: 'k'");
    expect(() => parseTags("{.a b}")).toThrow("Expected '.', found: 'b'");
  });

  test("markdown.py:179 — `Unexpected token: )`", () => {
    // pyk raises the literal string `Unexpected token: {token}`. `_match` is
    // only ever called with `')'`, so this is the only value it can report.
    expect(() => parseSelector("(a")).toThrow(MarkdownError);
    expect(() => parseSelector("(a")).toThrow("Unexpected token: )");
    expect(() => parseSelector("(a b)")).toThrow("Unexpected token: )");
  });

  test("the messages upstream gets right are unchanged", () => {
    expect(() => parseTags("a b")).toThrow("Invalid tag: 'a b'");
    expect(() => parseTags("{.}")).toThrow("Invalid tag: ''");
    expect(() => parseSelector("a b")).toThrow("Expected EOF, found: b");
    expect(() => parseSelector("")).toThrow("Unexpected EOF");
    expect(() => parseSelector("a &")).toThrow("Unexpected EOF");
    expect(() => parseSelector("a - b")).toThrow("Unexpected character: '-'");
  });
});

/////////////////////////////////////////
// markdown.py:221, verbatim           //
/////////////////////////////////////////

describe("quirk: a one-character atom must be alphanumeric (markdown.py:221)", () => {
  test("a lone `_` is rejected", () => {
    expect(() => parseSelector("_")).toThrow(MarkdownError);
    expect(() => parseSelector("_")).toThrow("Unexpected token: _");
    // Even though `_` is a perfectly good *tag*.
    expect([...parseTags("_")]).toEqual(["_"]);
  });

  test("two characters are enough, whatever they are", () => {
    const cases = ["__", "a_", "ab_", "_a", "_1"];
    for (const text of cases) {
      expect(parseSelector(text)).toEqual({ node: "Atom", name: text });
    }
  });

  test("a one-character atom passes when it is alphanumeric", () => {
    expect(parseSelector("a")).toEqual({ node: "Atom", name: "a" });
    expect(parseSelector("1")).toEqual({ node: "Atom", name: "1" });
    // `isalnum` is Python's, so it is Unicode-aware, not `[A-Za-z0-9]`.
    expect(parseSelector("é")).toEqual({ node: "Atom", name: "é" });
  });

  test("the `== '-'` branch is dead: the lexer never emits `-`", () => {
    expect([...selectorLexer("a")]).toEqual(["a", ""]);
    expect(() => [...selectorLexer("-")]).toThrow("Unexpected character: '-'");
    expect(() => parseSelector("-")).toThrow("Unexpected character: '-'");
    // A tag may contain `-`, so `a-b` is selectable by nothing at all.
    expect([...parseTags("a-b")]).toEqual(["a-b"]);
    expect(() => parseSelector("a-b")).toThrow("Unexpected character: '-'");
  });

  test("`_` inside a longer atom still lexes as one token", () => {
    expect([...selectorLexer("a_b & !c_d")]).toEqual(["a_b", "&", "!", "c_d", ""]);
  });
});

/////////////////////////////////////////
// The selector language, beyond pyk   //
/////////////////////////////////////////

describe("selector language", () => {
  test("a one-operand chain collapses (markdown.py:193-195,202-204)", () => {
    expect(parseSelector("(((a)))")).toEqual({ node: "Atom", name: "a" });
    expect(parseSelector("!!a")).toEqual({ node: "Not", op: { node: "Not", op: { node: "Atom", name: "a" } } });
  });

  test("`|` binds loosest, `&` next, `!` tightest", () => {
    const expected: Selector = {
      node: "Or",
      ops: [
        { node: "Atom", name: "a" },
        {
          node: "And",
          ops: [
            { node: "Not", op: { node: "Atom", name: "b" } },
            { node: "Atom", name: "c" },
          ],
        },
      ],
    };
    expect(parseSelector("a | !b & c")).toEqual(expected);
  });

  test("the AST is frozen", () => {
    const parsed = parseSelector("a & b");
    expect(Object.isFrozen(parsed)).toBe(true);
    if (parsed.node !== "And") throw new TypeError("expected an And");
    expect(Object.isFrozen(parsed.ops)).toBe(true);
  });

  test("the lexer's final `''` is a token, not an absence", () => {
    expect([...selectorLexer("")]).toEqual([""]);
    expect([...selectorLexer("  \t\n ")]).toEqual([""]);
    expect([...selectorLexer("!(a|b)")]).toEqual(["!", "(", "a", "|", "b", ")", ""]);
  });

  test("evaluation is set membership, and `atoms` may hold anything", () => {
    const selector = parseSelector("k & !symbolic");
    expect(evalSelector(selector, new Set(["k"]))).toBe(true);
    expect(evalSelector(selector, new Set(["k", "symbolic"]))).toBe(false);
    expect(evalSelector(selector, new Set())).toBe(false);
  });

  test("unbalanced and stray tokens are rejected", () => {
    expect(() => parseSelector("a)")).toThrow("Expected EOF, found: )");
    expect(() => parseSelector("&a")).toThrow("Unexpected token: &");
    expect(() => parseSelector("|")).toThrow("Unexpected token: |");
    expect(() => parseSelector("()")).toThrow("Unexpected token: )");
  });
});

/////////////////////////////////////////
// Info strings                        //
/////////////////////////////////////////

describe("parseTags", () => {
  test("the empty info string has no tags", () => {
    expect([...parseTags("")]).toEqual([]);
    // But `{}` is the *braced* empty set, which needs `str.split()` semantics
    // to reach at all: a naive split would leave one empty token behind.
    expect([...parseTags("{}")]).toEqual([]);
    expect([...parseTags("{   }")]).toEqual([]);
  });

  test("a bare info string is one tag, `-` and `_` included", () => {
    expect([...parseTags("k")]).toEqual(["k"]);
    expect([...parseTags("k-frontend_2")]).toEqual(["k-frontend_2"]);
  });

  test("braced tags are whitespace-separated and each must start with `.`", () => {
    expect([...parseTags("{.k}")]).toEqual(["k"]);
    expect([...parseTags("{.foo  .bar\t.baz}")].toSorted()).toEqual(["bar", "baz", "foo"]);
    expect([...parseTags("{.a .a}")]).toEqual(["a"]);
  });

  test("what a tag may not contain", () => {
    expect(() => parseTags("a.b")).toThrow("Invalid tag: 'a.b'");
    expect(() => parseTags('{.numberLines startFrom="0"}')).toThrow(MarkdownError);
    expect(() => parseTags("{.a!b}")).toThrow("Invalid tag: 'a!b'");
  });
});

/////////////////////////////////////////
// Fences                              //
/////////////////////////////////////////

/** Every character of `text` that is not a space, tab, CR or LF. */
function nonBlank(text: string): string {
  // Symmetric with `blank` in the module under test; see its note.
  // oxlint-disable-next-line require-unicode-regexp -- see above.
  return text.replaceAll(/[ \t\r\n]/g, "");
}

describe("fences", () => {
  test("an opening fence may be indented by at most three spaces", () => {
    const ok = "   ```k\nfoo\n```\n";
    expect([...codeBlocks(ok)]).toEqual([{ info: "k", code: "foo" }]);

    const tooFar = "    ```k\nfoo\n```\n";
    expect([...codeBlocks(tooFar)]).toEqual([]);
    expect(nonBlank(selectCodeBlocks(tooFar, "k"))).toBe("");
  });

  test("a closing fence may be indented and may be longer", () => {
    expect([...codeBlocks("```k\nfoo\n   ```\n")]).toEqual([{ info: "k", code: "foo" }]);
    expect([...codeBlocks("```k\nfoo\n``````\n")]).toEqual([{ info: "k", code: "foo" }]);
    // …but not shorter, and a shorter run just becomes part of the code.
    expect([...codeBlocks("````k\nfoo\n```\nbar\n````\n")]).toEqual([{ info: "k", code: "foo\n```\nbar" }]);
  });

  test("a fourth backtick after the opening run is not an info string", () => {
    // `(?!`)` — ```` ```` ```` opens a four-backtick fence, not a three.
    expect([...codeBlocks("````\nfoo\n```\n")]).toEqual([]);
  });

  test("an unterminated final fence is prose", () => {
    const text = "```k\nmodule A\n";
    expect([...codeBlocks(text)]).toEqual([]);
    expect(selectCodeBlocks(text, "k")).toBe("    \n        \n");
  });

  test("an empty block has empty code", () => {
    expect([...codeBlocks("```k\n```\n")]).toEqual([{ info: "k", code: "" }]);
    // And a block of only a blank line, after `rstrip`, likewise.
    expect([...codeBlocks("```k\n\n```\n")]).toEqual([{ info: "k", code: "" }]);
  });

  test("`code` is right-stripped but not left-stripped", () => {
    expect([...codeBlocks("```k\n  foo  \n```\n")]).toEqual([{ info: "k", code: "  foo" }]);
  });

  test("a fence must start a line", () => {
    expect([...codeBlocks("x ```k\nfoo\n```\n")]).toEqual([]);
  });

  test("CRLF documents still match — the reason `.` is spelled `[^\\n]`", () => {
    // JavaScript's `.` excludes `\r`, so with a literal `.` this would find no
    // block at all. Python's does not, and neither does this.
    const blocks = [...codeBlocks("```k\r\nmodule A\r\n```\r\n")];
    expect(blocks).toEqual([{ info: "k\r", code: "module A" }]);
    // pyk rejects that info string too, `\r` not being alnum — the fix only
    // decides whether the block is seen, not whether it is accepted.
    expect(() => parseTags("k\r")).toThrow("Invalid tag: 'k\\r'");
  });
});

/////////////////////////////////////////
// selectCodeBlocks, in the small      //
/////////////////////////////////////////

describe("selectCodeBlocks", () => {
  /** Two `k` blocks with prose between them — a module split across fences. */
  const doc = [
    "# Title", //             line 1
    "", //                    line 2
    "```k", //                line 3
    "module A", //            line 4
    "```", //                 line 5
    "", //                    line 6
    "prose about it", //      line 7
    "", //                    line 8
    "```{.k .symbolic}", //   line 9
    "endmodule", //           line 10
    "```", //                 line 11
    "", //                    line 12
  ].join("\n");

  test("both selected blocks survive, on their original lines", () => {
    const lines = selectCodeBlocks(doc, "k").split("\n");
    expect(lines[3]).toBe("module A");
    expect(lines[9]).toBe("endmodule");
    expect(lines.filter((line, index) => index !== 3 && index !== 9).join("")).toMatch(/^ *$/u);
    expect(lines).toHaveLength(doc.split("\n").length);
  });

  test("a selector that matches one block blanks the other", () => {
    const out = selectCodeBlocks(doc, "k & symbolic");
    expect(out).not.toContain("module A");
    expect(out).toContain("endmodule");
    expect(out).toHaveLength(doc.length);
  });

  test("no selector selects every block (`markdown.py:23` tests `if selector`)", () => {
    const all = selectCodeBlocks(doc, "k");
    expect(selectCodeBlocks(doc)).toBe(all);
    expect(selectCodeBlocks(doc, null)).toBe(all);
    expect(selectCodeBlocks(doc, "")).toBe(all);
  });

  test("a selector matching nothing blanks the whole document", () => {
    expect(nonBlank(selectCodeBlocks(doc, "haskell"))).toBe("");
  });

  test("the fences and info strings are blanked, not the code", () => {
    const out = selectCodeBlocks(doc, "k");
    expect(out).not.toContain("```");
    expect(out).not.toContain("symbolic");
    expect(out).not.toContain("# Title");
  });

  test("prose keeps its tabs, CRs and newlines", () => {
    const text = "a\tb\r\n\n```k\nfoo\n```\n";
    const out = selectCodeBlocks(text, "k");
    expect(out).toBe(" \t \r\n\n    \nfoo\n   \n");
    expect(out).toHaveLength(text.length);
  });

  test("the empty document is the empty document", () => {
    expect(selectCodeBlocks("", "k")).toBe("");
    expect(selectCodeBlocks("", null)).toBe("");
  });

  test("deviation: blanking is per UTF-16 code unit, so `.length` is exact", () => {
    // pyk blanks per code point, which in JavaScript would shorten the result
    // by one unit per astral character and shift every later column.
    const text = "prose 🎉 more\n\n```k\nfoo\n```\n";
    const out = selectCodeBlocks(text, "k");
    expect(out).toHaveLength(text.length);
    expect(out.indexOf("foo")).toBe(text.indexOf("foo"));
    expect(out.split("\n")[0]).toBe(" ".repeat(text.split("\n")[0]?.length ?? 0));
  });

  test("a malformed selector is reported before the document is read", () => {
    expect(() => selectCodeBlocks(doc, "k &")).toThrow(MarkdownError);
    expect(() => selectCodeBlocks("no fences here", "!")).toThrow("Unexpected EOF");
  });
});

/////////////////////////////////////////
// The error type                      //
/////////////////////////////////////////

describe("MarkdownError", () => {
  test("is a SyntaxError, and says so", () => {
    let caught: unknown;
    try {
      parseTags("a b");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MarkdownError);
    expect(caught).toBeInstanceOf(SyntaxError);
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof Error ? caught.name : "").toBe("MarkdownError");
  });

  test("every throwing path throws it and nothing else", () => {
    const throwers = [
      (): unknown => parseTags("a b"), //          markdown.py:67
      (): unknown => parseTags("{.k"), //          markdown.py:77
      (): unknown => parseTags("{k}"), //          markdown.py:83
      (): unknown => parseSelector("-"), //        markdown.py:161
      (): unknown => parseSelector("(a"), //       markdown.py:179
      (): unknown => parseSelector("a b"), //      markdown.py:185
      (): unknown => parseSelector(""), //         markdown.py:208
      (): unknown => parseSelector("_"), //        markdown.py:226
    ];
    for (const thrower of throwers) {
      expect(thrower).toThrow(MarkdownError);
    }
  });
});
