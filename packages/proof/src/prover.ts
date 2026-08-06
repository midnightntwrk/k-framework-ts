/**
 * The `Prover` seam and the serial driver (`proof/proof.py:482-639`).
 *
 * This module is part of the Node-only `@kframework-ts/proof/prove` entry
 * point, because {@link advanceProof}'s maintenance flush writes the proof
 * directory and therefore reaches `@kframework-ts/proof/store`. The
 * browser-safe main entry point stays free of it.
 *
 * # Divergences from pyk
 *
 * - **No generic `Proof`/`Prover` class hierarchy.** Nothing downstream
 *   subclasses either; the generics upstream exist only so
 *   `parallel_advance_proof` can be written once. Here {@link Prover} is a
 *   plain interface and {@link advanceProof} is a free function.
 * - **`failureInfo` is optional.** Upstream declares it abstract and
 *   `ImpliesProver` returns a bare marker; an optional method says the same
 *   thing without inventing a value.
 * - **`stepTimeout`, `shrinkStep` and `interrupt` are optional members**, not
 *   a base class with defaults (`proof.py:522-547`). A prover that sets none
 *   of them behaves exactly as `Prover`'s defaults do: no budget, no shrink,
 *   no interrupt.
 * - **`_StepShrunk`/`_StepExhausted` do not escape.** Upstream's two private
 *   exceptions (`proof.py:464-479`) carry a timed-out step back to
 *   `advance_proof`, which logs a warning and either retries or stops. There is
 *   no logger in this package, so the same two facts are reported through
 *   {@link AdvanceProofOptions.onStepTimeout} and the control flow is
 *   otherwise identical.
 *
 * # The one real design question, and the answer taken
 *
 * "Abandon an in-flight promise" is not what upstream does either, which is
 * what makes this portable: `_execute_step` (`proof.py:549-568`) interrupts the
 * step and then **waits for it to unwind** (`wait([future])`) before the prover
 * is reused. A `Promise` cannot be cancelled, but it can be raced against a
 * timer, and the settlement can still be awaited afterwards — so the sequence
 * here is race, {@link Prover.interrupt}, await the original promise, then
 * {@link Prover.shrinkStep}. `KCFGExplore.interrupt` reaches
 * `KoreClient.interrupt`, which is the interruptible resource upstream's
 * docstring names.
 */

import type { FailureInfo, Proof } from "./proof.js";
import { writeProofData } from "./store.js";

/** A proof that participates in the step protocol; `APRProof` is the only one so far. */
export interface SteppableProof<S, R> {
  /** Pure and repeatable; an empty list means the proof cannot progress. */
  getSteps(): readonly S[];
  /** The only mutator. */
  commit(result: R): void;
}

/**
 * `Prover` (`proof.py:482-546`).
 *
 * `stepProof` must not modify the proof or the prover, which is what lets a
 * concurrent driver run several of them against one proof.
 */
export interface Prover<P extends Proof, S, R> {
  /** Any one-time setup: module injection, terminal marking of `init`/`target`. */
  initProof(proof: P): Promise<void>;
  /** Do the work of one step. Pure with respect to the proof and to `this`. */
  stepProof(step: S): Promise<readonly R[]>;
  /** Release the backend resources this prover owns. */
  close(): void;
  /** Explain a failed proof; omitted when the prover has nothing to add. */
  failureInfo?(proof: P): Promise<FailureInfo>;
  /**
   * `Prover.step_timeout` (`proof.py:522-527`) — the per-step wall-clock budget
   * in **whole seconds**, minimum 1. Absent or `undefined` disables the policy
   * entirely, so steps run with no time limit.
   *
   * {@link advanceProof} reads it **once**, before the loop, exactly as
   * upstream decides there whether to build an executor at all
   * (`proof.py:597`): a prover that starts without a budget never acquires one
   * mid-run.
   *
   * A prover that can do less work per step should pair this with
   * {@link Prover.shrinkStep}; one backed by an interruptible resource should
   * also implement {@link Prover.interrupt}, or a timed-out step keeps running
   * until the backend answers on its own.
   */
  readonly stepTimeout?: number | undefined;
  /**
   * `Prover.shrink_step` (`proof.py:529-536`) — make one step do less work
   * after a timeout.
   *
   * `true` means a smaller step is ready and the driver should retry; `false`
   * (also the behaviour when the method is absent) means the step is already
   * minimal and the run stops.
   */
  shrinkStep?(): boolean;
  /**
   * `Prover.interrupt` (`proof.py:538-547`) — abort the `stepProof` currently
   * in flight, as quickly as possible.
   *
   * Called only by the timeout policy, and the prover must stay usable
   * afterwards. `APRProver` forwards to `KCFGExplore.interrupt`, i.e. to the
   * kore-rpc client's cancel request.
   */
  interrupt?(): void;
}

