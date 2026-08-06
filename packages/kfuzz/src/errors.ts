/**
 * Everything this package throws.
 *
 * A separate module for the same reason `packages/kcovr/src/errors.ts` is one:
 * an error type is part of the API a caller writes `catch` against, and a
 * caller who only wants to *handle* failures should not have to import the
 * module that produces them.
 *
 * Three types, one per way a fuzz run can go wrong:
 *
 * - {@link KFuzzArgumentError} — the request was malformed before anything ran;
 * - {@link KFuzzError} — a case failed, or the run was interrupted;
 * - {@link ExitCodeAssertionError} — the specific failure `checkExitCode` mode
 *   produces, and it arrives as {@link KFuzzError}'s `cause` rather than on its
 *   own.
 */

import type { KoreSubst } from "./subst.js";

/**
 * The request is not well-formed — pyk's `RuntimeError` (`kfuzz.py:175-176`),
 * with upstream's message.
 *
 * The check-mode exclusion is the only thing upstream validates, and it is
 * validated at runtime rather than in the type system for the same reason:
 * `KFuzz.fuzzWithCheck` and `KFuzz.fuzzWithExitCode` are the typed entry
 * points, and `fuzz` is the one that takes both fields because it is what they
 * both call.
 */
export class KFuzzArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KFuzzArgumentError";
  }
}

/**
 * A property did not hold — or the run could not be completed.
 *
 * Everything needed to reproduce the run exactly is a field, not a substring of
 * the message: {@link seed} and {@link path} replay it, {@link counterexample}
 * is the substitution that failed, and `cause` is whatever the check function
 * (or the exit-code assertion) threw.
 */
export class KFuzzError extends Error {
  /** The failing substitution, or `undefined` if the run failed without one. */
  readonly counterexample: KoreSubst | undefined;
  /** The seed the run used — pass it back as `run.seed` to replay. */
  readonly seed: number;
  /** fast-check's replay path, to be passed back as `run.path` alongside the seed. */
  readonly path: string | undefined;
  /** Cases executed up to and including the failure. */
  readonly numRuns: number;
  /** Shrink steps taken; always 0 unless `run.shrink` was set. */
  readonly numShrinks: number;
  /** True when the run was cut short by `interruptAfterTimeLimit` rather than by a failure. */
  readonly interrupted: boolean;

  constructor(
    message: string,
    fields: {
      readonly counterexample: KoreSubst | undefined;
      readonly seed: number;
      readonly path: string | undefined;
      readonly numRuns: number;
      readonly numShrinks: number;
      readonly interrupted: boolean;
      readonly cause: unknown;
    },
  ) {
    super(message, { cause: fields.cause });
    this.name = "KFuzzError";
    this.counterexample = fields.counterexample;
    this.seed = fields.seed;
    this.path = fields.path;
    this.numRuns = fields.numRuns;
    this.numShrinks = fields.numShrinks;
    this.interrupted = fields.interrupted;
  }
}

/**
 * The interpreter exited non-zero under `checkExitCode` — the `assert
 * res.returncode == 0` at `kfuzz.py:159`, given a message.
 *
 * It arrives as {@link KFuzzError}'s `cause`.  Upstream's bare `assert` says
 * nothing at all about what happened, which is exactly the wrong behaviour for
 * an operator who cannot see the terminal.
 */
export class ExitCodeAssertionError extends Error {
  readonly returncode: number;
  readonly stderr: string;

  constructor(returncode: number, stderr: string) {
    super(`Interpreter exited with status ${returncode}, expected 0${stderr === "" ? "" : `: ${stderr}`}`);
    this.name = "ExitCodeAssertionError";
    this.returncode = returncode;
    this.stderr = stderr;
  }
}
