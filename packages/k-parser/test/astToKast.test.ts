/**
 * `src/astToKast.ts` — the surface AST → `KDefinition` conversion.
 *
 * Three oracles, in increasing strength:
 *
 * 1. **pyk's own `test_ast_to_kast.py` table** (7 cases,
 *    `fixtures/pyk-unit/ast-to-kast.json`) — everything upstream could test,
 *    which is tier 1 only.
 * 2. **The six `parse-outer/*.expected.json` goldens** — pyk's end-to-end
 *    `parse_outer` output, byte for byte through `KDefinition.toDict()`.  They
 *    pin DFS order, include-dir resolution, markdown selection, `Location`
 *    injection and the dropped `requires`.  Every one of them has
 *    `"localSentences": []`, because pyk cannot convert a sentence.
 * 3. **Java's `imp.json`** — the only oracle for the sentence layer, and the
 *    only one independent of pyk.  See {@link NORMALIZATIONS} below for the
 *    exact tolerances and why each exists.
 *
 * Plus unit tests for the pieces the oracles exercise but do not *isolate*:
 * klabel generation, user-list expansion, the `strictAtts` throw.
 */

import { describe, expect, test } from "bun:test";
import { Atts, canonicalJson, ksort, type JsonObject, type JsonValue } from "@kframework-ts/kast";
import { join } from "node:path";
import {
  astToKast,
  attToKAtt,
  buildTagIndex,
  importToKImport,
  moduleToKFlatModule,
  productionKLabel,
  requireToKRequire,
  sentenceToKSentences,
} from "../src/astToKast.ts";
import { OuterParser } from "../src/parser.ts";
import { parseOuter, slurpDefinitions } from "../src/slurp.ts";
import {
  att,
  definition,
  importt,
  module,
  nonTerminal,
  priorityBlock,
  production,
  require as requireOf,
  sort,
  sortDecl,
  syntaxDefn,
  terminal,
  userList,
  type Ast,
  type Att,
  type Import,
  type Module,
  type Require,
  type Sentence,
} from "../src/syntax.ts";
import { BUILTIN, IMP_OUTER_JSON, PARSE_OUTER, readFixture, readPykUnitTable } from "./fixtures.ts";

//////////////////////////////
// Reading JSON, in one place//
//////////////////////////////

/**
 * The unchecked narrowings this file makes into JSON trees.
 *
 * Both sides of every diff below are `JsonValue`: one produced by
 * `KDefinition.toDict()`, one vendored from Java.  A test that re-validated
 * their shape would be testing `packages/kast`'s decoders rather than this
 * package's conversion, so the narrowing lives in these five one-liners —
 * unchecked exactly once each — instead of in ninety inline assertions.
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const obj = (value: unknown): JsonObject => value as JsonObject;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const objs = (value: unknown): readonly JsonObject[] => value as readonly JsonObject[];
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const str = (value: unknown): string => value as string;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const strs = (value: unknown): readonly string[] => value as readonly string[];
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const strss = (value: unknown): readonly (readonly string[])[] => value as readonly (readonly string[])[];

/** A KAST module's name, its sentences, and one sentence's attribute map. */
const moduleName = (flatModule: JsonObject): string => str(flatModule["name"]);
const sentencesIn = (flatModule: JsonObject): readonly JsonObject[] => objs(flatModule["localSentences"]);
const attsIn = (sentence: JsonObject): JsonObject => obj(obj(sentence["att"])["att"]);
const itemsOf = (sentence: JsonObject): readonly JsonObject[] => objs(sentence["productionItems"] ?? []);
const klabelName = (sentence: JsonObject | undefined): JsonValue | undefined =>
  sentence?.["klabel"] === undefined ? undefined : obj(sentence["klabel"])["name"];

//////////////////////////////
// 1. pyk's own table       //
//////////////////////////////

describe("ast_to_kast (pyk table)", () => {
  const table = readPykUnitTable("ast-to-kast.json");

  test("the table is the one the extractor wrote", () => {
    expect(table.source).toBe("pyk/src/tests/unit/kast/test_ast_to_kast.py");
    expect(table.cases).toHaveLength(7);
  });

  for (const [index, testCase] of table.cases.entries()) {
    test(`case ${index}`, () => {
      const node = decodeAst(testCase["ast"]);
      const mainModule = obj(testCase["kwargs"])["main_module"];
      const actual = convert(node, mainModule === undefined ? undefined : str(mainModule));
      expect(actual).toEqual(obj(testCase["expected"]));
    });
  }
});

