/**
 * The legacy haskell one-line log analyzer — `kore_exec_covr/`.
 *
 * The first two describes are driven entirely by
 * `fixtures/pyk-unit/kore-exec-covr-cases.json`, the hand-transcribed copy of
 * `pyk/src/tests/unit/test_kore_exec_covr.py` — the **only** test upstream has
 * for any of K's coverage tooling and, since the format is no longer emitted,
 * the only specification of it that will ever exist.  Every case runs; nothing
 * is paraphrased.
 *
 * The rest is what upstream has no test for: `build_rule_dict`'s skips and the
 * report `do_analyze` prints, pinned in full against a definition built inline
 * so the golden is readable next to the assertion.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  Atts,
  attEntry,
  type AttEntry,
  KAtt,
  kapply,
  kflatmodule,
  krewrite,
  krule,
  ktoken,
  KDefinition,
  type KRule,
} from "@kframework-ts/kast";

import {
  buildRuleDict,
  HaskellLogEntry,
  locationKey,
  parseHaskellOnelineLog,
  parseRuleApplications,
  renderKoreExecReport,
  UNKNOWN_LOCATION,
} from "../src/koreExecLog.ts";

//////////////////////////////
// The vendored table       //
//////////////////////////////

interface CaseTable {
  readonly parseHaskellOnelineLog: {
    readonly cases: readonly { id: string; line: string; entry: HaskellLogEntry; payload: string }[];
  };
  readonly parseRuleApplications: {
    readonly cases: readonly { id: string; log: string; expected: Record<string, Record<string, number>> }[];
  };
}

const TABLE_JSON: unknown = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "pyk-unit", "kore-exec-covr-cases.json"), "utf8"),
);
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the shape is asserted by the first test below
const TABLE = TABLE_JSON as CaseTable;

describe("parseHaskellOnelineLog — the 5 upstream cases", () => {
  test("the table is the one that was vendored", () => {
    expect(TABLE.parseHaskellOnelineLog.cases).toHaveLength(5);
    expect(TABLE.parseRuleApplications.cases).toHaveLength(2);
  });

  test.each(TABLE.parseHaskellOnelineLog.cases.map((c) => [c.id, c] as const))("%s", (_id, testCase) => {
    expect(parseHaskellOnelineLog(testCase.line)).toEqual({ entry: testCase.entry, payload: testCase.payload });
  });

  test("a multi-location line stays ONE composite key, unsplit", () => {
    const multi = TABLE.parseHaskellOnelineLog.cases.find((c) => c.id === "DebugAppliedRewriteRules-multilocation");
    const parsed = parseHaskellOnelineLog(multi?.line ?? "");
    expect(parsed?.payload).toInclude(" /some/other/path");
    // `test_kore_exec_covr.py:36-41` is the specification: do not "fix" this.
    expect(parsed?.payload).toBe(multi?.payload);
  });
});

describe("parseHaskellOnelineLog — what the regexp does and does not accept", () => {
  test("an empty pid bracket parses, because `\\d*` allows it", () => {
    expect(parseHaskellOnelineLog("kore-rpc: [] Debug (DebugApplyEquation): /a.k:1:1-1:2")).toEqual({
      entry: HaskellLogEntry.DEBUG_APPLY_EQUATION,
      payload: "/a.k:1:1-1:2",
    });
  });

  test("kore-rpc is accepted alongside kore-exec, and nothing else is", () => {
    expect(parseHaskellOnelineLog("kore-rpc: [1] Debug (DebugApplyEquation):")).not.toBeNull();
    expect(parseHaskellOnelineLog("kore-repl: [1] Debug (DebugApplyEquation):")).toBeNull();
    expect(parseHaskellOnelineLog("/usr/bin/kore-exec: [1] Debug (DebugApplyEquation):")).toBeNull();
  });

  test("an entry name that is not one of the two is dropped", () => {
    // pyk gets this from `HaskellLogEntry(entry)` raising `ValueError`
    // (`kore_exec_covr.py:73-75`): the enum lookup is the filter.
    expect(parseHaskellOnelineLog("kore-exec: [1] Debug (DebugAttemptEquation): /a.k:1:1-1:2")).toBeNull();
  });

  test("the payload is stripped, and nothing else about it is touched", () => {
    expect(parseHaskellOnelineLog("kore-exec: [1] Debug (DebugApplyEquation):    /a.k:1:1-1:2  ")?.payload).toBe(
      "/a.k:1:1-1:2",
    );
    // Backslash-escaped spaces in a path are left exactly as logged.
    expect(
      parseHaskellOnelineLog(String.raw`kore-exec: [1] Debug (DebugApplyEquation): /a\ b/c.k:1:1-1:2`)?.payload,
    ).toBe(String.raw`/a\ b/c.k:1:1-1:2`);
  });

  test("a line that is not a debug entry at all yields null", () => {
    for (const line of ["", "kore-exec: starting", "warning: something happened"]) {
      expect(parseHaskellOnelineLog(line)).toBeNull();
    }
  });
});

describe("parseRuleApplications — the 2 upstream cases", () => {
  test.each(TABLE.parseRuleApplications.cases.map((c) => [c.id, c] as const))("%s", (_id, testCase) => {
    const { rewrites, simplifications } = parseRuleApplications(testCase.log);
    expect(Object.fromEntries(rewrites)).toEqual(testCase.expected[HaskellLogEntry.DEBUG_APPLIED_REWRITE_RULES] ?? {});
    expect(Object.fromEntries(simplifications)).toEqual(testCase.expected[HaskellLogEntry.DEBUG_APPLY_EQUATION] ?? {});
  });

  test("the empty log produces two empty counters and no warning", () => {
    const parsed = parseRuleApplications("");
    expect(parsed.rewrites.size).toBe(0);
    expect(parsed.simplifications.size).toBe(0);
    expect(parsed.warnings).toEqual([]);
  });

  test("an empty location becomes the literal key UNKNOWN, in bulk", () => {
    const log = [
      "kore-exec: [1] Debug (DebugAppliedRewriteRules):",
      "kore-exec: [2] Debug (DebugAppliedRewriteRules):",
    ];
    expect(parseRuleApplications(log.join("\n")).rewrites.get(UNKNOWN_LOCATION)).toBe(2);
  });

  test("duplicates increment — it is a counter, not a set", () => {
    const line = "kore-exec: [1] Debug (DebugApplyEquation): /a.k:1:1-1:2";
    expect(parseRuleApplications([line, line, line].join("\n")).simplifications.get("/a.k:1:1-1:2")).toBe(3);
  });

  test("an unparseable line is warned about and skipped, never fatal", () => {
    const parsed = parseRuleApplications(
      ["kore-exec: [1] Debug (DebugApplyEquation): /a.k:1:1-1:2", "junk"].join("\n"),
    );
    expect(parsed.simplifications.size).toBe(1);
    // pyk's wording (`kore_exec_covr.py:51`), returned rather than logged.
    expect(parsed.warnings).toEqual(["Skipping log entry, failed to parse: junk"]);
  });

  test("a trailing newline is not a blank line to warn about", () => {
    expect(parseRuleApplications("kore-exec: [1] Debug (DebugApplyEquation):\n").warnings).toEqual([]);
    // …but an interior blank line is a line, and pyk warns about it too.
    expect(parseRuleApplications("\nkore-exec: [1] Debug (DebugApplyEquation):\n").warnings).toHaveLength(1);
  });

  test("locations are counted in first-seen order, which the report prints", () => {
    const log = [
      "kore-exec: [1] Debug (DebugAppliedRewriteRules): /b.k:2:1-2:2",
      "kore-exec: [2] Debug (DebugAppliedRewriteRules): /a.k:1:1-1:2",
      "kore-exec: [3] Debug (DebugAppliedRewriteRules): /b.k:2:1-2:2",
    ];
    expect([...parseRuleApplications(log.join("\n")).rewrites.keys()]).toEqual(["/b.k:2:1-2:2", "/a.k:1:1-1:2"]);
  });
});

//////////////////////////////
// The definition side      //
//////////////////////////////

/** A rule at `source:location`, with whatever extra attributes a case needs. */
function ruleAt(
  source: string | null,
  location: readonly [number, number, number, number] | null,
  ...extra: readonly AttEntry[]
): KRule {
  const body = krewrite(kapply("<generatedTop>", [ktoken("0", "Int")]), kapply("<generatedTop>", [ktoken("1", "Int")]));
  return krule(body, {
    att: new KAtt([
      ...(source === null ? [] : [attEntry(Atts.SOURCE, source)]),
      ...(location === null ? [] : [attEntry(Atts.LOCATION, location)]),
      ...extra,
    ]),
  });
}

