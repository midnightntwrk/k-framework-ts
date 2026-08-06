/**
 * `src/parser.ts`, against every oracle the corpus provides.
 *
 * Six layers, in the order a failure is easiest to read:
 *
 * 1. **pyk's own 89 table cases** (`fixtures/pyk-unit/outer-parser-*.json`):
 *    72 sentences, 3 imports, 7 modules with their location tuples, 6
 *    definitions and the one `require`, each driving the same public method
 *    upstream's test drives.  They are compared through {@link syntaxToDict},
 *    because the extractor wrote them with *that* encoder — so a mismatch is
 *    reported as a JSON diff rather than as "two frozen objects differ".
 * 2. **The end-to-end golden diff**: all nine vendored prelude files
 *    (`fixtures/builtin/`, `domains.md` among them) parsed and encoded, then
 *    deep-equalled against the `.outer.json` `dump-outer.py` produced from pyk.
 *    123 KB of real K per file, node for node.
 * 3. **The `parse-outer/` corpus**: the seven inputs `test_utils.py` drives,
 *    parsed for shape rather than for content.
 * 4. **The inverse suite** — 32 files that fail `kompile` for reasons
 *    downstream of outer parsing, so must parse clean here — and the three
 *    negatives, one of which (`duplicateModule.k`) is a *positive* because its
 *    check is a post-parse one this package does not do.
 * 5. **The named contract items**: the NAT
 *    asymmetry, user-list and function-style detection, the named-non-terminal
 *    `or`, `REGEX`'s absence from the continuation set, `maybeAtt`'s value
 *    rules, and the two `source`/`location` tests transcribed from
 *    `test_outer_parser.py:500-523`.
 * 6. **Error-message parity**, six inputs whose message was read off a real
 *    pyk at K v7.1.337 and pasted into the test beside the assertion.
 *
 * Every "pyk today" claim in this file was produced by running
 * `PYTHONPATH=<k-checkout>/pyk/src python3 -c …` against the checkout
 * `fixtures/PROVENANCE.md` names, and the transcript is quoted at the
 * assertion that depends on it.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { syntaxToDict } from "../src/astJson.ts";
import { KParseError } from "../src/lexer.ts";
import { selectCodeBlocks } from "../src/markdown.ts";
import { OuterParser } from "../src/parser.ts";
import {
  BUILTIN,
  INVERSE_SUITE,
  PARSE_OUTER,
  RARITIES,
  listFixtures,
  readFixture,
  readPykUnitTable,
} from "./fixtures.ts";

/////////////////////////////////////////
// Helpers                             //
/////////////////////////////////////////

/** A case field as a string, throwing rather than casting, as the sibling tests do. */
function str(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new TypeError(`${field} is not a string: ${JSON.stringify(value)}`);
  return value;
}

/** The whole `.k`/`.md` tree under `dir`, sorted — `listFixtures` does not descend. */
function walkFixtures(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? walkFixtures(path) : [path];
    })
    .toSorted();
}

/**
 * The `.outer.json`-shaped encoding of whatever a parser method returned.
 *
 * Typed `unknown` because it is compared against a `JSON.parse`d golden, which
 * is `unknown` too — the assertion is the type check.
 */
function parse(
  text: string,
  method: "definition" | "module" | "sentence" | "importt" | "require",
  source?: string,
): unknown {
  const parser = new OuterParser(text, source);
  switch (method) {
    case "definition":
      return syntaxToDict(parser.definition());
    case "module":
      return syntaxToDict(parser.module());
    case "sentence":
      return syntaxToDict(parser.sentence());
    case "importt":
      return syntaxToDict(parser.importt());
    case "require":
      return syntaxToDict(parser.require());
    default:
      throw new TypeError(`no such method: ${String(method)}`);
  }
}

/** The one and only sentence of a one-module definition. */
function onlySentence(text: string) {
  const definition = new OuterParser(text).definition();
  const module = definition.modules[0];
  if (module === undefined) throw new TypeError(`no module in ${JSON.stringify(text)}`);
  const sentence = module.sentences[0];
  if (sentence === undefined) throw new TypeError(`no sentence in ${JSON.stringify(text)}`);
  return sentence;
}

/** The same, encoded. */
function onlySentenceDict(text: string) {
  return syntaxToDict(onlySentence(text));
}

