/**
 * `concurrentAdvanceProof` and its pool, driven by a fake prover.
 *
 * The driver is generic over the step protocol, so most of these rows use a
 * synthetic proof whose steps are strings and whose prover hands back control
 * to the test through explicit gates: that is what makes "two steps really were
 * in flight at once" an assertion rather than a hope. The last row runs a real
 * `APRProof` through it with `aprProofStepKey`, which is the wiring the façade
 * uses.
 */

import { KCFG } from "@kframework-ts/kcfg";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { APRProof, aprProofStepKey, ProofStatus, type APRProofResult, type APRProofStep } from "../src/index.ts";
import { concurrentAdvanceProof, ProverPool, type Prover } from "../src/prove.ts";
import { Proof, type FailureInfo } from "../src/proof.ts";
import { proofDataExists } from "../src/store.ts";
import { caught } from "./support.ts";
import { node, nodeDicts } from "./helpers.ts";

//////////////////////////
// A synthetic proof    //
//////////////////////////

/** A committed step, and the steps it makes available next. */
interface FakeResult {
  readonly step: string;
  readonly children: readonly string[];
}

/**
 * The smallest thing that satisfies the step protocol: a set of outstanding
 * step names, `commit` removing one and adding its children.
 *
 * `getSteps` returns the outstanding set *including* names already handed out,
 * exactly as `APRProof.getSteps()` re-offers a pending node until something
 * commits about it — which is what makes the driver's dedup load-bearing.
 */
class FakeProof extends Proof {
  outstanding: string[];
  readonly committed: string[] = [];
  /** Set by a committed step named `fail`, so `proof.failed` can flip mid-run. */
  broken = false;
  /** When set, `commit` records the step but leaves the frontier alone. */
  readonly frozenFrontier: boolean;

  constructor(
    steps: readonly string[],
    options: { readonly proofDir?: string; readonly frozenFrontier?: boolean } = {},
  ) {
    super("fake-proof", options.proofDir === undefined ? {} : { proofDir: options.proofDir });
    this.outstanding = [...steps];
    this.frozenFrontier = options.frozenFrontier ?? false;
  }

  override get proofType(): string {
    return "FakeProof";
  }

  override get ownStatus(): ProofStatus {
    if (this.broken) return ProofStatus.FAILED;
    return this.outstanding.length === 0 ? ProofStatus.PASSED : ProofStatus.PENDING;
  }

  override get canProgress(): boolean {
    return this.outstanding.length > 0;
  }

  override get dict(): Readonly<Record<string, unknown>> {
    return { id: this.id, type: this.proofType };
  }

  getSteps(): readonly string[] {
    return [...this.outstanding];
  }

  commit(result: FakeResult): void {
    this.committed.push(result.step);
    if (this.frozenFrontier) return;
    this.outstanding = this.outstanding.filter((step) => step !== result.step);
    this.outstanding.push(...result.children);
    if (result.step === "fail") this.broken = true;
  }
}

/** A promise the test settles by hand. */
interface Gate {
  readonly promise: Promise<void>;
  release(): void;
}

/** The no-op a gate's `release` starts as, hoisted so it is made once. */
function noop(): void {
  // Replaced synchronously by the promise executor below.
}

function gate(): Gate {
  let release: () => void = noop;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

interface FakeProverScript {
  /** Steps whose `stepProof` blocks until the matching gate is released. */
  readonly gates?: ReadonlyMap<string, Gate>;
  /** Steps a committed result should make available next. */
  readonly children?: ReadonlyMap<string, readonly string[]>;
  /** Steps whose `stepProof` throws. */
  readonly throwsOn?: ReadonlySet<string>;
}

/** Shared bookkeeping across every prover a pool creates. */
class ProverLedger {
  readonly created: FakeProver[] = [];
  readonly steps: string[] = [];
  inFlight = 0;
  peakInFlight = 0;
  closes = 0;
  initProofs = 0;
}

class FakeProver implements Prover<FakeProof, string, FakeResult> {
  constructor(
    readonly ledger: ProverLedger,
    readonly script: FakeProverScript,
  ) {
    ledger.created.push(this);
  }

  initProof(_proof: FakeProof): Promise<void> {
    this.ledger.initProofs += 1;
    return Promise.resolve();
  }

  async stepProof(step: string): Promise<readonly FakeResult[]> {
    this.ledger.steps.push(step);
    this.ledger.inFlight += 1;
    this.ledger.peakInFlight = Math.max(this.ledger.peakInFlight, this.ledger.inFlight);
    try {
      await this.script.gates?.get(step)?.promise;
      if (this.script.throwsOn?.has(step) === true) throw new Error(`step ${step} exploded`);
      return [{ step, children: this.script.children?.get(step) ?? [] }];
    } finally {
      this.ledger.inFlight -= 1;
    }
  }

  close(): void {
    this.ledger.closes += 1;
  }

  failureInfo(_proof: FakeProof): Promise<FailureInfo> {
    return Promise.resolve({ print: () => ["fake failure info"] });
  }
}

/** Numeric sort, since `toSorted` compares as strings by default. */
function ascending(left: number, right: number): number {
  return left - right;
}

/** Let every already-scheduled microtask and timer callback run. */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, 0);
  });
}