/**
 * `_ast_to_kast(ast, **kwargs)` for the five node types the table uses, as
 * JSON — the dispatch pyk gets from `@singledispatch` and TypeScript does not.
 */
function convert(node: Ast, mainModule: string | undefined): JsonValue {
  // The table only ever holds these five; the other nineteen node types are
  // tier 2's business and are covered by the sentence-layer suite below.
  // oxlint-disable-next-line typescript/switch-exhaustiveness-check
  switch (node.node) {
    case "Import":
      return importToDict(importToKImport(node));
    case "Require":
      return { node: "KRequire", require: requireToKRequire(node).require };
    case "Module":
      return moduleToDict(moduleToKFlatModule(node));
    case "Att":
      return attToKAtt(node).toDict();
    case "Definition":
      return astToKast(node, mainModule ?? "").toDict();
    default:
      throw new TypeError(`Unhandled table node: ${node.node}`);
  }
}

function importToDict(value: { name: string; public: boolean }): JsonObject {
  return { node: "KImport", name: value.name, isPublic: value.public };
}

function moduleToDict(value: ReturnType<typeof moduleToKFlatModule>): JsonObject {
  return {
    node: "KFlatModule",
    name: value.name,
    localSentences: [],
    imports: value.imports.map((item) => importToDict(item)),
    att: value.att.toDict(),
  };
}

//////////////////////////////
// 2. parse-outer goldens   //
//////////////////////////////

describe("parseOuter (pyk goldens)", () => {
  // `test_utils.py:19` globs `*.k` and `*.md` at the top level only — `include/e.k`
  // is reached through resolution, not directly.
  const files = ["a.k", "b.k", "c.k", "d.k", "include.k", "markdown.md"];

  for (const file of files) {
    test(file, () => {
      const expected = obj(JSON.parse(readFixture(PARSE_OUTER, `${file}.expected.json`)));
      const mainModule = file.replace(/\.(?:k|md)$/u, "").toUpperCase();
      const actual = parseOuter(join(PARSE_OUTER, file), mainModule, {
        includeDirs: [join(PARSE_OUTER, "include")],
        includeSource: false,
      });
      expect(actual.toDict()).toEqual(expected);
    });
  }

  test("goldens carry Location but no Source (include_source=False)", () => {
    const golden = obj(JSON.parse(readFixture(PARSE_OUTER, "d.k.expected.json")));
    for (const mod of objs(golden["modules"])) {
      expect(attsIn(mod)["org.kframework.attributes.Location"]).toBeDefined();
      expect(attsIn(mod)["org.kframework.attributes.Source"]).toBeUndefined();
    }
  });

  test("requires are dropped, always (utils.py:36-37)", () => {
    const actual = parseOuter(join(PARSE_OUTER, "d.k"), "D", { includeSource: false });
    expect(actual.requires).toEqual([]);
  });

  test("includeSource records the file on every module", () => {
    const actual = parseOuter(join(PARSE_OUTER, "a.k"), "A");
    for (const mod of actual.allModules) expect(mod.att.get(Atts.SOURCE)).toContain("a.k");
  });
});

//////////////////////////////
// 3. The Java oracle       //
//////////////////////////////

/**
 * Every tolerance the `imp.json` diff applies, each with the reason it is
 * *not* a bug in this package.
 *
 * The headline finding: `fixtures/imp-outer-json/imp.json` is a **stale**
 * fixture.  It is an *input* to `kompile --outer-parsed-json`, not a
 * regenerated expectation, and it has not been rebuilt since before K
 * PR #4334 ("Parse regular expressions").  Two independent proofs:
 *
 * - it encodes `KRegexTerminal` as `{precedeRegex, regex, followRegex}`, a
 *   shape `unparser/ToJson.java:369-371` at v7.1.337 cannot emit (it writes
 *   `regex` alone), and it omits `KNonTerminal.name`, which the same file
 *   writes at `:366-367`;
 * - its `Location`s do not line up with the `domains.md` it names: it puts the
 *   `Id` token production at `domains.md:2243`, where v7.1.337 has an
 *   `endmodule` — that production is now at `:2282`.
 *
 * So the prelude half of the oracle describes an older `domains.md`/`kast.md`
 * than the one this repository vendors, and content differences there are
 * *expected*.  `imp.k` itself is current — its line numbers match to the
 * column — which is why {@link IMP_MODULES} gets a stricter test.
 */
