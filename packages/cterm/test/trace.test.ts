/**
 * The trace assembler, entirely offline: the join is a dictionary lookup and
 * the projection is a string, so nothing here needs a backend.
 *
 * The `logs` payloads below are the shapes a live server was *measured*
 * producing (see `src/trace.ts`'s header), plus the substitution-bearing shape
 * the protocol type admits and no v0.1.155 server emits — the second is how
 * the R4 half stays exercised while the emission is what it is.
 */

import { describe, expect, test } from "bun:test";

import {
  Atts,
  KAtt,
  KDefinition,
  attEntry,
  kapply,
  kflatmodule,
  krewrite,
  krule,
  ktoken,
  kvariable,
} from "@kframework-ts/kast";
import { mlAnd, mlEquals } from "@kframework-ts/kast/prelude/ml";
import { indexDefinition, parseDefinition } from "@kframework-ts/kore";
import { app, evar, sortApp, top } from "@kframework-ts/kore";
import { koreJson, type LogEntry, type LogOrigin } from "@kframework-ts/kore-rpc";

import {
  assembleTrace,
  filterTrace,
  traceRuleCounts,
  traceRuleIndexFromKast,
  traceRuleIndexFromKore,
  traceToJsonl,
  type TraceContext,
} from "../src/trace.ts";

const A_TO_B = "6c1e1a1f0b6f7a5c";
const B_TO_C = "9d2f3e4a5b6c7d8e";

/** Two rules: one fully attributed, one carrying only a unique id. */
const DEFINITION = new KDefinition("RULES", [
  kflatmodule("RULES", {
    sentences: [
      krule(krewrite(kapply("a"), kapply("b")), {
        att: new KAtt([
          attEntry(Atts.UNIQUE_ID, A_TO_B),
          attEntry(Atts.LABEL, "a-to-b"),
          attEntry(Atts.SOURCE, "/k/rules.k"),
          attEntry(Atts.LOCATION, [12, 5, 12, 30] as const),
        ]),
      }),
      krule(krewrite(kapply("b"), kapply("c")), {
        att: new KAtt([attEntry(Atts.UNIQUE_ID, B_TO_C)]),
      }),
    ],
  }),
]);

/** As a server writes it: rule id, origin, and nothing else. */
function rewrite(ruleId: string, origin: LogOrigin = "booster"): LogEntry {
  return { tag: "rewrite", result: { tag: "success", ruleId }, origin };
}

const CONTEXT: TraceContext = { rules: traceRuleIndexFromKast(DEFINITION) };

describe("traceRuleIndexFromKast", () => {
  test("indexes every module's uniquely-identified sentences with label, source, and location", () => {
    const index = traceRuleIndexFromKast(DEFINITION);
    expect(index.get(A_TO_B)).toEqual({
      label: "a-to-b",
      source: "/k/rules.k",
      location: [12, 5, 12, 30],
      module: "RULES",
    });
    // No `label` attribute, so `KSentence.label` falls back to the unique id;
    // no Source/Location pair, so both are null rather than absent.
    expect(index.get(B_TO_C)).toEqual({ label: B_TO_C, source: null, location: null, module: "RULES" });
    expect(index.has("nosuchid")).toBe(false);
  });

  test("keeps the first declaration when two modules share a unique id", () => {
    const shared = new KDefinition("FIRST", [
      kflatmodule("FIRST", {
        sentences: [
          krule(kapply("x"), { att: new KAtt([attEntry(Atts.UNIQUE_ID, "dup"), attEntry(Atts.LABEL, "first")]) }),
        ],
      }),
      kflatmodule("SECOND", {
        sentences: [
          krule(kapply("y"), { att: new KAtt([attEntry(Atts.UNIQUE_ID, "dup"), attEntry(Atts.LABEL, "second")]) }),
        ],
      }),
    ]);
    expect(traceRuleIndexFromKast(shared).get("dup")).toMatchObject({ label: "first", module: "FIRST" });
  });
});

