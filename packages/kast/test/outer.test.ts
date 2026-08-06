/**
 * The outer data model and `KDefinition`.
 *
 * Four sources, kept apart:
 *
 * 1. The **six vendored `KDefinition` goldens** under
 *    `fixtures/parse-outer/` — pyk's own `*.expected.json` at v7.1.337, byte
 *    for byte (see `fixtures/PROVENANCE.md`).  Each is read strictly and
 *    written back; the comparison is on **canonical JSON**
 *    (`json.dumps(..., sort_keys=True)`, which `eq.ts`'s {@link canonicalJson}
 *    reproduces), so key *order* is allowed to differ and nothing else is.
 * 2. The three tables `test/kast.test.ts` left for this phase, transcribed
 *    from `pyk/src/tests/unit/kast/test_kast.py` at v7.1.337:
 *    `IS_PREFIX_TEST_DATA` (11 rows, `test_kast.py:296`),
 *    `DEFAULT_FORMAT_TEST_DATA` (10 rows, `test_kast.py:346`) and
 *    `test_defn_module_names` (1, `test_kast.py:234`).  They were **moved**
 *    here rather than un-skipped there; `test/kast.test.ts`'s header points at
 *    this file.
 * 3. `pyk/src/tests/unit/kast/test_definition.py` (2 rows) — the v7.1.337
 *    `add_cell_map_items` regression, with its `DEFN` transcribed as-is.
 * 4. Behaviour with no upstream test at all: the `KSyntaxLexical` node-name
 *    typo, the optional-field truthiness rules, the codec's error paths,
 *    `KDefinition`'s constructor validation, and `indexedRewrite`.
 *
 * The differential half — every node's `to_dict` against pyk's, plus
 * `emptyConfig` / `initConfig` — lives in `test/outer-parity.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Atts, EMPTY_ATT, KAtt, attEntry, mapAtt, parseFormat, unparseFormat } from "../src/att.ts";
import { canonicalJson, eq } from "../src/eq.ts";
import { kapply, klabel, krewrite, ksort, ktoken, kvariable, type KInner } from "../src/inner.ts";
import type { JsonValue } from "../src/json.ts";
import {
  KAssoc,
  KDefinition,
  kbubble,
  kclaim,
  kcontext,
  flatModuleListFromDict,
  flatModuleListToDict,
  importFromDict,
  importToDict,
  kflatmodule,
  kflatmodulelist,
  kimport,
  knonterminal,
  kproduction,
  kregexterminal,
  krequire,
  krule,
  ksortsynonym,
  ksyntaxassociativity,
  ksyntaxlexical,
  ksyntaxpriority,
  ksyntaxsort,
  kterminal,
  letKImport,
  letKNonTerminal,
  letKProduction,
  letKRegexTerminal,
  letKRequire,
  letKTerminal,
  letSentenceAtt,
  moduleRules,
  moduleSyntaxProductions,
  productionArgumentSorts,
  productionAsSubsort,
  productionItemToDict,
  productionDefaultFormat,
  productionIsPrefix,
  productionIsRecord,
  productionNonTerminals,
  readKastDefinition,
  readKastDefinitionFromJson,
  requireFromDict,
  requireToDict,
  rulePriority,
  sentenceFromDict,
  sentenceLabel,
  sentenceSource,
  sentenceToDict,
  sentenceUniqueId,
  claimDependencies,
  claimIsCircularity,
  claimIsTrusted,
  type KProduction,
} from "../src/outer.ts";
import { indexedRewrite } from "../src/rewrite.ts";
import { TRUE } from "../src/prelude/kbool.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "parse-outer");

/** `KAtt(entries=[...])`, spelled once. */
const atts = (entries: Parameters<typeof KAtt.prototype.update>[0]): KAtt => EMPTY_ATT.update(entries);

/////////////////////////////////////////
// The six vendored KDefinition goldens //
/////////////////////////////////////////

const GOLDENS = [
  "a.k.expected.json",
  "b.k.expected.json",
  "c.k.expected.json",
  "d.k.expected.json",
  "include.k.expected.json",
  "markdown.md.expected.json",
] as const;