const NORMALIZATIONS = [
  "drop-locations",
  "drop-digest",
  "drop-content-start",
  "drop-nonterminal-names",
  "erase-regex-terminals",
  "sort-tag-sets",
  "canonical-att-key-order",
  "strip-colors-spaces",
  "rstrip-bubble-contents",
  "canonicalize-klabel-symbol",
] as const;

/** The two modules that come from `imp.k`, which is byte-current. */
const IMP_MODULES = ["IMP", "IMP-SYNTAX"] as const;

/** Parses `imp.k` + the vendored prelude and converts with main module `IMP`. */
function convertImp(): readonly JsonObject[] {
  // `imp.k` has no `requires`: `kompile` auto-includes the prelude
  // (`DefinitionParsing.java:306-318`), so the test wires `domains.md` in by
  // slurping it alongside.  `domains.md` requires `kast.md` on its own.
  const files = [
    ...slurpDefinitions(join(IMP_OUTER_JSON, "imp.k")).values(),
    ...slurpDefinitions(join(BUILTIN, "domains.md")).values(),
  ];
  const modules: Module[] = [];
  for (const file of files) modules.push(...file.modules);
  return objs(astToKast(definition({ modules }), "IMP").toDict()["modules"]);
}

/** The vendored Java output, unwrapped from its `{format, version, term}` envelope. */
function readOracle(): readonly JsonObject[] {
  return objs(obj(obj(JSON.parse(readFixture(IMP_OUTER_JSON, "imp.json")))["term"])["modules"]);
}

/**
 * `drop-locations` + `drop-digest` + `drop-content-start` +
 * `strip-colors-spaces` + `canonicalize-klabel-symbol`, on one attribute map.
 *
 * - **`Location`/`Source`**: pyk's outer parser records them on exactly two
 *   node types, `Module` (`outer_parser.py:145`) and `StringSentence` (`:373`).
 *   No `Production`, `SyntaxDecl` or `PriorityBlock` carries either, so there
 *   is nothing to convert.  Java puts both on all 485 productions.
 * - **`digest`**: a content hash Java computes over its own KIL objects
 *   (`KILtoKORE.java:85`).
 * - **`contentStartLine`/`Column`**: *emitted* by this package and equal to
 *   Java's on `imp.k`, but dropped here because they are line numbers into the
 *   `domains.md` source associated with the oracle snapshot.
 * - **`colors`**: `KAtt`'s `ColorsType` strips every space (`att.py:246-257`),
 *   so `colors(yellow, white)` round-trips as `yellow,white` where Java keeps
 *   the source spacing.  A pyk/Java difference in `packages/kast`, not here.
 * - **`klabel(X)` + `symbol()` \u2261 `symbol(X)`**: the oracle prelude uses
 *   `[klabel(#let), symbol]`; K v7.1.337 uses `[symbol(#let)]`.
 *   Both mean "the declared label is `#let`" (`kil/Production.java:118-126`)
 *   and produce the same generated `klabel` field.
 */
function normalizeAtt(atts: JsonObject): JsonObject {
  const dropped = new Set([
    "org.kframework.attributes.Location",
    "org.kframework.attributes.Source",
    "digest",
    "contentStartLine",
    "contentStartColumn",
  ]);
  const out: Record<string, JsonValue> = {};
  for (const [key, raw] of Object.entries(atts)) {
    if (dropped.has(key)) continue;
    out[key] = key === "colors" && typeof raw === "string" ? raw.replaceAll(" ", "") : raw;
  }
  if (typeof out["klabel"] === "string" && out["symbol"] === "") {
    out["symbol"] = out["klabel"];
    delete out["klabel"];
  }
  return out;
}

/**
 * `drop-nonterminal-names` + `erase-regex-terminals`.
 *
 * The oracle predates `ToJson.java:366-367` writing `KNonTerminal.name` at all,
 * so its 119 named non-terminals are anonymous.  Its `KRegexTerminal`s carry
 * the `{precedeRegex, regex, followRegex}` triple a `ParseRegex`-parsed `Regex`
 * prints to; this package keeps the regex verbatim (plan \u00a76 puts a regex
 * parser out of scope), so the comparison keeps only the node type.
 */
function normalizeItem(item: JsonObject): JsonValue {
  if (item["node"] === "KNonTerminal") return { node: "KNonTerminal", sort: obj(item["sort"]) };
  if (item["node"] === "KRegexTerminal") return { node: "KRegexTerminal" };
  return item;
}