/** What a call threw, as a {@link KParseError}, failing the test when it threw nothing. */
function thrownBy(run: () => unknown): KParseError {
  try {
    run();
  } catch (error) {
    if (error instanceof KParseError) return error;
    throw error;
  }
  throw new TypeError("expected a KParseError, nothing was thrown");
}

/////////////////////////////////////////
// 1. pyk's extracted tables           //
/////////////////////////////////////////

describe("pyk unit tables", () => {
  const tables = [
    { file: "outer-parser-sentence.json", method: "sentence", table: "SENTENCE_TEST_DATA", count: 72 },
    { file: "outer-parser-import.json", method: "importt", table: "IMPORT_TEST_DATA", count: 3 },
    { file: "outer-parser-module.json", method: "module", table: "MODULE_TEST_DATA", count: 7 },
    { file: "outer-parser-definition.json", method: "definition", table: "DEFINITION_TEST_DATA", count: 6 },
    { file: "outer-parser-require.json", method: "require", table: "test_require", count: 1 },
  ] as const;

  test("the five tables hold the 89 cases PROVENANCE.md records", () => {
    const counts = tables.map(({ file }) => readPykUnitTable(file).cases.length);
    expect(counts).toEqual(tables.map(({ count }) => count));
    expect(counts.reduce((total, count) => total + count, 0)).toBe(89);
  });

  for (const { file, method, table } of tables) {
    describe(`${method}() (${table})`, () => {
      const data = readPykUnitTable(file);

      test("the table is the one it says it is", () => {
        expect(data.table).toBe(table);
        expect(data.source).toBe("pyk/src/tests/unit/kast/test_outer_parser.py");
        expect(data.fields).toEqual(["kText", "expected"]);
      });

      for (const [index, testCase] of data.cases.entries()) {
        const kText = str(testCase, "kText");
        test(`${index}: ${JSON.stringify(kText)}`, () => {
          expect(parse(kText, method)).toEqual(testCase["expected"]);
        });
      }
    });
  }
});

/////////////////////////////////////////
// 2. The end-to-end golden diff       //
/////////////////////////////////////////

describe("builtin prelude goldens", () => {
  const names = [...listFixtures(BUILTIN, ".k"), ...listFixtures(BUILTIN, ".md")].toSorted();

  test("all 9 prelude files are read", () => {
    expect(names).toEqual([
      "domains.md",
      "ffi.md",
      "json.md",
      "kast.md",
      "prelude.md",
      "rat.md",
      "substitution.md",
      "timer.md",
      "unification.k",
    ]);
  });

  for (const name of names) {
    test(`${name} encodes to its .outer.json byte for byte`, () => {
      const raw = readFixture(BUILTIN, name);
      // `dump-outer.py` selects `.md` with `'k'` and parses `.k` as-is, gated
      // purely on the suffix — `utils.py:74`.
      const text = name.endsWith(".md") ? selectCodeBlocks(raw, "k") : raw;
      const actual: unknown = syntaxToDict(new OuterParser(text).definition());
      const expected: unknown = JSON.parse(readFixture(BUILTIN, `${name}.outer.json`));
      expect(actual).toEqual(expected);
      // Key *order* is not `toEqual`'s business, and the goldens are text a
      // human reads in a diff, so pin it too.
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    });
  }

  test("the goldens carry no `source`, because dump-outer.py passed none", () => {
    for (const name of names) {
      expect(readFixture(BUILTIN, `${name}.outer.json`)).not.toContain('"source"');
    }
  });
});

/////////////////////////////////////////
// 3. The parse-outer corpus           //
/////////////////////////////////////////

