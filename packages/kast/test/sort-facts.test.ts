import { describe, expect, test } from "bun:test";
import { Atts, EMPTY_ATT, KAtt, attEntry } from "../src/att.ts";
import {
  BUILTIN_TOKEN_SORT_NAMES,
  definitionTokenFacts,
  INTERNAL_SORT_NAMES,
  isBuiltinTokenSort,
  isInternalSort,
} from "../src/sort-facts.ts";
import { ksort } from "../src/inner.ts";
import { KDefinition, kflatmodule, knonterminal, kproduction, ksyntaxsort, kterminal } from "../src/outer.ts";

const TOKEN = new KAtt([attEntry(Atts.TOKEN, null)]);

describe("sort facts", () => {
  test("pins K's internal-sort predicate exactly, including every # sort", () => {
    expect(INTERNAL_SORT_NAMES).toEqual([
      "GeneratedTopCell",
      "K",
      "KBott",
      "KConfigVar",
      "KItem",
      "KLabel",
      "KList",
      "KResult",
      "KString",
    ]);
    const internal = [
      "#CellName",
      "#CellProperties",
      "#CellProperty",
      "#KVariable",
      "#Layout",
      "#LowerId",
      "#OptionalDots",
      "#RuleBody",
      "#RuleContent",
      "#UpperId",
      "GeneratedTopCell",
      "K",
      "KBott",
      "KConfigVar",
      "KItem",
      "KLabel",
      "KList",
      "KResult",
      "KString",
    ];
    for (const sort of internal) expect(isInternalSort(sort)).toBe(true);
    for (const sort of ["Bool", "Int", "Id", "KVar", "Map", "GeneratedCounterCell", "user#Sort"]) {
      expect(isInternalSort(sort)).toBe(false);
    }
    expect(isInternalSort("#AnythingAtAll")).toBe(true);
  });

  test("pins K's v7.1.337 builtin token roster exactly", () => {
    expect(BUILTIN_TOKEN_SORT_NAMES).toEqual([
      "#CellName",
      "#KVariable",
      "#LowerId",
      "#UpperId",
      "Bool",
      "Bytes",
      "Float",
      "Id",
      "Int",
      "KConfigVar",
      "KLabel",
      "KString",
      "KVar",
      "String",
    ]);
    for (const sort of BUILTIN_TOKEN_SORT_NAMES) expect(isBuiltinTokenSort(sort)).toBe(true);
    for (const sort of ["K", "KItem", "MInt", "GeneratedTopCell", "user#Token"])
      expect(isBuiltinTokenSort(sort)).toBe(false);
  });

  test("unions token syntax sorts and productions, exposing only whole terminal pins", () => {
    const definition = new KDefinition("MAIN", [
      kflatmodule("MAIN", {
        sentences: [
          ksyntaxsort("Declared", { att: TOKEN }),
          kproduction("Bool", { items: [kterminal("true")], att: TOKEN }),
          kproduction("Bool", { items: [kterminal("false")], att: TOKEN }),
          kproduction("Int", { items: [{ node: "KRegexTerminal", regex: "[0-9]+" }], att: TOKEN }),
          kproduction("Complex", { items: [kterminal("prefix"), knonterminal("Id")], att: TOKEN }),
          kproduction("Ignored", { items: [kterminal("not-a-token")], att: EMPTY_ATT }),
        ],
      }),
    ]);
    expect(definitionTokenFacts(definition)).toEqual([
      { sort: ksort("Declared"), terminals: [] },
      { sort: ksort("Bool"), terminals: ["true", "false"] },
      { sort: ksort("Int"), terminals: [] },
      { sort: ksort("Complex"), terminals: [] },
    ]);
  });
});
