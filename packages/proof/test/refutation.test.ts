/**
 * Node refutations: the split walk, the four refusals, and the disk round trip.
 *
 * `pyk/src/tests/integration/proof/test_refute_node.py` is the upstream oracle
 * and needs a backend to build its graphs; the graphs are built by hand here so
 * every branch of `construct_node_refutation` (`reachability.py:672-713`) is
 * reachable without one. The live port of that suite — including the exact
 * `RefutationProof.to_claim` golden — is in `test/live-k.test.ts`.
 */

import { CTerm } from "@kframework-ts/cterm";
import { freeVars, kapply, kvariable, type KInner } from "@kframework-ts/kast";
import { addInt, intToken, leInt } from "@kframework-ts/kast/prelude/kint";
import { FALSE } from "@kframework-ts/kast/prelude/kbool";
import { mlEqualsTrue } from "@kframework-ts/kast/prelude/ml";
import { KCFG } from "@kframework-ts/kcfg";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { APRProof, ProofStatus, RefutationProof } from "../src/index.ts";
import { proofDataExists, readProofData, refuteNode, unrefuteNode, writeProofData } from "../src/store.ts";
import { asAprProof, asRefutationProof, caught } from "./support.ts";

//////////////////////////
// Fixtures             //
//////////////////////////

const L = kvariable("L");
const M = kvariable("M");
const N = kvariable("N");

const config = (term: KInner): KInner => kapply("<generatedTop>", [kapply("<k>", [term])]);

/** `L +Int N <=Int 0` — shares `N` with the branch predicate below. */
const RELEVANT = mlEqualsTrue(leInt(addInt(L, N), intToken(0)));
/** `M <=Int 0` — shares nothing, so the refutation must not carry it. */
const USELESS = mlEqualsTrue(leInt(M, intToken(0)));
/** The predicate the first branch of the split adds. */
const BRANCH = mlEqualsTrue(leInt(N, intToken(0)));
const OTHER_BRANCH = mlEqualsTrue(leInt(intToken(0), N));

/**
 * `init` splits two ways; the first branch runs one step to a stuck leaf.
 *
 * ```text
 *  init --split--> branchA --edge--> leaf (stuck)
 *              \-> branchB
 * ```
 */
function splitProof(proofDir?: string): { readonly proof: APRProof; readonly leaf: number; readonly branchB: number } {
  const graph = new KCFG();
  const init = graph.createNode(new CTerm(config(N), [RELEVANT, USELESS]));
  const target = graph.createNode(new CTerm(config(kvariable("Z"))));
  const [branchA, branchB] = graph.splitOnConstraints(init.id, [BRANCH, OTHER_BRANCH]);
  const leaf = graph.createNode(new CTerm(config(kapply("stuck"))));
  graph.createEdge(branchA!, leaf.id, 1, ["r"]);
  graph.addStuck(leaf.id);
  const proof = new APRProof(
    "split.proof",
    graph,
    [],
    init.id,
    target.id,
    new Map(),
    proofDir === undefined ? {} : { proofDir },
  );
  return { proof, leaf: leaf.id, branchB: branchB! };
}

//////////////////////////
// The pure construction//
//////////////////////////

describe("APRProof.constructNodeRefutation", () => {
  test("turns the closest split's predicate into a refutation goal, pruning useless constraints", () => {
    const { proof, leaf } = splitProof();
    expect(proof.failing.map((node) => node.id)).toEqual([leaf]);

    const refutation = proof.constructNodeRefutation(leaf);
    expect(refutation).toBeInstanceOf(RefutationProof);
    const built = asRefutationProof(refutation!);

    expect(built.id).toBe("split.proof.node-infeasible-" + String(leaf));
    // `last_constraint` is the branch predicate as a *boolean*, not an ML one.
    expect(built.lastConstraint).toEqual(leInt(N, intToken(0)));
    // `M <=Int 0` shares no variable with it and is dropped
    // (`reachability.py:697-701`); `L +Int N <=Int 0` survives.
    expect(built.preConstraints).toHaveLength(1);
    expect([...freeVars(built.preConstraints[0]!)].toSorted()).toEqual(["L", "N"]);

    // The construction registers the subproof but records no node refutation:
    // that is `refuteNode`'s job, after the refutation is on disk.
    expect(proof.subproofIds).toEqual([built.id]);
    expect(proof.isRefuted(leaf)).toBe(false);
  });

  test("to_claim states the branch predicate rewriting to false under the pre-constraints", () => {
    const { proof, leaf } = splitProof();
    const refutation = asRefutationProof(proof.constructNodeRefutation(leaf)!);
    const [claim] = refutation.toClaim("refute-node-claim");

    expect(claim.body.node).toBe("KRewrite");
    if (claim.body.node === "KRewrite") {
      expect(claim.body.lhs).toEqual(refutation.lastConstraint);
      expect(claim.body.rhs).toEqual(FALSE);
    }
    // `build_claim` renames a variable that appears only in `requires` to the
    // `_`-prefixed spelling K's frontend wants — upstream's own golden for this
    // claim is `_L +Int N <=Int 0` (`test_refute_node.py:294-296`).
    expect([...freeVars(claim.requires)].toSorted()).toEqual(["N", "_L"]);
  });

  test("refuses a node that already has successors", () => {
    const { proof } = splitProof();
    expect(proof.constructNodeRefutation(proof.init)).toBeUndefined();
    expect(proof.subproofIds).toEqual([]);
  });

  test("refuses a linear path — no branch introduced a condition", () => {
    const graph = new KCFG();
    const init = graph.createNode(new CTerm(config(N)));
    const leaf = graph.createNode(new CTerm(config(kapply("stuck"))));
    const target = graph.createNode(new CTerm(config(kvariable("Z"))));
    graph.createEdge(init.id, leaf.id, 1, ["r"]);
    const proof = new APRProof("linear", graph, [], init.id, target.id);
    expect(proof.constructNodeRefutation(leaf.id)).toBeUndefined();
  });

  test("refuses a non-deterministic branch as not yet implemented upstream", () => {
    const graph = new KCFG();
    const init = graph.createNode(new CTerm(config(N)));
    const a = graph.createNode(new CTerm(config(kapply("a"))));
    const b = graph.createNode(new CTerm(config(kapply("b"))));
    const target = graph.createNode(new CTerm(config(kvariable("Z"))));
    graph.createNDBranch(init.id, [a.id, b.id], ["r"]);
    const proof = new APRProof("ndbranch", graph, [], init.id, target.id);
    expect(proof.constructNodeRefutation(a.id)).toBeUndefined();
  });

  test("refuses a split whose substitution is not the identity", () => {
    const graph = new KCFG();
    // Splitting a variable into two concrete values makes each branch's csubst
    // carry `N |-> value`, which `construct_node_refutation` rejects because
    // the branch predicate alone does not describe the branch.
    const init = graph.createNode(new CTerm(config(N)));
    const a = graph.createNode(new CTerm(config(intToken(0))));
    const b = graph.createNode(new CTerm(config(intToken(1))));
    const target = graph.createNode(new CTerm(config(kvariable("Z"))));
    graph.createSplit(
      init.id,
      [a, b].map((branch) => [branch.id, init.cterm.matchWithConstraint(branch.cterm)!] as const),
    );
    expect(init.cterm.matchWithConstraint(a.cterm)?.subst.isIdentity).toBe(false);

    const proof = new APRProof("nonidentity", graph, [], init.id, target.id);
    expect(proof.constructNodeRefutation(a.id)).toBeUndefined();
  });

  test("more than one path to the node is an error, as `single` is upstream", () => {
    const { proof, leaf, branchB } = splitProof();
    proof.kcfg.createEdge(branchB, leaf, 1, ["r2"]);
    expect(() => proof.constructNodeRefutation(leaf)).toThrow(/Expected exactly one path/u);
  });
});

