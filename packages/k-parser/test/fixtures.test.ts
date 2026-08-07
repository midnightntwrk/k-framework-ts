/**
 * The fixtures, held to what `fixtures/PROVENANCE.md` says they are.
 *
 * There is no lexer yet, so nothing here parses K.  What it does instead is
 * keep the corpus **load-bearing before the code that consumes it exists**: it
 * pins the file counts, re-reads every `.test` file through the readers in
 * `fixtures.ts`, checks the 9,283 expected tokens against the location
 * invariant they must satisfy, and verifies every vendored byte against the
 * checksums recorded in `PROVENANCE.md`.
 *
 * That last one is the important one.  A provenance document that nothing
 * checks is a claim; one a test re-derives is evidence.  If a fixture is ever
 * edited, reformatted, or re-copied from a different K release, this file
 * fails and names the file.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  BUILTIN,
  FIXTURES,
  IMP_OUTER_JSON,
  INVERSE_SUITE,
  MARKDOWN_CODE_BLOCKS,
  MARKDOWN_SELECT,
  OUTER_LEXER,
  OUTER_TOKEN_TYPES,
  PARSE_OUTER,
  PYK_UNIT,
  RARITIES,
  listFixtures,
  parseCodeBlocksTest,
  parseLexerTest,
  parseSelectTest,
  readFixture,
  readPykUnitTable,
  tokensWithBadLocations,
} from "./fixtures.ts";

/** Every file under `dir`, recursively, as paths relative to `FIXTURES`. */
function walk(dir: string): string[] {
  const out: string[] = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) pending.push(path);
      else out.push(relative(FIXTURES, path));
    }
  }
  return out.toSorted();
}

/**
 * Narrows JSON to an object without a type assertion.
 *
 * `readPykUnitTable` types the case values as `unknown` on purpose — each of
 * the sixteen tables has a different case shape — so every access here goes
 * through a predicate. Asserting instead would let a table that stopped having
 * the field still pass, which is precisely what these tests exist to catch.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The same, as a throwing accessor for use inside an expectation. */
function objectAt(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${what} is not an object: ${JSON.stringify(value)}`);
  return value;
}

/** `value` as an array, throwing when it is not one. */
function arrayAt(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${what} is not an array: ${JSON.stringify(value)}`);
  return value;
}

/** The `[Error] <phase>:` a `regression-new` `.out` file opens with, if any. */
function errorPhase(name: string): string {
  return /^\[Error\] ([A-Za-z ]+):/mu.exec(readFixture(RARITIES, "checks", name))?.[1] ?? "";
}

/**
 * The `## Checksums` fenced block of `PROVENANCE.md`, as `[sha256, path]` pairs.
 *
 * The section holds two fenced blocks: the regeneration command, tagged `sh`,
 * and then the checksums. The block is found by requiring its first line to be
 * a sha256 rather than by counting fences — the prose elsewhere in the document
 * quotes fence markers inline, so counting would be wrong.
 */
function recordedChecksums(): [string, string][] {
  const text = readFixture(FIXTURES, "PROVENANCE.md");
  const heading = text.lastIndexOf("\n## Checksums\n");
  if (heading === -1) throw new Error("PROVENANCE.md has no ## Checksums section");
  const block = /^```\n([0-9a-f]{64} [\s\S]*?)^```$/mu.exec(text.slice(heading))?.[1];
  if (block === undefined) throw new Error("PROVENANCE.md has no checksum block");
  return block
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [hash, ...rest] = line.split("  ");
      return [hash ?? "", rest.join("  ")];
    });
}

