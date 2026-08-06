/**
 * Hermetic KLean conformance seed using the committed IMP `definition.kore`.
 *
 * The optional Lake assertion is deliberately opt-in: normal Bun tests only
 * generate an in-memory project and therefore neither require Lean nor write
 * a project. Run it in an environment with the pinned toolchain via:
 *
 *     KLEAN_RUN_LAKE=1 bun test packages/klean/test/imp-conformance.test.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeKleanProject } from "../src/fs.ts";
import { generateKleanProject, type GeneratedProject } from "../src/generate.ts";
import { sourceFromKoreText } from "../src/source.ts";

const IMP_DEFINITION = new URL(
  "../../kompiled/fixtures/generated/imp-haskell-kompiled/definition.kore",
  import.meta.url,
);
const IMP_RULE = "IMP-SYNTAX._%_1-cool";
const OPTIONS = { packageName: "imp-klean", deriveBeq: true, deriveDecidableEq: true } as const;
const PROJECT_FILES = [
  "ImpKlean.lean",
  "ImpKlean/Prelude.lean",
  "ImpKlean/Sorts.lean",
  "ImpKlean/Inj.lean",
  "ImpKlean/Func.lean",
  "ImpKlean/Rewrite.lean",
  "lakefile.toml",
  "lean-toolchain",
];

async function generate(options: Parameters<typeof generateKleanProject>[1] = OPTIONS): Promise<GeneratedProject> {
  return generateKleanProject(sourceFromKoreText(await Bun.file(IMP_DEFINITION).text()), options);
}

function expectNoGenerationErrors(project: GeneratedProject): void {
  expect(project.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
}

async function expectLakeBuild(project: GeneratedProject, root: string): Promise<void> {
  const destination = await writeKleanProject(project, root);
  const process = Bun.spawn(["lake", "build"], { cwd: destination, stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect(status, `${stdout}\n${stderr}`).toBe(0);
}

describe("IMP KLean conformance", () => {
  test("full committed IMP produces the complete deterministic Lake plan", async () => {
    const first = await generate();
    const second = await generate();

    expectNoGenerationErrors(first);
    expect([...first.files.keys()]).toEqual(PROJECT_FILES);
    expect([...first.files]).toEqual([...second.files]);
    expect(first.manifest).toEqual(second.manifest);
    expect(first.diagnostics).toEqual(second.diagnostics);
    for (const text of first.files.values()) expect(text).toEndWith("\n");
    expect(first.files.get("ImpKlean.lean")).toBe("import ImpKlean.Rewrite\n");
    expect(first.files.get("lakefile.toml")).toContain('defaultTargets = ["ImpKlean"]');
    expect(first.files.get("lean-toolchain")).toBe("leanprover/lean4:v4.30.0\n");

    expect(first.manifest).toMatchObject({
      packageName: "imp-klean",
      libraryName: "ImpKlean",
      semanticMode: {
        rewritePriorities: "ignored",
        functions: "option-with-axiomatic-fallback",
        collections: "shallow-hook-structures",
      },
    });
    // These three functions require matcher support.
    // `isKResult` needs a subsort retraction, `_=/=Int_` and `#lookup` need
    // Option-monad hoisting; `#lookup` then needs `noncomputable` because it
    // reaches the axiomatized `Map:lookup`.
    const functions = first.files.get("ImpKlean/Func.lean") ?? "";
    expect(functions).toContain(
      "  | SortK.kseq _Pat0 SortK.dotk => match (@retr SortKResult SortKItem) _Pat0 with\n    | some KResult => some true\n    | _ => none\n  | _ => none",
    );
    expect(functions).toContain(
      "  | I1, I2 => do\n    let _Val0 <- «_==Int_» I1 I2\n    let _Val1 <- notBool_ _Val0\n    return _Val1",
    );
    expect(functions).toContain(
      "noncomputable def «#lookup(_,_)_IMP_KItem_Id_Map» (x0 : SortId) (x1 : SortMap) : Option SortKItem :=",
    );
    expect(functions).toContain("    guard _Val0\n    return _Val1");
    // A dependency is always declared before its dependents.
    expect(functions.indexOf("def notBool_ ")).toBeLessThan(functions.indexOf("def _4de6e05"));

    expect(first.manifest.selectedRewriteLabels).toHaveLength(46);
    expect(first.manifest.selectedRewriteUids).toHaveLength(56);
    expect(first.manifest.emittedSorts).toHaveLength(19);
    expect(first.manifest.emittedSymbols).toHaveLength(69);
    expect(first.manifest.emittedFunctionEquations).toHaveLength(9);
    expect(first.manifest.emittedRewrites).toHaveLength(56);
  });

  test("an exact IMP rule retains its dependency closure and shrinks the theory", async () => {
    const full = await generate();
    const selected = await generate({ ...OPTIONS, ruleLabels: [IMP_RULE] });

    expectNoGenerationErrors(selected);
    expect([...selected.files.keys()]).toEqual(PROJECT_FILES);
    expect(selected.manifest.selectedRewriteLabels).toEqual([IMP_RULE]);
    expect(selected.manifest.selectedRewriteUids).toHaveLength(1);
    expect(selected.manifest.emittedRewrites).toHaveLength(1);
    expect(selected.manifest.emittedSorts).toHaveLength(13);
    expect(selected.manifest.emittedSymbols).toHaveLength(33);
    expect(selected.manifest.emittedFunctionEquations).toHaveLength(4);
    expect(selected.manifest.emittedSorts.length).toBeLessThan(full.manifest.emittedSorts.length);
    expect(selected.manifest.emittedSymbols.length).toBeLessThan(full.manifest.emittedSymbols.length);
    expect(selected.manifest.emittedFunctionEquations.length).toBeLessThan(
      full.manifest.emittedFunctionEquations.length,
    );
  });

  test("optional Lake build accepts full and selected IMP projects", async () => {
    if (process.env.KLEAN_RUN_LAKE !== "1") return;
    const root = await mkdtemp(join(tmpdir(), "klean-imp-lake-"));
    try {
      const full = await generate();
      const selected = await generate({
        ...OPTIONS,
        packageName: "imp-klean-selected",
        libraryName: "ImpKleanSelected",
        ruleLabels: [IMP_RULE],
      });
      expectNoGenerationErrors(full);
      expectNoGenerationErrors(selected);
      await expectLakeBuild(full, root);
      await expectLakeBuild(selected, root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