function ledgerFor(script: FakeProverScript = {}): { ledger: ProverLedger; createProver: () => FakeProver } {
  const ledger = new ProverLedger();
  return { ledger, createProver: () => new FakeProver(ledger, script) };
}

//////////////////////////
// The rows             //
//////////////////////////

describe("concurrentAdvanceProof", () => {
  test("runs maxWorkers steps at once and never more", async () => {
    const gates = new Map([
      ["a", gate()],
      ["b", gate()],
      ["c", gate()],
      ["d", gate()],
    ]);
    const { ledger, createProver } = ledgerFor({ gates });
    const proof = new FakeProof(["a", "b", "c", "d"]);

    const advancing = concurrentAdvanceProof(proof, { createProver, stepKey: (step) => step, maxWorkers: 2 });
    await tick();

    // Two slots busy, two steps queued behind them — `ThreadPoolExecutor`'s
    // shape, not "submit everything and hope".
    expect(ledger.inFlight).toBe(2);
    expect(ledger.steps).toEqual(["a", "b"]);

    for (const [, opened] of gates) opened.release();
    await advancing;

    expect(ledger.peakInFlight).toBe(2);
    expect(proof.committed.toSorted()).toEqual(["a", "b", "c", "d"]);
  });

  test("a single worker never overlaps, so the whole run is serial", async () => {
    const gates = new Map([
      ["a", gate()],
      ["b", gate()],
    ]);
    const { ledger, createProver } = ledgerFor({ gates });
    const proof = new FakeProof(["a", "b"]);

    const advancing = concurrentAdvanceProof(proof, { createProver, stepKey: (step) => step, maxWorkers: 1 });
    await tick();
    expect(ledger.steps).toEqual(["a"]);

    for (const [, opened] of gates) opened.release();
    await advancing;
    expect(ledger.peakInFlight).toBe(1);
  });

  test("a step is never run twice, however often getSteps re-offers it", async () => {
    // Nothing is ever removed from the frontier until its own result commits,
    // and `getSteps` is re-read after every commit — so without dedup the
    // second read would re-submit the step still in flight.
    const { ledger, createProver } = ledgerFor({ children: new Map([["a", ["b"]]]) });
    const proof = new FakeProof(["a"]);

    await concurrentAdvanceProof(proof, { createProver, stepKey: (step) => step, maxWorkers: 4 });

    expect(ledger.steps).toEqual(["a", "b"]);
    expect(proof.committed).toEqual(["a", "b"]);
  });

  test("terminates deterministically when the frontier stops shrinking", async () => {
    // `getSteps` keeps returning both names forever; the driver stops because
    // every step it can see has already been explored.
    const { ledger, createProver } = ledgerFor();
    const proof = new FakeProof(["x", "y"], { frozenFrontier: true });

    await concurrentAdvanceProof(proof, { createProver, stepKey: (step) => step, maxWorkers: 2 });
    expect(ledger.steps.toSorted()).toEqual(["x", "y"]);
  });

  test("failFast stops committing as soon as the proof is failing", async () => {
    const gates = new Map([
      ["fail", gate()],
      ["slow", gate()],
    ]);
    const { createProver } = ledgerFor({ gates });
    const proof = new FakeProof(["fail", "slow", "queued"]);

    const advancing = concurrentAdvanceProof(proof, {
      createProver,
      stepKey: (step) => step,
      maxWorkers: 2,
      failFast: true,
    });
    await tick();
    // `fail` finishes first, mid-flight for `slow`.
    gates.get("fail")?.release();
    await tick();
    gates.get("slow")?.release();
    await advancing;

    expect(proof.committed).toEqual(["fail"]);
    expect(proof.failed).toBe(true);
    // The main prover's failure info is attached, as it is on the serial path.
    expect(proof.failureInfo?.print()).toEqual(["fake failure info"]);
  });

  test("maxIterations counts committed results, not submitted steps", async () => {
    const { createProver } = ledgerFor();
    const proof = new FakeProof(["a", "b", "c", "d"]);
    await concurrentAdvanceProof(proof, {
      createProver,
      stepKey: (step) => step,
      maxWorkers: 4,
      maxIterations: 2,
    });
    expect(proof.committed).toHaveLength(2);
  });

  test("maintenance runs on the cadence, not on every commit", async () => {
    const { createProver } = ledgerFor();
    const proof = new FakeProof(["a", "b", "c", "d"]);
    const seen: number[] = [];
    await concurrentAdvanceProof(proof, {
      createProver,
      stepKey: (step) => step,
      maxWorkers: 1,
      maintenanceRate: 2,
      callback: (advanced) => {
        seen.push(advanced.committed.length);
      },
    });
    expect(seen).toEqual([2, 4]);
  });

  test("one prover per slot plus one for the main loop, all closed", async () => {
    const gates = new Map([
      ["a", gate()],
      ["b", gate()],
      ["c", gate()],
    ]);
    const { ledger, createProver } = ledgerFor({ gates });
    const proof = new FakeProof(["a", "b", "c"]);

    const advancing = concurrentAdvanceProof(proof, { createProver, stepKey: (step) => step, maxWorkers: 2 });
    await tick();
    for (const [, opened] of gates) opened.release();
    await advancing;

    // main + slot 0 + slot 1; `initProof` runs exactly once, on the main one.
    expect(ledger.created).toHaveLength(3);
    expect(ledger.initProofs).toBe(1);
    expect(ledger.closes).toBe(3);
  });

  test("a slot that never receives a task never builds a prover", async () => {
    const { ledger, createProver } = ledgerFor();
    const proof = new FakeProof(["only"]);
    await concurrentAdvanceProof(proof, { createProver, stepKey: (step) => step, maxWorkers: 8 });
    // The main prover and exactly one slot prover.
    expect(ledger.created).toHaveLength(2);
    expect(ledger.closes).toBe(2);
  });

  test("a failing step propagates, and the provers are still closed", async () => {
    const { ledger, createProver } = ledgerFor({ throwsOn: new Set(["boom"]) });
    const proof = new FakeProof(["boom"]);
    const error = await caught(() =>
      concurrentAdvanceProof(proof, { createProver, stepKey: (step) => step, maxWorkers: 1 }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("step boom exploded");
    expect(ledger.closes).toBe(2);
  });

  test("rejects a maxWorkers or maintenanceRate that is not a positive integer", async () => {
    const { createProver } = ledgerFor();
    const proof = new FakeProof(["a"]);
    const badWorkers = await caught(() =>
      concurrentAdvanceProof(proof, { createProver, stepKey: (step) => step, maxWorkers: 0 }),
    );
    expect(badWorkers).toBeInstanceOf(RangeError);
    const badRate = await caught(() =>
      concurrentAdvanceProof(proof, { createProver, stepKey: (step) => step, maintenanceRate: 0 }),
    );
    expect(badRate).toBeInstanceOf(RangeError);
  });

  test("drives a real APRProof through aprProofStepKey and writes it out", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kframework-ts-parallel-"));
    try {
      // Nodes 1 and 2 are pending leaves; 3 is the target.
      const kcfg = KCFG.fromDict({ nodes: nodeDicts(3) });
      const proof = new APRProof("concurrent-apr", kcfg, [], node(1).id, node(3).id, new Map(), {
        proofDir: directory,
      });
      const stepped: number[] = [];

      const prover: Prover<APRProof, APRProofStep, APRProofResult> = {
        initProof: () => Promise.resolve(),
        stepProof: (step) => {
          stepped.push(step.node.id);
          return Promise.resolve([
            { kind: "terminal", nodeId: step.node.id, priorLoopsCacheUpdate: [], optimizeKcfg: false },
          ]);
        },
        close: () => undefined,
      };

      await concurrentAdvanceProof(proof, {
        createProver: () => prover,
        stepKey: aprProofStepKey,
        maxWorkers: 2,
      });

      expect(stepped.toSorted(ascending)).toEqual([1, 2]);
      expect([...proof.terminalIds].toSorted(ascending)).toEqual([1, 2]);
      expect(await proofDataExists(directory, proof.id)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("ProverPool", () => {
  test("refuses work once closed, as _ProverPool does", () => {
    const { createProver } = ledgerFor();
    const pool = new ProverPool<FakeProof, string, FakeResult>(createProver, 1);
    pool.close();
    expect(() => pool.submit("a")).toThrow("ProverPool has been closed");
  });

  test("reuses one prover per slot across many steps", async () => {
    const { ledger, createProver } = ledgerFor();
    const pool = new ProverPool<FakeProof, string, FakeResult>(createProver, 2);
    await Promise.all([pool.submit("a"), pool.submit("b"), pool.submit("c"), pool.submit("d")]);
    await pool.drain();
    pool.close();
    expect(pool.proverCount).toBe(2);
    expect(ledger.steps).toHaveLength(4);
    expect(ledger.closes).toBe(2);
  });
});
