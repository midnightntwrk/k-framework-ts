/**
 * `pyk/src/tests/integration/proof/test_goto.py` — bounded model checking.
 *
 * # This suite is skipped, and the reason is not this package
 *
 * The single upstream row (`symbolic-loop`) cannot run against the pinned K
 * install. Its very first step is the subsumption check of `init` against
 * `target`, which asks Z3 whether `0 <=Int N` implies
 * `?S ==Int (N *Int (N +Int 1)) /Int 2` — nonlinear integer arithmetic with a
 * division. The solver is *canceled* rather than answering `unknown`, and
 * `kore-rpc` turns that into an SMT error, so the step raises before any BMC
 * behaviour is reached. Raising `--smt-timeout` from its 40 ms default to 30 s
 * changes nothing except how long each query burns.
 *
 * This is backend behavior, not a transcription result. With the pinned K
 * installation, upstream pyk fails at the same query and claim:
 *
 * ```text
 * $ .venv/bin/python -m pytest src/tests/integration/proof/test_goto.py --use-server=legacy
 * E  pyk.cterm.symbolic.CTermSMTError: { true #Equals 0 <=Int N:Int }
 * E  #And #Not ( { 0 #Equals N:Int *Int N:Int +Int 1 /Int 2 } )
 * FAILED ...::test_all_path_bmc_reachability_prove[legacy-symbolic-loop]
 * ```
 *
 * The port is kept whole — `GotoSemantics`, the row, the vendored `goto.k` —
 * so that re-enabling it on a machine whose Z3 answers is deleting one `.skip`.
 * Bounded model checking itself **is** covered, by `test_imp.py`'s
 * `APRBMC_PROVE_TEST_DATA` rows in `live-imp.test.ts`, which exercise the same
 * `bmcDepth` machinery through IMP's `while` loop and do run here.
 */

import type { CTerm } from "@kframework-ts/cterm";
import { eq } from "@kframework-ts/kast";
import { DefaultKCFGSemantics } from "@kframework-ts/kcfg/explore";
import { kompileCached } from "@kframework-ts/ktool/testing";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { APRProof, ProofStatus } from "../src/index.ts";
import { advanceProof, APRProver } from "../src/prove.ts";
import { FIXTURES, single, TIMEOUT, withLiveSession } from "./live-support.ts";

/** `GotoSemantics` (`test_goto.py:34-49`). */
class GotoSemantics extends DefaultKCFGSemantics {
  override isLoop(cterm: CTerm): boolean {
    const kCell = cterm.tryCell("K_CELL");
    if (kCell?.node !== "KSequence") return false;
    const head = kCell.items[0];
    return head?.node === "KApply" && head.label.name === "jumpi";
  }

  override sameLoop(left: CTerm, right: CTerm): boolean {
    const kCell = left.tryCell("K_CELL");
    const leftPc = left.tryCell("PC_CELL");
    const rightPc = right.tryCell("PC_CELL");
    if (leftPc === undefined || rightPc === undefined || !eq(leftPc, rightPc)) return false;
    if (kCell?.node !== "KSequence" || kCell.items.length === 0) return false;
    const head = kCell.items[0];
    return head?.node === "KApply" && head.label.name === "jumpi";
  }
}

describe("BMC against pyk's goto definition", () => {
  // `test.skip`, not `describeKompiled`: a skipped body never runs, so the
  // definition is never kompiled either. See this file's header for why.
  test.skip(
    "test_all_path_bmc_reachability_prove[symbolic-loop]",
    async () => {
      const definitionDir = await kompileCached({
        backend: "haskell",
        mainFile: join(FIXTURES, "goto.k"),
        mainModule: "GOTO",
        syntaxModule: "GOTO-SYNTAX",
      });
      await withLiveSession(definitionDir, "GOTO", new GotoSemantics(), "goto", async (context) => {
        const claim = single(
          await context.claims(join(FIXTURES, "goto.k"), {
            specModuleName: "GOTO-SPEC",
            claimLabels: ["GOTO-SPEC.sum-n"],
          }),
        );
        const proof = APRProof.fromClaim(context.definition, claim, new Map(), { bmcDepth: 1 });
        await context.explore.simplify(proof.kcfg);

        await advanceProof(new APRProver(context.explore, { executeDepth: 20 }), proof, { maxIterations: 20 });

        expect(proof.status).toBe(ProofStatus.PASSED);
        // `leaf_number` (`test_goto.py:69-71`).
        const nonTargetLeaves = proof.kcfg.leaves.filter((node) => !proof.isTarget(node.id));
        expect(nonTargetLeaves.length + proof.kcfg.predecessors(proof.target).length).toBe(3);
        // The point of the row: the loop is closed by bounding, not by
        // exploring it a second time.
        expect(proof.bounded.length).toBeGreaterThan(0);
        for (const node of proof.bounded) expect(proof.isBounded(node.id)).toBe(true);
      });
    },
    TIMEOUT,
  );
});
