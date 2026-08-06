/** KEVM exercises the alias half of KDefinition.macroRules on real K output. */

import { describe, expect, test } from "bun:test";

import { EVM_CENSUS, EVM_DEFINITION_HASH } from "@kframework-ts/evm-fixtures";
import { Atts, sentenceUniqueId } from "@kframework-ts/kast";
import { ATT_UNIQUE_ID, attString } from "@kframework-ts/kore";

import { MissingKompiledFileError } from "../src/errors.ts";
import { loadKompiledDefinition } from "../src/fs.ts";
import { caught } from "./caught.ts";
import { EVM_HASKELL } from "./fixtures.ts";

const evm = await loadKompiledDefinition(EVM_HASKELL);

describe("the partial KEVM kompiled directory", () => {
  test("is the executable Ethereum configuration", () => {
    expect(evm.layout.backend).toBe("haskell");
    expect(evm.layout.mainModule).toBe(EVM_CENSUS.mainModule);
    expect(evm.layout.mainSyntaxModule).toBe(EVM_CENSUS.mainModule);
    expect(evm.layout.configVars).toEqual(["SCHEDULE", "PGM", "USEGAS", "MODE", "CHAINID"]);
    expect(evm.layout.configVarSorts.get("PGM")).toBe("EthereumSimulation");
    expect(evm.definitionHash).toBe(EVM_DEFINITION_HASH);
  });

  test("keeps the KAST layer while omitting the two large KORE definitions", () => {
    expect(caught(() => evm.koreDefinition, MissingKompiledFileError).file).toBe("definition.kore");
    expect(caught(() => evm.syntaxKore, MissingKompiledFileError).file).toBe("syntaxDefinition.kore");
    expect(evm.definition.rules.length).toBe(EVM_CENSUS.rules);
  });
});

describe("real KEVM aliases", () => {
  test("exercise both halves of KDefinition.macroRules", () => {
    const macros = evm.definition.rules.filter((rule) => rule.att.has(Atts.MACRO));
    expect(macros.length).toBe(EVM_CENSUS.macroAttributeRules);
    expect(evm.definition.aliasRules.length).toBe(EVM_CENSUS.aliasRules);
    expect(evm.definition.macroRules.length).toBe(macros.length + evm.definition.aliasRules.length);
    expect(evm.definition.macroRules.length).toBe(EVM_CENSUS.macroRules);
  });

  test("join exactly to the generated macros.kore axioms by UNIQUE_ID", () => {
    const fromKore = new Set(evm.macrosKore.axioms.map((axiom) => attString(axiom.attrs, ATT_UNIQUE_ID)));
    const fromKast = new Set(
      evm.definition.macroRules
        .map((rule) => sentenceUniqueId(rule))
        .filter((id): id is string => typeof id === "string"),
    );
    expect(fromKore.size).toBe(EVM_CENSUS.macroRules);
    expect(fromKore).toEqual(fromKast);
  });
});