/**
 * `sort-tag-sets` + `rstrip-bubble-contents` + `canonical-att-key-order`.
 *
 * - **tags**: `KSyntaxPriority.priorities` and `KSyntaxAssociativity.tags` are
 *   Scala `Set`s on the Java side (`ToJson.java:252-276`) and JavaScript `Set`s
 *   here; neither order means anything.
 * - **bubble contents**: pyk's lexer `rstrip`s the bubble before an attribute
 *   list (plan \u00a74.3); Java keeps the whitespace.  Exactly 120 of the oracle's
 *   218 bubbles differ this way and **all 120 have an attribute list** \u2014
 *   verified by the test below, which is what makes this a rule rather than a
 *   fudge.
 * - **key order**: `canonicalJson` sorts object keys, so an attribute map that
 *   differs only in insertion order compares equal.
 */
function normalizeSentence(sentence: JsonObject): string {
  const node = str(sentence["node"]);
  const out: Record<string, JsonValue> = { node, att: normalizeAtt(attsIn(sentence)) };
  switch (node) {
    case "KProduction":
      out["klabel"] = sentence["klabel"] === undefined ? null : obj(sentence["klabel"]);
      out["sort"] = obj(sentence["sort"]);
      out["params"] = objs(sentence["params"]).map((param) => param);
      out["productionItems"] = objs(sentence["productionItems"]).map((item) => normalizeItem(item));
      break;
    case "KSyntaxSort":
      out["sort"] = obj(sentence["sort"]);
      out["params"] = objs(sentence["params"]).map((param) => param);
      break;
    case "KBubble":
      out["sentenceType"] = str(sentence["sentenceType"]);
      out["contents"] = rstrip(str(sentence["contents"]));
      break;
    case "KSyntaxAssociativity":
      out["assoc"] = str(sentence["assoc"]);
      out["tags"] = strs(sentence["tags"]).toSorted();
      break;
    case "KSyntaxPriority":
      out["priorities"] = strss(sentence["priorities"]).map((group) => group.toSorted());
      break;
    default:
      break;
  }
  return canonicalJson(out);
}

/** Python's `str.rstrip()` over the four characters pyk's lexer strips. */
function rstrip(text: string): string {
  return text.replace(/[ \t\r\n]+$/u, "");
}

describe("imp.json (Java oracle)", () => {
  const ours = convertImp();
  const theirs = readOracle();
  const ourModules = new Map(ours.map((mod) => [moduleName(mod), mod]));
  const theirModules = new Map(theirs.map((mod) => [moduleName(mod), mod]));
  const allSentences = (modules: readonly JsonObject[]): readonly JsonObject[] =>
    modules.flatMap((mod) => [...sentencesIn(mod)]);
  const countOf = (modules: readonly JsonObject[], node: string): number =>
    allSentences(modules).filter((sentence) => sentence["node"] === node).length;

  test("the oracle is what the plan says it is", () => {
    expect(theirs).toHaveLength(89);
    expect(allSentences(theirs)).toHaveLength(802);
    expect(countOf(theirs, "KBubble")).toBe(218);
  });

  test("every normalization is named", () => {
    expect(new Set(NORMALIZATIONS).size).toBe(NORMALIZATIONS.length);
    expect(NORMALIZATIONS).toContain("rstrip-bubble-contents");
  });

  test("module names agree exactly", () => {
    expect([...ourModules.keys()].toSorted()).toEqual([...theirModules.keys()].toSorted());
    expect(ourModules.size).toBe(89);
  });

  test("KBubble, KSyntaxSort and KSyntaxPriority counts agree exactly", () => {
    expect(countOf(ours, "KBubble")).toBe(218);
    expect(countOf(ours, "KSyntaxSort")).toBe(countOf(theirs, "KSyntaxSort"));
    expect(countOf(ours, "KSyntaxPriority")).toBe(countOf(theirs, "KSyntaxPriority"));
  });

  test("rstrip-bubble-contents applies only to bubbles that have an attribute list", () => {
    const structural = new Set([
      "org.kframework.attributes.Location",
      "org.kframework.attributes.Source",
      "contentStartLine",
      "contentStartColumn",
      "label",
    ]);
    let trailing = 0;
    for (const sentence of allSentences(theirs)) {
      if (sentence["node"] !== "KBubble") continue;
      const contents = str(sentence["contents"]);
      if (contents === rstrip(contents)) continue;
      trailing += 1;
      expect(Object.keys(attsIn(sentence)).some((key) => !structural.has(key))).toBe(true);
    }
    expect(trailing).toBe(120);
  });

  /** The normalized sentence multiset of one module, as a set of strings. */
  const shapeOf = (modules: ReadonlyMap<string, JsonObject>, name: string): ReadonlySet<string> =>
    new Set(sentencesIn(modules.get(name) ?? {}).map((sentence) => normalizeSentence(sentence)));

  test("the two imp.k modules match sentence for sentence", () => {
    for (const name of IMP_MODULES) {
      expect([...shapeOf(ourModules, name)].toSorted()).toEqual([...shapeOf(theirModules, name)].toSorted());
    }
  });

  /**
   * The residual gap, pinned by name so it cannot silently grow.
   *
   * 75 of 89 modules are sentence-for-sentence identical under
   * {@link NORMALIZATIONS}.  The 14 that are not were each inspected: every
   * difference is a change to `domains.md` / `kast.md` between the oracle's
   * snapshot and v7.1.337: `K-REFLECTION` uses `getKLabel` in the oracle and
   * `getsymbol` in v7.1.337; collection modules use `klabel(X)` + `symbol()` in
   * the oracle and `symbol(X)` in v7.1.337 (where Java's generated label and
   * the declared label legitimately differ); the `minInt` guard in `INT` uses
   * `<Int` in the oracle and `<=Int` in v7.1.337; and `MINT`/`BYTES-HOOKED`/
   * `LIST` gain new `MInt` productions.  None is a conversion defect.
   */
  test("75 of 89 modules are identical; the other 14 are prelude drift", () => {
    const identical: string[] = [];
    const differing: string[] = [];
    for (const name of theirModules.keys()) {
      const mine = shapeOf(ourModules, name);
      const yours = shapeOf(theirModules, name);
      const same = mine.size === yours.size && [...mine].every((sentence) => yours.has(sentence));
      (same ? identical : differing).push(name);
    }
    expect(identical).toHaveLength(75);
    expect(differing.toSorted()).toEqual([
      "BYTES",
      "BYTES-HOOKED",
      "FLOAT",
      "INT",
      "INT-COMMON",
      "INT-KORE",
      "INT-SYMBOLIC",
      "K-REFLECTION",
      "LIST",
      "MAP",
      "MINT",
      "RANGEMAP",
      "SET",
      "STRING-COMMON",
    ]);
  });
});

