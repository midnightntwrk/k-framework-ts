/**
 * Behaviour the upstream unit suite does not reach: node classification over
 * every leaf kind, status composition, `prune`, `pathConstraints`, the rule and
 * claim derivations, and `fromClaim` on both proof kinds.
 *
 * The two `fromClaim` rows are checked against pyk's own output for the same
 * definition and claims; see `fixtures/pinned-pyk-proof.json`'s `from-claim`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { CTerm } from "@kframework-ts/cterm";
import {
  attEntry,
  Atts,
  KAtt,
  kapply,
  kclaim,
  kflatmodule,
  KDefinition,
  knonterminal,
  kproduction,
  krewrite,
  ksort,
  kterminal,
  kvariable,
  type KInner,
} from "@kframework-ts/kast";
import { andBool, TRUE } from "@kframework-ts/kast/prelude/kbool";
import { geInt, intToken, ltInt } from "@kframework-ts/kast/prelude/kint";
import { mlEqualsTrue, mlTop } from "@kframework-ts/kast/prelude/ml";
import { KCFG, NodeAttr } from "@kframework-ts/kcfg";

import {
  APRProof,
  composeStatus,
  EqualityProof,
  formatProofStatus,
  IMPLIES_SOUNDNESS_WARNING,
  ProofError,
  ProofStatus,
  RefutationProof,
  subproofsStatus,
} from "../src/index.ts";
import { proofDataExists, readProofData, readSubproofData, writeProofData } from "../src/store.ts";

import { equalityProof, nodeDicts } from "./helpers.ts";
import { caught, jsonObject, jsonObjectFile, jsonString, parseJson } from "./support.ts";

/** One string field of one case in `fixtures/pinned-pyk-proof.json`. */
function pinned(caseName: string, field: string): string {
  const bundle = jsonObjectFile(join(import.meta.dir, "..", "fixtures", "pinned-pyk-proof.json"));
  return jsonString(jsonObject(jsonObject(bundle["cases"])[caseName])[field]);
}

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kframework-ts-proof-behavior-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const x = kvariable("X", "Int");
const xGe0 = mlEqualsTrue(geInt(x, intToken(0)));
const xLt0 = mlEqualsTrue(ltInt(x, intToken(0)));

function state(term: KInner, constraints: readonly KInner[] = []): CTerm {
  return new CTerm(kapply("<top>", [term]), constraints);
}

describe("status composition", () => {
  test("admitted short-circuits before subproofs are consulted", () => {
    const failingSubproof = { status: ProofStatus.FAILED } as const;
    expect(composeStatus(true, ProofStatus.FAILED, [failingSubproof])).toBe(ProofStatus.PASSED);
    expect(composeStatus(false, ProofStatus.PASSED, [failingSubproof])).toBe(ProofStatus.FAILED);
  });

  test("subproofsStatus is PASSED for an empty collection, as `all([])` is", () => {
    expect(subproofsStatus([])).toBe(ProofStatus.PASSED);
    expect(subproofsStatus([{ status: ProofStatus.PENDING }])).toBe(ProofStatus.PENDING);
    expect(subproofsStatus([{ status: ProofStatus.PENDING }, { status: ProofStatus.FAILED }])).toBe(ProofStatus.FAILED);
  });

  test("statuses render the way Python interpolates the enum member", () => {
    expect(formatProofStatus(ProofStatus.PASSED)).toBe("ProofStatus.PASSED");
    expect(formatProofStatus(ProofStatus.PENDING)).toBe("ProofStatus.PENDING");
  });
});

