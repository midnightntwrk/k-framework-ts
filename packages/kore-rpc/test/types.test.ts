/**
 * The wire types themselves: that the discriminated unions narrow the way
 * `Types.hs` plus pyk's result classes say they should, that the enum
 * constants are complete and in declaration order, and that the transcription
 * manifest is well formed.
 *
 * Several assertions here are really *compile-time* claims — `result.rule` is
 * reachable only after narrowing to `cut-point-rule`/`terminal-rule` — made
 * executable so that `bun test` fails alongside `check:types` if the union is
 * ever flattened.
 */

import { describe, expect, test } from "bun:test";
import {
  type ExecuteResult,
  type GetModelResult,
  type HaltReason,
  type ImpliesStatus,
  type KoreRpcMethod,
  type SatResult,
  CANCEL_METHOD,
  HALT_REASONS,
  HASKELL_BACKEND_RELEASE,
  IMPLIES_STATUSES,
  JSONRPC_VERSION,
  KORE_RPC_METHODS,
  K_RELEASE,
  RESPONSE_TERMINATOR,
  SAT_RESULTS,
  TRANSCRIBED_FROM,
  koreJson,
} from "../src/index.ts";
import { intDv } from "@kframework-ts/kore/prelude";

//////////////////////
// Enums            //
//////////////////////

describe("closed enums", () => {
  test("HaltReason is the eight of Types.hs:129-137, in order", () => {
    expect(HALT_REASONS).toEqual([
      "branching",
      "stuck",
      "vacuous",
      "depth-bound",
      "cut-point-rule",
      "terminal-rule",
      "aborted",
      "timeout",
    ]);
    // Every member of the type is in the constant, and vice versa.
    const fromType: readonly HaltReason[] = HALT_REASONS;
    expect(new Set(fromType).size).toBe(8);
  });

  test("ImpliesStatus is the tri-state of Types.hs:168-180", () => {
    expect(IMPLIES_STATUSES).toEqual(["valid", "invalid", "indeterminate"]);
    const statuses: readonly ImpliesStatus[] = IMPLIES_STATUSES;
    expect(statuses).toContain("indeterminate");
  });

  test("SatResult is capitalized — the one enum without a tag modifier", () => {
    expect(SAT_RESULTS).toEqual(["Sat", "Unsat", "Unknown"]);
    const results: readonly SatResult[] = SAT_RESULTS;
    for (const result of results) expect(result[0]).toBe(result[0]?.toUpperCase() ?? "");
  });

  test("the five payload methods, and cancel beside them", () => {
    expect(KORE_RPC_METHODS).toEqual(["execute", "implies", "simplify", "add-module", "get-model"]);
    const methods: readonly string[] = KORE_RPC_METHODS;
    expect(methods).not.toContain(CANCEL_METHOD);
    expect(CANCEL_METHOD).toBe("cancel");
    const first: KoreRpcMethod = "execute";
    expect(methods[0]).toBe(first);
  });

  test("framing constants (Server.hs:91-98)", () => {
    expect(JSONRPC_VERSION).toBe("2.0");
    expect(RESPONSE_TERMINATOR).toBe("\n");
  });
});

//////////////////////
// Narrowing        //
//////////////////////

/**
 * Everything a caller can pull out of a result, with only `reason` known.
 *
 * The body is the point: `result.rule` compiles under `cut-point-rule` and
 * `terminal-rule` and nowhere else, and `result.unknownPredicate` only under
 * `aborted`.
 */
function summarize(result: ExecuteResult): { rule?: string; branches?: number; unknown?: boolean } {
  switch (result.reason) {
    case "cut-point-rule":
      // Both `rule` and `nextStates` are available here, and only here.
      return { rule: result.rule, branches: result.nextStates.length };
    case "terminal-rule":
      return { rule: result.rule };
    case "branching":
      return { branches: result.nextStates.length };
    case "aborted":
      return { unknown: result.unknownPredicate !== undefined };
    case "stuck":
    case "vacuous":
    case "depth-bound":
    case "timeout":
      return {};
    default:
      throw new TypeError("unreachable");
  }
}

/** The same, for the `satisfiable` union: only `Sat` has a substitution. */
function model(result: GetModelResult): string {
  switch (result.satisfiable) {
    case "Sat":
      return result.substitution === undefined ? "sat, trivially" : "sat, with a model";
    case "Unsat":
      return "unsat";
    case "Unknown":
      return "unknown";
    default:
      throw new TypeError("unreachable");
  }
}

