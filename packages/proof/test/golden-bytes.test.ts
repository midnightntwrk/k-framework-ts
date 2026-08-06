/**
 * Byte-stability goldens for everything this package writes.
 *
 * `test/pinned-pyk.test.ts` proves the *documents* match pyk. This file
 * freezes the actual bytes, so a change in how they are emitted — separators,
 * key order, number formatting — shows up as a diff rather than as silence.
 * The goldens are ours; regenerate them with
 * `UPDATE_GOLDEN=1 bun test test/golden-bytes.test.ts` from the package root,
 * and read the diff before committing it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { kapply, kvariable } from "@kframework-ts/kast";
import { BOOL } from "@kframework-ts/kast/prelude/kbool";
import { intToken } from "@kframework-ts/kast/prelude/kint";
import { KCFG, KCFGNodeAttr } from "@kframework-ts/kcfg";
import type { LogEntry } from "@kframework-ts/kore-rpc";

import { APRProof, EqualityProof, RefutationProof } from "../src/index.ts";
import { writeProofData } from "../src/store.ts";

import { nodeDicts } from "./helpers.ts";

const GOLDEN = join(import.meta.dir, "..", "fixtures", "golden", "written-bytes.json");
const UPDATE = process.env["UPDATE_GOLDEN"] === "1";

const constraintLt7 = kapply("_<Int_", [kvariable("X"), intToken(7)]);
const constraintGe0 = kapply("_>=Int_", [kvariable("X"), intToken(0)]);

let scratch: string;
const produced: Record<string, string> = {};

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kframework-ts-proof-golden-"));
});

afterAll(async () => {
  if (UPDATE) writeFileSync(GOLDEN, `${JSON.stringify(produced, null, 2)}\n`);
  await rm(scratch, { recursive: true, force: true });
});

function golden(name: string): string {
  const value: unknown = JSON.parse(readFileSync(GOLDEN, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Bad golden file");
  const entry: unknown = Object.entries(value).find(([key]) => key === name)?.[1];
  return typeof entry === "string" ? entry : "<missing golden>";
}

function freeze(name: string, bytes: string): void {
  produced[name] = bytes;
  if (UPDATE) return;
  expect(`${name}\n${bytes}`).toBe(`${name}\n${golden(name)}`);
}

describe("written bytes", () => {
  test("a plain APRProof directory", async () => {
    const proof = new APRProof("golden_plain", KCFG.fromDict({ nodes: nodeDicts(2) }), [2], 1, 2, new Map(), {
      proofDir: scratch,
    });
    proof.kcfg.createEdge(1, 2, 3, ["RULE-1"]);
    proof.kcfg.addAttr(1, KCFGNodeAttr.STUCK);
    await writeProofData(proof);

    freeze("golden_plain/proof.json", await readFile(join(scratch, "golden_plain", "proof.json"), "utf8"));
    freeze("golden_plain/kcfg/kcfg.json", await readFile(join(scratch, "golden_plain", "kcfg", "kcfg.json"), "utf8"));
    freeze(
      "golden_plain/kcfg/nodes/1.json",
      await readFile(join(scratch, "golden_plain", "kcfg", "nodes", "1.json"), "utf8"),
    );
  });

  test("an APRProof with every optional field, and its two subproofs", async () => {
    const equality = new EqualityProof("golden_equality", intToken(1), intToken(1), BOOL, { proofDir: scratch });
    const refutation = new RefutationProof("golden_rich.node-infeasible-2", [constraintLt7], constraintGe0, {
      proofDir: scratch,
    });
    const logs = new Map<number, readonly LogEntry[]>([
      [2, [{ tag: "rewrite", origin: "booster", result: { tag: "success", ruleId: "RULE-A" } }]],
      [5, [{ tag: "rewrite", origin: "kore-rpc", result: { tag: "failure", reason: "no rule applies" } }]],
    ]);
    const proof = new APRProof("golden_rich", KCFG.fromDict({ nodes: nodeDicts(5) }), [3, 1], 1, 4, logs, {
      proofDir: scratch,
      bmcDepth: 3,
      bounded: [5, 2],
      circularity: true,
      admitted: true,
      subproofs: [equality, refutation],
      subproofIds: [equality.id, refutation.id],
      nodeRefutations: { 2: refutation.id },
      priorLoopsCache: { 2: [1], 5: [1, 2] },
      execTime: 3661.4,
    });

    await writeProofData(proof);
    await writeProofData(equality);
    await writeProofData(refutation);

    freeze("golden_rich/proof.json", await readFile(join(scratch, "golden_rich", "proof.json"), "utf8"));
    freeze("golden_rich/dict", JSON.stringify(proof.dict));
    freeze("golden_equality/proof.json", await readFile(join(scratch, "golden_equality", "proof.json"), "utf8"));
    freeze(
      "golden_rich.node-infeasible-2/proof.json",
      await readFile(join(scratch, "golden_rich.node-infeasible-2", "proof.json"), "utf8"),
    );
  });
});
