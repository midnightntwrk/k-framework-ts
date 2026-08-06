/**
 * The hint grammar: all eight event kinds, the three magics, the version
 * assertion, the empty trace, and the streaming parser's agreement with the
 * whole-buffer one.
 *
 * Synthetic bytes here, real traces in `reference.test.ts` — the two are
 * complementary.  The fixtures cover the seven event kinds a normal run
 * produces; only a `pattern_matching_failure` (`Decision.cpp:931`, emitted when
 * a function's decision tree falls through) needs writing by hand, because
 * producing one live means a run that aborts.
 */

import { describe, expect, test } from "bun:test";
import { koreText } from "@kframework-ts/kore";

import { ProofTraceVersionError } from "../src/errors.ts";
import { parseProofTrace, proofTraceEvents, PROOF_TRACE_VERSION, SENTINELS } from "../src/events.ts";
import { KoreHeader } from "../src/header.ts";
import { caught } from "./caught.ts";
import {
  ByteWriter,
  writeConfig,
  writeFunction,
  writeFunctionExit,
  writeHeader,
  writeHook,
  writePatternMatchingFailure,
  writeRule,
  writeSideConditionEnter,
  writeSideConditionExit,
  writeTraceHeader,
} from "./encode.ts";
import { runHeader, runHints } from "./support.ts";

const HEADER = KoreHeader.parse(
  writeHeader(
    [{ name: "SortInt" }],
    [
      { name: "Lblz", arity: 0 }, // 0
      { name: "Lbls", arity: 1 }, // 1
      { name: "\\dv", sortParams: [0], arity: 1 }, // 2
    ],
  ),
);

const Z = { tag: 0 } as const;
const S = { tag: 1, args: [Z] } as const;

/** A stream with one of every event kind, in a shape the reference would accept. */
function everyEvent(): Uint8Array {
  const out = writeTraceHeader(new ByteWriter());
  writeHook(out, "INT.add", "Lbl'UndsPlus'Int'Unds'", "0:1", [Z, S], { tag: 2, args: [{ string: "3" }] });
  writeFunction(out, "LblinitKCell", "0");
  writeRule(out, 7, [["VarInit", S]]);
  writeFunctionExit(out, 7, false);
  writeConfig(out, Z);
  writeSideConditionEnter(out, 11, [["VarN", Z]]);
  writeSideConditionExit(out, 11, false);
  writePatternMatchingFailure(out, "Lblpartial");
  writeRule(out, 12, [
    ["VarA", Z],
    ["VarB", S],
  ]);
  writeConfig(out, S);
  return out.build();
}

describe("the sentinel table", () => {
  test("is the ten values `detail::word` is applied to", () => {
    // Pinned as a table because a silent renumbering upstream would otherwise
    // show up as "unknown event sentinel" on an unrelated trace.
    expect(SENTINELS).toEqual({
      config: 0xff,
      functionEnter: 0xdd,
      functionEnd: 0x11,
      hook: 0xaa,
      hookResult: 0xbb,
      rule: 0x22,
      sideConditionEnter: 0xee,
      sideConditionExit: 0x33,
      patternMatchingFailure: 0x44,
      functionExit: 0x55,
    });
    expect(new Set(Object.values(SENTINELS)).size).toBe(10);
  });
});

