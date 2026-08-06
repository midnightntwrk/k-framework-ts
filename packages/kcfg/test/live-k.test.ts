/**
 * A deliberately small real-K conformance scenario for KCFG exploration.
 *
 * `describeKompiled` keeps this suite inert unless `KFRAMEWORK_TS_K_BIN`
 * explicitly selects the pinned K distribution. The fixture is shared with
 * CTerm's live suite: its complementary `a(X)` rules create a logical split,
 * and extending one split child creates a concrete edge.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CTerm } from "@kframework-ts/cterm";
import { CTermSymbolic } from "@kframework-ts/cterm/symbolic";
import { kapply, ksequence, kvariable, type KInner } from "@kframework-ts/kast";
import { KPrint } from "@kframework-ts/ktool";
import { describeKompiled, requireKTestEnvironment } from "@kframework-ts/ktool/testing";
import { KoreClient, tcpTransport } from "@kframework-ts/kore-rpc";
import { koreRpcServer } from "@kframework-ts/kore-rpc/server";

import { KCFGExplore, KCFGExploration } from "../src/explore.ts";
import { KCFG } from "../src/kcfg.ts";
import { readKcfgStore, writeKcfgStore } from "../src/store.ts";

const MULTIPLE_DEFINITIONS = join(import.meta.dir, "../../cterm/test/fixtures/live-k/multiple-definitions.k");

/** The generated top cell for `MULTIPLE-DEFINITIONS`' single `<k>` configuration. */
function config(k: KInner): CTerm {
  return new CTerm(kapply("<generatedTop>", [kapply("<k>", [ksequence([k])]), kvariable("GENERATED_COUNTER_CELL")]));
}

async function withSymbolic(definitionDir: string, body: (symbolic: CTermSymbolic) => Promise<void>): Promise<void> {
  const environment = await requireKTestEnvironment();
  const kprint = await KPrint.load(definitionDir, {
    command: [join(environment.binDir, "kast")],
    korePrintCommand: [join(environment.binDir, "kore-print")],
  });
  const server = await koreRpcServer({
    kompiledDir: definitionDir,
    moduleName: "MULTIPLE-DEFINITIONS",
    command: [join(environment.binDir, "kore-rpc")],
  });
  let client: KoreClient | undefined;
  try {
    client = new KoreClient(await tcpTransport(server.host, server.port, { timeout: 30_000 }));
    await body(new CTermSymbolic(client, kprint.definition));
  } finally {
    client?.close();
    await server.close();
  }
}

describeKompiled(
  describe,
  "KCFGExplore against pyk's multiple-definitions scenario",
  {
    backend: "haskell",
    mainFile: MULTIPLE_DEFINITIONS,
    mainModule: "MULTIPLE-DEFINITIONS",
    syntaxModule: "MULTIPLE-DEFINITIONS",
  },
  (definitionDir) => {
    test("creates an edge, creates a logical split, and round-trips the resulting store", async () => {
      await withSymbolic(await definitionDir, async (symbolic) => {
        const graph = new KCFG();
        const exploration = new KCFGExploration(graph);
        const explore = new KCFGExplore(symbolic);

        const splitSource = graph.createNode(config(kapply("a", [kvariable("X")])));
        const splitResults = await explore.extendNode(exploration, splitSource.id, { executeDepth: 1 });
        expect(splitResults).toHaveLength(1);
        expect(splitResults[0]).toMatchObject({ kind: "branch", heuristic: false });
        const split = graph.successor(splitSource.id);
        expect(split?.kind).toBe("split");
        if (split?.kind !== "split") throw new Error("Expected a logical KCFG split");
        expect(split.targets).toHaveLength(2);

        const edgeSource = split.targets[0]!.node;
        const edgeResults = await explore.extendNode(exploration, edgeSource.id, { executeDepth: 1 });
        expect(edgeResults).toHaveLength(1);
        expect(edgeResults[0]).toMatchObject({ kind: "step", depth: 1 });
        const edge = graph.successor(edgeSource.id);
        expect(edge).toMatchObject({ kind: "edge", depth: 1 });

        const directory = await mkdtemp(join(tmpdir(), "kframework-ts-kcfg-live-store-"));
        try {
          await writeKcfgStore(directory, graph);
          expect((await readKcfgStore(directory)).toDict()).toEqual(graph.toDict());
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    }, 120_000);
  },
);
