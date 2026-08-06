/**
 * The two log families.
 *
 * Oracles: `Types/Log.hs` (the derived family) and `Types/ContextLog.hs` (the
 * hand-written one). Neither has an upstream unit test, so the assertions here
 * are structural: every tag round-trips, every field name is the one the
 * deriving rules produce, and the two deliberate deviations from upstream —
 * an unknown `logs` tag and an unrecognized context frame are *preserved*
 * rather than thrown on — hold.
 */

import { describe, expect, test } from "bun:test";
import { type JsonObject, type JsonValue, encodeKoreJsonValue } from "@kframework-ts/kore";
import { intDv } from "@kframework-ts/kore/prelude";
import {
  type CLContext,
  type LogEntry,
  type LogLine,
  LOG_ORIGINS,
  SIMPLE_CONTEXTS,
  decodeCLContext,
  decodeLogEntries,
  decodeLogEntry,
  decodeLogLine,
  decodeLogLines,
  decodeTimestamp,
  encodeCLContext,
  encodeLogEntry,
  encodeLogLine,
  encodeTimestamp,
  koreJson,
  parseUniqueId,
} from "../src/index.ts";

const term = encodeKoreJsonValue(intDv(0));

//////////////////////
// logs             //
//////////////////////

interface LogRow {
  readonly id: string;
  readonly wire: JsonObject;
  readonly expected: LogEntry;
}

/** One row per tag of `LogEntry` (`Log.hs:51-89`), plus the two result shapes. */
const LOG_ROWS: readonly LogRow[] = [
  {
    id: "rewrite / success (the only tag v0.1.155 emits)",
    wire: {
      tag: "rewrite",
      result: { tag: "success", "rewritten-term": term, substitution: term, "rule-id": "abc1234" },
      origin: "booster",
    },
    expected: {
      tag: "rewrite",
      result: {
        tag: "success",
        rewrittenTerm: koreJson(intDv(0)),
        substitution: koreJson(intDv(0)),
        ruleId: "abc1234",
      },
      origin: "booster",
    },
  },
  {
    id: "rewrite / failure, with the optional rule-id",
    wire: { tag: "rewrite", result: { tag: "failure", reason: "no match", "rule-id": "abc1234" }, origin: "kore-rpc" },
    expected: {
      tag: "rewrite",
      result: { tag: "failure", reason: "no match", ruleId: "abc1234" },
      origin: "kore-rpc",
    },
  },
  {
    id: "rewrite / failure, without a rule-id",
    wire: { tag: "rewrite", result: { tag: "failure", reason: "aborted" }, origin: "proxy" },
    expected: { tag: "rewrite", result: { tag: "failure", reason: "aborted" }, origin: "proxy" },
  },
  {
    id: "simplification",
    wire: {
      tag: "simplification",
      "original-term": term,
      "original-term-index": [0, 2, 1],
      result: { tag: "success", "rule-id": "def5678" },
      origin: "llvm",
    },
    expected: {
      tag: "simplification",
      originalTerm: koreJson(intDv(0)),
      originalTermIndex: [0, 2, 1],
      result: { tag: "success", ruleId: "def5678" },
      origin: "llvm",
    },
  },
  {
    id: "fallback",
    wire: {
      tag: "fallback",
      "original-term": term,
      "rewritten-term": term,
      reason: "aborted",
      "fallback-rule-id": "abc1234",
      "recovery-rule-ids": ["abc1234", "def5678"],
      "recovery-depth": 2,
      origin: "proxy",
    },
    expected: {
      tag: "fallback",
      originalTerm: koreJson(intDv(0)),
      rewrittenTerm: koreJson(intDv(0)),
      reason: "aborted",
      fallbackRuleId: "abc1234",
      recoveryRuleIds: ["abc1234", "def5678"],
      recoveryDepth: 2,
      origin: "proxy",
    },
  },
  {
    id: "processing-time, with a component",
    wire: { tag: "processing-time", component: "booster", time: 0.125 },
    expected: { tag: "processing-time", component: "booster", time: 0.125 },
  },
  {
    id: "processing-time, overall",
    wire: { tag: "processing-time", time: 3 },
    expected: { tag: "processing-time", time: 3 },
  },
];