describe("APRProof node classification", () => {
  /**
   * ```text
   *  1 --> 2 (target)
   *  1 --> 3 stuck        failing
   *  1 --> 4 vacuous      neither pending nor failing
   *  1 --> 5              pending
   *  1 --> 6              bounded
   *  1 --> 7              refuted
   * ```
   */
  function fanOut(): APRProof {
    const graph = new KCFG();
    graph.createNode(state(x));
    for (let i = 2; i <= 7; i += 1) graph.createNode(state(intToken(i)));
    graph.createNDBranch(1, [2, 3, 4, 5, 6, 7], ["r"]);
    graph.addAttr(3, NodeAttr.STUCK);
    graph.addAttr(4, NodeAttr.VACUOUS);
    const refutation = new RefutationProof("fan.node-infeasible-7", [], geInt(x, intToken(0)), {
      proofDir: scratch,
    });
    const proof = new APRProof("fan", graph, [], 1, 2, new Map(), {
      proofDir: scratch,
      subproofs: [refutation],
      subproofIds: ["fan.node-infeasible-7"],
      nodeRefutations: { 7: "fan.node-infeasible-7" },
    });
    proof.addBounded(6);
    return proof;
  }

  test("splits leaves into pending, failing, bounded, refuted, target and vacuous", () => {
    const proof = fanOut();
    expect(proof.pending.map((node) => node.id)).toEqual([5]);
    expect(proof.failing.map((node) => node.id)).toEqual([3]);
    expect(proof.bounded.map((node) => node.id)).toEqual([6]);
    expect(proof.isRefuted(7)).toBe(true);
    expect(proof.isTarget(2)).toBe(true);
    expect(proof.isInit(1)).toBe(true);
    // A vacuous leaf is neither pending nor failing — it is discharged.
    expect(proof.isPending(4)).toBe(false);
    expect(proof.isFailing(4)).toBe(false);
    expect(proof.ownStatus).toBe(ProofStatus.FAILED);
    expect(proof.canProgress).toBe(true);
  });

  test("a terminal leaf stops being explorable and starts failing", () => {
    const graph = KCFG.fromDict({ nodes: nodeDicts(2) });
    const proof = new APRProof("terminal", graph, [], 1, 1, new Map());
    expect(proof.pending.map((node) => node.id)).toEqual([2]);
    proof.addTerminal(2);
    expect(proof.pending).toEqual([]);
    expect(proof.failing.map((node) => node.id)).toEqual([2]);
    proof.removeTerminal(2);
    expect(proof.pending.map((node) => node.id)).toEqual([2]);
  });

  test("refutations must be declared as subproofs", () => {
    const graph = KCFG.fromDict({ nodes: nodeDicts(2) });
    expect(
      () =>
        new APRProof("bad", graph, [], 1, 1, new Map(), {
          proofDir: scratch,
          nodeRefutations: { 2: "nowhere" },
        }),
    ).toThrow(/All node refutations must be included in subproofs, violators are nowhere/u);
  });

  test("a refutation subproof must actually be a RefutationProof", () => {
    const graph = KCFG.fromDict({ nodes: nodeDicts(2) });
    const wrong = equalityProof(1, scratch);
    expect(
      () =>
        new APRProof("bad", graph, [], 1, 1, new Map(), {
          proofDir: scratch,
          subproofs: [wrong],
          subproofIds: [wrong.id],
          nodeRefutations: { 2: wrong.id },
        }),
    ).toThrow(/must be a RefutationProof/u);
  });

  test("subproofs without a proofDir, and undeclared subproofs, are errors", () => {
    const graph = KCFG.fromDict({ nodes: nodeDicts(1) });
    expect(() => new APRProof("no-dir", graph, [], 1, 1, new Map(), { subproofIds: ["x"] })).toThrow(ProofError);
    expect(() => new APRProof("gap", graph, [], 1, 1, new Map(), { proofDir: scratch, subproofIds: ["x"] })).toThrow(
      /declares subproofs that were not supplied/u,
    );
  });
});

