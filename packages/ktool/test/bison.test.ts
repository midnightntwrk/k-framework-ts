import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  BISON_INPUT_VIRTUAL_DIRECTORY,
  BisonGrammarPolicyAnalysisSchema,
  BisonLr1EvidenceSchema,
  BisonLr1VerdictSchema,
  BisonRunEvidenceSchema,
  BisonXmlDecodeError,
  BisonXmlReportSchema,
  analyzeBisonGrammarPolicy,
  analyzeBisonLr1,
  bisonAnalysisFingerprint,
  buildStrictBisonArgv,
  classifyBisonRun,
  decodeBisonXml,
  parseBisonXmlReport,
  normalizeBisonEvidenceText,
  runStrictBison,
  type CompletedProcess,
} from "../src/index.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "bison");
const BISON_VERSION = "3.8.2";
const CLASSIFY_BISON = "/usr/bin/bison";
const scratchDirs: string[] = [];

const fixture = (name: string, extension: "y" | "xml" | "output"): string => join(FIXTURES, `${name}.${extension}`);
const textFixture = (name: string, extension: "y" | "xml" | "output"): Promise<string> =>
  readFile(fixture(name, extension), "utf8");

function classificationIdentity(name: string) {
  return { bisonExecutable: CLASSIFY_BISON, grammarPath: resolve(fixture(name, "y")) } as const;
}

