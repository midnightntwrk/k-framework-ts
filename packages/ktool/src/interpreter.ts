/**
 * The LLVM backend's generated `interpreter` binary.
 *
 * A transcription of `llvm_interpret` and `llvm_interpret_raw`
 * (`pyk/ktool/krun.py:427-478`) at K `v7.1.337`.
 *
 * # Why this is the most important function in the package
 *
 * Four of the five surveyed downstream repos use `llvm_interpret` as their
 * *execution* path — KEVM's entire GST conformance suite
 * (`evm-semantics/kevm-pyk/src/kevm_pyk/interpreter.py:47`), imp-semantics'
 * `KImp.run`, KMIR's integration tests — and it needs **no K on `PATH` at
 * all**.  `<definitionDir>/interpreter` is a self-contained native binary that
 * `kompile --backend llvm` produced; if you have the directory, you can run it.
 * Everything else in this package shells out to a K installation, and this does
 * not, which makes it the one wrapper that works on a machine that only ever
 * *received* a kompiled definition.
 *
 * # The `/dev/stdin`, `/dev/stdout` literals, and why the spawn does not use them
 *
 * The argv is `<dir>/interpreter /dev/stdin <depth|-1> /dev/stdout` (`:476`):
 * the interpreter takes filenames, and pyk hands it the process's own streams
 * by path rather than writing two temp files.  {@link llvmInterpretArgs} still
 * builds exactly that list by default, because it is pyk's list and the golden
 * table pins it.
 *
 * **The spawn does not use it.**  Node and Bun give a spawned child a
 * `socketpair` for its piped stdio, and reopening a socket through
 * `/proc/self/fd/N` is `ENXIO` — so an interpreter handed `/dev/stdin` fails
 * with `Cannot read file: /dev/stdin` and one handed `/dev/stdout` cannot open
 * its output either.  CPython's `subprocess` uses a real `pipe(2)`, which is
 * why upstream's spelling works upstream and cannot work here; `stdio.ts` has
 * the full write-up and the evidence.  So {@link llvmInterpretRaw} materialises
 * two temp files, passes *their* paths, and reports the output file's contents
 * as {@link CompletedProcess.stdout} — which keeps every observable in this
 * module's contract exactly where it was.
 *
 * {@link llvmInterpretArgs} grew two optional parameters for the substitute
 * paths.  Additive: the two-argument call, and the goldens over it, are
 * unchanged.
 *
 * # `-1` is not a sentinel this package invented
 *
 * `depth if depth is not None else -1` (`:475`) — the interpreter's own
 * spelling of "run to completion".  `depth: 0` is a different request (take no
 * steps) and is passed through as `0`.
 */

import { KoreParser, koreText, type Pattern } from "@kframework-ts/kore";
import { join } from "node:path";

import type { ProcessRunner } from "./kore-print.js";
import { checkFilePath, ProcessError, runProcess, type CompletedProcess, type ProcessLogger } from "./proc.js";
import { DEV_STDIN, DEV_STDOUT, withStdinFile, withStdoutFile } from "./stdio.js";

/**
 * The interpreter ran and the run is not usable — pyk's two `RuntimeError`s
 * (`krun.py:446,449`), with upstream's messages.
 *
 * Two distinct causes, both carried as fields so a caller does not have to
 * parse the message: a non-zero exit ({@link returncode} non-zero,
 * {@link emptyOutput} either way) and a successful exit that produced nothing
 * ({@link emptyOutput} `true`).  The second is the one that catches a
 * misconfigured definition directory, because an interpreter given a pattern it
 * cannot start from exits 0 and says nothing.
 */
export class InterpreterError extends Error {
  /** The interpreter's exit status, or `-signum` if a signal killed it. */
  readonly returncode: number;
  /** Everything it wrote to stderr. */
  readonly stderr: string;
  /** Whether the failure was "no output" rather than "non-zero status". */
  readonly emptyOutput: boolean;

  constructor(message: string, returncode: number, stderr: string, emptyOutput: boolean) {
    super(message);
    this.name = "InterpreterError";
    this.returncode = returncode;
    this.stderr = stderr;
    this.emptyOutput = emptyOutput;
  }
}

/** Options shared by {@link llvmInterpret} and {@link llvmInterpretRaw}. */
export interface LlvmInterpretOptions {
  /** Maximal number of rewrite steps.  Absent means `-1`, "to completion". */
  readonly depth?: number;
  /** Throw on a non-zero exit.  Defaults to `true`. */
  readonly check?: boolean;
  /** The child's working directory. */
  readonly cwd?: string;
  /** The child's whole environment, replacing this process's. */
  readonly env?: Readonly<Record<string, string>>;
  readonly logger?: ProcessLogger;
  /** Test seam — see {@link ProcessRunner}. */
  readonly runner?: ProcessRunner;
}

