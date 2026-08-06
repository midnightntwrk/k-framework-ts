/**
 * `parallel_advance_proof` and `_ProverPool` (`proof/proof.py:324-479`) as an
 * async pool.
 *
 * The step protocol is what makes this possible at all: `getSteps()` is pure,
 * `stepProof()` is pure with respect to both the proof and the prover, and
 * `commit()` is the only mutator. Upstream turns that into a
 * `ThreadPoolExecutor` with **one `Prover` per worker thread**
 * (`_ProverPool._with_prover`, `proof.py:463-478`); here it is N in-flight
 * promises, because a step is JSON-RPC-bound rather than CPU-bound and one
 * event loop can hold as many sockets open as the backend will serve.
 *
 * # How the async pool maps onto `_ProverPool`
 *
 * | pyk                                       | here                                                          |
 * | ----------------------------------------- | ------------------------------------------------------------- |
 * | `ThreadPoolExecutor(max_workers)`         | {@link ProverPool}: `maxWorkers` slots plus a FIFO queue       |
 * | one prover per *thread*, made on first use | one prover per *slot*, made on that slot's first task          |
 * | `pool.submit(step) -> Future`             | `pool.submit(step) -> Promise`                                 |
 * | `wait(pending, FIRST_COMPLETED)`          | `Promise.race` over the in-flight map                          |
 * | `set[PS]` dedup on a frozen dataclass     | `Set<string>` over {@link ConcurrentAdvanceProofOptions.stepKey} |
 * | commit on the main thread                 | commit on the main loop between `await`s                       |
 * | `executor.__exit__` drains, then `close()` | {@link ProverPool.drain} then {@link ProverPool.close}          |
 *
 * **Commit serialization is free here and deliberate upstream.** Only the main
 * loop ever calls `proof.commit`, one result at a time, in first-completed
 * order; a step that was produced from a stale frontier is still valid because
 * `APRProofStep` copies everything it needs out of the proof.
 *
 * **Dedup needs an explicit key.** pyk relies on `APRProofStep` being a frozen
 * dataclass, so `step in explored` is structural equality with the loops cache
 * excluded (`field(compare=False)`, `reachability.py:86`). TypeScript has no
 * structural hashing, so the key function is a required option and
 * {@link aprProofStepKey} is the one to pass for an `APRProof` — it already
 * leaves the loops cache out.
 *
 * # Divergences
 *
 * - **No step timeout.** Neither has upstream's parallel driver: `step_timeout`
 *   is enforced only on the sequential path (`kevm_pyk/utils.py:145-153`).
 * - **A worker failure propagates after the pool has drained.** Upstream
 *   `future.result()` re-raises inside the `with` blocks, so the executor is
 *   still shut down and the provers still closed on the way out; the `finally`
 *   here does the same, which means an in-flight step is awaited rather than
 *   abandoned. There is no cancellation: a promise cannot be interrupted, and
 *   `Prover.interrupt` is not part of this seam yet.
 * - **Queued work drains too.** `ThreadPoolExecutor.shutdown` does not cancel
 *   queued jobs, so a `failFast` break still runs whatever was already
 *   submitted. Transcribed as-is rather than "improved", because the observable
 *   proof state — which steps ran — is what a resumed run sees.
 */

import type { Proof } from "./proof.js";
import { ProofError } from "./proof.js";
import type { Prover, SteppableProof } from "./prover.js";
import { writeProofData } from "./store.js";