describe("parse-outer goldens", () => {
  for (const name of GOLDENS) {
    test(`${name} round-trips`, () => {
      const text = readFileSync(join(FIXTURES, name), "utf8");
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const golden = JSON.parse(text) as JsonValue;
      const definition = KDefinition.fromDict(golden);
      // Canonical JSON, so a difference in key order is not a difference.
      expect(canonicalJson(definition.toDict())).toBe(canonicalJson(golden));
    });
  }

  test("the envelope form reads the same definition", () => {
    const text = readFileSync(join(FIXTURES, "d.k.expected.json"), "utf8");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const golden = JSON.parse(text) as JsonValue;
    const wrapped = { format: "KAST", version: 4, term: golden };
    expect(canonicalJson(readKastDefinition(wrapped).toDict())).toBe(canonicalJson(golden));
  });

  test("d.k's import closure is every module it names", () => {
    const text = readFileSync(join(FIXTURES, "d.k.expected.json"), "utf8");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const definition = KDefinition.fromDict(JSON.parse(text) as JsonValue);
    expect(definition.mainModuleName).toBe("D");
    expect([...definition.allModuleNames]).toEqual([
      "D-SYNTAX",
      "D",
      "B-SYNTAX",
      "B",
      "A-SYNTAX",
      "A",
      "C-SYNTAX",
      "C",
    ]);
    // Breadth-first from the main module (`outer.py:1086-1096`).
    expect([...definition.moduleNames]).toEqual(["D", "D-SYNTAX", "B", "C", "B-SYNTAX", "A", "C-SYNTAX", "A-SYNTAX"]);
    // Every module of `d.k` is reachable, but in a different order from the
    // declaration order above — the closure is a traversal, not a filter.
    expect(definition.moduleNames.length).toBe(definition.allModuleNames.length);
    expect(definition.module("A").name).toBe("A");
    // Every golden module carries a Location attribute and nothing else.
    expect(definition.module("A").att.get(Atts.LOCATION)).toEqual([4, 1, 6, 10]);
  });
});

////////////////////////////////////////////
// IS_PREFIX_TEST_DATA (test_kast.py:296)  //
////////////////////////////////////////////

const IS_PREFIX_TEST_DATA: readonly (readonly [KProduction, boolean])[] = [
  [kproduction("Int"), false],
  [kproduction("Int", { items: [kterminal("foo")] }), false],
  [kproduction("Int", { items: [knonterminal(ksort("Foo"))] }), false],
  [kproduction("Int", { items: [kterminal("foo"), kterminal("(")] }), false],
  [kproduction("Int", { items: [kterminal("foo"), kterminal("("), kterminal(")")] }), true],
  [kproduction("Int", { items: [kregexterminal("foo"), kterminal("("), kterminal(")")] }), false],
  [kproduction("Int", { items: [knonterminal(ksort("foo")), kterminal("("), kterminal(")")] }), false],
  [kproduction("Int", { items: [kterminal("foo"), kterminal("bar"), kterminal("("), kterminal(")")] }), true],
  [kproduction("Int", { items: [kterminal("foo"), kterminal("("), knonterminal(ksort("Foo")), kterminal(")")] }), true],
  [
    kproduction("Int", {
      items: [kterminal("foo"), kterminal("("), knonterminal(ksort("Foo")), kterminal(","), kterminal(")")],
    }),
    false,
  ],
  [
    kproduction("Int", {
      items: [
        kterminal("foo"),
        kterminal("("),
        knonterminal(ksort("Foo")),
        kterminal(","),
        knonterminal(ksort("Bar")),
        kterminal(")"),
      ],
    }),
    true,
  ],
];

describe("productionIsPrefix", () => {
  IS_PREFIX_TEST_DATA.forEach(([production, expected], i) => {
    test(String(i), () => {
      expect(productionIsPrefix(production)).toBe(expected);
    });
  });
});

////////////////////////////////////////////////
// DEFAULT_FORMAT_TEST_DATA (test_kast.py:346) //
////////////////////////////////////////////////

const S = ksort("S");

