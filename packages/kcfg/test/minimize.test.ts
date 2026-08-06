/** Focused ports of pyk's KCFG minimizer fixtures. */

import { describe, expect, test } from "bun:test";

import { CTerm } from "@kframework-ts/cterm";
import { kapply, kvariable, type KInner } from "@kframework-ts/kast";
import { intToken } from "@kframework-ts/kast/prelude/kint";
import { mlEqualsTrue } from "@kframework-ts/kast/prelude/ml";

import { KCFG } from "../src/kcfg.ts";
import { DefaultKCFGSemantics, KCFGMinimizationError, KCFGMinimizer, type KCFGSemantics } from "../src/minimize.ts";

const config = (term: KInner) => kapply("<generatedTop>", [kapply("<k>", [term])]);
const state = (term: KInner, constraints: readonly KInner[] = []) => new CTerm(config(term), constraints);
const x = kvariable("X", "Int");
const y = kvariable("Y", "Int");
const atLeast = (variable: ReturnType<typeof kvariable>, number: number) =>
  mlEqualsTrue(kapply("_>=Int_", [variable, intToken(number)]));
const below = (variable: ReturnType<typeof kvariable>, number: number) =>
  mlEqualsTrue(kapply("_<Int_", [variable, intToken(number)]));

function edgeChain(): KCFG {
  const graph = new KCFG();
  graph.createNode(state(x));
  graph.createNode(state(x));
  graph.createNode(state(x));
  graph.createNode(state(x));
  graph.createEdge(1, 2, 5, ["r1"]);
  graph.createEdge(2, 3, 10, ["r2"]);
  graph.createEdge(3, 4, 15, ["r3"]);
  return graph;
}

describe("KCFG minimizer lifting", () => {
  test("lifts repeated edge chains while retaining depth and rule order", () => {
    const graph = edgeChain();
    const minimizer = new KCFGMinimizer(graph);

    minimizer.minimize();

    expect(graph.nodes.map((node) => node.id)).toEqual([1, 4]);
    const result = graph.edge(1, 4);
    expect(result?.depth).toBe(30);
    expect(result?.rules).toEqual(["r1", "r2", "r3"]);
  });

  test("lifts a split through an incoming edge", () => {
    const graph = new KCFG();
    graph.createNode(state(x));
    graph.createNode(state(x));
    graph.createNode(state(x, [atLeast(x, 0)]));
    graph.createNode(state(x, [below(x, 0)]));
    graph.createNode(state(x));
    graph.createNode(state(x));
    graph.createEdge(1, 2, 7, ["prefix"]);
    graph.createSplitByNodes(2, [3, 4]);
    graph.createEdge(3, 5, 2, ["then"]);
    graph.createEdge(4, 6, 3, ["else"]);

    new KCFGMinimizer(graph).liftSplitEdge(2);

    const split = graph.successor(1);
    expect(split?.kind).toBe("split");
    if (split?.kind !== "split") throw new Error("expected split");
    expect(split.targets).toHaveLength(2);
    const lifted = split.targets.map((branch) => branch.node);
    expect(lifted.map((node) => node.cterm.constraints)).toEqual([[atLeast(x, 0)], [below(x, 0)]]);
    expect(graph.edge(lifted[0]!.id, 3)?.rules).toEqual(["prefix"]);
    expect(graph.edge(lifted[0]!.id, 3)?.depth).toBe(7);
    expect(graph.edge(lifted[1]!.id, 4)?.rules).toEqual(["prefix"]);
  });

  test("fuses consecutive splits and accumulates their constraints", () => {
    const graph = new KCFG();
    graph.createNode(state(x));
    graph.createNode(state(x, [atLeast(x, 0)]));
    graph.createNode(state(x));
    graph.createNode(state(x, [atLeast(x, 0), atLeast(x, 5)]));
    graph.createNode(state(x, [atLeast(x, 0), below(x, 5)]));
    graph.createSplitByNodes(1, [2, 3]);
    graph.createSplitByNodes(2, [4, 5]);

    new KCFGMinimizer(graph).minimize();

    const split = graph.successor(1);
    expect(split?.kind).toBe("split");
    if (split?.kind !== "split") throw new Error("expected split");
    expect(split.targets.map((branch) => branch.node.id)).toEqual([3, 4, 5]);
    const branchFour = split.targets.find((branch) => branch.node.id === 4);
    expect(branchFour?.csubst.constraints).toEqual([atLeast(x, 0), atLeast(x, 5)]);
  });

  test("rejects a fresh-variable split before changing the graph", () => {
    const graph = new KCFG();
    graph.createNode(state(x));
    graph.createNode(state(x));
    graph.createNode(state(y));
    graph.createNode(state(x));
    graph.createEdge(1, 2, 1, ["r"]);
    graph.createSplitByNodes(2, [3, 4]);
    const before = graph.toDict();

    expect(() => new KCFGMinimizer(graph).liftSplitEdge(2)).toThrow(KCFGMinimizationError);
    expect(graph.toDict()).toEqual(before);
  });
});

