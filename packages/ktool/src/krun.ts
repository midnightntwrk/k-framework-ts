/**
 * `krun` — the argv, the spawn, and the four ways to read the result back.
 *
 * A transcription of `pyk/ktool/krun.py` (478 lines) at K `v7.1.337`.
 * {@link krunArgs} is `_build_arg_list` (`:371-424`) and is **pure**; it is also
 * the one function in all of pyk's `ktool` that has an upstream unit test
 * (`pyk/src/tests/unit/ktool/test_krun.py`), which `test/krun.test.ts` ports
 * verbatim.
 *
 * # The quirk ledger, applied
 *
 * None of these is load-bearing upstream — each is a pyk accident — so the port
 * diverges and records the verdict here, where a later drift check finds it
 * instead of re-litigating it.
 *
 * | quirk | upstream | here |
 * | --- | --- | --- |
 * | `KRun.run_process` takes `output=` and `bug_report=` and **ignores both** | `krun.py:77,79,93-94` | the dead parameters are not offered — {@link KRun.runProcess} is always `--output kore --parser cat` |
 * | `KRun.krun` and `run_proof_hint` build their argv with the literal `'krun'`, ignoring `self.command` | `krun.py:135,297-301` | {@link KRun.command} is honoured **everywhere** |
 * | `run_proof_hint` — a bytes-mode process runner with zero downstream users | `krun.py:110-210` | **not ported**.  Node has no text/bytes duality to work around, and `--proof-hint` is still reachable through {@link krunArgs} |
 * | `--debugger` does `os.execvp`, replacing the process | `pyk/utils.py:437-485` | spawn with `stdio: 'inherit'` and hand back the child's status — see {@link KRunOptions.debugger} |
 * | `KRun.run` **prints** to stdout | `krun.py:249-258` | it **returns** the rendered string; a library that writes to your terminal is a library you work around |
 *
 * One more that is not in the ledger because it is not pyk's: `depth` is
 * validated with `if depth and depth < 0` (`:334`), where `depth == 0` is falsy
 * and skips the check.  `0` passes either spelling, so the behaviour is
 * identical; the condition here is the one that says what it means.
 *
 * # `--depth 0` is emitted, and that is not a typo
 *
 * `_build_arg_list` tests `depth is not None` (`:400`), so `depth: 0` produces
 * `--depth 0` — "take no steps", which is a real and useful request.  pyk's
 * *kprove* wrapper tests `if depth:` instead and therefore drops it.  The two
 * disagree upstream; this is krun's side of the disagreement, and the ported
 * golden table pins it.
 */

import { spawn } from "node:child_process";

import { kastTermToDict, type KInner } from "@kframework-ts/kast";
import { koreText, KoreParser, type Pattern } from "@kframework-ts/kore";

import { withTempFile } from "./kast-cli.js";
import { korePrint, type ProcessRunner } from "./kore-print.js";
import { KPrint, type KPrintOptions } from "./kprint.js";
import {
  checkDirPath,
  checkFilePath,
  formatCommand,
  ProcessError,
  runProcess,
  signalNumber,
  type CompletedProcess,
  type ProcessLogger,
} from "./proc.js";

//////////////////////////////
// Enumerations             //
//////////////////////////////

/** `--output` — `KRunOutput` (`ktool/krun.py:34-42`). */
export const KRUN_OUTPUTS = ["pretty", "program", "kast", "binary", "json", "latex", "kore", "none"] as const;
export type KRunOutput = (typeof KRUN_OUTPUTS)[number];

/**
 * `-p<NAME>=<VALUE>` / `-c<NAME>=<VALUE>` values.
 *
 * A plain object or a `Map`, and **iteration order is the argv order** — pyk
 * emits `(pmap or {}).items()` (`:402-405`), which is insertion order in
 * Python.  A `Map` reproduces that exactly.  A plain object does too, with one
 * JavaScript caveat that costs nothing in practice: integer-like keys
 * (`"0"`, `"12"`) are enumerated first and in numeric order, and a K
 * configuration variable is never spelled that way.
 */
