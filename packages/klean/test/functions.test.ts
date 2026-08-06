import { describe, expect, test } from "bun:test";
import type { App, Axiom, EquationAxiom, Pattern, Sort, SortApp, SymbolDecl } from "@kframework-ts/kore";

import { generateFunctions, PRELUDE_FUNCTIONS } from "../src/functions.js";
import type { KleanEquation, KleanProjection } from "../src/projection.js";

const sort = (name: string): SortApp => ({ tag: "SortApp", name, sorts: [] });
const sortVar = (name: string): Sort => ({ tag: "SortVar", name });
const evar = (name: string, variableSort: Sort) => ({ tag: "EVar" as const, name, sort: variableSort });
const app = (symbol: string, args: readonly Pattern[] = []): App => ({ tag: "App", symbol, sorts: [], args });
const boolean = (value: "true" | "false"): Pattern => ({
  tag: "DV",
  sort: sort("SortBool"),
  value: { tag: "String", value },
});

function symbolDecl(name: string, paramSorts: readonly Sort[], result: Sort, vars: readonly string[] = []): SymbolDecl {
  return {
    tag: "SymbolDecl",
    symbol: { tag: "Symbol", name, vars: vars.map((variable) => ({ tag: "SortVar", name: variable })) },
    paramSorts,
    sort: result,
    attrs: [],
    hooked: false,
  };
}

function equation(symbol: string, lhs: App, rhs: Pattern, result: Sort, uid: string, priority = 50): KleanEquation {
  const axiom: Axiom = { tag: "Axiom", vars: [], pattern: { tag: "Top", sort: result }, attrs: [] };
  const rule: EquationAxiom = {
    kind: priority >= 200 ? "owise" : "equation",
    symbol,
    lhs,
    argSorts: [],
    sort: result,
    rhs,
    requires: undefined,
    ensures: undefined,
    antiLeft: undefined,
    priority,
    uid,
    label: undefined,
  };
  return { axiom, rule };
}

function projection(overrides: Partial<KleanProjection>): KleanProjection {
  return {
    rewrites: [],
    equations: new Map(),
    sorts: new Map(),
    symbols: new Map(),
    subsorts: new Map(),
    constructors: new Map(),
    collections: new Map(),
    selection: { labels: [], uids: [], rewriteCount: 0, allRewrites: true },
    diagnostics: [],
    ...overrides,
  };
}

const unknown = symbolDecl("LblUnknown", [sort("SortInt")], sort("SortInt"));