describe("parse-outer corpus", () => {
  const inputs = ["a.k", "b.k", "c.k", "d.k", "include.k", "include/e.k", "markdown.md"] as const;

  for (const name of inputs) {
    test(`${name} parses`, () => {
      const raw = readFixture(PARSE_OUTER, name);
      const text = name.endsWith(".md") ? selectCodeBlocks(raw, "k") : raw;
      expect(() => new OuterParser(text, name).definition()).not.toThrow();
    });
  }

  test("a.k is two modules and no requires", () => {
    const definition = new OuterParser(readFixture(PARSE_OUTER, "a.k")).definition();
    expect(definition.modules.map((module) => module.name)).toEqual(["A-SYNTAX", "A"]);
    expect(definition.requires).toEqual([]);
    expect(definition.modules[1]?.imports.map((each) => each.moduleName)).toEqual(["A-SYNTAX"]);
  });

  test("b.k requires a.k and imports A", () => {
    const definition = new OuterParser(readFixture(PARSE_OUTER, "b.k")).definition();
    expect(definition.requires.map((each) => each.path)).toEqual(["a.k"]);
    expect(definition.modules.map((module) => module.name)).toEqual(["B-SYNTAX", "B"]);
    expect(definition.modules.flatMap((module) => module.imports.map((each) => each.moduleName))).toEqual([
      "B-SYNTAX",
      "A",
    ]);
  });

  test("markdown.md needs selecting first — the raw text yields nothing", () => {
    const raw = readFixture(PARSE_OUTER, "markdown.md");
    expect(new OuterParser(selectCodeBlocks(raw, "k")).definition().modules[0]?.name).toBe("MARKDOWN");
    // Unselected, the file opens with prose, so `definition()` stops before the
    // first `module` keyword rather than throwing: `require*` then `module*`
    // are both allowed to match nothing (`outer_parser.py:110-119`).
    expect(new OuterParser(raw).definition().modules).toHaveLength(0);
  });
});

/////////////////////////////////////////
// 4. The inverse suite and negatives  //
/////////////////////////////////////////

describe("inverse suite: 32 files that must outer-parse clean", () => {
  const paths = walkFixtures(INVERSE_SUITE);

  test("all 32 files are read", () => {
    expect(paths).toHaveLength(32);
    expect(paths.every((path) => path.endsWith(".k"))).toBe(true);
  });

  for (const path of paths) {
    const name = path.slice(INVERSE_SUITE.length + 1);
    test(`${name} parses, bubbles opaque`, () => {
      const definition = new OuterParser(readFileSync(path, "utf8"), name).definition();
      expect(definition.modules.length).toBeGreaterThan(0);
    });
  }
});

describe("negatives", () => {
  // pyk at v7.1.337, verified by running it:
  //   >>> OuterParser(Path('missingBar.k').read_text(), source=Path('missingBar.k')).definition()
  //   ValueError: missingBar.k:5:18: Expected KW_CLAIM, KW_CONFIG, KW_RULE, got: ID_LOWER
  test("checks/missingBar.k is a true outer-parse error, at 5:18", () => {
    const text = readFixture(RARITIES, "checks", "missingBar.k");
    const error = thrownBy(() => new OuterParser(text, "missingBar.k").definition());
    expect(error.message).toBe("missingBar.k:5:18: Expected KW_CLAIM, KW_CONFIG, KW_RULE, got: ID_LOWER");
    expect([error.line, error.col]).toEqual([5, 18]);
    expect(error.source).toBe("missingBar.k");
  });

  test("checks/missingBar.k's .out confirms it is the outer parser that rejects it", () => {
    expect(readFixture(RARITIES, "checks", "missingBar.k.out")).toContain("[Error] Outer Parser");
  });

  // The one file whose `.out` says `[Error] Outer Parser` and which nonetheless
  // parses: the duplicate is found *after* parsing, and post-parse validation is
  // deliberately out of scope.  Verified against pyk, which also parses it clean.
  test("checks/duplicateModule.k parses clean — its check is a post-parse one", () => {
    const text = readFixture(RARITIES, "checks", "duplicateModule.k");
    const definition = new OuterParser(text, "duplicateModule.k").definition();
    expect(definition.modules.map((module) => module.name)).toEqual(["DUPLICATEMODULE", "DUPLICATEMODULE"]);
    expect(readFixture(RARITIES, "checks", "duplicateModule.k.out")).toContain("[Error] Outer Parser");
  });

  // pyk at v7.1.337:
  //   ValueError: parseErrorExpected.k:11:1: Expected BUBBLE, got: KW_RULE
  // Java outer-parses this and reports five *inner* errors instead, which is why
  // the `.out` says `[Error] Inner Parser`.  Pinned as the divergence it is.
  test("checks/parseErrorExpected.k: an empty bubble is a pyk divergence from Java", () => {
    const text = readFixture(RARITIES, "checks", "parseErrorExpected.k");
    const error = thrownBy(() => new OuterParser(text, "parseErrorExpected.k").definition());
    expect(error.message).toBe("parseErrorExpected.k:11:1: Expected BUBBLE, got: KW_RULE");
    expect(readFixture(RARITIES, "checks", "parseErrorExpected.k.out")).toContain("[Error] Inner Parser");
  });
});