function completed(name: string, overrides: Partial<CompletedProcess> = {}): CompletedProcess {
  const identity = classificationIdentity(name);
  return {
    args: [...buildStrictBisonArgv(identity)],
    returncode: 0,
    stdout: "",
    stderr: "",
    signal: undefined,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ktool-bison-test-"));
  scratchDirs.push(dir);
  return dir;
}

describe("Bison structural schemas", () => {
  test("accepts policy analysis and decoded XML while preserving their discriminants", async () => {
    const policy = analyzeBisonGrammarPolicy("%define lr.type ielr\n%expect 1\n%%\n");
    expect(BisonGrammarPolicyAnalysisSchema.parse(policy)).toEqual(policy);

    const report = parseBisonXmlReport(await textFixture("lr1", "xml"), BISON_VERSION);
    expect(BisonXmlReportSchema.parse(report)).toEqual(report);
    expect(parseBisonXmlReport(await textFixture("shift-reduce", "xml"), BISON_VERSION).conflicts).toHaveLength(1);
    expect(() => parseBisonXmlReport("<bison-xml-report>", BISON_VERSION)).toThrow(BisonXmlDecodeError);
  });

  test("keeps incomplete run evidence distinct from complete LR(1) evidence", async () => {
    const report = decodeBisonXml(await textFixture("lr1", "xml"), BISON_VERSION);
    const process = completed("lr1");
    const partial = {
      sourceSha256: "source",
      requestedGrammarPath: "/grammar.y",
      analyzedGrammarPath: "/snapshot/parser.y",
      normativeArgv: ["/usr/bin/bison", "parser.y"],
      process,
    };
    expect(BisonRunEvidenceSchema.parse(partial)).toEqual(partial);
    expect(BisonLr1EvidenceSchema.safeParse(partial).success).toBe(false);

    const complete = {
      ...partial,
      xmlSha256: "xml",
      textReportSha256: "report",
      rawXml: new TextEncoder().encode(await textFixture("lr1", "xml")),
      rawTextReport: new TextEncoder().encode(await textFixture("lr1", "output")),
      report,
    };
    const verdict = { kind: "lr1" as const, evidence: complete };
    expect(BisonLr1VerdictSchema.parse(verdict)).toEqual(verdict);
    expect(BisonLr1VerdictSchema.safeParse({ kind: "lr1", evidence: partial }).success).toBe(false);

    const branches = [
      {
        kind: "conflicts" as const,
        conflicts: [{ kind: "shift-reduce" as const, state: 1, symbol: "TOK", disabledReductionRule: 2 }],
        evidence: complete,
      },
      { kind: "policy-violation" as const, violations: [{ kind: "missing-lr-type" as const }] },
      {
        kind: "policy-violation" as const,
        violations: [{ kind: "missing-lr-type" as const }],
        evidence: partial,
      },
      { kind: "inconsistent" as const, issues: ["partial evidence"], evidence: partial },
    ];
    for (const branch of branches) expect(BisonLr1VerdictSchema.safeParse(branch).success).toBe(true);
    expect(BisonLr1VerdictSchema.safeParse({ kind: "conflicts", conflicts: [], evidence: partial }).success).toBe(
      false,
    );
    expect(
      BisonLr1VerdictSchema.safeParse({
        kind: "inconsistent",
        issues: ["bad process"],
        evidence: { ...partial, process: { ...process, stdout: 7 } },
      }).success,
    ).toBe(false);
  });
});

describe("analyzeBisonGrammarPolicy", () => {
  test("accepts the deterministic IELR declaration used by K v7.1.337", async () => {
    const policy = analyzeBisonGrammarPolicy(await textFixture("lr1", "y"));
    expect(policy.lrType).toBe("ielr");
    expect(policy.violations).toEqual([]);
  });

  test("rejects every top-level conflict-hiding directive and preserves its source line", () => {
    const source = [
      "/* declaration header */",
      "%define lr.type ielr",
      "  %glr-parser /* forbidden */",
      "%expect 1",
      "%expect-rr 2",
      "%left PLUS",
      "%right TIMES",
      "%nonassoc EQ",
      "%precedence NEG",
      "%%",
      "start: TOKEN ;",
    ].join("\n");

    expect(analyzeBisonGrammarPolicy(source).violations).toEqual([
      { kind: "glr-parser", directive: "%glr-parser", line: 3, raw: "  %glr-parser /* forbidden */" },
      { kind: "expected-conflicts", directive: "%expect", line: 4, raw: "%expect 1" },
      { kind: "expected-conflicts", directive: "%expect-rr", line: 5, raw: "%expect-rr 2" },
      { kind: "precedence-resolution", directive: "%left", line: 6, raw: "%left PLUS" },
      { kind: "precedence-resolution", directive: "%right", line: 7, raw: "%right TIMES" },
      { kind: "precedence-resolution", directive: "%nonassoc", line: 8, raw: "%nonassoc EQ" },
      { kind: "precedence-resolution", directive: "%precedence", line: 9, raw: "%precedence NEG" },
    ]);
  });

  test("does not scan rule actions after the first declaration separator", () => {
    const source = "%define lr.type ielr\n%%\nstart: TOKEN { /* %left is C text here */ } ;\n";
    expect(analyzeBisonGrammarPolicy(source).violations).toEqual([]);
  });

  test("rejects rule-level expected-conflict directives outside actions", () => {
    const source = [
      "%define lr.type ielr",
      "%%",
      "start: TOKEN %expect 0",
      "     | OTHER %expect-rr 1",
      '     | THIRD { const char *text = "%expect 9"; }', // C action text is not Bison policy.
      ";",
    ].join("\n");
    expect(analyzeBisonGrammarPolicy(source).violations).toEqual([
      { kind: "expected-conflicts", directive: "%expect", line: 3, raw: "start: TOKEN %expect 0" },
      { kind: "expected-conflicts", directive: "%expect-rr", line: 4, raw: "     | OTHER %expect-rr 1" },
    ]);
  });

  test("code literals cannot hide a real policy directive", () => {
    const source = [
      "%define lr.type ielr",
      '%code { const char *open = "/*"; }',
      "%expect 0",
      "%%",
      "start: TOKEN;",
    ].join("\n");
    expect(analyzeBisonGrammarPolicy(source).violations).toEqual([
      { kind: "expected-conflicts", directive: "%expect", line: 3, raw: "%expect 0" },
    ]);
  });

  test("ignores policy spellings in literals, prologue/code blocks, actions, and the epilogue", () => {
    const source = [
      "%define lr.type ielr",
      '%token EXPECT_TEXT "%expect 8"',
      "%{",
      'const char *prologue = "%glr-parser /* %left";',
      "%}",
      "%code requires {",
      '  const char *code = "%expect-rr 4";',
      "}",
      "%%",
      'start: EXPECT_TEXT { const char *action = "%precedence"; };',
      "%%",
      "%expect 12 /* ordinary target-language epilogue bytes */",
    ].join("\n");
    expect(analyzeBisonGrammarPolicy(source)).toEqual({ lrType: "ielr", violations: [] });
  });

  test("ignores commented-out declarations instead of treating them as policy", () => {
    const source = [
      "/* %glr-parser",
      "%expect 4 */",
      "// %left PLUS",
      "%define lr.type ielr // selected algorithm",
      "%%",
    ].join("\n");
    expect(analyzeBisonGrammarPolicy(source)).toMatchObject({ lrType: "ielr", violations: [] });
  });

  test("rejects a missing LR declaration", () => {
    expect(analyzeBisonGrammarPolicy("%token ID\n%%\nstart: ID;").violations).toEqual([{ kind: "missing-lr-type" }]);
  });

  test("rejects duplicate LR declarations even when both say IELR", () => {
    const policy = analyzeBisonGrammarPolicy("%define lr.type ielr\n%define lr.type ielr\n%%\n");
    expect(policy.violations).toEqual([
      {
        kind: "duplicate-lr-type",
        declarations: [
          { value: "ielr", line: 1, raw: "%define lr.type ielr" },
          { value: "ielr", line: 2, raw: "%define lr.type ielr" },
        ],
      },
    ]);
  });

  test.each(["lalr", "canonical-lr", "future-lr"])('rejects unsupported lr.type "%s"', (value) => {
    expect(analyzeBisonGrammarPolicy(`%define lr.type ${value}\n%%\n`).violations).toEqual([
      {
        kind: "unsupported-lr-type",
        value,
        line: 1,
        raw: `%define lr.type ${value}`,
      },
    ]);
  });

  test("rejects an unknown or multiline lr.type value conservatively", () => {
    expect(analyzeBisonGrammarPolicy("%define lr.type\n  ielr\n%%\n").violations).toEqual([
      { kind: "unsupported-lr-type", value: undefined, line: 1, raw: "%define lr.type" },
    ]);
  });
});

describe("strict Bison command and evidence identity", () => {
  test("constructs the normative deterministic argv exactly", () => {
    expect(buildStrictBisonArgv({ bisonExecutable: "/opt/bison", grammarPath: "/generated/parser.y" })).toEqual([
      "/opt/bison",
      "-Werror=conflicts-sr",
      "-Werror=conflicts-rr",
      "--report=all",
      "--report-file=parser.output",
      "--xml=parser.xml",
      "--file-prefix-map=/generated=/ktool-bison-input",
      "-o",
      "parser.c",
      "parser.y",
    ]);
  });

  test("requires resolved absolute executable and input identities", () => {
    expect(() => buildStrictBisonArgv({ bisonExecutable: "bison", grammarPath: "/parser.y" })).toThrow("absolute");
    expect(() => buildStrictBisonArgv({ bisonExecutable: "/usr/bin/bison", grammarPath: "parser.y" })).toThrow(
      "absolute",
    );
  });

  test("normalizes longer absolute prefixes first and never treats them as regex", () => {
    expect(
      normalizeBisonEvidenceText("/tmp/a.b/run/parser.y /tmp/a.b/source.y", [
        { absolutePath: "/tmp/a.b", replacement: "<tmp>" },
        { absolutePath: "/tmp/a.b/run", replacement: "<run>" },
      ]),
    ).toBe("<run>/parser.y <tmp>/source.y");
  });

  test("fingerprints change independently with source, policy, tool identity, and argv", () => {
    const base = {
      source: "%define lr.type ielr\n%%\n",
      policyIdentity: "strict-ielr-v1",
      toolIdentity: { executable: "/usr/bin/bison", expectedVersion: BISON_VERSION },
      argv: ["/usr/bin/bison", "--xml=parser.xml"],
    } as const;
    const digest = bisonAnalysisFingerprint(base);
    expect(bisonAnalysisFingerprint({ ...base, source: `${base.source}\n` })).not.toBe(digest);
    expect(bisonAnalysisFingerprint({ ...base, policyIdentity: "strict-ielr-v2" })).not.toBe(digest);
    expect(
      bisonAnalysisFingerprint({ ...base, toolIdentity: { ...base.toolIdentity, executable: "/opt/bison" } }),
    ).not.toBe(digest);
    expect(bisonAnalysisFingerprint({ ...base, argv: [...base.argv, "--report=all"] })).not.toBe(digest);
  });
});

describe("decodeBisonXml", () => {
  test("decodes the version-pinned grammar and complete automaton semantically", async () => {
    const xml = await textFixture("lr1", "xml");
    const report = decodeBisonXml(xml, BISON_VERSION);
    expect(report.version).toBe(BISON_VERSION);
    expect(report.grammar.rules).toEqual([
      { number: 0, usefulness: "useful", lhs: "$accept", rhs: ["start", "$end"] },
      { number: 1, usefulness: "useful", lhs: "start", rhs: ["ID"] },
    ]);
    expect(report.automaton.states).toHaveLength(4);
    expect(report.summary).toEqual({
      ruleCount: 2,
      stateCount: 4,
      disabledActionCount: 0,
      solvedConflictCount: 0,
      shiftReduceConflictCount: 0,
      reduceReduceConflictCount: 0,
    });
    expect(xml).not.toContain("SEMANTIC_ACTION_MUST_NOT_APPEAR_IN_XML");
  });

  test("decodes shift/reduce conflicts from competing XML actions", async () => {
    const report = decodeBisonXml(await textFixture("shift-reduce", "xml"), BISON_VERSION);
    expect(report.conflicts).toEqual([
      {
        kind: "shift-reduce",
        state: 5,
        symbol: '"+"',
        disabledReductionRule: 2,
      },
    ]);
    expect(report.summary.disabledActionCount).toBe(1);
  });

  test("decodes reduce/reduce conflicts distinctly", async () => {
    const report = decodeBisonXml(await textFixture("reduce-reduce", "xml"), BISON_VERSION);
    expect(report.conflicts).toEqual([
      {
        kind: "reduce-reduce",
        state: 1,
        symbol: "$end",
        disabledReductionRule: 4,
        enabledReductionRule: 3,
      },
    ]);
  });

  test("retains effective precedence resolutions from XML", async () => {
    const report = decodeBisonXml(await textFixture("precedence", "xml"), BISON_VERSION);
    expect(report.solvedConflicts).toEqual([
      { state: 5, rule: 2, symbol: '"+"', type: "reduce", resolution: '%left "+"' },
    ]);
    expect(report.summary.solvedConflictCount).toBe(1);
  });

  test("rejects malformed XML, unexpected roots, doctypes, and unknown result shapes", async () => {
    expect(() => decodeBisonXml("<bison-xml-report>", BISON_VERSION)).toThrow(BisonXmlDecodeError);
    expect(() => decodeBisonXml('<not-bison version="3.8.2"/>', BISON_VERSION)).toThrow("root");
    expect(() =>
      decodeBisonXml(
        '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><bison-xml-report version="3.8.2"/>',
        BISON_VERSION,
      ),
    ).toThrow("DOCTYPE");
    const xml = await textFixture("lr1", "xml");
    expect(() =>
      decodeBisonXml(xml.replace("<reductions/>", "<reductions><mystery/></reductions>"), BISON_VERSION),
    ).toThrow("mystery");
  });

  test("rejects unknown XML container and leaf shapes", async () => {
    const xml = await textFixture("lr1", "xml");
    for (const mutation of [
      xml.replace("<grammar>", "<!-- future comment --><grammar>"),
      xml.replace(' bug-report="bug-bison@gnu.org"', ""),
      xml.replace("<rules>", "<rules><future-shape/>"),
      xml.replace("<rules>", '<rules future-attribute="true">'),
      xml.replace("<lhs>start</lhs>", '<lhs future-attribute="true">start</lhs>'),
      xml.replace("<symbol>ID</symbol>", '<symbol future-attribute="true">ID</symbol>'),
      xml.replace("<rhs>\n          <symbol>ID</symbol>\n        </rhs>", "<rhs/>"),
    ]) {
      expect(() => decodeBisonXml(mutation, BISON_VERSION)).toThrow(BisonXmlDecodeError);
    }
  });

  test("rejects dangling and internally inconsistent XML references", async () => {
    const xml = await textFixture("lr1", "xml");
    for (const mutation of [
      xml.replace('rule-number="1" dot="0"', 'rule-number="999" dot="0"'),
      xml.replace('rule-number="1" dot="0"', 'rule-number="1" dot="2"'),
      xml.replace('type="shift" symbol="ID" state="1"', 'type="shift" symbol="ID" state="999"'),
      xml.replace('type="shift" symbol="ID" state="1"', 'type="shift" symbol="ID" state="2"'),
      xml.replace('type="shift" symbol="ID" state="1"', 'type="shift" symbol="start" state="1"'),
      xml.replace('rule="1" enabled="true"', 'rule="999" enabled="true"'),
      xml.replace("<symbol>ID</symbol>", "<symbol>FUTURE</symbol>"),
      xml.replace("<lhs>start</lhs>", "<lhs>ID</lhs>"),
      xml.replace('<state number="3">', '<state number="99">'),
    ]) {
      expect(() => decodeBisonXml(mutation, BISON_VERSION)).toThrow(BisonXmlDecodeError);
    }
  });

  test("rejects a report from a different Bison version before interpretation", async () => {
    const xml = await textFixture("lr1", "xml");
    expect(() => decodeBisonXml(xml, "3.8.1")).toThrow("version");
  });
});

describe("classifyBisonRun", () => {
  test("returns lr1 only for zero exit, empty diagnostics, conflict-free XML, and consistent text", async () => {
    const verdict = classifyBisonRun({
      ...classificationIdentity("lr1"),
      source: await textFixture("lr1", "y"),
      expectedVersion: BISON_VERSION,
      process: completed("lr1"),
      xml: await textFixture("lr1", "xml"),
      textReport: await textFixture("lr1", "output"),
    });
    expect(verdict.kind).toBe("lr1");
    if (verdict.kind !== "lr1") throw new Error("expected lr1");
    expect(verdict.evidence.process.stderr).toBe("");
    expect(verdict.evidence.xmlSha256).toHaveLength(64);
    expect(verdict.evidence.textReportSha256).toHaveLength(64);
    expect(verdict.evidence.sourceSha256).toHaveLength(64);
  });

  test("accepts the actual 18-rule Panopticon Bison report", async () => {
    const report = await textFixture("panopticon-lr1", "output");
    expect(report).toContain('   10          | "let" SortId__ ":" SortValueType__ "=" SortExpr__ ";" SortPgm__');
    expect(report).toContain('   10 SortPgm__: "let" • SortId__ ":" SortValueType__ "=" SortExpr__ ";" SortPgm__');

    const verdict = classifyBisonRun({
      ...classificationIdentity("panopticon-lr1"),
      source: await textFixture("lr1", "y"),
      expectedVersion: BISON_VERSION,
      process: completed("panopticon-lr1"),
      xml: await textFixture("panopticon-lr1", "xml"),
      textReport: report,
    });
    expect(verdict.kind).toBe("lr1");
    if (verdict.kind !== "lr1") throw new Error("expected the Panopticon report to corroborate LR(1)");
    expect(verdict.evidence.report.summary).toMatchObject({ ruleCount: 18, stateCount: 27 });
  });

  test.each([
    ["shift-reduce", "shift-reduce", "error: 1 shift/reduce conflict [-Werror=conflicts-sr]\n"],
    ["reduce-reduce", "reduce-reduce", "error: 1 reduce/reduce conflict [-Werror=conflicts-rr]\n"],
    ["unambiguous-non-lr1", "reduce-reduce", "error: 1 reduce/reduce conflict [-Werror=conflicts-rr]\n"],
  ] as const)("classifies %s with preserved evidence", async (name, conflictKind, stderr) => {
    const verdict = classifyBisonRun({
      ...classificationIdentity(name),
      source: await textFixture(name, "y"),
      expectedVersion: BISON_VERSION,
      process: completed(name, { returncode: 1, stderr }),
      xml: await textFixture(name, "xml"),
      textReport: await textFixture(name, "output"),
    });
    expect(verdict.kind).toBe("conflicts");
    if (verdict.kind !== "conflicts") throw new Error("expected conflicts");
    expect(verdict.conflicts.some((conflict) => conflict.kind === conflictKind)).toBe(true);
    expect(verdict.evidence.process.stderr).toBe(stderr);
  });

  test("source precedence is a policy violation even though raw Bison accepts it", async () => {
    const verdict = classifyBisonRun({
      ...classificationIdentity("precedence"),
      source: await textFixture("precedence", "y"),
      expectedVersion: BISON_VERSION,
      process: completed("precedence"),
      xml: await textFixture("precedence", "xml"),
      textReport: await textFixture("precedence", "output"),
    });
    expect(verdict.kind).toBe("policy-violation");
    if (verdict.kind !== "policy-violation") throw new Error("expected policy violation");
    expect(verdict.violations[0]?.kind).toBe("precedence-resolution");
  });

  test("an effective XML resolution remains a policy violation when the header scan cannot see it", async () => {
    const verdict = classifyBisonRun({
      ...classificationIdentity("lr1"),
      source: await textFixture("lr1", "y"),
      expectedVersion: BISON_VERSION,
      process: completed("lr1"),
      xml: await textFixture("precedence", "xml"),
      textReport: await textFixture("precedence", "output"),
    });
    expect(verdict.kind).toBe("policy-violation");
    if (verdict.kind !== "policy-violation") throw new Error("expected policy violation");
    expect(verdict.violations).toEqual([
      {
        kind: "solved-conflict",
        state: 5,
        rule: 2,
        symbol: '"+"',
        type: "reduce",
        resolution: '%left "+"',
      },
    ]);
  });

  test("unknown stdout or stderr bytes can never produce an lr1 verdict", async () => {
    const common = {
      ...classificationIdentity("lr1"),
      source: await textFixture("lr1", "y"),
      expectedVersion: BISON_VERSION,
      xml: await textFixture("lr1", "xml"),
      textReport: await textFixture("lr1", "output"),
    };
    expect(classifyBisonRun({ ...common, process: completed("lr1", { stdout: "new output\n" }) }).kind).toBe(
      "inconsistent",
    );
    expect(classifyBisonRun({ ...common, process: completed("lr1", { stderr: "new warning\n" }) }).kind).toBe(
      "inconsistent",
    );
  });

  test("malformed raw bytes and missing reports remain preserved inconsistent evidence", async () => {
    const source = await textFixture("lr1", "y");
    const malformed = new Uint8Array([0xff, 0xfe, 0xfd]);
    const malformedVerdict = classifyBisonRun({
      ...classificationIdentity("lr1"),
      source,
      expectedVersion: BISON_VERSION,
      process: completed("lr1"),
      xml: malformed,
      textReport: new TextEncoder().encode(await textFixture("lr1", "output")),
    });
    expect(malformedVerdict.kind).toBe("inconsistent");
    if (malformedVerdict.kind !== "inconsistent") throw new Error("expected inconsistency");
    expect(malformedVerdict.evidence.rawXml).toEqual(malformed);

    const missingVerdict = classifyBisonRun({
      ...classificationIdentity("lr1"),
      source,
      expectedVersion: BISON_VERSION,
      process: completed("lr1", { returncode: 1, stderr: "syntax error\n" }),
      xml: undefined,
      textReport: undefined,
    });
    expect(missingVerdict.kind).toBe("inconsistent");
    if (missingVerdict.kind !== "inconsistent") throw new Error("expected inconsistency");
    expect(missingVerdict.evidence.process.stderr).toBe("syntax error\n");
  });

  test("text-report drift and exit/XML disagreement are conservative inconsistencies", async () => {
    const common = {
      ...classificationIdentity("shift-reduce"),
      source: await textFixture("shift-reduce", "y"),
      expectedVersion: BISON_VERSION,
      xml: await textFixture("shift-reduce", "xml"),
      textReport: await textFixture("shift-reduce", "output"),
    };
    expect(classifyBisonRun({ ...common, process: completed("shift-reduce", { returncode: 0 }) }).kind).toBe(
      "inconsistent",
    );
    expect(
      classifyBisonRun({
        ...common,
        process: completed("shift-reduce", { returncode: -9, signal: "SIGKILL" }),
      }).kind,
    ).toBe("inconsistent");
    expect(
      classifyBisonRun({
        ...common,
        process: completed("shift-reduce", { returncode: 1 }),
        textReport: "unknown report format",
      }).kind,
    ).toBe("inconsistent");

    const missingRule = common.textReport.replace('    2     | expr "+" expr\n', "");
    const ruleDrift = classifyBisonRun({
      ...common,
      process: completed("shift-reduce", {
        returncode: 1,
        stderr: "error: 1 shift/reduce conflict [-Werror=conflicts-sr]\n",
      }),
      textReport: missingRule,
    });
    expect(ruleDrift.kind).toBe("inconsistent");
    if (ruleDrift.kind !== "inconsistent") throw new Error("expected rule-count drift inconsistency");
    expect(ruleDrift.issues.filter((issue) => issue.startsWith("Text report has 2 rules"))).toHaveLength(1);
  });

  test("rejects process evidence whose argv is not the normative strict invocation", async () => {
    const verdict = classifyBisonRun({
      ...classificationIdentity("lr1"),
      source: await textFixture("lr1", "y"),
      expectedVersion: BISON_VERSION,
      process: completed("lr1", { args: [CLASSIFY_BISON, "--xml=parser.xml"] }),
      xml: await textFixture("lr1", "xml"),
      textReport: await textFixture("lr1", "output"),
    });
    expect(verdict.kind).toBe("inconsistent");
    if (verdict.kind !== "inconsistent") throw new Error("expected inconsistent argv evidence");
    expect(verdict.issues.some((issue) => issue.includes("normative strict invocation"))).toBe(true);
  });

  test("rejects appended nonempty text-report sections that were not consumed", async () => {
    const report = await textFixture("lr1", "output");
    const common = {
      ...classificationIdentity("lr1"),
      source: await textFixture("lr1", "y"),
      expectedVersion: BISON_VERSION,
      process: completed("lr1"),
      xml: await textFixture("lr1", "xml"),
    } as const;
    for (const drift of ["Future report section\n    new machine-readable facts\n", "    indented future fact\n"]) {
      const verdict = classifyBisonRun({ ...common, textReport: report + drift });
      expect(verdict.kind).toBe("inconsistent");
      if (verdict.kind !== "inconsistent") throw new Error("expected unconsumed report drift");
      const firstDriftLine = drift.trim().split("\n")[0];
      if (firstDriftLine === undefined) throw new Error("missing drift fixture line");
      expect(verdict.issues.some((issue) => issue.includes(firstDriftLine))).toBe(true);
    }
  });

  test("rejects orphan and reordered text-report preamble payload", async () => {
    const report = await textFixture("lr1", "output");
    const common = {
      ...classificationIdentity("lr1"),
      source: await textFixture("lr1", "y"),
      expectedVersion: BISON_VERSION,
      process: completed("lr1"),
      xml: await textFixture("lr1", "xml"),
    } as const;
    const drifts = [
      `    orphan future payload\n\n${report}`,
      `Rules useless in grammar\n\n    1 fake: ID\n\nTerminals unused in grammar\n\n    FUTURE\n\n${report}`,
      `Rules useless in grammar\n\n    unknown payload\n\n${report}`,
      `Terminals unused in grammar\n\n    unquoted payload\n\n${report}`,
      `Terminals unused in grammar\n\nTerminals unused in grammar\n\n    FUTURE\n\n${report}`,
    ];
    for (const textReport of drifts) {
      const verdict = classifyBisonRun({ ...common, textReport });
      expect(verdict.kind).toBe("inconsistent");
    }
  });
});

describe("analyzeBisonLr1 snapshot identity", () => {
  test("a caller grammar mutation after capture cannot change the bytes Bison opens", async () => {
    const dir = await scratch();
    const originalPath = join(dir, "caller-parser.y");
    const capturedPath = join(dir, "captured-by-tool.y");
    const snapshotXmlPath = join(dir, "snapshot.xml");
    const fakeBison = join(dir, "bison");
    const originalSource = await textFixture("lr1", "y");
    await writeFile(originalPath, originalSource);
    await writeFile(
      snapshotXmlPath,
      (await textFixture("lr1", "xml")).replace("<filename>lr1.y</filename>", "<filename>parser.y</filename>"),
    );
    await writeFile(
      fakeBison,
      `#!/bin/bash
set -eu
/usr/bin/printf '%%define lr.type lalr\n%%%%\nchanged: ;\n' > "$KTOOL_RACE_ORIGINAL"
last=""
for argument in "$@"; do last="$argument"; done
/bin/cp "$last" "$KTOOL_RACE_CAPTURED"
/bin/cp "$KTOOL_RACE_XML" parser.xml
/bin/cp "$KTOOL_RACE_REPORT" parser.output
`,
    );
    await chmod(fakeBison, 0o755);

    const verdict = await analyzeBisonLr1({
      bisonExecutable: fakeBison,
      grammarPath: originalPath,
      expectedVersion: BISON_VERSION,
      env: {
        KTOOL_RACE_ORIGINAL: originalPath,
        KTOOL_RACE_CAPTURED: capturedPath,
        KTOOL_RACE_XML: snapshotXmlPath,
        KTOOL_RACE_REPORT: resolve(fixture("lr1", "output")),
      },
    });
    expect(verdict.kind).toBe("lr1");
    if (verdict.kind !== "lr1") throw new Error(`expected snapshot to remain lr1, found ${verdict.kind}`);
    expect(await readFile(originalPath, "utf8")).toContain("lr.type lalr");
    expect(await readFile(capturedPath, "utf8")).toBe(originalSource);
    expect(verdict.evidence.requestedGrammarPath).toBe(originalPath);
    expect(verdict.evidence.analyzedGrammarPath).not.toBe(originalPath);
    expect(verdict.evidence.process.args.at(-1)).toBe("parser.y");
    expect(verdict.evidence.process.args).toEqual(verdict.evidence.normativeArgv);
  });
});

const bisonExecutable = process.env["KFRAMEWORK_TS_BISON_BIN"];
const describeBison = bisonExecutable === undefined || bisonExecutable === "" ? describe.skip : describe;

describeBison("GNU Bison 3.8.2 integration", () => {
  const executable = resolve(bisonExecutable ?? "");

  test.each([
    ["lr1", "lr1"],
    ["shift-reduce", "conflicts"],
    ["reduce-reduce", "conflicts"],
    ["unambiguous-non-lr1", "conflicts"],
  ] as const)("strictly analyzes %s as %s", async (name, kind) => {
    const verdict = await analyzeBisonLr1({
      bisonExecutable: executable,
      grammarPath: resolve(fixture(name, "y")),
      expectedVersion: BISON_VERSION,
    });
    expect(verdict.kind).toBe(kind);
  });

  test("%expect makes raw Bison accept but policy and XML independently expose the conflict", async () => {
    const path = resolve(fixture("expected-conflict", "y"));
    const run = await runStrictBison({ bisonExecutable: executable, grammarPath: path });
    expect(run.process.returncode).toBe(0);
    if (run.xml === undefined) throw new Error("expected XML report");
    expect(decodeBisonXml(run.xml, BISON_VERSION).summary.disabledActionCount).toBe(1);
    expect(
      (await analyzeBisonLr1({ bisonExecutable: executable, grammarPath: path, expectedVersion: BISON_VERSION })).kind,
    ).toBe("policy-violation");
  });

  test("raw reports use a stable input identity before evidence hashing", async () => {
    const grammarPath = resolve(fixture("lr1", "y"));
    const source = await textFixture("lr1", "y");
    const first = await runStrictBison({ bisonExecutable: executable, grammarPath });
    const second = await runStrictBison({ bisonExecutable: executable, grammarPath });
    if (
      first.xml === undefined ||
      first.textReport === undefined ||
      second.xml === undefined ||
      second.textReport === undefined
    ) {
      throw new Error("expected complete reports from both strict Bison runs");
    }
    expect(first.xml).toEqual(second.xml);
    expect(first.textReport).toEqual(second.textReport);
    expect(decodeBisonXml(first.xml, BISON_VERSION).filename).toBe("parser.y");
    expect(first.process.args).toContain(
      `--file-prefix-map=${dirname(first.analyzedGrammarPath)}=${BISON_INPUT_VIRTUAL_DIRECTORY}`,
    );
    const classify = (run: typeof first) =>
      classifyBisonRun({
        source,
        requestedGrammarPath: grammarPath,
        bisonExecutable: executable,
        grammarPath: run.analyzedGrammarPath,
        expectedVersion: BISON_VERSION,
        process: run.process,
        xml: run.xml,
        textReport: run.textReport,
      });
    const firstVerdict = classify(first);
    const secondVerdict = classify(second);
    expect(firstVerdict.kind).toBe("lr1");
    expect(secondVerdict.kind).toBe("lr1");
    if (firstVerdict.kind !== "lr1" || secondVerdict.kind !== "lr1") {
      throw new Error("expected both deterministic runs to classify as lr1");
    }
    expect(firstVerdict.evidence.xmlSha256).toBe(secondVerdict.evidence.xmlSha256);
    expect(firstVerdict.evidence.textReportSha256).toBe(secondVerdict.evidence.textReportSha256);
  });

  test("rule-level %expect 0 is rejected even though raw Bison accepts a conflict-free grammar", async () => {
    const path = resolve(fixture("rule-expected-zero", "y"));
    const run = await runStrictBison({ bisonExecutable: executable, grammarPath: path });
    expect(run.process.returncode).toBe(0);
    expect(run.process.stderr).toBe("");

    const verdict = await analyzeBisonLr1({
      bisonExecutable: executable,
      grammarPath: path,
      expectedVersion: BISON_VERSION,
    });
    expect(verdict.kind).toBe("policy-violation");
    if (verdict.kind !== "policy-violation") throw new Error("expected rule-level policy violation");
    expect(verdict.violations).toEqual([
      {
        kind: "expected-conflicts",
        directive: "%expect",
        line: 5,
        raw: "start: A %expect 0 ;",
      },
    ]);
  });

  test("precedence makes raw Bison accept but policy and solved-conflict XML independently expose it", async () => {
    const path = resolve(fixture("precedence", "y"));
    const run = await runStrictBison({ bisonExecutable: executable, grammarPath: path });
    expect(run.process.returncode).toBe(0);
    if (run.xml === undefined) throw new Error("expected XML report");
    expect(decodeBisonXml(run.xml, BISON_VERSION).summary.solvedConflictCount).toBe(1);
    expect(
      (await analyzeBisonLr1({ bisonExecutable: executable, grammarPath: path, expectedVersion: BISON_VERSION })).kind,
    ).toBe("policy-violation");
  });

  test("a malformed grammar with missing reports is inconsistent and preserves process evidence", async () => {
    const verdict = await analyzeBisonLr1({
      bisonExecutable: executable,
      grammarPath: resolve(fixture("syntax-error", "y")),
      expectedVersion: BISON_VERSION,
    });
    expect(verdict.kind).toBe("inconsistent");
    if (verdict.kind !== "inconsistent") throw new Error("expected inconsistency");
    expect(verdict.evidence.process.returncode).not.toBe(0);
    expect(verdict.evidence.process.stderr).not.toBe("");
  });
});
