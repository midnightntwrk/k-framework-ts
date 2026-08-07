/**
 * `kore-print` — turning a KORE pattern into pretty text, KAST JSON, or program
 * syntax, by asking the K distribution's own printer.
 *
 * A transcription of `pyk/kore/tools.py` (78 lines) at K `v7.1.337`.  Upstream
 * puts this in `pyk.kore`; here it lives in `ktool`, because
 * `@kframework-ts/kore` is hermetic and this function spawns a process — and
 * the house rule is that `ktool` is the only package in this monorepo that
 * spawns K binaries.  The layering divergence is the whole reason the file has
 * this name and not `packages/kore/src/tools.ts`.
 *
 * # What `kore-print` actually is
 *
 * A bash script (`k-distribution/src/main/scripts/bin/kore-print`), not a
 * binary.  It takes exactly one positional KORE file, and:
 *
 * - `--output kore` it answers by `cat`ting the file back — which is why
 *   {@link korePrint} short-circuits that case in-process and never forks;
 * - `--output pretty` it answers with the LLVM backend's C++ printer reading
 *   `syntaxDefinition.kore`, **but only if that file exists** — otherwise it
 *   re-execs `kast --input kore` with the original argv;
 * - every other mode it delegates to `kast --input kore` unconditionally.
 *
 * So this is a *dispatcher*, and the two things it dispatches to are the two
 * printers `@kframework-ts/kompiled`'s README calls Route B and Route A.
 *
 * # Divergences from `pyk/kore/tools.py`, all deliberate
 *
 * | upstream | here | why |
 * | --- | --- | --- |
 * | `--output_file` (`tools.py:68`) | `--output-file` | the script's option table has only the hyphenated spelling; `--output_file` falls into its `-*` catch-all, prints usage and exits 1.  pyk's spelling has **never been exercised** — no call site in pyk or in any downstream repo passes `output_file` — so nothing depends on the broken form.  A recorded divergence: this port follows the script, not pyk. |
 * | `check_file_path(output_file)` (`tools.py:67`) | no check | it is the file being *written*.  Requiring it to exist first makes the option unusable for its only purpose. |
 * | `'kore-print'` hardcoded (`tools.py:58`) | {@link KorePrintOptions.command} | every other wrapper in this package takes its command; a caller with a K install outside `PATH` should not have to shim one binary differently from the rest. |
 * | `/dev/stdin` as the positional argument, pattern on the pipe (`tools.py:58,77`) | a **temp file** | see `stdio.ts`.  Node and Bun give a spawned child a *socketpair* for piped stdio, and reopening a socket through `/proc/self/fd/0` is `ENXIO` — so `/dev/stdin` makes `kore-print` fail with `Cannot read file: /dev/stdin` for every output mode but `kore`.  CPython's `subprocess` uses a real pipe, so pyk's spelling works upstream and cannot work here. |
 *
 * And one **upstream trap kept as-is**: {@link PRINT_OUTPUTS} carries `latex`,
 * because `PrintOutput` does (`tools.py:14-22`), but the script's `--output`
 * validation lists `pretty program kast binary json kore none` and errors on
 * anything else.  `korePrint(p, {output: 'latex'})` therefore fails at the
 * child, not here.  The value is kept so the union is the enum; it is not kept
 * because it works.
 *
 * `pretty` and `program` retain the script's distinct meanings and are not a
 * reparse promise: stored artifacts may be readable but not executable, and
 * generated/parametric labels and bison-list lowering are not reconstructed.
 */

import { koreText, type Pattern } from "@kframework-ts/kore";

import {
  checkDirPath,
  runProcess,
  type CompletedProcess,
  type ProcessControlOptions,
  type ProcessLogger,
  type RunProcessOptions,
} from "./proc.js";
import { withStdinFile } from "./stdio.js";

//////////////////////////////
// The spawn seam           //
//////////////////////////////

/**
 * How a wrapper in this package reaches a child process.
 *
 * {@link runProcess} is the only implementation that ships, and it is the
 * default everywhere.  The indirection exists so that the *argv a wrapper
 * chose* is observable in a test without a K install: `krun.ts`,
 * `kast-cli.ts`, `interpreter.ts` and this module all accept one, and their
 * unit tests pass a function that records its arguments and returns a canned
 * {@link CompletedProcess}.
 *
 * Declared here, in the smallest of the four modules, so the three others can
 * import the type without importing each other.
 */
export type ProcessRunner = (args: readonly string[], options: RunProcessOptions) => Promise<CompletedProcess>;

//////////////////////////////
// Enumerations             //
//////////////////////////////