describe("outer-lexer/", () => {
  const names = listFixtures(OUTER_LEXER, ".test");

  test("37 golden files, exactly as PROVENANCE records", () => {
    expect(names).toHaveLength(37);
    expect(readdirSync(OUTER_LEXER)).toHaveLength(37);
  });

  test("every file parses, for 9,283 expected tokens in total", () => {
    // Measured with this reader *and* with pyk's own `_parse`, file by file:
    // the two agree on every field of every token.  (Planning estimated
    // 9,290; 9,283 is the real number.)
    let total = 0;
    for (const name of names) {
      const parsed = parseLexerTest(readFixture(OUTER_LEXER, name));
      expect(parsed.tokens.length).toBeGreaterThan(0);
      total += parsed.tokens.length;
    }
    expect(total).toBe(9283);
  });

  test("the 15 domains-* chunks are 9,018 of those tokens", () => {
    const domains = names.filter((name) => name.startsWith("domains-"));
    expect(domains).toHaveLength(15);
    const total = domains.reduce((sum, name) => sum + parseLexerTest(readFixture(OUTER_LEXER, name)).tokens.length, 0);
    expect(total).toBe(9018);
  });

  test("every token's recorded location actually locates its text", () => {
    // `test_outer_lexer.py:647-651`, run over the vendored data rather than
    // over a lexer's output: it is what proves the files mean what the reader
    // thinks they mean.
    for (const name of names) {
      const parsed = parseLexerTest(readFixture(OUTER_LEXER, name));
      expect({ name, bad: tokensWithBadLocations(parsed) }).toEqual({ name, bad: [] });
    }
  });

  test("every token type used is a declared TokenType, and EOF ends every file", () => {
    const declared = new Set<string>(OUTER_TOKEN_TYPES);
    const used = new Set<string>();
    for (const name of names) {
      const { tokens } = parseLexerTest(readFixture(OUTER_LEXER, name));
      for (const token of tokens) used.add(token.type);
      expect(tokens.at(-1)?.type).toBe("EOF");
    }
    expect([...used].filter((type) => !declared.has(type))).toEqual([]);
    // The corpus does not exercise every type — `PLUS`, `TIMES`, `QUESTION`
    // and `TILDE` are in pyk's enum but produced by nothing.
    expect(used.size).toBeLessThan(declared.size);
  });

  test("empty.test is one EOF token at (1, 0)", () => {
    const parsed = parseLexerTest(readFixture(OUTER_LEXER, "empty.test"));
    expect(parsed.text).toBe("");
    expect(parsed.tokens).toEqual([{ text: "", type: "EOF", loc: { line: 1, col: 0 } }]);
  });

  test("a multi-line bubble survives the reader's blank-line rule", () => {
    // Two rules, each a bubble spanning two lines, with a `/* ... */` between
    // them that contains the word `rule` and must not terminate anything. The
    // reader has to keep the embedded newlines and still find the next
    // `KW_RULE` record — which is the blank-line-then-type-name rule.
    const { tokens } = parseLexerTest(readFixture(OUTER_LEXER, "bubble-multi-line.test"));
    expect(tokens.map((token) => token.type)).toEqual(["KW_RULE", "BUBBLE", "KW_RULE", "BUBBLE", "EOF"]);
    const bubbles = tokens.filter((token) => token.type === "BUBBLE");
    expect(bubbles[0]?.text).toBe("<a> A        </a>\n          <b> b1 => b2 </b>");
    expect(bubbles[1]?.text).toBe("<a> a1 => a2 </a>\n  <b> B        </b>");
  });
});

