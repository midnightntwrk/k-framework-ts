/**
 * `src/astJson.ts` — the encoder, tested away from the parser.
 *
 * `test/parser.test.ts` already diffs {@link syntaxToDict}'s output against
 * pyk's nine `.outer.json` goldens and its 89 extracted table cases, which is
 * the real oracle.  What that cannot reach is the corners of the encoding no
 * vendored K file happens to contain — a node with a `source`, a
 * {@link SyntaxSynonym} (the prelude has none), the two `Assoc` members
 * `domains.md` never declares — so this file builds those by hand, straight
 * from `syntax.ts`'s factories.
 *
 * The three properties it pins:
 *
 * 1. **Every one of the 24 node types encodes**, checked against
 *    {@link AST_NODES} rather than against a list written twice.
 * 2. **Key order is `dataclasses.fields()` order** — `node`, then `source` and
 *    `location` when present, then the node's own fields — because the goldens
 *    are pretty-printed text a human reads in a diff.
 * 3. **pyk's field spellings win**: `module_name`, `non_empty`, `new`, `old`,
 *    and an `Assoc` as its *member name* rather than the source keyword its
 *    value holds.
 */

import { describe, expect, test } from "bun:test";
import { OuterAstJsonSchema, OuterAttJsonSchema, OuterPriorityBlockJsonSchema, syntaxToDict } from "../src/astJson.ts";
import {
  AST_NODES,
  Assoc,
  EMPTY_ATT,
  alias,
  att,
  claim,
  config,
  context,
  definition,
  importt,
  lexical,
  module,
  nonTerminal,
  priorityBlock,
  production,
  require,
  rule,
  sort,
  sortDecl,
  syntaxAssoc,
  syntaxDecl,
  syntaxDefn,
  syntaxLexical,
  syntaxPriority,
  syntaxSynonym,
  terminal,
  userList,
  type Ast,
} from "../src/syntax.ts";

/** The keys of an encoded node, in emission order. */
function keysOf(node: Ast): string[] {
  const encoded = syntaxToDict(node);
  if (typeof encoded !== "object" || encoded === null || Array.isArray(encoded)) {
    throw new TypeError(`not an object: ${JSON.stringify(encoded)}`);
  }
  return Object.keys(encoded);
}

/////////////////////////////////////////
// Totality                            //
/////////////////////////////////////////

describe("every node type encodes", () => {
  /** One node of each of the 24 types, keyed by the `node` name it must produce. */
  const samples: Readonly<Record<(typeof AST_NODES)[number], Ast>> = {
    Att: att([["a", "b"]]),
    SortDecl: sortDecl("Foo"),
    Sort: sort("Foo"),
    SyntaxDecl: syntaxDecl(sortDecl("Foo")),
    SyntaxDefn: syntaxDefn(sortDecl("Foo")),
    PriorityBlock: priorityBlock([]),
    Production: production([]),
    Terminal: terminal("a"),
    NonTerminal: nonTerminal(sort("Foo")),
    Lexical: lexical("[a-z]"),
    UserList: userList("Foo", ","),
    SyntaxSynonym: syntaxSynonym(sortDecl("Foo"), sort("Bar")),
    SyntaxPriority: syntaxPriority([["a"]]),
    SyntaxAssoc: syntaxAssoc(Assoc.LEFT, ["a"]),
    SyntaxLexical: syntaxLexical("Foo", "[a-z]"),
    Rule: rule("x"),
    Claim: claim("x"),
    Config: config("x"),
    Context: context("x"),
    Alias: alias("x"),
    Import: importt("FOO"),
    Module: module("FOO"),
    Require: require("foo.k"),
    Definition: definition(),
  };

  test("the taxonomy has 24 members and a sample for each", () => {
    expect(AST_NODES).toHaveLength(24);
    expect(Object.keys(samples).toSorted()).toEqual([...AST_NODES].toSorted());
  });

  for (const name of AST_NODES) {
    test(`${name} encodes with its own class name`, () => {
      const encoded = syntaxToDict(samples[name]);
      expect(encoded).toMatchObject({ node: name });
      expect(OuterAstJsonSchema.safeParse(encoded).success).toBe(true);
    });
  }
});

/////////////////////////////////////////
// Raw JSON schema boundary             //
/////////////////////////////////////////