const PROJECTION = attEntry(Atts.PROJECTION, null);
const INITIALIZER = attEntry(Atts.INITIALIZER, null);
const SIMPLIFICATION = attEntry(Atts.SIMPLIFICATION, "");

const definitionOf = (...rules: readonly KRule[]): KDefinition =>
  new KDefinition("TEST", [kflatmodule("TEST", { sentences: rules })]);

describe("buildRuleDict", () => {
  test("keys on file:startLine:startCol-endLine:endCol", () => {
    const rule = ruleAt("/s/a.k", [1, 2, 3, 4]);
    expect(locationKey("/s/a.k", [1, 2, 3, 4])).toBe("/s/a.k:1:2-3:4");
    expect([...buildRuleDict(definitionOf(rule)).rules.keys()]).toEqual(["/s/a.k:1:2-3:4"]);
  });

  test("projection and initializer rules are skipped by default", () => {
    const definition = definitionOf(
      ruleAt("/s/a.k", [1, 1, 1, 2]),
      ruleAt("/s/a.k", [2, 1, 2, 2], PROJECTION),
      ruleAt("/s/a.k", [3, 1, 3, 2], INITIALIZER),
    );
    expect([...buildRuleDict(definition).rules.keys()]).toEqual(["/s/a.k:1:1-1:2"]);
  });

  test("…and kept when the caller asks for them", () => {
    const definition = definitionOf(
      ruleAt("/s/a.k", [2, 1, 2, 2], PROJECTION),
      ruleAt("/s/a.k", [3, 1, 3, 2], INITIALIZER),
    );
    expect(buildRuleDict(definition, { skipProjections: false, skipInitializers: false }).rules.size).toBe(2);
    expect(buildRuleDict(definition, { skipProjections: false }).rules.size).toBe(1);
  });

  test("a rule missing Source or Location is warned about and skipped", () => {
    const definition = definitionOf(ruleAt(null, [1, 1, 1, 2]), ruleAt("/s/a.k", null));
    const { rules, warnings } = buildRuleDict(definition);
    expect(rules.size).toBe(0);
    expect(warnings).toHaveLength(2);
    // pyk's wording (`kore_exec_covr.py:93`), returned rather than logged.
    for (const warning of warnings) {
      expect(warning).toStartWith("Skipping rule with no location information ");
      expect(warning).toEndWith("...<truncated>");
    }
  });

  test("two rules at one location: the later wins, as a Python dict's would", () => {
    const first = ruleAt("/s/a.k", [1, 1, 1, 2], attEntry(Atts.LABEL, "first"));
    const second = ruleAt("/s/a.k", [1, 1, 1, 2], attEntry(Atts.LABEL, "second"));
    const { rules } = buildRuleDict(definitionOf(first, second));
    expect(rules.get("/s/a.k:1:1-1:2")?.att.get(Atts.LABEL)).toBe("second");
  });
});