/** Options for {@link advanceProof} (`proof.py:570-583`). */
export interface AdvanceProofOptions<P> {
  /** Stop after this many committed steps. */
  readonly maxIterations?: number;
  /** Stop as soon as the proof is failing, even with steps left in the batch. */
  readonly failFast?: boolean;
  /** Iterations between maintenance — a `writeProofData` plus the callback. Default 1. */
  readonly maintenanceRate?: number;
  /** Run at each maintenance point, for progress reporting. */
  readonly callback?: (proof: P) => void | Promise<void>;
  /**
   * Called when a step exhausts {@link Prover.stepTimeout}, in place of
   * upstream's two `_LOGGER.warning` lines (`proof.py:614-623`).
   *
   * `shrunk` is what {@link Prover.shrinkStep} answered, and therefore says
   * which of the two upstream exceptions this was: `true` is `_StepShrunk` —
   * steps are refetched and the smaller step retried — and `false` is
   * `_StepExhausted`, after which {@link advanceProof} returns without
   * attaching failure info.
   */
  readonly onStepTimeout?: (event: StepTimeoutEvent) => void;
}

/** What {@link AdvanceProofOptions.onStepTimeout} is told about a timed-out step. */
export interface StepTimeoutEvent {
  /** The budget in seconds that was exceeded — `Prover.stepTimeout`. */
  readonly budget: number;
  /** `true` when {@link Prover.shrinkStep} made the step smaller, so it is retried. */
  readonly shrunk: boolean;
}

/**
 * `_StepShrunk`/`_StepExhausted` (`proof.py:464-479`), collapsed into one.
 *
 * Upstream's pair are private and never escape `advance_proof`; neither does
 * this, which is why it stays unexported. The two are distinguished by
 * {@link StepTimeoutEvent.shrunk} rather than by class, because a caller cannot
 * observe either and an `instanceof` on a thing that cannot escape is noise.
 */
class StepTimedOut extends Error {
  override readonly name = "StepTimedOut";
  readonly event: StepTimeoutEvent;

  constructor(event: StepTimeoutEvent) {
    super(`Step exceeded its ${event.budget}s budget`);
    this.event = event;
  }
}

/** How a raced `stepProof` settled, so the timer branch is distinguishable from a rejection. */
type StepSettlement<R> =
  | { readonly ok: true; readonly results: readonly R[] }
  | { readonly ok: false; readonly error: unknown };

/**
 * `Prover._execute_step` (`proof.py:549-568`).
 *
 * With no budget the step is simply awaited. With one, the step is raced
 * against a timer; on expiry the prover is interrupted, the **original promise
 * is still awaited** so the step unwinds before the prover is reused
 * (upstream's `wait([future])`), and only then is `shrinkStep` consulted.
 *
 * The settlement is mapped to a value before the race, so a step that rejects
 * after the timer already won cannot surface as an unhandled rejection.
 */
