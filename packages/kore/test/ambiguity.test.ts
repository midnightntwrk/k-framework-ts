import { describe, expect, test } from "bun:test";
import { findAmbiguities, unwrapInjections } from "../src/ambiguity.ts";
import { parsePattern } from "../src/parser.ts";
import { LBL_AMB, INJ, inj } from "../src/prelude.ts";
import { app, sortApp } from "../src/syntax.ts";
import type { App, Pattern } from "../src/syntax.ts";

const BODY = sortApp("SortBody");
const KITEM = sortApp("SortKItem");

function amb(alternatives: readonly Pattern[], sorts: readonly (typeof BODY)[] = [BODY]): App {
  return app(LBL_AMB, sorts, alternatives);
}

describe("unwrapInjections", () => {
  test("iteratively removes only consecutive well-formed injection wrappers", () => {
    const leaf = app("LblbodyBlockExpr");
    expect(unwrapInjections(inj(BODY, KITEM, inj(BODY, KITEM, leaf)))).toBe(leaf);

    const malformed = { tag: "App", symbol: INJ, sorts: [BODY], args: [leaf] } as const;
    expect(unwrapInjections(malformed)).toBe(malformed);
    expect(unwrapInjections(leaf)).toBe(leaf);
  });
});

describe("findAmbiguities", () => {
  test("projects the provenance-backed GLR term vendored from K's llvm test definition", async () => {
    const fixture = await Bun.file(new URL("../fixtures/ambiguity/llvm-amb-rule.kore", import.meta.url)).text();
    const result = findAmbiguities(parsePattern(fixture));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ tag: "ambiguity", sortName: "Exp" });
    if (result[0]?.tag === "ambiguity") expect(result[0].alternatives).toHaveLength(2);
  });

  test("projects raw and demangled names, sorts, and injection-transparent heads", () => {
    const block = app("LblbodyBlockExpr");
    const expr = app("LblexprSub");
    const result = findAmbiguities(amb([inj(BODY, KITEM, block), expr]));
    expect(result).toEqual([
      {
        tag: "ambiguity",
        sort: BODY,
        sortName: "Body",
        alternatives: [inj(BODY, KITEM, block), expr],
        heads: [
          { symbol: "LblbodyBlockExpr", label: "bodyBlockExpr" },
          { symbol: "LblexprSub", label: "exprSub" },
        ],
      },
    ]);
  });

  test("flattens directly nested ambiguity nodes but retains deeper distinct nodes", () => {
    const a = app("Lbla");
    const b = app("Lblb");
    const c = app("Lblc");
    const flat = findAmbiguities(amb([amb([a, b]), c]));
    expect(flat).toHaveLength(1);
    expect(flat[0]).toMatchObject({ tag: "ambiguity", alternatives: [a, b, c] });

    const directChain = findAmbiguities(amb([amb([amb([a, b]), c]), a]));
    expect(directChain).toHaveLength(1);
    expect(directChain[0]).toMatchObject({ tag: "ambiguity", alternatives: [a, b, c, a] });

    const deep = findAmbiguities(amb([app("Lblf", [], [amb([a, b])]), c]));
    expect(deep).toHaveLength(2);
    expect(deep.map((entry) => entry.tag)).toEqual(["ambiguity", "ambiguity"]);
  });

  test("accepts synthetic n-ary input and returns malformed nodes as typed refusals", () => {
    const a = app("Lbla");
    const b = app("Lblb");
    const c = app("Lblc");
    expect(findAmbiguities(amb([a, b, c]))[0]).toMatchObject({ tag: "ambiguity", alternatives: [a, b, c] });
    expect(findAmbiguities(amb([a], []))).toEqual([
      { tag: "refusal", reason: "wrong-sort-arity", pattern: amb([a], []) },
    ]);
    expect(findAmbiguities(amb([a]))).toEqual([{ tag: "refusal", reason: "too-few-alternatives", pattern: amb([a]) }]);
  });

  test("walks a deeply nested term without recursion", () => {
    let deep: Pattern = amb([app("Lbla"), app("Lblb")]);
    for (let i = 0; i < 100_000; i += 1) deep = app("Lblwrap", [], [deep]);
    expect(findAmbiguities(deep)).toHaveLength(1);
  });
});