describe("APRProof graph operations", () => {
  test("prune keeps init and target and scrubs the bounded set and loops cache", () => {
    const graph = KCFG.fromDict({ nodes: nodeDicts(5) });
    graph.createEdge(1, 3, 1);
    graph.createEdge(3, 4, 1);
    graph.createEdge(4, 5, 1);
    const proof = new APRProof("prune", graph, [], 1, 2, new Map());
    proof.addBounded(4);
    proof.priorLoopsCache = new Map([
      [4, [3]],
      [5, [3, 4]],
    ]);

    const pruned = proof.prune(3);

    expect([...pruned].toSorted((a, b) => a - b)).toEqual([3, 4, 5]);
    expect(proof.kcfg.nodes.map((node) => node.id)).toEqual([1, 2]);
    expect(proof.isBounded(1)).toBe(false);
    expect(proof.priorLoopsCache.size).toBe(0);
  });

  test("prune removes pruned ids from surviving loops-cache values", () => {
    const graph = KCFG.fromDict({ nodes: nodeDicts(4) });
    graph.createEdge(1, 3, 1);
    const proof = new APRProof("prune-values", graph, [], 1, 2, new Map());
    proof.priorLoopsCache = new Map([[4, [3, 1]]]);

    proof.prune(3);

    expect(proof.priorLoopsCache.get(4)).toEqual([1]);
  });

  test("pathConstraints accumulates split predicates and cover substitutions", () => {
    const graph = new KCFG();
    graph.createNode(state(x));
    graph.createNode(state(x, [xGe0]));
    graph.createNode(state(x, [xLt0]));
    graph.createSplitByNodes(1, [2, 3]);
    const proof = new APRProof("paths", graph, [], 1, 1, new Map());

    expect(proof.pathConstraints(2)).toEqual(xGe0);
    expect(proof.pathConstraints(3)).toEqual(xLt0);
    // The init node itself has an empty path, hence `#Top`.
    expect(proof.pathConstraints(1)).toEqual(mlTop());
  });

  test("shortestPathTo reports an unreachable node rather than returning nothing", () => {
    const graph = KCFG.fromDict({ nodes: nodeDicts(2) });
    const proof = new APRProof("unreachable", graph, [], 1, 1, new Map());
    expect(() => proof.shortestPathTo(2)).toThrow(ProofError);
  });

  test("minimizeKcfg collapses chains and keeps only surviving terminals", () => {
    const graph = KCFG.fromDict({ nodes: nodeDicts(3) });
    graph.createEdge(1, 2, 3, ["a"]);
    graph.createEdge(2, 3, 4, ["b"]);
    const proof = new APRProof("min", graph, [2, 3], 1, 3, new Map());
    proof.minimizeKcfg();
    expect(proof.kcfg.nodes.map((node) => node.id)).toEqual([1, 3]);
    expect([...proof.terminalIds]).toEqual([3]);
    expect(proof.kcfg.edge(1, 3)?.depth).toBe(7);
  });
});

describe("APRProof names, rules and claims", () => {
  test("names derive from the proof id", () => {
    const graph = KCFG.fromDict({ nodes: nodeDicts(2) });
    const proof = new APRProof("test%C.f(uint256):0", graph, [], 1, 2, new Map());
    expect(proof.ruleId).toBe("APRPROOF-TEST%C.F(UINT256):0");
    expect(proof.moduleName).toBe("M-TEST-C-F-UINT256-0");
    expect(proof.dependenciesModuleName).toBe("M-TEST-C-F-UINT256-0-DEPENDS-MODULE");
    expect(proof.circularitiesModuleName).toBe("M-TEST-C-F-UINT256-0-CIRCULARITIES-MODULE");
    expect(proof.getRefutationId(4)).toBe("test%C.f(uint256):0.node-infeasible-4");
  });

  test("asRule and asClaim name the synthetic init-to-target sentence", () => {
    const graph = KCFG.fromDict({ nodes: nodeDicts(2) });
    const proof = new APRProof("r", graph, [], 1, 2, new Map());
    expect(proof.asRule().att.get(Atts.LABEL)).toBe("APRPROOF-R-1-TO-2");
    expect(proof.asClaim().att.get(Atts.LABEL)).toBe("APRPROOF-R-1-TO-2");
    // pyk annotates `priority` as an int but stores the attribute text, so a
    // freshly built rule carries the string (`outer.ts` documents this).
    expect(proof.asRule(30).att.get(Atts.PRIORITY)).toBe("30");
  });

  test("asRules summarises a circularity and expands everything else", () => {
    const graph = KCFG.fromDict({ nodes: nodeDicts(3) });
    graph.createEdge(1, 3, 2, ["step"]);
    const plain = new APRProof("plain", graph, [], 1, 2, new Map());
    expect(plain.asRules().map((rule) => rule.att.get(Atts.LABEL))).toEqual(["APRPROOF-PLAIN-1-TO-3"]);

    const circular = new APRProof("circ", graph, [], 1, 2, new Map(), { circularity: true });
    expect(circular.asRules().map((rule) => rule.att.get(Atts.LABEL))).toEqual(["APRPROOF-CIRC-1-TO-2"]);

    // Admitted, and the target has no predecessors: one rule for the whole proof.
    const admitted = new APRProof("adm", graph, [], 1, 2, new Map(), { admitted: true });
    expect(admitted.asRules().map((rule) => rule.att.get(Atts.LABEL))).toEqual(["APRPROOF-ADM-1-TO-2"]);
  });
});