describe("markdown/", () => {
  test("12 code-block goldens holding 11 blocks, and 4 select goldens", () => {
    const blockFiles = listFixtures(MARKDOWN_CODE_BLOCKS, ".test");
    expect(blockFiles).toHaveLength(12);
    const blocks = blockFiles.reduce(
      (sum, name) => sum + parseCodeBlocksTest(readFixture(MARKDOWN_CODE_BLOCKS, name)).blocks.length,
      0,
    );
    expect(blocks).toBe(11);
    expect(listFixtures(MARKDOWN_SELECT, ".test")).toHaveLength(4);
  });

  test("a block's info string and code are read apart", () => {
    const parsed = parseCodeBlocksTest(readFixture(MARKDOWN_CODE_BLOCKS, "simple-block-with-info.test"));
    expect(parsed.blocks).toEqual([{ info: "foo", code: "bar\n\nbaz" }]);
  });

  test("the two block-free files really have no blocks", () => {
    for (const name of ["empty-file.test", "no-blocks.test"]) {
      expect(parseCodeBlocksTest(readFixture(MARKDOWN_CODE_BLOCKS, name)).blocks).toEqual([]);
    }
  });

  test("selection preserves length exactly — every select golden", () => {
    // The invariant the whole `markdown.py` design exists for: non-selected
    // characters are blanked, not removed, so locations still refer to the
    // original `.md`.
    for (const name of listFixtures(MARKDOWN_SELECT, ".test")) {
      const parsed = parseSelectTest(readFixture(MARKDOWN_SELECT, name));
      expect({ name, len: parsed.expected.length }).toEqual({ name, len: parsed.text.length });
    }
  });

  test("an empty selector line reads as null, not as an empty selector", () => {
    expect(parseSelectTest(readFixture(MARKDOWN_SELECT, "no-selector.test")).selector).toBeNull();
    expect(parseSelectTest(readFixture(MARKDOWN_SELECT, "with-selector.test")).selector).toBe("foo");
    expect(parseSelectTest(readFixture(MARKDOWN_SELECT, "multiple-tags.test")).selector).toBe("foo & !bar");
  });
});

describe("the .test files justify the reader's single-separator splitLines", () => {
  test("no vendored .test file contains any other line separator", () => {
    // `fixtures.ts`'s `splitLines` handles `\n` only. Python's `splitlines`
    // also breaks on these, so the equivalence has to be checked, not assumed.
    const others = ["\r", "\v", "\f", "\u001C", "\u001D", "\u001E", "\u0085", "\u2028", "\u2029"];
    const files = walk(FIXTURES).filter((name) => name.endsWith(".test"));
    expect(files).toHaveLength(53);
    for (const name of files) {
      const text = readFixture(FIXTURES, name);
      expect({ name, found: others.filter((char) => text.includes(char)) }).toEqual({ name, found: [] });
    }
  });
});