describe("parseProofTrace", () => {
  test("splits pre-trace, initial config and trace at the first config event", () => {
    const trace = parseProofTrace(everyEvent(), HEADER);
    expect(trace.version).toBe(PROOF_TRACE_VERSION);
    expect(trace.kind).toBe("hint");
    expect(trace.preTrace.map((event) => event.tag)).toEqual(["hook", "function", "rule", "function-exit"]);
    expect(trace.initialConfig?.tag).toBe("config");
    expect(trace.trace.map((event) => event.tag)).toEqual([
      "side-condition-enter",
      "side-condition-exit",
      "pattern-matching-failure",
      "rule",
      "config",
    ]);
  });

  test("every field of every event kind survives the round trip", () => {
    const trace = parseProofTrace(everyEvent(), HEADER);
    const hook = trace.preTrace[0];
    expect(hook).toMatchObject({
      tag: "hook",
      name: "INT.add",
      symbolName: "Lbl'UndsPlus'Int'Unds'",
      relativePosition: "0:1",
    });
    expect(hook?.tag === "hook" && hook.args.map((arg) => koreText(arg.term))).toEqual([
      "Lblz{}()",
      "Lbls{}(Lblz{}())",
    ]);
    expect(hook?.tag === "hook" && koreText(hook.result)).toBe('\\dv{SortInt{}}("3")');

    expect(trace.preTrace[1]).toEqual({ tag: "function", name: "LblinitKCell", relativePosition: "0", args: [] });
    expect(trace.preTrace[3]).toEqual({ tag: "function-exit", ordinal: 7, isTail: false });
    expect(trace.trace[1]).toEqual({ tag: "side-condition-exit", ordinal: 11, result: false });
    expect(trace.trace[2]).toEqual({ tag: "pattern-matching-failure", functionName: "Lblpartial" });

    const rule = trace.trace[3];
    expect(rule?.tag).toBe("rule");
    expect(rule?.tag === "rule" && rule.ordinal).toBe(12);
    expect(rule?.tag === "rule" && rule.substitution.map((binding) => binding.name)).toEqual(["VarA", "VarB"]);
  });

  test("the substitution keeps wire order, which is not name order", () => {
    // The reference prints name-sorted because `substitution_` is a
    // `std::map`; the *bytes* are in whatever order the decision tree bound
    // them, and a reader that silently sorted would lose that.
    const out = writeTraceHeader(new ByteWriter());
    writeConfig(out, Z);
    writeRule(out, 1, [
      ["VarZ", Z],
      ["VarA", Z],
    ]);
    const trace = parseProofTrace(out.build(), HEADER);
    const rule = trace.trace[0];
    expect(rule?.tag === "rule" && rule.substitution.map((binding) => binding.name)).toEqual(["VarZ", "VarA"]);
  });

  test("a real run's rule events carry a substitution for every variable", () => {
    const trace = parseProofTrace(runHints("addRewrite"), runHeader("addRewrite"));
    const rules = trace.trace.filter((event) => event.tag === "rule");
    expect(rules.length).toBe(9);
    // R4, on real bytes: every step of the run records what it matched.
    expect(rules.every((rule) => rule.substitution.length > 0)).toBe(true);
    expect(rules.every((rule) => rule.substitution.every((binding) => binding.name.startsWith("Var")))).toBe(true);
  });

  test("the three magics are all accepted, and nothing else is", () => {
    for (const kind of ["HINT", "PTRC", "CHNK"] as const) {
      const out = writeTraceHeader(new ByteWriter(), kind);
      if (kind !== "CHNK") writeConfig(out, Z);
      writeRule(out, 1, []);
      const trace = parseProofTrace(out.build(), HEADER);
      expect(trace.kind).toBe(kind === "HINT" ? "hint" : kind === "PTRC" ? "pre-trace" : "chunk");
      // A CHNK stream has no header section at all (`ProofTraceParser.h:719`):
      // it never looks for an initial configuration, so everything is `trace`.
      expect(trace.initialConfig === undefined).toBe(kind === "CHNK");
      expect(trace.trace[0]?.tag).toBe("rule");
    }
    expect(() => parseProofTrace(new ByteWriter().raw("NOPE").u32(13).build(), HEADER)).toThrow(
      /expected the magic HINT, PTRC or CHNK/,
    );
  });

  test("the version is asserted, not assumed", () => {
    const bytes = writeTraceHeader(new ByteWriter(), "HINT", 12).build();
    const error = caught(() => parseProofTrace(bytes, HEADER), ProofTraceVersionError);
    expect(error.stream).toBe("hints");
    expect(error.expected).toBe(PROOF_TRACE_VERSION);
    expect(error.found).toBe(12);
  });

  test("a header-only stream is the empty trace, not an error — R10", () => {
    // Measured: an interpreter whose *input* fails to parse writes exactly
    // these eight bytes and exits non-zero.  R10 asks that such a run produce
    // an empty trace rather than a missing one, and the backend obliges.
    const trace = parseProofTrace(writeTraceHeader(new ByteWriter()).build(), HEADER);
    expect(trace).toMatchObject({ preTrace: [], initialConfig: undefined, trace: [] });
  });

  test("a truncated event names the byte it died on", () => {
    const complete = (() => {
      const out = writeTraceHeader(new ByteWriter());
      writeConfig(out, Z);
      writeRule(out, 3, [["VarN", S]]);
      return out.build();
    })();
    expect(() => parseProofTrace(complete.subarray(0, complete.length - 2), HEADER)).toThrow(/at byte \d+/);
  });

  test("an argument list with no terminator is reported, not looped on", () => {
    // `parse_argument` requires the next byte to be `\x7F` (`:648`); without
    // that guard a missing `WORD(0x11)` is an infinite loop.
    const out = writeTraceHeader(new ByteWriter());
    writeConfig(out, Z);
    out.word(SENTINELS.functionEnter).cstring("Lblf").cstring("0").u8(0x22);
    expect(() => parseProofTrace(out.build(), HEADER)).toThrow(
      /Expected an argument term or the function end sentinel/,
    );
  });

  test("an unknown sentinel is named rather than skipped", () => {
    const out = writeTraceHeader(new ByteWriter());
    writeConfig(out, Z);
    out.word(0x99);
    expect(() => parseProofTrace(out.build(), HEADER)).toThrow(/Unknown event sentinel \(at byte 25\)/);
  });
});

describe("proofTraceEvents", () => {
  test("yields exactly what parseProofTrace collects, phase for phase", () => {
    const bytes = everyEvent();
    const streamed = [...proofTraceEvents(bytes, HEADER)];
    const whole = parseProofTrace(bytes, HEADER);
    expect(streamed.filter((item) => item.phase === "pre-trace").map((item) => item.event)).toEqual([
      ...whole.preTrace,
    ]);
    expect(streamed.filter((item) => item.phase === "initial-config").map((item) => item.event)).toEqual(
      whole.initialConfig === undefined ? [] : [whole.initialConfig],
    );
    expect(streamed.filter((item) => item.phase === "trace").map((item) => item.event)).toEqual([...whole.trace]);
  });

  test("agrees with the whole-buffer parse on all three real runs", () => {
    for (const run of ["addRewrite", "guardedBig", "guardedSmall"] as const) {
      const bytes = runHints(run);
      const header = runHeader(run);
      const whole = parseProofTrace(bytes, header);
      const streamed = [...proofTraceEvents(bytes, header)];
      expect(streamed.length).toBe(whole.preTrace.length + 1 + whole.trace.length);
    }
  });

  test("stops without consuming the rest when the caller stops", () => {
    const events = proofTraceEvents(runHints("guardedBig"), runHeader("guardedBig"));
    const first = events.next();
    expect(first.done).toBe(false);
    events.return(undefined);
    expect(events.next().done).toBe(true);
  });
});
