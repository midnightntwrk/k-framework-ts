/** Runtime schemas for the JSON-only kore-rpc protocol boundaries. */

import { describe, expect, test } from "bun:test";
import {
  AddModuleParamsWireSchema,
  AddModuleResultSchema,
  AddModuleResultWireSchema,
  CLContextSchema,
  CLMessageSchema,
  IdCLContextWireSchema,
  JsonRpcErrorObjectWireSchema,
  JsonRpcResponseSchema,
  LogLineSchema,
  LogLineWireSchema,
  NameCLContextWireSchema,
  SimpleCLContextWireSchema,
  SystemTimeSchema,
} from "../src/index.ts";
import { ServerExitSchema } from "../src/server.ts";
import { readFixture, readFixtureJson } from "./fixtures.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("expected fixture object");
  return value;
}

describe("runtime schemas", () => {
  test("validates the recorded add-module request and decodes its response", () => {
    const params = readFixtureJson("kore-rpc-server", "add-module", "add", "params.json");
    const response = record(JSON.parse(readFixture("kore-rpc-server", "add-module", "add", "response.golden")));

    expect(AddModuleParamsWireSchema.parse(params).module).toContain("module NEW");
    expect(AddModuleResultWireSchema.parse(record(response.result))).toEqual({
      module: "m8e723e34b156f187e7cce8658dbb513244788a1ab81c1f496b909b1a2d1cc0c3",
    });
    expect(AddModuleResultSchema.parse(record(response.result))).toEqual({
      module: "m8e723e34b156f187e7cce8658dbb513244788a1ab81c1f496b909b1a2d1cc0c3",
    });
  });

  test("decodes recorded success and error envelopes without changing error normalization", () => {
    const success = JsonRpcResponseSchema.parse(readFixture("kore-rpc-server", "execute", "logs", "response.golden"));
    expect(success.kind).toBe("result");

    const error = JsonRpcResponseSchema.parse(readFixture("classification", "add-module.error.response"));
    expect(error).toMatchObject({ kind: "error", id: 4, error: { code: 2, message: "Could not verify pattern" } });
    expect(
      JsonRpcResponseSchema.parse({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "x", data: null } }),
    ).toEqual({
      kind: "error",
      id: 1,
      error: { code: -1, message: "x" },
    });
  });

  test("preserves an unfamiliar context frame while transforming timestamp and message", () => {
    const wire = {
      timestamp: "2024-03-01T12:34:56.125",
      context: ["booster", { rewrite: "abc1234" }, { future: [1, 2] }],
      message: { detail: "kept as JSON" },
    };

    expect(LogLineSchema.parse(wire)).toEqual({
      timestamp: { seconds: 1709296496, nanos: 125_000_000 },
      context: [
        { tag: "simple", context: "booster" },
        { tag: "id", kind: "rewrite", id: { kind: "short", value: "abc1234" } },
        { tag: "raw", raw: { future: [1, 2] } },
      ],
      message: { tag: "value", value: { detail: "kept as JSON" } },
    });
    expect(LogLineSchema.parse({ timestamp: null, context: [], message: "without time" })).toEqual({
      context: [],
      message: { tag: "text", text: "without time" },
    });
    expect(CLContextSchema.parse({ rewrite: "too-short" })).toEqual({ tag: "raw", raw: { rewrite: "too-short" } });
    expect(CLContextSchema.parse("booster")).toEqual({ tag: "simple", context: "booster" });
    expect(CLContextSchema.parse({ rewrite: "abc1234" })).toEqual({
      tag: "id",
      kind: "rewrite",
      id: { kind: "short", value: "abc1234" },
    });
    expect(CLContextSchema.parse({ hook: "INT.add" })).toEqual({ tag: "name", kind: "hook", name: "INT.add" });
    expect(CLContextSchema.parse({ rewrite: "abc1234", extension: true })).toEqual({
      tag: "raw",
      raw: { rewrite: "abc1234", extension: true },
    });
    expect(SimpleCLContextWireSchema.parse("booster")).toEqual({ tag: "simple", context: "booster" });
    expect(IdCLContextWireSchema.safeParse({ rewrite: "short" }).success).toBe(false);
    expect(NameCLContextWireSchema.parse({ hook: "INT.add" })).toEqual({ tag: "name", kind: "hook", name: "INT.add" });
    expect(CLMessageSchema.parse(["structured", "message"])).toEqual({
      tag: "value",
      value: ["structured", "message"],
    });
    expect(CLMessageSchema.safeParse(false).success).toBe(false);
    expect(SystemTimeSchema.safeParse({ seconds: 1, nanos: 2 }).success).toBe(true);
    expect(SystemTimeSchema.safeParse({ seconds: "1", nanos: 2 }).success).toBe(false);
  });

  test("rejects malformed nested wire values before they reach a decoder", () => {
    expect(
      AddModuleResultWireSchema.safeParse({
        module: "M",
        "haskell-log-entries": [{ context: "not-an-array", message: "x" }],
      }).success,
    ).toBeFalse();
    expect(LogLineWireSchema.safeParse({ context: ["booster"], message: true }).success).toBeFalse();
    expect(LogLineSchema.safeParse({ context: [], message: true }).success).toBeFalse();
    expect(JsonRpcErrorObjectWireSchema.safeParse({ code: 1, message: "x", data: true }).success).toBe(true);
    expect(JsonRpcErrorObjectWireSchema.safeParse({ code: 1.5, message: "x" }).success).toBe(false);
    expect(() => JsonRpcResponseSchema.parse({ id: 1, error: { code: "bad", message: "x" } })).toThrow(SyntaxError);
  });

  test("describes the public process-handle exit seam", () => {
    expect(ServerExitSchema.parse({ code: 0, signal: null })).toEqual({ code: 0, signal: null });
  });
});
