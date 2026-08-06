import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KleanOutputExistsError, writeKleanProject } from "../src/fs.ts";
import type { GeneratedProject } from "../src/generate.ts";

function project(files: ReadonlyMap<string, string> = new Map([["Demo.lean", "-- demo\n"]])): GeneratedProject {
  return {
    files,
    diagnostics: [],
    manifest: {
      kRelease: "v7.1.337",
      kCommit: "test",
      leanToolchain: "leanprover/lean4:v4.30.0",
      packageName: "demo-klean",
      libraryName: "Demo",
      selectedRewriteLabels: [],
      selectedRewriteUids: [],
      emittedSorts: [],
      emittedSymbols: [],
      emittedFunctionEquations: [],
      emittedRewrites: [],
      axiomaticFunctions: [],
      semanticMode: {
        rewritePriorities: "ignored",
        functions: "option-with-axiomatic-fallback",
        collections: "shallow-hook-structures",
      },
    },
  };
}

describe("writeKleanProject", () => {
  test("materialises files and manifest, then refuses overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "klean-fs-"));
    const destination = await writeKleanProject(project(), root);
    expect(await readFile(join(destination, "Demo.lean"), "utf8")).toBe("-- demo\n");
    expect(JSON.parse(await readFile(join(destination, "klean-manifest.json"), "utf8"))).toMatchObject({
      packageName: "demo-klean",
    });
    expect(writeKleanProject(project(), root)).rejects.toBeInstanceOf(KleanOutputExistsError);
  });

  test("rejects generated paths that escape the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "klean-fs-"));
    expect(writeKleanProject(project(new Map([["../escape", "bad"]])), root)).rejects.toThrow("Unsafe generated path");
  });
});