//////////////////////////////
// 4. The sentence layer    //
//////////////////////////////

/** Converts one module's source text and returns its sentences as JSON. */
function sentencesOf(text: string, main: string, source?: string): readonly JsonObject[] {
  const parsed = new OuterParser(text, source).definition();
  const modules = objs(astToKast(parsed, main).toDict()["modules"]);
  return sentencesIn(modules[0] ?? {});
}

describe("sentence layer", () => {
  test("bubbles carry Java's sentenceType, not pyk's source keyword", () => {
    const text = [
      "module M",
      "  rule a => b",
      "  claim c => d",
      "  configuration <k> e </k>",
      "  context f",
      "  context alias [g]: h",
      "endmodule",
    ].join("\n");
    expect(sentencesOf(text, "M").map((s) => s["sentenceType"])).toEqual([
      "rule",
      "claim",
      "config",
      "context",
      "alias",
    ]);
  });

  test("a rule label is qualified with the module; a context alias label is not", () => {
    const text = "module M\n  rule [r]: a => b\n  context alias [c]: x\nendmodule";
    const atts = sentencesOf(text, "M").map((sentence) => attsIn(sentence));
    expect(atts[0]?.["label"]).toBe("M.r");
    expect(atts[1]?.["label"]).toBe("c");
  });

  test("contentStartLine/Column come from the bubble start, and only with a source", () => {
    const text = "module M\n  rule a => b\nendmodule";
    expect(sentencesOf(text, "M")[0]?.["att"]).toEqual({ node: "KAtt", att: {} });

    const atts = attsIn(sentencesOf(text, "M", "m.k")[0] ?? {});
    expect(atts["contentStartLine"]).toBe("2");
    expect(atts["contentStartColumn"]).toBe("8");
    expect(atts["org.kframework.attributes.Source"]).toBe("m.k");
  });

  test("klabel generation follows Production.getPrefixLabel", () => {
    const sentences = sentencesOf('module M\n  syntax A ::= A "+" A [left]\n             | Int\nendmodule', "M");
    const labelled = sentences.find((s) => s["node"] === "KProduction" && s["klabel"] !== undefined);
    expect(klabelName(labelled)).toBe("_+__M_A_A_A");
    // The subsort `A ::= Int` gets none (`kil/Production.java:141-145`).
    const subsort = sentences.find((s) => s["node"] === "KProduction" && itemsOf(s).length === 1);
    expect(subsort?.["klabel"]).toBeUndefined();
    // `[left]` on the production becomes its own sentence (`KILtoKORE.java:301`).
    expect(sentences.filter((s) => s["node"] === "KSyntaxAssociativity")).toHaveLength(1);
  });

  test("symbol(X) wins over a generated label; klabel(X) alone does not", () => {
    const withSymbol = sentencesOf('module M\n  syntax A ::= "f" A [symbol(myF)]\nendmodule', "M");
    expect(klabelName(withSymbol[0])).toBe("myF");
    // `getKLabel(kore=true)` regenerates when `symbol` is absent
    // (`kil/Production.java:146-148`), so `klabel(X)` alone does not declare
    // the symbol that `symbol(X)` does.
    const withKlabel = sentencesOf('module M\n  syntax A ::= "f" A [klabel(myF)]\nendmodule', "M");
    expect(klabelName(withKlabel[0])).toBe("f__M_A_A");
  });

  test("a bracket production has no klabel but does have a bracketLabel", () => {
    const sentences = sentencesOf('module M\n  syntax A ::= "(" A ")" [bracket]\nendmodule', "M");
    expect(sentences[0]?.["klabel"]).toBeUndefined();
    expect(attsIn(sentences[0] ?? {})["bracketLabel"]).toEqual({ node: "KLabel", name: "(_)_M_A_A", params: [] });
  });

  test("a user list expands to two productions, exactly as imp.json shows", () => {
    const sentences = sentencesOf(
      'module IMP-SYNTAX\n  syntax Ids ::= List{Id,","} [format(%1%2 %3)]\nendmodule',
      "IMP-SYNTAX",
    );
    expect(sentences).toHaveLength(2);
    const element = sentences.find((s) => itemsOf(s).length === 3) ?? {};
    const terminator = sentences.find((s) => itemsOf(s).length === 1) ?? {};
    expect(klabelName(element)).toBe("_,__IMP-SYNTAX_Ids_Id_Ids");
    expect(attsIn(element)).toEqual({ format: "%1%2 %3", userList: "*" });
    expect(klabelName(terminator)).toBe('.List{"_,__IMP-SYNTAX_Ids_Id_Ids"}_Ids');
    expect(itemsOf(terminator)[0]).toEqual({ node: "KTerminal", value: ".Ids" });
    // `format` is dropped and `symbol` added (`KILtoKORE.java:346-354`).
    expect(attsIn(terminator)).toEqual({ userList: "*", symbol: '.List{"_,__IMP-SYNTAX"}' });
  });

  test("NeList marks the userList attribute with +", () => {
    const sentences = sentencesOf('module M\n  syntax Xs ::= NeList{X,";"}\nendmodule', "M");
    for (const sentence of sentences) {
      expect(attsIn(sentence)["userList"]).toBe("+");
    }
  });

  test("more than one priority block emits a KSyntaxPriority across them", () => {
    const sentences = sentencesOf('module M\n  syntax A ::= "a" > "b" > "c"\nendmodule', "M");
    const priority = sentences.find((s) => s["node"] === "KSyntaxPriority");
    expect(priority?.["priorities"]).toEqual([["a_M_A"], ["b_M_A"], ["c_M_A"]]);
    // One block alone emits none.
    expect(sentencesOf('module M\n  syntax A ::= "a"\nendmodule', "M")).toHaveLength(1);
  });

  test("a block associativity covers the whole block", () => {
    const sentences = sentencesOf('module M\n  syntax A ::= left: "a" | "b"\nendmodule', "M");
    const assoc = sentences.find((s) => s["node"] === "KSyntaxAssociativity");
    expect(assoc?.["assoc"]).toBe("Left");
    expect(assoc?.["tags"]).toEqual(["a_M_A", "b_M_A"]);
  });

  test("syntax priority resolves group tags through the definition-wide index", () => {
    const text = [
      "module M",
      '  syntax A ::= "a" [group(unary)]',
      '             | "b" [group(unary)]',
      '             | "c" [symbol(cee)]',
      "  syntax priority unary > cee",
      "endmodule",
    ].join("\n");
    const priority = sentencesOf(text, "M").find((s) => s["node"] === "KSyntaxPriority");
    expect(priority?.["priorities"]).toEqual([["a_M_A", "b_M_A"], ["cee"]]);
  });

  test("an unresolvable tag stays as written", () => {
    const index = buildTagIndex([]);
    expect(index.resolve("nothing")).toEqual(["nothing"]);
  });

  test("*Cell non-terminals get a temporary sort declaration", () => {
    const sentences = sentencesOf("module M\n  syntax A ::= KCell BCellFragment KCell\nendmodule", "M");
    const temporaries = sentences.filter(
      (s) => s["node"] === "KSyntaxSort" && attsIn(s)["temporary-cell-sort-decl"] === "",
    );
    // One per distinct sort, deduplicated (`KILtoKORE.java:56-77`).
    expect(temporaries.map((s) => obj(s["sort"])["name"])).toEqual(["KCell", "BCellFragment"]);
  });

  test("a named non-terminal keeps its name; an unnamed one has no key", () => {
    const sentences = sentencesOf("module M\n  syntax A ::= f(x: B, C) [function]\nendmodule", "M");
    const items = itemsOf(sentences[0] ?? {});
    expect(items.filter((item) => item["node"] === "KNonTerminal")).toEqual([
      { node: "KNonTerminal", sort: { node: "KSort", name: "B", params: [] }, name: "x" },
      { node: "KNonTerminal", sort: { node: "KSort", name: "C", params: [] } },
    ]);
  });

  test("sort parameters land on the production, sort arguments on the sort", () => {
    const sentences = sentencesOf("module M\n  syntax {W} MInt{W} ::= foo(MInt{W}) [function]\nendmodule", "M");
    expect(sentences[0]?.["params"]).toEqual([{ node: "KSort", name: "W", params: [] }]);
    expect(sentences[0]?.["sort"]).toEqual({
      node: "KSort",
      name: "MInt",
      params: [{ node: "KSort", name: "W", params: [] }],
    });
  });

  test("a numeric sort argument becomes a KSort named with its digits", () => {
    // `SortDecl.args` keeps NATs as strings, `Sort.args` as numbers;
    // both end up as `KSort('8')`.
    const sentences = sentencesOf("module M\n  syntax MInt{8} ::= foo(MInt{8}) [function]\nendmodule", "M");
    expect(obj(sentences[0]?.["sort"])["params"]).toEqual([{ node: "KSort", name: "8", params: [] }]);
    const items = itemsOf(sentences[0] ?? {});
    expect(items.find((item) => item["node"] === "KNonTerminal")?.["sort"]).toEqual({
      node: "KSort",
      name: "MInt",
      params: [{ node: "KSort", name: "8", params: [] }],
    });
  });

  test("syntax sort, synonym and lexical convert one-for-one", () => {
    const sentences = sentencesOf(
      'module M\n  syntax Foo [token]\n  syntax Bar = Foo [hook(x)]\n  syntax lexical Baz = r"[a-z]"\nendmodule',
      "M",
    );
    // `"KSyntaxLexcial"` is pyk's own typo in `outer.py:467`, transcribed
    // deliberately in `packages/kast/src/outer.ts:83,1218` — the wire format is
    // what it is.
    expect(sentences.map((s) => s["node"])).toEqual(["KSyntaxSort", "KSortSynonym", "KSyntaxLexcial"]);
    expect(sentences[2]).toEqual({
      node: "KSyntaxLexcial",
      name: "Baz",
      regex: "[a-z]",
      att: { node: "KAtt", att: {} },
    });
  });

  test("sentenceToKSentences is the unit under all of this", () => {
    const parsed = new OuterParser("module M\n  rule x => y\nendmodule").definition();
    const sentence = parsed.modules[0]?.sentences[0];
    expect(sentence === undefined ? [] : sentenceToKSentences(sentence, "M")).toHaveLength(1);
  });
});