/** Options for {@link concurrentAdvanceProof} (`proof.py:324-338`). */
export interface ConcurrentAdvanceProofOptions<P extends Proof, S, R> {
  /**
   * Makes one prover per pool slot, plus one for the main loop.
   *
   * "These provers must not reference any shared data to be written during
   * `parallel_advance_proof`" (`proof.py:346-347`) — in this monorepo that
   * means **one `KoreClient` per prover**, because `add-module` state is
   * per-session and a request id is labelled at client construction.
   */
  readonly createProver: () => Prover<P, S, R> | Promise<Prover<P, S, R>>;
  /**
   * A stable value key for a step, standing in for pyk's frozen-dataclass
   * hashing. Pass `aprProofStepKey` for an `APRProof`.
   */
  readonly stepKey: (step: S) => string;
  /** Slots, and therefore provers. Defaults to 1, as upstream. */
  readonly maxWorkers?: number;
  /** Stop after this many committed results. */
  readonly maxIterations?: number;
  /** Stop once the proof is failing, without waiting for the frontier to empty. */
  readonly failFast?: boolean;
  /** Iterations between a `writeProofData` plus the callback. Default 1. */
  readonly maintenanceRate?: number;
  /** Run at each maintenance point, for progress reporting. */
  readonly callback?: (proof: P) => void | Promise<void>;
}

/**
 * What one finished pool task hands back to the main loop.
 *
 * Tagged with `ok` rather than by testing `error` for `undefined`: a step that
 * rejected with `undefined` must still be a failure, the way `future.result()`
 * re-raises whatever it was handed.
 */
type TaskOutcome<R> =
  | { readonly id: number; readonly ok: true; readonly results: readonly R[] }
  | { readonly id: number; readonly ok: false; readonly error: unknown };

/**
 * `parallel_advance_proof` (`proof.py:324-397`).
 *
 * The loop, in upstream's order: submit the whole frontier, then repeatedly
 * take the **first completed** result, commit it, run maintenance on the
 * cadence, check the two stop conditions, and re-submit the new frontier.
 * Steps already submitted are never submitted again, so re-fetching after
 * every commit is cheap and keeps the pool fed.
 *
 * The proof is written once more at the end, and failure info comes from the
 * *main* prover — the one that ran `initProof` — not from a pool prover.
 */
export async function concurrentAdvanceProof<P extends Proof & SteppableProof<S, R>, S, R>(
  proof: P,
  options: ConcurrentAdvanceProofOptions<P, S, R>,
): Promise<void> {
  const maintenanceRate = options.maintenanceRate ?? 1;
  if (!Number.isSafeInteger(maintenanceRate) || maintenanceRate < 1) {
    throw new RangeError(`maintenanceRate must be a positive integer, got ${maintenanceRate}`);
  }
  const maxWorkers = options.maxWorkers ?? 1;
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1) {
    throw new RangeError(`maxWorkers must be a positive integer, got ${maxWorkers}`);
  }
  const { maxIterations, callback, stepKey } = options;
  const failFast = options.failFast ?? false;

  const mainProver = await options.createProver();
  const pool = new ProverPool<P, S, R>(options.createProver, maxWorkers);
  try {
    await mainProver.initProof(proof);

    const explored = new Set<string>();
    const inflight = new Map<number, Promise<TaskOutcome<R>>>();
    let nextTaskId = 0;
    let iterations = 0;

    const submitSteps = (steps: readonly S[]): void => {
      for (const step of steps) {
        const key = stepKey(step);
        if (explored.has(key)) continue;
        explored.add(key);
        const id = nextTaskId;
        nextTaskId += 1;
        // Both branches are handled at submission time, so an abandoned task
        // can never surface as an unhandled rejection.
        inflight.set(
          id,
          pool.submit(step).then(
            (results): TaskOutcome<R> => ({ id, ok: true, results }),
            (error: unknown): TaskOutcome<R> => ({ id, ok: false, error }),
          ),
        );
      }
    };

    submitSteps(proof.getSteps());

    for (;;) {
      if (inflight.size === 0) break;
      const outcome = await Promise.race(inflight.values());
      inflight.delete(outcome.id);
      if (!outcome.ok) throw outcome.error;
      for (const result of outcome.results) proof.commit(result);
      iterations += 1;
      if (iterations % maintenanceRate === 0) {
        await writeProofData(proof);
        await callback?.(proof);
      }
      if (maxIterations !== undefined && maxIterations <= iterations) break;
      if (failFast && proof.failed) break;
      submitSteps(proof.getSteps());
    }

    if (proof.failed) {
      const failureInfo = mainProver.failureInfo?.bind(mainProver);
      if (failureInfo !== undefined) proof.failureInfo = await failureInfo(proof);
    }
    await writeProofData(proof);
  } finally {
    // `_ProverPool.__exit__` shuts the executor down waiting, *then* closes
    // every prover it made (`proof.py:428-437`); the main prover's own `with`
    // closes it last.
    await pool.drain();
    pool.close();
    mainProver.close();
  }
}

