import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  APRProof,
  EqualityProof,
  ImpliesProof,
  RefutationProof,
  aprProofDataSchema,
  aprProofDictSchema,
  impliesProofDictSchema,
} from "../src/index.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "pinned-pyk-proof.json");

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (!isObject(value)) throw new TypeError("expected object");
  return value;
}

function fixtureDocument(caseName: string, field: string): unknown {
  const fixture = object(JSON.parse(readFileSync(FIXTURE, "utf8")) as unknown);
  const entry = object(object(fixture["cases"])[caseName]);
  const text = entry[field];
  if (typeof text !== "string") throw new TypeError(`missing ${caseName}.${field}`);
  return JSON.parse(text) as unknown;
}

describe("proof wire schemas", () => {
  test("round-trip pyk fixture documents through their existing domain decoders", () => {
    const aprDocument = fixtureDocument("apr-plain", "dict");
    const apr = APRProof.fromDict(aprDocument);
    expect(aprProofDictSchema.parse(apr.dict)).toEqual(aprProofDictSchema.parse(aprDocument));

    const impliesDocument = fixtureDocument("equality", "proof_json");
    const equality = EqualityProof.fromDict(impliesDocument);
    expect(impliesProofDictSchema.parse(equality.dict)).toEqual(impliesProofDictSchema.parse(impliesDocument));

    const proofData = aprProofDataSchema.parse(fixtureDocument("apr-rich", "proof_json"));
    expect([...proofData.node_refutations]).toEqual([[2, "apr_proof_rich.node-infeasible-2"]]);
    expect([...proofData.loops_cache]).toEqual([
      [2, [1]],
      [5, [1, 2]],
    ]);
  });

  test("reject malformed nested map and array members", () => {
    const apr = fixtureDocument("apr-plain", "dict");
    expect(aprProofDictSchema.safeParse({ ...object(apr), node_refutations: { 1: 42 } }).success).toBe(false);

    const data = fixtureDocument("apr-rich", "proof_json");
    expect(aprProofDataSchema.safeParse({ ...object(data), loops_cache: { 2: ["one"] } }).success).toBe(false);

    const implies = fixtureDocument("equality", "proof_json");
    expect(impliesProofDictSchema.safeParse({ ...object(implies), subproof_ids: [1] }).success).toBe(false);

    const withoutSubproofs = { ...object(implies) };
    delete withoutSubproofs["subproof_ids"];
    expect(impliesProofDictSchema.safeParse(withoutSubproofs).success).toBe(false);
    for (const ProofType of [ImpliesProof, EqualityProof, RefutationProof]) {
      expect(() => ProofType.fromDict({ ...withoutSubproofs, type: ProofType.name })).toThrow();
    }
  });
});