describe("pyk-unit/", () => {
  /**
   * What `extract-pyk-fixtures.py` produced, recorded so a re-run against a
   * different K release cannot quietly change the corpus size.
   */
  const CASES: Readonly<Record<string, number>> = {
    "ast-to-kast.json": 7,
    "markdown-parse-tags.json": 3,
    "markdown-selector-eval.json": 23,
    "markdown-selector-parse.json": 20,
    "outer-lexer-attr.json": 15,
    "outer-lexer-bubble.json": 42,
    "outer-lexer-comment.json": 9,
    "outer-lexer-context.json": 2,
    "outer-lexer-default.json": 28,
    "outer-lexer-klabel.json": 19,
    "outer-lexer-modname.json": 10,
    "outer-parser-definition.json": 6,
    "outer-parser-import.json": 3,
    "outer-parser-module.json": 7,
    "outer-parser-require.json": 1,
    "outer-parser-sentence.json": 72,
  };

  test("16 extracted tables, and the extractor beside them", () => {
    expect(listFixtures(PYK_UNIT, ".json")).toEqual(Object.keys(CASES).toSorted());
    expect(existsSync(join(PYK_UNIT, "extract-pyk-fixtures.py"))).toBe(true);
  });

  test("every table parses, and holds exactly the recorded number of cases", () => {
    let total = 0;
    for (const [name, expected] of Object.entries(CASES)) {
      const table = readPykUnitTable(name);
      expect({ name, cases: table.cases.length }).toEqual({ name, cases: expected });
      total += table.cases.length;
    }
    // 125 lexer + 89 parser + 46 markdown + 7 ast-to-kast.
    expect(total).toBe(267);
  });

  test("every case carries exactly the declared fields, in order", () => {
    for (const name of Object.keys(CASES)) {
      const table = readPykUnitTable(name);
      expect(table.fields.length).toBeGreaterThan(0);
      expect(table.source.startsWith("pyk/src/tests/unit/kast/")).toBe(true);
      for (const kase of table.cases) {
        expect({ name, keys: Object.keys(kase) }).toEqual({ name, keys: [...table.fields] });
      }
    }
  });

  test("the lexer tables' expected tokens are well-formed", () => {
    const declared = new Set<string>(OUTER_TOKEN_TYPES);
    const isToken = (value: unknown): boolean => {
      if (typeof value !== "object" || value === null) return false;
      const token = value as { text?: unknown; type?: unknown; loc?: unknown };
      return (
        typeof token.text === "string" &&
        typeof token.type === "string" &&
        declared.has(token.type) &&
        Array.isArray(token.loc) &&
        token.loc.length === 2
      );
    };

    for (const name of ["outer-lexer-default.json", "outer-lexer-modname.json", "outer-lexer-klabel.json"]) {
      for (const kase of readPykUnitTable(name).cases) expect(isToken(kase["expectedToken"])).toBe(true);
    }
    for (const name of ["outer-lexer-bubble.json", "outer-lexer-context.json", "outer-lexer-attr.json"]) {
      for (const kase of readPykUnitTable(name).cases) {
        const tokens = kase["expectedTokens"];
        expect(Array.isArray(tokens)).toBe(true);
        for (const token of arrayAt(tokens, "expectedTokens")) expect(isToken(token)).toBe(true);
      }
    }
  });

  test("the parser tables' expected values are outer_syntax nodes", () => {
    for (const name of ["outer-parser-sentence.json", "outer-parser-module.json", "outer-parser-definition.json"]) {
      for (const kase of readPykUnitTable(name).cases) {
        expect(typeof kase["kText"]).toBe("string");
        expect(typeof objectAt(kase["expected"], "expected")["node"]).toBe("string");
      }
    }
  });

  test("every module case carries the 4-tuple location the parser must reproduce", () => {
    for (const kase of readPykUnitTable("outer-parser-module.json").cases) {
      const expected = objectAt(kase["expected"], "expected");
      expect(expected["node"]).toBe("Module");
      expect(arrayAt(expected["location"], "location")).toHaveLength(4);
    }
  });

  test("ast-to-kast pairs an outer_syntax node with KAST v4 JSON", () => {
    const table = readPykUnitTable("ast-to-kast.json");
    const nodes = table.cases.map((kase) => objectAt(kase["expected"], "expected")["node"]);
    expect(nodes).toEqual(["KImport", "KImport", "KRequire", "KFlatModule", "KAtt", "KAtt", "KDefinition"]);
    // Only the last case is the `**kwargs` one.
    expect(table.cases.map((kase) => Object.keys(objectAt(kase["kwargs"], "kwargs")).length)).toEqual([
      0, 0, 0, 0, 0, 0, 1,
    ]);
  });
});

describe("parse-outer/", () => {
  test("15 files: 7 inputs, 6 expected goldens, 2 orphan .out.json", () => {
    expect(walk(PARSE_OUTER)).toHaveLength(15);
    expect(listFixtures(PARSE_OUTER, ".expected.json")).toHaveLength(6);
    expect(listFixtures(PARSE_OUTER, ".out.json")).toHaveLength(2);
    expect(existsSync(join(PARSE_OUTER, "include", "e.k"))).toBe(true);
  });

  test("every expected golden is a KDefinition whose modules have no sentences", () => {
    // pyk's `_sentence_to_ksentence` is an unimplemented stub, so upstream
    // cannot produce a sentence here. These goldens pin ordering, imports and
    // the Location codec, and nothing else — see PROVENANCE.
    for (const name of listFixtures(PARSE_OUTER, ".json")) {
      // Fixture JSON, validated field by field right here.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const parsed = JSON.parse(readFixture(PARSE_OUTER, name)) as {
        node: string;
        mainModule: string;
        modules: { node: string; localSentences: unknown[] }[];
        requires: unknown[];
      };
      expect(parsed.node).toBe("KDefinition");
      expect(parsed.requires).toEqual([]);
      expect(parsed.modules.length).toBeGreaterThan(0);
      for (const module of parsed.modules) {
        expect(module.node).toBe("KFlatModule");
        expect({ name, sentences: module.localSentences }).toEqual({ name, sentences: [] });
      }
    }
  });

  test("d.k is the diamond: 8 modules, main module D", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const parsed = JSON.parse(readFixture(PARSE_OUTER, "d.k.expected.json")) as {
      mainModule: string;
      modules: { name: string }[];
    };
    expect(parsed.mainModule).toBe("D");
    expect(parsed.modules).toHaveLength(8);
  });
});

