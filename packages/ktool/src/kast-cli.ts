/**
 * `kast` — the K parser/unparser binary, as argv and as a spawn.
 *
 * A transcription of `pyk/ktool/kprint.py:39-168` (the two enums, `_kast`,
 * `gen_glr_parser`, `_build_arg_list`) plus `KPrint._temp_file` and
 * `KPrint._expression_kast` (`:206-216`, `:314-353`) at K `v7.1.337`.  The
 * class that owns those last two upstream is `kprint.ts` here; the *mechanism*
 * lives with the binary it drives, because {@link expressionKast} is the only
 * way anything in this package ever passes a term to `kast` and it should not
 * be reachable only through a loaded definition.
 *
 * # The 128 KiB rule, which is the interesting part
 *
 * `kast --expression <text>` puts the term in the argv.  Every operating system
 * caps the total size of an argv (`ARG_MAX`; 2 MiB on Linux, 256 KiB on macOS),
 * and a KAST-JSON configuration for a real semantics goes past that without
 * trying.  So pyk switches to a temp file at **128 × 1024 characters**
 * (`kprint.py:326`) — the constant is {@link EXPRESSION_MAX_LENGTH}, the
 * comparison is `<` (so exactly 131072 characters take the file), and the
 * threshold counts **characters, not bytes**, which is upstream's meaning and
 * therefore ours: a term of 100 000 astral-plane characters is 400 000 bytes of
 * argv and still takes the `--expression` path in both implementations.
 *
 * # Temp files, and why {@link KastTempOptions.useDirectory} changes their fate
 *
 * `NamedTemporaryFile(dir=self.use_directory, delete=not self.use_directory)`
 * (`kprint.py:208-214`).  Read the `delete=`: when a `use_directory` is
 * configured the file is written **there and kept**, and when it is not, the
 * file goes to the system temp directory and is removed.  That is not a
 * housekeeping detail — it is how you debug a failing `kast` invocation, by
 * pointing `useDirectory` at somewhere you can read afterwards.
 * {@link withTempFile} reproduces both halves.
 *
 * `pretty` and `program` are K printer routes, not parse/print inverses.
 * Bison-list lowering and generated parametric labels remain parser-generation
 * concerns; this argv layer never repairs printed text or guesses artifacts.
 */

import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProcessRunner } from "./kore-print.js";
import {
  checkDirPath,
  checkFilePath,
  runProcess,
  type CompletedProcess,
  type ProcessControlOptions,
  type ProcessLogger,
} from "./proc.js";

//////////////////////////////
// Enumerations             //
//////////////////////////////

/** `--input` — `KAstInput` (`ktool/kprint.py:39-45`). */
export const KAST_INPUTS = ["program", "binary", "json", "kast", "kore", "rule"] as const;
export type KAstInput = (typeof KAST_INPUTS)[number];

/** `--output` — `KAstOutput` (`ktool/kprint.py:48-56`). */
export const KAST_OUTPUTS = ["pretty", "program", "kast", "binary", "json", "latex", "kore", "none"] as const;
export type KAstOutput = (typeof KAST_OUTPUTS)[number];

//////////////////////////////
// Pure argv construction   //
//////////////////////////////

/** Everything `kast`'s argv can carry — `_build_arg_list` (`ktool/kprint.py:136-148`). */
export interface KastArgs {
  /**
   * The positional argument.
   *
   * A file to parse — **except** with {@link genGlrParser}, where it is the
   * parser binary to *write* (`kprint.py:77-81`).  That inversion is why
   * {@link runKast} checks its existence in one case and forbids its absence in
   * the other.
   */
  readonly file?: string;
  /** Defaults to `['kast']`.  Only `command[0]` is ever executed. */
  readonly command?: readonly string[];
  /** `--definition`. */
  readonly definitionDir?: string;
  /** `--input`. */
  readonly input?: KAstInput;
  /** `--output`. */
  readonly output?: KAstOutput;
  /** `--expression` — the term as a single argv element.  See {@link EXPRESSION_MAX_LENGTH}. */
  readonly expression?: string;
  /** `--module`. */
  readonly module?: string;
  /** `--sort`. */
  readonly sort?: string;
  /** `--temp-dir`. */
  readonly tempDir?: string;
  /** `--gen-glr-parser`; turns {@link file} into an output path. */
  readonly genGlrParser?: boolean;
  /** Hidden official JVM option; unlike wrapper routes, `kast` receives it directly. */
  readonly noExcWrap?: boolean;
}

