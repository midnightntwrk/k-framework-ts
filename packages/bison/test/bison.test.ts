import { afterEach, describe, expect, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  BisonGrammarPolicyAnalysisSchema,
  BisonLr1AnalysisSchema,
  BisonLr1EvidenceSchema,
  BisonLr1VerdictSchema,
  BisonRunEvidenceSchema,
  BisonXmlDecodeError,
  BisonXmlReportSchema,
  CompletedProcessSchema,
  analyzeBisonGrammarPolicy,
  analyzeBisonLr1,
  analyzeBisonLr1File,
  bisonAnalysisFingerprint,
  buildStrictBisonArgv,
  classifyBisonRun,
  decodeBisonXml,
  parseBisonXmlReport,
  normalizeBisonEvidenceText,
  resolveOnPath,
  type CompletedProcess,
} from "../src/testing.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
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
  const dir = await mkdtemp(join(tmpdir(), "kframework-ts-bison-test-"));
  scratchDirs.push(dir);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("Bison structural schemas", () => {
  test("aggregate parsing preserves the public readonly runtime boundary", () => {
    const source = new Uint8Array();
    const parsed = BisonLr1AnalysisSchema.parse({
      source: { bytes: source, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
      classification: { kind: "tool-failure", failure: { message: "not run" } },
      policyDiagnostics: [],
    });

    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.source)).toBe(true);
    expect(Object.isFrozen(parsed.classification)).toBe(true);
  });

  test("uses a portable string representation for process signals", () => {
    const process = completed("lr1", { signal: "SIGKILL" });
    expect(CompletedProcessSchema.parse(process).signal).toBe("SIGKILL");
  });

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
  test("resolves a separator-containing command relative to the supplied tool cwd", async () => {
    const cwd = await scratch();
    const executable = join(cwd, "tools", "bison");
    await mkdir(join(cwd, "tools"));
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);

    expect(await resolveOnPath("./tools/bison", "", cwd)).toBe(executable);
    expect(await resolveOnPath("./tools/missing-bison", "", cwd)).toBeUndefined();
  });

  test("passes a supplied tool cwd to relative Bison command resolution", async () => {
    const cwd = await scratch();
    const tools = join(cwd, "tools");
    const executable = join(tools, "bison");
    await mkdir(tools);
    await writeFile(
      executable,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "bison (GNU Bison) 3.8.3"
fi
`,
    );
    await chmod(executable, 0o755);

    const result = await analyzeBisonLr1({
      source: new TextEncoder().encode("%%\n"),
      env: { PATH: "" },
      tool: { command: ["./tools/bison"], cwd },
    });
    expect(result.classification).toMatchObject({
      kind: "tool-failure",
      failure: { message: expect.stringContaining("Unsupported GNU Bison version 3.8.3") },
    });
    expect(result.evidence?.argv[0]).toBe(executable);
  });

  test("constructs the normative deterministic argv exactly", () => {
    expect(buildStrictBisonArgv({ bisonExecutable: "/opt/bison", grammarPath: "/generated/parser.y" })).toEqual([
      "/opt/bison",
      "--force-define=lr.type=ielr",
      "-Werror=conflicts-sr",
      "-Werror=conflicts-rr",
      "--report=all",
      "--report-file=parser.output",
      "--xml=parser.xml",
      "--file-prefix-map=/generated=/kframework-ts-bison-input",
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

test("converts owned-workspace cleanup failure into a tool failure with run evidence", async () => {
  const parent = await scratch();
  const fakeBison = join(parent, "cleanup-failure-bison");
  await writeFile(
    fakeBison,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "bison (GNU Bison) 3.8.2"
  exit 0
fi
/bin/cp "$XML" parser.xml
/bin/cp "$REPORT" parser.output
/bin/chmod a-w "$PARENT"
`,
  );
  await chmod(fakeBison, 0o755);
  try {
    const result = await analyzeBisonLr1({
      source: await readFile(fixture("lr1", "y")),
      tool: { command: [fakeBison] },
      tempDir: parent,
      env: {
        XML: resolve(fixture("lr1", "xml")),
        REPORT: resolve(fixture("lr1", "output")),
        PARENT: parent,
      },
    });
    expect(result.classification.kind).toBe("tool-failure");
    expect(result.tool?.resolvedExecutable).toBe(fakeBison);
    expect(result.evidence?.process.returncode).toBe(0);
  } finally {
    await chmod(parent, 0o755);
  }
});

const bisonExecutable = process.env["KFRAMEWORK_TS_BISON_BIN"];
const describeBison = bisonExecutable === undefined || bisonExecutable === "" ? describe.skip : describe;