const DEFAULT_FORMAT_TEST_DATA: readonly (readonly [KProduction, string])[] = [
  [kproduction(S), ""],
  [kproduction(S, { items: [kterminal("foo")] }), "%1"],
  [kproduction(S, { items: [kterminal("foo"), kterminal("bar")] }), "%1 %2"],
  [kproduction(S, { items: [kterminal("foo"), kterminal("bar"), kterminal("baz")] }), "%1 %2 %3"],
  [kproduction(S, { items: [kterminal("foo"), knonterminal(S), kterminal("baz")] }), "%1 %2 %3"],
  [kproduction(S, { items: [kterminal("foo"), kterminal("("), kterminal(")")] }), "%1 %2 %3"],
  [kproduction(S, { items: [kterminal("foo"), kterminal("("), knonterminal(S), kterminal(")")] }), "%1 %2 %3 %4"],
  [
    kproduction(S, { items: [kterminal("foo"), kterminal("("), knonterminal(S, "x"), kterminal(")")] }),
    "%1 %2... x: %3 %4",
  ],
  [
    kproduction(S, {
      items: [kterminal("foo"), kterminal("("), knonterminal(S, "x"), kterminal(","), knonterminal(S), kterminal(")")],
    }),
    "%1 %2 %3 %4 %5 %6",
  ],
  [
    kproduction(S, {
      items: [
        kterminal("foo"),
        kterminal("("),
        knonterminal(S, "x"),
        kterminal(","),
        knonterminal(S, "y"),
        kterminal(")"),
      ],
    }),
    "%1 %2... x: %3 %4 y: %5 %6",
  ],
];

describe("productionDefaultFormat", () => {
  DEFAULT_FORMAT_TEST_DATA.forEach(([production, formatStr], i) => {
    test(String(i), () => {
      expect(productionDefaultFormat(production)).toEqual(parseFormat(formatStr));
      // The tokens concatenate back to the string, which is what makes the
      // comparison above meaningful rather than a tautology.
      expect(unparseFormat(productionDefaultFormat(production))).toBe(formatStr);
    });
  });

  // Not upstream: only the record branch inspects the items, so this is the
  // one shape `default_format` refuses (`outer.py:343-344`).
  test("a regex terminal in a record production has no default format", () => {
    const prod = kproduction(S, {
      items: [kregexterminal("foo"), kterminal("("), knonterminal(S, "x"), kterminal(")")],
    });
    // …but only when the production is a record; a regex terminal makes
    // `is_prefix` false, so this one falls into the non-record branch.
    expect(productionIsRecord(prod)).toBe(false);
    expect(unparseFormat(productionDefaultFormat(prod))).toBe("%1 %2 %3 %4");
  });
});

/////////////////////////////////////////////
// test_defn_module_names (test_kast.py:234) //
/////////////////////////////////////////////

test("defn module names", () => {
  const defn = new KDefinition("FOO", [
    kflatmodule("BAR"),
    kflatmodule("FOO", { imports: [kimport("FOO-A"), kimport("FOO-B")] }),
    kflatmodule("FOO-A", { imports: [kimport("FOO-C")] }),
    kflatmodule("FOO-B", { imports: [kimport("FOO-C")] }),
    kflatmodule("FOO-C"),
  ]);

  expect(defn.allModuleNames.length).toBe(5);
  expect(defn.moduleNames.length).toBe(4);
  expect(new Set(defn.allModuleNames)).toEqual(new Set(["FOO", "BAR", "FOO-A", "FOO-B", "FOO-C"]));
  expect(new Set(defn.moduleNames)).toEqual(new Set(["FOO", "FOO-A", "FOO-B", "FOO-C"]));
});

///////////////////////////////////////////////////
// test_definition.py — add_cell_map_items (2)    //
///////////////////////////////////////////////////

const INT = ksort("Int");
const ACCOUNT_CELL_MAP = ksort("AccountCellMap");
const ACCOUNT_CELL = ksort("AccountCell");

const ACCT_MAP_CONCAT = kproduction(ACCOUNT_CELL_MAP, {
  items: [knonterminal(ACCOUNT_CELL_MAP), knonterminal(ACCOUNT_CELL_MAP)],
  klabel: "_AccountCellMap_",
  att: new KAtt([
    attEntry(Atts.CELL_COLLECTION, null),
    attEntry(Atts.ELEMENT, "AccountCellMapItem"),
    attEntry(Atts.WRAP_ELEMENT, "<account>"),
  ]),
});

