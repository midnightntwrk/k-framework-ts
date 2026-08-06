/**
 * `KCFG.Edge.to_rule`, `KCFG.to_rules` and `KCFG.to_module`
 * (`kcfg/kcfg.py:218-246`, `288-289`, `713-735`).
 *
 * # No upstream oracle exists
 *
 * pyk asserts on none of this: `test_kcfg.py` never calls `to_rule`,
 * `to_rules` or `to_module`, and the only in-tree consumers are
 * `proof/reachability.py` and `kcfg/show.py`. The expectations below are
 * therefore read off `kcfg.py` line by line — sentence-id shape, priority
 * default, `#Ceil` filtering, the edges-then-merged-edges order, and the
 * successor kinds that contribute nothing — rather than copied from a fixture.
 *
 * The printer is `stubPrint` from `./show-support.ts`, for the same reason the
 * `./show` tests use it: nothing here depends on a kompiled definition.
 */

import { CTerm } from "@kframework-ts/cterm";
import {
  Atts,
  KAtt,
  attEntry,
  extractLhs,
  extractRhs,
  inlineCellMaps as kastInlineCellMaps,
  kapply,
  kimport,
  kvariable,
  minimizeRuleLike as kastMinimizeRuleLike,
  type KRule,
} from "@kframework-ts/kast";
import { intToken } from "@kframework-ts/kast/prelude/kint";
import { mlEqualsTrue } from "@kframework-ts/kast/prelude/ml";
import { describe, expect, test } from "bun:test";

import { KCFG } from "../src/kcfg.ts";
import {
  edgeToClaim,
  edgeToRule,
  inlineCellMaps,
  kcfgToModule,
  kcfgToRules,
  minimizeRuleLike,
  sentenceId,
  simplifyConfig,
} from "../src/rules.ts";
import { edge } from "../src/successor.ts";
import { chainGraph, concrete, csubst, gtInt, stubPrint, symbolic } from "./show-support.ts";

const attText = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const labelOf = (rule: KRule): string | undefined => attText(rule.att.get(Atts.LABEL));
const priorityOf = (rule: KRule): string | undefined => attText(rule.att.get(Atts.PRIORITY));

/** The two-node graph every default in `to_rules` is visible on. */
const oneEdge = (): KCFG => chainGraph();

describe("edgeToRule (kcfg.py:218-246)", () => {
  test("the sentence id is <label>-<source>-TO-<target> (kcfg.py:230)", () => {
    const graph = oneEdge();
    const [only] = graph.edges();
    expect(only).toBeDefined();
    expect(sentenceId(only!, "SUMMARY")).toBe("SUMMARY-1-TO-2");
    expect(labelOf(edgeToRule(only!, "SUMMARY"))).toBe("SUMMARY-1-TO-2");
  });

  test("the body rewrites the source configuration to the target's", () => {
    const graph = oneEdge();
    const [only] = graph.edges();
    const rule = edgeToRule(only!, "BASIC-BLOCK");
    expect(stubPrint(extractLhs(rule.body))).toContain("<k>(X)");
    expect(stubPrint(extractRhs(rule.body))).toBe("<generatedTop>(<k>(2))");
  });

  test("source constraints become requires", () => {
    const graph = oneEdge();
    const [only] = graph.edges();
    expect(stubPrint(edgeToRule(only!, "BASIC-BLOCK").requires)).toContain("_>Int_");
  });

  test("#Ceil conditions are dropped from both ends (kcfg.py:226-227, 232-235)", () => {
    const graph = new KCFG();
    const ceil = kapply("#Ceil", [kvariable("X")]);
    const source = graph.createNode(symbolic("X", [ceil, gtInt("X", 0)]));
    const target = graph.createNode(concrete(2));
    graph.createEdge(source.id, target.id, 1);
    const [only] = graph.edges();
    const rendered = stubPrint(edgeToRule(only!, "BASIC-BLOCK"));
    expect(rendered).not.toContain("#Ceil");
    expect(rendered).toContain("_>Int_");
  });

  test("priority is attached only when asked for (kcfg.py:241-243)", () => {
    const graph = oneEdge();
    const [only] = graph.edges();
    expect(priorityOf(edgeToRule(only!, "BASIC-BLOCK"))).toBeUndefined();
    expect(priorityOf(edgeToRule(only!, "BASIC-BLOCK", { priority: 20 }))).toBe("20");
  });

  test("minimize runs minimize_rule_like over the result (kcfg.py:244-245)", () => {
    const graph = new KCFG();
    // `Unused` occurs once, so `minimize_rule_like` abstracts it away.
    const source = graph.createNode(
      new CTerm(kapply("<generatedTop>", [kapply("<k>", [kvariable("X")]), kapply("<extra>", [kvariable("Unused")])])),
    );
    const target = graph.createNode(
      new CTerm(kapply("<generatedTop>", [kapply("<k>", [intToken(2)]), kapply("<extra>", [kvariable("Unused")])])),
    );
    graph.createEdge(source.id, target.id, 1);
    const [only] = graph.edges();
    expect(stubPrint(edgeToRule(only!, "BASIC-BLOCK"))).toContain("<extra>");
    expect(stubPrint(edgeToRule(only!, "BASIC-BLOCK", { minimize: true }))).not.toContain("<extra>");
  });

  test("a bare { source, target } pair works, as APRProof's depth-0 edge needs (reachability.py:459-468)", () => {
    const graph = new KCFG();
    const init = graph.createNode(symbolic("X"));
    const target = graph.createNode(concrete(9));
    // `edge()` rejects depth 0 (`successor.ts:8-11`), which is exactly what pyk
    // fabricates here; `to_rule` never reads the depth.
    expect(() => edge(init, target, 0)).toThrow();
    expect(labelOf(edgeToRule({ source: init, target }, "PROOF-ID"))).toBe("PROOF-ID-1-TO-2");
  });

  test("a merged edge takes the identical path (kcfg.py:288-289)", () => {
    const graph = new KCFG();
    const source = graph.createNode(symbolic("X"));
    const target = graph.createNode(concrete(3));
    graph.createMergedEdge(source.id, target.id, [edge(source, target, 2, ["A"]), edge(source, target, 5, ["B"])]);
    const [merged] = graph.mergedEdges();
    expect(merged).toBeDefined();
    expect(labelOf(edgeToRule(merged!, "BASIC-BLOCK"))).toBe("BASIC-BLOCK-1-TO-2");
  });
});