describe("logs (Types/Log.hs)", () => {
  for (const row of LOG_ROWS) {
    test(`decodes: ${row.id}`, () => {
      expect(decodeLogEntry(row.wire)).toEqual(row.expected);
    });

    test(`round-trips: ${row.id}`, () => {
      expect(encodeLogEntry(row.expected)).toEqual(row.wire);
      expect(decodeLogEntry(encodeLogEntry(row.expected))).toEqual(row.expected);
    });
  }

  test("all four tags decode from one array", () => {
    const entries = decodeLogEntries(LOG_ROWS.map((row) => row.wire));
    expect(entries.map((entry) => entry.tag)).toEqual([
      "rewrite",
      "rewrite",
      "rewrite",
      "simplification",
      "fallback",
      "processing-time",
      "processing-time",
    ]);
  });

  test("every LogOrigin is accepted (Log.hs:23)", () => {
    expect(LOG_ORIGINS).toEqual(["kore-rpc", "booster", "llvm", "proxy"]);
    for (const origin of LOG_ORIGINS) {
      const entry = decodeLogEntry({ tag: "rewrite", result: { tag: "failure", reason: "r" }, origin });
      expect(entry.tag === "rewrite" && entry.origin).toBe(origin);
    }
    expect(() => decodeLogEntry({ tag: "rewrite", result: { tag: "failure", reason: "r" }, origin: "kore" })).toThrow(
      'Unknown log origin: "kore"',
    );
  });

  //////////////////////
  // The deviation    //
  //////////////////////

  test("an unknown tag is preserved, not thrown on (pyk raises here)", () => {
    const wire = { tag: "future-thing", whatever: [1, 2, 3], nested: { a: 1 } };
    const entry = decodeLogEntry(wire);
    expect(entry).toEqual({ tag: "unknown-log-entry", logTag: "future-thing", raw: wire });
    // And it re-encodes to exactly the bytes it came from.
    expect(encodeLogEntry(entry)).toEqual(wire);
  });

  test("an unknown tag inside an array does not lose its neighbours", () => {
    const entries = decodeLogEntries([
      { tag: "rewrite", result: { tag: "failure", reason: "r" }, origin: "booster" },
      { tag: "future-thing" },
      { tag: "processing-time", time: 1 },
    ]);
    expect(entries.map((entry) => entry.tag)).toEqual(["rewrite", "unknown-log-entry", "processing-time"]);
  });

  test("but structure we understand is still strict", () => {
    expect(() => decodeLogEntry({ tag: "rewrite", origin: "booster" })).toThrow(
      'rewrite is missing the field "result"',
    );
    expect(() => decodeLogEntry({ tag: "rewrite", result: { tag: "maybe" }, origin: "booster" })).toThrow(
      'Expected a "success" or "failure" rewrite result, got "maybe"',
    );
    expect(() => decodeLogEntry({ tag: "rewrite", result: { tag: "success" }, origin: "booster" })).toThrow(
      'success is missing the field "rule-id"',
    );
    expect(() => decodeLogEntry({ tag: 7 })).toThrow("Expected a string log entry tag, got 7");
  });

  test("recovery-rule-ids is NonEmpty (Log.hs:72)", () => {
    const base = {
      tag: "fallback",
      reason: "r",
      "fallback-rule-id": "abc1234",
      "recovery-depth": 1,
      origin: "proxy",
    };
    expect(() => decodeLogEntry({ ...base, "recovery-rule-ids": [] })).toThrow(
      "fallback requires at least one recovery rule id",
    );
    // Absent is fine — the field itself is `Maybe`.
    expect(decodeLogEntry(base)).toEqual({
      tag: "fallback",
      reason: "r",
      fallbackRuleId: "abc1234",
      recoveryDepth: 1,
      origin: "proxy",
    });
  });

  test("recovery-depth is a Depth, hence non-negative", () => {
    expect(() =>
      decodeLogEntry({
        tag: "fallback",
        reason: "r",
        "fallback-rule-id": "a",
        "recovery-depth": -1,
        origin: "proxy",
      }),
    ).toThrow("Expected a non-negative integer, got -1");
  });
});

