/**
 * Conformance against documents a real pyk wrote.
 *
 * `fixtures/pinned-pyk-proof.json` stores each document as pyk's own JSON
 * *text*, so this suite pins key order as well as values without depending on
 * Python's `json.dumps` separators (`", "`/`": "`, where `JSON.stringify` uses
 * `","`/`":"` — see the README's byte-parity note).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { CSubst } from "@kframework-ts/cterm";
import { kapply, kvariable, toDict as kastToDict } from "@kframework-ts/kast";
import { BOOL } from "@kframework-ts/kast/prelude/kbool";
import { intToken } from "@kframework-ts/kast/prelude/kint";
import { KCFG, KCFGNodeAttr } from "@kframework-ts/kcfg";
import { KCFGExplorationNodeAttr } from "@kframework-ts/kcfg/explore";
import type { LogEntry } from "@kframework-ts/kore-rpc";

import { APRProof, EqualityProof, RefutationProof, summaryToString } from "../src/index.ts";
import { readProofData, writeProofData } from "../src/store.ts";

import { nodeDicts } from "./helpers.ts";
import {
  asAprProof,
  asRefutationProof,
  caught,
  jsonObject,
  jsonObjectFile,
  jsonString,
  jsonStrings,
  parseJson,
} from "./support.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "pinned-pyk-proof.json");
const FIXTURE_SHA256 = "69997b2e1a36e493e6b63900c7269bbe74a8089ab996893ce8db1290c0a6b3a1";

const fixtureText = readFileSync(FIXTURE, "utf8");

/** One case of `fixtures/pinned-pyk-proof.json`. */
function pinned(name: string): Readonly<Record<string, unknown>> {
  const value = jsonObject(jsonObject(parseJson(fixtureText))["cases"])[name];
  if (value === undefined) throw new Error(`Fixture case ${name} is missing`);
  return jsonObject(value);
}

/** One string field of one case — a whole JSON document, as pyk wrote it. */
function pinnedText(name: string, field: string): string {
  return jsonString(pinned(name)[field]);
}

/** One string-array field of one case. */
function pinnedLines(name: string, field: string): readonly string[] {
  return jsonStrings(pinned(name)[field]);
}

/** One string-to-string map field of one case. */
function pinnedMap(name: string, field: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(jsonObject(pinned(name)[field]))) out[key] = jsonString(value);
  return out;
}

/** Compare against a pyk document, key order included. */
function expectSameDocument(actual: unknown, pykText: string): void {
  const expected = parseJson(pykText);
  expect(actual).toEqual(expected);
  expect(keyOrder(actual)).toEqual(keyOrder(expected));
}

/** A nested key-order fingerprint: arrays keep their shape, objects their keys. */
function keyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(keyOrder);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).map(([key, entry]) => [key, keyOrder(entry)]);
  }
  return null;
}

function kcfgOf(n: number): KCFG {
  return KCFG.fromDict({ nodes: nodeDicts(n) });
}

const constraintLt7 = kapply("_<Int_", [kvariable("X"), intToken(7)]);
const constraintGe0 = kapply("_>=Int_", [kvariable("X"), intToken(0)]);

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kframework-ts-proof-pinned-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Rebuild the `apr-rich` proof, which exercises every optional field at once. */
function richProof(proofDir?: string): APRProof {
  const options = proofDir === undefined ? {} : { proofDir };
  const equality = new EqualityProof("equality_proof_1", intToken(1), intToken(1), BOOL, options);
  const refutation = new RefutationProof("apr_proof_rich.node-infeasible-2", [constraintLt7], constraintGe0, options);
  const logs = new Map<number, readonly LogEntry[]>([
    [2, [{ tag: "rewrite", origin: "booster", result: { tag: "success", ruleId: "RULE-A" } }]],
    [5, [{ tag: "rewrite", origin: "kore-rpc", result: { tag: "failure", reason: "no rule applies" } }]],
  ]);
  return new APRProof("apr_proof_rich", kcfgOf(5), [3, 1], 1, 4, logs, {
    ...options,
    bmcDepth: 3,
    bounded: [5, 2],
    circularity: true,
    admitted: true,
    subproofs: [equality, refutation],
    subproofIds: ["equality_proof_1", "apr_proof_rich.node-infeasible-2"],
    nodeRefutations: { 2: "apr_proof_rich.node-infeasible-2" },
    priorLoopsCache: { 2: [1], 5: [1, 2] },
    execTime: 3661.4,
  });
}