async function executeStep<P extends Proof, S, R>(
  prover: Prover<P, S, R>,
  step: S,
  budget: number | undefined,
): Promise<readonly R[]> {
  if (budget === undefined) return prover.stepProof(step);

  const settled: Promise<StepSettlement<R>> = prover.stepProof(step).then(
    (results): StepSettlement<R> => ({ ok: true, results }),
    (error: unknown): StepSettlement<R> => ({ ok: false, error }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = Symbol("expired");
  const timeout = new Promise<typeof expired>((resolve) => {
    timer = setTimeout(() => resolve(expired), budget * 1000);
    // A pending budget must not be the reason a process stays alive; the step
    // it guards is what keeps the loop running.
    (timer as { unref?: () => void }).unref?.();
  });

  let outcome: StepSettlement<R> | typeof expired;
  try {
    outcome = await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }

  if (outcome !== expired) {
    if (!outcome.ok) throw outcome.error;
    return outcome.results;
  }

  prover.interrupt?.();
  await settled; // let the interrupted step unwind before we reuse the prover
  throw new StepTimedOut({ budget, shrunk: prover.shrinkStep?.() ?? false });
}

/**
 * `Prover.advance_proof` (`proof.py:570-639`) — the serial driver.
 *
 * The loop is `getSteps()` → `stepProof()` → `commit()`, and the ordering
 * detail that matters is that the **whole batch of steps is consumed before
 * steps are refetched**: nodes created by a commit enter the *next* outer
 * iteration, not the current batch. `failFast` is checked before each step
 * rather than after, so a proof that starts out failing takes no steps at all.
 *
 * `maintenanceRate` is what makes a killed run resumable: at most that many
 * committed steps are lost.
 *
 * When the prover carries a {@link Prover.stepTimeout}, each step runs under
 * that budget (see {@link executeStep}). A step that times out and **shrinks**
 * abandons the rest of its batch and refetches — so the same node is retried
 * with less work — and one that cannot shrink stops the run. A timed-out step
 * counts for nothing: `iterations` is not incremented and nothing is committed.
 */
export async function advanceProof<P extends Proof & SteppableProof<S, R>, S, R>(
  prover: Prover<P, S, R>,
  proof: P,
  options: AdvanceProofOptions<P> = {},
): Promise<void> {
  const maintenanceRate = options.maintenanceRate ?? 1;
  if (!Number.isSafeInteger(maintenanceRate) || maintenanceRate < 1) {
    throw new RangeError(`maintenanceRate must be a positive integer, got ${maintenanceRate}`);
  }
  const maxIterations = options.maxIterations;
  const failFast = options.failFast ?? false;
  const callback = options.callback;
  const onStepTimeout = options.onStepTimeout;
  // Read once, as `proof.py:597` decides once whether to build an executor.
  const stepTimeout = prover.stepTimeout;

  let iterations = 0;
  await prover.initProof(proof);

  for (;;) {
    const steps = proof.getSteps();
    if (steps.length === 0) break;
    for (const step of steps) {
      if (failFast && proof.failed) {
        await attachFailureInfo(prover, proof);
        return;
      }
      // Upstream `return`s here rather than breaking (`proof.py:610-611`), so
      // hitting the iteration cap does **not** attach failure info even to a
      // proof that is already failing. Transcribed as written.
      if (maxIterations !== undefined && maxIterations <= iterations) return;
      let results: readonly R[];
      try {
        results = await executeStep(prover, step, stepTimeout);
      } catch (error) {
        if (!(error instanceof StepTimedOut)) throw error;
        onStepTimeout?.(error.event);
        // `_StepShrunk` breaks out of the batch so steps are refetched and the
        // same node retried, now smaller; `_StepExhausted` returns, without
        // failure info, exactly as the iteration cap does (`proof.py:614-624`).
        if (!error.event.shrunk) return;
        break;
      }
      iterations += 1;
      for (const result of results) proof.commit(result);
      if (iterations % maintenanceRate === 0) {
        await writeProofData(proof);
        await callback?.(proof);
      }
    }
    // Upstream tracks `shrank_step` and `continue`s on it (`proof.py:604`,
    // `:631-632`); that `continue` is the last statement of the `while` body,
    // so it is a no-op and the flag is dead. The `break` above is the whole
    // effect, and it is transcribed.
  }

  if (proof.failed) await attachFailureInfo(prover, proof);
}

async function attachFailureInfo<P extends Proof, S, R>(prover: Prover<P, S, R>, proof: P): Promise<void> {
  const failureInfo = prover.failureInfo?.bind(prover);
  if (failureInfo === undefined) return;
  proof.failureInfo = await failureInfo(proof);
}
