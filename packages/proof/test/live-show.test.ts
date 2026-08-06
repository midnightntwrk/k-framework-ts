/**
 * The show layer against a real K: a proof proved here, rendered by a real
 * `KPrint`, and frozen.
 *
 * # Why this suite exists at all
 *
 * `show.test.ts` pins every text shape with a stub printer, which is the right
 * tool for the *layout*. What a stub cannot check is the composition: that the
 * `CTermShow` seam really does accept `KPrint.prettyPrint`, that
 * `minimize`/`omit-cells` survive contact with a definition's real cells, and
 * that `to_module` produces a module the definition's own pretty-printer can
 * render. That is what is frozen here.
 *
 * # These goldens are self-generated
 *
 * pyk has no show goldens — `exec_show` only prints. `fixtures/golden/show/`
 * therefore records this implementation's output at K v7.1.337, reviewed
 * against `show.py`. It catches regressions; it is not an upstream oracle.
 *
 * Set `KFRAMEWORK_TS_SHOW_GOLDEN=update` to rewrite the files instead of
 * asserting against them.
 */

import type { CTerm } from "@kframework-ts/cterm";
import { CTermShow } from "@kframework-ts/cterm";
import { DefaultKCFGSemantics } from "@kframework-ts/kcfg/explore";
import { describeKompiled } from "@kframework-ts/ktool/testing";
import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { main } from "../src/cli.ts";
import { APRProof, ProofStatus } from "../src/index.ts";
import { proveClaims } from "../src/prove.ts";
import { APRProofNodePrinter, APRProofShow } from "../src/show.ts";
import { FIXTURES, KOMPILED_SRC, single, TIMEOUT, withLiveSession } from "./live-support.ts";

const IMP_SIMPLE_SPEC = join(FIXTURES, "imp-simple-spec.k");
const GOLDEN = join(import.meta.dir, "..", "fixtures", "golden", "show");
const LABEL = "IMP-SIMPLE-SPEC.addition-1";

/** `ImpSemantics` (`test_prove_rpc.py:34-73`); without it an IMP proof never closes. */
class ImpSemantics extends DefaultKCFGSemantics {
  override isTerminal(cterm: CTerm): boolean {
    const kCell = cterm.tryCell("K_CELL");
    if (kCell?.node === "KSequence") {
      if (kCell.items.length === 0) return true;
      if (kCell.items.length === 1 && kCell.items[0]?.node === "KVariable") return true;
    }
    return kCell?.node === "KVariable";
  }
}

/** Compare against the frozen file, or rewrite it under `KFRAMEWORK_TS_SHOW_GOLDEN=update`. */
async function expectGolden(name: string, actual: string): Promise<void> {
  const path = join(GOLDEN, name);
  if (process.env["KFRAMEWORK_TS_SHOW_GOLDEN"] === "update") {
    await mkdir(GOLDEN, { recursive: true });
    await writeFile(path, actual);
    return;
  }
  expect(actual).toBe(await readFile(path, "utf8"));
}

describeKompiled(
  describe,
  "APRProofShow against pyk's IMP verification definition",
  {
    backend: "haskell",
    mainFile: join(FIXTURES, "imp-verification.k"),
    mainModule: "IMP-VERIFICATION",
    syntaxModule: "IMP-VERIFICATION-SYNTAX",
    includeDirs: [KOMPILED_SRC],
  },
  (definitionDir) => {
    test(
      "renders a proved IMP claim through a real KPrint, and kproof show prints the same thing",
      async () => {
        await withLiveSession(await definitionDir, "IMP-VERIFICATION", new ImpSemantics(), "show", async (context) => {
          const proofDir = join(context.scratch, "proofs-show");
          await mkdir(proofDir, { recursive: true });
          const specFile = await context.copySpec(IMP_SIMPLE_SPEC);

          const verdict = single(
            await proveClaims({
              definitionDir: await definitionDir,
              specFile,
              specModuleName: "IMP-SIMPLE-SPEC",
              claimLabels: [LABEL],
              includeDirs: [FIXTURES, KOMPILED_SRC],
              builtinDir: context.builtinDir,
              proofDir,
              session: context.session,
            }),
          );
          expect(verdict.status).toBe(ProofStatus.PASSED);
          const proof = verdict.proof;
          expect(proof).toBeInstanceOf(APRProof);
          if (!(proof instanceof APRProof)) return;

          // The composition pyk performs at `__main__.py:287-289`.
          const printer = context.kprint.prettyPrint.bind(context.kprint);
          const show = new APRProofShow({
            definition: context.definition,
            prettyPrint: printer,
            nodePrinter: new APRProofNodePrinter(proof, new CTermShow(printer, { minimize: false }), {
              fullPrinter: true,
            }),
          });

          // `minimize: false` is `exec_show`'s own setting (`__main__.py:290`)
          // and the CLI's default, so library and command agree byte for byte.
          await expectGolden(
            "live-imp-addition-1-pretty.txt",
            `${show.pretty(proof, { minimize: false }).join("\n")}\n`,
          );
          await expectGolden(
            "live-imp-addition-1-show.txt",
            `${show.show(proof, { toModule: true, minimize: false }).join("\n")}\n`,
          );
          await expectGolden("live-imp-addition-1.dot", `${show.dot(proof)}\n`);

          // `kproof show` loads the same proof from disk and prints the same
          // block — the CLI adds no logic the library does not have.
          const out: string[] = [];
          const code = await main(
            ["show", await definitionDir, proofDir, LABEL],
            (text) => {
              out.push(text);
            },
            () => undefined,
          );
          expect(code).toBe(0);
          expect(out.join("")).toBe(await readFile(join(GOLDEN, "live-imp-addition-1-show.txt"), "utf8"));

          // `--dot` swaps the rendering, not the proof.
          const dotOut: string[] = [];
          expect(
            await main(
              ["show", await definitionDir, proofDir, LABEL, "--dot"],
              (text) => {
                dotOut.push(text);
              },
              () => undefined,
            ),
          ).toBe(0);
          expect(dotOut.join("")).toBe(await readFile(join(GOLDEN, "live-imp-addition-1.dot"), "utf8"));
        });
      },
      TIMEOUT,
    );
  },
);