describe("OuterAstJsonSchema", () => {
  test("accepts a nested definition emitted by syntaxToDict", () => {
    const encoded = syntaxToDict(
      definition({
        modules: [
          module("MAIN", {
            imports: [importt("OTHER", { public: false })],
            sentences: [
              syntaxDefn(sortDecl("Exp"), {
                blocks: [
                  priorityBlock(
                    [
                      production([terminal("("), nonTerminal(sort("Exp"), { name: "term" }), lexical("[0-9]+")]),
                      userList("Exp", ",", { nonEmpty: true }),
                    ],
                    { assoc: Assoc.LEFT },
                  ),
                ],
              }),
              syntaxSynonym(sortDecl("Nat", { args: ["8"] }), sort("MInt", { args: [8] })),
              rule("term", { label: "main" }),
            ],
          }),
        ],
        requires: [require("prelude.k")],
      }),
    );

    expect(OuterAstJsonSchema.safeParse(encoded as unknown).success).toBe(true);
  });

  test("rejects malformed nested children instead of decoding them into AST nodes", () => {
    expect(
      OuterAstJsonSchema.safeParse({
        node: "Definition",
        modules: [
          {
            node: "Module",
            name: "MAIN",
            sentences: [
              {
                node: "SyntaxDefn",
                decl: { node: "SortDecl", name: "Exp", params: [], args: [] },
                blocks: [
                  {
                    node: "PriorityBlock",
                    productions: [
                      {
                        node: "Production",
                        items: [{ node: "NonTerminal", sort: { node: "Sort", name: "Exp", args: [] } }],
                        att: { node: "Att", items: [] },
                      },
                    ],
                    assoc: null,
                  },
                ],
              },
            ],
            imports: [],
            att: { node: "Att", items: [] },
          },
        ],
        requires: [],
      }).success,
    ).toBe(false);
  });

  test("enforces pyk spellings, nullability, and omitted parser-only metadata", () => {
    expect(OuterAstJsonSchema.safeParse({ node: "Import", moduleName: "OTHER", public: true }).success).toBe(false);
    expect(
      OuterAstJsonSchema.safeParse({
        node: "UserList",
        sort: "Exp",
        sep: ",",
        nonEmpty: true,
        att: { node: "Att", items: [] },
      }).success,
    ).toBe(false);
    expect(
      OuterAstJsonSchema.safeParse({
        node: "SyntaxSynonym",
        new: { node: "SortDecl", name: "New", params: [], args: [] },
        att: { node: "Att", items: [] },
      }).success,
    ).toBe(false);
    expect(OuterPriorityBlockJsonSchema.safeParse({ node: "PriorityBlock", productions: [] }).success).toBe(false);
    expect(
      OuterPriorityBlockJsonSchema.safeParse({ node: "PriorityBlock", productions: [], assoc: null }).success,
    ).toBe(true);
    expect(OuterAstJsonSchema.safeParse({ node: "Terminal", value: "x", span: [1, 1, 1, 2] }).success).toBe(false);
    expect(OuterAttJsonSchema.safeParse({ node: "Att", items: [], itemSpans: [] }).success).toBe(false);
  });
});

/////////////////////////////////////////
// source and location                 //
/////////////////////////////////////////

describe("source and location are omitted when absent, first when present", () => {
  test("neither key appears on a node that has neither", () => {
    expect(keysOf(terminal("a"))).toEqual(["node", "value"]);
    expect(syntaxToDict(terminal("a"))).toEqual({ node: "Terminal", value: "a" });
  });

  test("both come immediately after `node`, source before location", () => {
    const node = terminal("a", { source: "test.k", location: [1, 2, 3, 4] });
    expect(keysOf(node)).toEqual(["node", "source", "location", "value"]);
    expect(syntaxToDict(node)).toEqual({
      node: "Terminal",
      source: "test.k",
      location: [1, 2, 3, 4],
      value: "a",
    });
  });

  test("either can appear without the other", () => {
    expect(keysOf(terminal("a", { source: "test.k" }))).toEqual(["node", "source", "value"]);
    expect(keysOf(terminal("a", { location: [1, 2, 3, 4] }))).toEqual(["node", "location", "value"]);
  });

  test("a location is copied out as a plain array, not the frozen tuple", () => {
    const encoded = syntaxToDict(module("FOO", { location: [1, 1, 1, 21] }));
    expect(encoded).toEqual({
      node: "Module",
      location: [1, 1, 1, 21],
      name: "FOO",
      sentences: [],
      imports: [],
      att: { node: "Att", items: [] },
    });
  });
});

