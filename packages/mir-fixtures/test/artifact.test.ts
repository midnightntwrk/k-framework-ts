/** Hermetic integrity and census checks for the vendored KMIR artifact. */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { Atts, readKastDefinitionFromJson } from "@kframework-ts/kast";

import {
  MIR_CENSUS,
  MIR_COMPILED_JSON_SHA256,
  MIR_DEFINITION_HASH,
  MIR_HASKELL_KOMPILED_DIR,
  MIR_PIN,
} from "../src/index.ts";

const compiledJson = readFileSync(join(MIR_HASKELL_KOMPILED_DIR, "compiled.json"), "utf8");
const definition = readKastDefinitionFromJson(compiledJson);

function marker(file: string): string {
  return readFileSync(join(MIR_HASKELL_KOMPILED_DIR, file), "utf8").trim();
}

describe("the vendored KMIR directory", () => {
  test("resolves independently of the working directory", () => {
    expect(basename(MIR_HASKELL_KOMPILED_DIR)).toBe("mir-haskell-kompiled");
    expect(MIR_HASKELL_KOMPILED_DIR.startsWith("/")).toBe(true);
  });

  test("is deliberately partial", () => {
    for (const file of [
      "compiled.json",
      "macros.kore",
      "allRules.txt",
      "configVars.sh",
      "backend.txt",
      "mainModule.txt",
      "mainSyntaxModule.txt",
      "timestamp",
      "README.md",
    ]) {
      expect(readFileSync(join(MIR_HASKELL_KOMPILED_DIR, file)).length).toBeGreaterThan(0);
    }
    for (const absent of ["definition.kore", "syntaxDefinition.kore"]) {
      expect(() => readFileSync(join(MIR_HASKELL_KOMPILED_DIR, absent))).toThrow();
    }
  });

  test("compiled.json matches its recorded byte hash", () => {
    expect(createHash("sha256").update(compiledJson).digest("hex")).toBe(MIR_COMPILED_JSON_SHA256);
    expect(compiledJson.length).toBe(5_044_686);
  });
});

describe("the exported KMIR identity and census", () => {
  test("matches the committed definition hash", () => {
    expect(definition.hash).toBe(MIR_DEFINITION_HASH);
  });

  test("derives every census value from the committed definition", () => {
    expect(definition.mainModuleName).toBe(MIR_CENSUS.mainModule);
    expect(definition.allModules.length).toBe(MIR_CENSUS.modules);
    expect(definition.syntaxProductions.length).toBe(MIR_CENSUS.syntaxProductions);
    expect(new Set(definition.syntaxProductions.map((production) => production.sort.name)).size).toBe(
      MIR_CENSUS.productionSorts,
    );
    expect(definition.rules.length).toBe(MIR_CENSUS.rules);
    expect(definition.overloads.size).toBe(MIR_CENSUS.overloads);
    expect(definition.cellCollectionProductions.length).toBe(MIR_CENSUS.cellCollectionProductions);
    expect(definition.macroRules.length).toBe(MIR_CENSUS.macroRules);
    expect(definition.aliasRules.length).toBe(MIR_CENSUS.aliasRules);
    const priorities = definition.rules
      .filter((rule) => rule.att.has(Atts.PRIORITY))
      .map((rule) => rule.att.require(Atts.PRIORITY));
    expect(priorities.length).toBe(MIR_CENSUS.priorityRules);
    expect(new Set(priorities).size).toBe(MIR_CENSUS.priorityValues);
  });

  test("is the released executable MIR definition", () => {
    expect(marker("backend.txt")).toBe("haskell");
    expect(marker("mainModule.txt")).toBe(MIR_CENSUS.mainModule);
    expect(marker("mainSyntaxModule.txt")).toBe("KMIR-AST");
    expect(marker("configVars.sh")).toContain("declaredConfigVar_PGM='KItem'");
    expect(MIR_PIN.kRelease).toBe(MIR_PIN.kBuiltWith);
    expect(MIR_PIN.commit).toMatch(/^[0-9a-f]{40}$/u);
  });
});
