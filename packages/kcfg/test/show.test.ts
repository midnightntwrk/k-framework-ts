/**
 * `KCFGShow` and `NodePrinter` (`kcfg/show.py`).
 *
 * # These goldens are self-generated
 *
 * pyk has **no** `show` goldens: `test_kcfg.py` never asserts on
 * `pretty_segments`, `show`, `to_module` or `dot` output, and `__main__.py`
 * only logs it. The four files in `fixtures/show/` were therefore produced by
 * this implementation, reviewed line by line against `show.py`, and frozen —
 * they pin regressions, not upstream agreement. `fixtures/PROVENANCE.md` says
 * the same thing where a reader will trip over it.
 *
 * The printer throughout is `stubPrint`, a structural stand-in. `show.py`
 * never inspects the printer's output — it splits and indents it — so nothing
 * about the layout under test depends on having a kompiled definition.
 */

import { CTerm } from "@kframework-ts/cterm";
import { Atts, kapply, kvariable } from "@kframework-ts/kast";
import { intToken } from "@kframework-ts/kast/prelude/kint";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CTermShow } from "@kframework-ts/cterm";

import { KCFG } from "../src/kcfg.ts";
import { edge } from "../src/successor.ts";
import {
  KCFGShow,
  NodePrinter,
  dotDocument,
  dotEdge,
  dotNode,
  kcfgToModule,
  kcfgToRules,
  type KCFGSegment,
} from "../src/show.ts";
import { chainGraph, concrete, csubst, gtInt, stubPrint, symbolic, wideGraph } from "./show-support.ts";

const golden = async (name: string): Promise<string> =>
  readFile(new URL(`../fixtures/show/${name}`, import.meta.url), "utf8");

const showing = (): KCFGShow => new KCFGShow({ prettyPrint: stubPrint });

describe("KCFGShow construction", () => {
  test("needs a definition or a printer", () => {
    expect(() => new KCFGShow()).toThrow(TypeError);
  });

  test("the default node printer is NodePrinter(CTermShow(print)) (show.py:79)", () => {
    const show = showing();
    expect(show.nodePrinter).toBeInstanceOf(NodePrinter);
    expect(show.nodePrinter.fullPrinter).toBe(false);
    expect(show.nodePrinter.ctermShow).toBeInstanceOf(CTermShow);
  });

  test("a printer-only KCFGShow refuses to hand out a definition", () => {
    expect(() => showing().definition).toThrow(TypeError);
  });
});

describe("NodePrinter (show.py:40-70)", () => {
  test("node_attrs order is root, stuck, vacuous, leaf, split, then sorted aliases", () => {
    const graph = new KCFG();
    const root = graph.createNode(symbolic("X"));
    const left = graph.createNode(concrete(1));
    const right = graph.createNode(concrete(2));
    graph.createSplitByNodes(root.id, [left.id, right.id]);
    graph.addStuck(left.id);
    graph.addVacuous(right.id);
    graph.addAlias("zeta", root.id);
    graph.addAlias("alpha", root.id);

    const printer = new NodePrinter(new CTermShow(stubPrint));
    expect(printer.nodeAttrs(graph, root)).toEqual(["root", "split", "@alpha", "@zeta"]);
    expect(printer.nodeAttrs(graph, left)).toEqual(["stuck", "leaf"]);
    expect(printer.nodeAttrs(graph, right)).toEqual(["vacuous", "leaf"]);
  });

  test("print_node is the header alone unless fullPrinter is set (show.py:49-55)", () => {
    const graph = new KCFG();
    const node = graph.createNode(symbolic("X", [gtInt("X", 0)]));
    const ctermShow = new CTermShow(stubPrint, { minimize: false });
    expect(new NodePrinter(ctermShow).printNode(graph, node)).toEqual(["1 (root, leaf)"]);
    expect(new NodePrinter(ctermShow, { fullPrinter: true }).printNode(graph, node)).toEqual([
      "1 (root, leaf)",
      "  <generatedTop>(<k>(X))",
      "  #And #Equals(true, _>Int_(X, 0))",
    ]);
  });
});

