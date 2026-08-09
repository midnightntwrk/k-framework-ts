/**
 * The trace records — the consumer-facing half, checked requirement by
 * requirement against `docs/execution-traces.md`.
 *
 * The two guarded runs are the fixture the request itself asks for in R4:
 * "for a rule with a side condition, two programs that take the two sides of
 * that condition produce traces that differ in the substitution, and the
 * difference is the operand that differs".
 */

import { describe, expect, test } from "bun:test";
import { readKastDefinitionFromJson } from "@kframework-ts/kast";
import { parseDefinition } from "@kframework-ts/kore";

import {
  assembleProofTrace,
  filterProofTrace,
  proofTraceContext,
  proofTraceRecordSchema,
  proofTraceRecords,
  proofTraceRuleCounts,
  proofTraceToJsonl,
  type ProofTraceRecord,
} from "../src/records.ts";
import { parseProofTrace } from "../src/events.ts";
import { ordinalRuleIndex } from "../src/ordinals.ts";
import { fixtureText, runHeader, runHints, runDefinition, type RunName } from "./support.ts";

const CONTEXTS = new Map<string, ReturnType<typeof proofTraceContext>>();

function contextFor(run: RunName): ReturnType<typeof proofTraceContext> {
  const key = run === "addRewrite" ? "add-rewrite" : "guarded";
  let context = CONTEXTS.get(key);
  if (context === undefined) {
    context = proofTraceContext(
      ordinalRuleIndex(parseDefinition(runDefinition(run), { lazyAxioms: true })),
      readKastDefinitionFromJson(fixtureText("hints", `${key}.compiled.json`)),
    );
    CONTEXTS.set(key, context);
  }
  return context;
}

function recordsFor(run: RunName, options = {}): readonly ProofTraceRecord[] {
  return assembleProofTrace(runHints(run), runHeader(run), contextFor(run), options);
}

describe("the record shape", () => {
  test("has cterm's eleven keys, in cterm's order", () => {
    const [first] = recordsFor("addRewrite");
    expect(Object.keys(first!)).toEqual([
      "index",
      "outcome",
      "ruleId",
      "resolved",
      "label",
      "source",
      "location",
      "module",
      "origin",
      "reason",
      "substitution",
    ]);
  });

  test("origin says which oracle wrote it", () => {
    expect(recordsFor("addRewrite").every((entry) => entry.origin === "llvm")).toBe(true);
  });

  test("every field is populated or explicitly null — never undefined", () => {
    for (const entry of recordsFor("guardedBig")) {
      for (const value of Object.values(entry)) expect(value).not.toBeUndefined();
    }
  });

  test("fixture records round-trip through the JSONL interchange schema", () => {
    const records = recordsFor("guardedBig");
    const reread = proofTraceToJsonl(records)
      .trimEnd()
      .split("\n")
      .map((line) => proofTraceRecordSchema.parse(JSON.parse(line) as unknown));
    expect(reread).toEqual([...records]);
  });

  test("rejects malformed nested interchange fields", () => {
    const [record] = recordsFor("addRewrite");
    expect(record).toBeDefined();
    expect(proofTraceRecordSchema.safeParse({ ...record!, location: [18, 23, 18, "76"] }).success).toBe(false);
    expect(proofTraceRecordSchema.safeParse({ ...record!, substitution: { VarN: { bad: BigInt(1) } } }).success).toBe(
      false,
    );
  });
});

describe("R3 — a step names its rule three ways", () => {
  test("id, label, location and module, joined from the ordinal", () => {
    const records = recordsFor("addRewrite");
    expect(records[0]).toMatchObject({
      outcome: "success",
      resolved: true,
      label: "ADD-REWRITE.state-next",
      module: "ADD-REWRITE",
      location: [18, 23, 18, 76],
    });
    expect(records[0]?.ruleId).toMatch(/^[0-9a-f]{64}$/);
    expect(records[0]?.source).toEndWith("add-rewrite.k");
  });

  test("the ids are the ones definition.kore declares, so a kore-rpc trace joins", () => {
    const index = ordinalRuleIndex(parseDefinition(runDefinition("addRewrite"), { lazyAxioms: true }));
    const declared = new Set(index.flatMap((identity) => (identity.uniqueId === null ? [] : [identity.uniqueId])));
    for (const entry of recordsFor("addRewrite")) {
      if (entry.ruleId !== null) expect(declared.has(entry.ruleId)).toBe(true);
    }
  });
});