//////////////////////
// ContextLog       //
//////////////////////

describe("haskell-log-entries: contexts (ContextLog.hs)", () => {
  test("the 30 SimpleContext values, with the three spelling quirks", () => {
    expect(SIMPLE_CONTEXTS).toHaveLength(30);
    // `camelTo2 '-' . drop 3` on `CtxSMT`, `CtxLlvm`, `CtxKoreTerm`.
    expect(SIMPLE_CONTEXTS).toContain("smt");
    expect(SIMPLE_CONTEXTS).toContain("llvm");
    expect(SIMPLE_CONTEXTS).toContain("kore-term");
    expect(SIMPLE_CONTEXTS).toContain("get-model");
    expect(SIMPLE_CONTEXTS).toContain("add-module");
  });

  test("every SimpleContext decodes as a plain string and round-trips", () => {
    for (const name of SIMPLE_CONTEXTS) {
      const context = decodeCLContext(name);
      expect(context).toEqual({ tag: "simple", context: name });
      expect(encodeCLContext(context)).toBe(name);
    }
  });

  test("id contexts are single-key objects carrying a UniqueId", () => {
    const short = "abc1234";
    const long = "a".repeat(64);
    const cases: readonly [string, string, CLContext][] = [
      ["rewrite", short, { tag: "id", kind: "rewrite", id: { kind: "short", value: short } }],
      ["simplification", long, { tag: "id", kind: "simplification", id: { kind: "long", value: long } }],
      ["function", "UNKNOWN", { tag: "id", kind: "function", id: { kind: "unknown", value: "UNKNOWN" } }],
      ["ceil", short, { tag: "id", kind: "ceil", id: { kind: "short", value: short } }],
      ["term", short, { tag: "id", kind: "term", id: { kind: "short", value: short } }],
    ];
    for (const [key, payload, expected] of cases) {
      const wire = { [key]: payload };
      expect(decodeCLContext(wire)).toEqual(expected);
      expect(encodeCLContext(expected)).toEqual(wire);
    }
  });

  test("name contexts carry a plain string", () => {
    for (const key of ["hook", "request", "cached"] as const) {
      const wire = { [key]: "INT.add" };
      const context = decodeCLContext(wire);
      expect(context).toEqual({ tag: "name", kind: key, name: "INT.add" });
      expect(encodeCLContext(context)).toEqual(wire);
    }
  });

  test("parseUniqueId is the 7 / 64 / UNKNOWN rule (ContextLog.hs:119-124)", () => {
    expect(parseUniqueId("abc1234")).toEqual({ kind: "short", value: "abc1234" });
    expect(parseUniqueId("f".repeat(64))?.kind).toBe("long");
    expect(parseUniqueId("UNKNOWN")).toEqual({ kind: "unknown", value: "UNKNOWN" });
    expect(parseUniqueId("abc")).toBeUndefined();
    expect(parseUniqueId("")).toBeUndefined();
  });

  test("an unrecognized context is kept raw, not thrown on (upstream fails here)", () => {
    const strays: readonly JsonValue[] = [
      "not-a-context",
      { rewrite: "too-short" },
      { unknown_key: "x" },
      { a: 1, b: 2 },
      [1, 2],
      42,
      null,
    ];
    for (const wire of strays) {
      const context = decodeCLContext(wire);
      expect(context.tag).toBe("raw");
      expect(encodeCLContext(context)).toEqual(wire);
    }
  });
});