describe("edgeToClaim (kcfg.py:218-246, claim=True)", () => {
  test("the claim carries the same sentence id and rewrite", () => {
    const graph = oneEdge();
    const [only] = graph.edges();
    const claim = edgeToClaim(only!, "SUMMARY");
    expect(claim.node).toBe("KClaim");
    expect(claim.att.get(Atts.LABEL)).toBe("SUMMARY-1-TO-2");
    expect(stubPrint(extractRhs(claim.body))).toBe("<generatedTop>(<k>(2))");
  });

  test("minimizeRuleLike keeps a claim a claim (manip.py:534-560)", () => {
    const graph = oneEdge();
    const [only] = graph.edges();
    expect(edgeToClaim(only!, "SUMMARY", { minimize: true }).node).toBe("KClaim");
    expect(minimizeRuleLike(edgeToRule(only!, "SUMMARY")).node).toBe("KRule");
  });
});

describe("kcfgToRules (kcfg.py:713-722)", () => {
  test("the defaults are BASIC-BLOCK and priority 20", () => {
    const [rule] = kcfgToRules(oneEdge());
    expect(labelOf(rule!)).toBe("BASIC-BLOCK-1-TO-2");
    expect(priorityOf(rule!)).toBe("20");
  });

  test("edges come first, then merged edges", () => {
    const graph = new KCFG();
    const n1 = graph.createNode(symbolic("X"));
    const n2 = graph.createNode(concrete(2));
    const n3 = graph.createNode(concrete(3));
    const n4 = graph.createNode(concrete(4));
    graph.createEdge(n1.id, n2.id, 1, ["RULE-A"]);
    graph.createMergedEdge(n3.id, n4.id, [edge(n3, n4, 1, ["RULE-B"])]);
    expect(kcfgToRules(graph, { id: "M" }).map(labelOf)).toEqual(["M-1-TO-2", "M-3-TO-4"]);
  });

  test("covers, splits and ndbranches contribute no rules", () => {
    const graph = new KCFG();
    const root = graph.createNode(symbolic("Y"));
    const left = graph.createNode(symbolic("Y", [gtInt("Y", 10)]));
    const right = graph.createNode(symbolic("Y", [gtInt("Y", 20)]));
    const branchA = graph.createNode(concrete(7));
    const branchB = graph.createNode(concrete(8));
    graph.createSplit(root.id, [
      [left.id, csubst({ Y: kvariable("Y") }, [gtInt("Y", 10)])],
      [right.id, csubst({ Y: kvariable("Y") }, [gtInt("Y", 20)])],
    ]);
    graph.createNDBranch(left.id, [branchA.id, branchB.id], ["RULE-C"]);
    graph.createCover(branchA.id, root.id, csubst({ Y: intToken(7) }));
    expect(graph.splits()).toHaveLength(1);
    expect(graph.covers()).toHaveLength(1);
    expect(graph.ndbranches()).toHaveLength(1);
    expect(kcfgToRules(graph)).toHaveLength(0);
  });

  test("the returned array is frozen", () => {
    expect(Object.isFrozen(kcfgToRules(oneEdge()))).toBe(true);
  });
});

