/** Opt-in live coverage for deterministic PGM parser-source capture. */

import { describe, expect, test } from "bun:test";
import { delimiter } from "node:path";
import { dirname, isAbsolute, join } from "node:path";

import { kTestEnabled, requireKTestEnvironment } from "@kframework-ts/ktool/testing";

import {
  checkKGrammarLr1,
  generateKParserGrammar,
  KParserGrammarCaptureError,
  type KompileSpec,
} from "../src/index.ts";
import { K_RELEASE } from "../src/version.ts";

const HERE = import.meta.dirname;
const FIXTURES = join(HERE, "fixtures", "live-k");
const LIVE_TIMEOUT_MS = 120_000;
const BISON_BIN_ENV = "KFRAMEWORK_TS_BISON_BIN";
const describeLive = kTestEnabled() && configuredBison() !== undefined ? describe : describe.skip;

const LR1 = { stem: "lr1", module: "GENERATED-BISON-LR1" } as const;
const UNUSED = { stem: "unused", module: "GENERATED-BISON-UNUSED" } as const;
const ADDITIONAL = { stem: "additional-parser", module: "GENERATED-BISON-ADDITIONAL-PARSER" } as const;

describeLive("K PGM parser-source capture", () => {
  test(
    "captures the retained deterministic PGM parser as bytes with the strict K policy",
    async () => {
      const generated = await generate(LR1);
      expect(generated.kVersion.text).toBe(K_RELEASE);
      expect(new TextDecoder().decode(generated.source.bytes)).toContain("%define lr.type ielr");
      expect(generated.target).toEqual({ kind: "pgm" });
      const argv = generated.process.args;
      expect(argv).toContain("--gen-bison-parser");
      expect(argv).toContain("--debug");
      expect(argv).toContain("--warnings-to-errors");
      expect(argv.slice(argv.indexOf("-Wno"), argv.indexOf("-Wno") + 2)).toEqual(["-Wno", "unused-symbol"]);
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    "keeps unused-symbol as the sole tolerated warning",
    async () => {
      const generated = await generate(UNUSED);
      expect(generated.process.returncode).toBe(0);
      expect(generated.process.args.slice(generated.process.args.indexOf("-Wno"))).toContain("unused-symbol");
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    "composes capture with byte-oriented Bison analysis without losing either result",
    async () => {
      const checked = await check(LR1);
      expect(checked.capture.target).toEqual({ kind: "pgm" });
      expect(checked.analysis.classification).toEqual({ kind: "lr1" });
      expect(checked.unprovedBoundaries).toContain("scanner-determinism");
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    "rejects a configuration-selected additional parser target",
    async () => {
      try {
        await generate(ADDITIONAL);
        throw new Error("expected additional parser capture to fail");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(KParserGrammarCaptureError);
        expect(error).toMatchObject({ code: "parser-target-unsupported" });
      }
    },
    LIVE_TIMEOUT_MS,
  );
});

async function generate(fixture: { readonly stem: string; readonly module: string }) {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }
  environment.PATH = dirname(bisonPath()) + delimiter + (environment.PATH ?? "");
  const k = await requireKTestEnvironment();
  return generateKParserGrammar(spec(fixture), {
    command: [k.kompilePath],
    env: environment,
  });
}

async function check(fixture: { readonly stem: string; readonly module: string }) {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }
  environment.PATH = dirname(bisonPath()) + delimiter + (environment.PATH ?? "");
  const k = await requireKTestEnvironment();
  return checkKGrammarLr1(spec(fixture), {
    capture: {
      command: [k.kompilePath],
      env: environment,
      timeoutMs: LIVE_TIMEOUT_MS,
    },
    bison: {
      tool: { command: [bisonPath()] },
      timeoutMs: LIVE_TIMEOUT_MS,
    },
  });
}

function configuredBison(): string | undefined {
  const value = process.env[BISON_BIN_ENV];
  return value === undefined || value === "" ? undefined : value;
}

function bisonPath(): string {
  const value = configuredBison();
  if (value === undefined || !isAbsolute(value)) {
    throw new Error("Live K parser-source capture requires an absolute " + BISON_BIN_ENV);
  }
  return value;
}

function spec(fixture: { readonly stem: string; readonly module: string }): KompileSpec {
  return {
    backend: "haskell",
    mainFile: join(FIXTURES, "generated-bison-" + fixture.stem + ".k"),
    mainModule: fixture.module,
    syntaxModule: fixture.module + "-SYNTAX",
    haskellBinary: false,
  };
}
