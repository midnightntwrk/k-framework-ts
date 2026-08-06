/**
 * The step protocol and `APRProver`, driven entirely by a fake backend.
 *
 * Every `APRProofResult` variant, the `getSteps`/`commit` contract, the
 * `advanceProof` loop, and `initProof`'s module injection are exercised here
 * with no K installation and no server: the seam `KCFGExplore` takes is narrow
 * enough that a recorded-response fake satisfies it, which is the same trick
 * `@kframework-ts/kcfg`'s `explore.test.ts` uses.
 */

import { CSubst, CTerm } from "@kframework-ts/cterm";
import {
  KDefinition,
  kapply,
  kflatmodule,
  kproduction,
  krewrite,
  ksort,
  kterminal,
  ktoken,
  kvariable,
  Subst,
  type KFlatModule,
  type KInner,
  type KRule,
} from "@kframework-ts/kast";
import { KCFG, type KCFGNode } from "@kframework-ts/kcfg";
import {
  DefaultKCFGSemantics,
  KCFGExplore,
  type ExtendCtermOptions,
  type KCFGExtendResult,
  type KCFGSemantics,
  type KCFGSymbolic,
  type KCFGSymbolicAddModuleOptions,
  type KCFGSymbolicExecuteResult,
  type KCFGSymbolicImpliesOptions,
  type KCFGSymbolicImpliesResult,
  type KCFGSymbolicModelResult,
  type KCFGSymbolicSimplifyResult,
} from "@kframework-ts/kcfg/explore";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { APRFailureInfo, APRProof, aprProofStepKey, type APRProofResult, type APRProofStep } from "../src/index.ts";
import { advanceProof, APRProver, aprFailureInfoFromProof, type Prover } from "../src/prove.ts";
import { caught } from "./support.ts";
import { proofDataExists, readProofData, writeProofData } from "../src/store.ts";

//////////////////////////
// Fixtures             //
//////////////////////////

/** `<generatedTop> <k> ?name </k> </generatedTop>`, with `?name` a variable. */
function term(name: string): CTerm {
  return new CTerm(kapply("<generatedTop>", [kapply("<k>", [kvariable(name)])]));
}

/** The same shape, but with a concrete `<k>` cell, so matching can fail. */
function concreteTerm(label: string): CTerm {
  return new CTerm(kapply("<generatedTop>", [kapply("<k>", [kapply(label)])]));
}

/** The `<k>` cell's variable name or function label, for the test semantics below. */
function kCellName(cterm: CTerm): string | undefined {
  const cell = cterm.tryCell("K_CELL");
  if (cell === undefined) return undefined;
  if (cell.node === "KVariable") return cell.name;
  if (cell.node === "KApply") return cell.label.name;
  return undefined;
}

/** A minimal definition, only so `APRProver` can read a main module name off it. */
function definition(): KDefinition {
  const module = kflatmodule("MAIN", { sentences: [kproduction(ksort("Foo"), { items: [kterminal("foo")] })] });
  return new KDefinition("MAIN", [module]);
}

/** One recorded `add-module` call. */
interface RecordedModule {
  readonly module: KFlatModule;
  readonly options: KCFGSymbolicAddModuleOptions | undefined;
}

interface FakeSymbolicScript {
  readonly implies?: readonly KCFGSymbolicImpliesResult[];
  readonly model?: KCFGSymbolicModelResult;
}

class FakeSymbolic implements KCFGSymbolic {
  readonly definition = definition();
  readonly addedModules: RecordedModule[] = [];
  readonly impliesCalls: { antecedent: CTerm; consequent: CTerm }[] = [];
  readonly simplifyCalls: CTerm[] = [];
  #implies: KCFGSymbolicImpliesResult[];
  #model: KCFGSymbolicModelResult | undefined;

  constructor(script: FakeSymbolicScript = {}) {
    this.#implies = [...(script.implies ?? [])];
    this.#model = script.model;
  }

  execute(): Promise<KCFGSymbolicExecuteResult> {
    throw new Error("the prover tests script extendCterm, not execute");
  }

  simplify(cterm: CTerm): Promise<KCFGSymbolicSimplifyResult> {
    this.simplifyCalls.push(cterm);
    return Promise.resolve({ cterm });
  }