describe("rarities that parse", () => {
  const cases = [
    { name: "context-alias/test.k", modules: 1, sentences: 19 },
    { name: "context-alias-2/test.k", modules: 1, sentences: 14 },
    { name: "checks/checkLexicalIdentifiers.k", modules: 2, sentences: 11 },
    { name: "checks/checkRegexRanges.k", modules: 1, sentences: 4 },
  ] as const;

  for (const { name, modules, sentences } of cases) {
    test(`${name}: ${modules} modules, ${sentences} sentences — as pyk`, () => {
      const definition = new OuterParser(readFixture(RARITIES, name), name).definition();
      expect(definition.modules).toHaveLength(modules);
      expect(definition.modules.reduce((total, module) => total + module.sentences.length, 0)).toBe(sentences);
    });
  }

  test("context-alias/test.k really does produce Aliases — the `context alias` re-key", () => {
    const definition = new OuterParser(readFixture(RARITIES, "context-alias", "test.k")).definition();
    const counts: Record<string, number> = {};
    for (const module of definition.modules) {
      for (const sentence of module.sentences) counts[sentence.node] = (counts[sentence.node] ?? 0) + 1;
    }
    expect(counts).toEqual({ Config: 1, Alias: 3, SyntaxDefn: 5, Rule: 10 });
  });

  test("context-alias-2/test.k: the same three Aliases, this time with labels", () => {
    const definition = new OuterParser(readFixture(RARITIES, "context-alias-2", "test.k")).definition();
    const aliases = definition.modules.flatMap((module) =>
      module.sentences.filter((sentence) => sentence.node === "Alias"),
    );
    expect(aliases).toHaveLength(3);
    expect(aliases.map((each) => each.label)).toEqual(["left", "middle", "right"]);
  });
});

/////////////////////////////////////////
// 5. The named contract items         //
/////////////////////////////////////////

describe("§4.6 source and location (test_outer_parser.py:500-523)", () => {
  test("without a source, a bubble carries neither source nor location", () => {
    const rule = new OuterParser("rule X => Y").sentence();
    expect(rule.node).toBe("Rule");
    expect(rule.source).toBeUndefined();
    expect(rule.location).toBeUndefined();
    expect(syntaxToDict(rule)).toEqual({
      node: "Rule",
      bubble: "X => Y",
      label: "",
      att: { node: "Att", items: [] },
    });
  });

  test("with a source, it carries both, the location degenerate", () => {
    const rule = new OuterParser("rule X => Y", "test.k").sentence();
    expect(rule.source).toBe("test.k");
    // `rule ` is five characters, so the bubble starts at column 6, and the
    // "end" is the start repeated: Java reads it as contentStartLine/Column.
    expect(rule.location).toEqual([1, 6, 1, 6]);
    expect(syntaxToDict(rule)).toEqual({
      node: "Rule",
      source: "test.k",
      location: [1, 6, 1, 6],
      bubble: "X => Y",
      label: "",
      att: { node: "Att", items: [] },
    });
  });

  test("a module records its location always, and its source even when undefined", () => {
    const module = new OuterParser("module FOO endmodule").module();
    expect(module.location).toEqual([1, 1, 1, 21]);
    expect(module.source).toBeUndefined();
    expect("source" in module).toBe(true);
    expect(new OuterParser("module FOO endmodule", "m.k").module().source).toBe("m.k");
  });

  test("a module's location spans to one past `endmodule`, across lines", () => {
    const module = new OuterParser("\n  module FOO\n  endmodule").module();
    expect(module.location).toEqual([2, 3, 3, 12]);
  });
});