describe("ExecuteResult narrows on reason", () => {
  const state = { term: koreJson(intDv(0)) };

  test("cut-point-rule carries both rule and next-states", () => {
    expect(summarize({ reason: "cut-point-rule", depth: 1, state, rule: "R", nextStates: [state, state] })).toEqual({
      rule: "R",
      branches: 2,
    });
  });

  test("terminal-rule carries a rule and no next-states", () => {
    expect(summarize({ reason: "terminal-rule", depth: 1, state, rule: "R" })).toEqual({ rule: "R" });
  });

  test("branching carries next-states and no rule", () => {
    expect(summarize({ reason: "branching", depth: 1, state, nextStates: [state, state, state] })).toEqual({
      branches: 3,
    });
  });

  test("aborted is the only reason with an unknown-predicate", () => {
    expect(summarize({ reason: "aborted", depth: 1, state })).toEqual({ unknown: false });
    expect(summarize({ reason: "aborted", depth: 1, state, unknownPredicate: koreJson(intDv(1)) })).toEqual({
      unknown: true,
    });
  });

  test("the four plain reasons carry nothing extra", () => {
    for (const reason of ["stuck", "vacuous", "depth-bound", "timeout"] as const) {
      expect(summarize({ reason, depth: 0, state })).toEqual({});
    }
  });

  test("aborted, timeout and vacuous are results, not errors", () => {
    // Nothing here throws; the caller decides what to do about the verdict.
    for (const reason of ["aborted", "timeout", "vacuous"] as const) {
      const result: ExecuteResult = { reason, depth: 0, state };
      expect(result.reason).toBe(reason);
    }
  });
});

describe("GetModelResult narrows on satisfiable", () => {
  test("each of the three", () => {
    expect(model({ satisfiable: "Sat" })).toBe("sat, trivially");
    expect(model({ satisfiable: "Sat", substitution: koreJson(intDv(0)) })).toBe("sat, with a model");
    expect(model({ satisfiable: "Unsat" })).toBe("unsat");
    expect(model({ satisfiable: "Unknown" })).toBe("unknown");
  });
});

//////////////////////
// Envelope factory //
//////////////////////

describe("koreJson", () => {
  test("wraps a pattern in the constant envelope", () => {
    expect(koreJson(intDv(7))).toEqual({ format: "KORE", version: 1, term: intDv(7) });
  });
});

//////////////////////
// The manifest     //
//////////////////////

describe("TRANSCRIBED_FROM", () => {
  test("pins both releases", () => {
    expect(K_RELEASE).toBe("v7.1.337");
    expect(HASKELL_BACKEND_RELEASE).toBe("v0.1.155");
  });

  test("every entry has a lowercase hex sha256 and a known repo", () => {
    for (const source of TRANSCRIBED_FROM) {
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(["runtimeverification/k", "runtimeverification/haskell-backend"]).toContain(source.repo);
      expect(source.path).not.toStartWith("/");
    }
  });

  test("the format tier is the six JsonRpc files, all haskell-backend", () => {
    const format = TRANSCRIBED_FROM.filter((source) => source.tier === "format");
    expect(format.map((source) => source.path)).toEqual([
      "kore-rpc-types/src/Kore/JsonRpc/Types.hs",
      "kore-rpc-types/src/Kore/JsonRpc/Error.hs",
      "kore-rpc-types/src/Kore/JsonRpc/Server.hs",
      "kore-rpc-types/src/Kore/JsonRpc/Types/Depth.hs",
      "kore-rpc-types/src/Kore/JsonRpc/Types/Log.hs",
      "kore-rpc-types/src/Kore/JsonRpc/Types/ContextLog.hs",
    ]);
    for (const source of format) expect(source.repo).toBe("runtimeverification/haskell-backend");
  });

  test("the content tier holds the reference client and its oracle", () => {
    const content = TRANSCRIBED_FROM.filter((source) => source.tier === "content").map((source) => source.path);
    expect(content).toContain("pyk/src/pyk/kore/rpc.py");
    expect(content).toContain("pyk/src/tests/unit/kore/test_client.py");
  });

  test("no path is listed twice", () => {
    const keys = TRANSCRIBED_FROM.map((source) => `${source.repo}:${source.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
