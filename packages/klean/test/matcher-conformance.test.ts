/**
 * The acceptance gate for the function-rule matcher hierarchy: `kompile` the
 * `fixtures/matchers.k` definition, generate a Lake project from it, and make
 * Lean elaborate the result.
 *
 * The committed IMP definition exercises exactly one matcher (a subsort
 * retraction), so it cannot show that the rest produce Lean that type-checks —
 * and generated Lean that does not elaborate is worth nothing.  This test is
 * the one that can.
 *
 * It needs both `kompile` and the pinned Lean toolchain, so it shares
 * `imp-conformance.test.ts`'s opt-in switch and is otherwise skipped:
 *
 *     KLEAN_RUN_LAKE=1 bun test packages/klean/test/matcher-conformance.test.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeKleanProject } from "../src/fs.ts";
import { generateKleanProject } from "../src/generate.ts";
import { sourceFromKoreText } from "../src/source.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/matchers.k", import.meta.url));

/** Every matcher variant, keyed by the generated Lean it must produce. */
const EXPECTED_LEAN: readonly (readonly [string, string])[] = [
  ["repeated left-hand-side variable", "match X == _Uniq0 with"],
  ["map split", "(MapHook SortKItem SortKItem).split _Pat0.coll [K]"],
  ["map leftover reboxed at its K sort", "(fun (vs, r) => (vs, ({ coll := r } : SortMap)))"],
  ["empty map", "(MapHook SortKItem SortKItem).size _Pat0.coll"],
  ["set split", "(SetHook SortKItem).split _Pat0.coll [X]"],
  ["empty set", "(SetHook SortKItem).size _Pat0.coll"],
  ["list split", "(ListHook SortKItem).split _Pat0.coll 1 0"],
  ["empty list", "(ListHook SortKItem).size _Pat0.coll"],
  ["mutual block", "mutual\n"],
  ["Option-monad hoisting", "let _Val0 <- "],
  ["noncomputable propagation", "noncomputable def "],
];

async function run(command: string[], cwd: string): Promise<{ status: number; output: string }> {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { status, output: `${stdout}\n${stderr}` };
}

describe("matcher conformance", () => {
  test("every matcher shape compiles to Lean that elaborates", async () => {
    if (process.env.KLEAN_RUN_LAKE !== "1") return;
    const root = await mkdtemp(join(tmpdir(), "klean-matchers-"));
    try {
      const kompiled = join(root, "matchers-kompiled");
      const kompile = await run(["kompile", "--backend", "haskell", FIXTURE, "-o", kompiled], root);
      expect(kompile.status, kompile.output).toBe(0);

      const definition = await Bun.file(join(kompiled, "definition.kore")).text();
      const project = generateKleanProject(sourceFromKoreText(definition), {
        packageName: "matchers-klean",
        deriveBeq: true,
        deriveDecidableEq: true,
      });

      // Nothing degraded to an axiom for want of lowering: the only axioms are
      // the collection hooks the Prelude deliberately leaves open.
      expect(project.diagnostics).toEqual([]);
      expect(project.manifest.axiomaticFunctions).toEqual([
        "Lbl'Stop'List",
        "Lbl'Stop'Map",
        "Lbl'Stop'Set",
        "Lbl'Unds'List'Unds'",
        "Lbl'Unds'Map'Unds'",
        "Lbl'Unds'Set'Unds'",
        "Lbl'UndsPipe'-'-GT-Unds'",
        "LblListItem",
        "LblSetItem",
      ]);

      const functions = project.files.get("MatchersKlean/Func.lean") ?? "";
      for (const [what, expected] of EXPECTED_LEAN) expect(functions, what).toContain(expected);

      const destination = await writeKleanProject(project, join(root, "out"));
      const build = await run(["lake", "build"], destination);
      expect(build.status, build.output).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 600_000);
});