export type KRunConfigVars = Readonly<Record<string, string>> | ReadonlyMap<string, string>;

function entriesOf(vars: KRunConfigVars | undefined): readonly (readonly [string, string])[] {
  if (vars === undefined) return [];
  return vars instanceof Map ? [...vars.entries()] : Object.entries(vars);
}

//////////////////////////////
// Pure argv construction   //
//////////////////////////////

/** Everything `krun`'s argv can carry — `_build_arg_list` (`ktool/krun.py:371-390`). */
export interface KrunArgs {
  /** Defaults to `['krun']`.  Only `command[0]` is ever executed. */
  readonly command?: readonly string[];
  /** The positional program/pattern file. */
  readonly inputFile?: string;
  /** `--definition`. */
  readonly definitionDir?: string;
  /** `--output`. */
  readonly output?: KRunOutput;
  /** `--parser` — the command `krun` pipes `$PGM` through.  `cat` means "already KORE". */
  readonly parser?: string;
  /** `--depth`.  **`0` is emitted**; see the module header. */
  readonly depth?: number;
  /** `-p<NAME>=<VALUE>`, emitted **before** {@link cmap} (`:402-405`). */
  readonly pmap?: KRunConfigVars;
  /** `-c<NAME>=<VALUE>`. */
  readonly cmap?: KRunConfigVars;
  /** `--term` — treat the input as the whole configuration, not as `$PGM`. */
  readonly term?: boolean;
  /** `--temp-dir`. */
  readonly tempDir?: string;
  /** `--save-temps`. */
  readonly saveTemps?: boolean;
  /** `--statistics`. */
  readonly statistics?: boolean;
  /** `--no-expand-macros`.  Note the polarity: this is the *negation* of `expandMacros`. */
  readonly noExpandMacros?: boolean;
  /** `--search-final`. */
  readonly searchFinal?: boolean;
  /** `--no-pattern`. */
  readonly noPattern?: boolean;
  /** `--debugger`.  See {@link KRunOptions.debugger} for what it does to the spawn. */
  readonly debugger?: boolean;
  /** `--proof-hint`.  Reachable here; `run_proof_hint` itself is not ported. */
  readonly proofHint?: boolean;
}

/**
 * The complete argv for one `krun` run — `_build_arg_list`
 * (`ktool/krun.py:371-424`), in emission order.
 *
 * Pure, and **unvalidated**: the mutual exclusion of `term` with `cmap`/`pmap`
 * and the non-negative `depth` are checked by {@link runKrun}, which is where
 * pyk checks them (`_krun`, `:334-338`).  That split is not cosmetic — the
 * upstream golden table's `all-args` row sets `term`, `pmap` *and* `cmap` at
 * once and expects an argv back, so a builder that validated would fail its own
 * test.
 *
 * The `-p`/`-c` elements are **single, unescaped argv elements**: `-pFOO=bar`,
 * not `-p` `FOO=bar` and not `-p'FOO=bar'`.  There is no shell, so a value with
 * a space in it needs no quoting and must not get any.
 */
export function krunArgs(options: KrunArgs = {}): string[] {
  const argv = [...(options.command ?? ["krun"])];

  if (present(options.inputFile)) argv.push(options.inputFile);
  if (present(options.definitionDir)) argv.push("--definition", options.definitionDir);
  if (options.output !== undefined) argv.push("--output", options.output);
  if (present(options.parser)) argv.push("--parser", options.parser);
  // `depth is not None` (`:400`) — `0` is emitted.
  if (options.depth !== undefined) argv.push("--depth", String(options.depth));
  for (const [name, value] of entriesOf(options.pmap)) argv.push(`-p${name}=${value}`);
  for (const [name, value] of entriesOf(options.cmap)) argv.push(`-c${name}=${value}`);
  if (options.term === true) argv.push("--term");
  if (present(options.tempDir)) argv.push("--temp-dir", options.tempDir);
  if (options.saveTemps === true) argv.push("--save-temps");
  if (options.statistics === true) argv.push("--statistics");
  if (options.noExpandMacros === true) argv.push("--no-expand-macros");
  if (options.searchFinal === true) argv.push("--search-final");
  if (options.noPattern === true) argv.push("--no-pattern");
  if (options.debugger === true) argv.push("--debugger");
  if (options.proofHint === true) argv.push("--proof-hint");

  return argv;
}