describe("traceRuleIndexFromKore", () => {
  test("reads the same identity off definition.kore's axiom attributes", () => {
    const text = `
      []
      module RULES
        axiom{R} \\top{R}() [
          UNIQUE'Unds'ID{}("${A_TO_B}"),
          label{}("RULES.a-to-b"),
          org'Stop'kframework'Stop'attributes'Stop'Source{}("Source(/k/rules.k)"),
          org'Stop'kframework'Stop'attributes'Stop'Location{}("Location(12,5,12,30)")
        ]
        axiom{R} \\top{R}() [UNIQUE'Unds'ID{}("${B_TO_C}")]
        axiom{R} \\top{R}() []
      endmodule []
    `;
    const index = traceRuleIndexFromKore(indexDefinition(parseDefinition(text)));
    expect(index.size).toBe(2);
    expect(index.get(A_TO_B)).toEqual({
      // Module-qualified in KORE, bare in KAST — the artifacts differ, and the
      // raw value is what a reader can grep the file for.
      label: "RULES.a-to-b",
      source: "/k/rules.k",
      location: [12, 5, 12, 30],
      module: "RULES",
    });
    expect(index.get(B_TO_C)).toEqual({ label: B_TO_C, source: null, location: null, module: "RULES" });
  });

  test("indexes a lazily-parsed definition identically", () => {
    // The function's own header recommends `lazyAxioms` for a big
    // `definition.kore`; a `LazyAxiom` still carries its attributes, which is
    // all the index reads. Both eager `Axiom` and `LazyAxiom` entries are
    // indexed.
    const text = `
      []
      module RULES
        axiom{R} \\top{R}() [
          UNIQUE'Unds'ID{}("${A_TO_B}"),
          label{}("RULES.a-to-b"),
          org'Stop'kframework'Stop'attributes'Stop'Source{}("Source(/k/rules.k)"),
          org'Stop'kframework'Stop'attributes'Stop'Location{}("Location(12,5,12,30)")
        ]
        axiom{R} \\top{R}() [UNIQUE'Unds'ID{}("${B_TO_C}")]
      endmodule []
    `;
    const eager = traceRuleIndexFromKore(indexDefinition(parseDefinition(text)));
    const lazy = traceRuleIndexFromKore(indexDefinition(parseDefinition(text, { lazyAxioms: true })));
    expect(lazy.size).toBe(2);
    expect(lazy).toEqual(eager);
  });
});

describe("assembleTrace", () => {
  test("attributes every rewrite entry, in order, and marks the unresolvable ones", () => {
    const trace = assembleTrace([rewrite(A_TO_B), rewrite(B_TO_C, "kore-rpc"), rewrite("UNKNOWN")], CONTEXT);
    expect(trace).toEqual([
      {
        index: 0,
        outcome: "success",
        ruleId: A_TO_B,
        resolved: true,
        label: "a-to-b",
        source: "/k/rules.k",
        location: [12, 5, 12, 30],
        module: "RULES",
        origin: "booster",
        reason: null,
        substitution: null,
      },
      {
        index: 1,
        outcome: "success",
        ruleId: B_TO_C,
        resolved: true,
        label: B_TO_C,
        source: null,
        location: null,
        module: "RULES",
        origin: "kore-rpc",
        reason: null,
        substitution: null,
      },
      {
        index: 2,
        outcome: "success",
        ruleId: "UNKNOWN",
        resolved: false,
        label: null,
        source: null,
        location: null,
        module: null,
        origin: "booster",
        reason: null,
        substitution: null,
      },
    ]);
  });

  test("records a failure entry with its reason and keeps a rule-less one attributable", () => {
    const logs: readonly LogEntry[] = [
      {
        tag: "rewrite",
        result: { tag: "failure", reason: "Uncertain about a condition in rule", ruleId: A_TO_B },
        origin: "booster",
      },
      { tag: "rewrite", result: { tag: "failure", reason: "No applicable rules found" }, origin: "booster" },
    ];
    const trace = assembleTrace(logs, CONTEXT);
    expect(trace.map((entry) => [entry.outcome, entry.ruleId, entry.label, entry.reason])).toEqual([
      ["failure", A_TO_B, "a-to-b", "Uncertain about a condition in rule"],
      ["failure", null, null, "No applicable rules found"],
    ]);
  });

  test("skips the log tags that are not rewrite steps, and absent logs assemble empty", () => {
    const logs: readonly LogEntry[] = [
      { tag: "processing-time", time: 0.25 },
      rewrite(A_TO_B),
      { tag: "unknown-log-entry", logTag: "from-the-future", raw: { tag: "from-the-future" } },
    ];
    expect(assembleTrace(logs, CONTEXT).map((entry) => entry.index)).toEqual([0]);
    expect(assembleTrace(undefined, CONTEXT)).toEqual([]);
    expect(assembleTrace([], CONTEXT)).toEqual([]);
  });

  test("projects a substitution the protocol admits, sorted, as KAST v4 documents", () => {
    // No v0.1.155 server fills this field; the type does, and an LLVM
    // proof-hint reader would.  The decoder stands in for konvert.
    const pred = mlAnd([mlEquals(kvariable("Z"), ktoken("2", "Int")), mlEquals(kvariable("X"), ktoken("1", "Int"))]);
    const wire = koreJson(app("substitution-stand-in"));
    const context: TraceContext = { rules: CONTEXT.rules, toKast: () => pred };
    const logs: readonly LogEntry[] = [
      { tag: "rewrite", result: { tag: "success", ruleId: A_TO_B, substitution: wire }, origin: "booster" },
    ];

    const substitution = assembleTrace(logs, context)[0]?.substitution;
    expect(substitution).toBeDefined();
    // Keys sorted, so two runs of the same trace serialize identically.
    expect(Object.keys(substitution ?? {})).toEqual(["X", "Z"]);
    expect(substitution?.["X"]).toEqual({
      format: "KAST",
      version: 4,
      term: { node: "KToken", token: "1", sort: { node: "KSort", name: "Int", params: [] } },
    });
  });

  test("a substitution that is not a conjunction of equalities degrades to null", () => {
    const context: TraceContext = { rules: CONTEXT.rules, toKast: () => kapply("notASubstitution") };
    const logs: readonly LogEntry[] = [
      {
        tag: "rewrite",
        result: { tag: "success", ruleId: A_TO_B, substitution: koreJson(top(sortApp("SortGeneratedTopCell"))) },
        origin: "booster",
      },
    ];
    expect(assembleTrace(logs, context)[0]?.substitution).toBeNull();
    // …and the rest of the record is untouched: a bad diagnostic must not cost
    // the caller the step.
    expect(assembleTrace(logs, context)[0]?.label).toBe("a-to-b");
  });

  test("a decoder-less context leaves the substitution null even when the wire has one", () => {
    const logs: readonly LogEntry[] = [
      {
        tag: "rewrite",
        result: { tag: "success", ruleId: A_TO_B, substitution: koreJson(evar("X", sortApp("SortInt"))) },
        origin: "booster",
      },
    ];
    expect(assembleTrace(logs, CONTEXT)[0]?.substitution).toBeNull();
  });
});