describe("§4.9 the NAT asymmetry (outer_parser.py:243-267)", () => {
  test("SortDecl keeps a NAT argument as a string", () => {
    expect(onlySentenceDict("module M syntax MInt{8} endmodule")).toEqual({
      node: "SyntaxDecl",
      decl: { node: "SortDecl", name: "MInt", params: [], args: ["8"] },
      att: { node: "Att", items: [] },
    });
  });

  test("Sort converts a NAT argument to a number", () => {
    expect(onlySentenceDict("module M syntax Foo ::= MInt{8} endmodule")).toEqual({
      node: "SyntaxDefn",
      decl: { node: "SortDecl", name: "Foo", params: [], args: [] },
      blocks: [
        {
          node: "PriorityBlock",
          productions: [
            {
              node: "Production",
              items: [{ node: "NonTerminal", sort: { node: "Sort", name: "MInt", args: [8] }, name: "" }],
              att: { node: "Att", items: [] },
            },
          ],
          assoc: null,
        },
      ],
    });
  });

  test("the two survive side by side in one synonym", () => {
    // `Foo{4}` is the declaration — strings — and `MInt{8}` is the use — numbers.
    const real = onlySentence("module M syntax Foo{4} = MInt{8} endmodule");
    expect(real.node).toBe("SyntaxSynonym");
    expect(syntaxToDict(real)).toEqual({
      node: "SyntaxSynonym",
      new: { node: "SortDecl", name: "Foo", params: [], args: ["4"] },
      old: { node: "Sort", name: "MInt", args: [8] },
      att: { node: "Att", items: [] },
    });
  });

  test("params come before the name, args after it", () => {
    expect(onlySentenceDict("module M syntax {P, Q} Foo{A, B} endmodule")).toEqual({
      node: "SyntaxDecl",
      decl: { node: "SortDecl", name: "Foo", params: ["P", "Q"], args: ["A", "B"] },
      att: { node: "Att", items: [] },
    });
  });
});

describe("§4.10 productionLike detection (outer_parser.py:288-323)", () => {
  test('List{Foo, ","} is a UserList, non-empty false', () => {
    expect(onlySentenceDict('module M syntax Foo ::= List{Bar, ","} endmodule')).toMatchObject({
      blocks: [{ productions: [{ node: "UserList", sort: "Bar", sep: ",", non_empty: false }] }],
    });
  });

  test('NeList{Foo, ","} is a UserList, non-empty true — the text[0] === "N" test', () => {
    expect(onlySentenceDict('module M syntax Foo ::= NeList{Bar, ","} endmodule')).toMatchObject({
      blocks: [{ productions: [{ node: "UserList", sort: "Bar", sep: ",", non_empty: true }] }],
    });
  });

  test("any other Name{…} is an ordinary production, not a user list", () => {
    expect(onlySentenceDict("module M syntax Foo ::= Map{Bar} endmodule")).toMatchObject({
      blocks: [
        {
          productions: [{ node: "Production", items: [{ node: "NonTerminal", sort: { name: "Map", args: ["Bar"] } }] }],
        },
      ],
    });
  });

  test("a function-style production makes Terminals of the name, parens and commas", () => {
    expect(onlySentenceDict("module M syntax Foo ::= f(Bar, Baz) endmodule")).toMatchObject({
      blocks: [
        {
          productions: [
            {
              node: "Production",
              items: [
                { node: "Terminal", value: "f" },
                { node: "Terminal", value: "(" },
                { node: "NonTerminal", sort: { name: "Bar" } },
                { node: "Terminal", value: "," },
                { node: "NonTerminal", sort: { name: "Baz" } },
                { node: "Terminal", value: ")" },
              ],
            },
          ],
        },
      ],
    });
  });

  test("an empty argument list is accepted: the `)` test comes first", () => {
    expect(onlySentenceDict("module M syntax Foo ::= f() endmodule")).toMatchObject({
      blocks: [
        {
          productions: [
            {
              node: "Production",
              items: [
                { node: "Terminal", value: "f" },
                { node: "Terminal", value: "(" },
                { node: "Terminal", value: ")" },
              ],
            },
          ],
        },
      ],
    });
  });
});

describe("§4.11 REGEX is not in the production-item continuation set", () => {
  test('r"a" "b" is one two-item production', () => {
    expect(onlySentenceDict('module M syntax Foo ::= r"a" "b" endmodule')).toMatchObject({
      blocks: [
        {
          productions: [
            {
              items: [
                { node: "Lexical", regex: "a" },
                { node: "Terminal", value: "b" },
              ],
            },
          ],
        },
      ],
    });
  });

  // pyk at v7.1.337, verified by running it:
  //   >>> OuterParser('module M syntax Foo ::= "b" r"a" endmodule', source=Path('test.k')).definition()
  //   ValueError: test.k:1:29: Expected KW_CLAIM, KW_CONFIG, KW_RULE, got: REGEX
  test('"b" r"a" stops after "b", and the regex is then an unexpected sentence', () => {
    const error = thrownBy(() => new OuterParser('module M syntax Foo ::= "b" r"a" endmodule', "test.k").definition());
    expect(error.message).toBe("test.k:1:29: Expected KW_CLAIM, KW_CONFIG, KW_RULE, got: REGEX");
  });
});

