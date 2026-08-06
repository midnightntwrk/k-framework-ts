import { describe, expect, test } from "bun:test";
import type { SortDecl, SymbolDecl } from "@kframework-ts/kore";

import { lowerKorePattern } from "../src/lower.js";

const sort = (name: string): SortDecl => ({ tag: "SortDecl", name, vars: [], attrs: [], hooked: false });
const symbol = (name: string, params: readonly string[], result: string): SymbolDecl => ({
  tag: "SymbolDecl",
  symbol: { tag: "Symbol", name, vars: [] },
  paramSorts: params.map((entry) => ({ tag: "SortApp", name: entry, sorts: [] })),
  sort: { tag: "SortApp", name: result, sorts: [] },
  attrs: [],
  hooked: false,
});

describe("KORE lowering", () => {
  const definition = {
    symbols: new Map([["LblPair", symbol("LblPair", ["SortInt", "SortInt"], "SortPair")]]),
    constructors: new Map([["SortPair", ["LblPair"]]]),
  };

  test("lowers domain values, constructors, and typeclass injections", () => {
    const pair = {
      tag: "App" as const,
      symbol: "LblPair",
      sorts: [],
      args: [
        {
          tag: "DV" as const,
          sort: { tag: "SortApp" as const, name: "SortInt", sorts: [] },
          value: { tag: "String" as const, value: "-1" },
        },
        {
          tag: "App" as const,
          symbol: "inj",
          sorts: [
            { tag: "SortApp" as const, name: "SortInt", sorts: [] },
            { tag: "SortApp" as const, name: "SortKItem", sorts: [] },
          ],
          args: [{ tag: "EVar" as const, name: "VarX", sort: { tag: "SortApp" as const, name: "SortInt", sorts: [] } }],
        },
      ],
    };
    expect(lowerKorePattern(definition, pair)).toEqual({
      term: "SortPair.Pair (-1) ((@inj SortInt SortKItem) X)",
      diagnostics: [],
    });
  });

  test("reports unsupported matching-logic terms instead of producing a partial term", () => {
    const result = lowerKorePattern(definition, { tag: "Top", sort: { tag: "SortApp", name: "SortBool", sorts: [] } });
    expect(result.term).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe("unsupported-pattern");
  });
});

void sort;