//////////////////////////////
// 5. Attributes            //
//////////////////////////////

describe("attributes", () => {
  test("strictAtts reproduces pyk's KAtt.parse throw on an ANY-typed key", () => {
    const text = "module M [haskell]\nendmodule";
    const parsed = new OuterParser(text).definition();
    expect(() => astToKast(parsed, "M", { strictAtts: true })).toThrow();
    // The default mode keeps the raw text, which is what `KAtt.fromDict` does.
    // A module always has a location (`outer_parser.py:145` sets it whether or
    // not there is a source), so the injected `Location` rides along.
    const converted = moduleToKFlatModule(parsed.modules[0] ?? module("M")).att.toDict();
    expect(converted).toEqual({
      node: "KAtt",
      att: { haskell: "", "org.kframework.attributes.Location": [1, 1, 2, 10] },
    });
  });

  test("attToKAtt is pyk's, verbatim: empty is EMPTY_ATT, duplicates last-win", () => {
    expect(attToKAtt(att([])).toDict()).toEqual({ node: "KAtt", att: {} });
    expect(
      attToKAtt(
        att([
          ["group", "a"],
          ["group", "b"],
        ]),
      ).toDict(),
    ).toEqual({
      node: "KAtt",
      att: { group: "b" },
    });
  });

  test("a registered key gets its codec; an unknown one keeps its text", () => {
    const sentences = sentencesOf(
      'module M\n  syntax A ::= "a" [format(%1), smt-hook(bvadd), total, index(3)]\nendmodule',
      "M",
    );
    expect(attsIn(sentences[0] ?? {})).toEqual({
      format: "%1",
      "smt-hook": "bvadd",
      total: "",
      index: "3",
    });
  });

  test("productionKLabel is reachable on its own", () => {
    const prod = production([terminal("f"), nonTerminal(sort("A"))]);
    expect(productionKLabel(prod, ksort("B"), "M", true)).toBe("f__M_B_A");
    expect(productionKLabel(prod, ksort("B"), "M", false)).toBe("f__M");
  });

  test("buildTagIndex maps declared labels and groups to generated klabels", () => {
    const mod = module("M", {
      sentences: [
        syntaxDefn(sortDecl("A"), {
          blocks: [
            priorityBlock([
              production([terminal("a")], { att: att([["group", "g"]]) }),
              production([terminal("b")], { att: att([["symbol", "bee"]]) }),
            ]),
          ],
        }),
      ],
    });
    const index = buildTagIndex([mod]);
    expect(index.resolve("g")).toEqual(["a_M_A"]);
    expect(index.resolve("bee")).toEqual(["bee"]);
  });

  test("a user list is a ProductionLike the label generator understands", () => {
    const list = userList("Id", ",");
    expect(productionKLabel(list, ksort("Ids"), "M", true)).toBe("_,__M_Ids_Id_Ids");
  });
});

