/**
 * `APRProofShow` and `APRProofNodePrinter` (`proof/show.py`).
 *
 * # These goldens are self-generated
 *
 * pyk asserts on none of this — `show.py`'s output is only ever logged — so
 * `fixtures/golden/show/` was produced by this implementation, reviewed
 * against `show.py` line by line, and frozen. It pins regressions, not
 * upstream agreement; `fixtures/PROVENANCE.md` says so where a reader will
 * trip over it.
 *
 * What is *not* self-generated is the proof underneath the biggest golden:
 * `assert-test-test-assert-false` is a real APRProof a released Kontrol wrote,
 * vendored byte-for-byte. Rendering it exercises every branch of
 * `pretty_segments` against a graph nobody here designed.
 *
 * The printer is `stubPrint`, a structural stand-in for
 * `PrettyPrinter(definition).print`, which the seam makes possible. `show.py`
 * never inspects the printer's output, so nothing under test here needs a
 * kompiled definition. The live lane in `live-show.test.ts` is where a real
 * `KPrint` renders a real proof.
 */

import { CTermShow } from "@kframework-ts/cterm";
import type { KAst } from "@kframework-ts/kast";
import { KCFG } from "@kframework-ts/kcfg";
import { TRUE } from "@kframework-ts/kast/prelude/kbool";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { APRFailureInfo, APRProof, RefutationProof } from "../src/index.ts";
import { APRProofNodePrinter, APRProofShow, summaryModuleName } from "../src/show.ts";
import { readProofData } from "../src/store.ts";
import { asAprProof, parseJson } from "./support.ts";
import { node, nodeDicts, term } from "./helpers.ts";

const KONTROL = join(import.meta.dir, "..", "fixtures", "upstream", "kontrol");
const GOLDEN = join(import.meta.dir, "..", "fixtures", "golden", "show");

/** A structural stand-in for `PrettyPrinter.print`, over both inner and outer terms. */
function stubPrint(kast: KAst): string {
  if (!("node" in kast)) return JSON.stringify(kast);
  switch (kast.node) {
    case "KToken":
      return kast.token;
    case "KVariable":
      return kast.name;
    case "KApply":
      return kast.args.length === 0 ? kast.label.name : `${kast.label.name}(${kast.args.map(stubPrint).join(", ")})`;
    case "KSequence":
      return kast.items.length === 0 ? ".K" : kast.items.map(stubPrint).join(" ~> ");
    case "KRewrite":
      return `${stubPrint(kast.lhs)} => ${stubPrint(kast.rhs)}`;
    case "KRule":
      return `rule ${stubPrint(kast.body)}\n  requires ${stubPrint(kast.requires)}\n  ensures ${stubPrint(kast.ensures)}`;
    case "KFlatModule":
      return [`module ${kast.name}`, ...kast.sentences.map(stubPrint), "endmodule"].join("\n");
    default:
      return `<${kast.node}>`;
  }
}

const golden = async (name: string): Promise<string> => readFile(join(GOLDEN, name), "utf8");

/** `APRProofShow` over the stub printer, with the proof-aware node printer wired in. */
function showing(proof: APRProof, fullPrinter = false): APRProofShow {
  return new APRProofShow({
    prettyPrint: stubPrint,
    nodePrinter: new APRProofNodePrinter(proof, new CTermShow(stubPrint, { minimize: false }), { fullPrinter }),
  });
}

/**
 * A 1 → 2 → 3 chain plus an unreachable node 4, so init/target/pending/
 * terminal/bounded/refuted can each be set independently.
 */
function chain(): APRProof {
  const graph = KCFG.fromDict({
    nodes: nodeDicts(4),
    edges: [
      { source: 1, target: 2, depth: 1, rules: ["R1"] },
      { source: 2, target: 3, depth: 1, rules: ["R2"] },
    ],
  });
  return new APRProof("chain_proof", graph, [], 1, 3, new Map());
}

