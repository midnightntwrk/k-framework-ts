import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CompletedProcessSchema,
  BisonGrammarPolicyViolationSchema,
  BisonSolvedConflictViolationSchema,
  KAmbiguityAlternativeSchema,
  KDiagnosticSchema,
  KInnerParserMessageTagSchema,
  KMessageClassSchema,
  KVersionParseResultSchema,
  KVersionResultSchema,
  classifyKDiagnostic,
  parseAmbiguity,
  parseKDiagnostics,
  runProcess,
  tryParseKVersion,
} from "../src/index.ts";

const DIAGNOSTICS = join(import.meta.dir, "..", "fixtures", "diagnostics");

describe("public runtime schemas", () => {
  test("accept values produced by the process, diagnostics, and version parsers", async () => {
    const process = await runProcess(["bash", "-c", "printf schema-out"]);
    expect(CompletedProcessSchema.safeParse(process).success).toBe(true);

    const diagnostics = parseKDiagnostics(await readFile(join(DIAGNOSTICS, "ambiguity.stderr"), "utf8"));
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of diagnostics) {
      expect(KDiagnosticSchema.safeParse(diagnostic).success).toBe(true);
      expect(KMessageClassSchema.safeParse(classifyKDiagnostic(diagnostic)).success).toBe(true);
      for (const alternative of parseAmbiguity(diagnostic))
        expect(KAmbiguityAlternativeSchema.safeParse(alternative).success).toBe(true);
    }

    const known = tryParseKVersion("v7.1.337-3-g0123456789-dirty");
    const unknown = tryParseKVersion("local-build");
    expect(KVersionParseResultSchema.safeParse(known).success).toBe(true);
    expect(KVersionParseResultSchema.safeParse(unknown).success).toBe(true);
    if (known.kind === "parsed") {
      expect(
        KVersionResultSchema.safeParse({
          ...known.version,
          banner: "K version: v7.1.337-3-g0123456789-dirty\n",
          line: "K version: v7.1.337-3-g0123456789-dirty",
        }).success,
      ).toBe(true);
    }
  });

  test("reject malformed nested records while preserving semantic parsing outside schemas", async () => {
    const [diagnostic] = parseKDiagnostics(await readFile(join(DIAGNOSTICS, "ambiguity.stderr"), "utf8"));
    expect(diagnostic).toBeDefined();
    expect(KDiagnosticSchema.safeParse({ ...diagnostic!, rawLines: [42] }).success).toBe(false);
    expect(KMessageClassSchema.safeParse({ family: "inner-parser", tag: "not-a-k-tag" }).success).toBe(false);
    expect(KAmbiguityAlternativeSchema.safeParse({ index: "1", production: "P", term: null }).success).toBe(false);
    expect(CompletedProcessSchema.safeParse({ args: ["x"], stdout: "", stderr: "", signal: undefined }).success).toBe(
      true,
    );
    expect(CompletedProcessSchema.safeParse({ args: ["x"], stdout: "", stderr: "" }).success).toBe(false);
    expect(CompletedProcessSchema.safeParse({ args: ["x"], stdout: "", stderr: 2, signal: undefined }).success).toBe(
      false,
    );
    expect(
      KVersionResultSchema.safeParse({
        major: 7,
        minor: 1,
        patch: 337,
        text: "v7.1.337",
        banner: "K version",
        line: "K version",
      }).success,
    ).toBe(false);
    expect(
      KVersionResultSchema.safeParse({
        major: 7,
        minor: 1,
        patch: 337,
        git: undefined,
        text: "v7.1.337",
        banner: "K version",
        line: "K version",
      }).success,
    ).toBe(true);
    expect(KInnerParserMessageTagSchema.safeParse("parse-unexpected-token").success).toBe(true);
    expect(KInnerParserMessageTagSchema.safeParse("future-tag").success).toBe(false);
    expect(
      BisonGrammarPolicyViolationSchema.safeParse({
        line: 3,
        raw: "%left PLUS",
        kind: "precedence-resolution",
        directive: "%left",
      }).success,
    ).toBe(true);
    expect(
      BisonSolvedConflictViolationSchema.safeParse({
        kind: "solved-conflict",
        state: 1,
        rule: 2,
        symbol: "PLUS",
        type: "shift",
      }).success,
    ).toBe(false);
  });
});
