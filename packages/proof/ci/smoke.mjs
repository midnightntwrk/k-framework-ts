import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CTerm } from "@kframework-ts/cterm";
import { KCFG } from "@kframework-ts/kcfg";
import { APRProof, APRSummary, K_RELEASE, ProofStatus } from "@kframework-ts/proof";
import * as store from "@kframework-ts/proof/store";
import { APRProver, advanceProof, concurrentAdvanceProof, proveClaims, withExplore } from "@kframework-ts/proof/prove";

assert.equal(K_RELEASE, "v7.1.337");
assert.equal(typeof APRProof, "function");
assert.equal(typeof APRSummary, "function");
assert.equal(ProofStatus.PASSED, "passed");
assert.equal(typeof store.readProofData, "function");
assert.equal(typeof store.writeProofData, "function");
assert.equal(typeof store.proofDataExists, "function");
assert.equal(typeof APRProver, "function");
assert.equal(typeof advanceProof, "function");
assert.equal(typeof concurrentAdvanceProof, "function");
assert.equal(typeof withExplore, "function");
assert.equal(typeof proveClaims, "function");

const scratch = await mkdtemp(join(tmpdir(), "kframework-ts-proof-smoke-"));
try {
  const graph = new KCFG();
  const only = graph.createNode(CTerm.top());
  const proof = new APRProof("smoke_proof", graph, [], only.id, only.id, new Map(), { proofDir: scratch });

  assert.equal(proof.status, ProofStatus.PASSED);
  assert.equal(proof.moduleName, "M-SMOKE-PROOF");
  assert.equal(proof.formattedExecTime(), "0s");
  // A proof whose init is its target has nothing pending, so no prover is needed.
  assert.deepEqual(proof.getSteps(), []);

  await store.writeProofData(proof);
  assert.equal(await store.proofDataExists(scratch, "smoke_proof"), true);

  const restored = await store.readProofData(scratch, "smoke_proof");
  assert.deepEqual(restored.dict, proof.dict);
  assert.equal(restored.summary.lines[0], "APRProof: smoke_proof");
} finally {
  await rm(scratch, { recursive: true, force: true });
}

console.log(`@kframework-ts/proof: packed tarball imports and runs under Node ${process.version}`);