describe("R4 — a step records its substitution", () => {
  test("every record carries one, as KAST JSON v4", () => {
    const records = recordsFor("addRewrite");
    expect(records.length).toBeGreaterThan(0);
    for (const entry of records) {
      expect(entry.substitution).not.toBeNull();
      expect(Object.keys(entry.substitution!).length).toBeGreaterThan(0);
      for (const document of Object.values(entry.substitution!)) {
        // `kastTermToDict` writes the envelope, not a bare node — which is
        // what R4 asks for ("KAST JSON (v4), readable by
        // `@kframework-ts/kast-json`") and what cterm's records carry too.
        expect(document).toMatchObject({ format: "KAST", version: 4 });
        expect(typeof (document as { term?: { node?: unknown } }).term?.node).toBe("string");
      }
    }
  });

  test("the keys are sorted, and are the backend's own variable names", () => {
    const [first] = recordsFor("addRewrite");
    const keys = Object.keys(first!.substitution!);
    expect(keys).toEqual([...keys].toSorted());
    expect(keys).toEqual(["VarM", "VarN", "Var'Unds'DotVar0", "Var'Unds'DotVar1", "Var'Unds'Gen4"].toSorted());
  });

  test("the two sides of a side condition differ in exactly the operand that differs", () => {
    // `halve-small` requires `depth(N) <=Int 1`.  `halve(s(z()))` takes it at
    // once; `halve(s(s(s(z()))))` fails it three times first.  This is the
    // check `docs/execution-traces.md` R4 names, and it is only answerable
    // because the substitution is recorded.
    const small = recordsFor("guardedSmall");
    const big = recordsFor("guardedBig");

    const firstSmall = small[0]!;
    const firstBig = big[0]!;
    expect(firstSmall).toMatchObject({ outcome: "success", label: "GUARDED.halve-small" });
    expect(firstBig).toMatchObject({
      outcome: "failure",
      label: "GUARDED.halve-small",
      reason: "side condition failed",
    });

    // Same rule — same `ruleId`, even — and the *only* difference is the
    // operand `VarN` matched.  No trace without R4 could distinguish these.
    expect(firstSmall.ruleId).toBe(firstBig.ruleId);
    expect(successors(firstSmall)).toBe(1);
    expect(successors(firstBig)).toBe(3);
  });

  test("without a toKast the substitution is null, exactly as cterm behaves", () => {
    const rules = ordinalRuleIndex(parseDefinition(runDefinition("addRewrite"), { lazyAxioms: true }));
    const records = assembleProofTrace(runHints("addRewrite"), runHeader("addRewrite"), { rules });
    expect(records.every((entry) => entry.substitution === null)).toBe(true);
    // …and everything else is still there, so a caller with no `compiled.json`
    // still gets R3 and R5.
    expect(records[0]?.label).toBe("ADD-REWRITE.state-next");
  });
});

/** How many `s(_)` constructors the KAST v4 document for `VarN` nests. */
function successors(entry: ProofTraceRecord): number {
  return JSON.stringify(entry.substitution?.["VarN"]).split('"s(_)_GUARDED-SYNTAX_Nat_Nat"').length - 1;
}

describe("R5 — steps are ordered, and the order is the firing order", () => {
  test("index is 0..n-1 and follows the rules the reference tool listed", () => {
    const records = recordsFor("addRewrite");
    expect(records.map((entry) => entry.index)).toEqual(records.map((_, index) => index));
    expect(records.map((entry) => entry.label)).toEqual([
      "ADD-REWRITE.state-next",
      "ADD-REWRITE.add-succ",
      "ADD-REWRITE.add-succ",
      "ADD-REWRITE.add-zero",
      "ADD-REWRITE.state-succ",
      "ADD-REWRITE.state-next",
      "ADD-REWRITE.add-succ",
      "ADD-REWRITE.add-zero",
      "ADD-REWRITE.state-succ",
    ]);
  });
});

describe("R6 — a trace is deterministic", () => {
  test("ten assemblies of the same bytes give one distinct payload", () => {
    const payloads = new Set(Array.from({ length: 10 }, () => proofTraceToJsonl(recordsFor("guardedBig"))));
    expect(payloads.size).toBe(1);
  });

  test("the JSONL is one line per record, newline-terminated, and empty for none", () => {
    const jsonl = proofTraceToJsonl(recordsFor("addRewrite"));
    expect(jsonl.endsWith("\n")).toBe(true);
    expect(jsonl.trimEnd().split("\n").length).toBe(recordsFor("addRewrite").length);
    for (const line of jsonl.trimEnd().split("\n")) expect(() => JSON.parse(line) as unknown).not.toThrow();
    expect(proofTraceToJsonl([])).toBe("");
  });
});