const ACCT_MAP_ITEM = kproduction(ACCOUNT_CELL_MAP, {
  items: [
    kterminal("AccountCellMapItem"),
    kterminal("("),
    knonterminal(INT),
    kterminal(","),
    knonterminal(ACCOUNT_CELL),
    kterminal(")"),
  ],
  klabel: "AccountCellMapItem",
});

const ACCOUNT_CELL_PROD = kproduction(ACCOUNT_CELL, {
  items: [kterminal("<account>"), kterminal("("), knonterminal(INT), kterminal(","), knonterminal(INT), kterminal(")")],
  klabel: "<account>",
});

const GET_ENTRY = kproduction(ACCOUNT_CELL, {
  items: [kterminal("getEntry"), kterminal("("), knonterminal(ACCOUNT_CELL), kterminal(")")],
  klabel: "getEntry",
});

const CELL_MAP_DEFN = new KDefinition("TEST", [
  kflatmodule("TEST", { sentences: [ACCT_MAP_CONCAT, ACCT_MAP_ITEM, ACCOUNT_CELL_PROD, GET_ENTRY] }),
]);

const ACCT_1 = kapply("<account>", [kvariable("X", INT), kvariable("Y", INT)]);
const ACCT_2 = kapply("<account>", [kvariable("A", INT), kvariable("B", INT)]);

const ADD_CELL_MAP_ITEMS_DATA: readonly (readonly [string, KInner, KInner])[] = [
  [
    "wraps_when_parent_expects_cell_map_sort",
    kapply("_AccountCellMap_", [ACCT_1, ACCT_2]),
    kapply("_AccountCellMap_", [
      kapply("AccountCellMapItem", [kvariable("X", INT), ACCT_1]),
      kapply("AccountCellMapItem", [kvariable("A", INT), ACCT_2]),
    ]),
  ],
  ["no_wrap_when_parent_expects_cell_element_sort", kapply("getEntry", [ACCT_1]), kapply("getEntry", [ACCT_1])],
];

describe("addCellMapItems", () => {
  for (const [id, term, expected] of ADD_CELL_MAP_ITEMS_DATA) {
    test(id, () => {
      expect(eq(CELL_MAP_DEFN.addCellMapItems(term), expected)).toBe(true);
    });
  }

  test("removeCellMapItems undoes it", () => {
    const wrapped = CELL_MAP_DEFN.addCellMapItems(kapply("_AccountCellMap_", [ACCT_1, ACCT_2]));
    expect(eq(CELL_MAP_DEFN.removeCellMapItems(wrapped), kapply("_AccountCellMap_", [ACCT_1, ACCT_2]))).toBe(true);
  });

  test("wrapping twice wraps once (`outer.py:1561`)", () => {
    const once = CELL_MAP_DEFN.addCellMapItems(kapply("_AccountCellMap_", [ACCT_1, ACCT_2]));
    expect(eq(CELL_MAP_DEFN.addCellMapItems(once), once)).toBe(true);
  });

  test("cellMapItemInfo maps the cell label to its constructor and sort", () => {
    const info = CELL_MAP_DEFN.cellMapItemInfo;
    expect([...info.keys()]).toEqual(["<account>"]);
    expect(info.get("<account>")?.[0]).toBe("AccountCellMapItem");
    expect(info.get("<account>")?.[1].name).toBe("AccountCellMap");
  });
});

//////////////////////////////
// The data model           //
//////////////////////////////