//////////////////////////////
// The report               //
//////////////////////////////

describe("renderKoreExecReport", () => {
  const definition = definitionOf(
    ruleAt("/s/a.k", [1, 1, 2, 2], attEntry(Atts.LABEL, "a-rule")),
    ruleAt("/s/a.k", [5, 1, 5, 9]),
    ruleAt("/s/b.k", [3, 1, 3, 8], SIMPLIFICATION, attEntry(Atts.SYMBOL, "foo")),
    ruleAt("/s/b.k", [7, 1, 7, 8], PROJECTION),
    ruleAt(null, null),
  );

  const LOG = [
    "kore-exec: [1] Debug (DebugAppliedRewriteRules): /s/a.k:1:1-2:2",
    "kore-exec: [2] Debug (DebugAppliedRewriteRules): /s/a.k:1:1-2:2",
    "kore-exec: [3] Debug (DebugAppliedRewriteRules):",
    "kore-exec: [4] Debug (DebugApplyEquation): /s/b.k:3:1-3:8",
    "kore-rpc: [] Debug (DebugApplyEquation): /s/gone.k:9:9-9:9",
    "kore-exec: [5] Debug (DebugAttemptEquation): /s/b.k:3:1-3:8",
    "",
  ].join("\n");

  test("the whole report, byte for byte", () => {
    const report = renderKoreExecReport(definition, LOG, { definitionDir: "/build/my-kompiled" });
    expect(report.text).toBe(
      [
        "Discovering rewrite and simplification rules in /build/my-kompiled",
        // `availible` is upstream's typo (`__main__.py:45-46`) and part of the
        // output contract.
        "    Found 2 rewrite rules availible for TEST",
        "    Found 1 simplification rules availible for TEST",
        "=================================",
        "=== REWRITES ====================",
        "=================================",
        "    2 applications of rule [a-rule] defined at /s/a.k:1:1-2:2",
        // Two spaces: the label is interpolated unconditionally, and no rule in
        // the definition sits at `UNKNOWN`.
        "    1 applications of rule  defined at UNKNOWN",
        "Total rewrites applied: 3",
        "=================================",
        "=== SIMPLIFICATIONS =============",
        "=================================",
        // Atts.SYMBOL, not Atts.LABEL, for a simplification (`:69-70`).
        "    1 applications of rule [foo] defined at /s/b.k:3:1-3:8",
        "    1 applications of rule  defined at /s/gone.k:9:9-9:9",
        "Total applied simplifications: 2",
        "",
      ].join("\n"),
    );
  });

  test("the totals and the printed lines agree", () => {
    const report = renderKoreExecReport(definition, LOG, { definitionDir: "/build/my-kompiled" });
    expect(report.totalRewrites).toBe(3);
    expect(report.totalSimplifications).toBe(2);
  });

  test("warnings from both halves come back, definition first", () => {
    const report = renderKoreExecReport(definition, LOG, { definitionDir: "/build/my-kompiled" });
    expect(report.warnings).toHaveLength(2);
    expect(report.warnings[0]).toStartWith("Skipping rule with no location information");
    // `DebugAttemptEquation` is a real kore-exec entry this tool does not read.
    expect(report.warnings[1]).toStartWith("Skipping log entry, failed to parse: kore-exec: [5]");
  });

  test("an empty log still prints both sections and two zero totals", () => {
    const report = renderKoreExecReport(definition, "", { definitionDir: "/d" });
    expect(report.text).toEndWith("Total applied simplifications: 0\n");
    expect(report.text).toInclude("Total rewrites applied: 0\n");
    expect(report.warnings).toHaveLength(1);
  });
});
