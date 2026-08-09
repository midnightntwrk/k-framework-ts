/**
 * Opt-in end-to-end tests for K's deterministic Bison generation boundary.
 *
 * Both tools are explicit: `KFRAMEWORK_TS_K_BIN` selects K through the shared
 * testing harness, and `KFRAMEWORK_TS_BISON_BIN` names the Bison whose
 * immutable snapshot is bound into K's PATH and reused for independent
 * analysis.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { kTestEnabled, requireKTestEnvironment } from "@kframework-ts/ktool/testing";

import {
  analyzeBisonGrammarPolicy,
  analyzeBisonLr1,
  classifyKDiagnostic,
  generateBisonGrammar,
  GeneratedBisonGrammarError,
  kompileDetailed,
  type GeneratedBisonGrammar,
  type KompileSpec,
} from "../src/index.ts";
import { K_RELEASE } from "../src/version.ts";

const HERE = import.meta.dirname;
const FIXTURES = join(HERE, "fixtures", "live-k");
const BISON_BIN_ENV = "KFRAMEWORK_TS_BISON_BIN";
const BISON_RELEASE = "3.8.2";
const LIVE_TIMEOUT_MS = 120_000;
const scratchDirs: string[] = [];

interface LiveFixture {
  readonly stem: string;
  readonly module: string;
}

const LR1 = { stem: "lr1", module: "GENERATED-BISON-LR1" } as const;
const AMBIGUOUS = { stem: "ambiguous", module: "GENERATED-BISON-AMBIGUOUS" } as const;
const UNAMBIGUOUS_NON_LR1 = {
  stem: "unambiguous-non-lr1",
  module: "GENERATED-BISON-UNAMBIGUOUS-NON-LR1",
} as const;
const UNUSED = { stem: "unused", module: "GENERATED-BISON-UNUSED" } as const;
const NOT_LR1 = { stem: "not-lr1", module: "GENERATED-BISON-NOT-LR1" } as const;
const ADDITIONAL_PARSER = {
  stem: "additional-parser",
  module: "GENERATED-BISON-ADDITIONAL-PARSER",
} as const;

const bisonConfigured = configuredBison() !== undefined;
const describeLive = kTestEnabled() && bisonConfigured ? describe : describe.skip;

afterAll(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describeLive("generated deterministic Bison grammar with real K", () => {
  test(
    "a minimal PGM grammar generates conflict-free IELR evidence with one bound Bison identity",
    async () => {
      const generated = await generate(LR1);
      expect(generated.kompile.process.returncode).toBe(0);
      expect(generated.kompile.process.stderr).toBe("");
      expect(analyzeBisonGrammarPolicy(generated.source)).toEqual({ lrType: "ielr", violations: [] });
      expect(generated.generatedBisonVersion).toBe(BISON_RELEASE);
      expect(generated.versionMarkers.c.line).toBe(`#define YYBISON_VERSION "${BISON_RELEASE}"`);
      expect(generated.versionMarkers.header.line).toBe(`/* A Bison parser, made by GNU Bison ${BISON_RELEASE}.  */`);

      const verdict = await analyze(generated);
      expect(verdict.kind).toBe("lr1");
      if (verdict.kind !== "lr1") throw new Error(`expected lr1, found ${verdict.kind}`);
      expect(verdict.evidence.report.version).toBe(BISON_RELEASE);
      expect(verdict.evidence.process.args[0]).toBe(generated.bisonInvocation.snapshotExecutable);
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    "K succeeds on an ambiguous grammar while the independent strict pass exposes its conflict",
    async () => {
      const generated = await generate(AMBIGUOUS);
      expect(generated.kompile.process.returncode).toBe(0);
      expect(generated.kompile.process.stderr).toBe("");

      const verdict = await analyze(generated);
      expect(verdict.kind).toBe("conflicts");
      if (verdict.kind !== "conflicts") throw new Error(`expected conflicts, found ${verdict.kind}`);
      expect(verdict.conflicts.some((conflict) => conflict.kind === "shift-reduce")).toBe(true);
      expect(verdict.evidence.process.returncode).toBe(1);
      expect(verdict.evidence.report.summary.shiftReduceConflictCount).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    "K succeeds on an unambiguous LR(2) grammar while the independent strict pass proves it is not LR(1)",
    async () => {
      const generated = await generate(UNAMBIGUOUS_NON_LR1);
      expect(generated.kompile.process.returncode).toBe(0);
      expect(generated.kompile.process.stderr).toBe("");

      const verdict = await analyze(generated);
      expect(verdict.kind).toBe("conflicts");
      if (verdict.kind !== "conflicts") throw new Error(`expected conflicts, found ${verdict.kind}`);
      expect(verdict.conflicts.some((conflict) => conflict.kind === "reduce-reduce")).toBe(true);
      expect(verdict.evidence.process.returncode).toBe(1);
      expect(verdict.evidence.report.summary.reduceReduceConflictCount).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    "unused syntax is fatal without suppression and generation suppresses only unused-symbol",
    async () => {
      const generated = await generate(UNUSED);
      expect(generated.kompile.process.returncode).toBe(0);
      const argv = generated.kompile.process.args;
      expect(argv.slice(argv.indexOf("-Wno"), argv.indexOf("-Wno") + 2)).toEqual(["-Wno", "unused-symbol"]);

      const scratch = await liveScratch();
      const unsuppressed = await kompileDetailed(spec(UNUSED), {
        command: [(await requireKTestEnvironment()).kompilePath],
        outputDir: join(scratch, "unsuppressed-output"),
        tempDir: scratch,
        typeInferenceMode: "checked",
        warnings: "all",
        warningsToErrors: true,
        debug: true,
        check: false,
        env: generated.environment,
      });
      expect(unsuppressed.process.returncode).toBe(113);
      expect(unsuppressed.process.args).not.toContain("-Wno");
      expect(unsuppressed.process.stderr).toContain("not used");
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    "unused-symbol suppression does not suppress an imported not-lr1 module",
    async () => {
      try {
        await generate(NOT_LR1);
        throw new Error("expected not-lr1 generation to fail");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(GeneratedBisonGrammarError);
        if (!(error instanceof GeneratedBisonGrammarError)) throw error;
        expect(error.code).toBe("kompile-failed");
        expect(error.process?.returncode).toBe(113);
        expect(error.process?.args.slice(error.process.args.indexOf("-Wno"))).toEqual(["-Wno", "unused-symbol"]);
        expect(error.diagnostics).toHaveLength(1);
        expect(classifyKDiagnostic(error.diagnostics[0]!)).toEqual({
          family: "inner-parser",
          tag: "non-lr-grammar",
        });
      }
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    "a real additional parser attribute is rejected instead of misidentifying retained parser.y",
    async () => {
      try {
        await generate(ADDITIONAL_PARSER);
        throw new Error("expected an additional generated parser to be unsupported");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(GeneratedBisonGrammarError);
        if (!(error instanceof GeneratedBisonGrammarError)) throw error;
        expect(error.code).toBe("parser-identity-unsupported");
        expect(error.process?.returncode).toBe(0);
        expect(error.paths.some((path) => path.includes("parser_Mode_GENERATED-BISON-MODE"))).toBe(true);
      }
    },
    LIVE_TIMEOUT_MS,
  );
});

async function generate(fixture: LiveFixture): Promise<GeneratedBisonGrammar> {
  const scratch = await liveScratch();
  const k = await requireKTestEnvironment();
  return generateBisonGrammar({
    spec: spec(fixture),
    startSort: "Pgm",
    syntaxModule: `${fixture.module}-SYNTAX`,
    expectedKVersion: K_RELEASE,
    expectedBisonVersion: BISON_RELEASE,
    kompileExecutable: k.kompilePath,
    bisonExecutable: bisonPath(),
    tempDir: scratch,
    outputDir: join(scratch, "output"),
    env: childEnvironment(),
  });
}

function spec(fixture: LiveFixture): KompileSpec {
  return {
    backend: "haskell",
    mainFile: join(FIXTURES, `generated-bison-${fixture.stem}.k`),
    mainModule: fixture.module,
    syntaxModule: `${fixture.module}-SYNTAX`,
    haskellBinary: false,
  };
}

function analyze(generated: GeneratedBisonGrammar) {
  return analyzeBisonLr1({
    bisonExecutable: generated.bisonInvocation.snapshotExecutable,
    grammarPath: generated.artifacts.parserSource,
    expectedVersion: BISON_RELEASE,
    env: generated.environment,
  });
}

async function liveScratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ktool-generated-bison-live-"));
  scratchDirs.push(dir);
  return dir;
}

function configuredBison(): string | undefined {
  const value = process.env[BISON_BIN_ENV];
  return value === undefined || value === "" ? undefined : value;
}

function bisonPath(): string {
  const value = configuredBison();
  if (value === undefined) throw new Error(`Real generated-Bison tests require ${BISON_BIN_ENV}`);
  if (!isAbsolute(value)) throw new Error(`${BISON_BIN_ENV} must name an absolute executable`);
  return value;
}

function childEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }
  return Object.freeze(environment);
}