/**
 * `--output` — `PrintOutput` (`kore/tools.py:14-22`).
 *
 * Byte-identical to `KRunOutput` and to `KAstOutput`; the three enums exist
 * separately upstream and are kept separate here for the same reason, which is
 * that the three tools accept different subsets of them and only the *names*
 * coincide.  See the module header on `latex`.
 */
export const PRINT_OUTPUTS = ["pretty", "program", "kast", "binary", "json", "latex", "kore", "none"] as const;
export type PrintOutput = (typeof PRINT_OUTPUTS)[number];

//////////////////////////////
// Pure argv construction   //
//////////////////////////////

/** The flags {@link korePrintArgs} can emit — `_kore_print`'s keyword arguments (`kore/tools.py:48-57`). */
export interface KorePrintArgs {
  /** Defaults to `['kore-print']`.  Only `command[0]` is ever executed. */
  readonly command?: readonly string[];
  /** `--definition`. */
  readonly definitionDir?: string;
  /** `--output-file`.  See the module header: pyk spells this with an underscore. */
  readonly outputFile?: string;
  /** `--output`. */
  readonly output?: PrintOutput;
  /** `--color on` / `--color off`.  Absent leaves the script's tty heuristic alone. */
  readonly color?: boolean;
}

/**
 * The complete argv for one `kore-print` run — `_kore_print`'s appends
 * (`kore/tools.py:58-75`), in emission order.
 *
 * Pure: no filesystem, no process, no K required.  The order is the contract
 * that `test/kore-print.test.ts` pins; upstream has no test for it at all.
 */
export function korePrintArgs(inputFile: string, options: KorePrintArgs = {}): string[] {
  const argv = [...(options.command ?? ["kore-print"]), inputFile];

  if (options.definitionDir !== undefined && options.definitionDir !== "") {
    argv.push("--definition", options.definitionDir);
  }
  if (options.outputFile !== undefined && options.outputFile !== "") {
    argv.push("--output-file", options.outputFile);
  }
  if (options.output !== undefined) argv.push("--output", options.output);
  if (options.color !== undefined) argv.push("--color", options.color ? "on" : "off");

  return argv;
}

//////////////////////////////
// Spawning                 //
//////////////////////////////

export interface KorePrintOptions extends KorePrintArgs, ProcessControlOptions {
  /** The child's working directory.  Checked before the spawn. */
  readonly cwd?: string;
  /** The child's whole environment, replacing this process's. */
  readonly env?: Readonly<Record<string, string>>;
  readonly logger?: ProcessLogger;
  /** Throw {@link import('./proc.js').ProcessError} on a non-zero exit.  Defaults to `true`. */
  readonly check?: boolean;
  /** Test seam — see {@link ProcessRunner}. */
  readonly runner?: ProcessRunner;
}

/**
 * Print a KORE pattern through `kore-print` — `kore_print`
 * (`kore/tools.py:25-45`).
 *
 * The pattern may be a `Pattern` or the KORE text itself; a `Pattern` is
 * rendered with `koreText` first, which is pyk's `pattern.text`.
 *
 * **`output: 'kore'` never forks.**  Upstream returns the input unchanged
 * (`tools.py:36-37`) because the script would only `cat` it back, and that
 * short-circuit is load-bearing for `KRun.run`, which reaches this function for
 * every output mode including `kore`.
 *
 * The text is written to a **temp file** whose path becomes the positional
 * argument, and the file is deleted afterwards.  pyk puts `/dev/stdin` there
 * and pushes the text down the pipe; that spelling cannot work from Node or
 * Bun, and `stdio.ts` documents exactly why.  Still POSIX-oriented — the
 * `--output-file` handling and the K scripts themselves are POSIX-oriented,
 * but this invocation does not require an openable `/dev/*` path.
 *
 * @returns the child's stdout, **trimmed** (`tools.py:78`).  A caller needing
 *   the exact bytes — trailing newline included — wants
 *   {@link KorePrintArgs.outputFile} or its own {@link runProcess} call.
 * @throws {Error} when `definitionDir` is not a directory.
 * @throws {import('./proc.js').ProcessError} when `kore-print` exits non-zero
 *   and `check` is not `false`.
 */
export async function korePrint(pattern: Pattern | string, options: KorePrintOptions = {}): Promise<string> {
  const input = typeof pattern === "string" ? pattern : koreText(pattern);
  if (options.output === "kore") return input;

  if (options.definitionDir !== undefined && options.definitionDir !== "") {
    await checkDirPath(options.definitionDir);
  }

  const run = options.runner ?? runProcess;
  const result = await withStdinFile(input, { prefix: "kore-print-", suffix: ".kore" }, (file) =>
    run(korePrintArgs(file, options), {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
      check: options.check !== false,
    }),
  );
  return result.stdout.trim();
}