describe("production accessors", () => {
  test("argumentSorts and nonTerminals skip terminals", () => {
    const prod = kproduction("Int", {
      items: [kterminal("f"), kterminal("("), knonterminal("Int", "a"), kterminal(","), knonterminal("Bool")],
    });
    expect(productionNonTerminals(prod).map((nt) => nt.name)).toEqual(["a", undefined]);
    expect(productionArgumentSorts(prod).map((s) => s.name)).toEqual(["Int", "Bool"]);
  });

  test("asSubsort is a single unlabelled non-terminal, and nothing else", () => {
    expect(productionAsSubsort(kproduction("Int", { items: [knonterminal("Nat")] }))).toEqual([
      ksort("Int"),
      ksort("Nat"),
    ]);
    // A label makes it a constructor, not a subsorting.
    expect(productionAsSubsort(kproduction("Int", { items: [knonterminal("Nat")], klabel: "inj" }))).toBeUndefined();
    expect(productionAsSubsort(kproduction("Int", { items: [kterminal("x")] }))).toBeUndefined();
    expect(productionAsSubsort(kproduction("Int"))).toBeUndefined();
  });

  test("isRecord needs every non-terminal named", () => {
    const named = kproduction("Int", {
      items: [kterminal("f"), kterminal("("), knonterminal("Int", "a"), kterminal(")")],
    });
    const partly = kproduction("Int", {
      items: [
        kterminal("f"),
        kterminal("("),
        knonterminal("Int", "a"),
        kterminal(","),
        knonterminal("Int"),
        kterminal(")"),
      ],
    });
    expect(productionIsRecord(named)).toBe(true);
    expect(productionIsRecord(partly)).toBe(false);
    // A prefix production with no non-terminals at all is not a record.
    expect(productionIsRecord(kproduction("Int", { items: [kterminal("("), kterminal(")")] }))).toBe(false);
  });
});

describe("sentence accessors", () => {
  test("uniqueId, source and label", () => {
    const bare = kproduction("Int");
    expect(sentenceUniqueId(bare)).toBeUndefined();
    expect(sentenceSource(bare)).toBeUndefined();
    expect(() => sentenceLabel(bare)).toThrow(TypeError);

    const located = kproduction("Int", {
      att: atts([
        attEntry(Atts.UNIQUE_ID, "uid-1"),
        attEntry(Atts.SOURCE, "/a/b.k"),
        attEntry(Atts.LOCATION, [1, 2, 3, 4]),
      ]),
    });
    expect(sentenceUniqueId(located)).toBe("uid-1");
    // pyk interpolates the Python tuple, which prints with its parentheses.
    expect(sentenceSource(located)).toBe("/a/b.k:(1, 2, 3, 4)");
    expect(sentenceLabel(located)).toBe("uid-1");

    const labelled = kproduction("Int", {
      att: atts([attEntry(Atts.UNIQUE_ID, "uid-1"), attEntry(Atts.LABEL, "explicit")]),
    });
    // `label` wins over `UNIQUE_ID` (`outer.py:194`).
    expect(sentenceLabel(labelled)).toBe("explicit");
  });

  test("rule priority (`outer.py:675-677`)", () => {
    const body = krewrite(kapply("a"), kapply("b"));
    expect(rulePriority(krule(body))).toBe(50);
    expect(rulePriority(krule(body, { att: atts([attEntry(Atts.OWISE, null)]) }))).toBe(200);
    expect(rulePriority(krule(body, { att: atts([attEntry(Atts.PRIORITY, 25)]) }))).toBe(25);
    // The explicit priority wins over `owise`.
    expect(rulePriority(krule(body, { att: atts([attEntry(Atts.OWISE, null), attEntry(Atts.PRIORITY, 25)]) }))).toBe(
      25,
    );
  });

  test("claim flags and dependencies", () => {
    const body = krewrite(kapply("a"), kapply("b"));
    expect(claimIsCircularity(kclaim(body))).toBe(false);
    expect(claimIsTrusted(kclaim(body))).toBe(false);
    expect(claimDependencies(kclaim(body))).toEqual([]);
    const decorated = kclaim(body, {
      att: atts([attEntry(Atts.CIRCULARITY, null), attEntry(Atts.TRUSTED, null), attEntry(Atts.DEPENDS, " a , b,c ")]),
    });
    expect(claimIsCircularity(decorated)).toBe(true);
    expect(claimIsTrusted(decorated)).toBe(true);
    expect(claimDependencies(decorated)).toEqual(["a", "b", "c"]);
  });

  test("letSentenceAtt reaches every sentence kind", () => {
    const att = EMPTY_ATT.update([attEntry(Atts.GROUP, "g")]);
    const body = krewrite(kapply("a"), kapply("b"));
    const sentences = [
      kproduction("Int"),
      ksyntaxsort("Int"),
      ksortsynonym("New", "Old"),
      ksyntaxlexical("N", "r"),
      ksyntaxassociativity(KAssoc.LEFT, { tags: ["t"] }),
      ksyntaxpriority([["a"], ["b"]]),
      kbubble("rule", "x"),
      krule(body),
      kclaim(body),
      kcontext(body),
    ];
    for (const sentence of sentences) {
      const updated = mapAtt(sentence, () => att, letSentenceAtt);
      expect(updated.node).toBe(sentence.node);
      expect(updated.att.get(Atts.GROUP)).toBe("g");
    }
    expect(sentences.length).toBe(10);
  });

  test("letKProduction can clear the klabel, which pyk's `let` cannot", () => {
    const prod = kproduction("Int", { klabel: "f" });
    expect(letKProduction(prod, { klabel: undefined }).klabel).toBeUndefined();
    expect(letKProduction(prod, { sort: "Bool" }).klabel).toEqual(klabel("f"));
  });
});