describe("traceToJsonl", () => {
  test("is byte-identical for identical input, one newline-terminated object per line", () => {
    const trace = assembleTrace([rewrite(A_TO_B), rewrite(B_TO_C)], CONTEXT);
    const text = traceToJsonl(trace);
    expect(traceToJsonl(assembleTrace([rewrite(A_TO_B), rewrite(B_TO_C)], CONTEXT))).toBe(text);
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.split("\n").slice(0, -1);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      `{"index":0,"outcome":"success","ruleId":"${A_TO_B}","resolved":true,"label":"a-to-b",` +
        `"source":"/k/rules.k","location":[12,5,12,30],"module":"RULES","origin":"booster",` +
        `"reason":null,"substitution":null}`,
    );
    // Every line is independently parseable — that is the whole point of R7.
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
    expect(traceToJsonl([])).toBe("");
  });
});

describe("traceRuleCounts", () => {
  test("counts successful firings per rule id in first-fire order", () => {
    const trace = assembleTrace([rewrite(A_TO_B), rewrite(B_TO_C), rewrite(A_TO_B), rewrite(A_TO_B)], CONTEXT);
    expect([...traceRuleCounts(trace)]).toEqual([
      [A_TO_B, 3],
      [B_TO_C, 1],
    ]);
  });

  test("an attempted-and-failed step is not a firing", () => {
    const logs: readonly LogEntry[] = [
      rewrite(A_TO_B),
      { tag: "rewrite", result: { tag: "failure", reason: "nope", ruleId: A_TO_B }, origin: "booster" },
    ];
    expect([...traceRuleCounts(assembleTrace(logs, CONTEXT))]).toEqual([[A_TO_B, 1]]);
  });

  test("subtracting the fired ids from the index answers 'which rules never fired'", () => {
    const fired = traceRuleCounts(assembleTrace([rewrite(A_TO_B)], CONTEXT));
    const never = [...CONTEXT.rules.keys()].filter((id) => !fired.has(id));
    expect(never).toEqual([B_TO_C]);
  });
});

describe("filterTrace", () => {
  test("filters client-side without renumbering, so positions stay the run's", () => {
    const trace = assembleTrace([rewrite(A_TO_B), rewrite(B_TO_C), rewrite(A_TO_B)], CONTEXT);
    const filtered = filterTrace(trace, (entry) => entry.ruleId === A_TO_B);
    expect(filtered.map((entry) => entry.index)).toEqual([0, 2]);
    // R8's stated check: filtered ≡ post-hoc-filtered.
    expect(traceToJsonl(filtered)).toBe(traceToJsonl(trace.filter((entry) => entry.ruleId === A_TO_B)));
  });
});