describe("haskell-log-entries: timestamps (ContextLog.hs:235-268)", () => {
  test("the human-readable form, with and without a fraction", () => {
    expect(decodeTimestamp("2024-03-01T12:34:56")).toEqual({ seconds: 1709296496, nanos: 0 });
    expect(decodeTimestamp("2024-03-01T12:34:56.125")).toEqual({ seconds: 1709296496, nanos: 125_000_000 });
    expect(decodeTimestamp("2024-03-01T12:34:56.000000001")).toEqual({ seconds: 1709296496, nanos: 1 });
  });

  test("emission is %Y-%m-%dT%H:%M:%S%Q: no fraction for whole seconds, no trailing zeros", () => {
    expect(encodeTimestamp({ seconds: 1709296496, nanos: 0 })).toBe("2024-03-01T12:34:56");
    expect(encodeTimestamp({ seconds: 1709296496, nanos: 125_000_000 })).toBe("2024-03-01T12:34:56.125");
    expect(encodeTimestamp({ seconds: 1709296496, nanos: 1 })).toBe("2024-03-01T12:34:56.000000001");
  });

  test("round-trips through both directions", () => {
    for (const time of [
      { seconds: 0, nanos: 0 },
      { seconds: 1709296496, nanos: 999_999_999 },
      { seconds: 1, nanos: 500_000_000 },
    ]) {
      expect(decodeTimestamp(encodeTimestamp(time))).toEqual(time);
    }
  });

  test("a JSON number is seconds with a fractional remainder (fromNumeric)", () => {
    expect(decodeTimestamp(1709296496)).toEqual({ seconds: 1709296496, nanos: 0 });
    expect(decodeTimestamp(1.5)).toEqual({ seconds: 1, nanos: 500_000_000 });
  });

  test("a bare digit string is read as SECONDS — upstream's misnamed fromNanos", () => {
    // `fromNanos` (ContextLog.hs:250-253) is documented as nanoseconds and
    // implemented as `fromNumeric`, i.e. seconds.  Transcribed as implemented.
    expect(decodeTimestamp("1709296496")).toEqual({ seconds: 1709296496, nanos: 0 });
  });

  test("anything else is a decode error", () => {
    expect(() => decodeTimestamp("not a time")).toThrow('Bad timestamp: "not a time"');
    expect(() => decodeTimestamp(true)).toThrow("Expected a timestamp, got true");
  });

  test("unpadded components parse — `%m`/`%d`/`%H`/`%M`/`%S` take one OR two digits", () => {
    // `parseTimeM defaultTimeLocale "%Y-%m-%dT%H:%M:%S%Q"` accepts an
    // unpadded number for every component but the year, so a log line written
    // by anything but `formatTime` still decodes.
    expect(decodeTimestamp("2024-1-2T3:4:5")).toEqual(decodeTimestamp("2024-01-02T03:04:05"));
    expect(decodeTimestamp("2024-1-2T3:4:5.5")).toEqual(decodeTimestamp("2024-01-02T03:04:05.5"));
  });

  test("a leap second (`%S` = 60) is accepted, rolling into the next minute", () => {
    expect(decodeTimestamp("2016-12-31T23:59:60")).toEqual(decodeTimestamp("2017-01-01T00:00:00"));
  });

  test("years 0000-0099 survive: `Date.UTC`'s two-digit-year rule is not used", () => {
    // `Date.UTC(99, 0, 1)` is 1999, so decoding must not use its
    // two-digit-year rule.
    expect(encodeTimestamp(decodeTimestamp("0099-01-01T00:00:00"))).toBe("0099-01-01T00:00:00");
    expect(encodeTimestamp(decodeTimestamp("0001-02-03T04:05:06"))).toBe("0001-02-03T04:05:06");
    expect(decodeTimestamp("0099-01-01T00:00:00")).not.toEqual(decodeTimestamp("1999-01-01T00:00:00"));
  });

  test("a non-finite number is this package's decode error, not {Infinity, NaN}", () => {
    // `1e309` parses to `Infinity`; accepting it would create
    // `{seconds: Infinity, nanos: NaN}`, which encodes to "Invalid Date" and
    // equals nothing, including itself.
    // Built rather than written as a literal, because that is how it arrives:
    // `JSON.parse('{"timestamp":1e309}')` yields `Infinity`.
    const overflowed = Number("1e309");
    expect(() => decodeTimestamp(overflowed)).toThrow(SyntaxError);
    expect(() => decodeTimestamp(overflowed)).toThrow(/Expected a number.*\(at timestamp\)/su);
    expect(() => decodeTimestamp(Number.NaN)).toThrow(SyntaxError);
    expect(() => decodeTimestamp(-Infinity)).toThrow(SyntaxError);
    // And the digit-string branch overflows the same way.
    expect(() => decodeTimestamp("9".repeat(400))).toThrow(SyntaxError);
  });
});