//////////////////////////
// from_claim           //
//////////////////////////

const INT = ksort("Int");

/** The definition `fixtures/generators/generate-pinned-pyk-proof.py` builds. */
const TINY_DEFINITION = new KDefinition("MAIN", [
  kflatmodule("MAIN", {
    sentences: [
      kproduction(INT, {
        items: [kterminal("f"), kterminal("("), knonterminal(INT), kterminal(")")],
        klabel: "f",
      }),
      kproduction(ksort("TopCell"), {
        items: [kterminal("<top>"), knonterminal(INT), kterminal("</top>")],
        klabel: "<top>",
        att: new KAtt([attEntry(Atts.CELL, null)]),
      }),
    ],
  }),
]);

describe("fromClaim", () => {
  test("EqualityProof.fromClaim matches pyk for the same claim", () => {
    const claim = kclaim(krewrite(kapply("f", [x]), x), {
      requires: andBool([geInt(x, intToken(0)), ltInt(x, intToken(10))]),
      ensures: TRUE,
      att: new KAtt([attEntry(Atts.LABEL, "MAIN.equality-claim")]),
    });
    const proof = EqualityProof.fromClaim(claim, TINY_DEFINITION);
    expect(proof.dict).toEqual(jsonObject(parseJson(pinned("from-claim", "equality_dict"))));
    expect(proof.id).toBe("MAIN.equality-claim");
    expect(proof.sort.name).toBe("Int");
    expect(proof.constraints).toHaveLength(2);
  });

  test("EqualityProof.fromClaim rejects a non-trivial ensures", () => {
    const claim = kclaim(krewrite(kapply("f", [x]), x), {
      requires: TRUE,
      ensures: geInt(x, intToken(0)),
      att: new KAtt([attEntry(Atts.LABEL, "MAIN.bad-claim")]),
    });
    expect(() => EqualityProof.fromClaim(claim, TINY_DEFINITION)).toThrow(/non-trival ensures clause/u);
  });

  test("APRProof.fromClaim matches pyk and carries the claim attributes", () => {
    const claim = kclaim(krewrite(kapply("<top>", [x]), kapply("<top>", [intToken(0)])), {
      requires: geInt(x, intToken(0)),
      ensures: ltInt(x, intToken(10)),
      att: new KAtt([
        attEntry(Atts.LABEL, "MAIN.apr-claim"),
        attEntry(Atts.CIRCULARITY, null),
        attEntry(Atts.TRUSTED, null),
      ]),
    });
    const proof = APRProof.fromClaim(TINY_DEFINITION, claim);
    expect(proof.dict).toEqual(jsonObject(parseJson(pinned("from-claim", "apr_dict"))));
    expect(proof.circularity).toBe(true);
    expect(proof.admitted).toBe(true);
    expect(proof.status).toBe(ProofStatus.PASSED);
  });
});

//////////////////////////
// implies family       //
//////////////////////////

