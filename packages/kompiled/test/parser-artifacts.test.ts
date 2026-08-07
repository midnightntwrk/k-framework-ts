import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectBisonParserArtifacts } from "../src/fs.ts";
import { parseKompiledLayout } from "../src/layout.ts";
import { bisonParserLibrarySuffix, bisonParserName, expectedBisonParserArtifacts } from "../src/parser-artifacts.ts";

const layout = parseKompiledLayout({
  mainModule: "TEST",
  mainSyntaxModule: "TEST-SYNTAX",
  backend: "llvm",
  timestampMtimeMs: 0,
  configVarsSh: [
    "declaredConfigVars=( PGM INPUT )",
    "declaredConfigVar_PGM='Pgm'",
    "declaredConfigVarModule_INPUT='INPUT-SYNTAX'",
  ].join("\n"),
});

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kframework-ts-parser-artifacts-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("Bison parser names", () => {
  test("uses K's executable and library spellings, including the platform suffix", () => {
    expect(bisonParserName("Pgm", "TEST-SYNTAX")).toBe("parser_Pgm_TEST-SYNTAX");
    expect(bisonParserName("#Exp", "A_B-C", { library: true, platform: "linux" })).toBe("libparser_#Exp_A_B-C.so");
    expect(bisonParserName("#Exp", "A_B-C", { library: true, platform: "darwin" })).toBe("libparser_#Exp_A_B-C.dylib");
    expect(bisonParserLibrarySuffix("linux")).toBe(".so");
    expect(bisonParserLibrarySuffix("darwin")).toBe(".dylib");
    expect(bisonParserLibrarySuffix("win32")).toBe(".dll");
  });

  test("derives PGM and parser-attribute artifacts forward, with K's K fallback", () => {
    expect(expectedBisonParserArtifacts(layout, { platform: "linux" })).toEqual([
      {
        kind: "concrete",
        sort: "Pgm",
        module: "TEST-SYNTAX",
        executable: "parser_Pgm_TEST-SYNTAX",
        library: "libparser_Pgm_TEST-SYNTAX.so",
      },
      {
        kind: "concrete",
        sort: "K",
        module: "INPUT-SYNTAX",
        executable: "parser_K_INPUT-SYNTAX",
        library: "libparser_K_INPUT-SYNTAX.so",
      },
      {
        kind: "alias",
        configVar: "PGM",
        file: "parser_PGM",
        sort: "Pgm",
        module: "TEST-SYNTAX",
        expectedTargets: ["parser_Pgm_TEST-SYNTAX", "libparser_Pgm_TEST-SYNTAX.so"],
      },
      {
        kind: "alias",
        configVar: "INPUT",
        file: "parser_INPUT",
        sort: "K",
        module: "INPUT-SYNTAX",
        expectedTargets: ["parser_K_INPUT-SYNTAX", "libparser_K_INPUT-SYNTAX.so"],
      },
    ]);
  });
});

describe("passive parser-artifact inspection", () => {
  test("treats missing generation as normal and reports an alias mismatch without executing anything", async () => {
    const dir = join(scratch, "inspection");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "parser_Pgm_TEST-SYNTAX"), "not a native parser");
    await symlink("wrong-target", join(dir, "parser_PGM"));

    const inspected = await inspectBisonParserArtifacts(dir, layout);
    const concrete = inspected.find((entry) => entry.artifact.kind === "concrete" && entry.artifact.sort === "Pgm");
    const pgmAlias = inspected.find((entry) => entry.artifact.kind === "alias" && entry.artifact.configVar === "PGM");
    const inputAlias = inspected.find(
      (entry) => entry.artifact.kind === "alias" && entry.artifact.configVar === "INPUT",
    );

    expect(concrete).toMatchObject({
      status: "present",
      executablePath: join(dir, "parser_Pgm_TEST-SYNTAX"),
    });
    expect(pgmAlias).toMatchObject({
      status: "target",
      target: "wrong-target",
      diagnostic: { kind: "unexpected-alias-target", actual: "wrong-target" },
    });
    expect(inputAlias).toMatchObject({ status: "missing" });
  });

  test("refuses a malformed parser alias before it can escape the directory", async () => {
    const base = parseKompiledLayout({
      mainModule: "TEST",
      mainSyntaxModule: "TEST-SYNTAX",
      backend: "llvm",
      timestampMtimeMs: 0,
    });
    // A malicious in-memory layout is still external input to the fs shell;
    // the parser's own configVars grammar cannot produce this spelling.
    const unsafe = {
      ...base,
      configVarModules: new Map([["../outside", "TEST-SYNTAX"]]),
    };
    const alias = (await inspectBisonParserArtifacts(join(scratch, "unsafe"), unsafe)).find(
      (entry) => entry.artifact.kind === "alias" && entry.artifact.configVar === "../outside",
    );
    expect(alias).toMatchObject({ status: "unsafe-path" });
  });
});
