import { describe, expect, test } from "bun:test";

import { generateKleanProject } from "../src/generate.js";
import { sourceFromKoreText } from "../src/source.js";

const impDefinition = new URL(
  "../../kompiled/fixtures/generated/imp-haskell-kompiled/definition.kore",
  import.meta.url,
);

// These three are axiomatized because the matcher hierarchy and
// the Option-monad hoisting were unported. They are the regression guard for
// that: an equation-lowering fallback here is compatibility debt, never an
// intentional Prelude hook axiom.
const IMP_EXPECTED_DEFINITIONS = [
  "Lbl'Hash'lookup'LParUndsCommUndsRParUnds'IMP'Unds'KItem'Unds'Id'Unds'Map",
  "Lbl'UndsEqlsSlshEqls'Int'Unds'",
  "LblisKResult",
] as const;

describe("in-memory KLean project generation", () => {
  test("requires a bare Lake package name instead of a scoped filesystem path", () => {
    const source = sourceFromKoreText("[] module M sort SortGeneratedTopCell{} [] endmodule []");
    expect(() => generateKleanProject(source, { packageName: "@scope/demo" })).toThrow(
      "bare lowercase kebab-case Lake package name",
    );
  });

  test("generates the complete IMP module graph with auditable fallbacks", async () => {
    const project = generateKleanProject(sourceFromKoreText(await Bun.file(impDefinition).text()), {
      packageName: "imp",
      libraryName: "Imp",
    });
    expect([...project.files.keys()]).toEqual([
      "Imp.lean",
      "Imp/Prelude.lean",
      "Imp/Sorts.lean",
      "Imp/Inj.lean",
      "Imp/Func.lean",
      "Imp/Rewrite.lean",
      "lakefile.toml",
      "lean-toolchain",
    ]);
    expect(project.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(project.manifest.emittedRewrites).toHaveLength(56);
    expect(project.files.get("Imp/Rewrite.lean")).toContain("| IMP_assign");
    expect(project.diagnostics).toEqual([]);
    for (const symbol of IMP_EXPECTED_DEFINITIONS) {
      expect(project.manifest.axiomaticFunctions).not.toContain(symbol);
    }
    // Only the collection hooks the Prelude leaves open remain axioms.
    expect(project.manifest.axiomaticFunctions).toEqual([
      "Lbl'Stop'Map",
      "Lbl'Stop'Set",
      "Lbl'Unds'Map'Unds'",
      "Lbl'Unds'Set'Unds'",
      "Lbl'Unds'in'Unds'keys'LParUndsRParUnds'MAP'Unds'Bool'Unds'KItem'Unds'Map",
      "Lbl'UndsPipe'-'-GT-Unds'",
      "LblMap'Coln'lookup",
      "LblMap'Coln'update",
      "LblSet'Coln'in",
      "LblSetItem",
      "Lblkeys'LParUndsRParUnds'MAP'Unds'Set'Unds'Map",
    ]);
  });
});