//////////////////////////
// refuteNode on disk   //
//////////////////////////

describe("refuteNode / unrefuteNode", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kframework-ts-proof-refute-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes the refutation first, then the parent naming it", async () => {
    const { proof, leaf } = splitProof(dir);
    expect(proof.status).toBe(ProofStatus.FAILED);

    const refutation = await refuteNode(proof, proof.kcfg.node(leaf));
    expect(refutation).toBeInstanceOf(RefutationProof);
    const refutationId = proof.getRefutationId(leaf);
    expect(await proofDataExists(dir, refutationId)).toBe(true);
    expect(await proofDataExists(dir, proof.id)).toBe(true);

    // A refuted node stops counting as failing; the outstanding refutation is
    // what now holds the proof back.
    expect(proof.isRefuted(leaf)).toBe(true);
    expect(proof.failing).toHaveLength(0);
    expect(proof.status).toBe(ProofStatus.PENDING);

    // The parent's proof.json names it, and reading the directory rebuilds the
    // map — `read_proof_data` does what `from_dict` does not.
    const reloaded = asAprProof(await readProofData(dir, proof.id));
    expect(reloaded.nodeRefutations.size).toBe(1);
    expect(reloaded.nodeRefutations.get(leaf)?.id).toBe(refutationId);
    expect(reloaded.isRefuted(leaf)).toBe(true);
    expect(reloaded.subproofIds).toEqual([refutationId]);
  });

  test("a failed refutation leaves the parent failed", async () => {
    const { proof, leaf } = splitProof(dir);
    const refutation = asRefutationProof((await refuteNode(proof, leaf))!);
    // The implication did not hold: the branch condition is satisfiable.
    refutation.commit({
      csubst: undefined,
      simplifiedAntecedent: refutation.antecedent,
      simplifiedConsequent: refutation.consequent,
    });
    expect(refutation.status).toBe(ProofStatus.FAILED);
    expect(proof.status).toBe(ProofStatus.FAILED);
  });

  test("unrefuting drops both records and rewrites the parent", async () => {
    const { proof, leaf } = splitProof(dir);
    await refuteNode(proof, leaf);
    await unrefuteNode(proof, leaf);

    expect(proof.isRefuted(leaf)).toBe(false);
    expect(proof.subproofIds).toEqual([]);
    expect(proof.status).toBe(ProofStatus.FAILED);

    // The refutation's own directory is deliberately left behind, exactly as
    // upstream leaves it; the parent simply stops naming it.
    expect(await proofDataExists(dir, proof.getRefutationId(leaf))).toBe(true);
    const reloaded = asAprProof(await readProofData(dir, proof.id));
    expect(reloaded.nodeRefutations.size).toBe(0);

    // Unrefuting twice is an error, as `remove_subproof` is upstream.
    expect(await caught(() => unrefuteNode(proof, leaf))).toBeInstanceOf(Error);
  });

  test("a refusal writes nothing", async () => {
    const { proof } = splitProof(dir);
    await writeProofData(proof);
    expect(await refuteNode(proof, proof.init)).toBeUndefined();
    expect(proof.subproofIds).toEqual([]);
    const reloaded = asAprProof(await readProofData(dir, proof.id));
    expect(reloaded.nodeRefutations.size).toBe(0);
  });
});
