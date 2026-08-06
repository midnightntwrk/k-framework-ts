/**
 * The byte-exact emitter suite.
 *
 * The oracle is `rpcJsonConfig` (`Types.hs:298-342`) plus the server's two
 * overrides (`Server.hs:91-98`). What has to hold:
 *
 * 1. keys named in `RPC_KEY_ORDER` come first, in list order;
 * 2. every other key follows, ascending lexicographically;
 * 3. the rule applies recursively, in every object at every depth;
 * 4. output is compact — no whitespace anywhere — and carries no trailing
 *    newline (that is the transport's, `Server.hs:98`).
 */

import { describe, expect, test } from "bun:test";
import { type JsonValue, encodeKoreJsonValue } from "@kframework-ts/kore";
import { INT, SORT_GENERATED_TOP_CELL, intDv } from "@kframework-ts/kore/prelude";
import { equals, evar } from "@kframework-ts/kore";
import {
  RPC_KEY_ORDER,
  compareRpcKeys,
  emitOrdered,
  encodeExecuteResult,
  encodeRequest,
  koreJson,
} from "../src/index.ts";
import { caught } from "./helpers/assert.ts";

describe("RPC_KEY_ORDER", () => {
  test("is Types.hs:303-341, verbatim and in order", () => {
    expect(RPC_KEY_ORDER).toEqual([
      "format",
      "version",
      "term",
      "tag",
      "assoc",
      "name",
      "symbol",
      "argSort",
      "sort",
      "sorts",
      "var",
      "varSort",
      "arg",
      "args",
      "argss",
      "source",
      "dest",
      "value",
      "jsonrpc",
      "id",
      "reason",
      "depth",
      "rule",
      "state",
      "next-states",
      "substitution",
      "predicate",
      "valid",
      "implication",
      "condition",
      "module",
      "step-timeout",
      "moving-average-step-timeout",
      "code",
      "data",
      "timestamp",
      "context",
      "message",
    ]);
  });

  test('keeps the dead "valid" entry, so later positions do not shift', () => {
    expect(RPC_KEY_ORDER).toContain("valid");
    // The four keys after it are the ones a drop would silently move.
    expect(RPC_KEY_ORDER.indexOf("valid")).toBe(27);
    expect(RPC_KEY_ORDER.indexOf("implication")).toBe(28);
    expect(RPC_KEY_ORDER.indexOf("condition")).toBe(29);
    expect(RPC_KEY_ORDER.indexOf("module")).toBe(30);
  });

  test("has no duplicates", () => {
    expect(new Set(RPC_KEY_ORDER).size).toBe(RPC_KEY_ORDER.length);
  });
});

describe("compareRpcKeys", () => {
  test("listed keys sort by position", () => {
    expect(compareRpcKeys("format", "version")).toBeLessThan(0);
    expect(compareRpcKeys("term", "format")).toBeGreaterThan(0);
    expect(compareRpcKeys("jsonrpc", "jsonrpc")).toBe(0);
  });

  test("a listed key precedes any unlisted key", () => {
    expect(compareRpcKeys("message", "aardvark")).toBeLessThan(0);
    expect(compareRpcKeys("aardvark", "message")).toBeGreaterThan(0);
  });

  test("two unlisted keys sort ascending lexicographically", () => {
    expect(compareRpcKeys("alpha", "beta")).toBeLessThan(0);
    expect(compareRpcKeys("beta", "alpha")).toBeGreaterThan(0);
    expect(compareRpcKeys("alpha", "alpha")).toBe(0);
  });

  test("sorting a mixed key set gives listed-then-ascending", () => {
    const keys = ["zulu", "depth", "alpha", "state", "haskell-log-entries", "reason", "logs"];
    expect(keys.toSorted(compareRpcKeys)).toEqual([
      // listed, in list order
      "reason",
      "depth",
      "state",
      // unlisted, ascending
      "alpha",
      "haskell-log-entries",
      "logs",
      "zulu",
    ]);
  });
});