describe("pinned pyk proof fixture", () => {
  test("is the recorded pyk-generated document", () => {
    expect(createHash("sha256").update(fixtureText).digest("hex")).toBe(FIXTURE_SHA256);
  });

  test("apr-plain matches both schemas key for key", () => {
    const proof = new APRProof("apr_proof_1", kcfgOf(1), [], 1, 1, new Map());
    expectSameDocument(proof.dict, pinnedText("apr-plain", "dict"));
    expectSameDocument(proof.proofDataDict, pinnedText("apr-plain", "proof_json"));
  });

  test("apr-attrs keeps vacuous in the store index and terminal in proof.json", async () => {
    const kcfg = kcfgOf(3);
    kcfg.addAttr(1, KCFGNodeAttr.VACUOUS);
    kcfg.addAttr(2, KCFGExplorationNodeAttr.TERMINAL);
    kcfg.addAttr(3, KCFGNodeAttr.STUCK);
    const proof = new APRProof("apr_proof_attrs", kcfg, [], 1, 3, new Map(), { proofDir: scratch });

    expectSameDocument(proof.dict, pinnedText("apr-attrs", "dict"));
    expectSameDocument(proof.proofDataDict, pinnedText("apr-attrs", "proof_json"));

    await writeProofData(proof);
    expectSameDocument(
      jsonObjectFile(join(scratch, "apr_proof_attrs", "kcfg", "kcfg.json")),
      pinnedText("apr-attrs", "kcfg_json"),
    );
  });

  test("apr-bmc sorts bounded and writes bmc_depth after it", () => {
    const proof = new APRProof("aprbmc_proof_1", kcfgOf(6), [], 1, 1, new Map(), { bmcDepth: 1 });
    for (const nodeId of [5, 2, 4]) proof.addBounded(nodeId);
    expectSameDocument(proof.dict, pinnedText("apr-bmc", "dict"));
    expectSameDocument(proof.proofDataDict, pinnedText("apr-bmc", "proof_json"));
  });

  test("apr-rich matches both schemas, the summary, and the one-line summary", () => {
    const proof = richProof(scratch);
    expectSameDocument(proof.dict, pinnedText("apr-rich", "dict"));
    expectSameDocument(proof.proofDataDict, pinnedText("apr-rich", "proof_json"));
    expect(proof.summary.lines).toEqual(pinnedLines("apr-rich", "summary"));
    expect(summaryToString(proof.summary)).toBe(pinnedLines("apr-rich", "summary").join("\n"));
    expect(proof.oneLineSummary).toBe(pinnedText("apr-rich", "one_line_summary"));
  });

  test("equality and refutation documents match", () => {
    const equality = new EqualityProof("equality_proof_1", intToken(1), intToken(1), BOOL);
    expectSameDocument(equality.dict, pinnedText("equality", "dict"));
    expectSameDocument(equality.dict, pinnedText("equality", "proof_json"));

    const refutation = new RefutationProof("apr_proof_rich.node-infeasible-2", [constraintLt7], constraintGe0);
    expectSameDocument(refutation.dict, pinnedText("refutation", "dict"));
    expectSameDocument(refutation.dict, pinnedText("refutation", "proof_json"));
  });

  test("formatted_exec_time reproduces Python's round-half-to-even", () => {
    const proof = new APRProof("timing", kcfgOf(1), [], 1, 1, new Map());
    for (const [seconds, expected] of Object.entries(pinnedMap("formatted-exec-time", "formatted"))) {
      proof.setExecTime(Number(seconds));
      expect(proof.formattedExecTime()).toBe(expected);
    }
  });

  test("the RefutationProof antecedent gains one #Equals wrapper per round trip", async () => {
    const antecedents = pinnedLines("refutation-round-trip", "antecedents");
    let current = new RefutationProof("refutation_round_trip", [constraintGe0], constraintGe0, {
      proofDir: scratch,
    });
    expect(jsonObject(parseJson(antecedents[0]!))).toEqual(kastToDict(current.antecedent));

    for (let round = 1; round < antecedents.length; round += 1) {
      await writeProofData(current);
      current = asRefutationProof(await readProofData(scratch, "refutation_round_trip"));
      expect(jsonObject(parseJson(antecedents[round]!))).toEqual(kastToDict(current.antecedent));
    }
    // Not idempotent, and pyk is not either: each read re-wraps `pre_constraints`.
    expect(jsonObject(parseJson(antecedents[0]!))).not.toEqual(kastToDict(current.antecedent));
  });
});