/** One unit of queued work: the step and the promise settlement it owns. */
interface PoolJob<S, R> {
  readonly step: S;
  readonly resolve: (results: readonly R[]) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * `_ProverPool` (`proof.py:400-479`) — `maxWorkers` slots, one prover each.
 *
 * A slot's prover is created on that slot's **first** task and reused for
 * every later one, which is precisely what `_with_prover`'s
 * `self._provers.get(thread_name)` does with threads. Slots that never receive
 * a task never create a prover, so a pool sized above the frontier costs
 * nothing.
 *
 * Exported for tests and for a caller building its own driver; the driver above
 * is the supported way to use it.
 */
export class ProverPool<P extends Proof, S, R> {
  readonly #createProver: () => Prover<P, S, R> | Promise<Prover<P, S, R>>;
  readonly #maxWorkers: number;
  readonly #provers: (Prover<P, S, R> | undefined)[];
  readonly #freeSlots: number[];
  readonly #queue: PoolJob<S, R>[] = [];
  readonly #running = new Set<Promise<void>>();
  #closed = false;

  constructor(createProver: () => Prover<P, S, R> | Promise<Prover<P, S, R>>, maxWorkers: number) {
    this.#createProver = createProver;
    this.#maxWorkers = maxWorkers;
    this.#provers = Array.from({ length: maxWorkers }, () => undefined);
    // Descending, so `pop()` hands out slot 0 first and a pool that is never
    // saturated only ever builds one prover.
    this.#freeSlots = Array.from({ length: maxWorkers }, (_, index) => maxWorkers - 1 - index);
  }

  /** How many provers have actually been constructed. */
  get proverCount(): number {
    return this.#provers.filter((prover) => prover !== undefined).length;
  }

  /** Slots, i.e. the ceiling on concurrent `stepProof` calls. */
  get maxWorkers(): number {
    return this.#maxWorkers;
  }

  /** `_ProverPool.submit` (`proof.py:439-442`) — queued when every slot is busy. */
  submit(step: S): Promise<readonly R[]> {
    if (this.#closed) throw new ProofError("ProverPool has been closed");
    return new Promise<readonly R[]>((resolve, reject) => {
      const job: PoolJob<S, R> = { step, resolve, reject };
      const slot = this.#freeSlots.pop();
      if (slot === undefined) this.#queue.push(job);
      else this.#start(slot, job);
    });
  }

  /** Wait for every started and queued task to settle — `Executor.__exit__`'s `wait=True`. */
  async drain(): Promise<void> {
    while (this.#running.size > 0) await Promise.all(this.#running);
  }

  /** `_ProverPool.close` (`proof.py:432-435`) — close every prover this pool made. */
  close(): void {
    this.#closed = true;
    for (const prover of this.#provers) prover?.close();
  }

  #start(slot: number, job: PoolJob<S, R>): void {
    const run = (async (): Promise<void> => {
      try {
        let prover = this.#provers[slot];
        if (prover === undefined) {
          prover = await this.#createProver();
          this.#provers[slot] = prover;
        }
        job.resolve(await prover.stepProof(job.step));
      } catch (error) {
        job.reject(error);
      } finally {
        // Hand the slot to the next queued job immediately, exactly as a worker
        // thread picks up the next item rather than waiting to be re-scheduled.
        const next = this.#queue.shift();
        if (next === undefined) this.#freeSlots.push(slot);
        else this.#start(slot, next);
      }
    })();
    this.#running.add(run);
    void run.finally(() => {
      this.#running.delete(run);
    });
  }
}
