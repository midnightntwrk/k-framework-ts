/**
 * The façade and the CLI against a real K.
 *
 * `proveClaims` is what replaces `ProveRpc` here, so this suite is the
 * equivalent of `pyk/src/tests/integration/proof/test_prove_rpc.py`: a spec
 * file goes in, a verdict per claim comes out, functional claims become
 * `EqualityProof`s and everything else an `APRProof`, and a second run over the
 * same proof directory resumes rather than re-proving. The APR rows are
 * upstream's `PROVE_TEST_DATA` (`test_prove_rpc.py:76-169`), and like it they
 * run under `ImpSemantics` — `DefaultSemantics` never calls `<k> .K </k>`
 * terminal, so an IMP proof under it explores past its own end.
 *
 * **Functional-claim detection is narrower than "in IMP-FUNCTIONAL-SPEC".**
 * `_prove_claim_rpc` only reaches `EqualityProof` when the claim's LHS is a
 * function *application* (`prove_rpc.py:105-106`), so `3 +Int 4 => 7` qualifies
 * and `0 => 0` does not: the latter is routed to `APRProof.from_claim`, which
 * cannot build a configuration out of a bare token and raises. That is upstream
 * behaviour, and it is exactly the case the batch contract exists for — the
 * crash lands on that one verdict and the rest of the batch still runs.
 *
 * The resume row is asserted the way only a library can assert it: the second
 * run is given an explore session whose adapter counts backend calls, so
 * "resumed" means *no request was made*, not merely "finished quickly".
 */

import type { CTerm } from "@kframework-ts/cterm";
import { CTermSymbolic, type CTermSymbolicClient } from "@kframework-ts/cterm/symbolic";
import { DefaultKCFGSemantics, KCFGExplore } from "@kframework-ts/kcfg/explore";
import { describeKompiled } from "@kframework-ts/ktool/testing";
import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { main } from "../src/cli.ts";
import { ProofStatus } from "../src/index.ts";
import { proveClaims, type ExploreSession, type ProveProgressEvent } from "../src/prove.ts";
import { FIXTURES, KOMPILED_SRC, single, TIMEOUT, withLiveSession, type LiveContext } from "./live-support.ts";

const IMP_SIMPLE_SPEC = join(FIXTURES, "imp-simple-spec.k");

/** `ImpSemantics` (`test_prove_rpc.py:34-73`), the same one `test_imp.py` uses. */
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

/**
 * The `IMP-FUNCTIONAL-SPEC` claims whose LHS is a function application, so the
 * façade's detection routes them to `EqualityProof`, with their upstream
 * statuses (`test_implies_proof.py:66-152`). `symbolic-addition-commutativity`
 * is in pyk's `FAILING_TESTS` list and is left out here as it is skipped there.
 */
const FUNCTIONAL_EXPECTED = new Map<string, ProofStatus>([
  ["IMP-FUNCTIONAL-SPEC.concrete-addition", ProofStatus.PASSED],
  ["IMP-FUNCTIONAL-SPEC.concrete-addition-fail", ProofStatus.FAILED],
  ["IMP-FUNCTIONAL-SPEC.ite-sort-param", ProofStatus.PASSED],
]);

/** A claim whose LHS is a bare token: routed to `APRProof`, and it crashes there. */
const NON_FUNCTIONAL_LABEL = "IMP-FUNCTIONAL-SPEC.concrete-identity";