/////////////////////////////////////////
// Field names and order               //
/////////////////////////////////////////

describe("pyk's field names, not this package's", () => {
  test("Import.moduleName is `module_name`", () => {
    expect(syntaxToDict(importt("FOO", { public: false }))).toEqual({
      node: "Import",
      module_name: "FOO",
      public: false,
    });
  });

  test("UserList.nonEmpty is `non_empty`", () => {
    expect(syntaxToDict(userList("Foo", ",", { nonEmpty: true }))).toEqual({
      node: "UserList",
      sort: "Foo",
      sep: ",",
      non_empty: true,
      att: { node: "Att", items: [] },
    });
  });

  test("SyntaxSynonym.newSort/oldSort are `new`/`old`", () => {
    expect(syntaxToDict(syntaxSynonym(sortDecl("Foo", { args: ["4"] }), sort("MInt", { args: [8] })))).toEqual({
      node: "SyntaxSynonym",
      new: { node: "SortDecl", name: "Foo", params: [], args: ["4"] },
      old: { node: "Sort", name: "MInt", args: [8] },
      att: { node: "Att", items: [] },
    });
  });
});

describe("key order is dataclasses.fields() order", () => {
  const cases = [
    { name: "Att", node: att([]), keys: ["node", "items"] },
    { name: "SortDecl", node: sortDecl("Foo"), keys: ["node", "name", "params", "args"] },
    { name: "Sort", node: sort("Foo"), keys: ["node", "name", "args"] },
    { name: "SyntaxDecl", node: syntaxDecl(sortDecl("Foo")), keys: ["node", "decl", "att"] },
    { name: "SyntaxDefn", node: syntaxDefn(sortDecl("Foo")), keys: ["node", "decl", "blocks"] },
    { name: "PriorityBlock", node: priorityBlock([]), keys: ["node", "productions", "assoc"] },
    { name: "Production", node: production([]), keys: ["node", "items", "att"] },
    { name: "Terminal", node: terminal("a"), keys: ["node", "value"] },
    { name: "NonTerminal", node: nonTerminal(sort("Foo")), keys: ["node", "sort", "name"] },
    { name: "Lexical", node: lexical("a"), keys: ["node", "regex"] },
    { name: "UserList", node: userList("Foo", ","), keys: ["node", "sort", "sep", "non_empty", "att"] },
    { name: "SyntaxSynonym", node: syntaxSynonym(sortDecl("A"), sort("B")), keys: ["node", "new", "old", "att"] },
    { name: "SyntaxPriority", node: syntaxPriority([]), keys: ["node", "groups"] },
    { name: "SyntaxAssoc", node: syntaxAssoc(Assoc.LEFT, []), keys: ["node", "assoc", "klabels"] },
    { name: "SyntaxLexical", node: syntaxLexical("A", "a"), keys: ["node", "name", "regex"] },
    { name: "Rule", node: rule("x"), keys: ["node", "bubble", "label", "att"] },
    { name: "Import", node: importt("FOO"), keys: ["node", "module_name", "public"] },
    { name: "Module", node: module("FOO"), keys: ["node", "name", "sentences", "imports", "att"] },
    { name: "Require", node: require("a.k"), keys: ["node", "path"] },
    { name: "Definition", node: definition(), keys: ["node", "modules", "requires"] },
  ] as const;

  for (const { name, node, keys } of cases) {
    test(name, () => {
      expect(keysOf(node)).toEqual([...keys]);
    });
  }

  test("the five string sentences share one field order", () => {
    for (const sentence of [rule("x"), claim("x"), config("x"), context("x"), alias("x")]) {
      expect(keysOf(sentence)).toEqual(["node", "bubble", "label", "att"]);
    }
  });
});

/////////////////////////////////////////
// The value rules                     //
/////////////////////////////////////////

