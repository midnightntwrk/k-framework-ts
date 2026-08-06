/**
 * `pyk/src/tests/unit/test_proof.py`, ported whole.
 *
 * Every `test_*` upstream has a counterpart here under the same name. The only
 * mechanical changes are the ones the port forces: disk access is `await`ed,
 * `Proof.read_proof_data` is `readProofData` from the `./store` subpath, and
 * `read_subproof_data` is the free function `readSubproofData` (see
 * `src/proof.ts` for why subproof reads left the constructor).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { intToken } from "@kframework-ts/kast/prelude/kint";
import { BOOL } from "@kframework-ts/kast/prelude/kbool";
import { KCFG, KCFGNodeAttr } from "@kframework-ts/kcfg";
import { KCFGExplorationNodeAttr } from "@kframework-ts/kcfg/explore";

import {
  APRFailureInfo,
  APRProof,
  APRSummary,
  CompositeSummary,
  EqualityProof,
  EqualitySummary,
  ProofStatus,
} from "../src/index.ts";
import { readProofData, readSubproofData, writeProofData } from "../src/store.ts";

import { aprProof, equalityProof, minimizationTestKcfg, node, nodeDicts } from "./helpers.ts";
import { asAprProof, asCompositeSummary } from "./support.ts";

let proofDir: string;

beforeEach(async () => {
  // `proof_dir` (`test_proof.py:26-28`) — function-scoped, so every row starts
  // from an empty directory.
  proofDir = await mkdtemp(join(tmpdir(), "kframework-ts-proofs-"));
});

afterEach(async () => {
  await rm(proofDir, { recursive: true, force: true });
});

describe("TestProof", () => {
  test("test_read_proof_apr", async () => {
    const sampleProof = new APRProof(
      "apr_proof_1",
      KCFG.fromDict({ nodes: nodeDicts(1) }),
      [],
      node(1).id,
      node(1).id,
      new Map(),
      { proofDir },
    );

    expect(sampleProof.proofDir).toBeDefined();
    await writeProofData(sampleProof);

    const proofFromDisk = await readProofData(proofDir, sampleProof.id);

    expect(proofFromDisk).toBeInstanceOf(APRProof);
    expect(proofFromDisk.dict).toEqual(sampleProof.dict);
  });

  test("test_read_proof_with_attributes", async () => {
    const kcfg = KCFG.fromDict({ nodes: nodeDicts(3) });
    kcfg.addAttr(1, KCFGNodeAttr.VACUOUS);
    kcfg.addAttr(2, KCFGExplorationNodeAttr.TERMINAL);
    const sampleProof = new APRProof("apr_proof_1", kcfg, [], node(1).id, node(3).id, new Map(), { proofDir });

    expect(sampleProof.proofDir).toBeDefined();
    await writeProofData(sampleProof);

    const proofFromDisk = await readProofData(proofDir, sampleProof.id);

    expect(proofFromDisk).toBeInstanceOf(APRProof);
    // `set(sample_proof.kcfg.nodes) == set(proof_from_disk.kcfg.nodes)`: the
    // `terminal` attr survives via `proof.json`, `vacuous` via the store index.
    expect(asAprProof(proofFromDisk).kcfg.toDict()).toEqual(sampleProof.kcfg.toDict());
  });

  test("test_read_proof_aprbmc", async () => {
    const sampleProof = new APRProof(
      "aprbmc_proof_1",
      KCFG.fromDict({ nodes: nodeDicts(1) }),
      [],
      node(1).id,
      node(1).id,
      new Map(),
      { proofDir, bmcDepth: 1 },
    );

    await writeProofData(sampleProof);
    const proofFromDisk = await readProofData(proofDir, sampleProof.id);

    expect(proofFromDisk).toBeInstanceOf(APRProof);
    expect(proofFromDisk.dict).toEqual(sampleProof.dict);
  });

  test("test_read_proof_equality", async () => {
    const sampleProof = new EqualityProof("equality_proof_1", intToken(1), intToken(1), BOOL, { proofDir });

    await writeProofData(sampleProof);
    const proofFromDisk = await readProofData(proofDir, sampleProof.id);

    expect(proofFromDisk).toBeInstanceOf(EqualityProof);
    expect(proofFromDisk.dict).toEqual(sampleProof.dict);
  });
});

describe("APRProof", () => {
  test("test_read_write_proof_data", async () => {
    // Upstream binds the store directory into the `KCFG` constructor; here the
    // layout is the store's business, so the graph is plain.
    const kcfg = new KCFG();
    const node1 = kcfg.createNode(node(1).cterm);
    const node2 = kcfg.createNode(node(2).cterm);
    kcfg.createNode(node(3).cterm);
    kcfg.createNode(node(4).cterm);

    const proof = new APRProof("apr_proof_1", kcfg, [], node1.id, node2.id, new Map(), { proofDir });

    await writeProofData(proof);
    const proofFromDisk = await readProofData(proofDir, proof.id);

    expect(proofFromDisk.dict).toEqual(proof.dict);
  });

  test("test_apr_proof_from_dict_no_subproofs", async () => {
    const proof = aprProof(1, proofDir);

    await writeProofData(proof);
    const proofFromDisk = await readProofData(proofDir, proof.id);

    expect(proof.dict).toEqual(proofFromDisk.dict);
  });

  test("test_apr_proof_from_dict_one_subproofs", async () => {
    const eqProof = equalityProof(1, proofDir);
    const proof = aprProof(1, proofDir);

    await writeProofData(eqProof);
    await readSubproofData(proof, eqProof.id);
    await writeProofData(proof);
    const proofFromDisk = await readProofData(proofDir, proof.id);

    expect(proof.dict).toEqual(proofFromDisk.dict);
  });

  test("test_apr_proof_from_dict_nested_subproofs", async () => {
    const eqProof = equalityProof(1, proofDir);
    const subproof = aprProof(2, proofDir);
    const proof = aprProof(1, proofDir);

    await writeProofData(eqProof);
    await readSubproofData(subproof, eqProof.id);
    await writeProofData(subproof);
    await readSubproofData(proof, subproof.id);
    await writeProofData(proof);
    const proofFromDisk = await readProofData(proofDir, proof.id);

    expect(proof.dict).toEqual(proofFromDisk.dict);
  });

  test("test_apr_proof_from_dict_heterogeneous_subproofs", async () => {
    const subProof1 = equalityProof(1, proofDir);
    const subProof2 = aprProof(2, proofDir);
    const subProof3 = aprProof(3, proofDir, 3);
    const proof = aprProof(1, proofDir);

    await writeProofData(subProof1);
    await writeProofData(subProof2);
    await writeProofData(subProof3);
    await readSubproofData(proof, subProof1.id);
    await readSubproofData(proof, subProof2.id);
    await readSubproofData(proof, subProof3.id);
    await writeProofData(proof);
    const proofFromDisk = await readProofData(proofDir, proof.id);

    expect(proof.dict).toEqual(proofFromDisk.dict);
  });

  test("test_apr_proof_minimization_and_terminals", () => {
    const proof = new APRProof("apr_min_proof", minimizationTestKcfg(), [3, 9, 11], 1, 11, new Map());

    expect([...proof.terminalIds].toSorted((a, b) => a - b)).toEqual([3, 9, 11]);
    proof.minimizeKcfg();
    expect([...proof.terminalIds]).toEqual([11]);
  });

  // `MODULE_NAME_TEST_DATA` (`test_proof.py:262-278`).
  test.each([
    ["sq-bracket", "TEST-KONTROL-TEST-UINT256-BYTES[]-0", "M-TEST-KONTROL-TEST-UINT256-BYTESbktbkt-0"],
    ["underscore", "TEST_KONTROL_%)_UINT256-1", "M-TEST-KONTROL-UINT256-1"],
  ])("test_proof_module_name %s", (_testId, proofId, expected) => {
    expect(APRProof.makeModuleName(proofId)).toBe(expected);
  });
});

describe("APRBMCProof", () => {
  test("test_aprbmc_proof_from_dict_no_subproofs", async () => {
    const proof = aprProof(1, proofDir, 1);

    await writeProofData(proof);
    const proofFromDisk = await readProofData(proofDir, proof.id);

    expect(proof.dict).toEqual(proofFromDisk.dict);
  });

  test("test_aprbmc_proof_from_dict_one_subproofs", async () => {
    const eqProof = equalityProof(1, proofDir);
    const proof = aprProof(1, proofDir, 1);

    await writeProofData(eqProof);
    await readSubproofData(proof, eqProof.id);
    await writeProofData(proof);
    const proofFromDisk = await readProofData(proofDir, proof.id);

    expect(proof.dict).toEqual(proofFromDisk.dict);
  });

  test("test_aprbmc_proof_from_dict_heterogeneous_subproofs", async () => {
    const eqProof = equalityProof(1, proofDir);
    const subproof = aprProof(2, proofDir);
    const proof = aprProof(1, proofDir, 1);

    await writeProofData(eqProof);
    await readSubproofData(subproof, eqProof.id);
    await writeProofData(subproof);
    await readSubproofData(proof, subproof.id);
    await writeProofData(proof);
    const proofFromDisk = await readProofData(proofDir, proof.id);

    expect(proof.dict).toEqual(proofFromDisk.dict);
  });
});

test("test_print_failure_info", () => {
  const failureInfo = new APRFailureInfo({
    failingNodes: [3, 5],
    pendingNodes: [6, 7, 8],
    failureReasons: new Map([
      [
        3,
        "Structural matching failed, the following cells failed individually (antecedent #Implies consequent):\nSTATE_CELL: $n |-> 2 #Implies 1",
      ],
      [
        5,
        "Structural matching failed, the following cells failed individually (antecedent #Implies consequent):\nSTATE_CELL: $n |-> 5 #Implies 6",
      ],
    ]),
    pathConditions: new Map([
      [3, "true #Equals X <=Int 100"],
      [5, "#Top"],
    ]),
    models: new Map([[5, [["X", "101"]]]]),
  });

  const actualOutput = failureInfo.print().join("\n");
  const expectedOutput = `5 Failure nodes. (3 pending and 2 failing)

Pending nodes: [6, 7, 8]

Failing nodes:

  Node id: 3
  Failure reason:
    Structural matching failed, the following cells failed individually (antecedent #Implies consequent):
    STATE_CELL: $n |-> 2 #Implies 1
  Path condition:
    true #Equals X <=Int 100
  Failed to generate a model.

  Node id: 5
  Failure reason:
    Structural matching failed, the following cells failed individually (antecedent #Implies consequent):
    STATE_CELL: $n |-> 5 #Implies 6
  Path condition:
    #Top
  Model:
    X = 101

Join the Runtime Verification Discord server for support: https://discord.gg/CurfmXNtbN`;

  expect(actualOutput).toBe(expectedOutput);
});

test("test_apr_proof_summary", () => {
  const proof = aprProof(1, proofDir);

  expect(proof.summary.summaries).toHaveLength(1);
  expect(proof.summary).toEqual(
    new CompositeSummary([
      new APRSummary({
        id: "apr_proof_1",
        status: ProofStatus.PASSED,
        admitted: false,
        nodes: 1,
        pending: 0,
        failing: 0,
        vacuous: 0,
        stuck: 0,
        terminal: 0,
        refuted: 0,
        bmcDepth: undefined,
        bounded: 0,
        subproofs: 0,
        formattedExecTime: "0s",
      }),
    ]),
  );
});

test("test_aprbmc_proof_summary", () => {
  const proof = aprProof(1, proofDir, 1);

  expect(proof.summary.summaries).toHaveLength(1);
  expect(proof.summary).toEqual(
    new CompositeSummary([
      new APRSummary({
        id: "apr_proof_1",
        status: ProofStatus.PASSED,
        admitted: false,
        nodes: 1,
        pending: 0,
        failing: 0,
        vacuous: 0,
        stuck: 0,
        terminal: 0,
        refuted: 0,
        bmcDepth: 1,
        bounded: 0,
        subproofs: 0,
        formattedExecTime: "0s",
      }),
    ]),
  );
});

test("test_apr_proof_summary_subproofs", async () => {
  const eqProof = equalityProof(1, proofDir);
  const subproof = aprProof(2, proofDir);
  const proof = aprProof(1, proofDir);

  await writeProofData(eqProof);
  await readSubproofData(subproof, eqProof.id);
  await writeProofData(subproof);
  await readSubproofData(proof, subproof.id);
  await writeProofData(proof);
  const proofFromDisk = await readProofData(proofDir, proof.id);

  const compSummary = proofFromDisk.summary;
  expect(compSummary).toBeInstanceOf(CompositeSummary);
  const summaries = asCompositeSummary(compSummary).summaries;
  expect(summaries).toHaveLength(2);
  expect(summaries[0]).toEqual(
    new APRSummary({
      id: "apr_proof_1",
      status: ProofStatus.PENDING,
      admitted: false,
      nodes: 1,
      pending: 0,
      failing: 0,
      vacuous: 0,
      stuck: 0,
      terminal: 0,
      refuted: 0,
      bmcDepth: undefined,
      bounded: 0,
      subproofs: 1,
      formattedExecTime: "0s",
    }),
  );

  expect(summaries[1]).toEqual(
    new CompositeSummary([
      new APRSummary({
        id: "apr_proof_2",
        status: ProofStatus.PENDING,
        admitted: false,
        nodes: 2,
        pending: 1,
        failing: 0,
        vacuous: 0,
        stuck: 0,
        terminal: 0,
        refuted: 0,
        bmcDepth: undefined,
        bounded: 0,
        subproofs: 1,
        formattedExecTime: "0s",
      }),
      new EqualitySummary("equality_proof_1", ProofStatus.PENDING, false),
    ]),
  );
});