describe("rarities/", () => {
  test("the targeted cases, with the upstream directory names preserved", () => {
    expect(walk(RARITIES).filter((path) => !path.includes("inverse-suite"))).toEqual([
      "rarities/checks/checkLexicalIdentifiers.k",
      "rarities/checks/checkRegexRanges.k",
      "rarities/checks/duplicateModule.k",
      "rarities/checks/duplicateModule.k.out",
      "rarities/checks/markdownErrorLocation.md",
      "rarities/checks/markdownErrorLocation.md.out",
      "rarities/checks/missingBar.k",
      "rarities/checks/missingBar.k.out",
      "rarities/checks/parseErrorExpected.k",
      "rarities/checks/parseErrorExpected.k.out",
      "rarities/context-alias-2/test.k",
      "rarities/context-alias/test.k",
      "rarities/markdownSelectors/test.md",
    ]);
  });

  test("each negative's .out names the phase that justifies vendoring it", () => {
    // Negatives are gated on the `[Error] …` prefix in the `.out`, never on
    // directory membership — which is why `duplicateModule.k` is a *positive*
    // despite living beside the others: its error is a post-parse check.
    expect(errorPhase("missingBar.k.out")).toBe("Outer Parser");
    expect(errorPhase("duplicateModule.k.out")).toBe("Outer Parser");
    expect(errorPhase("parseErrorExpected.k.out")).toBe("Inner Parser");
    expect(errorPhase("markdownErrorLocation.md.out")).toBe("Compiler");
  });

  test("the inverse suite is 32 .k files that must outer-parse clean", () => {
    const checks = listFixtures(join(INVERSE_SUITE, "checks"), ".k");
    const warns = listFixtures(join(INVERSE_SUITE, "checkWarns"), ".k");
    const bytes = listFixtures(join(INVERSE_SUITE, "bad-bytes-literal"), ".k");
    expect(checks).toHaveLength(12);
    expect(warns).toHaveLength(16);
    expect(bytes).toHaveLength(4);
    expect(walk(INVERSE_SUITE)).toHaveLength(32);
    // Only inputs: no `.out` here, because the assertion is "parses", not
    // "produces that message".
    expect(walk(INVERSE_SUITE).every((path) => path.endsWith(".k"))).toBe(true);
    // The 13th `[Error] Inner Parser` file is deliberately elsewhere: pyk
    // rejects it, which is a divergence rather than an inverse-suite member.
    expect(checks).not.toContain("parseErrorExpected.k");
  });
});