  implies(
    antecedent: CTerm,
    consequent: CTerm,
    _options?: KCFGSymbolicImpliesOptions,
  ): Promise<KCFGSymbolicImpliesResult> {
    this.impliesCalls.push({ antecedent, consequent });
    return Promise.resolve(this.#implies.shift() ?? {});
  }

  getModel(): Promise<KCFGSymbolicModelResult> {
    return Promise.resolve(this.#model ?? { satisfiable: "Unknown" });
  }

  addModule(module: KFlatModule, options?: KCFGSymbolicAddModuleOptions): Promise<string> {
    this.addedModules.push({ module, options });
    return Promise.resolve(module.name);
  }
}

/**
 * A `KCFGExplore` whose `extendCterm` is a queue of prepared results.
 *
 * `APRProver` never inspects an extension, so scripting them isolates the step
 * algorithm from execute-response classification, which `@kframework-ts/kcfg`
 * already covers exhaustively. Every field is private because `KCFGExplore`'s
 * constructor freezes `this` — a public class field would be defined after
 * `super()` returns and would throw.
 */
class ScriptedExplore extends KCFGExplore {
  readonly #extendCalls: { cterm: CTerm; nodeId: number; options: ExtendCtermOptions }[] = [];
  readonly #script: (readonly KCFGExtendResult[])[];

  constructor(symbolic: KCFGSymbolic, script: (readonly KCFGExtendResult[])[], semantics?: KCFGSemantics) {
    super(symbolic, { semantics: semantics ?? new DefaultKCFGSemantics() });
    this.#script = script;
  }

  get extendCalls(): readonly { cterm: CTerm; nodeId: number; options: ExtendCtermOptions }[] {
    return this.#extendCalls;
  }

  override extendCterm(
    cterm: CTerm,
    nodeId: number,
    options: ExtendCtermOptions = {},
  ): Promise<readonly KCFGExtendResult[]> {
    this.#extendCalls.push({ cterm, nodeId, options });
    const next = this.#script.shift();
    if (next === undefined) throw new Error("no scripted extend result");
    return Promise.resolve(next);
  }
}

/** Terminal exactly on the named `<k>` cells. */
class TerminalOn extends DefaultKCFGSemantics {
  readonly #names: readonly string[];
  constructor(names: readonly string[]) {
    super();
    this.#names = names;
  }
  override isTerminal(cterm: CTerm): boolean {
    const name = kCellName(cterm);
    return name !== undefined && this.#names.includes(name);
  }
}

/** Every node is the same loop head, so BMC bounding is reachable in a unit test. */
class LoopSemantics extends DefaultKCFGSemantics {
  override isLoop(): boolean {
    return true;
  }
  override sameLoop(): boolean {
    return true;
  }
}

function stepResult(cterm: CTerm, depth = 1, rules: readonly string[] = ["R"]): KCFGExtendResult {
  return { kind: "step", cterm, depth, rules, logs: [] };
}

/** A two-node proof: `init` pending, `target` unreached. */
function twoNodeProof(id = "test", options: { circularity?: boolean; bmcDepth?: number } = {}): APRProof {
  const graph = new KCFG();
  const init = graph.createNode(term("A"));
  const target = graph.createNode(term("Z"));
  return new APRProof(id, graph, [], init.id, target.id, new Map(), {
    ...(options.circularity === undefined ? {} : { circularity: options.circularity }),
    ...(options.bmcDepth === undefined ? {} : { bmcDepth: options.bmcDepth }),
  });
}

/** A branch predicate pair that `splitOnConstraints` accepts. */
function twoConstraints(): readonly KInner[] {
  return [
    kapply("#Equals", [kvariable("X"), kvariable("Y")]),
    kapply("#Not", [kapply("#Equals", [kvariable("X"), kvariable("Y")])]),
  ];
}

function onlyStep(proof: APRProof): APRProofStep {
  const steps = proof.getSteps();
  expect(steps).toHaveLength(1);
  return steps[0]!;
}

//////////////////////////
// APRProof.getSteps    //
//////////////////////////

describe("APRProof.getSteps", () => {
  test("emits one step per pending node with the depends module and no cache", () => {
    const proof = twoNodeProof("my.proof");
    const only = onlyStep(proof);
    expect(only.proofId).toBe("my.proof");
    expect(only.node.id).toBe(proof.init);
    expect(only.target.id).toBe(proof.target);
    expect(only.moduleName).toBe("M-MY-PROOF-DEPENDS-MODULE");
    expect(only.useCache).toBeUndefined();
    expect(only.bmcDepth).toBeUndefined();
    expect(only.nonzeroDepth).toBe(false);
    expect(only.circularityRuleId).toBe(`APRPROOF-MY.PROOF-${proof.init}-TO-${proof.target}`);
    expect(only.shortestPathToNode).toEqual([]);
  });

  test("a circularity at non-zero depth routes to the circularities module", () => {
    const proof = twoNodeProof("circ", { circularity: true });
    // At zero depth the depends module is still used (`reachability.py:190-192`).
    expect(onlyStep(proof).moduleName).toBe("M-CIRC-DEPENDS-MODULE");

    const next = proof.kcfg.createNode(term("B"));
    proof.kcfg.createEdge(proof.init, next.id, 1, ["r"]);
    const advanced = onlyStep(proof);
    expect(advanced.node.id).toBe(next.id);
    expect(advanced.nonzeroDepth).toBe(true);
    expect(advanced.moduleName).toBe("M-CIRC-CIRCULARITIES-MODULE");
  });

  test("more than one incoming edge is an error", () => {
    const graph = new KCFG();
    const a = graph.createNode(term("A"));
    const b = graph.createNode(term("B"));
    const joined = graph.createNode(term("C"));
    const target = graph.createNode(term("Z"));
    graph.createEdge(a.id, joined.id, 1, ["r1"]);
    graph.createEdge(b.id, joined.id, 1, ["r2"]);
    const proof = new APRProof("join", graph, [], a.id, target.id);
    expect(() => proof.getSteps()).toThrow(/2 incoming edges/u);
  });

  test("a split predecessor contributes no edges, hence no cache", () => {
    const proof = twoNodeProof("split");
    expect(proof.kcfg.splitOnConstraints(proof.init, twoConstraints())).toHaveLength(2);
    expect(proof.getSteps().map((entry) => entry.useCache)).toEqual([undefined, undefined]);
  });

  test("the BMC shortest path skips zero-depth sources", () => {
    const proof = twoNodeProof("bmc", { bmcDepth: 2 });
    const mid = proof.kcfg.createNode(term("B"));
    proof.kcfg.createEdge(proof.init, mid.id, 3, ["r"]);
    const path = onlyStep(proof).shortestPathToNode;
    expect(path.map((node: KCFGNode) => node.id)).toEqual([proof.init]);
  });

  test("the step key ignores the loops cache but not the proof", () => {
    const proof = twoNodeProof("key", { bmcDepth: 1 });
    const before = aprProofStepKey(onlyStep(proof));
    proof.priorLoopsCache.set(proof.init, [4, 5]);
    expect(aprProofStepKey(onlyStep(proof))).toBe(before);
    expect(onlyStep(proof).priorLoopsCache.get(proof.init)).toEqual([4, 5]);

    expect(aprProofStepKey(onlyStep(twoNodeProof("other", { bmcDepth: 1 })))).not.toBe(before);
  });
});

//////////////////////////
// APRProof.commit      //
//////////////////////////

describe("APRProof.commit", () => {
  test("commits every result variant and keeps the extend cache off disk", async () => {
    const proof = twoNodeProof("commit");
    const base = { priorLoopsCacheUpdate: [7], optimizeKcfg: false } as const;

    proof.commit({ ...base, kind: "extend", nodeId: proof.init, extensionToApply: stepResult(term("B")) });
    expect(proof.priorLoopsCache.get(proof.init)).toEqual([7]);
    const b = proof.kcfg.edges({ source: proof.init })[0]!.target;

    proof.commit({
      ...base,
      kind: "extend-and-cache",
      nodeId: b.id,
      extensionToApply: stepResult(term("C")),
      extensionToCache: stepResult(term("D"), 2, ["cached"]),
    });
    expect(proof.nextSteps.has(b.id)).toBe(true);
    const c = proof.kcfg.edges({ source: b.id })[0]!.target;

    // Caching twice over one node is an `assert` upstream (`reachability.py:233`).
    expect(() => {
      proof.commit({
        ...base,
        kind: "extend-and-cache",
        nodeId: b.id,
        extensionToApply: stepResult(term("C2")),
        extensionToCache: stepResult(term("D2")),
      });
    }).toThrow(/already has a cached next step/u);

    // The cached step applies to `c` and leaves the cache.
    proof.commit({ ...base, kind: "use-cache", nodeId: c.id, cachedNodeId: b.id });
    expect(proof.nextSteps.size).toBe(0);
    expect(proof.kcfg.edges({ source: c.id })[0]?.depth).toBe(2);
    expect(() => {
      proof.commit({ ...base, kind: "use-cache", nodeId: c.id, cachedNodeId: b.id });
    }).toThrow(/no cached next step/u);

    const d = proof.kcfg.edges({ source: c.id })[0]!.target;
    proof.commit({ ...base, kind: "terminal", nodeId: d.id });
    expect(proof.isTerminal(d.id)).toBe(true);
    proof.commit({ ...base, kind: "bounded", nodeId: d.id });
    expect(proof.isBounded(d.id)).toBe(true);

    proof.commit({ ...base, kind: "subsume", nodeId: d.id, csubst: new CSubst(new Subst()) });
    expect(proof.kcfg.covers({ source: d.id })).toHaveLength(1);

    // The extend cache is in-memory only: it appears in neither schema and does
    // not survive a disk round trip (`reachability.py:118`, and see the README).
    proof.commit({
      ...base,
      kind: "extend-and-cache",
      nodeId: proof.target,
      extensionToApply: stepResult(term("E")),
      extensionToCache: stepResult(term("F")),
    });
    expect(JSON.stringify(proof.dict)).not.toContain("next_steps");
    expect(JSON.stringify(proof.proofDataDict)).not.toContain("next_steps");

    const dir = await mkdtemp(join(tmpdir(), "kframework-ts-proof-cache-"));
    try {
      proof.proofDir = dir;
      await writeProofData(proof);
      const reloaded = await readProofData(dir, "commit");
      expect(reloaded).toBeInstanceOf(APRProof);
      if (reloaded instanceof APRProof) expect(reloaded.nextSteps.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("optimizeKcfg merges a step into its single incoming edge", () => {
    const proof = twoNodeProof("optimize");
    const base = { priorLoopsCacheUpdate: [], optimizeKcfg: true } as const;
    proof.commit({ ...base, kind: "extend", nodeId: proof.init, extensionToApply: stepResult(term("B"), 3, ["r1"]) });
    const b = proof.kcfg.edges({ source: proof.init })[0]!.target;
    proof.commit({ ...base, kind: "extend", nodeId: b.id, extensionToApply: stepResult(term("C"), 4, ["r2"]) });

    // The intermediate node is gone and the two edges have become one.
    expect(proof.kcfg.getNode(b.id)).toBeUndefined();
    const edges = proof.kcfg.edges({ source: proof.init });
    expect(edges).toHaveLength(1);
    expect(edges[0]?.depth).toBe(7);
    expect(edges[0]?.rules).toEqual(["r1", "r2"]);
  });
});

//////////////////////////
// APRProver.stepProof  //
//////////////////////////

describe("APRProver.stepProof", () => {
  test("extends through the backend, forwarding module, depth and cut rules", async () => {
    const symbolic = new FakeSymbolic();
    const explore = new ScriptedExplore(symbolic, [[stepResult(term("B"))]]);
    const proof = twoNodeProof("extend");
    const prover = new APRProver(explore, { executeDepth: 5, cutPointRules: ["CUT"], terminalRules: ["TERM"] });

    const results = await prover.stepProof(onlyStep(proof));
    expect(results).toHaveLength(1);
    expect(results[0]?.kind).toBe("extend");
    expect(results[0]?.nodeId).toBe(proof.init);
    expect(explore.extendCalls[0]?.options).toMatchObject({
      executeDepth: 5,
      cutPointRules: ["CUT"],
      terminalRules: ["TERM"],
      module: "M-EXTEND-DEPENDS-MODULE",
    });
  });

  test("two extension results become extend-and-cache only at non-zero depth", async () => {
    const symbolic = new FakeSymbolic();
    const explore = new ScriptedExplore(symbolic, [
      [stepResult(term("B")), stepResult(term("C"))],
      [stepResult(term("D")), stepResult(term("E"))],
    ]);
    const proof = twoNodeProof("cache");
    const prover = new APRProver(explore, {});

    const zero = await prover.stepProof(onlyStep(proof));
    expect(zero[0]?.kind).toBe("extend");

    proof.commit(zero[0]!);
    const b = proof.kcfg.edges({ source: proof.init })[0]!.target;
    const deep = await prover.stepProof(onlyStep(proof));
    expect(deep[0]?.kind).toBe("extend-and-cache");
    expect(deep[0]?.nodeId).toBe(b.id);
  });

  test("a cache hit short-circuits the backend", async () => {
    const symbolic = new FakeSymbolic();
    const explore = new ScriptedExplore(symbolic, []);
    const proof = twoNodeProof("hit");
    proof.commit({
      priorLoopsCacheUpdate: [],
      optimizeKcfg: false,
      kind: "extend-and-cache",
      nodeId: proof.init,
      extensionToApply: stepResult(term("B")),
      extensionToCache: stepResult(term("C"), 2, ["cached"]),
    });
    const next = onlyStep(proof);
    expect(next.useCache).toBe(proof.init);

    const results = await new APRProver(explore, {}).stepProof(next);
    expect(results[0]?.kind).toBe("use-cache");
    expect(explore.extendCalls).toHaveLength(0);

    proof.commit(results[0]!);
    expect(proof.nextSteps.size).toBe(0);
  });

  test("subsumption runs only when node and target agree on terminality", async () => {
    // Node terminal, target not: the check is skipped entirely (`reachability.py:863`).
    const skipping = new FakeSymbolic({ implies: [{ csubst: new CSubst(new Subst()) }] });
    const skipExplore = new ScriptedExplore(skipping, [], new TerminalOn(["A"]));
    const skipResults = await new APRProver(skipExplore, {}).stepProof(onlyStep(twoNodeProof("skip")));
    expect(skipResults.map((entry) => entry.kind)).toEqual(["terminal"]);
    expect(skipping.impliesCalls).toHaveLength(0);

    // Both non-terminal: the check runs and a valid csubst subsumes.
    const symbolic = new FakeSymbolic({ implies: [{ csubst: new CSubst(new Subst()) }] });
    const proof = twoNodeProof("subsume");
    const results = await new APRProver(new ScriptedExplore(symbolic, []), {}).stepProof(onlyStep(proof));
    expect(results.map((entry) => entry.kind)).toEqual(["subsume"]);
    proof.commit(results[0]!);
    expect(proof.kcfg.covers({ source: proof.init })).toHaveLength(1);

    // Both terminal: the terminal result comes back alongside the subsume one,
    // so the terminal set is still updated (`reachability.py:865-874`).
    const both = new FakeSymbolic({ implies: [{ csubst: new CSubst(new Subst()) }] });
    const bothExplore = new ScriptedExplore(both, [], new TerminalOn(["A", "Z"]));
    const bothResults = await new APRProver(bothExplore, {}).stepProof(onlyStep(twoNodeProof("both")));
    expect(bothResults.map((entry) => entry.kind)).toEqual(["terminal", "subsume"]);
  });

  test("fastCheckSubsumption skips the RPC when the K cells cannot match", async () => {
    const graph = new KCFG();
    const init = graph.createNode(concreteTerm("bar"));
    const target = graph.createNode(concreteTerm("foo"));
    const proof = new APRProof("fast", graph, [], init.id, target.id);

    const symbolic = new FakeSymbolic({ implies: [{}] });
    const explore = new ScriptedExplore(symbolic, [[stepResult(concreteTerm("baz"))]]);
    const results = await new APRProver(explore, { fastCheckSubsumption: true }).stepProof(onlyStep(proof));
    expect(symbolic.impliesCalls).toHaveLength(0);
    expect(results[0]?.kind).toBe("extend");

    // Without the pre-filter the same step does call the backend.
    const symbolic2 = new FakeSymbolic({ implies: [{}] });
    const explore2 = new ScriptedExplore(symbolic2, [[stepResult(concreteTerm("baz"))]]);
    await new APRProver(explore2, {}).stepProof(onlyStep(proof));
    expect(symbolic2.impliesCalls).toHaveLength(1);
  });

  test("a terminal non-subsumed node returns only the terminal result", async () => {
    const symbolic = new FakeSymbolic({ implies: [{}] });
    const explore = new ScriptedExplore(symbolic, [], new TerminalOn(["A", "Z"]));
    const proof = twoNodeProof("terminal");
    const results = await new APRProver(explore, {}).stepProof(onlyStep(proof));
    expect(results.map((entry) => entry.kind)).toEqual(["terminal"]);
    proof.commit(results[0]!);
    expect(proof.isTerminal(proof.init)).toBe(true);
  });

  test("BMC bounds a node once the prior-loop chain exceeds the depth", async () => {
    const symbolic = new FakeSymbolic({ implies: [{}] });
    const explore = new ScriptedExplore(symbolic, [[stepResult(term("B"))]], new LoopSemantics());
    const proof = twoNodeProof("bounded", { bmcDepth: 1 });
    const mid = proof.kcfg.createNode(term("B"));
    proof.kcfg.createEdge(proof.init, mid.id, 1, ["r"]);
    // Two prior loop heads recorded against `init` makes the chain length 3 > 1.
    proof.priorLoopsCache.set(proof.init, [90, 91]);

    const results = await new APRProver(explore, {}).stepProof(onlyStep(proof));
    expect(results.map((entry) => entry.kind)).toEqual(["bounded"]);
    expect(results[0]?.priorLoopsCacheUpdate).toEqual([90, 91, proof.init]);
    proof.commit(results[0]!);
    expect(proof.isBounded(mid.id)).toBe(true);
    expect(proof.priorLoopsCache.get(mid.id)).toEqual([90, 91, proof.init]);
  });

  test("a zero-depth circularity forces executeDepth 1 and cuts at its own rule once deep", async () => {
    const symbolic = new FakeSymbolic({ implies: [{}, {}] });
    const explore = new ScriptedExplore(symbolic, [[stepResult(term("B"))], [stepResult(term("C"))]]);
    const proof = twoNodeProof("circ", { circularity: true });
    const prover = new APRProver(explore, { executeDepth: 32 });

    const first = await prover.stepProof(onlyStep(proof));
    expect(explore.extendCalls[0]?.options.executeDepth).toBe(1);
    expect([...(explore.extendCalls[0]?.options.cutPointRules ?? [])]).toEqual([]);

    proof.commit(first[0]!);
    await prover.stepProof(onlyStep(proof));
    expect(explore.extendCalls[1]?.options.executeDepth).toBe(32);
    expect([...(explore.extendCalls[1]?.options.cutPointRules ?? [])]).toEqual([
      `APRPROOF-CIRC-${proof.init}-TO-${proof.target}`,
    ]);
  });
});

//////////////////////////
// APRProver.initProof  //
//////////////////////////

describe("APRProver.initProof", () => {
  test("injects the depends module, importing the main module", async () => {
    const symbolic = new FakeSymbolic();
    const proof = twoNodeProof("dep.proof");
    await new APRProver(new ScriptedExplore(symbolic, []), {}).initProof(proof);

    expect(symbolic.addedModules).toHaveLength(1);
    const injected = symbolic.addedModules[0]!;
    expect(injected.module.name).toBe("M-DEP-PROOF-DEPENDS-MODULE");
    expect(injected.module.imports.map((entry) => entry.name)).toEqual(["MAIN"]);
    expect(injected.module.sentences).toEqual([]);
    expect(injected.options).toEqual({ nameAsId: true });
  });

  test("a circularity adds a second module importing the first, at priority 20", async () => {
    const symbolic = new FakeSymbolic();
    const proof = twoNodeProof("circ", { circularity: true });
    await new APRProver(new ScriptedExplore(symbolic, []), {}).initProof(proof);

    expect(symbolic.addedModules.map((entry) => entry.module.name)).toEqual([
      "M-CIRC-DEPENDS-MODULE",
      "M-CIRC-CIRCULARITIES-MODULE",
    ]);
    const circularities = symbolic.addedModules[1]!.module;
    expect(circularities.imports.map((entry) => entry.name)).toEqual(["M-CIRC-DEPENDS-MODULE"]);
    expect(circularities.sentences).toHaveLength(1);
    expect(attValue(asRule(circularities.sentences[0]), "priority")).toBe("20");
    expect(attValue(asRule(circularities.sentences[0]), "label")).toBe(
      `APRPROOF-CIRC-${proof.init}-TO-${proof.target}`,
    );
  });

  test("an extra module becomes the base the depends module imports", async () => {
    const symbolic = new FakeSymbolic();
    const extra = kflatmodule("EXTRA", {});
    await new APRProver(new ScriptedExplore(symbolic, []), { extraModule: extra }).initProof(twoNodeProof("extra"));

    expect(symbolic.addedModules.map((entry) => entry.module.name)).toEqual(["EXTRA", "M-EXTRA-DEPENDS-MODULE"]);
    expect(symbolic.addedModules[1]!.module.imports.map((entry) => entry.name)).toEqual(["EXTRA"]);
  });

  test("subproof rules are read from disk and filed at priority 20", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kframework-ts-proof-init-"));
    try {
      const subGraph = new KCFG();
      const subInit = subGraph.createNode(term("SA"));
      const subTarget = subGraph.createNode(term("SZ"));
      subGraph.createEdge(subInit.id, subTarget.id, 1, ["sub"]);
      const sub = new APRProof("sub", subGraph, [], subInit.id, subTarget.id, new Map(), { proofDir: dir });
      await writeProofData(sub);
      expect(await proofDataExists(dir, "sub")).toBe(true);

      const graph = new KCFG();
      const init = graph.createNode(term("A"));
      const target = graph.createNode(term("Z"));
      const proof = new APRProof("parent", graph, [], init.id, target.id, new Map(), {
        proofDir: dir,
        subproofs: [sub],
        subproofIds: ["sub"],
      });

      const symbolic = new FakeSymbolic();
      await new APRProver(new ScriptedExplore(symbolic, []), {}).initProof(proof);
      const depends = symbolic.addedModules[0]!.module;
      expect(depends.name).toBe("M-PARENT-DEPENDS-MODULE");
      expect(depends.sentences).toHaveLength(1);
      expect(attValue(asRule(depends.sentences[0]), "priority")).toBe("20");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("init and target are marked terminal — the one prover-mutates-proof case", async () => {
    const symbolic = new FakeSymbolic();
    const explore = new ScriptedExplore(symbolic, [], new TerminalOn(["A", "Z"]));
    const proof = twoNodeProof("mark");
    expect(proof.isTerminal(proof.init)).toBe(false);
    await new APRProver(explore, {}).initProof(proof);
    expect(proof.isTerminal(proof.init)).toBe(true);
    expect(proof.isTerminal(proof.target)).toBe(true);
  });
});

/** One attribute's value by name; `KAtt.get` keys on an `AttKey`, not a string. */
function attValue(rule: KRule, name: string): unknown {
  return [...rule.att.entries()].find((entry) => entry.key.name === name)?.value;
}

function asRule(sentence: unknown): KRule {
  if (typeof sentence !== "object" || sentence === null || !("node" in sentence) || sentence.node !== "KRule") {
    throw new TypeError("Expected a KRule");
  }
  // The guard above is the whole structural check this test helper needs.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return sentence as KRule;
}

//////////////////////////
// advanceProof         //
//////////////////////////

class RecordingProver implements Prover<APRProof, APRProofStep, APRProofResult> {
  readonly initialized: string[] = [];
  readonly stepped: number[] = [];
  readonly failureInfoFor: string[] = [];
  closed = false;

  constructor(private readonly onStep: (step: APRProofStep) => readonly APRProofResult[]) {}

  initProof(proof: APRProof): Promise<void> {
    this.initialized.push(proof.id);
    return Promise.resolve();
  }

  stepProof(step: APRProofStep): Promise<readonly APRProofResult[]> {
    this.stepped.push(step.node.id);
    return Promise.resolve(this.onStep(step));
  }

  close(): void {
    this.closed = true;
  }

  failureInfo(proof: APRProof): Promise<APRFailureInfo> {
    this.failureInfoFor.push(proof.id);
    return Promise.resolve(
      new APRFailureInfo({
        failingNodes: proof.failing.map((node) => node.id),
        pendingNodes: proof.pending.map((node) => node.id),
        pathConditions: new Map(),
        failureReasons: new Map(),
      }),
    );
  }
}

/** Count the steps each `getSteps()` call returned, without changing behaviour. */
function traceGetSteps(proof: APRProof, sizes: number[]): void {
  const original = proof.getSteps.bind(proof);
  Object.defineProperty(proof, "getSteps", {
    value: (): readonly APRProofStep[] => {
      const steps = original();
      sizes.push(steps.length);
      return steps;
    },
  });
}

function extendWith(cterm: CTerm): (step: APRProofStep) => readonly APRProofResult[] {
  return (step) => [
    {
      kind: "extend",
      nodeId: step.node.id,
      priorLoopsCacheUpdate: [],
      optimizeKcfg: false,
      extensionToApply: stepResult(cterm),
    },
  ];
}

describe("advanceProof", () => {
  test("consumes a whole batch before refetching steps", async () => {
    const proof = twoNodeProof("batch");
    expect(proof.kcfg.splitOnConstraints(proof.init, twoConstraints())).toHaveLength(2);
    const sizes: number[] = [];
    traceGetSteps(proof, sizes);
    const prover = new RecordingProver((step) => [
      { kind: "terminal", nodeId: step.node.id, priorLoopsCacheUpdate: [], optimizeKcfg: false },
    ]);

    await advanceProof(prover, proof);
    expect(prover.initialized).toEqual(["batch"]);
    expect(prover.stepped).toHaveLength(2);
    // Both steps of the first batch ran before `getSteps` was called again; a
    // per-step refetch would have produced [2, 1, 0].
    expect(sizes).toEqual([2, 0]);
  });

  test("maxIterations caps committed steps and skips the failure report", async () => {
    const proof = twoNodeProof("cap");
    let index = 0;
    const prover = new RecordingProver((step) => {
      index += 1;
      return extendWith(term(`N${index}`))(step);
    });
    await advanceProof(prover, proof, { maxIterations: 3 });
    expect(prover.stepped).toHaveLength(3);
    expect(prover.failureInfoFor).toEqual([]);
  });

  test("failFast stops before the next step and attaches failure info", async () => {
    const proof = twoNodeProof("fail");
    expect(proof.kcfg.splitOnConstraints(proof.init, twoConstraints())).toHaveLength(2);
    const prover = new RecordingProver((step) => [
      {
        kind: "extend",
        nodeId: step.node.id,
        priorLoopsCacheUpdate: [],
        optimizeKcfg: false,
        extensionToApply: { kind: "stuck" },
      },
    ]);
    await advanceProof(prover, proof, { failFast: true });
    // The first step made a leaf stuck, so the second never ran.
    expect(prover.stepped).toHaveLength(1);
    expect(proof.failed).toBe(true);
    expect(prover.failureInfoFor).toEqual(["fail"]);
    expect(proof.failureInfo).toBeDefined();
  });

  test("without failFast a failing proof still finishes its batch", async () => {
    const proof = twoNodeProof("slow-fail");
    expect(proof.kcfg.splitOnConstraints(proof.init, twoConstraints())).toHaveLength(2);
    const prover = new RecordingProver((step) => [
      {
        kind: "extend",
        nodeId: step.node.id,
        priorLoopsCacheUpdate: [],
        optimizeKcfg: false,
        extensionToApply: { kind: "stuck" },
      },
    ]);
    await advanceProof(prover, proof);
    expect(prover.stepped).toHaveLength(2);
    expect(prover.failureInfoFor).toEqual(["slow-fail"]);
  });

  test("maintenance flushes to disk on the configured cadence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kframework-ts-proof-advance-"));
    try {
      const proof = twoNodeProof("flush");
      proof.proofDir = dir;
      const seen: number[] = [];
      let index = 0;
      const prover = new RecordingProver((step) => {
        index += 1;
        return extendWith(term(`N${index}`))(step);
      });
      await advanceProof(prover, proof, {
        maxIterations: 5,
        maintenanceRate: 2,
        callback: (advanced) => {
          seen.push(advanced.kcfg.nodes.length);
        },
      });
      // Five steps at a rate of two: maintenance at iterations 2 and 4.
      expect(seen).toEqual([4, 6]);
      expect(await proofDataExists(dir, "flush")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects a non-positive maintenance rate", async () => {
    const prover = new RecordingProver(() => []);
    const error = await caught(() => advanceProof(prover, twoNodeProof("rate"), { maintenanceRate: 0 }));
    expect(error).toBeInstanceOf(RangeError);
  });
});

//////////////////////////
// The step timeout     //
//////////////////////////

/**
 * A prover whose steps hang until the test releases them, so a budget can be
 * exceeded without waiting for one — the timeout is measured in milliseconds
 * here by giving `stepTimeout` a fractional value the driver multiplies by
 * 1000. (`APRProver` clamps its own to a whole second; `advanceProof` takes
 * whatever the prover carries.)
 */
class HangingProver implements Prover<APRProof, APRProofStep, APRProofResult> {
  readonly stepped: number[] = [];
  readonly interrupts: number[] = [];
  readonly shrinks: number[] = [];
  readonly unwound: number[] = [];
  closed = false;
  stepTimeout: number | undefined;
  /** How many timeouts to answer with a successful shrink before giving up. */
  shrinksLeft: number;
  /** Steps that must hang until interrupted — once each; every other step resolves at once. */
  readonly hang: ReadonlySet<number>;
  readonly #hung = new Set<number>();
  #release: (() => void) | undefined;

  constructor(options: { stepTimeout?: number; shrinksLeft?: number; hang?: Iterable<number> } = {}) {
    this.stepTimeout = options.stepTimeout;
    this.shrinksLeft = options.shrinksLeft ?? 0;
    this.hang = new Set(options.hang ?? []);
  }

  initProof(): Promise<void> {
    return Promise.resolve();
  }

  async stepProof(step: APRProofStep): Promise<readonly APRProofResult[]> {
    this.stepped.push(step.node.id);
    if (this.hang.has(step.node.id) && !this.#hung.has(step.node.id)) {
      this.#hung.add(step.node.id);
      // Resolves only when `interrupt` releases it, which is what a kore-rpc
      // client does when the server answers a cancelled request.
      await new Promise<void>((resolve) => {
        this.#release = resolve;
      });
      this.unwound.push(step.node.id);
      this.#release = undefined;
      throw new Error("interrupted");
    }
    return [{ kind: "terminal", nodeId: step.node.id, priorLoopsCacheUpdate: [], optimizeKcfg: false }];
  }

  interrupt(): void {
    this.interrupts.push(this.stepped.length);
    this.#release?.();
  }

  shrinkStep(): boolean {
    this.shrinks.push(this.stepped.length);
    if (this.shrinksLeft <= 0) return false;
    this.shrinksLeft -= 1;
    return true;
  }

  close(): void {
    this.closed = true;
  }
}

describe("advanceProof's step timeout", () => {
  test("no budget means no timer: a slow step is simply awaited", async () => {
    const proof = twoNodeProof("no-budget");
    const prover = new HangingProver();
    await advanceProof(prover, proof);
    expect(prover.stepped).toEqual([proof.init]);
    expect(prover.interrupts).toEqual([]);
    expect(prover.shrinks).toEqual([]);
  });

  test("a step over budget is interrupted, unwound, and only then shrunk", async () => {
    const proof = twoNodeProof("shrink");
    const prover = new HangingProver({ stepTimeout: 0.01, shrinksLeft: 1, hang: [proof.init] });
    const timeouts: { budget: number; shrunk: boolean }[] = [];

    await advanceProof(prover, proof, { onStepTimeout: (event) => void timeouts.push({ ...event }) });

    // The same node was retried after the shrink, and the second attempt ran to
    // completion because a node hangs only once.
    expect(prover.stepped).toEqual([proof.init, proof.init]);
    expect(timeouts).toEqual([{ budget: 0.01, shrunk: true }]);
    // Interrupt happened first, the step unwound, and `shrinkStep` was asked
    // afterwards — `wait([future])` before `shrink_step()` (`proof.py:566-568`).
    expect(prover.interrupts).toEqual([1]);
    expect(prover.unwound).toEqual([proof.init]);
    expect(prover.shrinks).toEqual([1]);
    // Nothing was committed for the abandoned step; the retry marked it terminal.
    expect(proof.isTerminal(proof.init)).toBe(true);
  });

  test("a step that cannot shrink stops the run without failure info", async () => {
    const proof = twoNodeProof("exhausted");
    expect(proof.kcfg.splitOnConstraints(proof.init, twoConstraints())).toHaveLength(2);
    const [first] = proof.getSteps();
    const prover = new HangingProver({ stepTimeout: 0.01, shrinksLeft: 0, hang: [first!.node.id] });
    const timeouts: { budget: number; shrunk: boolean }[] = [];

    await advanceProof(prover, proof, { onStepTimeout: (event) => void timeouts.push({ ...event }) });

    expect(timeouts).toEqual([{ budget: 0.01, shrunk: false }]);
    // The rest of the batch never ran, and the run returned rather than
    // refetching (`proof.py:620-624`).
    expect(prover.stepped).toEqual([first!.node.id]);
    expect(proof.failureInfo).toBeUndefined();
  });

  test("a step that finishes inside its budget is untouched", async () => {
    const proof = twoNodeProof("in-budget");
    const prover = new HangingProver({ stepTimeout: 30 });
    await advanceProof(prover, proof);
    expect(prover.stepped).toEqual([proof.init]);
    expect(prover.interrupts).toEqual([]);
    expect(prover.shrinks).toEqual([]);
  });

  test("a rejecting step still rejects when a budget is set", async () => {
    const proof = twoNodeProof("boom");
    const prover = new HangingProver({ stepTimeout: 30 });
    Object.defineProperty(prover, "stepProof", { value: () => Promise.reject(new Error("backend fell over")) });
    const error = await caught(() => advanceProof(prover, proof));
    expect(String(error)).toContain("backend fell over");
  });

  test("the budget is read once, so raising it mid-run does not enable the policy", async () => {
    const proof = twoNodeProof("late-budget");
    expect(proof.kcfg.splitOnConstraints(proof.init, twoConstraints())).toHaveLength(2);
    const prover = new HangingProver();
    const original = prover.stepProof.bind(prover);
    Object.defineProperty(prover, "stepProof", {
      value: (step: APRProofStep): Promise<readonly APRProofResult[]> => {
        prover.stepTimeout = 0.01;
        return original(step);
      },
    });
    await advanceProof(prover, proof);
    // `proof.py:597` builds the executor before the loop; a prover that starts
    // without a budget never acquires one.
    expect(prover.stepped).toHaveLength(2);
    expect(prover.interrupts).toEqual([]);
  });
});

//////////////////////////
// Shrink and interrupt //
//////////////////////////

describe("APRProver.shrinkStep and interrupt", () => {
  test("stepTimeout is clamped to at least one whole second", () => {
    const explore = new ScriptedExplore(new FakeSymbolic(), []);
    expect(new APRProver(explore, {}).stepTimeout).toBeUndefined();
    expect(new APRProver(explore, { stepTimeout: 0 }).stepTimeout).toBe(1);
    expect(new APRProver(explore, { stepTimeout: 0.5 }).stepTimeout).toBe(1);
    expect(new APRProver(explore, { stepTimeout: -7 }).stepTimeout).toBe(1);
    expect(new APRProver(explore, { stepTimeout: 90 }).stepTimeout).toBe(90);
  });

  test("shrinkStep halves the execution depth until it reaches one", () => {
    const prover = new APRProver(new ScriptedExplore(new FakeSymbolic(), []), { executeDepth: 5 });
    expect(prover.shrinkStep()).toBe(true);
    expect(prover.executeDepth).toBe(2);
    expect(prover.shrinkStep()).toBe(true);
    expect(prover.executeDepth).toBe(1);
    expect(prover.shrinkStep()).toBe(false);
    expect(prover.executeDepth).toBe(1);
  });

  test("an unset execution depth cannot be shrunk", () => {
    const prover = new APRProver(new ScriptedExplore(new FakeSymbolic(), []), {});
    expect(prover.shrinkStep()).toBe(false);
    expect(prover.executeDepth).toBeUndefined();
  });

  test("interrupt reaches the adapter through KCFGExplore", () => {
    const symbolic = new FakeSymbolic();
    const interrupts: number[] = [];
    Object.defineProperty(symbolic, "interrupt", { value: () => void interrupts.push(1) });
    new APRProver(new ScriptedExplore(symbolic, []), {}).interrupt();
    expect(interrupts).toEqual([1]);
  });
});

//////////////////////////
// Failure info         //
//////////////////////////

/** A legible stand-in for `PrettyPrinter`, so a report can be pinned exactly. */
function show(kast: KInner): string {
  switch (kast.node) {
    case "KApply":
      return kast.args.length === 0 ? kast.label.name : `${kast.label.name}(${kast.args.map(show).join(", ")})`;
    case "KVariable":
      return kast.name;
    case "KToken":
      return kast.token;
    case "KRewrite":
      return `${show(kast.lhs)} => ${show(kast.rhs)}`;
    case "KSequence":
      return kast.items.map(show).join(" ~> ");
    default:
      return kast.node;
  }
}

describe("aprFailureInfoFromProof", () => {
  test("composes the failing-cell block and the remaining implication", async () => {
    // What `CTermSymbolic.implies({ failureReason: true })` now computes
    // (`cterm/symbolic.py:330-359`); the rendering is `explore.py:101-130`.
    const symbolic = new FakeSymbolic({
      implies: [
        {
          // `failing_cells` values are cell *contents*, as rewrites
          // (`cterm/symbolic.py:341-358`): a mismatch, then a cell the
          // consequent does not have at all.
          failingCells: [
            ["K_CELL", krewrite(kapply("foo"), kapply("bar"))],
            ["STATE_CELL", krewrite(kapply("stateA"), ktoken(".K", "KItem"))],
          ],
          remainingImplication: kapply("#Implies", [kapply("lhs"), kapply("rhs")]),
        },
      ],
    });
    const explore = new KCFGExplore(symbolic, { prettyPrint: show });
    const proof = twoNodeProof("composed");
    proof.kcfg.addStuck(proof.init);

    const info = await aprFailureInfoFromProof(proof, explore);
    expect(info.failureReasons.get(proof.init)).toBe(
      [
        "Matching failed.",
        "The following cells failed matching individually (antecedent #Implies consequent):",
        "K_CELL: #Implies(foo, bar)",
        "STATE_CELL: #Implies(stateA, .K)",
        "The remaining implication is:",
        "#Implies(lhs, rhs)",
      ].join("\n"),
    );

    // …and the report indents every line of it by four spaces.
    expect(info.print()).toEqual([
      "1 Failure nodes. (0 pending and 1 failing)",
      "",
      "Failing nodes:",
      "",
      `  Node id: ${proof.init}`,
      "  Failure reason:",
      "    Matching failed.",
      "    The following cells failed matching individually (antecedent #Implies consequent):",
      "    K_CELL: #Implies(foo, bar)",
      "    STATE_CELL: #Implies(stateA, .K)",
      "    The remaining implication is:",
      "    #Implies(lhs, rhs)",
      "  Path condition:",
      "    #Top",
      "  Failed to generate a model.",
      "",
      "Join the Runtime Verification Discord server for support: https://discord.gg/CurfmXNtbN",
    ]);
  });

  test("reports failing nodes with reasons, conditions and a model", async () => {
    const symbolic = new FakeSymbolic({
      implies: [{}],
      model: { satisfiable: "Sat", model: new Subst({ X: kapply("one") }) },
    });
    const explore = new KCFGExplore(symbolic, { prettyPrint: (value) => value.node });
    const proof = twoNodeProof("failure");
    proof.kcfg.addStuck(proof.init);

    const info = await aprFailureInfoFromProof(proof, explore, { counterexampleInfo: true });
    expect(info.failingNodes).toEqual([proof.init]);
    expect(info.pendingNodes).toEqual([]);
    expect(info.failureReasons.get(proof.init)).toContain("Matching failed.");
    expect(info.pathConditions.get(proof.init)).toBeDefined();
    expect(info.models.get(proof.init)).toEqual([["X", "KApply"]]);
    // Two simplify calls per failing node — node and target — exactly as upstream.
    expect(symbolic.simplifyCalls).toHaveLength(2);
  });
});
