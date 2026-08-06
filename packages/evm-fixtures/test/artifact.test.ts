/** Hermetic integrity and census checks for the vendored KEVM artifact. */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { Atts, readKastDefinitionFromJson } from "@kframework-ts/kast";

import {
  EVM_CENSUS,
  EVM_COMPILED_JSON_SHA256,
  EVM_DEFINITION_HASH,
  EVM_HASKELL_KOMPILED_DIR,
  EVM_PIN,
} from "../src/index.ts";

const compiledJson = readFileSync(join(EVM_HASKELL_KOMPILED_DIR, "compiled.json"), "utf8");
const definition = readKastDefinitionFromJson(compiledJson);

function marker(file: string): string {
  return readFileSync(join(EVM_HASKELL_KOMPILED_DIR, file), "utf8").trim();
}

describe("the vendored KEVM directory", () => {
  test("resolves independently of the working directory", () => {
    expect(basename(EVM_HASKELL_KOMPILED_DIR)).toBe("evm-haskell-kompiled");
    expect(EVM_HASKELL_KOMPILED_DIR.startsWith("/")).toBe(true);
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
      expect(readFileSync(join(EVM_HASKELL_KOMPILED_DIR, file)).length).toBeGreaterThan(0);
    }
    for (const absent of ["definition.kore", "syntaxDefinition.kore"]) {
      expect(() => readFileSync(join(EVM_HASKELL_KOMPILED_DIR, absent))).toThrow();
    }
  });

  test("compiled.json matches its recorded byte hash", () => {
    expect(createHash("sha256").update(compiledJson).digest("hex")).toBe(EVM_COMPILED_JSON_SHA256);
    expect(compiledJson.length).toBe(9_759_752);
  });
});

describe("the exported KEVM identity and census", () => {
  test("matches the committed definition hash", () => {
    expect(definition.hash).toBe(EVM_DEFINITION_HASH);
  });

  test("derives every census value from the committed definition", () => {
    expect(definition.mainModuleName).toBe(EVM_CENSUS.mainModule);
    expect(definition.allModules.length).toBe(EVM_CENSUS.modules);
    expect(definition.syntaxProductions.length).toBe(EVM_CENSUS.syntaxProductions);
    expect(new Set(definition.syntaxProductions.map((production) => production.sort.name)).size).toBe(
      EVM_CENSUS.productionSorts,
    );
    expect(definition.rules.length).toBe(EVM_CENSUS.rules);
    expect(definition.overloads.size).toBe(EVM_CENSUS.overloads);
    expect(definition.cellCollectionProductions.length).toBe(EVM_CENSUS.cellCollectionProductions);
    expect(definition.rules.filter((rule) => rule.att.has(Atts.MACRO)).length).toBe(EVM_CENSUS.macroAttributeRules);
    expect(definition.macroRules.length).toBe(EVM_CENSUS.macroRules);
    expect(definition.aliasRules.length).toBe(EVM_CENSUS.aliasRules);
  });

  test("is the released executable Ethereum definition", () => {
    expect(marker("backend.txt")).toBe("haskell");
    expect(marker("mainModule.txt")).toBe(EVM_CENSUS.mainModule);
    expect(marker("mainSyntaxModule.txt")).toBe(EVM_CENSUS.mainModule);
    expect(marker("configVars.sh")).toContain("declaredConfigVar_PGM='EthereumSimulation'");
    expect(EVM_PIN.kRelease).toBe(EVM_PIN.kBuiltWith);
    expect(EVM_PIN.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(EVM_PIN.pluginCommit).toMatch(/^[0-9a-f]{40}$/u);
  });
});
