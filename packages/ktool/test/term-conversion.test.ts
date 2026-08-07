import { describe, expect, test } from "bun:test";
import { decodeTerm, type KTerm } from "@kframework-ts/kast-json";

import { toKInner } from "../src/term-conversion.ts";

describe("toKInner", () => {
  test("reconstructs every supported KTerm node, including nested sort parameters", () => {
    const term = decodeTerm({
      node: "KApply",
      label: { node: "KLabel", name: "f", params: [{ node: "KSort", name: "Map{Int,Id}" }] },
      args: [
        { node: "KToken", token: "1", sort: { node: "KSort", name: "MInt{64}" } },
        { node: "KSequence", items: [{ node: "KVariable", name: "X" }] },
        {
          node: "KRewrite",
          lhs: { node: "KVariable", name: "L", sort: { node: "KSort", name: "Int" } },
          rhs: { node: "KAs", pattern: { node: "KVariable", name: "R" }, alias: { node: "KVariable", name: "A" } },
        },
      ],
    });
    const result = toKInner(term);
    if ("kind" in result) throw new Error(`unexpected refusal at ${result.path}`);
    expect(result).toEqual({
      node: "KApply",
      label: {
        name: "f",
        params: [
          {
            name: "Map",
            params: [
              { name: "Int", params: [] },
              { name: "Id", params: [] },
            ],
          },
        ],
      },
      args: [
        { node: "KToken", token: "1", sort: { name: "MInt", params: [{ name: "64", params: [] }] } },
        { node: "KSequence", items: [{ node: "KVariable", name: "X", sort: undefined }] },
        {
          node: "KRewrite",
          lhs: { node: "KVariable", name: "L", sort: { name: "Int", params: [] } },
          rhs: {
            node: "KAs",
            pattern: { node: "KVariable", name: "R", sort: undefined },
            alias: { node: "KVariable", name: "A", sort: undefined },
          },
        },
      ],
    });
  });

  test("returns a typed refusal for injected labels at the root and below a supported node", () => {
    const root = toKInner({ node: "InjectedKLabel", label: "_+_", params: [] });
    expect(root).toEqual({ kind: "injected-k-label", label: "_+_", params: [], path: "term" });

    const nested = toKInner({
      node: "KApply",
      label: "f",
      params: [],
      args: [{ node: "InjectedKLabel", label: "_+_", params: [] }],
    });
    expect(nested).toEqual({ kind: "injected-k-label", label: "_+_", params: [], path: "term.args[0]" });
  });

  test("returns a typed refusal for KOther rather than throwing", () => {
    const term: KTerm = { node: "KOther", args: [], items: [] };
    expect(toKInner(term)).toEqual({ kind: "other", args: 0, items: 0, path: "term" });
  });

  test("uses an explicit work stack for deep terms", () => {
    let term: KTerm = { node: "KVariable", name: "X", sort: undefined };
    for (let i = 0; i < 20_000; i++) term = { node: "KApply", label: "f", params: [], args: [term] };
    const result = toKInner(term);
    expect("kind" in result).toBe(false);
  });
});
