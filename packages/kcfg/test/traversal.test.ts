import { CSubst, CTerm } from "@kframework-ts/cterm";
import { intToken } from "@kframework-ts/kast/prelude/kint";
import { kapply } from "@kframework-ts/kast";
import { describe, expect, test } from "bun:test";
import { KCFG } from "../src/index.ts";

const term = (value: number) => new CTerm(kapply("<top>", [intToken(value)]));

describe("KCFG traversal", () => {
  test("uses Dijkstra path weights and permits positive cycles", () => {
    const graph = new KCFG();
    const a = graph.createNode(term(0));
    const b = graph.createNode(term(1));
    const c = graph.createNode(term(2));
    graph.createEdge(a.id, b.id, 3);
    graph.createEdge(b.id, c.id, 2);
    graph.createEdge(c.id, a.id, 1);
    // pyk's distance helper is symmetric, so it sees the reverse one-step edge.
    expect(graph.shortestDistanceBetween(a.id, c.id)).toBe(1);
    expect(graph.shortestPathBetween(a.id, c.id)?.map((step) => step.target)).toEqual([b.id, c.id]);
    expect(graph.pathsBetween(a.id, c.id)).toHaveLength(1);
  });

  test("rejects zero-weight cycles and prunes only forward-reachable nodes", () => {
    const graph = new KCFG();
    const a = graph.createNode(term(0));
    const b = graph.createNode(term(1));
    const c = graph.createNode(term(2));
    graph.createNDBranch(a.id, [b.id, c.id]);
    expect(graph.zeroDepthBetween(a.id, b.id)).toBe(false);
    const extra = graph.createNode(term(3));
    expect([...graph.prune(a.id, [b.id])].toSorted((left, right) => left - right)).toEqual([a.id, c.id]);
    expect(graph.node(extra.id)).toBe(extra);
  });

  test("reports successors, predecessors, and reverse reachability through a branch", () => {
    const graph = new KCFG();
    const root = graph.createNode(term(0));
    const branch = graph.createNode(term(1));
    const left = graph.createNode(term(2));
    const right = graph.createNode(term(3));
    graph.createEdge(root.id, branch.id, 1);
    graph.createNDBranch(branch.id, [left.id, right.id]);
    expect(graph.successors(branch.id)[0]?.targetIds).toEqual([left.id, right.id]);
    expect(graph.predecessors(left.id)[0]?.source.id).toBe(branch.id);
    expect(
      [...graph.reachableNodes(left.id, { reverse: true })]
        .map((node) => node.id)
        .toSorted((first, second) => first - second),
    ).toEqual([root.id, branch.id, left.id].toSorted((first, second) => first - second));
  });

  test("rejects cover and split zero-depth backedges while allowing positive cycles", () => {
    const coverGraph = new KCFG();
    const general = coverGraph.createNode(
      new CTerm(kapply("<top>", [{ node: "KVariable", name: "X", sort: undefined }])),
    );
    const concrete = coverGraph.createNode(term(1));
    coverGraph.createCover(concrete.id, general.id);
    expect(() => coverGraph.createCover(general.id, concrete.id, new CSubst())).toThrow();

    const splitGraph = new KCFG();
    const source = splitGraph.createNode(
      new CTerm(kapply("<top>", [{ node: "KVariable", name: "Y", sort: undefined }])),
    );
    const target = splitGraph.createNode(term(2));
    const other = splitGraph.createNode(term(3));
    splitGraph.createCover(target.id, source.id);
    expect(() => splitGraph.createSplitByNodes(source.id, [target.id, other.id])).toThrow();

    const positive = new KCFG();
    const a = positive.createNode(term(0));
    const b = positive.createNode(term(1));
    positive.createEdge(a.id, b.id, 1);
    expect(() => positive.createEdge(b.id, a.id, 1)).not.toThrow();
  });
});