describe("builtin/", () => {
  const SOURCES = [
    "domains.md",
    "ffi.md",
    "json.md",
    "kast.md",
    "prelude.md",
    "rat.md",
    "substitution.md",
    "timer.md",
    "unification.k",
  ];

  test("9 prelude files, one .outer.json golden each, and the generator", () => {
    expect(SOURCES.filter((name) => existsSync(join(BUILTIN, name)))).toEqual(SOURCES);
    expect(listFixtures(BUILTIN, ".outer.json")).toHaveLength(9);
    expect(existsSync(join(BUILTIN, "dump-outer.py"))).toBe(true);
  });

  test("every golden is a Definition, for 103 modules and 578 sentences", () => {
    let modules = 0;
    let sentences = 0;
    for (const name of SOURCES) {
      // Generated by the checked-in `dump-outer.py`; its shape is that
      // script's contract, and this test is what holds it to it.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const parsed = JSON.parse(readFixture(BUILTIN, `${name}.outer.json`)) as {
        node: string;
        modules: { node: string; name: string; sentences: unknown[] }[];
        requires: { node: string; path: string }[];
      };
      expect({ name, node: parsed.node }).toEqual({ name, node: "Definition" });
      modules += parsed.modules.length;
      for (const module of parsed.modules) {
        expect(module.node).toBe("Module");
        sentences += module.sentences.length;
      }
    }
    expect(modules).toBe(103);
    expect(sentences).toBe(578);
  });

  test("prelude.md is two requires and no module — the slurping fixture", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const parsed = JSON.parse(readFixture(BUILTIN, "prelude.md.outer.json")) as {
      modules: unknown[];
      requires: { path: string }[];
    };
    expect(parsed.modules).toEqual([]);
    expect(parsed.requires.map((r) => r.path)).toEqual(["kast.md", "domains.md"]);
  });

  test("domains.md is the biggest thing here, and it is real K", () => {
    const text = readFixture(BUILTIN, "domains.md");
    expect(text.length).toBe(123428);
    expect(text).toContain("module INT");
    expect(text).toContain("smt-hook");
  });
});

describe("imp-outer-json/", () => {
  test("Java's outer-parsed IMP: 89 modules, 802 sentences, 218 bubbles", () => {
    // The only oracle here independent of pyk, and the acceptance test for the
    // net-new sentence layer. Counting nodes rather than trusting a header is
    // the point: these three numbers are what phase 5 has to reproduce.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const parsed = JSON.parse(readFixture(IMP_OUTER_JSON, "imp.json")) as {
      format: string;
      version: number;
      term: { node: string; modules: { localSentences: { node: string }[] }[] };
    };
    expect(parsed.format).toBe("KAST");
    expect(parsed.version).toBe(4);
    expect(parsed.term.node).toBe("KDefinition");
    expect(parsed.term.modules).toHaveLength(89);

    const sentences = parsed.term.modules.flatMap((module) => module.localSentences);
    expect(sentences).toHaveLength(802);
    expect(sentences.filter((sentence) => sentence.node === "KBubble")).toHaveLength(218);
  });

  test("imp.k is beside it — the input, from imp-llvm, not imp-semantics", () => {
    // `imp-semantics` has no license grant at all, so it is never vendored.
    // Note what `imp.k` does *not* have: a `requires` line. The 89 modules in
    // `imp.json` come from the prelude `kompile` splices in, not from this
    // file, which is why the two are vendored together.
    const text = readFixture(IMP_OUTER_JSON, "imp.k");
    expect(text).toContain("module IMP-SYNTAX");
    expect(text).toContain("module IMP\n");
    expect(text).not.toContain('requires "');
    // A user list — the one production form Java expands and this package
    // will not, the known gap in the `imp.json` diff.
    expect(text).toContain('List{Id,","}');
  });
});

describe("PROVENANCE.md", () => {
  test("records exactly the 130 vendored or provenance-backed files — no more, no fewer", () => {
    const recorded = recordedChecksums();
    expect(recorded).toHaveLength(130);

    const vendored = walk(FIXTURES).filter(
      (path) =>
        !path.endsWith(".outer.json") &&
        !path.endsWith(".py") &&
        !path.startsWith("pyk-unit") &&
        !path.startsWith("label-precedence/") &&
        path !== "PROVENANCE.md",
    );
    expect(recorded.map(([, path]) => path).toSorted()).toEqual(vendored.toSorted());
  });

  test("every recorded sha256 is the file's actual sha256", () => {
    // This is the whole reason the checksum block is in the tree: it turns a
    // claim about provenance into something a test can re-derive.
    for (const [expected, path] of recordedChecksums()) {
      const actual = createHash("sha256")
        .update(readFileSync(join(FIXTURES, path)))
        .digest("hex");
      expect({ path, sha256: actual }).toEqual({ path, sha256: expected });
    }
  });
});