describe("module accessors", () => {
  const module = kflatmodule("M", {
    sentences: [
      kproduction("Int", { klabel: "a" }),
      kproduction("Int", { items: [knonterminal("Nat")] }),
      krule(krewrite(kapply("a"), kapply("b"))),
      ksyntaxsort("Int"),
    ],
  });

  test("syntaxProductions are the labelled ones", () => {
    expect(moduleSyntaxProductions(module).length).toBe(1);
    expect(moduleRules(module).length).toBe(1);
  });
});

//////////////////////////////
// The JSON codec           //
//////////////////////////////

describe("sentence JSON", () => {
  /**
   * `outer.py:467` spells the node name `KSyntaxLexcial` on the way *out* and
   * `KSyntaxLexical` on the way *in*, so the sentence does not round-trip
   * through pyk.  We keep the typo: a definition written by one library must
   * be byte-identical to one written by the other.
   */
  test("KSyntaxLexical writes a node name it cannot read back", () => {
    const sentence = ksyntaxlexical("Name", "[a-z]+");
    const dct = sentenceToDict(sentence);
    expect(dct["node"]).toBe("KSyntaxLexcial");
    expect(() => sentenceFromDict(dct)).toThrow(/Invalid KSentence node: "KSyntaxLexcial"/u);
    // Correcting the name is all it takes.
    expect(sentenceFromDict({ ...dct, node: "KSyntaxLexical" })).toEqual(sentence);
  });

  test("a production with no klabel omits the key entirely (`filter_none`)", () => {
    expect(Object.hasOwn(sentenceToDict(kproduction("Int")), "klabel")).toBe(false);
    expect(Object.hasOwn(sentenceToDict(kproduction("Int", { klabel: "f" })), "klabel")).toBe(true);
  });

  test("a non-terminal with no name omits the key entirely", () => {
    const anonymous = productionItemToDict(knonterminal("Nat"));
    expect(Object.hasOwn(anonymous, "name")).toBe(false);
    expect(Object.hasOwn(productionItemToDict(knonterminal("Nat", "x")), "name")).toBe(true);
  });

  test("absent requires/ensures default to `true`, not to null", () => {
    const rule = sentenceFromDict({
      node: "KRule",
      body: { node: "KVariable", name: "X" },
      att: { node: "KAtt", att: {} },
    });
    expect(rule.node).toBe("KRule");
    if (rule.node !== "KRule") throw new Error("unreachable");
    expect(eq(rule.requires, TRUE)).toBe(true);
    expect(eq(rule.ensures, TRUE)).toBe(true);
  });

  test("an absent or empty att is the empty att (Python truthiness)", () => {
    // `outer.py:240`: `KAtt.from_dict(d['att']) if d.get('att') else EMPTY_ATT`
    // — and `{}` is falsy in Python.
    for (const att of [undefined, null, {}]) {
      const raw: Record<string, unknown> = {
        node: "KProduction",
        sort: { node: "KSort", name: "Int" },
        productionItems: [],
        params: [],
      };
      if (att !== undefined) raw["att"] = att;
      expect(sentenceFromDict(raw).att.size).toBe(0);
    }
  });

  test("errors name the JSON path", () => {
    expect(() =>
      sentenceFromDict({
        node: "KProduction",
        sort: { node: "KSort", name: "Int", params: [] },
        productionItems: [{ node: "KTerminal" }],
        params: [],
      }),
    ).toThrow(/at sentence\.productionItems\.0/u);

    expect(() => sentenceFromDict({ node: "KNope" })).toThrow(/Invalid KSentence node/u);
    expect(() =>
      sentenceFromDict({
        node: "KProduction",
        sort: { node: "KSort", name: "Int", params: [] },
        productionItems: [{ node: "KWat" }],
        params: [],
      }),
    ).toThrow(/Invalid KProductionItem node/u);
    expect(() =>
      sentenceFromDict({
        node: "KSyntaxAssociativity",
        assoc: "Sideways",
        tags: [],
      }),
    ).toThrow(/Invalid KAssoc/u);
  });

  test("KFlatModuleList lives under the key `term`, not `modules`", () => {
    const list = { node: "KFlatModuleList", mainModule: "FOO", term: [] };
    expect(canonicalJson(sentenceToDict(kproduction("Int")))).toContain("KProduction");
    expect(() => KDefinition.fromDict(list)).toThrow(/missing the field "modules"/u);
  });
});

