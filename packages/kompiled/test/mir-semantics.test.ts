/** KMIR exercises explicit priorities on real, production-sized K rules. */

import { describe, expect, test } from "bun:test";

import { MIR_CENSUS, MIR_DEFINITION_HASH } from "@kframework-ts/mir-fixtures";
import { Atts, rulePriority } from "@kframework-ts/kast";

import { MissingKompiledFileError } from "../src/errors.ts";
import { loadKompiledDefinition } from "../src/fs.ts";
import { caught } from "./caught.ts";
import { MIR_HASKELL } from "./fixtures.ts";

const mir = await loadKompiledDefinition(MIR_HASKELL);

describe("the partial KMIR kompiled directory", () => {
  test("is the executable Rust MIR configuration", () => {
    expect(mir.layout.backend).toBe("haskell");
    expect(mir.layout.mainModule).toBe(MIR_CENSUS.mainModule);
    expect(mir.layout.mainSyntaxModule).toBe("KMIR-AST");
    expect(mir.layout.configVars).toEqual(["PGM"]);
    expect(mir.layout.configVarSorts.get("PGM")).toBe("KItem");
    expect(mir.definitionHash).toBe(MIR_DEFINITION_HASH);
  });

  test("keeps KAST and generated macros while omitting the large KORE definitions", () => {
    expect(caught(() => mir.koreDefinition, MissingKompiledFileError).file).toBe("definition.kore");
    expect(caught(() => mir.syntaxKore, MissingKompiledFileError).file).toBe("syntaxDefinition.kore");
    expect(mir.definition.rules.length).toBe(MIR_CENSUS.rules);
    expect(mir.macrosKore.axioms.length).toBe(MIR_CENSUS.macroRules);
  });
});

describe("real KMIR rule priorities", () => {
  test("preserves all explicit values and rule counts", () => {
    const counts = new Map<number, number>();
    for (const rule of mir.definition.rules) {
      if (!rule.att.has(Atts.PRIORITY)) continue;
      const priority = rulePriority(rule);
      counts.set(priority, (counts.get(priority) ?? 0) + 1);
    }

    expect([...counts.entries()].toSorted(([left], [right]) => left - right)).toEqual([
      [40, 16],
      [42, 1],
      [45, 4],
      [55, 1],
      [60, 3],
      [100, 6],
    ]);
    expect([...counts.values()].reduce((sum, count) => sum + count, 0)).toBe(MIR_CENSUS.priorityRules);
    expect(counts.size).toBe(MIR_CENSUS.priorityValues);
  });

  test("retains K's default and owise priority behavior beside explicit values", () => {
    const ordinary = mir.definition.rules.find((rule) => !rule.att.has(Atts.PRIORITY) && !rule.att.has(Atts.OWISE));
    const owise = mir.definition.rules.find((rule) => !rule.att.has(Atts.PRIORITY) && rule.att.has(Atts.OWISE));
    expect(rulePriority(ordinary!)).toBe(50);
    expect(rulePriority(owise!)).toBe(200);
  });
});