describe("the implies family", () => {
  test("carries upstream's soundness caveat as a value", () => {
    expect(IMPLIES_SOUNDNESS_WARNING).toContain("haskell-backend/issues/3605");
  });

  test("own status walks pending, failed, then passed", () => {
    const proof = new RefutationProof("status", [], geInt(x, intToken(0)));
    expect(proof.ownStatus).toBe(ProofStatus.PENDING);
    expect(proof.canProgress).toBe(true);
    proof.simplifiedAntecedent = mlTop();
    expect(proof.ownStatus).toBe(ProofStatus.PENDING);
    proof.simplifiedConsequent = mlTop();
    expect(proof.ownStatus).toBe(ProofStatus.FAILED);
    expect(proof.canProgress).toBe(false);
    proof.admit();
    expect(proof.ownStatus).toBe(ProofStatus.PASSED);
  });

  test("RefutationProof.toClaim rebuilds a claim from the constraints", () => {
    const constraint = geInt(x, intToken(0));
    const proof = new RefutationProof("to-claim", [ltInt(x, intToken(10))], constraint);
    const [claim] = proof.toClaim("REFUTE-1");
    expect(claim.node).toBe("KClaim");
    expect(claim.att.get(Atts.LABEL)).toBe("REFUTE-1");
    expect(proof.lastConstraint).toEqual(constraint);
  });

  test("EqualityProof accessors re-derive from the consequent", () => {
    const proof = new EqualityProof("eq", intToken(1), intToken(2), INT, {
      constraints: [mlEqualsTrue(geInt(x, intToken(0)))],
    });
    expect(proof.lhsBody).toEqual(intToken(1));
    expect(proof.rhsBody).toEqual(intToken(2));
    expect(proof.sort.name).toBe("Int");
    expect(proof.constraints).toHaveLength(1);
    expect(proof.simplifiedConstraints).toBeUndefined();
  });
});

//////////////////////////
// store behaviour      //
//////////////////////////

describe("proof-data store", () => {
  test("APRProof.writeProofData does not recurse; the implies family does", async () => {
    const dir = join(scratch, "recursion");
    const equality = equalityProof(9, dir);
    const apr = new APRProof("apr-parent", KCFG.fromDict({ nodes: nodeDicts(1) }), [], 1, 1, new Map(), {
      proofDir: dir,
      subproofs: [equality],
      subproofIds: [equality.id],
    });
    await writeProofData(apr);
    expect(await proofDataExists(dir, "apr-parent")).toBe(true);
    // `reachability.py:618-650` never touches the subproofs.
    expect(await proofDataExists(dir, equality.id)).toBe(false);

    const refutation = new RefutationProof("implies-parent", [], geInt(x, intToken(0)), {
      proofDir: dir,
      subproofs: [equality],
      subproofIds: [equality.id],
    });
    await writeProofData(refutation);
    // `proof.py:261-264` via `implies.py:100-110` does.
    expect(await proofDataExists(dir, equality.id)).toBe(true);
  });

  test("reading a proof reads its subproof forest recursively", async () => {
    const dir = join(scratch, "forest");
    const leaf = equalityProof(1, dir);
    const middle = new APRProof("middle", KCFG.fromDict({ nodes: nodeDicts(1) }), [], 1, 1, new Map(), {
      proofDir: dir,
    });
    await writeProofData(leaf);
    await readSubproofData(middle, leaf.id);
    await writeProofData(middle);

    const root = new APRProof("root", KCFG.fromDict({ nodes: nodeDicts(1) }), [], 1, 1, new Map(), {
      proofDir: dir,
    });
    await readSubproofData(root, middle.id);
    await writeProofData(root);

    const restored = await readProofData(dir, "root");
    expect(restored.subproofIds).toEqual(["middle"]);
    expect(restored.subproofs[0]!.subproofIds).toEqual(["equality_proof_1"]);
  });

  test("a missing subproof is reported against the parent", async () => {
    const dir = join(scratch, "missing");
    const proof = new APRProof("orphan", KCFG.fromDict({ nodes: nodeDicts(1) }), [], 1, 1, new Map(), {
      proofDir: dir,
    });
    await writeProofData(proof);
    expect(String(await caught(() => readSubproofData(proof, "nope")))).toMatch(/Cannot find subproof nope/u);
  });

  test("a proof with no proofDir does not write", async () => {
    const proof = new APRProof("in-memory", KCFG.fromDict({ nodes: nodeDicts(1) }), [], 1, 1, new Map());
    await writeProofData(proof);
    expect(await proofDataExists(scratch, "in-memory")).toBe(false);
  });

  test("proof ids become directory names verbatim", async () => {
    const dir = join(scratch, "verbatim");
    const id = "test%Contract.f(uint256)_0";
    const proof = new APRProof(id, KCFG.fromDict({ nodes: nodeDicts(1) }), [], 1, 1, new Map(), { proofDir: dir });
    await writeProofData(proof);
    expect(await proofDataExists(dir, id)).toBe(true);
    expect((await readProofData(dir, id)).id).toBe(id);
  });
});
