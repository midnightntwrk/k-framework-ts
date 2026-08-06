import { describe, expect, test } from "bun:test";
import { stableSccs, stableTopologicalOrder, stableTopologicalSccs } from "../src/analysis.ts";

describe("stable KLean graph analysis", () => {
  test("SCCs and dependency-first ordering have lexical tie-breaking", () => {
    const graph = new Map<string, readonly string[]>([
      ["z", ["b"]],
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["b"]],
      ["isolated", []],
    ]);
    expect(stableSccs(graph)).toEqual([["a"], ["b", "c"], ["isolated"], ["z"]]);
    expect(stableTopologicalSccs(graph)).toEqual([["b", "c"], ["a"], ["isolated"], ["z"]]);
    expect(stableTopologicalOrder(graph)).toEqual(["b", "c", "a", "isolated", "z"]);
  });

  test("targets absent from graph inputs are deterministic leaves", () => {
    expect(stableTopologicalSccs(new Map([["a", ["external"]]]))).toEqual([["external"], ["a"]]);
  });
});