/**
 * The complete argv for one `kast` run — `_build_arg_list`
 * (`ktool/kprint.py:136-168`), in emission order.
 *
 * Pure: no filesystem, no process, no K required. The bare default `kast` is
 * resolved by the OS through `PATH`; pass an absolute `command` for a pinned
 * K installation. Upstream has no test for this order;
 * `test/kast-cli.test.ts` is the table that pins it.
 */
export function kastArgs(options: KastArgs = {}): string[] {
  const argv = [...(options.command ?? ["kast"])];

  if (present(options.file)) argv.push(options.file);
  if (present(options.definitionDir)) argv.push("--definition", options.definitionDir);
  if (options.input !== undefined) argv.push("--input", options.input);
  if (options.output !== undefined) argv.push("--output", options.output);
  if (present(options.expression)) argv.push("--expression", options.expression);
  if (present(options.module)) argv.push("--module", options.module);
  if (present(options.sort)) argv.push("--sort", options.sort);
  if (present(options.tempDir)) argv.push("--temp-dir", options.tempDir);
  if (options.genGlrParser === true) argv.push("--gen-glr-parser");
  if (options.noExcWrap === true) argv.push("--no-exc-wrap");

  return argv;
}

/** pyk gates every one of these on truthiness, so `''` is "absent" throughout. */
function present(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

//////////////////////////////
// Spawning                 //
//////////////////////////////

/** The non-argv half of a {@link runKast} call. */
export interface RunKastOptions extends KastArgs, ProcessControlOptions {
  /**
   * Text written to the child's stdin.
   *
   * Spelled `stdin` and not `input` because {@link KastArgs.input} is already
   * taken by `--input`, which is a *format* and not data.  pyk never passes
   * stdin to `kast` at all; this is here for a caller driving `kast -` by hand.
   */
  readonly stdin?: string;
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
 * Run `kast` — `_kast` (`ktool/kprint.py:59-109`).
 *
 * The three pre-flight checks are upstream's, in upstream's order:
 *
 * 1. a {@link KastArgs.file} that is **not** a `--gen-glr-parser` output must
 *    already exist (`:77-78`);
 * 2. `--gen-glr-parser` with no file is an error *here*, not a usage message
 *    from the child (`:80-81`);
 * 3. `definitionDir` must be a directory (`:83-85`).
 *
 * @throws {Error} for any of the three, before a process exists.
 * @throws {import('./proc.js').ProcessError} when `kast` exits non-zero and
 *   `check` is not `false`.
 */
export async function runKast(options: RunKastOptions = {}): Promise<CompletedProcess> {
  const genGlr = options.genGlrParser === true;

  if (present(options.file) && !genGlr) await checkFilePath(options.file);
  if (!present(options.file) && genGlr) throw new Error("No output file specified for --gen-glr-parser");
  if (present(options.definitionDir)) await checkDirPath(options.definitionDir);

  const run = options.runner ?? runProcess;
  return run(kastArgs(options), {
    ...(options.stdin === undefined ? {} : { input: options.stdin }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
    check: options.check !== false,
  });
}

/**
 * Generate a Bison GLR parser for a definition — `gen_glr_parser`
 * (`ktool/kprint.py:112-133`).
 *
 * `parserFile` is an **output**: it is written by the child and asserted to
 * exist afterwards (pyk `assert`s at `:132`, i.e. the check vanishes under
 * `python -O`; the throw here does not).
 *
 * `check` is forced to `true` upstream and is not offered — a parser generator
 * that reported success after failing would be worse than useless.
 *
 * @returns `parserFile`, unchanged.
 * @throws {Error} when the run succeeded but the file is not there.
 */
export async function genGlrParser(
  parserFile: string,
  options: Omit<RunKastOptions, "file" | "genGlrParser" | "check" | "input" | "output" | "expression"> = {},
): Promise<string> {
  await runKast({ ...options, file: parserFile, genGlrParser: true, check: true });
  await checkFilePath(parserFile);
  return parserFile;
}

//////////////////////////////
// Expressions and temps    //
//////////////////////////////

/**
 * The `--expression`/temp-file switch point, in **characters**
 * (`ktool/kprint.py:326`).
 *
 * `128 * 1024`.  The comparison upstream is `len(expression) < 128 * 1024`, so
 * a term of exactly this length takes the file path.
 */
export const EXPRESSION_MAX_LENGTH = 128 * 1024;

/** The half of {@link ExpressionKastOptions} that decides where temp files go. */
export interface KastTempOptions {
  /**
   * Where temp files are written, and whether they survive —
   * `KPrint.use_directory` (`ktool/kprint.py:191-214`).
   *
   * Set: files are created here and **kept** after the run, and the path is
   * also passed to `kast` as `--temp-dir`.  Unset: files go to the system temp
   * directory and are deleted, and no `--temp-dir` is emitted.
   */
  readonly useDirectory?: string;
}

export interface ExpressionKastOptions
  extends KastTempOptions, Omit<RunKastOptions, "file" | "expression" | "tempDir"> {
  /**
   * Force the temp-file path regardless of length.
   *
   * Not upstream.  It exists because the alternative way to exercise the file
   * branch is to construct a 128 KiB string in a test, and a test that allocates
   * 128 KiB to assert on an `if` is a test that hides what it is checking.
   */
  readonly forceTempFile?: boolean;
}

/**
 * Hand `expression` to `kast`, by argv or by file — `KPrint._expression_kast`
 * (`ktool/kprint.py:314-353`).
 *
 * Note what does **not** change between the two branches: `--temp-dir` is
 * `useDirectory` either way, and so is the temp file's directory.  The only
 * difference is `--expression <text>` versus a positional filename.
 */
export async function expressionKast(
  expression: string,
  options: ExpressionKastOptions = {},
): Promise<CompletedProcess> {
  const { useDirectory, forceTempFile, ...rest } = options;
  const tempDir = useDirectory === undefined ? {} : { tempDir: useDirectory };

  if (expression.length < EXPRESSION_MAX_LENGTH && forceTempFile !== true) {
    return runKast({ ...rest, ...tempDir, expression });
  }

  return withTempFile(expression, useDirectory === undefined ? {} : { useDirectory }, (file) =>
    runKast({ ...rest, ...tempDir, file }),
  );
}

/**
 * `KPrint._temp_file` (`ktool/kprint.py:206-216`): write `contents` to a fresh
 * file, hand its path to `body`, and delete it afterwards **unless** a
 * {@link KastTempOptions.useDirectory} was configured.
 *
 * The name is random rather than sequential because `NamedTemporaryFile`'s is:
 * two concurrent `kastToKore` calls on the same definition must not collide,
 * and `mkstemp`-style O_EXCL retry logic is not worth writing when
 * `randomUUID` exists.
 *
 * The delete is in a `finally`, so a throwing `body` still cleans up — which is
 * what the `with` block upstream guarantees and what a naive
 * `await body(); await unlink()` would not.
 */
export async function withTempFile<T>(
  contents: string,
  options: KastTempOptions & { readonly prefix?: string; readonly suffix?: string },
  body: (path: string) => Promise<T>,
): Promise<T> {
  const directory = options.useDirectory;
  if (directory !== undefined) await checkDirPath(directory);

  const name = `${options.prefix ?? "ktool-"}${randomUUID()}${options.suffix ?? ""}`;
  const path = join(directory ?? tmpdir(), name);

  await writeFile(path, contents, "utf8");
  try {
    return await body(path);
  } finally {
    // `delete=not self.use_directory` (`:212`).  A configured directory is a
    // request to keep the evidence.
    if (directory === undefined) await unlink(path).catch(() => undefined);
  }
}
