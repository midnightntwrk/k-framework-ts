import { CTerm } from "@kframework-ts/cterm";
import { intToken } from "@kframework-ts/kast/prelude/kint";
import { kapply, kvariable } from "@kframework-ts/kast";
import { describe, expect, test } from "bun:test";
import { KCFG, KCFGDictionaryError, edge } from "../src/index.ts";

const term = (value: number) => new CTerm(kapply("<top>", [intToken(value)]));

describe("KCFG structural dictionaries", () => {
  test("omits empty collections and round-trips deterministically", () => {
    const graph = new KCFG();
    expect(graph.toDict()).toEqual({ next: 1 });
    const first = graph.createNode(term(1));
    const second = graph.createNode(term(2));
    graph.createEdge(first.id, second.id, 2, ["rule"]);
    graph.addAlias("end", second.id);
    const dict = graph.toDict();
    expect(KCFG.fromJson(graph.toJson()).toDict()).toEqual(dict);
    expect(KCFG.fromDict(dict).toDict()).toEqual(dict);
  });

  test("rejects malformed and dangling structural documents", () => {
    expect(() => KCFG.fromDict({ next: 0 })).toThrow(KCFGDictionaryError);
    expect(() => KCFG.fromDict({ nodes: [], edges: [{ source: 1, target: 2, depth: 1, rules: [] }] })).toThrow(
      KCFGDictionaryError,
    );
    expect(() =>
      KCFG.fromDict({
        nodes: [
          { id: 1, cterm: term(1).toDict(), attrs: [] },
          { id: 2, cterm: term(2).toDict(), attrs: [] },
        ],
        edges: [{ source: 1, target: 2, depth: 0, rules: [] }],
      }),
    ).toThrow(KCFGDictionaryError);
  });

  test("rejects a persisted graph whose implicit next would be unsafe", () => {
    expect(() =>
      KCFG.fromDict({
        nodes: [{ id: Number.MAX_SAFE_INTEGER, cterm: CTerm.top().toDict(), attrs: [] }],
      }),
    ).toThrow();
  });

  test("sorts attributes and aliases without exposing mutable graph arrays", () => {
    const graph = new KCFG();
    const node = graph.createNode(new CTerm(kapply("<top>", [kvariable("X")])), ["z", "a"]);
    graph.addAlias("z", node.id);
    graph.addAlias("a", node.id);
    expect(node.toDict().attrs).toEqual(["a", "z"]);
    expect(graph.aliases(node.id)).toEqual(["a", "z"]);
    expect(Object.isFrozen(graph.nodes)).toBe(true);
  });

  test("round-trips all five successor dictionary shapes together", () => {
    const graph = new KCFG();
    const nodes = Array.from({ length: 14 }, (_, index) =>
      graph.createNode(index === 6 ? new CTerm(kapply("<top>", [kvariable("X")])) : term(index + 1)),
    );
    const at = (index: number) => nodes[index]!;
    graph.createEdge(at(0).id, at(1).id, 2, ["edge-rule"]);
    graph.createMergedEdge(at(2).id, at(3).id, [edge(at(12), at(13), 4, ["member-rule"])]);
    const coverTarget = graph.createNode(new CTerm(kapply("<top>", [kvariable("Y")])));
    graph.createCover(at(4).id, coverTarget.id);
    const splitSource = at(6);
    graph.createSplit(splitSource.id, [
      [at(7).id, splitSource.cterm.matchWithConstraint(at(7).cterm)!],
      [at(8).id, splitSource.cterm.matchWithConstraint(at(8).cterm)!],
    ]);
    graph.createNDBranch(at(9).id, [at(10).id, at(11).id], ["nd-rule"]);

    const dict = graph.toDict();
    expect(dict.edges).toHaveLength(1);
    expect(dict.merged_edges).toHaveLength(1);
    expect(dict.covers).toHaveLength(1);
    expect(dict.splits).toHaveLength(1);
    expect(dict.ndbranches).toHaveLength(1);
    expect(KCFG.fromDict(dict).toDict()).toEqual(dict);
  });
});