describe("APRProofNodePrinter.nodeAttrs (show.py:32-50)", () => {
  test("appends init, target, pending, refuted, terminal, bounded in pyk's order", () => {
    const proof = chain();
    const printer = new APRProofNodePrinter(proof, new CTermShow(stubPrint));
    // Node 4 is an unreached leaf root: pending, and a root and a leaf.
    expect(printer.nodeAttrs(proof.kcfg, proof.kcfg.node(1))).toEqual(["root", "init"]);
    expect(printer.nodeAttrs(proof.kcfg, proof.kcfg.node(3))).toEqual(["leaf", "target"]);
    expect(printer.nodeAttrs(proof.kcfg, proof.kcfg.node(4))).toEqual(["root", "leaf", "pending"]);
  });

  test("terminal removes stuck (show.py:42-45)", () => {
    const proof = chain();
    proof.kcfg.addStuck(4);
    const printer = new APRProofNodePrinter(proof, new CTermShow(stubPrint));
    expect(printer.nodeAttrs(proof.kcfg, proof.kcfg.node(4))).toEqual(["root", "stuck", "leaf"]);
    proof.addTerminal(4);
    expect(printer.nodeAttrs(proof.kcfg, proof.kcfg.node(4))).toEqual(["root", "leaf", "terminal"]);
  });

  test("bounded removes stuck (show.py:46-49)", () => {
    const proof = chain();
    proof.kcfg.addStuck(4);
    proof.addBounded(4);
    const printer = new APRProofNodePrinter(proof, new CTermShow(stubPrint));
    expect(printer.nodeAttrs(proof.kcfg, proof.kcfg.node(4))).toEqual(["root", "leaf", "bounded"]);
  });

  test("refuted is appended and does not suppress anything", () => {
    const proof = chain();
    proof.nodeRefutations.set(4, new RefutationProof("refutation_of_4", [], TRUE));
    const printer = new APRProofNodePrinter(proof, new CTermShow(stubPrint));
    // `refuted` also takes node 4 out of `pending` (`reachability.py:293`).
    expect(printer.nodeAttrs(proof.kcfg, proof.kcfg.node(4))).toEqual(["root", "leaf", "refuted"]);
  });

  test("fullPrinter prints the node's CTerm beneath its header", () => {
    const proof = chain();
    const printer = new APRProofNodePrinter(proof, new CTermShow(stubPrint, { minimize: false }), {
      fullPrinter: true,
    });
    expect(printer.printNode(proof.kcfg, proof.kcfg.node(1))).toEqual(["1 (root, init)", "  <top>(1)"]);
  });
});

describe("APRProofShow.prettySegments (show.py:59-65)", () => {
  test("appends a Target Node segment while nodes are pending", () => {
    const proof = chain();
    expect(proof.pending.length).toBeGreaterThan(0);
    const segments = showing(proof).prettySegments(proof);
    const last = segments[segments.length - 1];
    expect(last?.lines).toEqual(["", "Target Node:", "3 (leaf, target)"]);
    // The target already appeared in the graph, so this segment is suffixed.
    expect(last?.id).toBe("node_3_0");
  });

  test("omits the Target Node segment once nothing is pending", () => {
    const proof = chain();
    proof.kcfg.removeNode(4);
    expect(proof.pending).toEqual([]);
    expect(showing(proof).pretty(proof).join("\n")).not.toContain("Target Node:");
  });
});

describe("APRProofShow.show (show.py:70-88)", () => {
  test("names the module SUMMARY-<ID>, upper-cased with underscores hyphenated", () => {
    expect(summaryModuleName("chain_proof")).toBe("SUMMARY-CHAIN-PROOF");
    expect(summaryModuleName("test%AssertTest.setUp():0")).toBe("SUMMARY-TEST%ASSERTTEST.SETUP():0");
    const rendered = showing(chain()).show(chain(), { toModule: true }).join("\n");
    expect(rendered).toContain("module SUMMARY-CHAIN-PROOF");
  });

  test("an explicit moduleName wins", () => {
    expect(showing(chain()).show(chain(), { toModule: true, moduleName: "M" }).join("\n")).toContain("module M");
  });
});

/**
 * `showRules` is **beyond pyk** and this package's own reason for it: when a
 * proof fails, the first question is which rule fired on the edge into the
 * failing node. It is opt-in, because `APRFailureInfo.print` is pinned by an
 * upstream golden and every other surface here is a straight transcription —
 * see `src/show.ts`'s header.
 */
