import { describe, expect, test } from "bun:test";
import type { App, EVar, Pattern, SortApp, SymbolDecl } from "@kframework-ts/kore";

import {
  functionRuleMatchers,
  isExhaustive,
  matcherInputs,
  matcherOutputs,
  matcherTerms,
  orderMatchers,
  plainSortName,
  renameRepeatedVariables,
  type KleanMatcher,
  type MatcherDefinition,
} from "../src/matchers.js";

const sort = (name: string): SortApp => ({ tag: "SortApp", name, sorts: [] });
const evar = (name: string, sortName: string): EVar => ({ tag: "EVar", name, sort: sort(sortName) });
const app = (symbol: string, args: readonly Pattern[] = [], sorts: readonly SortApp[] = []): App => ({
  tag: "App",
  symbol,
  sorts,
  args,
});
const declaration = (name: string, paramSorts: readonly string[], result: string): SymbolDecl => ({
  tag: "SymbolDecl",
  symbol: { tag: "Symbol", name, vars: [] },
  paramSorts: paramSorts.map((each) => sort(each)),
  sort: sort(result),
  attrs: [],
  hooked: false,
});

/**
 * Just enough of a projected definition for the matcher module: one `Map` and
 * one `Set` collection over `SortKItem`, a `SortKResult` that has subsorts (so
 * an injection from it abstracts), and a two-constructor `SortK`.
 */
const definition: MatcherDefinition = {
  symbols: new Map([
    ["Lbl'UndsPipe'-'-GT-Unds'", declaration("Lbl'UndsPipe'-'-GT-Unds'", ["SortKItem", "SortKItem"], "SortMap")],
    ["LblSetItem", declaration("LblSetItem", ["SortKItem"], "SortSet")],
    ["LblListItem", declaration("LblListItem", ["SortKItem"], "SortList")],
    ["Lblf", declaration("Lblf", ["SortMap"], "SortKItem")],
    ["kseq", declaration("kseq", ["SortKItem", "SortK"], "SortK")],
    ["dotk", declaration("dotk", [], "SortK")],
    ["LblwrapKItem", declaration("LblwrapKItem", ["SortKItem"], "SortKItem")],
  ]),
  constructors: new Map([
    ["SortK", ["dotk", "kseq"]],
    ["SortKItem", ["LblwrapKItem"]],
  ]),
  structureSymbols: new Map(),
  structures: new Map([
    ["SortMap", [{ name: "coll", type: "List (SortKItem × SortKItem)" }]],
    ["SortSet", [{ name: "coll", type: "List SortKItem" }]],
    ["SortList", [{ name: "coll", type: "List SortKItem" }]],
  ]),
  subsorts: new Map([["SortKResult", ["SortInt"]]]),
  collections: new Map([
    [
      "SortMap",
      { element: "Lbl'UndsPipe'-'-GT-Unds'", concat: undefined, unit: undefined, hook: "MAP.Map", kind: "Map" },
    ],
    ["SortSet", { element: "LblSetItem", concat: undefined, unit: undefined, hook: "SET.Set", kind: "Set" }],
    ["SortList", { element: "LblListItem", concat: undefined, unit: undefined, hook: "LIST.List", kind: "List" }],
  ]),
  equations: new Map([
    ["Lbl'UndsPipe'-'-GT-Unds'", []],
    ["LblSetItem", []],
    ["LblListItem", []],
  ]),
};

function only(matchers: readonly (readonly KleanMatcher[])[]): KleanMatcher {
  const flat = matchers.flat();
  expect(flat).toHaveLength(1);
  const [matcher] = flat;
  if (matcher === undefined) throw new Error("expected exactly one matcher");
  return matcher;
}

