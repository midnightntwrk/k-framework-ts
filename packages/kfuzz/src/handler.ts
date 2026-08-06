/**
 * The integration seam — `KFuzzHandler` (`pyk/ktool/kfuzz.py:25-50`) at K
 * `v7.1.337`.
 *
 * Two callbacks, one per case and one per failure, and upstream's whole
 * rationale for them is the docstring's parenthesis: *"(ie. printing)"*.  A
 * fuzz run is otherwise a black box that either returns or throws; the handler
 * is where a consumer hangs progress reporting, corpus recording, or the
 * JSONL an agent-facing harness wants (C4 in
 * [`docs/gap-analysis.md`](../../../docs/gap-analysis.md)).
 *
 * # Deviations from pyk, both deliberate
 *
 * - **An interface, not an abstract base class.**  pyk's `KFuzzHandler` is an
 *   `ABC` with two `@abstractmethod`s, which buys a runtime error if a subclass
 *   forgets one.  TypeScript's structural typing gives that at compile time and
 *   costs nothing at runtime, so there is no class to extend — any object with
 *   the two methods is a handler.
 * - **The callbacks may be asynchronous.**  pyk's are `-> None`; here they may
 *   return a promise, which is awaited before the case proceeds (and, for
 *   `handleFailure`, before the failure is re-thrown).  A handler that writes
 *   a line of JSONL to a file has no synchronous spelling in Node, and a
 *   fire-and-forget write would interleave under concurrency and lose its last
 *   lines on exit.  Synchronous handlers are unaffected: a non-promise return
 *   is awaited in the same microtask.
 */

import type { KoreSubst } from "./subst.js";

/**
 * Custom behaviour per test case and on failure — pyk's `KFuzzHandler`.
 *
 * Pass one to {@link KFuzz}'s constructor or to `fuzz`'s `handler` option.
 */
export interface KFuzzHandler {
  /**
   * Called with the substitution about to be tested, before the interpreter
   * runs — `handle_test` (`:31-34`).
   */
  handleTest(subst: KoreSubst): void | Promise<void>;

  /**
   * Called when a case fails, before the error is re-thrown — `handle_failure`
   * (`:36-39`).
   *
   * Note that under shrinking (opt-in here, and off in pyk — see the README's
   * mapping table) this fires once per failing candidate, not once per run.
   */
  handleFailure(subst: KoreSubst): void | Promise<void>;
}

/**
 * The handler that does nothing — pyk's `_KFuzzNullHandler` / `_DEFAULT_HANDLER`
 * (`:42-50`).
 *
 * Exported, where upstream keeps it private: a consumer composing handlers
 * (say, "the caller's handler if they passed one") needs a name for the
 * identity element, and re-declaring an empty object at every call site is
 * worse than sharing this one.  It is frozen, because a shared singleton that
 * can be mutated is a shared singleton that will be.
 */
export const NULL_KFUZZ_HANDLER: KFuzzHandler = Object.freeze({
  handleTest(): void {},
  handleFailure(): void {},
});