describeKompiled(
  describe,
  "proveClaims and the kproof CLI against pyk's IMP verification definition",
  {
    backend: "haskell",
    mainFile: join(FIXTURES, "imp-verification.k"),
    mainModule: "IMP-VERIFICATION",
    syntaxModule: "IMP-VERIFICATION-SYNTAX",
    includeDirs: [KOMPILED_SRC],
  },
  (definitionDir) => {
    test(
      "routes functional claims to EqualityProof, and one crashing claim does not stop the batch",
      async () => {
        await withLiveSession(
          await definitionDir,
          "IMP-VERIFICATION",
          new ImpSemantics(),
          "facade-functional",
          async (context) => {
            const proofDir = join(context.scratch, "proofs-functional");
            await mkdir(proofDir, { recursive: true });
            const specFile = await context.copySpec(IMP_SIMPLE_SPEC);
            const events: ProveProgressEvent[] = [];

            const verdicts = await proveClaims({
              definitionDir: await definitionDir,
              specFile,
              specModuleName: "IMP-FUNCTIONAL-SPEC",
              claimLabels: [...FUNCTIONAL_EXPECTED.keys(), NON_FUNCTIONAL_LABEL],
              includeDirs: [FIXTURES, KOMPILED_SRC],
              builtinDir: context.builtinDir,
              proofDir,
              session: context.session,
              progress: (event) => {
                events.push(event);
              },
            });

            const functional = verdicts.filter((verdict) => verdict.id !== NON_FUNCTIONAL_LABEL);
            const actual = new Map(functional.map((verdict) => [verdict.id, verdict.status]));
            expect(actual).toEqual(FUNCTIONAL_EXPECTED);
            // Each of those is an implies-family proof: its LHS head is a
            // function symbol (`prove_rpc.py:105-106`).
            for (const verdict of functional) {
              expect([verdict.id, verdict.proof?.proofType]).toEqual([verdict.id, "EqualityProof"]);
              expect([verdict.id, verdict.error]).toEqual([verdict.id, undefined]);
            }

            // The token-LHS claim is routed to `APRProof`, which cannot build a
            // configuration from it. `run_prover`'s contract: the crash is
            // recorded on that verdict and the batch runs to the end anyway.
            const crashed = single(verdicts.filter((verdict) => verdict.id === NON_FUNCTIONAL_LABEL));
            expect(crashed.error).toBeInstanceOf(Error);
            expect(crashed.passed).toBe(false);

            expect(events.filter((event) => event.kind === "proof-finished")).toHaveLength(verdicts.length);
          },
        );
      },
      TIMEOUT,
    );

    test(
      "proves APR claims, then resumes them from disk without touching the backend",
      async () => {
        await withLiveSession(
          await definitionDir,
          "IMP-VERIFICATION",
          new ImpSemantics(),
          "facade-apr",
          async (context) => {
            const proofDir = join(context.scratch, "proofs-apr");
            await mkdir(proofDir, { recursive: true });
            const specFile = await context.copySpec(IMP_SIMPLE_SPEC);
            const labels = ["IMP-SIMPLE-SPEC.addition-1", "IMP-SIMPLE-SPEC.addition-2", "IMP-SIMPLE-SPEC.addition-var"];

            const first = await proveClaims({
              definitionDir: await definitionDir,
              specFile,
              specModuleName: "IMP-SIMPLE-SPEC",
              claimLabels: labels,
              includeDirs: [FIXTURES, KOMPILED_SRC],
              builtinDir: context.builtinDir,
              proofDir,
              session: context.session,
            });

            expect(first.map((verdict) => verdict.id).toSorted()).toEqual(labels.toSorted());
            for (const verdict of first) {
              expect([verdict.id, verdict.proof?.proofType]).toEqual([verdict.id, "APRProof"]);
              expect([verdict.id, verdict.status]).toEqual([verdict.id, ProofStatus.PASSED]);
              expect([verdict.id, verdict.resumed]).toEqual([verdict.id, false]);
            }

            // A second run over the same proof directory: every proof is read
            // back already passed, so no prover is ever built and the counting
            // adapter sees nothing.
            const calls: string[] = [];
            const second = await proveClaims({
              definitionDir: await definitionDir,
              specFile,
              specModuleName: "IMP-SIMPLE-SPEC",
              claimLabels: labels,
              includeDirs: [FIXTURES, KOMPILED_SRC],
              builtinDir: context.builtinDir,
              proofDir,
              session: countingSession(context, calls, "resume"),
            });

            for (const verdict of second) {
              expect([verdict.id, verdict.status]).toEqual([verdict.id, ProofStatus.PASSED]);
              expect([verdict.id, verdict.resumed]).toEqual([verdict.id, true]);
            }
            expect(calls).toEqual([]);
          },
        );
      },
      TIMEOUT,
    );

    test(
      "a claim whose text changed is re-initialised, not resumed",
      async () => {
        await withLiveSession(
          await definitionDir,
          "IMP-VERIFICATION",
          new ImpSemantics(),
          "facade-digest",
          async (context) => {
            const proofDir = join(context.scratch, "proofs-digest");
            await mkdir(proofDir, { recursive: true });
            const label = "IMP-SIMPLE-SPEC.addition-1";
            const original = await context.copySpec(IMP_SIMPLE_SPEC);

            // The same claim label with a different body: `3 + 4` becomes
            // `4 + 3`, which still proves and still sums to 7, so the *only*
            // thing that changed is the claim's text — and therefore its
            // digest. A separate file, because `ClaimLoader` caches its parse
            // next to the spec.
            const edited = join(context.scratch, "imp-simple-spec-edited.k");
            const source = await readFile(original, "utf8");
            expect(source).toContain("claim [addition-1]: <k> 3 + 4 => 7 ... </k>");
            await writeFile(edited, source.replace("<k> 3 + 4 => 7 ... </k>", "<k> 4 + 3 => 7 ... </k>"), "utf8");

            const common = {
              definitionDir: await definitionDir,
              specModuleName: "IMP-SIMPLE-SPEC",
              claimLabels: [label],
              includeDirs: [FIXTURES, KOMPILED_SRC],
              builtinDir: context.builtinDir,
              proofDir,
            };

            const first = single([...(await proveClaims({ ...common, specFile: original, session: context.session }))]);
            expect([first.status, first.resumed]).toEqual([ProofStatus.PASSED, false]);
            // The digest file is the record that makes the next two runs differ.
            expect(await readFile(join(proofDir, "digest"), "utf8")).toContain(label);

            // Run two, on the edited claim, against a call-counting session:
            // the stored proof is *not* resumed and the backend is used again.
            const changedCalls: string[] = [];
            const second = single([
              ...(await proveClaims({
                ...common,
                specFile: edited,
                session: countingSession(context, changedCalls, "digest-changed"),
              })),
            ]);
            expect([second.status, second.resumed]).toEqual([ProofStatus.PASSED, false]);
            expect(changedCalls.length).toBeGreaterThan(0);

            // Run three, on the same edited claim: now the digest matches, so
            // the passed proof is read back and nothing is asked of the server.
            const sameCalls: string[] = [];
            const third = single([
              ...(await proveClaims({
                ...common,
                specFile: edited,
                session: countingSession(context, sameCalls, "digest-same"),
              })),
            ]);
            expect([third.status, third.resumed]).toEqual([ProofStatus.PASSED, true]);
            expect(sameCalls).toEqual([]);
          },
        );
      },
      TIMEOUT,
    );

    test(
      "the concurrent driver proves two claims over one server",
      async () => {
        await withLiveSession(
          await definitionDir,
          "IMP-VERIFICATION",
          new ImpSemantics(),
          "facade-workers",
          async (context) => {
            const proofDir = join(context.scratch, "proofs-workers");
            await mkdir(proofDir, { recursive: true });
            const specFile = await context.copySpec(IMP_SIMPLE_SPEC);

            const verdicts = await proveClaims({
              definitionDir: await definitionDir,
              specFile,
              specModuleName: "IMP-SIMPLE-SPEC",
              claimLabels: ["IMP-SIMPLE-SPEC.failing-if", "IMP-SIMPLE-SPEC.addition-1"],
              includeDirs: [FIXTURES, KOMPILED_SRC],
              builtinDir: context.builtinDir,
              proofDir,
              maxWorkers: 2,
              session: context.session,
            });

            const statuses = new Map(verdicts.map((verdict) => [verdict.id, verdict.status]));
            // Both statuses are `test_prove_rpc.py`'s (`:76-169`).
            expect(statuses.get("IMP-SIMPLE-SPEC.addition-1")).toBe(ProofStatus.PASSED);
            expect(statuses.get("IMP-SIMPLE-SPEC.failing-if")).toBe(ProofStatus.FAILED);
          },
        );
      },
      TIMEOUT,
    );

    test(
      "kproof prove, then kproof status, end to end",
      async () => {
        await withLiveSession(
          await definitionDir,
          "IMP-VERIFICATION",
          new ImpSemantics(),
          "facade-cli",
          async (context) => {
            const proofDir = join(context.scratch, "proofs-cli");
            await mkdir(proofDir, { recursive: true });
            // Two copies, because `ClaimLoader`'s `<spec>.json` cache digest
            // covers the spec file, the include dirs and the md selector but
            // **not** the spec module (`claim_loader.py:59,93-99`) — so a second
            // run over the same path with a different `--spec-module` would hit
            // the first run's cache and not find its labels. pyk has the same
            // hole; giving each invocation its own copy sidesteps it.
            const simpleSpec = await context.copySpec(IMP_SIMPLE_SPEC);
            const functionalSpec = join(context.scratch, "imp-functional-copy.k");
            await copyFile(simpleSpec, functionalSpec);
            const out: string[] = [];
            const err: string[] = [];
            const sinks: [(text: string) => void, (text: string) => void] = [
              (text) => {
                out.push(text);
              },
              (text) => {
                err.push(text);
              },
            ];

            /** The flags every invocation below shares. */
            const common = async (specFile: string, specModule: string, labels: string): Promise<readonly string[]> => [
              "prove",
              await definitionDir,
              specFile,
              "--spec-module",
              specModule,
              "--labels",
              labels,
              "-I",
              FIXTURES,
              "-I",
              KOMPILED_SRC,
              "--builtin-dir",
              context.builtinDir,
              "--proof-dir",
              proofDir,
              "--failure-info",
              "--quiet",
              "--kore-rpc-command",
              join(context.binDir, "kore-rpc"),
              "--kprove",
              join(context.binDir, "kprove"),
            ];

            // The CLI runs `DefaultKCFGSemantics`, exactly as pyk's `exec_prove`
            // runs `DefaultSemantics` — every hook trivial. `addition-1` closes
            // by subsumption, so it needs no `is_terminal`; an IMP claim that
            // does would explore past its own end under either tool, which is
            // why the failing half of this test is a functional claim.
            const passing = await main(
              [...(await common(simpleSpec, "IMP-SIMPLE-SPEC", "IMP-SIMPLE-SPEC.addition-1"))],
              ...sinks,
            );
            expect([passing, err.join("")]).toEqual([0, ""]);
            expect(out.join("")).toContain("IMP-SIMPLE-SPEC.addition-1");
            expect(out.join("")).toContain("ProofStatus.PASSED");

            out.length = 0;
            const mixed = await main(
              [
                ...(await common(
                  functionalSpec,
                  "IMP-FUNCTIONAL-SPEC",
                  "IMP-FUNCTIONAL-SPEC.concrete-addition,IMP-FUNCTIONAL-SPEC.concrete-addition-fail",
                )),
              ],
              ...sinks,
            );
            // pyk's contract: the exit code is the number of proofs that did
            // not pass (`__main__.py:290`).
            expect([mixed, err.join("")]).toEqual([1, ""]);
            const text = out.join("");
            expect(text).toContain("IMP-FUNCTIONAL-SPEC.concrete-addition");
            expect(text).toContain("EqualityProof: IMP-FUNCTIONAL-SPEC.concrete-addition-fail");
            expect(text).toContain("ProofStatus.PASSED");
            expect(text).toContain("ProofStatus.FAILED");

            const statusOut: string[] = [];
            const statusSinks: [(line: string) => void, (line: string) => void] = [
              (line) => {
                statusOut.push(line);
              },
              (line) => {
                err.push(line);
              },
            ];
            expect(await main(["status", proofDir, "IMP-SIMPLE-SPEC.addition-1"], ...statusSinks)).toBe(0);
            expect(statusOut.join("")).toContain("IMP-SIMPLE-SPEC.addition-1");
            expect(await main(["status", proofDir, "IMP-FUNCTIONAL-SPEC.concrete-addition-fail"], ...statusSinks)).toBe(
              1,
            );
          },
        );
      },
      TIMEOUT,
    );
  },
);