describe("haskell-log-entries: LogLine (ContextLog.hs:221-264)", () => {
  const LINES: readonly [string, JsonObject, LogLine][] = [
    [
      "a text message with a full context stack",
      {
        timestamp: "2024-03-01T12:34:56.125",
        context: ["booster", "execute", { rewrite: "abc1234" }, { hook: "INT.add" }],
        message: "applied",
      },
      {
        timestamp: { seconds: 1709296496, nanos: 125_000_000 },
        context: [
          { tag: "simple", context: "booster" },
          { tag: "simple", context: "execute" },
          { tag: "id", kind: "rewrite", id: { kind: "short", value: "abc1234" } },
          { tag: "name", kind: "hook", name: "INT.add" },
        ],
        message: { tag: "text", text: "applied" },
      },
    ],
    [
      "no timestamp, an object message (a KORE term, say)",
      { context: ["kore-term"], message: term },
      {
        context: [{ tag: "simple", context: "kore-term" }],
        message: { tag: "value", value: term },
      },
    ],
    [
      "an array message",
      { context: [], message: [1, 2, 3] },
      { context: [], message: { tag: "value", value: [1, 2, 3] } },
    ],
    [
      "a null message",
      { context: ["info"], message: null },
      { context: [{ tag: "simple", context: "info" }], message: { tag: "value", value: null } },
    ],
  ];

  for (const [id, wire, expected] of LINES) {
    test(`decodes: ${id}`, () => {
      expect(decodeLogLine(wire)).toEqual(expected);
    });

    test(`round-trips: ${id}`, () => {
      expect(encodeLogLine(expected)).toEqual(wire);
    });
  }

  test("context and message are required; only timestamp is optional", () => {
    expect(() => decodeLogLine({ context: [] })).toThrow('LogLine is missing the field "message"');
    expect(() => decodeLogLine({ message: "x" })).toThrow('LogLine is missing the field "context"');
  });

  test("a number or a boolean message is rejected (ContextLog.hs:214-215)", () => {
    expect(() => decodeLogLine({ context: [], message: 3 })).toThrow(
      "Expected an object, array, or string message, got 3",
    );
  });

  test("emission order is timestamp, context, message (ContextLog.hs:256-262)", () => {
    const keys = Object.keys(
      encodeLogLine({
        timestamp: { seconds: 0, nanos: 0 },
        context: [],
        message: { tag: "text", text: "x" },
      }),
    );
    expect(keys).toEqual(["timestamp", "context", "message"]);
  });

  test("decodeLogLines reads a whole bundle", () => {
    const lines = decodeLogLines([
      { context: ["proxy"], message: "one" },
      { context: ["kore"], message: "two" },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.message).toEqual({ tag: "text", text: "two" });
  });
});