describeBison("GNU Bison 3.8.2 integration", () => {
  const executable = resolve(bisonExecutable ?? "");

  async function analyzeV1(name: string) {
    return analyzeBisonLr1({
      source: await readFile(fixture(name, "y")),
      tool: { command: [executable] },
    });
  }

  test.each(["v1-mode-missing", "v1-mode-lalr", "v1-mode-ielr", "v1-mode-canonical"])(
    "forces IELR independently of the %s source selection",
    async (name) => {
      const analysis = await analyzeV1(name);
      expect(analysis.tool).toMatchObject({ version: BISON_VERSION, adapter: "gnu-bison-3.8.2-xml-v1" });
      expect(analysis.classification).toEqual({ kind: "lr1" });
      expect(analysis.policyDiagnostics.length).toBeGreaterThanOrEqual(name === "v1-mode-ielr" ? 0 : 1);
    },
  );

  test("uses forced IELR for an LR(1)-but-not-LALR grammar and retains exact bytes", async () => {
    const bytes = await readFile(fixture("v1-lr1-not-lalr", "y"));
    const analysis = await analyzeBisonLr1({ source: bytes, tool: { command: [executable] } });
    expect(analysis.source.bytes).toEqual(bytes);
    expect(analysis.source.sha256).toHaveLength(64);
    expect(analysis.classification).toEqual({ kind: "lr1" });
    expect(analysis.evidence?.argv).toContain("--force-define=lr.type=ielr");
  });

  test("classifies unresolved and solved conflicts from XML regardless of Bison's conflict-policy exit", async () => {
    const expected = await analyzeV1("expected-conflict");
    expect(expected.evidence?.process.returncode).toBe(0);
    expect(expected.classification.kind).toBe("not-lr1");
    if (expected.classification.kind !== "not-lr1") throw new Error("expected an unresolved conflict");
    expect(expected.classification.conflicts.some((conflict) => conflict.kind === "shift-reduce")).toBe(true);

    const precedence = await analyzeV1("precedence");
    expect(precedence.evidence?.process.returncode).toBe(0);
    expect(precedence.classification.kind).toBe("not-lr1");
    if (precedence.classification.kind !== "not-lr1") throw new Error("expected a solved conflict");
    expect(precedence.classification.conflicts).toContainEqual({
      kind: "solved",
      solved: { state: 5, rule: 2, symbol: '"+"', type: "reduce", resolution: '%left "+"' },
    });

    const unexpected = await analyzeV1("v1-expect-zero-conflict");
    expect(unexpected.evidence?.process.returncode).toBe(1);
    expect(unexpected.classification.kind).toBe("not-lr1");
    if (unexpected.classification.kind !== "not-lr1") throw new Error("expected an unexpected conflict");
    expect(unexpected.classification.conflicts.some((conflict) => conflict.kind === "shift-reduce")).toBe(true);
  });

  test("keeps unused precedence and %expect 0 as non-gating policy diagnostics", async () => {
    for (const name of ["v1-unused-precedence", "v1-expect-zero"]) {
      const analysis = await analyzeV1(name);
      expect(analysis.classification).toEqual({ kind: "lr1" });
      expect(analysis.policyDiagnostics.length).toBeGreaterThan(0);
    }
  });

  test("returns distinct invalid, unsupported, and tool-failure classifications", async () => {
    const invalid = await analyzeV1("syntax-error");
    expect(invalid.classification.kind).toBe("invalid-grammar");

    for (const [name, reason] of [
      ["v1-glr", "glr"],
      ["v1-skeleton", "custom-skeleton"],
      ["v1-glr-dprec", "glr-runtime-control"],
    ] as const) {
      const analysis = await analyzeV1(name);
      expect(analysis.classification.kind).toBe("unsupported-input");
      if (analysis.classification.kind !== "unsupported-input") throw new Error("expected unsupported input");
      expect(analysis.classification.reasons.some((item) => item.kind === reason)).toBe(true);
    }

    const failed = await analyzeBisonLr1({
      source: await readFile(fixture("v1-mode-missing", "y")),
      tool: { command: [join(await scratch(), "missing-bison")] },
    });
    expect(failed.classification.kind).toBe("tool-failure");

    const commandDir = await scratch();
    const marker = join(commandDir, "spawned");
    const markerExecutable = join(commandDir, "marker-bison");
    await writeFile(
      markerExecutable,
      `#!/bin/sh
: > "$MARKER"
echo "bison (GNU Bison) 3.8.2"
`,
    );
    await chmod(markerExecutable, 0o755);
    for (const trailingArgument of [
      "--help",
      "--",
      "-Dlr.type=lalr",
      "-Flr.type=lalr",
      "--language=c++",
      "--skeleton=custom.m4",
    ]) {
      const invalidCommand = await analyzeBisonLr1({
        source: await readFile(fixture("v1-mode-missing", "y")),
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- exercise runtime validation past the tuple type
        tool: { command: [markerExecutable, trailingArgument] as unknown as readonly [string] },
        env: { MARKER: marker },
      });
      expect(invalidCommand.classification).toMatchObject({
        kind: "tool-failure",
        failure: { message: expect.stringContaining("exactly one executable") },
      });
      expect(await exists(marker)).toBe(false);
    }

    const wrapper = join(commandDir, "bison-wrapper");
    await writeFile(
      wrapper,
      `#!/bin/sh
exec "$BISON_UNDER_TEST" "$@"
`,
    );
    await chmod(wrapper, 0o755);
    const wrapped = await analyzeBisonLr1({
      source: await readFile(fixture("v1-mode-missing", "y")),
      tool: { command: [wrapper] },
      env: { BISON_UNDER_TEST: executable },
    });
    expect(wrapped.classification).toEqual({ kind: "lr1" });
    expect(wrapped.tool?.resolvedExecutable).toBe(wrapper);

    const unsupportedTool = join(await scratch(), "bison-3.8.3");
    await writeFile(
      unsupportedTool,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "bison (GNU Bison) 3.8.3"
fi
`,
    );
    await chmod(unsupportedTool, 0o755);
    const unsupportedVersion = await analyzeBisonLr1({
      source: await readFile(fixture("v1-mode-missing", "y")),
      tool: { command: [unsupportedTool] },
    });
    expect(unsupportedVersion.classification).toMatchObject({
      kind: "tool-failure",
      failure: { message: expect.stringContaining("Unsupported GNU Bison version 3.8.3") },
    });
  });

  test("file convenience reads once and delegates to the byte-oriented result", async () => {
    const result = await analyzeBisonLr1File({
      path: resolve(fixture("v1-mode-missing", "y")),
      tool: { command: [executable] },
    });
    expect(result.classification).toEqual({ kind: "lr1" });
  });
});