describe("documented upstream divergences", () => {
  test("fromDict restores node_refutations where pyk's from_dict drops them", async () => {
    const proof = richProof(scratch);
    await writeProofData(proof);
    for (const subproof of proof.subproofs) await writeProofData(subproof);

    // pyk's guard tests the singular key `'node_refutation'` (reachability.py:390).
    expect(pinnedMap("apr-rich", "from_dict_node_refutations")).toEqual({});
    expect(pinnedMap("apr-rich", "read_proof_data_node_refutations")).toEqual({
      "2": "apr_proof_rich.node-infeasible-2",
    });

    const restored = APRProof.fromDict(parseJson(pinnedText("apr-rich", "dict")), {
      proofDir: scratch,
      subproofs: proof.subproofs,
      subproofIds: proof.subproofIds,
    });
    expect([...restored.nodeRefutations].map(([nodeId, sub]) => [nodeId, sub.id])).toEqual([
      [2, "apr_proof_rich.node-infeasible-2"],
    ]);

    // The proof-data path agrees with pyk exactly.
    const fromDisk = asAprProof(await readProofData(scratch, "apr_proof_rich"));
    expect([...fromDisk.nodeRefutations].map(([nodeId, sub]) => [nodeId, sub.id])).toEqual([
      [2, "apr_proof_rich.node-infeasible-2"],
    ]);
  });

  test("bounded is sorted in both schemas even though pyk's dict writes list(set)", () => {
    const proof = new APRProof("bounded_order", kcfgOf(9), [], 1, 1, new Map());
    for (const nodeId of [7, 3, 9, 1]) proof.addBounded(nodeId);
    expect(proof.dict["bounded"]).toEqual([1, 3, 7, 9]);
    expect(proof.proofDataDict["bounded"]).toEqual([1, 3, 7, 9]);
  });

  test("integer-keyed maps are emitted in ascending order, not insertion order", () => {
    const logs = new Map<number, readonly LogEntry[]>([
      [5, []],
      [2, []],
    ]);
    const proof = new APRProof("key_order", kcfgOf(5), [], 1, 1, logs);
    proof.priorLoopsCache = new Map([
      [9, [1]],
      [3, [2]],
    ]);
    // Python preserves insertion order here; JavaScript objects do not, and
    // `JSON.stringify` follows the object. Node ids are inserted ascending in
    // every real artifact, so the two agree in practice.
    expect(Object.keys(jsonObject(proof.proofDataDict["logs"]))).toEqual(["2", "5"]);
    expect(Object.keys(jsonObject(proof.proofDataDict["loops_cache"]))).toEqual(["3", "9"]);
  });

  test("a bare ImpliesProof cannot be read back", async () => {
    const bare = new RefutationProof("bare_implies", [constraintGe0], constraintGe0, { proofDir: scratch });
    await writeProofData(bare);
    const path = join(scratch, "bare_implies", "proof.json");
    const document = { ...jsonObjectFile(path), type: "ImpliesProof" };
    await Bun.write(path, JSON.stringify(document));

    expect(String(await caught(() => readProofData(scratch, "bare_implies")))).toMatch(
      /Could not load Proof from file/u,
    );
  });

  test("bind_universally is not serialized and comes back true", async () => {
    const proof = new RefutationProof("bind_universally", [constraintGe0], constraintGe0, {
      proofDir: scratch,
    });
    // The constructor hardcodes `true`, exactly as upstream does — the option
    // is not even on `RefutationProofOptions`, because nothing could honour it.
    expect(proof.bindUniversally).toBe(true);
    expect(Object.keys(proof.dict)).not.toContain("bind_universally");
    await writeProofData(proof);
    expect(asRefutationProof(await readProofData(scratch, "bind_universally")).bindUniversally).toBe(true);
  });

  test("csubst round-trips through the implies schema", async () => {
    const proof = new RefutationProof("with_csubst", [constraintGe0], constraintGe0, {
      proofDir: scratch,
      simplifiedAntecedent: constraintGe0,
      simplifiedConsequent: constraintLt7,
      csubst: new CSubst(),
    });
    expect(Object.keys(proof.dict)).toEqual([
      "id",
      "subproof_ids",
      "admitted",
      "type",
      "antecedent",
      "consequent",
      "simplified_antecedent",
      "simplified_consequent",
      "csubst",
    ]);
    await writeProofData(proof);
    const read = asRefutationProof(await readProofData(scratch, "with_csubst"));
    expect(read.csubst).toBeInstanceOf(CSubst);
    expect(read.status).toBe("passed");
  });
});
