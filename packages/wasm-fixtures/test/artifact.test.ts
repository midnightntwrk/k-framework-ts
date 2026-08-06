/**
 * The vendored bytes, and the constants that claim to describe them.
 *
 * Every number in {@link WASM_CENSUS} and both hashes are re-derived here from
 * the files as committed, so a constant cannot drift from the artifact it is
 * about — which matters more than usual, because two other packages assert
 * against these constants and neither of them re-derives anything.
 *
 * Hermetic: no K install, no network, nothing outside this package.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { readKastDefinitionFromJson } from "@kframework-ts/kast";

import {
  WASM_CENSUS,
  WASM_COMPILED_JSON_SHA256,
  WASM_DEFINITION_HASH,
  WASM_HASKELL_KOMPILED_DIR,
  WASM_PIN,
} from "../src/index.ts";

const compiledJson = readFileSync(join(WASM_HASKELL_KOMPILED_DIR, "compiled.json"), "utf8");
const definition = readKastDefinitionFromJson(compiledJson);

/** One of `kompile`'s one-line marker files, trimmed. */
function marker(file: string): string {
  return readFileSync(join(WASM_HASKELL_KOMPILED_DIR, file), "utf8").trim();
}

describe("the vendored directory", () => {
  test("it resolves from this module, not from the working directory", () => {
    // The property that lets `dist/index.js` and `src/index.ts` agree: the
    // fixture is one level up from either, and the path is absolute.
    expect(basename(WASM_HASKELL_KOMPILED_DIR)).toBe("wasm-haskell-kompiled");
    expect(WASM_HASKELL_KOMPILED_DIR.startsWith("/")).toBe(true);
  });

  test("it is the partial directory PROVENANCE describes — and partial on purpose", () => {
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
      expect(readFileSync(join(WASM_HASKELL_KOMPILED_DIR, file)).length).toBeGreaterThan(0);
    }
    // The two the fixture budget bought back.  Their absence is the reason
    // `kompile-soak` exists at all, so it is asserted rather than assumed.
    for (const absent of ["definition.kore", "syntaxDefinition.kore"]) {
      expect(() => readFileSync(join(WASM_HASKELL_KOMPILED_DIR, absent))).toThrow();
    }
  });

  test("compiled.json is byte-for-byte the file PROVENANCE checksums", () => {
    expect(createHash("sha256").update(compiledJson).digest("hex")).toBe(WASM_COMPILED_JSON_SHA256);
    expect(compiledJson.length).toBe(4_902_059);
  });
});

describe("the constants two other packages assert against", () => {
  test("WASM_DEFINITION_HASH is this definition's KAst.hash", () => {
    // The soak-identity guard.  If this ever disagrees with the bytes, both
    // soaks are asserting against a number that describes nothing.
    expect(definition.hash).toBe(WASM_DEFINITION_HASH);
  });

  test("WASM_CENSUS is measured, not remembered", () => {
    expect(definition.mainModuleName).toBe(WASM_CENSUS.mainModule);
    expect(definition.allModules.length).toBe(WASM_CENSUS.modules);
    expect(definition.syntaxProductions.length).toBe(WASM_CENSUS.syntaxProductions);
    expect(new Set(definition.syntaxProductions.map((production) => production.sort.name)).size).toBe(
      WASM_CENSUS.productionSorts,
    );
    expect(definition.rules.length).toBe(WASM_CENSUS.rules);
    expect(definition.overloads.size).toBe(WASM_CENSUS.overloads);
    expect(definition.cellCollectionProductions.length).toBe(WASM_CENSUS.cellCollectionProductions);
    expect(definition.macroRules.length).toBe(WASM_CENSUS.macroRules);
    expect(definition.aliasRules.length).toBe(WASM_CENSUS.aliasRules);
  });

  test("the markers agree with the pin's story about which build this is", () => {
    expect(marker("backend.txt")).toBe("haskell");
    expect(marker("mainModule.txt")).toBe(WASM_CENSUS.mainModule);
    expect(marker("mainSyntaxModule.txt")).toBe("WASM-TEST-SYNTAX");
    // The recorded skew: the semantics pin K 7.1.329 and this was built at
    // 7.1.337, deliberately.  `fixtures/PROVENANCE.md` has the reasoning.
    expect(WASM_PIN.kRelease).not.toBe(WASM_PIN.kBuiltWith);
    expect(WASM_PIN.commit).toMatch(/^[0-9a-f]{40}$/u);
  });
});