describe("KCFGShow.makeUniqueSegments (show.py:102-115)", () => {
  test("suffixes repeats with _0, _1, … and right-strips every line", () => {
    const segments: KCFGSegment[] = [
      { id: "node_1", lines: ["a   "] },
      { id: "node_1", lines: ["b\t"] },
      { id: "node_1", lines: ["c"] },
      { id: "node_1_0", lines: ["d"] },
    ];
    // The counter restarts at 0 for every segment, so the third `node_1` skips
    // the taken `node_1_0` and lands on `node_1_1` (`show.py:108-111`).
    expect(KCFGShow.makeUniqueSegments(segments)).toEqual([
      { id: "node_1", lines: ["a"] },
      { id: "node_1_0", lines: ["b"] },
      { id: "node_1_1", lines: ["c"] },
      { id: "node_1_0_0", lines: ["d"] },
    ]);
  });
});

describe("KCFGShow.hideCells / simplifyConfig", () => {
  test("hideCells is a no-op with no labels and replaces named applications otherwise", () => {
    const term = kapply("<generatedTop>", [kapply("<k>", [kvariable("X")]), kapply("<state>", [intToken(1)])]);
    expect(KCFGShow.hideCells(term, [])).toBe(term);
    expect(stubPrint(KCFGShow.hideCells(term, ["<state>"]))).toBe("<generatedTop>(<k>(X), ...)");
  });

  test("simplifyConfig inlines cell maps before hiding", () => {
    const term = kapply("<generatedTop>", [
      kapply("accountsCellMapItem", [kapply("<id>", [intToken(1)]), kapply("<account>", [intToken(9)])]),
    ]);
    expect(stubPrint(KCFGShow.simplifyConfig(term, []))).toBe("<generatedTop>(<account>(9))");
  });
});

