/**
 * Property fuzzing over a K semantics — `fuzz` and `KFuzz`
 * (`pyk/ktool/kfuzz.py:53-109,138-206`) at K `v7.1.337`, with `fast-check`
 * where upstream has `hypothesis`.
 *
 * The loop is four steps and has not changed shape in the port:
 *
 * 1. generate a substitution — one concrete pattern per declared variable;
 * 2. push it into the template (`subst_func`, `:186`);
 * 3. run the **LLVM interpreter** over the result (`llvm_interpret_raw`,
 *    `:187`) — a native binary, no JVM and no `kore-rpc` server in the loop;
 * 4. grade the run, either by parsing its KORE output and handing it to a
 *    check function, or by looking at its exit status (`:189-195`).
 *
 * Everything interesting is in how steps 1 and the surrounding runner map onto
 * a different property-testing library.  The full table is in `README.md`; the
 * three rows that change *behaviour* rather than spelling are repeated here,
 * because a reader of this file needs them:
 *
 * - **Shrinking is off by default**, because it is off upstream.  pyk sets
 *   `phases = (explicit, reuse, generate)` (`:204`) — a list that omits
 *   `Phase.shrink` — so hypothesis reports the first failing case as found.
 *   {@link FuzzRunParameters.shrink} turns fast-check's shrinker back on, and
 *   is worth turning on: each shrink step is one more interpreter spawn, which
 *   is the cost upstream declined to pay, but a minimal counterexample is worth
 *   several seconds.
 * - **There is no example database.**  hypothesis' `Phase.reuse` replays
 *   failures from `.hypothesis/`; fast-check has no such store, and the
 *   equivalent is explicit — {@link FuzzRunParameters.seed} plus
 *   {@link FuzzRunParameters.path}, both of which every failure reports.  That
 *   is the better trade for this repo anyway: a replay instruction that lives
 *   in the failure text can go in an issue, and a directory of pickles cannot.
 * - **A failure is a typed error, not a bare `AssertionError`.**
 *   {@link KFuzzError} carries the counterexample, the seed, the replay path
 *   and the underlying error as `cause`.  pyk re-raises hypothesis'
 *   `AssertionError` and leaves the caller to scrape the message.
 *
 * # Determinism
 *
 * `seed` is fast-check's, and defaults to fast-check's default — `Date.now()`.
 * It is **not** pinned to a constant here: a fuzzer that explores the same 100
 * inputs on every run is a slow unit test.  What this package guarantees
 * instead is that the seed is always *reported* — {@link FuzzReport.seed} on
 * success, {@link KFuzzError.seed} on failure — so any run is replayable
 * exactly, which is the property C4 in
 * [`docs/gap-analysis.md`](../../../docs/gap-analysis.md) actually needs.  Pin
 * `seed` explicitly for a byte-identical corpus.
 */

import { KoreParser, koreText, type EVar, type Pattern } from "@kframework-ts/kore";
import { llvmInterpretRaw, type LlvmInterpretOptions } from "@kframework-ts/ktool";
import * as fc from "fast-check";
import type { Arbitrary } from "fast-check";

import { ExitCodeAssertionError, KFuzzArgumentError, KFuzzError } from "./errors.js";
import { NULL_KFUZZ_HANDLER, type KFuzzHandler } from "./handler.js";
import { substituteVars, type KoreSubst, type SubstFunction } from "./subst.js";

/**
 * The per-variable arbitraries — pyk's `subst_strategy: dict[EVar, SearchStrategy[Pattern]]`.
 *
 * A `Map` keyed by the caller's own `EVar` constants, or any iterable of pairs
 * (so an array literal works and needs no `new Map`).  Order is preserved into
 * the generated {@link KoreSubst}, which keeps a fuzz run's substitutions
 * printed in declaration order rather than in whatever order a hash landed
 * them.
 */
export type SubstStrategy = ReadonlyMap<EVar, Arbitrary<Pattern>> | Iterable<readonly [EVar, Arbitrary<Pattern>]>;

/**
 * Grades the interpreter's output — pyk's `check_func`
 * (`kfuzz.py:143,153-155`).
 *
 * **Throw to fail.**  Upstream documents "should throw an `AssertionError`";
 * here any throw is a failing case, because JavaScript has no distinguished
 * assertion error and every test framework's `expect` throws something
 * different.  The consequence is a real difference and is listed as a
 * deviation: in pyk a `TypeError` inside `check_func` escapes the run without
 * `handle_failure` ever being called, and here it does not.
 */