/**
 * The argv for one interpreter run — `llvm_interpret_raw`'s list (`:476`).
 *
 * Pure, so the `-1` default and the `/dev/*` literals are testable without a
 * binary.
 *
 * `inputFile` and `outputFile` default to {@link DEV_STDIN}/{@link DEV_STDOUT},
 * which is upstream's list verbatim.  {@link llvmInterpretRaw} passes real
 * paths instead — see the module header — and they are parameters rather than a
 * private detail so that a caller comparing a spawned argv against this
 * function's output can reproduce it.
 */
export function llvmInterpretArgs(
  definitionDir: string,
  depth?: number,
  inputFile: string = DEV_STDIN,
  outputFile: string = DEV_STDOUT,
): string[] {
  return [join(definitionDir, "interpreter"), inputFile, String(depth ?? -1), outputFile];
}

/**
 * Run the interpreter over KORE **text** — `llvm_interpret_raw`
 * (`ktool/krun.py:454-478`).
 *
 * The unprocessed form: nothing is parsed on the way in or on the way out.
 * pyk keeps this public, but the downstream survey found no caller for it
 * outside pyk's own `kfuzz`, so by this package's ranking it is internal.  It is
 * exported anyway, and the export has since earned itself:
 * `@kframework-ts/kfuzz` is built on precisely this signature, taking it as the
 * default interpret seam its runs go through (`kfuzz/src/fuzz.ts`).
 *
 * The returned {@link CompletedProcess.stdout} is what the interpreter wrote to
 * its **output file**, not what it wrote to fd 1 — see the module header on why
 * there is an output file at all.  Every other field is the child's own, and
 * `stderr` in particular still carries the backend's diagnostics.
 *
 * @throws {Error} when `<definitionDir>/interpreter` is not a file — checked
 *   before the spawn (`:473`), so a haskell-backend directory says what is
 *   wrong instead of producing an ENOENT.
 * @throws {ProcessError} when the interpreter exits non-zero and `check` is not
 *   `false`.
 */
export async function llvmInterpretRaw(
  definitionDir: string,
  kore: string,
  options: LlvmInterpretOptions = {},
): Promise<CompletedProcess> {
  const interpreter = join(definitionDir, "interpreter");
  await checkFilePath(interpreter);

  const run = options.runner ?? runProcess;
  const { result, output } = await withStdoutFile({ prefix: "interpreter-out-", suffix: ".kore" }, (outputFile) =>
    withStdinFile(kore, { prefix: "interpreter-in-", suffix: ".kore" }, (inputFile) =>
      run(llvmInterpretArgs(definitionDir, options.depth, inputFile, outputFile), {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        check: options.check !== false,
      }),
    ),
  );

  // The output *file* is this function's stdout. A `runner` seam that ignores
  // the paths and answers on the real stdout — which is what every unit test in
  // this package's suite does — must still be honoured, so a non-empty child
  // stdout wins over an empty file.
  return output === "" ? result : { ...result, stdout: output };
}

/**
 * Rewrite a KORE pattern with the LLVM backend's interpreter —
 * `llvm_interpret` (`ktool/krun.py:427-451`).
 *
 * Both failure shapes upstream produces are reproduced as
 * {@link InterpreterError}, message for message:
 *
 * - a non-zero exit becomes `Interpreter failed with status <n>: <stderr>`
 *   (`:446`) — note that this happens **only** under `check`, because without
 *   it `llvm_interpret_raw` never raises and the empty-output branch is reached
 *   instead;
 * - an empty stdout becomes `Interpreter terminated with status <n> and
 *   produced no output: <stderr>` (`:449`), and this one fires regardless of
 *   `check`.
 *
 * @returns the pattern the rewrites ended at.
 * @throws {InterpreterError} for either of the two above.
 * @throws {import('@kframework-ts/kore').KoreSyntaxError} when stdout is not a
 *   KORE pattern.
 */
export async function llvmInterpret(
  definitionDir: string,
  pattern: Pattern,
  options: LlvmInterpretOptions = {},
): Promise<Pattern> {
  let result: CompletedProcess;
  try {
    result = await llvmInterpretRaw(definitionDir, koreText(pattern), options);
  } catch (error) {
    // `except CalledProcessError` (`:445-446`) — and only that; a missing
    // interpreter file is not re-wrapped, upstream or here.
    if (!(error instanceof ProcessError)) throw error;
    throw new InterpreterError(
      `Interpreter failed with status ${error.returncode}: ${error.stderr}`,
      error.returncode,
      error.stderr,
      false,
    );
  }

  if (result.stdout === "") {
    throw new InterpreterError(
      `Interpreter terminated with status ${result.returncode} and produced no output: ${result.stderr}`,
      result.returncode,
      result.stderr,
      true,
    );
  }

  // pyk does not check `eof` here, unlike `run_pattern` — and neither does
  // this, because the interpreter writes a trailing newline that a stricter
  // reading would reject.
  return new KoreParser(result.stdout).pattern();
}
