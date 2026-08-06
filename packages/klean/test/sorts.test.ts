import { describe, expect, test } from "bun:test";
import type { SortDecl, SymbolDecl } from "@kframework-ts/kore";

import { generateInjectionsModule } from "../src/injections.js";
import { generateSortsModule, structureFields } from "../src/sorts.js";

const sort = (name: string): SortDecl => ({ tag: "SortDecl", name, vars: [], attrs: [], hooked: false });
const symbol = (name: string, params: readonly string[], result: string): SymbolDecl => ({
  tag: "SymbolDecl",
  symbol: { tag: "Symbol", name, vars: [] },
  paramSorts: params.map((entry) => ({ tag: "SortApp", name: entry, sorts: [] })),
  sort: { tag: "SortApp", name: result, sorts: [] },
  attrs: [],
  hooked: false,
});

describe("sort and injection generation", () => {
  const definition = {
    sorts: new Map([
      ["SortNat", sort("SortNat")],
      ["SortKItem", sort("SortKItem")],
      ["SortStateCell", sort("SortStateCell")],
    ]),
    symbols: new Map([
      ["LblZero", symbol("LblZero", [], "SortNat")],
      ["LblStateCell", symbol("LblStateCell", ["SortNat"], "SortStateCell")],
    ]),
    subsorts: new Map([
      ["SortNat", []],
      ["SortKItem", ["SortNat"]],
      ["SortStateCell", []],
    ]),
    constructors: new Map([
      ["SortNat", ["LblZero"]],
      ["SortKItem", []],
      ["SortStateCell", ["LblStateCell"]],
    ]),
    collections: new Map(),
  };

  test("uses inductives for ordinary sorts and structures for cells", () => {
    expect(generateSortsModule(definition)).toContain("inductive SortNat : Type where\n  | Zero : SortNat");
    expect(generateSortsModule(definition)).toContain("structure SortStateCell : Type where\n  val : SortNat");
    expect(structureFields(definition).get("SortStateCell")).toEqual([{ name: "val", type: "SortNat" }]);
  });

  test("emits an Inj instance with injection and partial retraction", () => {
    const output = generateInjectionsModule(definition);
    expect(output).toContain("instance inj_SortNat_SortKItem : Inj SortNat SortKItem where");
    expect(output).toContain("retr");
  });

  test("excludes SortKItem and every transitive container from DecidableEq", () => {
    const nested = {
      sorts: new Map([
        ["SortKItem", sort("SortKItem")],
        ["SortWrapped", sort("SortWrapped")],
        ["SortTransitive", sort("SortTransitive")],
        ["SortPlain", sort("SortPlain")],
      ]),
      symbols: new Map([
        ["LblWrapped", symbol("LblWrapped", ["SortKItem"], "SortWrapped")],
        ["LblTransitive", symbol("LblTransitive", ["SortWrapped"], "SortTransitive")],
      ]),
      subsorts: new Map([
        ["SortKItem", []],
        ["SortWrapped", []],
        ["SortTransitive", []],
        ["SortPlain", []],
      ]),
      constructors: new Map([
        ["SortKItem", []],
        ["SortWrapped", ["LblWrapped"]],
        ["SortTransitive", ["LblTransitive"]],
        ["SortPlain", []],
      ]),
      collections: new Map(),
    };
    const output = generateSortsModule(nested, { deriveBeq: true, deriveDecidableEq: true });
    expect(output).toContain("inductive SortKItem : Type\n  deriving BEq");
    expect(output).toContain(
      "inductive SortWrapped : Type where\n  | Wrapped (x0 : SortKItem) : SortWrapped\n  deriving BEq",
    );
    expect(output).toContain(
      "inductive SortTransitive : Type where\n  | Transitive (x0 : SortWrapped) : SortTransitive\n  deriving BEq",
    );
    expect(output).toContain("inductive SortPlain : Type\n  deriving BEq, DecidableEq");
  });
});