export type CheckFunction = (pattern: Pattern) => void | Promise<void>;

/**
 * What one interpreter run produced.  Structurally a subset of ktool's
 * `CompletedProcess`, so the real runner satisfies it without adaptation.
 */
export interface InterpretResult {
  /** The exit status, or `-signum` if a signal killed it. */
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The interpreter seam — this package's analogue of ktool's `runner` option.
 *
 * Defaults to `llvmInterpretRaw(dir, kore, { check: false, ...interpretOptions })`,
 * which is pyk's call exactly (`kfuzz.py:187`), `check=False` included: a
 * non-zero exit is a *result* to grade, not an exception to propagate.
 *
 * One thing that call hides is worth knowing about, because it bit this package
 * during development and is invisible from here: pyk's argv hands the
 * interpreter the literal paths `/dev/stdin` and `/dev/stdout`, and **those
 * cannot be opened from Node or Bun** — libuv gives a spawned child a
 * `socketpair(2)` where CPython's `subprocess` gives it a `pipe(2)`, and
 * reopening a socket through `/proc/self/fd/N` is `ENXIO`.  The interpreter
 * answers `Cannot read file: /dev/stdin` and produces nothing.
 * `@kframework-ts/ktool` handles it — `ktool/src/stdio.ts` materialises real
 * temp files and passes their paths — so this package makes the plain call and
 * only records the hazard.
 *
 * Replacing the whole function is how the unit tests here fuzz thousands of
 * cases with no binary anywhere, and how a consumer could route execution
 * through a cached or remote interpreter.
 */
export type Interpret = (definitionDir: string, kore: string) => Promise<InterpretResult>;

/**
 * The `hypothesis_args` passthrough (`kfuzz.py:148,165-170`), expressed in
 * fast-check's `Parameters`.
 *
 * Only the parameters with a coherent meaning for this loop are surfaced; the
 * rest of fast-check's surface (`randomType`, `skipEqualValues`, …) is
 * deliberately not re-exported, because a fuzz run whose generator is
 * non-reproducible defeats the seed contract above.
 */
export interface FuzzRunParameters {
  /** Initial seed.  Defaults to fast-check's `Date.now()`; always reported. */
  readonly seed?: number;
  /** Cases to run before declaring success.  fast-check and hypothesis both default to 100. */
  readonly numRuns?: number;
  /**
   * Replay path from a previous failure, as printed by {@link KFuzzError.path}.
   * Needs {@link seed} too.
   */
  readonly path?: string;
  /**
   * Per-case timeout in milliseconds — hypothesis' `deadline`.
   *
   * Defaults to {@link DEFAULT_DEADLINE_MS}, which is upstream's default
   * (`kfuzz.py:203`).  Pass `0` to disable it; an interpreter run over a real
   * semantics can exceed five seconds legitimately.
   */
  readonly timeout?: number;
  /**
   * Shrink a failing case to a minimal one.  **Off** by default, matching
   * pyk's phase list (`:204`) — see the module header.
   */
  readonly shrink?: boolean;
  /**
   * Cases to run first, before any generated ones — hypothesis' `Phase.explicit`
   * (`@example`), which upstream's default phase list *does* include.
   */
  readonly examples?: readonly KoreSubst[];
  /**
   * Abandon the whole run after this many milliseconds.
   *
   * An interrupted run is reported as a **failure** here
   * (`markInterruptAsFailure`), where fast-check's default is to call it a
   * success: "I ran out of time" is not "the property holds", and a harness
   * that treats it as one has a silently green oracle.
   * {@link KFuzzError.interrupted} distinguishes the two.
   */
  readonly interruptAfterTimeLimit?: number;
  /** fast-check's verbose reporting, folded into {@link KFuzzError.message}. */
  readonly verbose?: boolean;
}

/** hypothesis' `deadline` default, as pyk sets it (`kfuzz.py:203`). */
export const DEFAULT_DEADLINE_MS = 5000;

/** Everything `fuzz` accepts beyond the template and the strategies. */
export interface FuzzOptions {
  /**
   * Grade by inspecting the output pattern.  Mutually exclusive with
   * {@link checkExitCode}; exactly one is required.
   */
  readonly checkFunc?: CheckFunction;
  /**
   * Grade by the interpreter's exit status — 0 passes (`kfuzz.py:158-159`).
   *
   * The status comes from the configuration cell marked `exit=""`
   * (`finish_rewriting.cpp:74`), so a definition without such a cell always
   * exits 0 and this mode always passes.
   */
  readonly checkExitCode?: boolean;
  /** Per-case and per-failure hooks.  Defaults to {@link NULL_KFUZZ_HANDLER}. */
  readonly handler?: KFuzzHandler;
  /** How the case is pushed into the template.  Defaults to `substituteVars`. */
  readonly substFunc?: SubstFunction;
  /** Test seam — see {@link Interpret}. */
  readonly interpret?: Interpret;
  /**
   * Passed to `llvmInterpretRaw` on every case.  `check` is not among them:
   * this loop grades a non-zero exit rather than throwing on it.
   */
  readonly interpretOptions?: Omit<LlvmInterpretOptions, "check">;
  /** fast-check parameters — see {@link FuzzRunParameters}. */
  readonly run?: FuzzRunParameters;
}

/**
 * What a completed run reports.  pyk's `fuzz` returns `None`; this returns the
 * facts a replay needs, which a caller is free to ignore.
 */
export interface FuzzReport {
  /** The seed the run used, whether supplied or generated. */
  readonly seed: number;
  /** Cases actually executed. */
  readonly numRuns: number;
}

/** Normalise {@link SubstStrategy} into a stable, ordered pair list. */
function strategyEntries(strategy: SubstStrategy): readonly (readonly [EVar, Arbitrary<Pattern>])[] {
  return [...strategy];
}

/**
 * `fixed_dictionaries(subst_strategy)` (`kfuzz.py:200`) in fast-check.
 *
 * hypothesis has a combinator that takes a dict of strategies and yields a dict
 * of values; fast-check's nearest equivalent, `fc.record`, is keyed by strings
 * and cannot carry `EVar` keys.  So the tuple of the values is generated and
 * zipped back against the declared variables — which is what `fixed_dictionaries`
 * does internally, and which keeps key order deterministic by construction.
 */
function substArbitrary(entries: readonly (readonly [EVar, Arbitrary<Pattern>])[]): Arbitrary<KoreSubst> {
  const arbitraries = entries.map(([, arbitrary]) => arbitrary);
  return fc.tuple(...arbitraries).map((values) => {
    const subst = new Map<EVar, Pattern>();
    values.forEach((value, index) => {
      const entry = entries[index];
      if (entry !== undefined) subst.set(entry[0], value);
    });
    return subst;
  });
}

/**
 * Fuzz a property test with concrete execution over a K term — `fuzz`
 * (`kfuzz.py:138-206`).
 *
 * @param definitionDir a directory `kompile --backend llvm` produced; the
 *   `interpreter` binary inside it is what runs.  **No K installation is
 *   needed** — that is `llvmInterpretRaw`'s whole point.
 * @param template the term sent to the interpreter once its variables are
 *   substituted.  It should contain at least one variable; one that contains
 *   none is not an error, it is 100 identical runs.
 * @param substStrategy one arbitrary per variable in the template.
 * @param options see {@link FuzzOptions}.
 *
 * @returns the seed and case count, so the run can be replayed or recorded.
 * @throws {KFuzzArgumentError} if neither or both of `checkFunc` and
 *   `checkExitCode` are given — upstream's `RuntimeError` (`:175-176`).
 * @throws {KFuzzError} when a case fails, or when the run was interrupted.
 */
export async function fuzz(
  definitionDir: string,
  template: Pattern,
  substStrategy: SubstStrategy,
  options: FuzzOptions = {},
): Promise<FuzzReport> {
  const checkExitCode = options.checkExitCode === true;
  // `if bool(check_func) == check_exit_code` (`:175`) — one, and not both.
  if ((options.checkFunc !== undefined) === checkExitCode) {
    throw new KFuzzArgumentError("Must pass one of check_func or check_exit_code, and not both!");
  }
  const checkFunc = options.checkFunc;

  const handler = options.handler ?? NULL_KFUZZ_HANDLER;
  const substFunc = options.substFunc ?? substituteVars;
  const interpretOptions = options.interpretOptions;
  const interpret: Interpret =
    options.interpret ?? ((dir, kore) => llvmInterpretRaw(dir, kore, { ...interpretOptions, check: false }));

  // `def test(subst_case)` (`:178-198`), with the handler calls in upstream's
  // positions: `handle_test` before the interpreter runs, `handle_failure`
  // after a failure and before it propagates.
  const property = fc.asyncProperty(substArbitrary(strategyEntries(substStrategy)), async (subst: KoreSubst) => {
    await handler.handleTest(subst);
    const result = await interpret(definitionDir, koreText(substFunc(template, subst)));
    try {
      // The guard above makes `checkFunc === undefined` and `checkExitCode`
      // the same condition; branching on the former is what lets the compiler
      // narrow the call below without an assertion.
      if (checkFunc === undefined) {
        if (result.returncode !== 0) throw new ExitCodeAssertionError(result.returncode, result.stderr);
      } else {
        // The parse is inside the guarded block, as it is upstream (`:194`) —
        // but here a malformed interpreter response is a *failing case* that
        // reaches `handleFailure`, where in pyk its `ValueError` escapes the
        // `except AssertionError` and aborts the whole run silently.
        await checkFunc(new KoreParser(result.stdout).pattern());
      }
    } catch (error) {
      await handler.handleFailure(subst);
      throw error;
    }
  });

  const run = options.run ?? {};
  const timeout = run.timeout ?? DEFAULT_DEADLINE_MS;
  const details = await fc.check(property, {
    // `endOnFailure` is the inverse of shrinking: pyk's phase list has no
    // `Phase.shrink`, so this defaults to "stop at the first failure".
    endOnFailure: run.shrink !== true,
    ...(run.seed === undefined ? {} : { seed: run.seed }),
    ...(run.numRuns === undefined ? {} : { numRuns: run.numRuns }),
    ...(run.path === undefined ? {} : { path: run.path }),
    ...(timeout === 0 ? {} : { timeout }),
    ...(run.examples === undefined ? {} : { examples: run.examples.map((subst): [KoreSubst] => [subst]) }),
    ...(run.interruptAfterTimeLimit === undefined
      ? {}
      : { interruptAfterTimeLimit: run.interruptAfterTimeLimit, markInterruptAsFailure: true }),
    ...(run.verbose === undefined ? {} : { verbose: run.verbose }),
  });

  if (!details.failed) return { seed: details.seed, numRuns: details.numRuns };

  const counterexample = details.counterexample?.[0];
  const report = await fc.asyncDefaultReportMessage(details);
  throw new KFuzzError(report ?? "Property failed", {
    counterexample,
    seed: details.seed,
    path: details.counterexamplePath ?? undefined,
    numRuns: details.numRuns,
    numShrinks: details.numShrinks,
    interrupted: details.interrupted,
    cause: details.errorInstance,
  });
}

/** {@link KFuzz}'s constructor options — pyk's two constructor keyword arguments. */
export type KFuzzOptions = Pick<FuzzOptions, "handler" | "substFunc" | "interpret" | "interpretOptions">;

/**
 * Interface for fuzzing over property tests in K — pyk's `KFuzz`
 * (`kfuzz.py:53-109`).
 *
 * Binds a definition directory, a handler and a substitution function once, so
 * a suite of properties over one semantics does not repeat them.  Both methods
 * delegate to {@link fuzz}; the class holds no other state.
 *
 * ```ts
 * const kfuzz = new KFuzz(definitionDir);
 * await kfuzz.fuzzWithCheck(template, [[VAR_X, kintegers()]], checkResult);
 * ```
 */
export class KFuzz {
  readonly definitionDir: string;
  readonly handler: KFuzzHandler;
  readonly substFunc: SubstFunction;
  private readonly options: KFuzzOptions;

  constructor(definitionDir: string, options: KFuzzOptions = {}) {
    this.definitionDir = definitionDir;
    this.handler = options.handler ?? NULL_KFUZZ_HANDLER;
    this.substFunc = options.substFunc ?? substituteVars;
    this.options = options;
  }

  /**
   * Fuzz using `checkFunc` to grade the interpreter's output pattern —
   * `fuzz_with_check` (`:70-89`).
   */
  fuzzWithCheck(
    template: Pattern,
    substStrategy: SubstStrategy,
    checkFunc: CheckFunction,
    run: FuzzRunParameters = {},
  ): Promise<FuzzReport> {
    return fuzz(this.definitionDir, template, substStrategy, { ...this.options, checkFunc, run });
  }

  /**
   * Fuzz using the interpreter's exit status to grade the run —
   * `fuzz_with_exit_code` (`:91-109`).
   */
  fuzzWithExitCode(template: Pattern, substStrategy: SubstStrategy, run: FuzzRunParameters = {}): Promise<FuzzReport> {
    return fuzz(this.definitionDir, template, substStrategy, { ...this.options, checkExitCode: true, run });
  }
}