function present(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/**
 * A `krun` request is not well-formed: a negative depth, or `term` together
 * with config-variable maps.
 *
 * Stands in for the two `ValueError`s at `krun.py:335` and `:338`, with
 * upstream's messages.
 */
export class KRunArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KRunArgumentError";
  }
}

//////////////////////////////
// Spawning                 //
//////////////////////////////

export interface KRunOptions extends KrunArgs {
  /** The child's working directory.  Checked before the spawn. */
  readonly cwd?: string;
  /** The child's whole environment, replacing this process's. */
  readonly env?: Readonly<Record<string, string>>;
  readonly logger?: ProcessLogger;
  /** Throw {@link ProcessError} on a non-zero exit.  Defaults to `true`. */
  readonly check?: boolean;
  /** Mirror the child's stderr onto this process's, line by line.  pyk's `pipe_stderr`, inverted. */
  readonly teeStderr?: boolean;
  /** Test seam — see {@link ProcessRunner}.  Ignored on the `debugger` path, which cannot capture. */
  readonly runner?: ProcessRunner;
}

/**
 * Run `krun` — `_krun` (`ktool/krun.py:304-368`).
 *
 * Pre-flight, in upstream's order: `inputFile` must be a file (`:328-329`),
 * `definitionDir` must be a directory (`:331-332`), `depth` must not be
 * negative (`:334-335`), and `term` must not be combined with `cmap`/`pmap`
 * (`:337-338`).
 *
 * `bug_report` is not offered — its call site is null-guarded upstream
 * (`:360-366`) and it is a tar-append interop format (`pyk/utils.py:696-743`)
 * worth its own module when somebody needs pyk-compatible bug reports.
 *
 * @throws {KRunArgumentError} for a negative depth or `term` × `cmap`/`pmap`.
 * @throws {Error} when `inputFile` or `definitionDir` is missing.
 * @throws {ProcessError} when `krun` exits non-zero and `check` is not `false`.
 */
export async function runKrun(options: KRunOptions = {}): Promise<CompletedProcess> {
  if (present(options.inputFile)) await checkFilePath(options.inputFile);
  if (present(options.definitionDir)) await checkDirPath(options.definitionDir);
  if (options.depth !== undefined && options.depth < 0) {
    throw new KRunArgumentError(`Expected non-negative depth, got: ${options.depth}`);
  }
  if (options.term === true && (options.cmap !== undefined || options.pmap !== undefined)) {
    throw new KRunArgumentError("Cannot supply both term and cmap/pmap");
  }

  const argv = krunArgs(options);
  const check = options.check !== false;

  if (options.debugger === true) return runInherited(argv, options, check);

  const run = options.runner ?? runProcess;
  return run(argv, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    teeStderr: options.teeStderr === true,
    check,
  });
}

/**
 * The `--debugger` spawn: all three streams **inherited**, nothing captured.
 *
 * pyk `os.execvp`s here (`pyk/utils.py:437-485`), replacing the Python process
 * with `krun`, so the debugger owns the terminal and its exit status becomes
 * the tool's.  Node has no `execvp` — `child_process` always forks — so the
 * closest honest equivalent is to inherit the streams (the debugger gets the
 * real tty, which is the part that matters: a piped `gdb` is unusable) and hand
 * the child's status back to the caller.
 *
 * The consequence a caller must know: **this process survives**, where pyk's
 * does not.  A CLI wanting execvp parity should finish with
 * `process.exit(result.returncode)`.  {@link CompletedProcess.stdout} and
 * `stderr` are empty strings, because nothing was captured — which is why
 * {@link KRun.run} cannot render output on this path.
 */