describe("APRProofShow showRules (beyond pyk)", () => {
  test("the chain proof's rule-annotated rendering is frozen", async () => {
    const proof = chain();
    expect(`${showing(proof).pretty(proof, { showRules: true }).join("\n")}\n`).toBe(
      await golden("chain-pretty-rules.txt"),
    );
  });

  test("off by default, so the transcribed rendering is untouched", () => {
    const proof = chain();
    const off = showing(proof).pretty(proof).join("\n");
    expect(off).not.toContain("rules:");
    expect(showing(proof).pretty(proof, { showRules: false }).join("\n")).toBe(off);
    expect(showing(proof).show(proof, { toModule: true }).join("\n")).not.toContain("rules:");
  });

  test("prettySegments and show both forward it, and the segment ids do not move", () => {
    const proof = chain();
    const segments = showing(proof).prettySegments(proof, { showRules: true });
    expect(segments.flatMap((segment) => [...segment.lines]).join("\n")).toContain("rules:");
    expect(segments.map((segment) => segment.id)).toEqual(
      showing(proof)
        .prettySegments(proof)
        .map((segment) => segment.id),
    );
    expect(showing(proof).show(proof, { showRules: true }).join("\n")).toContain("R1");
  });

  test("the failure report itself is untouched — it is pinned to pyk", () => {
    const info = new APRFailureInfo({
      failingNodes: [2],
      pendingNodes: [],
      pathConditions: { 2: "true" },
      failureReasons: { 2: "Matching failed." },
    });
    expect(info.print().join("\n")).not.toContain("rules:");
  });
});

describe("APRProofShow.dot (show.py:90-97)", () => {
  test("draws ??? from each pending node and false from each stuck node to the target", () => {
    const proof = chain();
    proof.kcfg.addStuck(4);
    // Stuck nodes are not pending, so the two edge families do not overlap.
    const dot = showing(proof).dot(proof);
    expect(dot).toContain(`"4" -> "3" [label=" false" class="target" style="solid"]`);
    expect(dot).not.toContain(`"4" -> "3" [label=" ???"`);

    const pendingOnly = chain();
    expect(showing(pendingOnly).dot(pendingOnly)).toContain(`"4" -> "3" [label=" ???" class="target" style="solid"]`);
  });
});

describe("APRProofShow.dump (show.py:99-111)", () => {
  test("writes <id>.json beside the KCFG dump", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kframework-ts-proof-show-"));
    const proof = chain();
    const show = showing(proof);
    await show.dump(proof, dir, { dot: true });

    expect((await readdir(dir)).toSorted()).toEqual([
      "chain_proof.dot",
      "chain_proof.json",
      "chain_proof_cfg.json",
      "covers",
      "edges",
      "nodes",
    ]);
    // `<id>.json` is `Proof.json` — the `dict` schema, not the proof-data one.
    expect(parseJson(await readFile(join(dir, "chain_proof.json"), "utf8"))).toEqual(parseJson(proof.json));
    // The DOT written is the *proof's*, target edges included.
    expect(await readFile(join(dir, "chain_proof.dot"), "utf8")).toBe(show.dot(proof));
    expect(await readFile(join(dir, "chain_proof.dot"), "utf8")).toContain(" ???");
    expect(parseJson(await readFile(join(dir, "chain_proof_cfg.json"), "utf8"))).toEqual(
      parseJson(proof.kcfg.toJson()),
    );
  });
});

describe("goldens over a real Kontrol proof", () => {
  const load = async (): Promise<APRProof> => asAprProof(await readProofData(KONTROL, "assert-test-test-assert-false"));

  test("pretty is frozen", async () => {
    const proof = await load();
    expect(`${showing(proof).pretty(proof).join("\n")}\n`).toBe(await golden("kontrol-pretty.txt"));
  });

  test("show with the SUMMARY module is frozen", async () => {
    const proof = await load();
    expect(`${showing(proof).show(proof, { toModule: true }).join("\n")}\n`).toBe(await golden("kontrol-show.txt"));
  });

  test("dot is frozen", async () => {
    const proof = await load();
    expect(`${showing(proof).dot(proof)}\n`).toBe(await golden("kontrol-graph.dot"));
  });

  test("the node attributes the proof adds are visible in the rendering", async () => {
    const proof = await load();
    const rendered = showing(proof).pretty(proof).join("\n");
    expect(rendered).toContain("init");
    expect(rendered).toContain("target");
    // `node` and `term` are the shared fixture vocabulary; naming them here
    // keeps this file's helper imports honest.
    expect(node(1).id).toBe(1);
    expect(term(1).config.node).toBe("KApply");
  });
});
