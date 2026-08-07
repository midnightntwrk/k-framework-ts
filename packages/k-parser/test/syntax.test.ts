/**
 * The surface AST's factories: defaults, sharing, and the taxonomy.
 *
 * Deliberately light.  `syntax.ts` is data with no behaviour, and what really
 * pins it is downstream: `test/lexer.test.ts` for the token stream these nodes
 * are built from, and (phase 3) the 88 extracted `outer-parser-*.json` cases,
 * which assert a whole tree per case.  Duplicating those here would be pinning
 * the factories against themselves.
 *
 * What is worth stating once, because nothing else would notice it changing:
 * every default (`Import.public`, `NonTerminal.name`, `UserList.nonEmpty`, the
 * empty attribute list), the two `args` types that must stay different
 *, and {@link Assoc}'s values, which the parser builds from token
 * text.
 */

import { describe, expect, test } from "bun:test";
import {
  AST_NODES,
  Assoc,
  EMPTY_ATT,
  PRODUCTION_ITEM_NODES,
  PRODUCTION_LIKE_NODES,
  SENTENCE_NODES,
  STRING_SENTENCE_NODES,
  STRING_SENTENCE_PREFIXES,
  SYNTAX_SENTENCE_NODES,
  alias,
  assocFromKeyword,
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
  stringSentencePrefix,
  syntaxAssoc,
  syntaxDecl,
  syntaxDefn,
  syntaxLexical,
  syntaxPriority,
  syntaxSynonym,
  terminal,
  userList,
  type ProductionItem,
  type Sentence,
} from "../src/syntax.ts";

describe("Att", () => {
  test("EMPTY_ATT is the shared empty list, and att() returns it", () => {
    expect(EMPTY_ATT.items).toEqual([]);
    expect(att()).toBe(EMPTY_ATT);
    expect(att([])).toBe(EMPTY_ATT);
  });

  test("every factory defaults its attributes to that same object", () => {
    expect(production([]).att).toBe(EMPTY_ATT);
    expect(syntaxDecl(sortDecl("Foo")).att).toBe(EMPTY_ATT);
    expect(rule("x").att).toBe(EMPTY_ATT);
    expect(module("M").att).toBe(EMPTY_ATT);
    expect(userList("Foo", ",").att).toBe(EMPTY_ATT);
  });

  test("it is a sequence: order is kept and duplicates are legal", () => {
    const duplicated = att([
      ["foo", "1"],
      ["bar", ""],
      ["foo", "2"],
    ]);
    expect(duplicated.items).toEqual([
      ["foo", "1"],
      ["bar", ""],
      ["foo", "2"],
    ]);
  });

  test("a source or location makes it a distinct object even when empty", () => {
    const located = att([], { location: [1, 1, 1, 2] });
    expect(located).not.toBe(EMPTY_ATT);
    expect(located.location).toEqual([1, 1, 1, 2]);
  });
});

describe("sorts", () => {
  test("SortDecl keeps a NAT argument as a string; Sort converts it", () => {
    // `MInt{8}`: the declaration has to produce `KSort('8')` to match Java's
    // `compiled.json`, while a use carries the number.  Neither is a bug.
    expect(sortDecl("MInt", { args: ["8"] }).args).toEqual(["8"]);
    expect(sort("MInt", { args: [8] }).args).toEqual([8]);
    expect(sort("Matrix", { args: ["N", 1] }).args).toEqual(["N", 1]);
  });

  test("params and args default to empty", () => {
    expect(sortDecl("Foo")).toEqual({
      node: "SortDecl",
      name: "Foo",
      params: [],
      args: [],
      source: undefined,
      location: undefined,
    });
    expect(sort("Foo").args).toEqual([]);
  });
});

describe("Assoc", () => {
  test("its values are the source keywords the parser reads", () => {
    expect(Assoc).toEqual({ LEFT: "left", RIGHT: "right", NON_ASSOC: "non-assoc" });
  });

  test("assocFromKeyword is the enum lookup, and is total", () => {
    expect(assocFromKeyword("non-assoc")).toBe(Assoc.NON_ASSOC);
    expect(assocFromKeyword("left")).toBe(Assoc.LEFT);
    expect(assocFromKeyword("Left")).toBeUndefined();
    expect(assocFromKeyword("")).toBeUndefined();
  });

  test("a priority block has no associativity unless one was declared", () => {
    expect(priorityBlock([]).assoc).toBeUndefined();
    expect(priorityBlock([], { assoc: Assoc.LEFT }).assoc).toBe("left");
  });
});

describe("productions", () => {
  test("NonTerminal's name defaults to the empty string, not undefined", () => {
    expect(nonTerminal(sort("Foo")).name).toBe("");
    expect(nonTerminal(sort("Foo"), { name: "x" }).name).toBe("x");
  });

  test("UserList is not non-empty by default", () => {
    expect(userList("Foo", ",").nonEmpty).toBe(false);
    expect(userList("Foo", ",", { nonEmpty: true }).nonEmpty).toBe(true);
  });

  test("a production's items are copied, so the caller's array cannot leak in", () => {
    const items: ProductionItem[] = [terminal("bar")];
    const built = production(items);
    items.push(lexical("baz"));
    expect(built.items).toHaveLength(1);
  });

  test("frozen: a node cannot be edited after construction", () => {
    const built = terminal("bar");
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.value)).toBe(true);
  });
});

