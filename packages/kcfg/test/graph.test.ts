import { CSubst, CTerm } from "@kframework-ts/cterm";
import { intToken } from "@kframework-ts/kast/prelude/kint";
import { kapply, kvariable } from "@kframework-ts/kast";
import { describe, expect, test } from "bun:test";
import { KCFG, KCFGInvariantError, KCFGNode, NodeAttr, UnknownKCFGNodeError, edge, split } from "../src/index.ts";

const concrete = (value: number) => new CTerm(kapply("<top>", [intToken(value)]));
const general = () => new CTerm(kapply("<top>", [kvariable("X")]));

describe("KCFG graph mutation", () => {
  test("has one canonical successor and refreshes all node references", () => {
    const graph = new KCFG();
    const source = graph.createNode(concrete(1));
    const target = graph.createNode(concrete(2));
    graph.addSuccessor(edge(source, target, 1));
    expect(() => graph.createEdge(source.id, target.id, 1)).toThrow();
    const replacement = target.let({ attrs: [NodeAttr.STUCK] });
    graph.replaceNode(replacement);
    expect(graph.edge(source.id, target.id)?.target).toBe(replacement);
    expect(graph.isStuck(target.id)).toBe(true);
    graph.addAlias("target", target.id);
    graph.removeNode(target.id);
    expect(graph.getNode("@target")).toBeUndefined();
    expect(graph.successor(source.id)).toBeUndefined();
  });

  test("constructs all successor kinds and enforces their cardinality", () => {
    const coverGraph = new KCFG();
    const covered = coverGraph.createNode(concrete(1));
    const pattern = coverGraph.createNode(general());
    expect(coverGraph.createCover(covered.id, pattern.id).kind).toBe("cover");

    const graph = new KCFG();
    const source = graph.createNode(general());
    const left = graph.createNode(concrete(1));
    const right = graph.createNode(concrete(2));
    const leftSubst = source.cterm.matchWithConstraint(left.cterm)!;
    const rightSubst = source.cterm.matchWithConstraint(right.cterm)!;
    expect(
      graph.createSplit(source.id, [
        [left.id, leftSubst],
        [right.id, rightSubst],
      ]).kind,
    ).toBe("split");
    expect(() => graph.createNDBranch(source.id, [left.id])).toThrow(KCFGInvariantError);

    const ndGraph = new KCFG();
    const n0 = ndGraph.createNode(concrete(0));
    const n1 = ndGraph.createNode(concrete(1));
    const n2 = ndGraph.createNode(concrete(2));
    expect(ndGraph.createNDBranch(n0.id, [n1.id, n2.id], ["r"]).weight).toBe(1);
  });

  test("removing a referenced node removes adjacency for every successor kind", () => {
    const cases: readonly (() => readonly [KCFG, number, number])[] = [
      () => {
        const graph = new KCFG();
        const source = graph.createNode(concrete(0));
        const victim = graph.createNode(concrete(1));
        graph.createEdge(source.id, victim.id, 1);
        return [graph, source.id, victim.id];
      },
      () => {
        const graph = new KCFG();
        const source = graph.createNode(concrete(0));
        const target = graph.createNode(concrete(1));
        const victim = graph.createNode(concrete(2));
        const memberTarget = graph.createNode(concrete(3));
        graph.createMergedEdge(source.id, target.id, [edge(victim, memberTarget, 1)]);
        return [graph, source.id, victim.id];
      },
      () => {
        const graph = new KCFG();
        const source = graph.createNode(concrete(0));
        const victim = graph.createNode(general());
        graph.createCover(source.id, victim.id);
        return [graph, source.id, victim.id];
      },
      () => {
        const graph = new KCFG();
        const source = graph.createNode(general());
        const victim = graph.createNode(concrete(1));
        const other = graph.createNode(concrete(2));
        graph.createSplitByNodes(source.id, [victim.id, other.id]);
        return [graph, source.id, victim.id];
      },
      () => {
        const graph = new KCFG();
        const source = graph.createNode(concrete(0));
        const victim = graph.createNode(concrete(1));
        const other = graph.createNode(concrete(2));
        graph.createNDBranch(source.id, [victim.id, other.id]);
        return [graph, source.id, victim.id];
      },
    ];
    for (const make of cases) {
      const [graph, source, victim] = make();
      graph.addAlias("victim", victim);
      graph.removeNode(victim);
      expect(graph.successor(source)).toBeUndefined();
      expect(graph.getNode("@victim")).toBeUndefined();
    }
  });

  test("resolves aliases exactly and maintains vacuous/stuck attributes", () => {
    const graph = new KCFG();
    const node = graph.createNode(concrete(0));
    graph.addAlias("start", node.id);
    expect(graph.node("@start")).toBe(node);
    expect(graph.aliases(node.id)).toEqual(["start"]);
    expect(() => graph.addAlias("@bad", node.id)).toThrow(KCFGInvariantError);
    expect(() => graph.addAlias("start", node.id)).toThrow(KCFGInvariantError);
    expect(() => graph.node("@missing")).toThrow(UnknownKCFGNodeError);
    graph.addVacuous(node.id);
    graph.addStuck(node.id);
    expect(graph.vacuous).toHaveLength(1);
    expect(graph.stuck).toHaveLength(1);
    graph.removeVacuous(node.id);
    graph.discardStuck(node.id);
    expect(graph.isVacuous(node.id)).toBe(false);
    expect(graph.isStuck(node.id)).toBe(false);
  });

  test("derives split substitutions by nodes and fails without mutation on mismatch", () => {
    const graph = new KCFG();
    const source = graph.createNode(general());
    const left = graph.createNode(concrete(1));
    const right = graph.createNode(concrete(2));
    const value = graph.createSplitByNodes(source.id, [left.id, right.id])!;
    expect(value.splits.get(left.id)?.toDict()).toEqual(source.cterm.matchWithConstraint(left.cterm)?.toDict());
    expect(value.splits.get(right.id)?.toDict()).toEqual(source.cterm.matchWithConstraint(right.cterm)?.toDict());
    const failed = new KCFG();
    const concreteSource = failed.createNode(concrete(0));
    const bad = failed.createNode(concrete(1));
    const other = failed.createNode(concrete(2));
    expect(failed.createSplitByNodes(concreteSource.id, [bad.id, other.id])).toBeUndefined();
    expect(failed.successor(concreteSource.id)).toBeUndefined();
  });

  test("validates an externally supplied split against canonical graph nodes", () => {
    const graph = new KCFG();
    const actual = graph.createNode(concrete(0));
    const left = graph.createNode(concrete(1));
    const right = graph.createNode(concrete(2));
    const stale = new KCFGNode(actual.id, general());
    const supplied = split(stale, [
      { node: left, csubst: stale.cterm.matchWithConstraint(left.cterm)! },
      { node: right, csubst: stale.cterm.matchWithConstraint(right.cterm)! },
    ]);
    expect(() => graph.addSuccessor(supplied)).toThrow(KCFGInvariantError);
  });

  test("rejects a split substitution that does not produce its target", () => {
    const graph = new KCFG();
    const source = graph.createNode(general());
    const left = graph.createNode(concrete(1));
    const right = graph.createNode(concrete(2));

    expect(() =>
      graph.createSplit(source.id, [
        [left.id, new CSubst()],
        [right.id, new CSubst()],
      ]),
    ).toThrow(KCFGInvariantError);
    expect(graph.successor(source.id)).toBeUndefined();
  });

  test("never advances next beyond the safe-integer range", () => {
    const graph = new KCFG();
    expect(() => graph.addNode(new KCFGNode(Number.MAX_SAFE_INTEGER, general()))).toThrow(KCFGInvariantError);
    expect(graph.next).toBe(1);
  });
});
