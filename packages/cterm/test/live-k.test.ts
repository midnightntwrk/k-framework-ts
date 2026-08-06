/**
 * The two direct `pyk` CTerm integration scenarios, behind ktool's shared
 * K-bearing harness.  The harness is responsible for the opt-in gate, pinned
 * v7.1.337 check, and compilation cache; this file owns only the CTerm-level
 * assertions and always starts its kore-rpc server through the public API.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { eq, kapply, kflatmodule, kimport, ksequence, ktoken, kvariable, type KInner } from "@kframework-ts/kast";
import { mlEqualsTrue } from "@kframework-ts/kast/prelude/ml";
import { KPrint } from "@kframework-ts/ktool";
import { describeKompiled, requireKTestEnvironment } from "@kframework-ts/ktool/testing";
import { KoreClient, tcpTransport } from "@kframework-ts/kore-rpc";
import { koreRpcServer } from "@kframework-ts/kore-rpc/server";

import { CTerm, ctermEq } from "../src/cterm.ts";
import { CTermSymbolic } from "../src/symbolic.ts";
import { assembleTrace, traceContext, traceRuleCounts, traceToJsonl } from "../src/trace.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "live-k");
const SIMPLE_PROOFS = join(FIXTURES, "simple-proofs.k");
const MULTIPLE_DEFINITIONS = join(FIXTURES, "multiple-definitions.k");

/** The K source's generated top cell, as assembled by pyk's `TestSimpleProof.config`. */
async function simpleConfig(kprint: KPrint, k: string, state: string, constraint?: string): Promise<CTerm> {
  const kTerm = await kprint.parseToken(ktoken(k, "K"), { asRule: true });
  const stateTerm = await kprint.parseToken(ktoken(state, "Map"), { asRule: true });
  const constraints =
    constraint === undefined
      ? []
      : [mlEqualsTrue(await kprint.parseToken(ktoken(constraint, "Bool"), { asRule: true }))];
  return new CTerm(
    kapply("<generatedTop>", [
      kapply("<k>", [ksequence([kTerm])]),
      kapply("<state>", [stateTerm]),
      kvariable("GENERATED_COUNTER_CELL"),
    ]),
    constraints,
  );
}

function multipleDefinitionsConfig(): CTerm {
  return new CTerm(
    kapply("<generatedTop>", [
      kapply("<k>", [ksequence([kapply("a", [kvariable("X")])])]),
      kvariable("GENERATED_COUNTER_CELL"),
    ]),
  );
}

async function parsed(kprint: KPrint, text: string, sort: string): Promise<KInner> {
  return kprint.parseToken(ktoken(text, sort), { asRule: true });
}

async function expectCell(kprint: KPrint, actual: KInner, text: string, sort: string): Promise<void> {
  expect(eq(actual, await parsed(kprint, text, sort))).toBe(true);
}

async function expectUnorderedKCells(
  kprint: KPrint,
  actual: readonly CTerm[],
  expected: readonly string[],
): Promise<void> {
  const expectedTerms = await Promise.all(expected.map((text) => parsed(kprint, text, "K")));
  expect(actual).toHaveLength(expectedTerms.length);
  for (const expectedTerm of expectedTerms) {
    expect(actual.some((cterm) => eq(cterm.cell("K_CELL"), expectedTerm))).toBe(true);
  }
}

async function withSymbolic(
  definitionDir: string,
  moduleName: string,
  body: (symbolic: CTermSymbolic, kprint: KPrint) => Promise<void>,
): Promise<void> {
  const environment = await requireKTestEnvironment();
  const kprint = await KPrint.load(definitionDir, {
    command: [join(environment.binDir, "kast")],
    korePrintCommand: [join(environment.binDir, "kore-print")],
  });
  const server = await koreRpcServer({
    kompiledDir: definitionDir,
    moduleName,
    command: [join(environment.binDir, "kore-rpc")],
  });
  let client: KoreClient | undefined;
  try {
    // `tcpTransport` supplies the server-ready retry loop.  A transport error
    // is intentionally allowed to retain its compilation/transport context.
    client = new KoreClient(await tcpTransport(server.host, server.port, { timeout: 30_000 }));
    await body(new CTermSymbolic(client, kprint.definition), kprint);
  } finally {
    client?.close();
    await server.close();
  }
}