describe("repeated left-hand-side variables", () => {
  test("renames every occurrence after the first and records the class", () => {
    const pattern = app("Lblsame", [evar("VarX", "SortInt"), evar("VarX", "SortInt"), evar("VarY", "SortInt")]);
    const renamed = renameRepeatedVariables(pattern);
    expect(renamed.pattern).toMatchObject({
      args: [{ name: "VarX" }, { name: "Var'Unds'Uniq0" }, { name: "VarY" }],
    });
    expect([...renamed.classes.values()].map((group) => group.map((variable) => variable.name))).toEqual([
      ["VarX", "Var'Unds'Uniq0"],
      ["VarY"],
    ]);
  });

  test("becomes an equality guard rather than a non-linear Lean pattern", () => {
    const lhs = app("Lblsame", [evar("VarX", "SortInt"), evar("VarX", "SortInt")]);
    const result = functionRuleMatchers(definition, lhs);
    expect(result.diagnostics).toEqual([]);
    expect(result.args.map((argument) => (argument.tag === "EVar" ? argument.name : argument.tag))).toEqual([
      "VarX",
      "Var'Unds'Uniq0",
    ]);
    const matcher = only(result.generations);
    expect(matcher.tag).toBe("eq");
    expect(matcherTerms(definition, matcher).terms).toEqual({ scrutinee: "X == _Uniq0", pattern: "true" });
  });

  test("a map item's key and a set item's element stay input positions", () => {
    // pyk `k2lean4.py:800-807`: renaming these would drop the constraint the
    // hook `split` is about to impose, so the second `VarK` must survive.
    const pattern = app("Lblg", [
      app("LblSetItem", [evar("VarK", "SortKItem")]),
      app("Lbl'UndsPipe'-'-GT-Unds'", [evar("VarK", "SortKItem"), evar("VarK", "SortKItem")]),
    ]);
    const renamed = renameRepeatedVariables(pattern);
    const [setItem, mapItem] = renamed.pattern.tag === "App" ? renamed.pattern.args : [];
    expect(setItem).toMatchObject({ args: [{ name: "VarK" }] });
    expect(mapItem).toMatchObject({ args: [{ name: "VarK" }, { name: "VarK" }] });
  });
});

describe("subsort and collection matchers", () => {
  test("an injection from a sort that has subsorts becomes a retraction", () => {
    const lhs = app("LblisKResult", [
      app("kseq", [app("inj", [evar("VarR", "SortKResult")], [sort("SortKResult"), sort("SortKItem")]), app("dotk")]),
    ]);
    const result = functionRuleMatchers(definition, lhs);
    expect(result.diagnostics).toEqual([]);
    const matcher = only(result.generations);
    expect(matcher).toMatchObject({ tag: "subsort", subsort: "SortKResult", supersort: "SortKItem" });
    expect(matcherTerms(definition, matcher).terms).toEqual({
      scrutinee: "(@retr SortKResult SortKItem) _Pat0",
      pattern: "some R",
    });
  });

  test("an injection from a leaf sort is left as an ordinary constructor pattern", () => {
    const lhs = app("Lblh", [app("inj", [evar("VarI", "SortInt")], [sort("SortInt"), sort("SortKItem")])]);
    const result = functionRuleMatchers(definition, lhs);
    expect(result.generations).toEqual([]);
    expect(result.args[0]).toMatchObject({ tag: "App", symbol: "inj" });
  });

  test("`(K |-> V) M` splits the map and rebuilds the leftover at its K sort", () => {
    const lhs = app("Lblf", [
      app("Lbl'Unds'Map'Unds'", [
        app("Lbl'UndsPipe'-'-GT-Unds'", [evar("VarK", "SortKItem"), evar("VarV", "SortKItem")]),
        evar("VarM", "SortMap"),
      ]),
    ]);
    const matcher = only(functionRuleMatchers(definition, lhs).generations);
    expect(matcher).toMatchObject({ tag: "map", keySort: "SortKItem", valueSort: "SortKItem" });
    expect(matcherTerms(definition, matcher).terms).toEqual({
      scrutinee:
        "((MapHook SortKItem SortKItem).split _Pat0.coll [K]).map (fun (vs, r) => (vs, ({ coll := r } : SortMap)))",
      pattern: "some ([V], M)",
    });
  });

  test("`SetItem(X) S` splits the set", () => {
    const lhs = app("Lblf", [
      app("Lbl'Unds'Set'Unds'", [app("LblSetItem", [evar("VarX", "SortKItem")]), evar("VarS", "SortSet")]),
    ]);
    const matcher = only(functionRuleMatchers(definition, lhs).generations);
    expect(matcher.tag).toBe("set");
    expect(matcherTerms(definition, matcher).terms).toEqual({
      scrutinee: "((SetHook SortKItem).split _Pat0.coll [X]).map (fun r => ({ coll := r } : SortSet))",
      pattern: "some S",
    });
  });

  test("`ListItem(X) L` splits the list with a one-element prefix", () => {
    const lhs = app("Lblf", [
      app("Lbl'Unds'List'Unds'", [app("LblListItem", [evar("VarX", "SortKItem")]), evar("VarL", "SortList")]),
    ]);
    const matcher = only(functionRuleMatchers(definition, lhs).generations);
    expect(matcher).toMatchObject({ tag: "list", prefix: [{ tag: "EVar" }], suffix: [] });
    expect(matcherTerms(definition, matcher).terms).toEqual({
      scrutinee:
        "((ListHook SortKItem).split _Pat0.coll 1 0).map (fun (p, m, s) => (p, ({ coll := m } : SortList), s))",
      pattern: "some ([X], L, [])",
    });
  });

  test("the empty collections become size checks", () => {
    const cases: readonly (readonly [string, KleanMatcher["tag"], string])[] = [
      ["Lbl'Stop'Map", "empty-map", "(MapHook SortKItem SortKItem).size _Pat0.coll"],
      ["Lbl'Stop'Set", "empty-set", "(SetHook SortKItem).size _Pat0.coll"],
      ["Lbl'Stop'List", "empty-list", "(ListHook SortKItem).size _Pat0.coll"],
    ];
    for (const [symbol, tag, scrutinee] of cases) {
      const matcher = only(functionRuleMatchers(definition, app("Lblf", [app(symbol)])).generations);
      expect(matcher.tag).toBe(tag);
      expect(matcherTerms(definition, matcher).terms).toEqual({ scrutinee, pattern: "0" });
    }
  });
});

