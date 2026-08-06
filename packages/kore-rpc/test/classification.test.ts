/**
 * The filename-is-the-oracle tier: `fixtures/classification`.
 *
 * Upstream (`booster/test/jsonrpc-examples/README.md`, vendored beside the
 * fixtures) names every file after the `KoreRpcType` its bytes must classify
 * as, and `Test.Booster.JsonRpc.DiffTest` asserts exactly that. The mapping:
 *
 * | suffix               | `KoreRpcType` | here |
 * | -------------------- | ------------- | ---- |
 * | `.<method>.request`  | `RpcReq M`    | `{kind: "request", method}` |
 * | `.<method>.response` | `RpcResp M`   | `{kind: "response", method}` |
 * | `.error.response`    | `RpcErr`      | `{kind: "error-response"}` |
 * | `.kore.json`         | `RpcKore`     | `{kind: "kore"}` |
 * | `.random.json`       | `RpcJs`       | `{kind: "json"}` |
 * | `.error`             | `NotRpcJs`    | `{kind: "not-json"}` |
 *
 * {@link classify} is the test-local `decodeKoreRpc`: it is written only out
 * of this package's decoders, so what it really asserts is that the decoders
 * are *discriminating* — that a request is not mistakable for a response, that
 * a bare KORE-JSON term is not mistakable for either, and that a result's own
 * shape is enough to say which method produced it.
 *
 * # The five symlinks
 *
 * PROVENANCE §"Symlinks SKIPPED (5)" records five top-level entries that were
 * not copied because they duplicate bytes vendored elsewhere, together with
 * where those bytes now live. The classification each asserts is a property of
 * the **link name**, not of the target's own name — `params.random.json`
 * asserts that a params fragment is valid JSON and *not* an RPC message, and
 * `not-json.error` asserts that a Markdown file is not JSON at all. Those five
 * cases are driven here through the vendored paths; see {@link SYMLINK_CASES}.
 *
 * # Skips
 *
 * None. Every one of the 9 vendored files in `classification/` is classified
 * below (`README.md` included — it is `not-json.error`'s target), and the
 * enumeration is asserted to be complete.
 */

import { describe, expect, test } from "bun:test";
import { type JsonValue, decodeKoreJson } from "@kframework-ts/kore";
import { decodeResponse, decodeResult, encodeRequest } from "../src/codec.ts";
import { PatternError, decodeKoreRpcError } from "../src/errors.ts";
import { emitOrdered } from "../src/keyorder.ts";
import { KORE_RPC_METHODS, type KoreRpcMethod } from "../src/types.ts";
import { decodeRequestEnvelope, encodeResultFor, expectRoundTrip, listFiles, readFixture } from "./fixtures.ts";
import { jsonMember, jsonRecord, jsonRecords, jsonString, parseJson } from "./helpers/assert.ts";

//////////////////////
// The classifier   //
//////////////////////

/** `KoreRpcType` (`booster/library/Booster/JsonRpc/Utils.hs`), as this package can see it. */
export type Classification =
  | { readonly kind: "request"; readonly method: KoreRpcMethod }
  | { readonly kind: "response"; readonly method: KoreRpcMethod }
  | { readonly kind: "error-response" }
  | { readonly kind: "kore" }
  | { readonly kind: "json" }
  | { readonly kind: "not-json" };