class MergeEverything extends DefaultKCFGSemantics {
  override isMergeable(): boolean {
    return true;
  }
}

function mergeGraph(): KCFG {
  const graph = new KCFG();
  graph.createNode(state(x));
  graph.createNode(state(x, [atLeast(x, 0)]));
  graph.createNode(state(x, [below(x, 0)]));
  graph.createNode(state(intToken(1)));
  graph.createNode(state(intToken(2)));
  graph.createSplitByNodes(1, [2, 3]);
  graph.createEdge(2, 4, 4, ["left"]);
  graph.createEdge(3, 5, 9, ["right"]);
  return graph;
}

describe("KCFG minimizer branch merging", () => {
  test("creates a merged edge and a recovery split using ctermsAntiUnify", () => {
    const graph = mergeGraph();

    new KCFGMinimizer(graph, new MergeEverything()).minimize(true);

    const merged = graph.successor(1);
    expect(merged?.kind).toBe("merged-edge");
    if (merged?.kind !== "merged-edge") throw new Error("expected merged edge");
    expect(merged.edges.map((edge) => [edge.source.id, edge.target.id, edge.depth, edge.rules])).toEqual([
      [2, 4, 4, ["left"]],
      [3, 5, 9, ["right"]],
    ]);
    const recovery = graph.successor(merged.target.id);
    expect(recovery?.kind).toBe("split");
    if (recovery?.kind !== "split") throw new Error("expected recovery split");
    expect(recovery.targets.map((branch) => branch.node.id)).toEqual([4, 5]);
  });

  test("does not merge branches under the conservative default policy", () => {
    const graph = mergeGraph();
    const before = graph.toDict();

    expect(new KCFGMinimizer(graph).mergeNodes()).toBe(false);
    expect(graph.toDict()).toEqual(before);
  });

  test("merges one equivalence class while preserving the other split branches", () => {
    const graph = mergeGraph();
    graph.createNode(state(x, [atLeast(x, 10)]));
    graph.createNode(state(intToken(3)));
    graph.removeSuccessor(1);
    graph.createSplitByNodes(1, [2, 3, 6]);
    graph.createEdge(6, 7, 12, ["other"]);
    const firstTwo: KCFGSemantics = {
      isMergeable(first, second) {
        const mergeable = new Set([graph.node(4).cterm, graph.node(5).cterm]);
        return mergeable.has(first) && mergeable.has(second);
      },
    };

    new KCFGMinimizer(graph, firstTwo).minimize(true);

    const split = graph.successor(1);
    expect(split?.kind).toBe("split");
    if (split?.kind !== "split") throw new Error("expected split");
    expect(split.targets).toHaveLength(2);
    expect(split.targets.some((branch) => branch.node.id === 6)).toBe(true);
    const mergedSource = split.targets.find((branch) => branch.node.id !== 6)!.node;
    const merged = graph.successor(mergedSource.id);
    expect(merged?.kind).toBe("merged-edge");
    if (merged?.kind !== "merged-edge") throw new Error("expected merged edge");
    expect(merged.edges.map((edge) => edge.rules)).toEqual([["left"], ["right"]]);
    expect(graph.edge(6, 7)?.rules).toEqual(["other"]);
  });

  test("rejects an asymmetric mergeability heuristic before editing", () => {
    const graph = mergeGraph();
    const before = graph.toDict();
    const asymmetric: KCFGSemantics = {
      isMergeable(first, second) {
        return first === graph.node(4).cterm && second === graph.node(5).cterm;
      },
    };

    expect(() => new KCFGMinimizer(graph, asymmetric).mergeNodes()).toThrow(KCFGMinimizationError);
    expect(graph.toDict()).toEqual(before);
  });
});