describe("matcher ordering", () => {
  test("a matcher that reads another's output is put in a later generation", () => {
    // `f((K |-> V) .Map)`: the inner `.Map` abstracts first and its size check
    // can only run once the outer split has bound the variable it reads.
    const lhs = app("Lblf", [
      app("Lbl'Unds'Map'Unds'", [
        app("Lbl'UndsPipe'-'-GT-Unds'", [evar("VarK", "SortKItem"), evar("VarV", "SortKItem")]),
        app("Lbl'Stop'Map"),
      ]),
    ]);
    const result = functionRuleMatchers(definition, lhs);
    expect(result.diagnostics).toEqual([]);
    expect(result.generations.map((generation) => generation.map((matcher) => matcher.tag))).toEqual([
      ["map"],
      ["empty-map"],
    ]);
  });

  test("independent matchers share one generation and a cycle is a diagnostic, not a throw", () => {
    const left = evar("VarA", "SortKItem");
    const right = evar("VarB", "SortKItem");
    const independent: readonly KleanMatcher[] = [
      { tag: "eq", first: left, second: right },
      { tag: "empty-set", variable: evar("VarS", "SortSet") },
    ];
    expect(orderMatchers(independent).generations).toHaveLength(1);

    const producesItsConsumersInput: readonly KleanMatcher[] = [
      { tag: "subsort", variable: left, subsort: "SortKResult", supersort: "SortKItem", pattern: right },
      { tag: "subsort", variable: right, subsort: "SortKResult", supersort: "SortKItem", pattern: left },
    ];
    const cyclic = orderMatchers(producesItsConsumersInput);
    expect(cyclic.generations).toEqual([]);
    expect(cyclic.diagnostics.map((item) => item.code)).toEqual(["unsupported-pattern"]);
  });

  test("inputs and outputs follow pyk's read/bind split", () => {
    const map: KleanMatcher = {
      tag: "map",
      variable: evar("VarM", "SortMap"),
      keySort: "SortKItem",
      valueSort: "SortKItem",
      keys: [evar("VarK", "SortKItem")],
      values: [evar("VarV", "SortKItem")],
      rest: evar("VarRest", "SortMap"),
    };
    expect(matcherInputs(map).map((variable) => variable.name)).toEqual(["VarM", "VarK"]);
    expect(matcherOutputs(map).map((variable) => variable.name)).toEqual(["VarV", "VarRest"]);
  });
});

describe("exhaustiveness and sort names", () => {
  test("only a variable, or a sole constructor applied to variables, is exhaustive", () => {
    expect(isExhaustive(definition, evar("VarX", "SortInt"))).toBe(true);
    expect(isExhaustive(definition, { tag: "DV", sort: sort("SortInt"), value: { tag: "String", value: "1" } })).toBe(
      false,
    );
    // SortK has two constructors, so matching one of them is not exhaustive.
    expect(isExhaustive(definition, app("kseq", [evar("VarA", "SortKItem"), app("dotk")]))).toBe(false);
    // SortKItem has exactly one, applied to a variable.
    expect(isExhaustive(definition, app("LblwrapKItem", [evar("VarA", "SortKItem")]))).toBe(true);
    // A collection function is never a constructor pattern.
    expect(isExhaustive(definition, app("LblSetItem", [evar("VarA", "SortKItem")]))).toBe(false);
  });

  test("a sort variable is a usable Lean type name and a parametric application is not", () => {
    expect(plainSortName({ tag: "SortVar", name: "S" })).toBe("S");
    expect(plainSortName(sort("SortInt"))).toBe("SortInt");
    expect(plainSortName({ tag: "SortApp", name: "SortList", sorts: [sort("SortInt")] })).toBeUndefined();
  });
});