function tried<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Which method's result this is, decided by the result's own shape.
 *
 * The five result types are mutually exclusive in their required fields —
 * `execute` needs `reason`/`depth`/`state`, `implies` needs
 * `implication`/`status`, `simplify` needs a `state` that is a KORE-JSON
 * envelope (an `execute` result's `state` is an `ExecuteState`, so it is not),
 * `add-module` needs `module` and `get-model` needs `satisfiable` — so exactly
 * one decoder accepts any real result. Requiring *exactly* one is the
 * assertion; an ambiguous result would mean the union is not discriminating
 * and would classify as plain JSON rather than being silently mis-assigned.
 */
function resultMethod(result: JsonValue): KoreRpcMethod | undefined {
  const accepted = KORE_RPC_METHODS.filter((method) => tried(() => decodeResult(method, result)) !== undefined);
  return accepted.length === 1 ? accepted[0] : undefined;
}

/**
 * Classify a parsed JSON value the way booster's `decodeKoreRpc` does.
 *
 * Order is significant and mirrors upstream's: an envelope with a `method` is
 * a request; an envelope with `result`/`error` is a response; a
 * `{format, version, term}` document is a bare KORE term; anything else that
 * parsed is just JSON.
 */
export function classify(json: unknown): Classification {
  const asRequest = tried(() => decodeRequestEnvelope(json));
  if (asRequest !== undefined && asRequest.request.method !== "cancel") {
    return { kind: "request", method: asRequest.request.method };
  }

  const asResponse = tried(() => decodeResponse(json));
  if (asResponse !== undefined) {
    if (asResponse.kind === "error") return { kind: "error-response" };
    const method = resultMethod(asResponse.result);
    if (method !== undefined) return { kind: "response", method };
    return { kind: "json" };
  }

  if (tried(() => decodeKoreJson(json)) !== undefined) return { kind: "kore" };
  return { kind: "json" };
}

/** Classify raw file bytes: the only way to reach `not-json`. */
export function classifyText(text: string): Classification {
  const json = tried(() => JSON.parse(text) as unknown);
  if (json === undefined) return { kind: "not-json" };
  return classify(json);
}

//////////////////////////////
// What each name declares  //
//////////////////////////////

/** Read the expected classification out of a filename, per the README's table. */
function expectedFromName(name: string): Classification {
  if (name.endsWith(".error")) return { kind: "not-json" };
  if (name.endsWith(".kore.json")) return { kind: "kore" };
  if (name.endsWith(".random.json")) return { kind: "json" };
  if (name.endsWith(".error.response")) return { kind: "error-response" };

  const response = /\.([a-z-]+)\.response$/.exec(name);
  if (response !== null) {
    const method = response[1];
    if (!isMethod(method)) throw new Error(`not a method: ${String(method)} (in ${name})`);
    return { kind: "response", method };
  }

  const request = /\.([a-z-]+)\.request$/.exec(name);
  if (request !== null) {
    const method = request[1];
    if (!isMethod(method)) throw new Error(`not a method: ${String(method)} (in ${name})`);
    return { kind: "request", method };
  }

  throw new Error(`filename declares no classification: ${name}`);
}

function isMethod(value: string | undefined): value is KoreRpcMethod {
  return value !== undefined && (KORE_RPC_METHODS as readonly string[]).includes(value);
}

/** One case: the name that declares the type, and the vendored bytes to read. */
interface Case {
  /** The name whose suffix is the oracle. */
  readonly name: string;
  /** Path segments under `fixtures/`, which for the five symlinks point elsewhere. */
  readonly segments: readonly string[];
}

const CLASSIFICATION_FILES: readonly string[] = listFiles("classification");

/**
 * The eight files named after their type, plus `README.md`.
 *
 * `README.md` has no classification suffix of its own — it is the *target* of
 * the `not-json.error` symlink, so it appears in {@link SYMLINK_CASES} under
 * that name instead and is excluded here.
 */
const DIRECT_CASES: readonly Case[] = CLASSIFICATION_FILES.filter((f) => f !== "README.md").map((name) => ({
  name,
  segments: ["classification", name],
}));

/** PROVENANCE §"Symlinks SKIPPED (5)", read through the paths the bytes actually live at. */
const SYMLINK_CASES: readonly Case[] = [
  { name: "depth-limit.execute.response", segments: ["booster-rpc", "test-a-to-f", "response-depth-limit.json"] },
  { name: "terminal.execute.response", segments: ["booster-rpc", "test-a-to-f", "response-terminal-rule.json"] },
  { name: "params.random.json", segments: ["booster-rpc", "test-a-to-f", "params-cut-point.json"] },
  { name: "state-a.kore.json", segments: ["booster-rpc", "test-a-to-f", "state-branching.execute"] },
  { name: "not-json.error", segments: ["classification", "README.md"] },
];

const CASES: readonly Case[] = [...DIRECT_CASES, ...SYMLINK_CASES];

describe("classification: every file classifies as its name declares", () => {
  test.each(CASES.map((c) => [c.name, c] as const))("%s", (name, testCase) => {
    const text = readFixture(...testCase.segments);
    expect(classifyText(text)).toEqual(expectedFromName(name));
  });

  test("the corpus is the 8 named files plus the README, and 5 symlinks by reference", () => {
    expect(CLASSIFICATION_FILES).toEqual([
      "README.md",
      "add-module.error.response",
      "depth-limit.spaghetti-formatted.execute.response",
      "foundry-proof.implies.request",
      "foundry-proof.simplify.request",
      "foundry-proof2.simplify.request",
      "state-a.spaghetti-formatted.kore.json",
      "state-a.unformatted.execute.request",
      "with-logging.simplify.response",
    ]);
    expect(DIRECT_CASES).toHaveLength(8);
    expect(SYMLINK_CASES).toHaveLength(5);

    // All six classifications occur, so no arm of `classify` is untested.
    const kinds = new Set(CASES.map((c) => classifyText(readFixture(...c.segments)).kind));
    expect(kinds).toEqual(new Set(["request", "response", "error-response", "kore", "json", "not-json"]));
  });
});

//////////////////////////////
// The interesting cases    //
//////////////////////////////

describe("classification: lenient decoding and pathological formatting", () => {
  test("an unknown param does not stop a request from being a request", () => {
    const text = readFixture("classification", "state-a.unformatted.execute.request");
    const raw = parseJson(text);

    // The file really does carry a param no version of this protocol has.
    const params = jsonRecord(jsonMember(raw, "params", "the request"), "the request's params");
    expect(Object.keys(params).toSorted()).toEqual(["cut-point-rules", "max-depth", "state", "xdoesnot"]);

    expect(classify(raw)).toEqual({ kind: "request", method: "execute" });

    const { id, request } = decodeRequestEnvelope(raw);
    expect(id).toBe(1);
    if (request.method !== "execute") throw new Error("expected an execute request");
    expect(request.params.maxDepth).toBe(42);
    expect(request.params.cutPointRules).toEqual(["foo", "bar"]);

    // Lenient means *ignored*, not preserved: `encodeRequest` emits exactly the
    // declared fields, so the round trip drops `xdoesnot` and nothing else.
    const reencoded = encodeRequest(id, request);
    const reencodedParams = jsonRecord(reencoded["params"], "the re-encoded params");
    expect(Object.keys(reencodedParams).toSorted()).toEqual(["cut-point-rules", "max-depth", "state"]);

    // Putting the stray param back is enough to recover the original exactly,
    // which is the precise sense in which nothing else was lost.
    const restored: JsonValue = {
      ...reencoded,
      params: { ...reencodedParams, xdoesnot: jsonMember(params, "xdoesnot", "the request's params") },
    };
    expectRoundTrip(restored, raw);
  });

  test('"unformatted" means the keys were sorted alphabetically, and emitOrdered puts them back', () => {
    const text = readFixture("classification", "state-a.unformatted.execute.request");
    const raw = parseJson(text);

    // `id` before `jsonrpc`, and `args`/`name`/`sorts`/`tag` inside every
    // pattern: alphabetical, which is not the order any server emits.
    expect(Object.keys(jsonRecord(raw, "the request"))).toEqual(["id", "jsonrpc", "method", "params"]);
    expect(text).toStartWith('{"id":1,"jsonrpc":"2.0",');

    // `emitOrdered` restores `PrettyJson.keyOrder`: `jsonrpc` first, then `id`,
    // and `tag` before `name` before `sorts` before `args`.
    const ordered = emitOrdered(raw);
    expect(ordered).toStartWith('{"jsonrpc":"2.0","id":1,');
    expect(ordered).toContain('{"format":"KORE","version":1,"term":{"tag":"App"');
    expect(ordered).not.toBe(text.trimEnd());
    // Same document either way.
    expect(JSON.parse(ordered)).toEqual(raw);
  });

  test('"spaghetti-formatted" files are minified re-orderings of documents vendored elsewhere', () => {
    // Both are the same bytes-as-values as the pretty-printed booster copies,
    // which is what makes them a formatting oracle rather than new data.
    const response = parseJson(readFixture("classification", "depth-limit.spaghetti-formatted.execute.response"));
    expect(response).toEqual(parseJson(readFixture("booster-rpc", "test-a-to-f", "response-depth-limit.json")));
    expect(classify(response)).toEqual({ kind: "response", method: "execute" });

    const term = parseJson(readFixture("classification", "state-a.spaghetti-formatted.kore.json"));
    expect(term).toEqual(parseJson(readFixture("booster-rpc", "test-a-to-f", "state-branching.execute")));
    expect(classify(term)).toEqual({ kind: "kore" });

    // …and they decode to the same typed values as their pretty twins.
    const decoded = decodeResponse(response);
    if (decoded.kind !== "result") throw new Error("expected a result response");
    const result = decodeResult("execute", decoded.result);
    expect(result.reason).toBe("depth-bound");
    expect(result.depth).toBe(2);
  });

  test("the two 50 KB+ foundry requests decode and round-trip", () => {
    for (const file of ["foundry-proof.simplify.request", "foundry-proof2.simplify.request"]) {
      const raw = parseJson(readFixture("classification", file));
      const { id, request } = decodeRequestEnvelope(raw);
      expect(request.method).toBe("simplify");
      expectRoundTrip(encodeRequest(id, request), raw);
    }

    const raw = parseJson(readFixture("classification", "foundry-proof.implies.request"));
    const { id, request } = decodeRequestEnvelope(raw);
    expect(request.method).toBe("implies");
    if (request.method !== "implies") throw new Error("expected an implies request");
    expect(request.params.antecedent.format).toBe("KORE");
    expect(request.params.consequent.format).toBe("KORE");
    expectRoundTrip(encodeRequest(id, request), raw);
  });

  test("add-module.error.response is a code 2 with a null context", () => {
    const raw = parseJson(readFixture("classification", "add-module.error.response"));
    expect(classify(raw)).toEqual({ kind: "error-response" });

    const response = decodeResponse(raw);
    if (response.kind !== "error") throw new Error("expected an error response");
    expect(response.error.code).toBe(2);
    expect(response.error.message).toBe("Could not verify pattern");

    const typed = decodeKoreRpcError(jsonMember(raw, "error", "add-module.error.response"));
    expect(typed).toBeInstanceOf(PatternError);
    if (typed instanceof PatternError) {
      // `"context": null` — pyk reads this member with `[...]` and would raise;
      // here a null context is simply an absent one (see `errors.ts`).
      expect(typed.details).toHaveLength(1);
      expect(typed.context).toEqual([]);
      expect(typed.error).toBe("FOUNDRY-MAIN-DEPENDS-MODULE: Duplicate module");
    }
  });
});

//////////////////////
// The log corpus   //
//////////////////////

describe("classification: with-logging.simplify.response parses its log entries", () => {
  const raw = parseJson(readFixture("classification", "with-logging.simplify.response"));

  test("it is a simplify response", () => {
    expect(classify(raw)).toEqual({ kind: "response", method: "simplify" });
  });

  test("the tag histogram matches the file", () => {
    const response = decodeResponse(raw);
    if (response.kind !== "result") throw new Error("expected a result response");
    const result = decodeResult("simplify", response.result);

    const logs = result.logs ?? [];

    // What the raw file says…
    const rawLogs = jsonRecords(jsonMember(response.result, "logs", "the simplify result"), "the raw log entries");
    const rawTags = new Map<string, number>();
    for (const entry of rawLogs) {
      const tag = jsonString(entry, "tag");
      rawTags.set(tag, (rawTags.get(tag) ?? 0) + 1);
    }

    // …and what the decoder made of it, which must be the same census.
    const tags = new Map<string, number>();
    for (const entry of logs) tags.set(entry.tag, (tags.get(entry.tag) ?? 0) + 1);
    expect(tags).toEqual(rawTags);

    // Absolute numbers, so a fixture change cannot pass unnoticed: 23 entries,
    // every one a `simplification`, of which 22 failed to apply and 1 succeeded.
    expect(logs).toHaveLength(23);
    expect(tags).toEqual(new Map([["simplification", 23]]));

    const results = new Map<string, number>();
    for (const entry of logs) {
      if (entry.tag !== "simplification") throw new Error(`unexpected log tag: ${entry.tag}`);
      results.set(entry.result.tag, (results.get(entry.result.tag) ?? 0) + 1);
      expect(entry.origin).toBe("booster");
    }
    expect(results).toEqual(
      new Map([
        ["failure", 22],
        ["success", 1],
      ]),
    );

    // Every failure carries the rule it could not apply and why.
    for (const entry of logs) {
      if (entry.tag !== "simplification" || entry.result.tag !== "failure") continue;
      expect(entry.result.reason.length).toBeGreaterThan(0);
      expect(entry.result.ruleId).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("the result round-trips with its logs", () => {
    const response = decodeResponse(raw);
    if (response.kind !== "result") throw new Error("expected a result response");
    const result = decodeResult("simplify", response.result);
    expectRoundTrip(encodeResultFor("simplify", result), response.result);
  });
});