describe("named non-terminals (outer_parser.py:334-341)", () => {
  test("`foo: Bar` is named — the ID_LOWER half of the `or`", () => {
    expect(onlySentenceDict("module M syntax Foo ::= foo: Bar endmodule")).toMatchObject({
      blocks: [{ productions: [{ items: [{ node: "NonTerminal", sort: { name: "Bar" }, name: "foo" }] }] }],
    });
  });

  test("`Foo: Bar` is named — the la2-is-COLON half", () => {
    expect(onlySentenceDict("module M syntax Foo ::= Baz: Bar endmodule")).toMatchObject({
      blocks: [{ productions: [{ items: [{ node: "NonTerminal", sort: { name: "Bar" }, name: "Baz" }] }] }],
    });
  });

  test("a bare sort is anonymous, its name the empty string", () => {
    expect(onlySentenceDict("module M syntax Foo ::= Bar endmodule")).toMatchObject({
      blocks: [{ productions: [{ items: [{ node: "NonTerminal", sort: { name: "Bar" }, name: "" }] }] }],
    });
  });
});

describe("maybeAtt (outer_parser.py:376-410)", () => {
  test("no bracket at all is EMPTY_ATT, the interned one", () => {
    const rule = new OuterParser("rule x").stringSentence();
    expect(rule.att.items).toEqual([]);
    expect(rule.att).toBe(new OuterParser("rule y").stringSentence().att);
  });

  test("a key without parentheses and `key()` both have the empty string", () => {
    expect(onlySentenceDict("module M rule x [a, b()] endmodule")).toMatchObject({
      att: {
        items: [
          ["a", ""],
          ["b", ""],
        ],
      },
    });
  });

  test("ATTR_CONTENT is verbatim, nested parentheses and all", () => {
    expect(onlySentenceDict("module M rule x [smt-hook((and #1 #2))] endmodule")).toMatchObject({
      att: { items: [["smt-hook", "(and #1 #2)"]] },
    });
  });

  test("a STRING value is dequoted, escapes decoded", () => {
    expect(onlySentenceDict('module M rule x [key("value\\n")] endmodule')).toMatchObject({
      att: { items: [["key", "value\n"]] },
    });
  });

  test("pairs keep their order, duplicates included", () => {
    expect(onlySentenceDict("module M rule x [foo(1), bar, foo(2)] endmodule")).toMatchObject({
      att: {
        items: [
          ["foo", "1"],
          ["bar", ""],
          ["foo", "2"],
        ],
      },
    });
  });

  test("a dotted key is one key", () => {
    expect(onlySentenceDict("module M rule x [org.kframework.attributes.Location(1)] endmodule")).toMatchObject({
      att: { items: [["org.kframework.attributes.Location", "1"]] },
    });
  });
});

describe("dequoting (outer_parser.py:413-418)", () => {
  test("a require path loses its quotes and decodes its escapes", () => {
    expect(new OuterParser('requires "a\\tb.k"').require().path).toBe("a\tb.k");
  });

  test("a terminal loses its quotes", () => {
    expect(onlySentenceDict('module M syntax Foo ::= "a\\"b" endmodule')).toMatchObject({
      blocks: [{ productions: [{ items: [{ node: "Terminal", value: 'a"b' }] }] }],
    });
  });

  test('a regex loses `r"` and `"`, and `_dequote_regex` slices two characters', () => {
    expect(onlySentenceDict('module M syntax lexical Foo = r"[a-z]+" endmodule')).toEqual({
      node: "SyntaxLexical",
      name: "Foo",
      regex: "[a-z]+",
    });
  });
});