describe("KCFGShow.prettySegments (show.py:117-290)", () => {
  test("the wide graph's segments are frozen", async () => {
    expect(`${JSON.stringify(showing().prettySegments(wideGraph()), null, 2)}\n`).toBe(
      await golden("wide-segments.json"),
    );
  });

  test("the wide graph's text rendering is frozen", async () => {
    expect(`${showing().pretty(wideGraph(), { minimize: false }).join("\n")}\n`).toBe(await golden("wide-pretty.txt"));
  });

  test("minimize collapses a non-empty cover substitution to `subst: ...` (show.py:144-145)", () => {
    const minimized = showing().pretty(wideGraph(), { minimize: true }).join("\n");
    const full = showing().pretty(wideGraph(), { minimize: false }).join("\n");
    expect(minimized).toContain("subst: ...");
    expect(minimized).not.toContain("Y <- 6");
    expect(full).toContain("Y <- 6");
  });

  test("segment ids name every successor kind and are unique", () => {
    const ids = showing()
      .prettySegments(wideGraph())
      .map((segment) => segment.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("edge_1_2");
    expect(ids).toContain("split_2_3");
    expect(ids).toContain("cover_6_2");
    expect(ids).toContain("ndbranch_4_7");
    expect(ids).toContain("merged_edge_9_10");
    // The re-visited node keeps `node_<id>` and is disambiguated, not renamed.
    expect(ids).toContain("node_2");
    expect(ids).toContain("node_2_0");
  });

  test("a node reachable only from a non-root lands under Remaining Nodes", () => {
    const graph = new KCFG();
    graph.createNode(concrete(1));
    const second = graph.createNode(concrete(2));
    const third = graph.createNode(concrete(3));
    graph.createEdge(second.id, third.id, 1);
    graph.createEdge(third.id, second.id, 1);
    // `first` is the only root; the 2↔3 cycle has none.
    expect(showing().pretty(graph).join("\n")).toBe(
      ["", "┌─ 1 (root, leaf)", "", "Remaining Nodes:", "", "2", "", "3"].join("\n"),
    );
  });

  test("a revisited non-leaf node prints `(continues as previously)`", () => {
    const graph = new KCFG();
    const root = graph.createNode(symbolic("X"));
    const left = graph.createNode(concrete(1));
    const right = graph.createNode(concrete(2));
    const middle = graph.createNode(concrete(3));
    const tail = graph.createNode(concrete(4));
    graph.createSplitByNodes(root.id, [left.id, right.id]);
    graph.createEdge(left.id, middle.id, 1);
    graph.createEdge(right.id, middle.id, 1);
    graph.createEdge(middle.id, tail.id, 1);
    expect(showing().pretty(graph).join("\n")).toContain("(continues as previously)");
  });

  test("a single-step edge is `(1 step)`, not `(1 steps)` (show.py:160-164)", () => {
    const graph = new KCFG();
    const source = graph.createNode(concrete(1));
    const target = graph.createNode(concrete(2));
    graph.createEdge(source.id, target.id, 1);
    expect(showing().pretty(graph).join("\n")).toContain("(1 step)");
  });

  test("an over-wide merged edge degrades to `(merged edge)` (show.py:166-171)", () => {
    const graph = new KCFG();
    const source = graph.createNode(concrete(1));
    const target = graph.createNode(concrete(2));
    // 40 members put the joined `d1|d2|…` string past `show.py:171`'s 78 chars.
    const members = Array.from({ length: 40 }, (_unused, index) => edge(source, target, index + 1));
    graph.createMergedEdge(source.id, target.id, members);
    expect(showing().pretty(graph).join("\n")).toContain("(merged edge)");
  });
});

/**
 * `showRules` is **beyond pyk** — `KCFGShow` prints `(N steps)` and never a
 * rule label. These tests pin the new output and, just as importantly, that
 * it is absent unless asked for: the goldens above are the parity contract.
 */
describe("KCFGShow showRules (beyond pyk)", () => {
  test("the wide graph's rule-annotated rendering is frozen", async () => {
    expect(`${showing().pretty(wideGraph(), { minimize: false, showRules: true }).join("\n")}\n`).toBe(
      await golden("wide-pretty-rules.txt"),
    );
  });

  test("the default is off, and the default output is byte-identical to pyk's shape", () => {
    const off = showing().pretty(wideGraph(), { minimize: false }).join("\n");
    expect(showing().pretty(wideGraph(), { minimize: false, showRules: false }).join("\n")).toBe(off);
    expect(off).not.toContain("rules:");
    expect(showing().show(wideGraph()).join("\n")).not.toContain("rules:");
  });

  test("an edge names the rules it fired, in `_multi_line_print` shape", () => {
    const lines = showing().pretty(chainGraph(), { showRules: true }).join("\n");
    expect(lines).toContain("│  (4 steps)");
    expect(lines).toContain("│  rules:");
    expect(lines).toContain("│      RULE-E");
  });

  test("an edge with no rule ids says `unknown` rather than dropping the line", () => {
    const graph = new KCFG();
    const source = graph.createNode(concrete(1));
    const target = graph.createNode(concrete(2));
    graph.createEdge(source.id, target.id, 1);
    expect(showing().pretty(graph, { showRules: true }).join("\n")).toContain("│  rules: unknown");
  });

  test("a merged edge concatenates its members' rules, in member order and undeduplicated", () => {
    const graph = new KCFG();
    const source = graph.createNode(concrete(1));
    const target = graph.createNode(concrete(2));
    graph.createMergedEdge(source.id, target.id, [
      edge(source, target, 3, ["RULE-D", "RULE-D"]),
      edge(source, target, 5, ["RULE-D2"]),
    ]);
    const lines = showing().pretty(graph, { showRules: true }).join("\n");
    expect(lines).toContain("│  (3|5 steps)");
    expect(lines.split("\n").filter((line) => line.endsWith("RULE-D"))).toHaveLength(2);
    expect(lines.indexOf("RULE-D2")).toBeGreaterThan(lines.indexOf("RULE-D"));
  });

  test("an ndbranch names its rules; a split and a cover have none to name", () => {
    const lines = showing().pretty(wideGraph(), { showRules: true }).join("\n");
    expect(lines).toContain("┃ (1 step)");
    expect(lines).toContain("┃ rules:");
    expect(lines).toContain("┃     RULE-C");
    // The split's own header is `(branch)`, and nothing follows it.
    expect(lines).toContain("┃ (branch)\n┣━━┓");
    // The cover prints constraint/subst only.
    expect(lines).not.toContain("┊  rules:");
  });

  test("show() forwards showRules to pretty()", () => {
    expect(showing().show(chainGraph(), { showRules: true }).join("\n")).toContain("rules:");
  });

  test("segment ids are unchanged by showRules", () => {
    const off = showing()
      .prettySegments(wideGraph())
      .map((segment) => segment.id);
    const on = showing()
      .prettySegments(wideGraph(), { showRules: true })
      .map((segment) => segment.id);
    expect(on).toEqual(off);
  });
});

describe("KCFGShow.toModule (show.py:299-317)", () => {
  test("one rule per edge, labelled BASIC-BLOCK-<src>-TO-<tgt> (kcfg.py:713-723)", () => {
    const module = kcfgToModule(chainGraph(), { moduleName: "SUMMARY-TEST" });
    expect(module.name).toBe("SUMMARY-TEST");
    expect(module.sentences).toHaveLength(1);
    const [rule] = module.sentences;
    expect(rule?.node).toBe("KRule");
    expect(rule?.node === "KRule" ? rule.att.get(Atts.LABEL) : undefined).toBe("BASIC-BLOCK-1-TO-2");
  });

  test("the default module name is KCFG (kcfg.py:732)", () => {
    expect(kcfgToModule(chainGraph()).name).toBe("KCFG");
    expect(kcfgToRules(chainGraph())).toHaveLength(1);
  });

  test("omitCells reaches the rule body", () => {
    const module = showing().toModule(chainGraph(), { moduleName: "M", omitCells: ["<k>"] });
    expect(stubPrint(module)).toContain("...");
  });

  test("parseableOutput false keeps generated cells", () => {
    const graph = new KCFG();
    const source = graph.createNode(new CTerm(kapply("<generatedTop>", [kapply("<generatedCounter>", [intToken(0)])])));
    const target = graph.createNode(new CTerm(kapply("<generatedTop>", [kapply("<generatedCounter>", [intToken(1)])])));
    graph.createEdge(source.id, target.id, 1);
    const kept = stubPrint(showing().toModule(graph, { parseableOutput: false }));
    expect(kept).toContain("<generatedCounter>");
  });
});

describe("KCFGShow.show (show.py:319-370)", () => {
  test("the chain graph's rendering with its SUMMARY module is frozen", async () => {
    expect(`${showing().show(chainGraph(), { toModule: true, moduleName: "SUMMARY-TEST" }).join("\n")}\n`).toBe(
      await golden("chain-show.txt"),
    );
  });

  test("printing no nodes appends three blank lines, printing one appends two (show.py:361-364)", () => {
    const bare = showing().show(chainGraph());
    expect(bare.slice(-3)).toEqual(["", "", ""]);
    const withNode = showing().show(chainGraph(), { nodes: [1] });
    expect(withNode.slice(-2)).toEqual(["", ""]);
    expect(withNode).toContain("Node 1:");
  });

  test("node deltas print the pushed-down rewrite between two configurations", () => {
    const lines = showing().show(chainGraph(), { nodeDeltas: [[1, 2]] });
    expect(lines).toContain("State Delta 1 => 2:");
    expect(lines.join("\n")).toContain("X => 2");
  });
});

describe("KCFGShow.dot (show.py:372-414)", () => {
  test("the wide graph's DOT document is frozen", async () => {
    expect(`${showing().dot(wideGraph())}\n`).toBe(await golden("wide-graph.dot"));
  });

  test("every edge kind carries pyk's label text", () => {
    const dot = showing().dot(wideGraph());
    // pyk labels every edge `{depth} steps`, including depth 1 (`show.py:391`).
    expect(dot).toContain(`"3" -> "6" [label="  1 steps        "]`);
    expect(dot).toContain(`class="abstraction" style="dashed"`);
    expect(dot).toContain(`"4" -> "7" [label="  1 step        "]`);
  });

  test("a node with no attributes carries no class", () => {
    expect(showing().dot(wideGraph())).toContain(`"3" [label="3"]\n`);
  });

  test("labels longer than 100 characters are clipped per line (show.py:373-379)", () => {
    const graph = new KCFG();
    const covered = graph.createNode(concrete(1));
    const pattern = graph.createNode(symbolic("X"));
    graph.createCover(covered.id, pattern.id, csubst({ X: kapply("f".repeat(160)) }));
    expect(showing().dot(graph)).toContain(" ...");
  });

  test("the emitter always quotes and escapes", () => {
    expect(dotNode("1", 'a "quoted"\nsecond', { class: "root" })).toBe(
      `"1" [label="a \\"quoted\\"\\nsecond" class="root"]`,
    );
    expect(dotEdge("1", "2", "x", { style: "solid", class: "target" })).toBe(
      `"1" -> "2" [label="x" class="target" style="solid"]`,
    );
    expect(dotDocument(["a", "b"])).toBe("digraph {\n\ta\n\tb\n}");
  });
});

describe("KCFGShow.dump (show.py:416-479)", () => {
  test("writes the graph, its nodes, edges and covers, and never overwrites a per-artifact file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kframework-ts-kcfg-dump-"));
    const show = new KCFGShow({ prettyPrint: stubPrint });
    const graph = wideGraph();
    await show.dump("cfg", graph, dir, { dot: true });

    expect((await readdir(dir)).toSorted()).toEqual(["cfg.dot", "cfg.json", "covers", "edges", "nodes"]);
    expect(JSON.parse(await readFile(join(dir, "cfg.json"), "utf8"))).toEqual(JSON.parse(graph.toJson()));
    expect(await readFile(join(dir, "cfg.dot"), "utf8")).toBe(show.dot(graph));
    expect((await readdir(join(dir, "nodes"))).length).toBe(3 * graph.nodes.length);
    expect((await readdir(join(dir, "edges"))).toSorted()).toEqual([
      "config_1_2.txt",
      "config_3_6.txt",
      "config_minimized_1_2.txt",
      "config_minimized_3_6.txt",
    ]);
    expect((await readdir(join(dir, "covers"))).toSorted()).toEqual(["config_6_2.txt", "constraint_6_2.txt"]);

    // `if not node_file.exists()` throughout: a second dump leaves them alone.
    await writeFile(join(dir, "nodes", "config_1.txt"), "SENTINEL");
    await show.dump("cfg", graph, dir, { dot: false });
    expect(await readFile(join(dir, "nodes", "config_1.txt"), "utf8")).toBe("SENTINEL");
  });

  test("a printer-only instance still dumps covers, with the predicate left unsorted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kframework-ts-kcfg-dump-"));
    const graph = new KCFG();
    const covered = graph.createNode(concrete(1));
    const pattern = graph.createNode(symbolic("X"));
    graph.createCover(covered.id, pattern.id, csubst({ X: intToken(1) }));
    // `cover.csubst.pred(sort_with=self.pretty_printer.definition)` (`show.py:471`)
    // degrades to `pred()` rather than refusing.
    await showing().dump("cfg", graph, dir);
    expect(await readFile(join(dir, "covers", "config_1_2.txt"), "utf8")).toBe("#Equals(X, 1)");
  });
});