/**
 * A `KoreClient`-shaped proxy that records every request made through it.
 *
 * The seam is the *client*, not the adapter: `CTermSymbolic` freezes itself in
 * its constructor, so it cannot be subclassed with new fields, and it takes a
 * structural `CTermSymbolicClient` anyway. Delegating rather than stubbing is
 * deliberate — the resume row needs an adapter that would work if anything
 * called it, so that an empty call list is evidence and not a broken fake.
 */
/** The live session, with every backend call recorded — so "resumed" is provable. */
function countingSession(context: LiveContext, calls: string[], id: string): ExploreSession {
  const counted = new CTermSymbolic(countingClient(context.session.client, calls), context.definition);
  return {
    ...context.session,
    symbolic: counted,
    explore: new KCFGExplore(counted, { semantics: new ImpSemantics(), id }),
  };
}

function countingClient(inner: CTermSymbolicClient, calls: string[]): CTermSymbolicClient {
  return {
    execute: (...args) => {
      calls.push("execute");
      return inner.execute(...args);
    },
    simplify: (...args) => {
      calls.push("simplify");
      return inner.simplify(...args);
    },
    getModel: (...args) => {
      calls.push("get-model");
      return inner.getModel(...args);
    },
    implies: (...args) => {
      calls.push("implies");
      return inner.implies(...args);
    },
    addModule: (...args) => {
      calls.push("add-module");
      return inner.addModule(...args);
    },
    interrupt: () => {
      calls.push("interrupt");
      inner.interrupt();
    },
  };
}