describe("assoc, priority and the six syntax forms", () => {
  test("`syntax left a b` is a SyntaxAssoc keyed by member name", () => {
    expect(onlySentenceDict("module M syntax left foo bar endmodule")).toEqual({
      node: "SyntaxAssoc",
      assoc: "LEFT",
      klabels: ["foo", "bar"],
    });
  });

  test("`non-assoc` is NON_ASSOC, not the source keyword", () => {
    expect(onlySentenceDict("module M syntax non-assoc foo endmodule")).toEqual({
      node: "SyntaxAssoc",
      assoc: "NON_ASSOC",
      klabels: ["foo"],
    });
  });

  test("`syntax priority a b > c` groups by `>`", () => {
    expect(onlySentenceDict("module M syntax priority a b > c endmodule")).toEqual({
      node: "SyntaxPriority",
      groups: [["a", "b"], ["c"]],
    });
  });

  test("a block's associativity is the `left:` prefix, and it needs its colon", () => {
    expect(onlySentenceDict('module M syntax Foo ::= left: "a" > right: "b" endmodule')).toMatchObject({
      blocks: [{ assoc: "LEFT" }, { assoc: "RIGHT" }],
    });
  });

  test("a block with no associativity has null, not an absent key", () => {
    const encoded = onlySentenceDict('module M syntax Foo ::= "a" endmodule');
    expect(JSON.stringify(encoded)).toContain('"assoc":null');
  });
});

describe("stringSentence dispatch (outer_parser.py:345-374)", () => {
  const keywords = [
    { text: "rule x", node: "Rule" },
    { text: "claim x", node: "Claim" },
    { text: "configuration x", node: "Config" },
    { text: "context x", node: "Context" },
    { text: "context alias x", node: "Alias" },
  ] as const;

  for (const { text, node } of keywords) {
    test(`${JSON.stringify(text)} is a ${node}`, () => {
      expect(new OuterParser(text).sentence().node).toBe(node);
    });
  }

  test("`context alias` re-keys the node; a plain `context` does not", () => {
    expect(new OuterParser("context alias x").sentence().node).toBe("Alias");
    expect(new OuterParser("context aliasx").sentence()).toMatchObject({ node: "Context", bubble: "aliasx" });
  });

  test("a `[label]:` prefix becomes the label, not part of the bubble", () => {
    expect(new OuterParser("rule [label]: X => Y").sentence()).toMatchObject({ label: "label", bubble: "X => Y" });
  });

  test("a label with `_` in it is not a label — it stays bubble text", () => {
    expect(new OuterParser("rule [my_rule]: X").sentence()).toMatchObject({ label: "", bubble: "[my_rule]: X" });
  });
});

/////////////////////////////////////////
// 6. Divergences and message parity   //
/////////////////////////////////////////

// Recorded from a real pyk at K v7.1.337:
//   PYTHONPATH=<k>/pyk/src python3 -c "
//     from pathlib import Path
//     from pyk.kast.outer_parser import OuterParser
//     OuterParser('module M syntax Foo ::= f(/* c */) endmodule', source=Path('test.k')).definition()"
//   ValueError: test.k:1:36: Expected ID_UPPER, got: KW_ENDMODULE
describe("known divergence: `f(/* comment */)` is rejected", () => {
  test("pyk rejects an argument list holding only a comment; Java accepts it", () => {
    const error = thrownBy(() =>
      new OuterParser("module M syntax Foo ::= f(/* c */) endmodule", "test.k").definition(),
    );
    expect(error.message).toBe("test.k:1:36: Expected ID_UPPER, got: KW_ENDMODULE");
  });

  test("the same production without the comment parses", () => {
    expect(() => new OuterParser("module M syntax Foo ::= f(Bar) endmodule").definition()).not.toThrow();
  });
});