describe("function generation", () => {
  test("makes a function without selected equations auditable as an axiom", () => {
    const generated = generateFunctions(
      projection({ equations: new Map([["LblUnknown", []]]), symbols: new Map([["LblUnknown", unknown]]) }),
    );
    expect(generated.text).toContain("axiom Unknown (x0 : SortInt) : Option SortInt");
    expect(generated.axiomaticFunctions).toEqual(["LblUnknown"]);
  });

  test("uses the complete upstream hooked-function Prelude surface", () => {
    expect(PRELUDE_FUNCTIONS).toHaveLength(22);
    expect(PRELUDE_FUNCTIONS).toContain("LblmaxInt'LParUndsCommUndsRParUnds'INT-COMMON'Unds'Int'Unds'Int'Unds'Int");
    expect(PRELUDE_FUNCTIONS).toContain(
      "LblsubstrBytes'LParUndsCommUndsCommUndsRParUnds'BYTES-HOOKED'Unds'Bytes'Unds'Bytes'Unds'Int'Unds'Int",
    );
  });

  test("marks a caller of an axiomatized function `noncomputable`", () => {
    // `caller(X) => opaque(X)`, where `opaque` has no retained equation. Lean
    // will not accept a plain `def` whose body reduces to an `axiom`.
    const integer = sort("SortInt");
    const generated = generateFunctions(
      projection({
        symbols: new Map([
          ["Lblopaque", symbolDecl("Lblopaque", [integer], integer)],
          ["Lblcaller", symbolDecl("Lblcaller", [integer], integer)],
        ]),
        equations: new Map([
          ["Lblopaque", []],
          [
            "Lblcaller",
            [
              equation(
                "Lblcaller",
                app("Lblcaller", [evar("VarX", integer)]),
                app("Lblopaque", [evar("VarX", integer)]),
                integer,
                "aaaaaaa1",
              ),
            ],
          ],
        ]),
      }),
    );
    expect(generated.diagnostics).toEqual([]);
    expect(generated.axiomaticFunctions).toEqual(["Lblopaque"]);
    expect(generated.text).toContain("axiom opaque (x0 : SortInt) : Option SortInt");
    expect(generated.text).toContain("noncomputable def _aaaaaa");
    expect(generated.text).toContain("noncomputable def caller (x0 : SortInt) : Option SortInt");
    // The axiom itself has no body, so it never carries the modifier.
    expect(generated.text).not.toContain("noncomputable axiom");
    // Dependencies precede dependents: Lean has no forward references.
    expect(generated.text.indexOf("axiom opaque")).toBeLessThan(generated.text.indexOf("def caller"));
  });

  test("puts a mutually recursive component in one `mutual` block", () => {
    const nat = sort("SortNat");
    const bool = sort("SortBool");
    const successor = (name: string) => app("Lbls", [evar(name, nat)]);
    const generated = generateFunctions(
      projection({
        symbols: new Map([
          ["Lblz", symbolDecl("Lblz", [], nat)],
          ["Lbls", symbolDecl("Lbls", [nat], nat)],
          ["Lblev", symbolDecl("Lblev", [nat], bool)],
          ["Lblod", symbolDecl("Lblod", [nat], bool)],
        ]),
        constructors: new Map([["SortNat", ["Lbls", "Lblz"]]]),
        equations: new Map([
          [
            "Lblev",
            [
              equation("Lblev", app("Lblev", [app("Lblz")]), boolean("true"), bool, "bbbbbb01"),
              equation("Lblev", app("Lblev", [successor("VarN")]), app("Lblod", [evar("VarN", nat)]), bool, "bbbbbb02"),
            ],
          ],
          [
            "Lblod",
            [
              equation("Lblod", app("Lblod", [app("Lblz")]), boolean("false"), bool, "cccccc01"),
              equation("Lblod", app("Lblod", [successor("VarN")]), app("Lblev", [evar("VarN", nat)]), bool, "cccccc02"),
            ],
          ],
        ]),
      }),
    );
    expect(generated.diagnostics).toEqual([]);
    expect(generated.text).toContain("mutual\n");
    expect(generated.text).toContain("\nend\n");
    // Every member of the cycle is inside the one block, indented by it.
    for (const name of ["def ev (x0 : SortNat)", "def od (x0 : SortNat)", "def _bbbbbb0", "def _cccccc0"])
      expect(generated.text).toContain(`  ${name}`);
    // The non-recursive base equations stay outside it.
    const block = generated.text.slice(generated.text.indexOf("mutual"), generated.text.indexOf("\nend"));
    expect(block).not.toContain("some true");
    // A nested Option-valued call becomes an Option-monad `do` block.
    expect(generated.text).toContain("let _Val0 <- od N");
  });

  test("emits a sort-parametric function with an implicit `{S : Type}` binder", () => {
    const parameter = sortVar("S");
    const generated = generateFunctions(
      projection({
        symbols: new Map([["Lblid", symbolDecl("Lblid", [parameter], parameter, ["S"])]]),
        equations: new Map([
          [
            "Lblid",
            [
              equation(
                "Lblid",
                app("Lblid", [evar("VarX", parameter)]),
                evar("VarX", parameter),
                parameter,
                "dddddd01",
              ),
            ],
          ],
        ]),
      }),
    );
    expect(generated.diagnostics).toEqual([]);
    expect(generated.text).toContain("def _dddddd0 {S : Type} : S → Option S");
    expect(generated.text).toContain("def id {S : Type} (x0 : S) : Option S := _dddddd0 x0");
  });

  test("refuses a parametric sort application instead of mistyping the declaration", () => {
    const parametric: Sort = { tag: "SortApp", name: "SortList", sorts: [sortVar("S")] };
    const generated = generateFunctions(
      projection({
        symbols: new Map([["Lblhead", symbolDecl("Lblhead", [parametric], sortVar("S"), ["S"])]]),
        equations: new Map([["Lblhead", []]]),
      }),
    );
    expect(generated.diagnostics.map((item) => item.code)).toEqual(["unsupported-function-signature"]);
    expect(generated.text).toBe("import Inj\n");
  });

  test("dispatches equations by priority, so an `owise` fallback is tried last", () => {
    const integer = sort("SortInt");
    const generated = generateFunctions(
      projection({
        symbols: new Map([["Lblpick", symbolDecl("Lblpick", [integer], integer)]]),
        equations: new Map([
          [
            "Lblpick",
            [
              equation(
                "Lblpick",
                app("Lblpick", [evar("VarX", integer)]),
                evar("VarX", integer),
                integer,
                "ffffff01",
                200,
              ),
              equation("Lblpick", app("Lblpick", [evar("VarY", integer)]), evar("VarY", integer), integer, "eeeeee01"),
            ],
          ],
        ]),
      }),
    );
    expect(generated.text).toContain("def pick (x0 : SortInt) : Option SortInt := (_eeeeee0 x0) <|> (_ffffff0 x0)");
  });
});