describe("string sentences", () => {
  test("all five share a shape and differ by node and prefix", () => {
    const built = [rule("x"), claim("x"), config("x"), context("x"), alias("x")];
    expect(built.map((sentence) => sentence.node)).toEqual([...STRING_SENTENCE_NODES]);
    expect(built.map((sentence) => stringSentencePrefix(sentence))).toEqual([
      "rule",
      "claim",
      "configuration",
      "context",
      "context alias",
    ]);
    for (const sentence of built) {
      expect(sentence.bubble).toBe("x");
      expect(sentence.label).toBe("");
      expect(sentence.att).toBe(EMPTY_ATT);
    }
  });

  test("the prefix is a lookup, not a field — it must not affect equality", () => {
    expect(Object.keys(rule("x"))).toEqual(["node", "bubble", "label", "att", "source", "location", "span"]);
    expect(STRING_SENTENCE_PREFIXES.Alias).toBe("context alias");
  });

  test("source and location are only there when the parser was given them", () => {
    // `outer_parser.py:373` sets them only for a real source path; emitting
    // them for an in-memory string diverges from Java's `compiled.json`.
    expect(rule("x").source).toBeUndefined();
    expect(rule("x", { source: "a.k", location: [1, 1, 1, 6] }).location).toEqual([1, 1, 1, 6]);
  });
});

describe("modules and definitions", () => {
  test("an import is public unless it says otherwise", () => {
    expect(importt("FOO").public).toBe(true);
    expect(importt("FOO", { public: false }).public).toBe(false);
  });

  test("a module defaults to empty everything", () => {
    expect(module("M")).toEqual({
      node: "Module",
      name: "M",
      sentences: [],
      imports: [],
      att: EMPTY_ATT,
      source: undefined,
      location: undefined,
    });
  });

  test("a definition holds modules and requires, in order", () => {
    const built = definition({
      modules: [module("A"), module("B")],
      requires: [require("a.k"), require("b.k")],
    });
    expect(built.modules.map((m) => m.name)).toEqual(["A", "B"]);
    expect(built.requires.map((r) => r.path)).toEqual(["a.k", "b.k"]);
    expect(definition()).toEqual({
      node: "Definition",
      modules: [],
      requires: [],
      source: undefined,
      location: undefined,
    });
  });

  test("a module's location is a four-tuple spanning module..endmodule", () => {
    const built = module("M", { source: "a.k", location: [1, 1, 3, 10] });
    expect(built.location).toEqual([1, 1, 3, 10]);
    expect(built.source).toBe("a.k");
  });
});

describe("the taxonomy", () => {
  test("24 node names, and every union member is one of them", () => {
    expect(AST_NODES).toHaveLength(24);
    expect(new Set(AST_NODES).size).toBe(24);
    for (const nodes of [
      SENTENCE_NODES,
      SYNTAX_SENTENCE_NODES,
      STRING_SENTENCE_NODES,
      PRODUCTION_ITEM_NODES,
      PRODUCTION_LIKE_NODES,
    ]) {
      for (const node of nodes) expect(AST_NODES).toContain(node);
    }
  });

  test("Sentence is exactly the syntax sentences plus the string sentences", () => {
    expect(SENTENCE_NODES).toEqual([...SYNTAX_SENTENCE_NODES, ...STRING_SENTENCE_NODES]);
    expect(SENTENCE_NODES).toHaveLength(11);
  });

  test("a factory exists for every node name, and it reports that name", () => {
    const built = [
      att(),
      sortDecl("Foo"),
      sort("Foo"),
      syntaxDecl(sortDecl("Foo")),
      syntaxDefn(sortDecl("Foo")),
      priorityBlock([]),
      production([]),
      terminal("t"),
      nonTerminal(sort("Foo")),
      lexical("[a-z]"),
      userList("Foo", ","),
      syntaxSynonym(sortDecl("Foo"), sort("Bar")),
      syntaxPriority([["a"]]),
      syntaxAssoc(Assoc.LEFT, ["a"]),
      syntaxLexical("Foo", "[a-z]"),
      rule("x"),
      claim("x"),
      config("x"),
      context("x"),
      alias("x"),
      importt("FOO"),
      module("M"),
      require("a.k"),
      definition(),
    ];
    expect(built.map((node) => node.node)).toEqual([...AST_NODES]);
  });

  test("the discriminant narrows a Sentence without a cast", () => {
    const sentences: Sentence[] = [rule("x"), syntaxDecl(sortDecl("Foo"))];
    const described = sentences.map((sentence) =>
      sentence.node === "Rule" ? sentence.bubble : sentence.node === "SyntaxDecl" ? sentence.decl.name : "?",
    );
    expect(described).toEqual(["x", "Foo"]);
  });
});
