import { CTerm } from "@kframework-ts/cterm";
import { kapply, kvariable } from "@kframework-ts/kast";
import { describe, expect, test } from "bun:test";

import { DefaultKCFGSemantics, KCFGExploration, KCFGExplorationNodeAttr } from "../src/explore.ts";
import { KCFG } from "../src/index.ts";

const term = (name: string) => new CTerm(kapply("<top>", [kvariable(name)]));

describe("KCFGExploration", () => {
  test("is publicly exported by the exploration entry point", () => {
    expect(new DefaultKCFGSemantics().isTerminal(term("A"))).toBe(false);
  });

  test("keeps terminal state as an explicit graph attribute", () => {
    const graph = new KCFG();
    const first = graph.createNode(term("A"));
    const second = graph.createNode(term("B"));
    graph.createEdge(first.id, second.id, 1);
    const exploration = new KCFGExploration(graph, [second.id]);

    expect(exploration.isTerminal(second.id)).toBe(true);
    expect(graph.node(second.id).hasAttr(KCFGExplorationNodeAttr.TERMINAL)).toBe(true);
    expect(exploration.explorable).toEqual([]);
    exploration.removeTerminal(second.id);
    expect(exploration.explorable.map((node) => node.id)).toEqual([second.id]);
    expect(KCFGExploration.fromDict(exploration.toDict()).terminalIds).toEqual(new Set());
  });
});