//////////////////////////////
// KDefinition construction //
//////////////////////////////

describe("KDefinition construction", () => {
  test("the main module must exist, and must be unique", () => {
    expect(() => new KDefinition("NOPE", [kflatmodule("FOO")])).toThrow(/Module not found: NOPE/u);
    expect(() => new KDefinition("FOO", [kflatmodule("FOO"), kflatmodule("FOO")])).toThrow(
      /Module is not unique: FOO/u,
    );
  });

  test("`let` produces a definition with fresh caches", () => {
    const defn = new KDefinition("FOO", [kflatmodule("FOO", { sentences: [kproduction("Int", { klabel: "a" })] })]);
    expect([...defn.symbols.keys()]).toEqual(["a"]);
    const extended = defn.let({
      allModules: [kflatmodule("FOO", { sentences: [kproduction("Int", { klabel: "b" })] })],
    });
    expect([...extended.symbols.keys()]).toEqual(["b"]);
    // The original is untouched.
    expect([...defn.symbols.keys()]).toEqual(["a"]);
  });

  test("two productions for one symbol are an error when they really differ", () => {
    const defn = new KDefinition("FOO", [
      kflatmodule("FOO", {
        sentences: [kproduction("Int", { klabel: "a" }), kproduction("Bool", { klabel: "a" })],
      }),
    ]);
    expect(() => defn.symbols).toThrow(/Found multiple productions for a/u);
  });

  test("duplicate productions differing only in attributes are accepted", () => {
    // `outer.py:1251` compares `other.let(att=prod.att.drop_source())` — pyk
    // overwrites *both* sides with `prod`'s attributes, so attribute-only
    // differences never trip the check.  Transcribed, bug and all.
    const defn = new KDefinition("FOO", [
      kflatmodule("FOO", {
        sentences: [
          kproduction("Int", { klabel: "a", att: EMPTY_ATT.update([attEntry(Atts.FUNCTION, null)]) }),
          kproduction("Int", { klabel: "a", att: EMPTY_ATT.update([attEntry(Atts.TOTAL, null)]) }),
        ],
      }),
    ]);
    // The first one wins.
    expect(defn.symbols.get("a")?.att.has(Atts.FUNCTION)).toBe(true);
  });

  test("requires and att survive a round trip", () => {
    const defn = new KDefinition("FOO", [kflatmodule("FOO")], {
      requires: [krequire("domains.md")],
      att: EMPTY_ATT.update([attEntry(Atts.SYNTAX_MODULE, "FOO-SYNTAX")]),
    });
    const reread = KDefinition.fromDict(defn.toDict());
    expect(canonicalJson(reread.toDict())).toBe(canonicalJson(defn.toDict()));
    expect(reread.requires.map((r) => r.require)).toEqual(["domains.md"]);
    expect(reread.att.get(Atts.SYNTAX_MODULE)).toBe("FOO-SYNTAX");
  });

  test("productionForCellSort refuses a sort that is not a cell sort", () => {
    const defn = new KDefinition("FOO", [kflatmodule("FOO")]);
    expect(() => defn.productionForCellSort(ksort("Int"))).toThrow(/sorts ending in "Cell"/u);
    expect(() => defn.productionForCellSort(ksort("KCell"))).toThrow(/Expected a single cell production/u);
  });
});

