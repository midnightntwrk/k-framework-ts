/**
 * `pyk/src/tests/integration/proof/test_imp.py`, the slices this package can
 * answer for, against a real K.
 *
 * The mega-suite upstream is 1,615 lines and much of it belongs to sibling
 * packages (`test_execute`, `test_implies`, `test_get_model`, the three
 * anti-unification rows, `test_implication_failure_reason`). What is ported
 * here is the part that is about *proofs*:
 *
 * - `test_all_path_reachability_prove` — six representative rows of the ~35
 *   upstream, chosen to cover a passing straight line, a cut rule, a failing
 *   branch, a real loop, and both halves of the dependency pair.
 * - `test_collect_path_constraints` — the exact constraint string.
 * - `test_fail_fast` — the same claim proved twice, with and without.
 * - `test_proof_no_progress_on_reload` — a killed run resumed from disk makes
 *   no further progress and reports the same failure info.
 * - one `test_failure_info` row, asserting the failing node's path condition.
 * - two `test_all_path_bmc_reachability_prove` rows, which are the bounded
 *   model checking coverage this package can actually run: `test_goto.py`'s
 *   single BMC row cannot complete on this K install (see
 *   `live-goto.test.ts`), and these exercise the same `bmcDepth` machinery
 *   through IMP's `while` loop.
 *
 * The dependency rows diverge in one mechanical way: upstream builds them with
 * `APRProof.from_spec_modules` (`reachability.py:470-498`), which this package
 * does not port. `dependencyProof` does what that helper does for these rows —
 * build a proof per dependency label, write each to disk, then build the
 * dependent proof with them attached — which is what `APRProver.initProof`
 * reads back when it files the `-DEPENDS-MODULE`.
 */

import type { CTerm } from "@kframework-ts/cterm";
import { eq, sentenceLabel, type KClaim } from "@kframework-ts/kast";
import { DefaultKCFGSemantics } from "@kframework-ts/kcfg/explore";
import { describeKompiled } from "@kframework-ts/ktool/testing";
import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { APRProof, ProofStatus } from "../src/index.ts";
import { advanceProof, APRProver, type APRProverOptions } from "../src/prove.ts";
import { readProofData, writeProofData } from "../src/store.ts";
import { asAprProof } from "./support.ts";
import { FIXTURES, KOMPILED_SRC, single, TIMEOUT, withLiveSession, type LiveContext } from "./live-support.ts";

const IMP_SIMPLE_SPEC = join(FIXTURES, "imp-simple-spec.k");

/** `ImpSemantics` (`test_imp.py:51-85`). */
class ImpSemantics extends DefaultKCFGSemantics {
  override isTerminal(cterm: CTerm): boolean {
    const kCell = cterm.tryCell("K_CELL");
    if (kCell?.node === "KSequence") {
      if (kCell.items.length === 0) return true;
      if (kCell.items.length === 1 && kCell.items[0]?.node === "KVariable") return true;
    }
    return kCell?.node === "KVariable";
  }

  override isLoop(cterm: CTerm): boolean {
    const kCell = cterm.tryCell("K_CELL");
    if (kCell?.node !== "KSequence") return false;
    const head = kCell.items[0];
    return head?.node === "KApply" && head.label.name === "while(_)_";
  }

  override sameLoop(left: CTerm, right: CTerm): boolean {
    const leftCell = left.tryCell("K_CELL");
    const rightCell = right.tryCell("K_CELL");
    if (leftCell === undefined || rightCell === undefined) return false;
    if (!eq(leftCell, rightCell)) return false;
    if (leftCell.node !== "KSequence" || leftCell.items.length === 0) return false;
    const head = leftCell.items[0];
    return head?.node === "KApply" && head.label.name === "while(_)_";
  }
}

