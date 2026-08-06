/**
 * The real-K proving ladder: claim file → `APRProof` → `APRProver` → verdict.
 *
 * `describeKompiled` keeps every suite here inert unless `KFRAMEWORK_TS_K_BIN`
 * explicitly selects the pinned K distribution, exactly as
 * `packages/kcfg/test/live-k.test.ts` does. Three rungs, cheapest first:
 *
 * 1. **Hello world** — `k-distribution/tests/regression-new/profile`'s
 *    seven-line `<k> 0 => 1 </k>`. The smallest end-to-end proof there is.
 * 2. **`test_simple.py`** (`pyk/src/tests/integration/proof/test_simple.py`) —
 *    terminal-node marking at `executeDepth: 1`, with the same `SimpleSemantics`
 *    that calls an `f` at the head of `<k>` terminal.
 * 3. **`test_non_det.py`** — the non-deterministic branch shape, asserted node
 *    by node as upstream does.
 * 4. **`test_refute_node.py`** — the refutation suite: refute/unrefute round
 *    trips, the two refusals, useless-constraint pruning, the exact
 *    `RefutationProof.to_claim` golden, and the proof-directory round trip of
 *    node refutations. One extra test, with no upstream counterpart, pins the
 *    failure *reason* a real backend now produces.
 * 5. **`test_implies_proof.py`** — the five pure-logic `ImpliesProof` rows and
 *    the twelve `EqualityProof.from_claim` rows over IMP.
 *
 * `test_custom_step.py` is **deferred**; it needs the `CustomStep` registry
 * idiom on `KCFGSemantics`, which nothing in this monorepo exercises yet.
 *
 * Spec files are copied into a temporary directory before loading, because
 * `ClaimLoader` writes its `<spec>.json` parse cache next to the spec and
 * `fixtures/` is not a scratch directory.
 */

import { CTerm } from "@kframework-ts/cterm";
import { CTermSymbolic } from "@kframework-ts/cterm/symbolic";
import {
  attEntry,
  Atts,
  freeVars,
  KAtt,
  kclaim,
  krewrite,
  ksort,
  ktoken,
  kvariable,
  type KClaim,
  type KInner,
} from "@kframework-ts/kast";
import { BOOL, FALSE } from "@kframework-ts/kast/prelude/kbool";
import { addInt, intToken, leInt } from "@kframework-ts/kast/prelude/kint";
import { isTop, mlAnd, mlEqualsTrue } from "@kframework-ts/kast/prelude/ml";
import { KCFGExplore } from "@kframework-ts/kcfg/explore";
import { DefaultKCFGSemantics } from "@kframework-ts/kcfg/explore";
import { ClaimLoader, kDistributionFrom, KPrint, KproveModuleParser } from "@kframework-ts/ktool";
import { describeKompiled, requireKTestEnvironment } from "@kframework-ts/ktool/testing";
import { KoreClient, tcpTransport } from "@kframework-ts/kore-rpc";
import { koreRpcServer } from "@kframework-ts/kore-rpc/server";
import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { APRFailureInfo, APRProof, EqualityProof, ImpliesProof, ProofStatus } from "../src/index.ts";
import { advanceProof, APRProver, ImpliesProver } from "../src/prove.ts";
import { readProofData, refuteNode, unrefuteNode } from "../src/store.ts";
import { asAprProof, asRefutationProof } from "./support.ts";

const FIXTURES = join(import.meta.dir, "../fixtures/live-k");
/**
 * `simple-proofs.k` lives in a sibling package rather than being vendored
 * twice; `packages/kcfg/test/live-k.test.ts` reaches into `packages/cterm`
 * the same way.
 */
const KONVERT_SRC = join(import.meta.dir, "../../konvert/fixtures/src");

const TIMEOUT = 600_000;

interface LiveContext {
  readonly explore: KCFGExplore;
  readonly claims: (specFile: string, options?: ClaimSelection) => Promise<KClaim[]>;
  readonly definition: KPrint["definition"];
  /** The same adapter `explore` holds; `ImpliesProver` takes it directly. */
  readonly symbolic: CTermSymbolic;
  /** For `parse_token`, which the implies rows need to build their terms. */
  readonly kprint: KPrint;
  /** A writable directory for proof data, removed with the rest of the run. */
  readonly scratch: string;
}