//////////////////////////////
// Helpers                  //
//////////////////////////////

/**
 * The five surface node shapes `fixtures/pyk-unit/ast-to-kast.json` uses, from
 * pyk's dataclass encoding.
 *
 * Hand-written rather than a general decoder: `astJson.ts` is an *encoder* and
 * the table is seven cases deep, so a full inverse would be more code than the
 * thing it tests.
 */
function decodeAst(value: unknown): Ast {
  const node = obj(value);
  // Switching on a `JsonValue`, so "exhaustive" would mean listing `null`,
  // `true` and `false`; the `default` arm is the exhaustiveness check.
  // oxlint-disable-next-line typescript/switch-exhaustiveness-check
  switch (node["node"]) {
    case "Import":
      return importt(str(node["module_name"]), { public: node["public"] === true });
    case "Require":
      return requireOf(str(node["path"]));
    case "Att":
      return att(strss(node["items"]).map((item) => [str(item[0]), str(item[1])] as const));
    case "Module":
      return module(str(node["name"]), {
        sentences: objs(node["sentences"]).map((item) => decodeSentence(item)),
        imports: objs(node["imports"]).map((item) => decodeImport(item)),
        att: decodeAtt(node["att"]),
      });
    case "Definition":
      return definition({
        modules: objs(node["modules"]).map((item) => decodeModule(item)),
        requires: objs(node["requires"]).map((item) => decodeRequire(item)),
      });
    default:
      throw new TypeError(`Unhandled surface node: ${JSON.stringify(node["node"])}`);
  }
}

/**
 * The five narrowings `decodeAst` needs of itself.
 *
 * The table only ever nests a `Module` inside a `Definition` and an `Att`
 * inside a `Module`, and both of those are *empty* in all seven cases, so
 * these are total on the data even though the general function is not.
 */
function decodeImport(value: unknown): Import {
  const decoded = decodeAst(value);
  if (decoded.node !== "Import") throw new TypeError(`Expected an Import, got ${decoded.node}`);
  return decoded;
}

function decodeRequire(value: unknown): Require {
  const decoded = decodeAst(value);
  if (decoded.node !== "Require") throw new TypeError(`Expected a Require, got ${decoded.node}`);
  return decoded;
}

function decodeModule(value: unknown): Module {
  const decoded = decodeAst(value);
  if (decoded.node !== "Module") throw new TypeError(`Expected a Module, got ${decoded.node}`);
  return decoded;
}

function decodeAtt(value: unknown): Att {
  const decoded = decodeAst(value);
  if (decoded.node !== "Att") throw new TypeError(`Expected an Att, got ${decoded.node}`);
  return decoded;
}

function decodeSentence(value: unknown): Sentence {
  throw new TypeError(`The table has no sentences: ${JSON.stringify(value)}`);
}