function runInherited(argv: readonly string[], options: KRunOptions, check: boolean): Promise<CompletedProcess> {
  return new Promise<CompletedProcess>((fulfil, reject) => {
    const executable = argv[0];
    if (executable === undefined) {
      reject(new Error("Cannot run an empty command"));
      return;
    }
    const log = options.logger ?? ((): undefined => undefined);
    log(`[PID=?][exec] ${formatCommand(argv)}`);

    const child = spawn(executable, argv.slice(1), {
      stdio: "inherit",
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });

    child.on("error", reject);
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const result: CompletedProcess = {
        args: argv,
        returncode: code ?? -signalNumber(signal),
        stdout: "",
        stderr: "",
        signal: signal ?? undefined,
      };
      if (check && result.returncode !== 0) reject(new ProcessError(result));
      else fulfil(result);
    });
  });
}

//////////////////////////////
// The class                //
//////////////////////////////

/** {@link KRun}'s constructor options — `KRun.__init__` (`ktool/krun.py:48-64`). */
export interface KRunClassOptions extends KPrintOptions {
  /** The `krun` command.  Defaults to `['krun']`; honoured everywhere, unlike pyk. */
  readonly krunCommand?: readonly string[];
}

/** The per-call options shared by {@link KRun.runProcess}, {@link KRun.run} and {@link KRun.runPattern}. */
export interface KRunCallOptions {
  readonly cmap?: KRunConfigVars;
  readonly pmap?: KRunConfigVars;
  /** `--term`.  Set by {@link KRun.runPattern} and never by {@link KRun.runPattern}'s caller. */
  readonly term?: boolean;
  readonly depth?: number;
  /**
   * The **positive** spelling of `--no-expand-macros`.
   *
   * Defaults differ by entry point, exactly as upstream: `true` for
   * {@link KRun.run}/{@link KRun.runProcess} (`krun.py:74,220`) and **`false`**
   * for {@link KRun.runPattern} (`:269`).  That flip is not a typo upstream and
   * is not one here: a caller handing over a full configuration has already had
   * its macros expanded, and expanding them twice is wrong.
   */
  readonly expandMacros?: boolean;
  readonly searchFinal?: boolean;
  readonly noPattern?: boolean;
  readonly saveTemps?: boolean;
  readonly statistics?: boolean;
  /** See {@link KRunOptions.debugger}. */
  readonly debugger?: boolean;
  /** Mirror the child's stderr onto this process's. */
  readonly teeStderr?: boolean;
}

/**
 * `krun`, composed over a {@link KPrint}.
 *
 * ```ts
 * const krun = await KRun.load("imp-kompiled");
 * const final = await krun.runPattern(pattern);      // KORE in, KORE out
 * const text = await krun.run(pattern, { output: "pretty" });
 * ```
 *
 * `KRun extends KPrint` upstream (`krun.py:45`); here it **holds** one, exposed
 * as {@link KRun.kprint}, and forwards the two accessors that read naturally on
 * a runner.  See `kprint.ts`'s header on why the hierarchy is not reproduced.
 */
export class KRun {
  /** The printer, the definition, and everything in-process. */
  readonly kprint: KPrint;
  /** The command every child of this instance is spawned as — pyk's `self.command`. */
  readonly command: readonly string[];

  readonly #options: KRunClassOptions;

  constructor(kprint: KPrint, options: KRunClassOptions = {}) {
    this.kprint = kprint;
    this.command = options.krunCommand ?? ["krun"];
    this.#options = options;
  }