describeKompiled(
  describe,
  "CTermSymbolic against pyk's simple-proofs scenario",
  {
    backend: "haskell",
    mainFile: SIMPLE_PROOFS,
    mainModule: "SIMPLE-PROOFS",
    syntaxModule: "SIMPLE-PROOFS",
  },
  (definitionDir) => {
    test("preserves pyk's branch states/depths and simplifies bytes through a live server", async () => {
      await withSymbolic(await definitionDir, "SIMPLE-PROOFS", async (symbolic, kprint) => {
        const branch = await symbolic.execute(await simpleConfig(kprint, "a", ".Map"), { maxDepth: 3 });
        expect(branch.depth).toBe(1);
        await expectCell(kprint, branch.state.cell("K_CELL"), "b ~> .K", "K");
        await expectCell(kprint, branch.state.cell("STATE_CELL"), ".Map", "Map");
        expect(branch.nextStates).toHaveLength(2);
        await expectUnorderedKCells(
          kprint,
          branch.nextStates.map((next) => next.cterm),
          ["c ~> .K", "d ~> .K"],
        );

        const noBranch = await symbolic.execute(
          await simpleConfig(kprint, "foo", "3 |-> M:Int", "notBool pred1(M:Int)"),
          { maxDepth: 1 },
        );
        expect(noBranch.depth).toBe(0);
        expect(noBranch.nextStates).toHaveLength(0);
        await expectCell(kprint, noBranch.state.cell("K_CELL"), "foo ~> .K", "K");
        await expectCell(kprint, noBranch.state.cell("STATE_CELL"), "3 |-> M:Int", "Map");

        const simplified = await symbolic.simplify(await simpleConfig(kprint, "mybytes", ".Map"));
        await expectCell(kprint, simplified.cterm.cell("K_CELL"), String.raw`b"\x00\x90\xa0\n\xa1\xf1a" ~> .K`, "K");
        await expectCell(kprint, simplified.cterm.cell("STATE_CELL"), ".Map", "Map");
      });
    }, 120_000);

    test("assembles an attributed, deterministic trace from a live rewrite log", async () => {
      await withSymbolic(await definitionDir, "SIMPLE-PROOFS", async (symbolic, kprint) => {
        // Two deterministic steps, `c.e` then `e.f`, so ordering is observable.
        // Nothing here asks for logging: `logSuccessfulRewrites` defaults on,
        // which is the whole point of the instance policy.
        const start = await simpleConfig(kprint, "c", ".Map");
        const result = await symbolic.execute(start, { maxDepth: 20 });
        expect(result.reason).toBe("stuck");
        expect(result.depth).toBe(2);

        const context = traceContext(symbolic);
        const trace = assembleTrace(result.raw.logs, context);
        expect(trace).toHaveLength(2);
        expect(trace.map((entry) => entry.index)).toEqual([0, 1]);
        // Module-qualified, as `kompile` writes the `label` attribute — the `.k`
        // source says `rule [c.e]:`.
        expect(trace.map((entry) => entry.label)).toEqual(["SIMPLE-PROOFS.c.e", "SIMPLE-PROOFS.e.f"]);
        expect(trace.map((entry) => entry.outcome)).toEqual(["success", "success"]);
        expect(trace.every((entry) => entry.resolved)).toBe(true);
        expect(trace.every((entry) => entry.module === "SIMPLE-PROOFS")).toBe(true);
        expect(trace.every((entry) => entry.source?.endsWith("simple-proofs.k") === true)).toBe(true);
        expect(trace.every((entry) => entry.location !== null)).toBe(true);
        // Long ids, so the join is by whole id and no prefix rule is needed.
        expect(trace.every((entry) => entry.ruleId?.length === 64)).toBe(true);

        // The measured emission, pinned: a v0.1.155 server hard-codes
        // `substitution` and `rewritten-term` to `Nothing`
        // (`Booster/JsonRpc.hs:658-669`, `Kore/JsonRpc.hs:198-212`).  This
        // assertion is the alarm that rings if that ever changes.
        expect(trace.every((entry) => entry.substitution === null)).toBe(true);

        // Every rule fired once — the per-run coverage histogram, with no file
        // and no `K_LOG_DIR`.
        expect([...traceRuleCounts(trace).values()]).toEqual([1, 1]);

        // Determinism (R6): the same run, twice, byte-identical.
        const again = await symbolic.execute(start, { maxDepth: 20 });
        expect(traceToJsonl(assembleTrace(again.raw.logs, context))).toBe(traceToJsonl(trace));

        // And logging really is a policy an instance can turn off.
        const quiet = new CTermSymbolic(symbolic.client, symbolic.definition, { logSuccessfulRewrites: false });
        const quietResult = await quiet.execute(start, { maxDepth: 20 });
        expect(quietResult.raw.logs).toBeUndefined();
        expect(assembleTrace(quietResult.raw.logs, context)).toEqual([]);
      });
    }, 120_000);

    test("computes a #Ceil definedness condition and files a session module", async () => {
      await withSymbolic(await definitionDir, "SIMPLE-PROOFS", async (symbolic, kprint) => {
        // Everything in this configuration is total, so the backend simplifies
        // its `#Ceil` to `#Top` and `CTerm` normalisation drops it again.
        const total = await simpleConfig(kprint, "a", ".Map");
        expect(ctermEq(await symbolic.assumeDefined(total), total)).toBe(true);

        const module = kflatmodule("CTERM-TS-LIVE", { imports: [kimport("SIMPLE-PROOFS")] });
        const byHash = await symbolic.addModule(module);
        // `"m" + sha256(moduleText)`, and stable for the same text.
        expect(byHash).toStartWith("m");
        expect(byHash).toHaveLength(65);
        expect(await symbolic.addModule(module)).toBe(byHash);

        // The id names the module in a later request on the same session.
        const executed = await symbolic.execute(total, { maxDepth: 1, module: byHash });
        await expectCell(kprint, executed.state.cell("K_CELL"), "b ~> .K", "K");
      });
    }, 120_000);
  },
);

describeKompiled(
  describe,
  "CTermSymbolic against pyk's multiple-definitions scenario",
  {
    backend: "haskell",
    mainFile: MULTIPLE_DEFINITIONS,
    mainModule: "MULTIPLE-DEFINITIONS",
    syntaxModule: "MULTIPLE-DEFINITIONS",
  },
  (definitionDir) => {
    test("keeps both conditional branches and executes both to c", async () => {
      await withSymbolic(await definitionDir, "MULTIPLE-DEFINITIONS", async (symbolic, kprint) => {
        const split = await symbolic.execute(multipleDefinitionsConfig(), { maxDepth: 1 });
        expect(split.depth).toBe(0);
        expect(split.nextStates).toHaveLength(2);
        await expectCell(kprint, split.state.cell("K_CELL"), "a ( X:KItem ) ~> .K", "K");

        for (const branch of split.nextStates) {
          const finished = await symbolic.execute(branch.cterm, { maxDepth: 1 });
          await expectCell(kprint, finished.state.cell("K_CELL"), "c ~> .K", "K");
        }
      });
    }, 120_000);
  },
);
