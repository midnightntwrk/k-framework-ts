/**
 * Shared machinery for the three fixture-driven conformance suites
 * (`golden.test.ts`, `structural.test.ts`, `classification.test.ts`).
 *
 * Nothing here is an oracle by itself; it is the plumbing the oracles stand on:
 * locating and walking `fixtures/`, and the one canonicalisation the corpus
 * needs before a re-encoded document can be compared with the bytes it came
 * from.
 *
 * # Request-side decoders
 *
 * `src/codec.ts` owns the public request decoders used by bug-report readers,
 * session replayers, mock servers, and these fixture suites. This module
 * re-exports them as part of the shared fixture harness.
 *
 * # The one canonicalisation
 *
 * `canonicalizeJson` rewrites the legacy two-field `{"tag":"And","first":P,
 * "second":Q}` shape into the n-ary `{"tag":"And","patterns":[P,Q]}` one. This
 * is not a workaround: it is exactly `modifyAndOr`/`flattenAndOr`
 * (`haskell-backend/kore-rpc-types/…/Types.hs:245-263`), which upstream applies
 * to the *input* before its own decoder ever sees it, and which
 * `@kframework-ts/kore` reproduces on decode while always emitting the n-ary
 * form. Three fixtures use the legacy shape (all in
 * `booster-rpc/test-get-model/`), so a re-encoded document is compared against
 * the canonicalised original rather than the raw one. Everything else is
 * compared verbatim.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect } from "bun:test";
import type { JsonObject, JsonValue } from "@kframework-ts/kore";
import {
  encodeAddModuleParams,
  encodeAddModuleResult,
  encodeExecuteParams,
  encodeExecuteResult,
  encodeGetModelParams,
  encodeGetModelResult,
  encodeImpliesParams,
  encodeImpliesResult,
  encodeSimplifyParams,
  encodeSimplifyResult,
} from "../src/codec.ts";
import type { KoreRpcMethod, KoreRpcParamsByMethod, KoreRpcResultByMethod } from "../src/types.ts";
import { jsonRecord, parseJson } from "./helpers/assert.ts";

/**
 * The request-side codec, re-exported so the suites import one module.
 *
 * `src/codec.ts` is where they live now; see the header.
 */
export {
  type DecodedRequest,
  decodeAddModuleParams,
  decodeExecuteParams,
  decodeGetModelParams,
  decodeImpliesParams,
  decodeParams,
  decodeRequestEnvelope,
  decodeSimplifyParams,
  isKoreRpcMethod,
} from "../src/codec.ts";

//////////////////////
// Locating fixtures //
//////////////////////

/** The vendored corpus root — `packages/kore-rpc/fixtures`. */
export const FIXTURES: string = join(import.meta.dir, "..", "fixtures");

/** An absolute path inside {@link FIXTURES}. */
export function fixturePath(...segments: readonly string[]): string {
  return join(FIXTURES, ...segments);
}

/** The bytes of a fixture, as UTF-8 text. Never mutated, never rewritten. */
export function readFixture(...segments: readonly string[]): string {
  return readFileSync(fixturePath(...segments), "utf8");
}

/** A fixture parsed as JSON. Throws on a non-JSON fixture, which is sometimes the point. */
export function readFixtureJson(...segments: readonly string[]): JsonValue {
  return parseJson(readFixture(...segments));
}

/** The regular files directly inside a fixture directory, sorted, so test counts are stable. */
export function listFiles(...segments: readonly string[]): readonly string[] {
  const dir = fixturePath(...segments);
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .toSorted();
}

/** The subdirectories of a fixture directory, sorted. */
export function listDirs(...segments: readonly string[]): readonly string[] {
  const dir = fixturePath(...segments);
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .toSorted();
}

/** Strip the single trailing newline a `.golden` wire response carries (`confTrailingNewline`). */
export function stripTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

//////////////////////
// Canonicalisation //
//////////////////////

/**
 * Apply upstream's `flattenAndOr` rewrite everywhere in a JSON document.
 *
 * See the header: this is the only difference the corpus exhibits between "the
 * bytes we were given" and "the bytes a faithful decode/encode round trip
 * produces", and it is a difference upstream introduces itself.
 */
export function canonicalizeJson(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map((element: unknown) => canonicalizeJson(element));
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }

  // Everything that reaches here came out of a `JSON.parse` or out of an
  // encoder, so "not a scalar, not an array" means "a JSON object" — and
  // `jsonRecord` is what makes that a checked claim rather than an assumed one.
  const obj = jsonRecord(value, "a value inside the document");
  const tag = obj["tag"];
  if ((tag === "And" || tag === "Or") && !Object.hasOwn(obj, "patterns")) {
    return {
      tag,
      sort: canonicalizeJson(obj["sort"]),
      patterns: [canonicalizeJson(obj["first"]), canonicalizeJson(obj["second"])],
    };
  }

  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(obj)) out[key] = canonicalizeJson(obj[key]);
  return out;
}

/**
 * The corpus's central assertion: a document that was decoded into typed
 * values and encoded again is the document we started from.
 *
 * Structural, never byte-wise — see each suite's header for why that is the
 * right comparison for its tier — and against the canonicalised original, so
 * the one rewrite upstream performs on its own input is not counted as a
 * difference.
 */
export function expectRoundTrip(reencoded: JsonValue, original: unknown): void {
  expect(reencoded).toEqual(canonicalizeJson(original));
}

//////////////////////
// Encoders by method //
//////////////////////

type ParamsEncoders = {
  readonly [M in KoreRpcMethod]: (params: KoreRpcParamsByMethod[M]) => JsonObject;
};

const PARAMS_ENCODERS: ParamsEncoders = {
  execute: encodeExecuteParams,
  implies: encodeImpliesParams,
  simplify: encodeSimplifyParams,
  "add-module": encodeAddModuleParams,
  "get-model": encodeGetModelParams,
};

/** The `codec.ts` encoder for a method's params, by method — the mirror of {@link decodeParams}. */
export function encodeParamsFor<M extends KoreRpcMethod>(method: M, params: KoreRpcParamsByMethod[M]): JsonObject {
  return PARAMS_ENCODERS[method](params);
}

type ResultEncoders = {
  readonly [M in KoreRpcMethod]: (result: KoreRpcResultByMethod[M]) => JsonObject;
};

const RESULT_ENCODERS: ResultEncoders = {
  execute: encodeExecuteResult,
  implies: encodeImpliesResult,
  simplify: encodeSimplifyResult,
  "add-module": encodeAddModuleResult,
  "get-model": encodeGetModelResult,
};

/** The `codec.ts` encoder for a method's result, by method — the mirror of `decodeResult`. */
export function encodeResultFor<M extends KoreRpcMethod>(method: M, result: KoreRpcResultByMethod[M]): JsonObject {
  return RESULT_ENCODERS[method](result);
}