  /** Load a `*-kompiled` directory and wrap it — see {@link KPrint.load} on why this is not a constructor. */
  static async load(definitionDir: string, options: KRunClassOptions = {}): Promise<KRun> {
    return new KRun(await KPrint.load(definitionDir, options), options);
  }

  /** The `*-kompiled` directory. */
  get definitionDir(): string {
    return this.kprint.definitionDir;
  }

  /** Where temp files go, and whether they survive. */
  get useDirectory(): string | undefined {
    return this.kprint.useDirectory;
  }

  /**
   * Run a KORE pattern and hand back the raw {@link CompletedProcess} —
   * `KRun.run_process` (`ktool/krun.py:66-108`).
   *
   * Three things are **not** negotiable, and upstream makes the same three
   * non-negotiable by ignoring the parameters that would change them:
   *
   * - `--output kore`, so the result is always parseable KORE regardless of
   *   what the caller eventually wants to see;
   * - `--parser cat`, so `krun` does not try to parse the pattern as a program;
   * - the pattern goes in a **temp file**, because it is the positional
   *   argument and `krun` has no stdin mode.
   *
   * `check` is `false`: a non-zero `krun` still writes a configuration for a
   * stuck term, and throwing before the caller can look at it would be
   * unhelpful.  {@link run} and {@link runPattern} apply the caller's `check`
   * after they have read the output, which is upstream's order.
   */
  runProcess(pgm: Pattern, options: KRunCallOptions = {}): Promise<CompletedProcess> {
    return withTempFile(
      koreText(pgm),
      {
        ...(this.useDirectory === undefined ? {} : { useDirectory: this.useDirectory }),
        prefix: "krun-",
        suffix: ".kore",
      },
      (inputFile) =>
        runKrun({
          command: this.command,
          inputFile,
          definitionDir: this.definitionDir,
          output: "kore",
          parser: "cat",
          ...(options.depth === undefined ? {} : { depth: options.depth }),
          ...(options.cmap === undefined ? {} : { cmap: options.cmap }),
          ...(options.pmap === undefined ? {} : { pmap: options.pmap }),
          ...(options.term === undefined ? {} : { term: options.term }),
          ...(this.useDirectory === undefined ? {} : { tempDir: this.useDirectory }),
          saveTemps: options.saveTemps === true,
          statistics: options.statistics === true,
          noExpandMacros: options.expandMacros === false,
          searchFinal: options.searchFinal === true,
          noPattern: options.noPattern === true,
          debugger: options.debugger === true,
          teeStderr: options.teeStderr === true,
          check: false,
          ...this.#childOptions(),
        }),
    );
  }

  /**
   * Run a pattern and render the result — `KRun.run` (`ktool/krun.py:212-261`).
   *
   * **Returns the text; upstream prints it.**  That is the one behavioural
   * divergence in this method, and it is the ledger's "a library must not write
   * to your terminal" row.  `undefined` comes back for `output: 'none'`, which
   * is the mode that asks for no rendering at all.
   *
   * The four rendering routes, and they are upstream's:
   *
   * | output | route |
   * | --- | --- |
   * | `json` | parse the KORE, convert with {@link KPrint.koreToKast}, serialise the KAST envelope — **in-process** |
   * | `kore` | re-render the parsed pattern's text — in-process, no second child |
   * | `pretty` `program` `kast` `binary` `latex` | hand the KORE to `kore-print --output <mode>` |
   * | `none` | nothing |
   *
   * `latex` will fail at the child: `kore-print`'s `--output` accepts
   * `pretty program kast binary json kore none` and errors on anything else,
   * while `KRunOutput` carries `latex` anyway.  Upstream's mismatch, kept.
   *
   * @throws {ProcessError} when `check` is `true` and `krun` exited non-zero —
   *   **after** the output has been rendered, as pyk does (`:260-261`).
   */
  async run(
    pgm: Pattern,
    options: KRunCallOptions & { readonly output?: KRunOutput; readonly check?: boolean } = {},
  ): Promise<string | undefined> {
    const output = options.output ?? "pretty";
    const result = await this.runProcess(pgm, options);

    let rendered: string | undefined;
    if (output !== "none") {
      const pattern = new KoreParser(result.stdout).pattern();
      if (output === "json") {
        // `self.kore_to_kast(output_kore).to_json()` (`krun.py:252`) — the KAST
        // v4 envelope, not the bare term.
        rendered = JSON.stringify(kastTermToDict(await this.kprint.koreToKast(pattern)));
      } else if (output === "kore") {
        rendered = koreText(pattern);
      } else {
        rendered = await korePrint(pattern, {
          definitionDir: this.definitionDir,
          output,
          command: this.#options.korePrintCommand ?? ["kore-print"],
          ...this.#childOptions(),
        });
      }
    }

    if (options.check === true && result.returncode !== 0) throw new ProcessError(result);
    return rendered;
  }