//////////////////////////////
// indexedRewrite           //
//////////////////////////////

describe("indexedRewrite", () => {
  test("runs to a fixpoint, not one pass", () => {
    // a -> b, b -> c: one bottom-up pass would stop at `b`.
    const rewrites = [krewrite(kapply("a"), kapply("b")), krewrite(kapply("b"), kapply("c"))];
    expect(eq(indexedRewrite(kapply("f", [kapply("a")]), rewrites), kapply("f", [kapply("c")]))).toBe(true);
  });

  test("indexes by LHS kind: tokens, applications by label name, everything else", () => {
    const rewrites = [
      krewrite(ktoken("1", "Int"), ktoken("2", "Int")),
      krewrite(kvariable("X"), kapply("hit")),
      krewrite(kapply("f", [kvariable("Y")]), kapply("g", [kvariable("Y")])),
    ];
    // The `KVariable` LHS matches anything, but only lands on nodes that are
    // neither a token nor an application — here, the sequence.
    const term = kapply("f", [ktoken("1", "Int")]);
    expect(eq(indexedRewrite(term, rewrites), kapply("g", [ktoken("2", "Int")]))).toBe(true);
  });

  test("no rewrites is the identity", () => {
    const term = kapply("f", [kvariable("X")]);
    // Structurally, not by reference: the bottom-up pass rebuilds every node.
    expect(eq(indexedRewrite(term, []), term)).toBe(true);
  });
});

//////////////////////////////
// The remaining codecs     //
//////////////////////////////

describe("KFlatModuleList and KRequire", () => {
  test("a module list round-trips through its `term` key", () => {
    const list = kflatmodulelist("FOO", [kflatmodule("FOO"), kflatmodule("BAR", { imports: [kimport("FOO")] })]);
    const dct = flatModuleListToDict(list);
    expect(dct["node"]).toBe("KFlatModuleList");
    expect(canonicalJson(flatModuleListToDict(flatModuleListFromDict(dct)))).toBe(canonicalJson(dct));
  });

  test("a require round-trips", () => {
    const req = krequire("domains.md");
    expect(requireFromDict(requireToDict(req))).toEqual(req);
    expect(letKRequire(req, { require: "other.md" }).require).toBe("other.md");
  });

  test("an import round-trips, including a private one", () => {
    for (const imp of [kimport("FOO"), kimport("BAR", false)]) {
      expect(importFromDict(importToDict(imp))).toEqual(imp);
    }
    expect(letKImport(kimport("FOO"), { public: false }).public).toBe(false);
  });

  test("readKastDefinitionFromJson reads the enveloped text form", () => {
    const inner = new KDefinition("FOO", [kflatmodule("FOO")]).toDict();
    const text = JSON.stringify({ format: "KAST", version: 4, term: inner });
    expect(canonicalJson(readKastDefinitionFromJson(text).toDict())).toBe(canonicalJson(inner));
    // The envelope is checked, and by `!==`: version 3 is not version 4.
    expect(() => readKastDefinitionFromJson(JSON.stringify({ format: "KAST", version: 3, term: inner }))).toThrow(
      /Invalid version/u,
    );
  });

  test("the production-item `let` copiers", () => {
    expect(letKTerminal(kterminal("a"), { value: "b" }).value).toBe("b");
    expect(letKRegexTerminal(kregexterminal("a"), { regex: "b" }).regex).toBe("b");
    const nt = knonterminal("Int", "x");
    expect(letKNonTerminal(nt, { sort: "Bool" })).toEqual(knonterminal("Bool", "x"));
    // Present-and-`undefined` clears the name, as everywhere in this package.
    expect(letKNonTerminal(nt, { name: undefined }).name).toBeUndefined();
  });
});