describe("kcfgToModule (kcfg.py:724-735)", () => {
  test("the default module name is KCFG", () => {
    expect(kcfgToModule(oneEdge()).name).toBe("KCFG");
  });

  test("name, imports and att are passed through", () => {
    const module = kcfgToModule(oneEdge(), {
      moduleName: "SUMMARY-TEST",
      imports: [kimport("VERIFICATION")],
      att: new KAtt([attEntry(Atts.LABEL, "summary")]),
    });
    expect(module.name).toBe("SUMMARY-TEST");
    expect(module.imports.map((imp) => imp.name)).toEqual(["VERIFICATION"]);
    expect(module.att.get(Atts.LABEL)).toBe("summary");
  });

  test("an explored graph round-trips into a module of one rule per basic block", () => {
    // 1 --2 steps--> 2 --3 steps--> 3, the shape `KCFGMinimizer` leaves behind.
    const graph = new KCFG();
    const n1 = graph.createNode(symbolic("X", [gtInt("X", 0)]));
    const n2 = graph.createNode(
      symbolic("X", [gtInt("X", 0), mlEqualsTrue(kapply("_>Int_", [kvariable("X"), intToken(5)]))]),
    );
    const n3 = graph.createNode(concrete(42));
    graph.createEdge(n1.id, n2.id, 2, ["STEP-A"]);
    graph.createEdge(n2.id, n3.id, 3, ["STEP-B"]);

    const module = kcfgToModule(graph, { moduleName: "SUMMARY-ROUNDTRIP", id: "SUM", priority: 40 });

    expect(module.sentences).toHaveLength(2);
    expect(module.sentences.map((sentence) => (sentence.node === "KRule" ? labelOf(sentence) : undefined))).toEqual([
      "SUM-1-TO-2",
      "SUM-2-TO-3",
    ]);
    for (const sentence of module.sentences) {
      expect(sentence.node).toBe("KRule");
      if (sentence.node !== "KRule") continue;
      expect(priorityOf(sentence)).toBe("40");
      expect(sentence.body.node).toBe("KApply"); // a rewrite pushed down into the cells
    }
    const rendered = stubPrint(module);
    expect(rendered.startsWith("module SUMMARY-ROUNDTRIP")).toBe(true);
    expect(rendered.endsWith("endmodule")).toBe(true);
    expect(rendered).toContain("=>");
  });

  test("a graph with no convertible successors yields an empty module", () => {
    const graph = new KCFG();
    graph.createNode(symbolic("X"));
    expect(kcfgToModule(graph).sentences).toHaveLength(0);
  });
});

describe("the forwarded kast helpers", () => {
  test("inlineCellMaps and minimizeRuleLike are kast's own functions, not copies", () => {
    // The pass-through is the point: one implementation, two import paths.
    expect(inlineCellMaps).toBe(kastInlineCellMaps);
    expect(minimizeRuleLike).toBe(kastMinimizeRuleLike);
  });

  test("inlineCellMaps replaces a cell-map item by its value cell (manip.py:401-418)", () => {
    const item = kapply("AccountCellMapItem", [kapply("<id>", [intToken(1)]), kapply("<account>", [intToken(9)])]);
    expect(stubPrint(inlineCellMaps(item))).toBe("<account>(9)");
    // The key must itself be a cell, or the item is left alone.
    expect(
      stubPrint(inlineCellMaps(kapply("AccountCellMapItem", [intToken(1), kapply("<account>", [intToken(9)])]))),
    ).toBe("AccountCellMapItem(1, <account>(9))");
  });

  test("simplifyConfig is inline_cell_maps then sort_ac_collections (kcfg.py:228-229)", () => {
    const config = kapply("<generatedTop>", [
      kapply("<accounts>", [
        kapply("AccountCellMapItem", [kapply("<id>", [intToken(1)]), kapply("<account>", [intToken(9)])]),
      ]),
    ]);
    expect(stubPrint(simplifyConfig(config))).toBe("<generatedTop>(<accounts>(<account>(9)))");
  });
});