  /**
   * Run a pattern and parse the resulting one — `KRun.run_pattern`
   * (`ktool/krun.py:263-295`).
   *
   * `term: true` and `output: 'none'` are forced, `expandMacros` defaults to
   * **`false`** (see {@link KRunCallOptions.expandMacros}), and the child's
   * stdout must parse as exactly one pattern with nothing after it — pyk
   * `assert parser.eof` (`:294`), which vanishes under `python -O`; the throw
   * here does not.
   *
   * @throws {ProcessError} when `check` is `true` and `krun` exited non-zero,
   *   **before** parsing (upstream's order here, `:289-290` — the opposite of
   *   {@link run}'s).
   * @throws {import('@kframework-ts/kore').KoreSyntaxError} when stdout is not
   *   one complete KORE pattern.
   */
  async runPattern(
    pattern: Pattern,
    options: Omit<KRunCallOptions, "term" | "cmap" | "pmap"> & { readonly check?: boolean } = {},
  ): Promise<Pattern> {
    const result = await this.runProcess(pattern, {
      ...options,
      term: true,
      expandMacros: options.expandMacros ?? false,
    });

    if (options.check === true && result.returncode !== 0) throw new ProcessError(result);

    const parser = new KoreParser(result.stdout);
    const parsed = parser.pattern();
    parser.expectEof();
    return parsed;
  }

  /**
   * Run a program **file** and get its status and its KAST — `KRun.krun`
   * (`ktool/krun.py:297-301`).
   *
   * The ledger's second row lands here: upstream calls `_krun` without
   * `command=`, so a `KRun('…', command='kevm-krun')` silently runs plain
   * `krun` from this method and the configured one from every other.  This
   * honours {@link KRun.command}.
   *
   * `check` is `false` — the status is a *return value* here, which is the
   * whole point of the tuple.
   */
  async krun(
    inputFile: string,
    options: { readonly parser?: string } = {},
  ): Promise<{
    readonly returncode: number;
    readonly kast: KInner;
  }> {
    const result = await runKrun({
      command: this.command,
      inputFile,
      definitionDir: this.definitionDir,
      output: "kore",
      ...(options.parser === undefined ? {} : { parser: options.parser }),
      check: false,
      ...this.#childOptions(),
    });
    const kore = new KoreParser(result.stdout).pattern();
    return { returncode: result.returncode, kast: await this.kprint.koreToKast(kore) };
  }

  /** The env/logger/runner triple every child of this `KRun` inherits. */
  #childOptions(): {
    readonly env?: Readonly<Record<string, string>>;
    readonly logger?: ProcessLogger;
    readonly runner?: ProcessRunner;
  } {
    return {
      ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
      ...(this.#options.logger === undefined ? {} : { logger: this.#options.logger }),
      ...(this.#options.runner === undefined ? {} : { runner: this.#options.runner }),
    };
  }
}