/** A writable proof directory under the run's scratch space. */
async function scratchProofDir(context: LiveContext, name: string): Promise<string> {
  const directory = join(context.scratch, `proofs-${name}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

/** `leaf_number` (`test_imp.py:760-762`). */
function leafNumber(proof: APRProof): number {
  const nonTargetLeaves = proof.kcfg.leaves.filter((node) => !proof.isTarget(node.id));
  return nonTargetLeaves.length + proof.kcfg.predecessors(proof.target).length;
}

/** One `APR_PROVE_TEST_DATA` row (`test_imp.py:338-568`). */
interface AprProveRow {
  readonly testId: string;
  readonly specModule: string;
  readonly claimId: string;
  readonly maxIterations?: number;
  readonly maxDepth?: number;
  readonly cutRules?: readonly string[];
  readonly admitDeps: boolean;
  readonly status: ProofStatus;
  readonly leaves: number;
}

const APR_PROVE_TEST_DATA: readonly AprProveRow[] = [
  {
    testId: "imp-simple-addition-1",
    specModule: "IMP-SIMPLE-SPEC",
    claimId: "addition-1",
    maxIterations: 2,
    maxDepth: 1,
    admitDeps: true,
    status: ProofStatus.PASSED,
    leaves: 1,
  },
  {
    testId: "while-cut-rule",
    specModule: "IMP-SIMPLE-SPEC",
    claimId: "while-cut-rule",
    maxIterations: 2,
    maxDepth: 1,
    cutRules: ["IMP.while"],
    admitDeps: true,
    status: ProofStatus.PASSED,
    leaves: 1,
  },
  {
    testId: "failing-if",
    specModule: "IMP-SIMPLE-SPEC",
    claimId: "failing-if",
    maxIterations: 10,
    maxDepth: 1,
    admitDeps: true,
    status: ProofStatus.FAILED,
    leaves: 2,
  },
  {
    testId: "imp-simple-sum-10",
    specModule: "IMP-SIMPLE-SPEC",
    claimId: "sum-10",
    admitDeps: true,
    status: ProofStatus.PASSED,
    leaves: 1,
  },
  {
    // The dependency is admitted, so its (untrue) claim becomes a rule.
    testId: "imp-dep-untrue-admitted",
    specModule: "IMP-SIMPLE-SPEC",
    claimId: "dep-fail-1",
    admitDeps: true,
    status: ProofStatus.PASSED,
    leaves: 1,
  },
  {
    // The same claim without admitting it: no rule, so the proof fails.
    testId: "imp-dep-untrue-fail",
    specModule: "IMP-SIMPLE-SPEC",
    claimId: "dep-fail-1",
    admitDeps: false,
    status: ProofStatus.FAILED,
    leaves: 1,
  },
];

/** One `APRBMC_PROVE_TEST_DATA` row (`test_imp.py:617-724`). */
interface AprBmcProveRow {
  readonly testId: string;
  readonly claimId: string;
  readonly bmcDepth: number;
  readonly status: ProofStatus;
  readonly leaves: number;
  /** Whether the run is expected to bound at least one node. */
  readonly bounds: boolean;
}

const APRBMC_PROVE_TEST_DATA: readonly AprBmcProveRow[] = [
  // Depth 1 lets the loop run once and bounds the second visit, so nothing is
  // left failing and the proof passes.
  {
    testId: "bmc-loop-concrete-2",
    claimId: "bmc-loop-concrete",
    bmcDepth: 1,
    status: ProofStatus.PASSED,
    leaves: 1,
    bounds: true,
  },
  // Depth 2 lets it run far enough to reach a state that does not subsume.
  {
    testId: "bmc-loop-concrete-3",
    claimId: "bmc-loop-concrete",
    bmcDepth: 2,
    status: ProofStatus.FAILED,
    leaves: 1,
    bounds: false,
  },
];

describeKompiled(
  describe,
  "test_imp.py slices against pyk's IMP verification definition",
  {
    backend: "haskell",
    mainFile: join(FIXTURES, "imp-verification.k"),
    mainModule: "IMP-VERIFICATION",
    syntaxModule: "IMP-VERIFICATION-SYNTAX",
    includeDirs: [KOMPILED_SRC],
  },
  (definitionDir) => {
    const live = async (label: string, body: (context: LiveContext) => Promise<void>): Promise<void> => {
      await withLiveSession(await definitionDir, "IMP-VERIFICATION", new ImpSemantics(), label, body);
    };

    const loadClaims = async (context: LiveContext, specModule: string, claimId: string): Promise<readonly KClaim[]> =>
      context.claims(IMP_SIMPLE_SPEC, {
        specModuleName: specModule,
        claimLabels: [`${specModule}.${claimId}`],
        includeDirs: [FIXTURES, KOMPILED_SRC],
      });

    /**
     * Build the proof for `claimId`, plus a written proof for each dependency
     * the claim selection dragged in — `from_spec_modules` in the small.
     */
    const proofFor = async (
      context: LiveContext,
      specModule: string,
      claimId: string,
      proofDir: string,
      admitDeps: boolean,
    ): Promise<APRProof> => {
      const claims = await loadClaims(context, specModule, claimId);
      const label = `${specModule}.${claimId}`;
      const main = single(claims.filter((claim) => sentenceLabel(claim) === label));
      const subproofs: APRProof[] = [];
      for (const claim of claims) {
        if (sentenceLabel(claim) === label) continue;
        const subproof = APRProof.fromClaim(context.definition, claim, new Map(), { proofDir });
        if (admitDeps) subproof.admit();
        await writeProofData(subproof);
        subproofs.push(subproof);
      }
      return APRProof.fromClaim(context.definition, main, new Map(), { proofDir, subproofs });
    };

    for (const row of APR_PROVE_TEST_DATA) {
      test(
        `test_all_path_reachability_prove[${row.testId}]`,
        async () => {
          await live(row.testId, async (context) => {
            const proofDir = await scratchProofDir(context, row.testId);
            const proof = await proofFor(context, row.specModule, row.claimId, proofDir, row.admitDeps);

            const options: APRProverOptions = {
              ...(row.maxDepth === undefined ? {} : { executeDepth: row.maxDepth }),
              ...(row.cutRules === undefined ? {} : { cutPointRules: row.cutRules }),
            };
            await advanceProof(
              new APRProver(context.explore, options),
              proof,
              row.maxIterations === undefined ? {} : { maxIterations: row.maxIterations },
            );

            expect([row.testId, proof.status]).toEqual([row.testId, row.status]);
            expect([row.testId, leafNumber(proof)]).toEqual([row.testId, row.leaves]);
          });
        },
        TIMEOUT,
      );
    }

    for (const row of APRBMC_PROVE_TEST_DATA) {
      test(
        `test_all_path_bmc_reachability_prove[${row.testId}]`,
        async () => {
          await live(row.testId, async (context) => {
            const claim = single(await loadClaims(context, "IMP-SIMPLE-SPEC", row.claimId));
            const proof = APRProof.fromClaim(context.definition, claim, new Map(), { bmcDepth: row.bmcDepth });
            await context.explore.simplify(proof.kcfg);

            await advanceProof(
              new APRProver(context.explore, { executeDepth: 20, cutPointRules: ["IMP.while"] }),
              proof,
              { maxIterations: 20 },
            );

            expect([row.testId, proof.status]).toEqual([row.testId, row.status]);
            expect([row.testId, leafNumber(proof)]).toEqual([row.testId, row.leaves]);
            expect([row.testId, proof.bounded.length > 0]).toEqual([row.testId, row.bounds]);
          });
        },
        TIMEOUT,
      );
    }

    test(
      "test_collect_path_constraints[imp-simple-fail-branch]",
      async () => {
        await live("collect-path-constraints", async (context) => {
          const proofDir = await scratchProofDir(context, "path-constraints");
          const claim = single(await loadClaims(context, "IMP-SIMPLE-SPEC", "fail-branch"));
          const proof = APRProof.fromClaim(context.definition, claim, new Map(), { proofDir });

          await advanceProof(new APRProver(context.explore, { executeDepth: 1 }), proof);

          expect(proof.failing).toHaveLength(1);
          const constraint = context.explore.prettyPrint(proof.pathConstraints(proof.failing[0]!.id));
          expect(constraint.replaceAll("\n", " ")).toBe("{ false #Equals _S:Int <=Int 123 }");
        });
      },
      TIMEOUT,
    );

    test(
      "test_fail_fast: the second branch is left pending",
      async () => {
        await live("fail-fast", async (context) => {
          const proofDir = await scratchProofDir(context, "fail-fast");
          const claim = single(await loadClaims(context, "IMP-SIMPLE-SPEC", "fail-early"));

          const patient = APRProof.fromClaim(context.definition, claim, new Map(), { proofDir });
          await advanceProof(new APRProver(context.explore), patient, { failFast: false });
          // Both branches are checked and both fail.
          expect(patient.kcfg.leaves).toHaveLength(3);
          expect(patient.pending).toHaveLength(0);
          expect(patient.terminalIds.size).toBe(3);
          expect(patient.failing).toHaveLength(2);

          const hasty = APRProof.fromClaim(context.definition, claim, new Map(), { proofDir });
          await advanceProof(new APRProver(context.explore), hasty, { failFast: true });
          // The first branch fails and stops the run, leaving the long one pending.
          expect(hasty.kcfg.leaves).toHaveLength(3);
          expect(hasty.pending).toHaveLength(1);
          expect(hasty.terminalIds.size).toBe(2);
          expect(hasty.failing).toHaveLength(1);
        });
      },
      TIMEOUT,
    );

    test(
      "test_proof_no_progress_on_reload",
      async () => {
        await live("no-progress-on-reload", async (context) => {
          const proofDir = await scratchProofDir(context, "reload");
          const claim = single(await loadClaims(context, "IMP-SIMPLE-SPEC", "fail-early"));

          const proof = APRProof.fromClaim(context.definition, claim, new Map(), { proofDir });
          await context.explore.simplify(proof.kcfg);
          await advanceProof(new APRProver(context.explore), proof, { failFast: true });
          const before = proof.failureInfo;
          expect(before).toBeDefined();

          // Reload from disk — the maintenance flush is what makes this work —
          // and advance again: there is nothing left to do that fail-fast allows.
          const reloaded = asAprProof(await readProofData(proofDir, proof.id));
          const nodesBefore = reloaded.kcfg.nodes.length;
          await advanceProof(new APRProver(context.explore), reloaded, { failFast: true });

          expect(reloaded.kcfg.nodes.length).toBe(nodesBefore);
          expect(reloaded.pending).toHaveLength(1);
          expect(reloaded.failing).toHaveLength(1);
          expect(reloaded.failureInfo?.print()).toEqual(before?.print() ?? []);
        });
      },
      TIMEOUT,
    );

    test(
      "test_failure_info[fail-branch]: one failing node, with its path condition",
      async () => {
        await live("failure-info", async (context) => {
          const claim = single(await loadClaims(context, "IMP-SIMPLE-SPEC", "fail-branch"));
          const proof = APRProof.fromClaim(context.definition, claim);
          await context.explore.simplify(proof.kcfg);
          const prover = new APRProver(context.explore);
          await advanceProof(prover, proof);

          const failureInfo = await prover.failureInfo(proof);
          expect(failureInfo.pendingNodes).toHaveLength(0);
          expect(failureInfo.failingNodes).toHaveLength(1);

          // `test_failure_info` compares against
          // `mlEqualsFalse(_<=Int_(_S:Int, 123))` pretty-printed; the same
          // string `test_collect_path_constraints` pins, reached the other way.
          const conditions = [...failureInfo.pathConditions.values()];
          expect(conditions).toHaveLength(1);
          expect(conditions[0]).toBe("{ false #Equals _S:Int <=Int 123 }");

          const reasons = [...failureInfo.failureReasons.values()];
          expect(reasons).toHaveLength(1);
          expect(reasons[0]).toContain("Matching failed");
        });
      },
      TIMEOUT,
    );
  },
);