describe("Assoc encodes as its member name", () => {
  const cases = [
    { assoc: Assoc.LEFT, keyword: "left", name: "LEFT" },
    { assoc: Assoc.RIGHT, keyword: "right", name: "RIGHT" },
    { assoc: Assoc.NON_ASSOC, keyword: "non-assoc", name: "NON_ASSOC" },
  ] as const;

  for (const { assoc, keyword, name } of cases) {
    test(`${keyword} → ${name}`, () => {
      expect(assoc).toBe(keyword);
      expect(syntaxToDict(syntaxAssoc(assoc, ["a"]))).toEqual({ node: "SyntaxAssoc", assoc: name, klabels: ["a"] });
      expect(syntaxToDict(priorityBlock([], { assoc }))).toEqual({
        node: "PriorityBlock",
        productions: [],
        assoc: name,
      });
    });
  }

  test("a block with no associativity carries `null`, not an absent key", () => {
    expect(keysOf(priorityBlock([]))).toEqual(["node", "productions", "assoc"]);
    expect(JSON.stringify(syntaxToDict(priorityBlock([])))).toBe(
      '{"node":"PriorityBlock","productions":[],"assoc":null}',
    );
  });
});

describe("attributes are a sequence of pairs", () => {
  test("an empty list is an empty array, not an absent key", () => {
    expect(syntaxToDict(EMPTY_ATT)).toEqual({ node: "Att", items: [] });
  });

  test("pairs are two-element arrays, in order, duplicates kept", () => {
    const node = att([
      ["foo", "1"],
      ["bar", ""],
      ["foo", "2"],
    ]);
    expect(syntaxToDict(node)).toEqual({
      node: "Att",
      items: [
        ["foo", "1"],
        ["bar", ""],
        ["foo", "2"],
      ],
    });
  });
});

describe("the NAT asymmetry survives encoding", () => {
  test("SortDecl.args are strings", () => {
    expect(syntaxToDict(sortDecl("MInt", { args: ["8"] }))).toEqual({
      node: "SortDecl",
      name: "MInt",
      params: [],
      args: ["8"],
    });
  });

  test("Sort.args keep their numbers, and may mix", () => {
    expect(syntaxToDict(sort("MInt", { args: [8, "A"] }))).toEqual({
      node: "Sort",
      name: "MInt",
      args: [8, "A"],
    });
    expect(JSON.stringify(syntaxToDict(sort("MInt", { args: [8] })))).toContain('"args":[8]');
  });
});

describe("nesting", () => {
  test("a whole definition encodes depth-first, in field order", () => {
    const node = definition({
      requires: [require("a.k")],
      modules: [
        module("FOO", {
          location: [1, 1, 5, 10],
          imports: [importt("BAR", { public: false })],
          att: att([["private", ""]]),
          sentences: [
            syntaxDefn(sortDecl("Exp"), {
              blocks: [
                priorityBlock([production([terminal("("), nonTerminal(sort("Exp"), { name: "e" }), terminal(")")])], {
                  assoc: Assoc.NON_ASSOC,
                }),
              ],
            }),
            rule("x", { label: "l", att: att([["owise", ""]]) }),
          ],
        }),
      ],
    });

    expect(JSON.stringify(syntaxToDict(node))).toBe(
      '{"node":"Definition","modules":[{"node":"Module","location":[1,1,5,10],"name":"FOO",' +
        '"sentences":[{"node":"SyntaxDefn","decl":{"node":"SortDecl","name":"Exp","params":[],"args":[]},' +
        '"blocks":[{"node":"PriorityBlock","productions":[{"node":"Production","items":[' +
        '{"node":"Terminal","value":"("},{"node":"NonTerminal","sort":{"node":"Sort","name":"Exp","args":[]},"name":"e"},' +
        '{"node":"Terminal","value":")"}],"att":{"node":"Att","items":[]}}],"assoc":"NON_ASSOC"}]},' +
        '{"node":"Rule","bubble":"x","label":"l","att":{"node":"Att","items":[["owise",""]]}}],' +
        '"imports":[{"node":"Import","module_name":"BAR","public":false}],' +
        '"att":{"node":"Att","items":[["private",""]]}}],"requires":[{"node":"Require","path":"a.k"}]}',
    );
  });

  test("the encoder does not mutate or alias the node it read", () => {
    const node = module("FOO", { imports: [importt("BAR")] });
    const first = syntaxToDict(node);
    const second = syntaxToDict(node);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(node.imports).toHaveLength(1);
  });
});
