/** Narrowing helpers the tests share, so no test needs a type assertion. */

import { readFileSync } from "node:fs";

import { APRProof, CompositeSummary, type Proof, RefutationProof } from "../src/index.ts";

/** `JSON.parse` through an `unknown` binding rather than an assertion. */
export function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

export function readJsonFile(path: string): unknown {
  return parseJson(readFileSync(path, "utf8"));
}

export function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonObject(value: unknown): Readonly<Record<string, unknown>> {
  if (!isJsonObject(value)) throw new TypeError(`Expected a JSON object, got ${JSON.stringify(value)}`);
  return value;
}

export function jsonObjectFile(path: string): Readonly<Record<string, unknown>> {
  return jsonObject(readJsonFile(path));
}

export function jsonString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError(`Expected a string, got ${JSON.stringify(value)}`);
  return value;
}

export function jsonStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new TypeError(`Expected an array of strings, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function jsonNumbers(value: unknown): readonly number[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "number")) {
    throw new TypeError(`Expected an array of numbers, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function asAprProof(proof: Proof): APRProof {
  if (!(proof instanceof APRProof)) throw new TypeError(`Expected an APRProof, got ${proof.proofType}`);
  return proof;
}

export function asRefutationProof(proof: Proof): RefutationProof {
  if (!(proof instanceof RefutationProof)) throw new TypeError(`Expected a RefutationProof, got ${proof.proofType}`);
  return proof;
}

export function asCompositeSummary(summary: { readonly lines: readonly string[] }): CompositeSummary {
  if (!(summary instanceof CompositeSummary)) throw new TypeError("Expected a CompositeSummary");
  return summary;
}

/** Run an async call and return whatever it threw, so `expect` can inspect it. */
export async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to reject, but it resolved");
}