describe("emitOrdered", () => {
  test("is compact: no space anywhere, and no trailing newline", () => {
    const text = emitOrdered({ jsonrpc: "2.0", id: 1, result: { depth: 0 } });
    expect(text).toBe('{"jsonrpc":"2.0","id":1,"result":{"depth":0}}');
    expect(text).not.toContain(" ");
    expect(text.endsWith("\n")).toBe(false);
  });

  test("orders a response envelope jsonrpc, id, then the unlisted result", () => {
    expect(emitOrdered({ result: { reason: "stuck" }, id: 1, jsonrpc: "2.0" })).toBe(
      '{"jsonrpc":"2.0","id":1,"result":{"reason":"stuck"}}',
    );
  });

  test("orders an execute result: reason, depth, rule, state, next-states, then unlisted", () => {
    const result = encodeExecuteResult({
      reason: "cut-point-rule",
      depth: 2,
      rule: "RULE",
      state: { term: koreJson(intDv(0)) },
      nextStates: [{ term: koreJson(intDv(1)) }],
      logs: [{ tag: "rewrite", origin: "booster", result: { tag: "success", ruleId: "abc1234" } }],
    });
    const text = emitOrdered({ jsonrpc: "2.0", id: "a-001", result });
    // `logs` is unlisted, so it sorts after every listed key of the object.
    expect(text.indexOf('"reason"')).toBeLessThan(text.indexOf('"depth"'));
    expect(text.indexOf('"depth"')).toBeLessThan(text.indexOf('"rule"'));
    expect(text.indexOf('"rule"')).toBeLessThan(text.indexOf('"state"'));
    expect(text.indexOf('"state"')).toBeLessThan(text.indexOf('"next-states"'));
    expect(text.indexOf('"next-states"')).toBeLessThan(text.indexOf('"logs"'));
  });

  test("applies recursively, including inside a KORE-JSON envelope", () => {
    // A pattern object's keys arrive in `Types.hs` declaration order from our
    // encoder; `rpcJsonConfig` wants `tag`, `argSort`, `sort`, `first`,
    // `second` — and `first`/`second` are unlisted, so they land last, in
    // ascending order (`first` < `second`).
    const value = encodeKoreJsonValue(equals(INT, SORT_GENERATED_TOP_CELL, evar("x", INT), intDv(3)));
    const text = emitOrdered(value);
    expect(text.startsWith('{"format":"KORE","version":1,"term":{"tag":"Equals","argSort":')).toBe(true);
    expect(text.indexOf('"argSort"')).toBeLessThan(text.indexOf('"sort"'));
    expect(text.indexOf('"sort"')).toBeLessThan(text.indexOf('"first"'));
    expect(text.indexOf('"first"')).toBeLessThan(text.indexOf('"second"'));
    // Sort objects nested two levels down are ordered too: `tag` then `name`.
    expect(text).toContain('{"tag":"SortApp","name":"SortInt","args":[]}');
  });

  test("arrays keep their order and are compact", () => {
    expect(emitOrdered([1, "two", null, true, [], {}])).toBe('[1,"two",null,true,[],{}]');
  });

  test("an empty object and an empty array", () => {
    expect(emitOrdered({})).toBe("{}");
    expect(emitOrdered([])).toBe("[]");
  });

  test("scalars are escaped by JSON.stringify itself", () => {
    expect(emitOrdered('a "quoted" \\ backslash\n')).toBe(JSON.stringify('a "quoted" \\ backslash\n'));
    expect(emitOrdered(null)).toBe("null");
    expect(emitOrdered(-0)).toBe("0");
  });

  test("a request envelope emits jsonrpc, id, method, params", () => {
    const request = encodeRequest("a-001", { method: "get-model", params: { state: koreJson(intDv(0)) } });
    const text = emitOrdered(request);
    expect(text.startsWith('{"jsonrpc":"2.0","id":"a-001",')).toBe(true);
    // `method` and `params` are both unlisted, so ascending: method < params.
    expect(text.indexOf('"method"')).toBeLessThan(text.indexOf('"params"'));
  });

  test("a golden-shaped error response", () => {
    expect(
      emitOrdered({ jsonrpc: "2.0", id: 1, error: { data: "MODULE", message: "Could not find module", code: 3 } }),
    ).toBe('{"jsonrpc":"2.0","id":1,"error":{"code":3,"data":"MODULE","message":"Could not find module"}}');
  });

  test("deep nesting does not exhaust the call stack", () => {
    let value: JsonValue = 0;
    for (let i = 0; i < 50_000; i++) value = { arg: value };
    const text = emitOrdered(value);
    expect(text.length).toBeGreaterThan(50_000);
    expect(text.endsWith("0" + "}".repeat(50_000))).toBe(true);
  });
});

/**
 * A value the signature says is JSON and the runtime knows is not.
 *
 * The lie is the point of the suite below: `emitOrdered` takes a `JsonValue`,
 * and TypeScript cannot enforce that across a `JSON.parse`, an `any` or an
 * `as`. One assertion, named, rather than eight scattered ones.
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const notJson = (value: unknown): JsonValue => value as JsonValue;

describe("values that are not JSON", () => {
  // A walker that shrugged would emit `{"a":}` — not a JSON document, from the
  // one module in the package that exists to produce exact bytes. Every one of
  // these is this package's `SyntaxError`, with a path.
  test('a function-valued property is an error, not `{"a":}`', () => {
    expect(() => emitOrdered({ a: notJson(() => 1) })).toThrow(SyntaxError);
    expect(() => emitOrdered({ a: notJson(() => 1) })).toThrow(/\(at \$\.a\)/u);
  });

  test("a top-level `undefined` is an error, not the empty string", () => {
    expect(() => emitOrdered(notJson(nothing()))).toThrow(/Cannot emit nothing as JSON \(at \$\)/u);
  });

  test("a bigint is this package's error, not a raw TypeError", () => {
    const thrown = caught(() => emitOrdered({ n: notJson(1n) }));
    expect(thrown).toBeInstanceOf(SyntaxError);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect(thrown.message).toMatch(/\(at \$\.n\)/u);
  });

  test("an object with a toJSON is rejected rather than silently reshaped", () => {
    // `JSON.stringify` would replace it wholesale; walking its keys would emit
    // bytes the stringifier would never have produced, which is the one thing
    // this module must not do.
    expect(() => emitOrdered({ when: notJson(new Date(0)) })).toThrow(/toJSON method/u);
    expect(() => emitOrdered({ when: notJson(new Date(0)) })).toThrow(/\(at \$\.when\)/u);
  });

  test("a symbol inside an array is reported with its index", () => {
    expect(() => emitOrdered({ xs: [1, notJson(Symbol("s"))] })).toThrow(/\(at \$\.xs\[1\]\)/u);
  });
});

/** `undefined`, produced rather than written, so no rule mistakes it for noise. */
function nothing(): unknown {
  return ({} as Record<string, unknown>)["absent"];
}