interface ClaimSelection {
  readonly specModuleName?: string;
  readonly claimLabels?: readonly string[];
  readonly includeDirs?: readonly string[];
}

/**
 * Stand up `KPrint` + a `kore-rpc` server + `KoreClient` + `CTermSymbolic` +
 * `KCFGExplore` over one kompiled definition — pyk's `KCFGExploreTest` tower.
 *
 * The client is labelled with the suite name, which is this package's answer to
 * pyk's per-proof `client_label` ContextVar: one client per proof run, labelled
 * at construction. See `apr-prover.ts`'s header.
 */
async function withLiveK(
  definitionDir: string,
  moduleName: string,
  semantics: DefaultKCFGSemantics,
  label: string,
  body: (context: LiveContext) => Promise<void>,
): Promise<void> {
  const environment = await requireKTestEnvironment();
  const distribution = kDistributionFrom(environment.kompilePath);
  const kprint = await KPrint.load(definitionDir, {
    command: [join(environment.binDir, "kast")],
    korePrintCommand: [join(environment.binDir, "kore-print")],
  });
  const server = await koreRpcServer({
    kompiledDir: definitionDir,
    moduleName,
    command: [join(environment.binDir, "kore-rpc")],
  });
  const scratch = await mkdtemp(join(tmpdir(), "kframework-ts-proof-live-"));
  let client: KoreClient | undefined;
  try {
    client = new KoreClient(await tcpTransport(server.host, server.port, { timeout: 300_000 }), { label });
    const symbolic = new CTermSymbolic(client, kprint.definition);
    const loader = new ClaimLoader(
      new KproveModuleParser({ definitionDir, command: [join(environment.binDir, "kprove")] }),
    );
    await body({
      explore: new KCFGExplore(symbolic, { semantics, id: label }),
      definition: kprint.definition,
      symbolic,
      kprint,
      scratch,
      claims: async (specFile, options = {}) => {
        // Copy the spec somewhere writable: `loadClaims` caches beside it.
        const copied = join(scratch, basename(specFile));
        await copyFile(specFile, copied);
        return loader.loadClaims(copied, {
          ...(options.specModuleName === undefined ? {} : { specModuleName: options.specModuleName }),
          ...(options.claimLabels === undefined ? {} : { claimLabels: options.claimLabels }),
          includeDirs: options.includeDirs ?? [],
          builtinDir: distribution.builtinDir,
        });
      },
    });
  } finally {
    client?.close();
    await server.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

function single<T>(values: readonly T[]): T {
  expect(values).toHaveLength(1);
  return values[0]!;
}

//////////////////////////
// 1. Hello world       //
//////////////////////////

describeKompiled(
  describe,
  "APRProver against k-distribution's profile regression test",
  {
    backend: "haskell",
    mainFile: join(FIXTURES, "test.k"),
    mainModule: "TEST",
    syntaxModule: "TEST",
  },
  (definitionDir) => {
    test(
      "proves <k> 0 => 1 </k> end to end",
      async () => {
        await withLiveK(
          await definitionDir,
          "TEST",
          new DefaultKCFGSemantics(),
          "profile",
          async ({ explore, definition, claims }) => {
            const claim = single(await claims(join(FIXTURES, "test-spec.k"), { specModuleName: "TEST-SPEC" }));
            const proof = APRProof.fromClaim(definition, claim);
            expect(proof.status).toBe(ProofStatus.PENDING);

            await advanceProof(new APRProver(explore), proof);
            expect(proof.status).toBe(ProofStatus.PASSED);
            expect(proof.failing).toHaveLength(0);
            // Reaching the target is a cover, which is how APR records success.
            expect(proof.kcfg.covers({ target: proof.target }).length).toBeGreaterThan(0);
          },
        );
      },
      TIMEOUT,
    );
  },
);

//////////////////////////
// 2. test_simple.py    //
//////////////////////////

/** `SimpleSemantics` (`tests/integration/proof/test_simple.py:27-33`). */
class SimpleSemantics extends DefaultKCFGSemantics {
  override isTerminal(cterm: CTerm): boolean {
    const kCell = cterm.tryCell("K_CELL");
    if (kCell?.node !== "KSequence") return false;
    const head = kCell.items[0];
    return head?.node === "KApply" && head.label.name === "f_SIMPLE-PROOFS_Step";
  }
}

describeKompiled(
  describe,
  "APRProver against pyk's simple-proofs terminal-node marking",
  {
    backend: "haskell",
    mainFile: join(KONVERT_SRC, "simple-proofs.k"),
    mainModule: "SIMPLE-PROOFS",
    syntaxModule: "SIMPLE-PROOFS",
  },
  (definitionDir) => {
    test(
      "marks the target terminal for a-to-f and not for a-to-e",
      async () => {
        await withLiveK(
          await definitionDir,
          "SIMPLE-PROOFS",
          new SimpleSemantics(),
          "simple-proofs",
          async ({ explore, definition, claims }) => {
            const spec = join(FIXTURES, "simple-proofs-spec.k");
            const load = async (label: string): Promise<KClaim> =>
              single(
                await claims(spec, {
                  specModuleName: "SIMPLE-PROOFS-SPEC",
                  claimLabels: [`SIMPLE-PROOFS-SPEC.${label}`],
                  includeDirs: [KONVERT_SRC],
                }),
              );

            // `a => e` never reaches an `f`, so nothing is terminal.
            const toE = APRProof.fromClaim(definition, await load("a-to-e"));
            await explore.simplify(toE.kcfg);
            await advanceProof(new APRProver(explore, { executeDepth: 1 }), toE);
            expect(toE.isTerminal(toE.target)).toBe(false);
            for (const predecessor of toE.kcfg.predecessors(toE.target)) {
              expect(toE.isTerminal(predecessor.source.id)).toBe(false);
            }

            // `a => f` ends on `f`, which `SimpleSemantics` calls terminal —
            // and the terminality must reach the target's predecessors too.
            const toF = APRProof.fromClaim(definition, await load("a-to-f"));
            await explore.simplify(toF.kcfg);
            await advanceProof(new APRProver(explore, { executeDepth: 1 }), toF);
            expect(toF.isTerminal(toF.target)).toBe(true);
            for (const predecessor of toF.kcfg.predecessors(toF.target)) {
              expect(toF.isTerminal(predecessor.source.id)).toBe(true);
            }
          },
        );
      },
      TIMEOUT,
    );
  },
);

//////////////////////////
// 3. test_non_det.py   //
//////////////////////////

describeKompiled(
  describe,
  "APRProver against pyk's non-determinism scenario",
  {
    backend: "haskell",
    mainFile: join(FIXTURES, "non-det.k"),
    mainModule: "NON-DET",
    syntaxModule: "NON-DET-SYNTAX",
  },
  (definitionDir) => {
    test(
      "builds the expected nd-branch shape and passes",
      async () => {
        await withLiveK(
          await definitionDir,
          "NON-DET",
          new DefaultKCFGSemantics(),
          "non-det",
          async ({ explore, definition, claims }) => {
            const claim = single(
              await claims(join(FIXTURES, "non-det-spec.k"), {
                specModuleName: "NON-DET-SPEC",
                claimLabels: ["NON-DET-SPEC.non-det"],
              }),
            );
            const proof = APRProof.fromClaim(definition, claim);
            await advanceProof(new APRProver(explore, { executeDepth: 1 }), proof, { maxIterations: 8 });

            //      id1a - final1 - success
            //     /
            //    /      id1b1 - final2 - success
            // id1      /
            //    \id1b
            //          \
            //           id1b2 - final3 - success
            const ndBranch = (id: number): readonly [number, number] => {
              expect(proof.kcfg.successors(id)).toHaveLength(1);
              const branches = proof.kcfg.ndbranches({ source: id });
              expect(branches).toHaveLength(1);
              const targets = branches[0]!.targets.map((node) => node.id);
              expect(targets).toHaveLength(2);
              return [targets[0]!, targets[1]!];
            };
            const edge = (id: number): number => {
              expect(proof.kcfg.successors(id)).toHaveLength(1);
              const edges = proof.kcfg.edges({ source: id });
              expect(edges).toHaveLength(1);
              return edges[0]!.target.id;
            };

            let [id1a, id1b] = ndBranch(proof.init);
            if (proof.kcfg.ndbranches({ source: id1a }).length > proof.kcfg.ndbranches({ source: id1b }).length) {
              [id1a, id1b] = [id1b, id1a];
            }
            const [id1b1, id1b2] = ndBranch(id1b);
            edge(id1a);
            edge(id1b1);
            edge(id1b2);

            expect(proof.status).toBe(ProofStatus.PASSED);
          },
        );
      },
      TIMEOUT,
    );
  },
);

//////////////////////////
// 4. test_refute_node  //
//////////////////////////

/** `RefuteSemantics` (`tests/integration/proof/test_refute_node.py:37-58`). */
class RefuteSemantics extends DefaultKCFGSemantics {
  override isTerminal(cterm: CTerm): boolean {
    const kCell = cterm.tryCell("K_CELL");
    if (kCell?.node === "KSequence") {
      const items = kCell.items;
      if (items.length === 0) return true;
      if (items.length === 1 && items[0]!.node === "KVariable") return true;
      const head = items[0];
      if (
        items.length === 2 &&
        items[1]!.node === "KVariable" &&
        head?.node === "KApply" &&
        (head.label.name === "e(_)_REFUTE-NODE-SYNTAX_A_Int" || head.label.name === "f(_)_REFUTE-NODE-SYNTAX_A_Int")
      ) {
        return true;
      }
    }
    if (kCell?.node === "KVariable") return true;
    return false;
  }
}

const REFUTE_SPEC = join(FIXTURES, "refute-node-spec.k");

describeKompiled(
  describe,
  "refutations against pyk's refute-node definition",
  {
    backend: "haskell",
    mainFile: join(FIXTURES, "refute-node.k"),
    mainModule: "REFUTE-NODE",
    syntaxModule: "REFUTE-NODE-SYNTAX",
  },
  (definitionDir) => {
    /** `build_prover` (`test_refute_node.py:71-93`), plus a proof directory. */
    const refuteProof = async (context: LiveContext, claimId: string, proofDir: string): Promise<APRProof> => {
      const claim = single(
        await context.claims(REFUTE_SPEC, {
          specModuleName: "REFUTE-NODE-SPEC",
          claimLabels: [`REFUTE-NODE-SPEC.${claimId}`],
          includeDirs: [FIXTURES],
        }),
      );
      return APRProof.fromClaim(context.definition, claim, new Map(), { proofDir });
    };

    const live = async (
      label: string,
      body: (context: LiveContext, proofDir: string) => Promise<void>,
    ): Promise<void> => {
      await withLiveK(await definitionDir, "REFUTE-NODE", new RefuteSemantics(), label, async (context) => {
        const proofDir = join(context.scratch, `proofs-${label}`);
        await mkdir(proofDir, { recursive: true });
        await body(context, proofDir);
      });
    };

    test(
      "test_apr_proof_unrefute_node: refuting then unrefuting still lets the proof pass",
      async () => {
        await live("unrefute", async (context, proofDir) => {
          const proof = await refuteProof(context, "split-int-succeed", proofDir);
          const prover = new APRProver(context.explore);

          await advanceProof(prover, proof, { maxIterations: 1 });
          expect(proof.status).toBe(ProofStatus.PENDING);
          const frontier = proof.pending;
          expect(frontier).toHaveLength(2);

          const frontierNode = frontier[0]!;
          expect(await refuteNode(proof, frontierNode)).toBeDefined();
          expect(proof.isRefuted(frontierNode.id)).toBe(true);
          await unrefuteNode(proof, frontierNode);
          expect(proof.isRefuted(frontierNode.id)).toBe(false);

          await advanceProof(prover, proof);
          expect(proof.status).toBe(ProofStatus.PASSED);
        });
      },
      TIMEOUT,
    );

    test(
      "test_apr_proof_refute_node: the refutation of a failing split branch itself fails",
      async () => {
        await live("refute", async (context, proofDir) => {
          const proof = await refuteProof(context, "split-int-fail", proofDir);
          await advanceProof(new APRProver(context.explore), proof);
          expect(proof.status).toBe(ProofStatus.FAILED);

          const failingNode = single(proof.failing);
          const refutation = await refuteNode(proof, failingNode);
          expect(refutation).toBeDefined();
          expect(proof.subproofIds).toHaveLength(1);

          const subproof = asRefutationProof(single(proof.subproofs));
          await advanceProof(new ImpliesProver(context.symbolic), subproof);
          // `d(N) => e(N -Int 1) requires N <=Int 0` is perfectly satisfiable,
          // so the branch cannot be refuted (`test_refute_node.py:155`).
          expect(subproof.status).toBe(ProofStatus.FAILED);

          const actual = [...subproof.preConstraints, subproof.lastConstraint]
            .filter((constraint) => !isTop(constraint))
            .map((constraint) => context.definition.sortVars(constraint));
          expect(actual).toEqual([context.definition.sortVars(leInt(kvariable("N"), intToken(0)))]);

          expect(proof.status).toBe(ProofStatus.FAILED);
        });
      },
      TIMEOUT,
    );

    test(
      "test_apr_proof_read_node_refutations: a refutation survives the directory round trip",
      async () => {
        await live("read-refutations", async (context, proofDir) => {
          const proof = await refuteProof(context, "split-int-succeed", proofDir);
          await advanceProof(new APRProver(context.explore), proof, { maxIterations: 1 });
          expect(proof.status).toBe(ProofStatus.PENDING);
          const frontier = proof.pending;
          expect(frontier).toHaveLength(2);

          const frontierNode = frontier[0]!;
          await refuteNode(proof, frontierNode);

          const reloaded = asAprProof(await readProofData(proofDir, proof.id));
          expect(reloaded.nodeRefutations.size).toBe(1);
          expect(reloaded.nodeRefutations.get(frontierNode.id)?.id).toBe(proof.getRefutationId(frontierNode.id));
        });
      },
      TIMEOUT,
    );

    test(
      "test_apr_proof_refute_node_no_successors: only a leaf can be refuted",
      async () => {
        await live("no-successors", async (context, proofDir) => {
          const proof = await refuteProof(context, "split-int-fail", proofDir);
          await advanceProof(new APRProver(context.explore), proof);

          const failingNode = single(proof.failing);
          const predecessors = proof.kcfg.predecessors(failingNode.id);
          expect(predecessors).toHaveLength(1);

          expect(await refuteNode(proof, predecessors[0]!.source)).toBeUndefined();
          expect(await refuteNode(proof, failingNode)).toBeDefined();
        });
      },
      TIMEOUT,
    );

    test(
      "test_apr_proof_refute_node_no_useless_constraints: the refutation keeps only what it needs",
      async () => {
        await live("useless-constraints", async (context, proofDir) => {
          const proof = await refuteProof(context, "triple-split-int-fail", proofDir);
          await advanceProof(new APRProver(context.explore), proof);

          const failingNode = single(proof.failing);
          const allFreeVars = new Set(failingNode.cterm.constraints.flatMap((c) => [...freeVars(c)]));
          expect([...allFreeVars].toSorted()).toEqual(["L", "M", "N"]);

          const refutation = await refuteNode(proof, failingNode);
          expect(refutation).toBeDefined();
          // last_constraint is `N <=Int 0`; `M <=Int 0` is independent of it and
          // is dropped, `L +Int N <=Int 0` is not.
          expect(refutation!.preConstraints).toHaveLength(1);
          expect([...freeVars(refutation!.preConstraints[0]!)].toSorted()).toEqual(["L", "N"]);
        });
      },
      TIMEOUT,
    );

    test(
      "test_apr_proof_refute_node_to_claim: the KClaim golden, verbatim",
      async () => {
        await live("to-claim", async (context, proofDir) => {
          const proof = await refuteProof(context, "triple-split-int-fail", proofDir);
          await advanceProof(new APRProver(context.explore), proof);

          const refutation = await refuteNode(proof, single(proof.failing));
          expect(refutation).toBeDefined();
          const [claim] = refutation!.toClaim("refute-node-claim");

          // claim ['refute-node-claim']: <k> ( N:Int <=Int 0 => false ) </k>
          //   requires _L +Int N:Int <=Int 0        (`test_refute_node.py:288-297`)
          const INT = ksort("Int");
          expect(claim).toEqual(
            kclaim(krewrite(leInt(kvariable("N", INT), intToken(0)), FALSE), {
              requires: leInt(addInt(kvariable("_L", INT), kvariable("N", INT)), intToken(0)),
              att: new KAtt([attEntry(Atts.LABEL, "refute-node-claim")]),
            }),
          );
        });
      },
      TIMEOUT,
    );

    test(
      "a failed proof's failure info names the cell that could not match",
      async () => {
        await live("failure-info", async (context, proofDir) => {
          const proof = await refuteProof(context, "split-int-fail", proofDir);
          await advanceProof(new APRProver(context.explore), proof);
          expect(proof.status).toBe(ProofStatus.FAILED);

          // `advanceProof` attaches it on the way out (`proof.py:636-638`).
          const failure = proof.failureInfo;
          if (!(failure instanceof APRFailureInfo)) throw new TypeError("Expected an APRFailureInfo");
          const failingNode = single(proof.failing);

          const reason = failure.failureReasons.get(failingNode.id) ?? "";
          // The whole point of the cterm failure-reason walk: not just
          // "Matching failed.", but which cell and what is left to prove.
          expect(reason).toContain("Matching failed.");
          expect(reason).toContain("The following cells failed matching individually");
          expect(reason).toContain("K_CELL");
          expect(reason.split("\n").length).toBeGreaterThan(2);

          const pathCondition = failure.pathConditions.get(failingNode.id) ?? "";
          expect(pathCondition).toContain("<=Int");
          expect(failure.print().join("\n")).toContain("Failure reason:");
        });
      },
      TIMEOUT,
    );
  },
);

//////////////////////////////
// 5. test_implies_proof.py //
//////////////////////////////

/**
 * The whole of upstream's `imp-simple-spec.k` is vendored, and this rung reads
 * only its `IMP-FUNCTIONAL-SPEC` module; the APR modules in the same file are
 * `live-imp.test.ts`'s.
 */
const IMP_SIMPLE_SPEC = join(FIXTURES, "imp-simple-spec.k");
/** `imp.k` is vendored once, by `@kframework-ts/kompiled`; this points K at it. */
const KOMPILED_SRC = join(import.meta.dir, "../../kompiled/fixtures/src");

/** `IMPLIES_PROOF_TEST_DATA` (`test_implies_proof.py:31-63`). */
const IMPLIES_PROOF_TEST_DATA: readonly (readonly [
  id: string,
  antecedents: readonly string[],
  consequents: readonly string[],
  bindUniversally: boolean,
  expected: ProofStatus,
])[] = [
  ["antecedent-bottom", ["X <=Int 0", "0 <Int X"], ["X <Int 3"], true, ProofStatus.PASSED],
  ["consequent-top", ["X <Int 3"], ["X <Int X +Int 1"], true, ProofStatus.PASSED],
  ["satisfiable-not-valid", ["X <Int 3"], ["X <Int 2"], true, ProofStatus.FAILED],
  ["satisfiable-not-valid-true-antecedent", [], ["X <=Int 0"], true, ProofStatus.FAILED],
  // The same implication passes when `X` is bound existentially instead.
  ["satisfiable-not-valid-existential", [], ["X <=Int 0"], false, ProofStatus.PASSED],
];

/**
 * `FUNC_PROVE_TEST_DATA` (`test_implies_proof.py:66-152`), verbatim — including
 * the row whose id says `nontrivial` while its claim id says `trivial`, which
 * is an upstream copy-paste that makes two rows run the same claim.
 */
const FUNC_PROVE_TEST_DATA: readonly (readonly [id: string, claimId: string, expected: ProofStatus])[] = [
  ["func-spec-concrete", "concrete-addition", ProofStatus.PASSED],
  ["func-spec-concrete-fail", "concrete-addition-fail", ProofStatus.FAILED],
  ["func-spec-concrete-identity", "concrete-identity", ProofStatus.PASSED],
  ["func-spec-concrete-nonsense", "concrete-nonsense", ProofStatus.FAILED],
  [
    "func-spec-concrete-requires-trivial-false-identity",
    "concrete-requires-trivial-false-identity",
    ProofStatus.PASSED,
  ],
  [
    "func-spec-concrete-requires-nontrivial-false-identity",
    "concrete-requires-nontrivial-false-identity",
    ProofStatus.PASSED,
  ],
  [
    "func-spec-concrete-requires-trivial-false-nonsense",
    "concrete-requires-trivial-false-nonsense",
    ProofStatus.PASSED,
  ],
  [
    "func-spec-concrete-requires-trivial-false-nonsense-undecided",
    "concrete-requires-trivial-false-nonsense-undecided",
    ProofStatus.PASSED,
  ],
  [
    "func-spec-concrete-requires-nontrivial-false-nonsense-undecided",
    "concrete-requires-trivial-false-nonsense-undecided",
    ProofStatus.PASSED,
  ],
  [
    "func-spec-concrete-requires-nontrivial-false-nonsense",
    "concrete-requires-nontrivial-false-nonsense",
    ProofStatus.PASSED,
  ],
  ["func-spec-symbolic-add-comm", "symbolic-addition-commutativity", ProofStatus.PASSED],
  ["ite-sort-param", "ite-sort-param", ProofStatus.PASSED],
];

/** `FAILING_TESTS` (`test_implies_proof.py:30`) — skipped upstream, skipped here. */
const FAILING_IMPLIES_TESTS: readonly string[] = ["func-spec-symbolic-add-comm"];

describeKompiled(
  describe,
  "the implies family against pyk's IMP verification definition",
  {
    backend: "haskell",
    mainFile: join(FIXTURES, "imp-verification.k"),
    mainModule: "IMP-VERIFICATION",
    syntaxModule: "IMP-VERIFICATION-SYNTAX",
    includeDirs: [KOMPILED_SRC],
  },
  (definitionDir) => {
    const live = async (label: string, body: (context: LiveContext) => Promise<void>): Promise<void> => {
      await withLiveK(await definitionDir, "IMP-VERIFICATION", new DefaultKCFGSemantics(), label, body);
    };

    test(
      "test_implies_proof: the five pure-logic rows",
      async () => {
        await live("implies-proof", async (context) => {
          for (const [id, antecedents, consequents, bindUniversally, expected] of IMPLIES_PROOF_TEST_DATA) {
            const parse = async (texts: readonly string[]): Promise<KInner[]> => {
              const parsed: KInner[] = [];
              for (const text of texts) {
                parsed.push(await context.kprint.parseToken(ktoken(text, BOOL), { asRule: true }));
              }
              return parsed;
            };
            const antecedent = mlAnd((await parse(antecedents)).map((term) => mlEqualsTrue(term)));
            const consequent = mlAnd((await parse(consequents)).map((term) => mlEqualsTrue(term)));

            const proof = new ImpliesProof(id, antecedent, consequent, { bindUniversally });
            await advanceProof(new ImpliesProver(context.symbolic), proof);
            expect([id, proof.status]).toEqual([id, expected]);
          }
        });
      },
      TIMEOUT,
    );

    test(
      "test_functional_prove: EqualityProof.fromClaim over IMP-FUNCTIONAL-SPEC",
      async () => {
        await live("functional-prove", async (context) => {
          for (const [id, claimId, expected] of FUNC_PROVE_TEST_DATA) {
            if (FAILING_IMPLIES_TESTS.includes(id)) continue;
            const claim = single(
              await context.claims(IMP_SIMPLE_SPEC, {
                specModuleName: "IMP-FUNCTIONAL-SPEC",
                claimLabels: [`IMP-FUNCTIONAL-SPEC.${claimId}`],
                includeDirs: [FIXTURES, KOMPILED_SRC],
              }),
            );
            const proof = EqualityProof.fromClaim(claim, context.definition);
            await advanceProof(new ImpliesProver(context.symbolic), proof);
            expect([id, proof.status]).toEqual([id, expected]);
          }
        });
      },
      TIMEOUT,
    );
  },
);
