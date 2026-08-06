/**
 * `pyk/src/tests/integration/proof/test_cell_map.py`'s proving row.
 *
 * The definition uses a cell *collection* (`<accounts>` holding `<account>`
 * cells keyed by `<id>`), which is the shape that makes `assume_defined`
 * necessary: without the `#Ceil` constraint on the initial node the map's
 * well-formedness is not known and the proof does not close. Upstream's
 * `test_all_path_reachability_prove` (`test_cell_map.py:120-153`) does exactly
 * that one call and then a two-iteration proof.
 *
 * `cell-map.k` is vendored once, by `@kframework-ts/konvert`; only the spec
 * file is vendored here, following the cross-package fixture precedent
 * `packages/kcfg/test/live-k.test.ts` set.
 */

import { DefaultKCFGSemantics } from "@kframework-ts/kcfg/explore";
import { describeKompiled } from "@kframework-ts/ktool/testing";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { APRProof, ProofStatus } from "../src/index.ts";
import { advanceProof, APRProver } from "../src/prove.ts";
import { FIXTURES, KONVERT_SRC, single, TIMEOUT, withLiveSession } from "./live-support.ts";

describeKompiled(
  describe,
  "APRProver against pyk's cell-map definition",
  {
    backend: "haskell",
    mainFile: join(KONVERT_SRC, "cell-map.k"),
    mainModule: "CELL-MAP",
    syntaxModule: "CELL-MAP-SYNTAX",
  },
  (definitionDir) => {
    test(
      "test_all_path_reachability_prove[cell-map-no-branch]",
      async () => {
        await withLiveSession(
          await definitionDir,
          "CELL-MAP",
          new DefaultKCFGSemantics(),
          "cell-map",
          async (context) => {
            const claim = single(
              await context.claims(join(FIXTURES, "cell-map-spec.k"), {
                specModuleName: "CELL-MAP-SPEC",
                claimLabels: ["CELL-MAP-SPEC.cell-map-no-branch"],
                includeDirs: [KONVERT_SRC],
              }),
            );
            const proof = APRProof.fromClaim(context.definition, claim);

            // `assume_defined` on the initial node, written back with
            // `let_node` — the half of `initializeAprProof` this row needs.
            const init = proof.kcfg.node(proof.init);
            proof.kcfg.letNode(init.id, { cterm: await context.symbolic.assumeDefined(init.cterm) });

            await advanceProof(new APRProver(context.explore, { executeDepth: 1 }), proof, { maxIterations: 2 });
            expect(proof.status).toBe(ProofStatus.PASSED);
          },
        );
      },
      TIMEOUT,
    );
  },
);