describe("error-message parity with pyk", () => {
  // Each `pyk` line below is the literal `ValueError` text a real pyk at
  // v7.1.337 printed for that input with `source=Path('test.k')`.
  const cases = [
    {
      name: "a sentence that is neither `syntax` nor a bubble keyword",
      text: "module M foo endmodule",
      pyk: "test.k:1:10: Expected KW_CLAIM, KW_CONFIG, KW_RULE, got: ID_LOWER",
    },
    {
      name: "end of input inside a module",
      text: "module M",
      pyk: "test.k:1:8: Expected KW_CLAIM, KW_CONFIG, KW_RULE, got: EOF",
    },
    {
      name: "a regex where a sentence was expected",
      text: 'module M syntax Foo ::= "b" r"a" endmodule',
      pyk: "test.k:1:29: Expected KW_CLAIM, KW_CONFIG, KW_RULE, got: REGEX",
    },
    {
      name: "an argument list holding only a comment",
      text: "module M syntax Foo ::= f(/* c */) endmodule",
      pyk: "test.k:1:36: Expected ID_UPPER, got: KW_ENDMODULE",
    },
  ] as const;

  for (const { name, text, pyk } of cases) {
    test(`${name} — message is pyk's byte for byte`, () => {
      expect(thrownBy(() => new OuterParser(text, "test.k").definition()).message).toBe(pyk);
    });
  }

  // pyk at v7.1.337:
  //   'module M syntax Foo ::= 3(Bar) endmodule'
  //     → ValueError: test.k:1:25: Expected ID_LOWER, ID_UPPER, got: NAT
  //   'module M syntax Foo ::= foo: 3 endmodule'
  //     → ValueError: test.k:1:30: Expected ID_UPPER, got: NAT
  test("a multi-name expected list is joined with `, `, sorted", () => {
    // Every expected-set upstream *reaches* an error with is already in sorted
    // order (`_ID_TOKENS`, `_SIMPLE_BUBBLE_TOKENS`), so `sorted()` is not
    // observable on real input — it is transcribed for fidelity, and the two
    // cases here pin the formatting either way.
    const two = thrownBy(() => new OuterParser("module M syntax Foo ::= 3(Bar) endmodule", "test.k").definition());
    expect(two.message).toBe("test.k:1:25: Expected ID_LOWER, ID_UPPER, got: NAT");
    const one = thrownBy(() => new OuterParser("module M syntax Foo ::= foo: 3 endmodule", "test.k").definition());
    expect(one.message).toBe("test.k:1:30: Expected ID_UPPER, got: NAT");
  });

  test("without a source the description is pyk's but the position is ours", () => {
    // pyk: `ValueError: Expected KW_CLAIM, KW_CONFIG, KW_RULE, got: ID_LOWER` —
    // no position at all.  The declared deviation (`lexer.ts`, deviation 2) is
    // that every failure here carries one.
    const error = thrownBy(() => new OuterParser("module M foo endmodule").definition());
    expect(error.description).toBe("Expected KW_CLAIM, KW_CONFIG, KW_RULE, got: ID_LOWER");
    expect(error.message).toBe("1:10: Expected KW_CLAIM, KW_CONFIG, KW_RULE, got: ID_LOWER");
    expect(error.source).toBeUndefined();
  });

  // pyk at v7.1.337: `ValueError: Unexpected token: endmodule` — this one comes
  // from the *lexer*, which pyk gives no source either, so both halves agree.
  test("`syntax endmodule` is a lexical failure, with pyk's wording", () => {
    const error = thrownBy(() => new OuterParser("module M syntax endmodule", "test.k").definition());
    expect(error.description).toBe("Unexpected token: endmodule");
  });

  // pyk at v7.1.337:
  //   >>> OuterParser('module M syntax', source=Path('test.k')).definition()
  //   ValueError: test.k:1:15: Unexpected token: EOF
  test("`Unexpected token: X` is the parser's message when nothing was expected", () => {
    // `syntax_sentence`'s fall-through (`:223`) passes no expected types.  It is
    // hard to reach: the lexer's SYNTAX state emits only `{`, an `ID_UPPER` and
    // the six syntax keywords, every one of which the dispatch above handles —
    // so end of input is the only token that gets here.
    const error = thrownBy(() => new OuterParser("module M syntax", "test.k").definition());
    expect(error.message).toBe("test.k:1:15: Unexpected token: EOF");
  });
});

describe("reading past the end is not a crash", () => {
  test("an empty definition is a Definition with nothing in it", () => {
    expect(syntaxToDict(new OuterParser("").definition())).toEqual({
      node: "Definition",
      modules: [],
      requires: [],
    });
  });

  test("a second definition() after the input ran out is still empty", () => {
    const parser = new OuterParser("module FOO endmodule");
    expect(parser.definition().modules).toHaveLength(1);
    expect(parser.definition().modules).toHaveLength(0);
    expect(parser.definition().modules).toHaveLength(0);
  });

  test("one parser reads consecutive constructs from one stream", () => {
    const parser = new OuterParser('requires "a.k" module FOO endmodule');
    expect(parser.require().path).toBe("a.k");
    expect(parser.module().name).toBe("FOO");
    expect(parser.definition().modules).toHaveLength(0);
  });
});