/** "the `add-*` rules that fired" — the projection R8's motivation names. */
function isAddRule(entry: ProofTraceRecord): boolean {
  return entry.label?.includes("add-") === true;
}

describe("R8 — a trace can be filtered", () => {
  test("filtering equals post-hoc filtering, and does not renumber", () => {
    const records = recordsFor("addRewrite");
    const filtered = filterProofTrace(records, isAddRule);
    expect(filtered).toEqual([...records].filter(isAddRule));
    expect(filtered.map((entry) => entry.index)).not.toEqual(filtered.map((_, index) => index));
  });
});

describe("which events become records", () => {
  test("pre-trace steps are dropped by default and kept on request", () => {
    const shallow = recordsFor("addRewrite");
    // Configuration initialization happens *entirely* inside `LblinitGenerated
    // TopCell`, so `preTrace` alone changes nothing at depth 0 — the two
    // filters are independent and both have to be lifted.
    expect(recordsFor("addRewrite", { preTrace: true })).toEqual([...shallow]);

    const deep = recordsFor("addRewrite", { preTrace: true, depth: Number.POSITIVE_INFINITY });
    expect(deep.length).toBeGreaterThan(shallow.length);
    // The program's own steps are still there, still in order, at the end.
    expect(deep.map((entry) => entry.label).slice(deep.length - shallow.length)).toEqual(
      shallow.map((entry) => entry.label),
    );
    // …and the initialization steps are the unlabelled generated axioms.
    expect(deep.slice(0, deep.length - shallow.length).every((entry) => entry.resolved)).toBe(true);
  });

  test("equations inside a function application need an explicit depth", () => {
    const shallow = recordsFor("guardedBig");
    const deep = recordsFor("guardedBig", { depth: Number.POSITIVE_INFINITY });
    expect(deep.length).toBeGreaterThan(shallow.length);
    // `depth-s` and `depth-z` fire only while a `requires` clause is being
    // evaluated, so they are invisible at depth 0 and visible past it.
    expect(shallow.some((entry) => entry.label === "GUARDED.depth-s")).toBe(false);
    expect(deep.some((entry) => entry.label === "GUARDED.depth-s")).toBe(true);
  });

  test("a rejected rule attempt is a failure record, and can be dropped", () => {
    const withFailures = recordsFor("guardedBig");
    const without = recordsFor("guardedBig", { failures: false });
    expect(withFailures.some((entry) => entry.outcome === "failure")).toBe(true);
    expect(without.every((entry) => entry.outcome === "success")).toBe(true);
    expect(without.length).toBeLessThan(withFailures.length);
    // A failure still carries its substitution — that is the point of
    // recording it at all.
    const failure = withFailures.find((entry) => entry.outcome === "failure")!;
    expect(failure.reason).toBe("side condition failed");
    expect(failure.substitution).not.toBeNull();
  });

  test("a side condition that passes contributes no record of its own", () => {
    // The `rule` event that follows it is the step; counting both would double
    // every guarded rule.
    const records = recordsFor("guardedSmall");
    expect(records.filter((entry) => entry.label === "GUARDED.halve-small").length).toBe(1);
  });
});

describe("proofTraceRuleCounts", () => {
  test("counts successful firings by unique id, skipping failures", () => {
    const records = recordsFor("addRewrite");
    const counts = proofTraceRuleCounts(records);
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    expect(total).toBe(records.filter((entry) => entry.outcome === "success" && entry.ruleId !== null).length);
    const addSucc = records.find((entry) => entry.label === "ADD-REWRITE.add-succ")!;
    expect(counts.get(addSucc.ruleId!)).toBe(3);
  });
});

describe("proofTraceRecords", () => {
  test("agrees with assembleProofTrace on an already-parsed trace", () => {
    const trace = parseProofTrace(runHints("guardedBig"), runHeader("guardedBig"));
    expect(proofTraceRecords(trace, contextFor("guardedBig"))).toEqual([...recordsFor("guardedBig")]);
  });
});
