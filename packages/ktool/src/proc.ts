/**
 * Running a child process the way pyk runs one — `run_process_2`
 * (`pyk/utils.py:488-529`) and the `_subprocess_run`/`_subprocess_communicate`
 * pair beneath it (`:532-641`) — plus the three path predicates every K tool
 * wrapper calls before it spawns (`:654-693`).
 *
 * This is the only module in `@kframework-ts/ktool` that starts a process, and
 * `ktool` is the only package in this monorepo that starts one at all (the one
 * exception, `@kframework-ts/kore-rpc`'s server spawner, quarantines itself the
 * same way).  Everything else here is pure argv construction, which is why
 * `kompile.ts` can be golden-tested with no K installed.
 *
 * # What "run_process_2 semantics" means, precisely
 *
 * 1. **Never a shell.**  `Popen` is given a list, so no word splitting, no glob
 *    expansion, no quoting.  `spawn` is given `shell: false` (the default) for
 *    the same reason, and that is the reason `--post-process` must *not* be
 *    `shlex.quote`d on the way in — see `kompile.ts`.
 * 2. **Both streams are always piped and always captured.**  `write_stdout` /
 *    `write_stderr` do not switch capture off; they add a *second*
 *    destination, line by line, to the parent's own stream.  {@link teeStdout}
 *    and {@link teeStderr} are those two flags, and
 *    {@link CompletedProcess.stdout} is populated either way.
 * 3. **The tee is line-wise, not chunk-wise.**  pyk's reader threads iterate
 *    the pipe as text lines and `write` + `flush` each one, so a caller that
 *    interleaves its own output onto the same terminal never lands mid-line.
 *    A trailing fragment with no newline is flushed when the pipe closes,
 *    exactly as Python's file iteration yields it.
 * 4. **stdin is `DEVNULL` unless {@link RunProcessOptions.input} is given**
 *    (`:545`).  A K tool that reads stdin when nobody meant it to should see
 *    EOF, not the parent's terminal.
 * 5. **`check` defaults to `true`** and raises on a non-zero status
 *    (`:526-527`).  Ours raises {@link ProcessError}, which carries argv,
 *    status and *both* captured streams — Python's `CalledProcessError` carries
 *    the same four fields, and callers reach for `stderr` on every one of them.
 *
 * # Deliberate divergences
 *
 * - **The logger is a callback, not a `logging.Logger`.**  pyk threads a
 *   `Logger` and a `loglevel` through every frame and emits `[PID=n][exec]`,
 *   `[stdo]`, `[stde]`, `[stdi]`, `[done]` and `[fail]` records.  The prefixes
 *   are reproduced verbatim so a K-shaped log stays greppable, but the sink is
 *   {@link ProcessLogger} — a package that logs through `console` by default
 *   would be a package you cannot silence.
 * - **A signal death reports a negative status.**  Node gives `code === null`
 *   and a signal name; POSIX `wait` (and therefore Python) gives `-signum`.
 *   {@link CompletedProcess.returncode} carries the Python number so that
 *   `returncode !== 0` means the same thing in both, and
 *   {@link CompletedProcess.signal} carries the name that Node knew.
 * - **The environment actually reaches the child.**  Both are "replace, do not
 *   merge" (`env=` in `Popen`, `env` in `spawn`), so this is parity — recorded
 *   only because `kompile.ts` diverges from `shutil.which`, which reads
 *   `os.environ` and *not* the `env` being passed to the child.
 */

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { constants } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

//////////////////////////////
// Types                    //
//////////////////////////////

/**
 * Where the `[PID=…]`-prefixed trace goes.
 *
 * One string per record, already prefixed, never terminated with a newline.
 * The default is to drop it: a library that writes to the terminal uninvited is
 * a library you have to work around.
 */
export type ProcessLogger = (message: string) => void;

/** What a finished process yielded — Python's `CompletedProcess`, plus {@link signal}. */
export interface CompletedProcess {
  /** The argv as spawned, executable first. Never a shell string. */
  readonly args: readonly string[];
  /** Observed exit status; absent only when forced cancellation settled before exit was observable. */
  readonly returncode?: number;
  /** Everything the child wrote to stdout, concatenated in order. */
  readonly stdout: string;
  /** Everything the child wrote to stderr, concatenated in order. */
  readonly stderr: string;
  /** The signal that killed the child, if one did — `undefined` for a normal exit. */
  readonly signal: NodeJS.Signals | undefined;
  /** Why this run was stopped by this library, if it was. */
  readonly cancelledBy?: "timeout" | "abort" | undefined;
}

const CompletedProcessInputSchema = z.object({
  /** The argv as spawned, executable first. Never a shell string. */
  args: z.array(z.string()).readonly(),
  /** Observed exit status; absent only when forced cancellation settled before exit was observable. */
  returncode: z.number().optional(),
  /** Everything the child wrote to stdout, concatenated in order. */
  stdout: z.string(),
  /** Everything the child wrote to stderr, concatenated in order. */
  stderr: z.string(),
  /** The signal that killed the child, if one did. */
  signal: z.union([
    z.custom<NodeJS.Signals>((value): value is NodeJS.Signals => typeof value === "string"),
    z.undefined(),
  ]),
  /** Why this run was stopped by this library, if it was. */
  cancelledBy: z.enum(["timeout", "abort"]).optional(),
});

/** Structural process evidence. Cancellation and exit chronology stay with the process runner. */
export const CompletedProcessSchema: z.ZodType<
  CompletedProcess,
  z.input<typeof CompletedProcessInputSchema>
> = CompletedProcessInputSchema.superRefine((result, context) => {
  if (!Object.hasOwn(result, "signal")) {
    context.addIssue({ code: "custom", message: "signal must be present, even when undefined" });
  }
}).transform(
  (result): CompletedProcess => ({
    args: result.args,
    ...(result.returncode === undefined ? {} : { returncode: result.returncode }),
    stdout: result.stdout,
    stderr: result.stderr,
    signal: result.signal,
    ...(result.cancelledBy === undefined ? {} : { cancelledBy: result.cancelledBy }),
  }),
);

/** Optional controls shared by every non-interactive K-tool invocation. */
export interface ProcessControlOptions {
  /** Wall-clock limit from spawn.  Must be finite and greater than zero. */
  readonly timeoutMs?: number;
  /** Cancels this one run.  A pre-aborted signal prevents spawning altogether. */
  readonly signal?: AbortSignal;
  /** TERM-to-KILL grace period.  Defaults to {@link DEFAULT_KILL_GRACE_MS}; zero kills immediately. */
  readonly killGraceMs?: number;
}

export const DEFAULT_KILL_GRACE_MS = 2_000;

export interface RunProcessOptions extends ProcessControlOptions {
  /**
   * Text written to the child's stdin, which is then closed.
   *
   * Its absence is *not* the same as `""`: absent means stdin is `/dev/null`
   * (`utils.py:545`), while `""` means an open-then-immediately-closed pipe.
   * Only the first makes a tool that probes `isatty` behave.
   */
  readonly input?: string;
  /** Mirror the child's stdout onto the parent's, line by line, while still capturing it. */
  readonly teeStdout?: boolean;
  /** Mirror the child's stderr onto the parent's, line by line, while still capturing it. */
  readonly teeStderr?: boolean;
  /**
   * Working directory for the child.
   *
   * Checked with {@link checkDirPath} before the spawn, as `run_process_2` does
   * (`utils.py:505-507`) — a `spawn` ENOENT cannot tell you whether it was the
   * executable or the directory that was missing.
   */
  readonly cwd?: string;
  /**
   * The child's entire environment.  **Replaces** `process.env`; it is not
   * merged into it.  Omit to inherit.
   */
  readonly env?: Readonly<Record<string, string>>;
  readonly logger?: ProcessLogger;
  /** Throw {@link ProcessError} on a non-zero status.  Defaults to `true`. */
  readonly check?: boolean;
}

/** A cancellation with no child outcome, currently only a pre-aborted signal. */
export class ProcessAbortError extends Error {
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly cancelledBy = "abort" as const;

  constructor(args: readonly string[]) {
    super(`Command was aborted before it started: ${formatCommand(args)}`);
    this.name = "ProcessAbortError";
    this.args = args;
    this.stdout = "";
    this.stderr = "";
  }
}

/**
 * A child exited non-zero under `check`.
 *
 * Python's `CalledProcessError` in every respect that matters: the four fields
 * are the four fields, and the message leads with the status and the command so
 * that an unhandled throw is readable on its own.  `name` is set explicitly
 * because `instanceof` across duplicated copies of a package is unreliable and
 * `name` is not.
 */
export class ProcessError extends Error {
  readonly args: readonly string[];
  readonly returncode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal: NodeJS.Signals | undefined;
  readonly cancelledBy: CompletedProcess["cancelledBy"];

  constructor(result: CompletedProcess) {
    super(
      `Command failed with status ${result.returncode ?? "unobserved"}: ${formatCommand(result.args)}` +
        (result.stderr === "" ? "" : `\n${result.stderr.trimEnd()}`),
    );
    this.name = "ProcessError";
    this.args = result.args;
    this.returncode = result.returncode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.signal = result.signal;
    this.cancelledBy = result.cancelledBy;
  }
}

/** A child was stopped by its deadline or by its caller's abort signal. */
export class ProcessCancelledError extends ProcessError {
  declare readonly cancelledBy: "timeout" | "abort";

  constructor(result: CompletedProcess) {
    super(result);
    this.name = result.cancelledBy === "timeout" ? "ProcessTimeoutError" : "ProcessAbortError";
    this.cancelledBy = result.cancelledBy ?? "abort";
  }
}

//////////////////////////////
// Running                  //
//////////////////////////////

/**
 * Spawn `args`, capture both streams, and resolve once the child and both pipes
 * are done — `run_process_2` (`pyk/utils.py:488-529`).
 *
 * `args[0]` is the executable.  It is resolved by the OS against `PATH`, so a
 * caller that wants "not found" reported *before* a process is created should
 * resolve it itself first ({@link resolveOnPath}); that is what
 * `kompile()` does, and why `KompileNotFoundError` is not an ENOENT.
 *
 * @throws {ProcessError} when the child exits non-zero and `check` is not `false`.
 * @throws {Error} when `args` is empty, when `cwd` is not a directory, or when
 *   the executable cannot be started at all (the ENOENT from `spawn`, which
 *   Python raises as `FileNotFoundError`).
 */
export async function runProcess(args: readonly string[], options: RunProcessOptions = {}): Promise<CompletedProcess> {
  const executable = args[0];
  if (executable === undefined) throw new Error("Cannot run an empty command");

  validateProcessControls(options);
  if (options.signal?.aborted === true) throw new ProcessAbortError(args);

  if (options.cwd !== undefined) await checkDirPath(options.cwd);

  const log = options.logger ?? (() => undefined);
  const result = await spawnAndCommunicate(executable, args, options, log);

  if (options.check !== false && result.cancelledBy !== undefined) throw new ProcessCancelledError(result);
  if (options.check !== false && result.returncode !== 0) throw new ProcessError(result);
  return result;
}

/** `_subprocess_run` + `_subprocess_communicate` (`pyk/utils.py:532-641`), as one function. */
function spawnAndCommunicate(
  executable: string,
  args: readonly string[],
  options: RunProcessOptions,
  log: ProcessLogger,
): Promise<CompletedProcess> {
  return new Promise<CompletedProcess>((fulfil, reject) => {
    const controlled = options.timeoutMs !== undefined || options.signal !== undefined;
    const child = spawn(executable, args.slice(1), {
      // `input === undefined` → `/dev/null`, matching `utils.py:545`.  Both
      // output pipes are unconditional: the tee is an *extra* destination.
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(controlled ? { detached: true } : {}),
    });

    // `pid` is `undefined` until the `spawn` event; pyk has a real pid by the
    // time it builds this prefix, so an unstarted child logs `?` rather than
    // `undefined`.
    const prefix = (): string => `[PID=${child.pid ?? "?"}]`;
    const start = Date.now();
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let cancelledBy: CompletedProcess["cancelledBy"];
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;

    for (const line of formatCommand(args).split("\n")) log(`${prefix()}[exec] ${line}`);

    const stdout = collector(options.teeStdout === true ? process.stdout : undefined, "[stdo]", prefix, log);
    const stderr = collector(options.teeStderr === true ? process.stderr : undefined, "[stde]", prefix, log);

    // Both are non-null because the `stdio` above pipes both; the guards are
    // for the type, which cannot see that.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: string) => stderr.push(chunk));

    const cleanup = (): void => {
      if (deadline !== undefined) clearTimeout(deadline);
      if (escalation !== undefined) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", abort);
    };

    const result = (code: number | null | undefined, signal: NodeJS.Signals | null | undefined): CompletedProcess => ({
      args,
      ...(code === undefined && signal === undefined ? {} : { returncode: code ?? -signalNumber(signal) }),
      stdout: stdout.text(),
      stderr: stderr.text(),
      signal: signal ?? undefined,
      cancelledBy,
    });

    const settle = (code: number | null | undefined, signal: NodeJS.Signals | null | undefined): void => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout.end();
      stderr.end();
      const completed = result(code, signal);
      log(`${prefix()}[done] status=${completed.returncode ?? "unobserved"} time=${elapsed(start)}`);
      fulfil(completed);
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      // `popen.kill()` in the `except BaseException` arm (`utils.py:570`): a
      // rejected promise must not leave a live child behind.
      child.kill();
      log(`${prefix()}[fail] time=${elapsed(start)}`);
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    child.on("error", fail);

    const signalChild = (signal: NodeJS.Signals): void => {
      if (exited) return;
      if (controlled && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (error: unknown) {
          const code =
            typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
              ? error.code
              : undefined;
          log(
            `${prefix()}[kill] group ${signal} failed${code === undefined ? "" : ` (${code})`}; falling back to child`,
          );
        }
      }
      try {
        child.kill(signal);
      } catch {
        // The exit event is authoritative; a raced-away child needs no further action.
      }
    };

    const cancel = (cause: "timeout" | "abort"): void => {
      if (settled) return;
      // The leader can exit while a descendant still owns its stdout/stderr.
      // In that state `close` cannot arrive until the descendant does.  A
      // deadline is still bounded: stop waiting on those pipes, but retain the
      // already-observed leader outcome.  Exit wins over the late deadline, so
      // this is deliberately not recorded as a cancellation.
      if (exited) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(exitCode, exitSignal);
        return;
      }
      cancelledBy = cause;
      signalChild("SIGTERM");
      const force = (): void => {
        if (!exited) signalChild("SIGKILL");
        // Pipe-holding descendants must not extend a bounded call forever.
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(exited ? exitCode : undefined, exited ? exitSignal : undefined);
      };
      const grace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
      // `setTimeout(force, 0)` still waits for the next event-loop turn. Zero
      // is a public same-turn contract, for callers that abort then tear down.
      if (grace === 0) force();
      else escalation = setTimeout(force, grace);
    };
    const abort = (): void => cancel("abort");
    if (options.signal !== undefined) options.signal.addEventListener("abort", abort, { once: true });
    // An AbortSignal may flip between the preflight test and listener setup.
    if (options.signal?.aborted === true) abort();
    if (options.timeoutMs !== undefined) deadline = setTimeout(() => cancel("timeout"), options.timeoutMs);

    if (options.input !== undefined && child.stdin !== null) {
      for (const line of options.input.split("\n")) log(`${prefix()}[stdi] ${line}`);
      // A child that exits without draining stdin gives EPIPE here.  pyk's
      // `_stdin_write` swallows EPIPE and ESHUTDOWN for the same reason: the
      // status the child exited with is the interesting failure, not the write.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    }

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      // A controlled run must settle on exit, rather than wait for a descendant
      // that inherited its pipes.  The ordinary path preserves pyk's close rule.
      if (cancelledBy !== undefined) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(code, signal);
      }
    });

    // `close` — not `exit` — is the one that fires after both pipes are drained,
    // which is what pyk's two `thread.join()` calls achieve before `wait()`.
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      settle(code, signal);
    });
  });
}

function validateProcessControls(options: ProcessControlOptions): void {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`timeoutMs must be a finite number greater than zero, got: ${String(options.timeoutMs)}`);
  }
  if (options.killGraceMs !== undefined && (!Number.isFinite(options.killGraceMs) || options.killGraceMs < 0)) {
    throw new Error(`killGraceMs must be a finite non-negative number, got: ${String(options.killGraceMs)}`);
  }
}

/**
 * pyk's `readerthread` (`utils.py:595-607`), as a push sink: buffer everything,
 * log and tee each *complete* line as it arrives, and flush the trailing
 * fragment at {@link Collector.end}.
 *
 * Splitting on `\n` and keeping the terminator on the emitted line is what
 * Python's text-file iteration does, so a mirrored stream is byte-identical to
 * the child's — `\r\n` included.
 */
interface Collector {
  push(chunk: string): void;
  end(): void;
  text(): string;
}

function collector(
  sink: NodeJS.WriteStream | undefined,
  streamPrefix: string,
  prefix: () => string,
  log: ProcessLogger,
): Collector {
  const chunks: string[] = [];
  let pending = "";

  const emit = (line: string): void => {
    log(`${prefix()}${streamPrefix} ${line.trimEnd()}`);
    // `flush()` after every line, as pyk does (`utils.py:606`).  Node's
    // `process.stdout` is already synchronous to a TTY and to a file, and
    // `write` is the only flush a pipe gets, so the call *is* the flush.
    sink?.write(line);
  };

  return {
    push(chunk: string): void {
      chunks.push(chunk);
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        emit(pending.slice(0, newline + 1));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    },
    end(): void {
      if (pending === "") return;
      emit(pending);
      pending = "";
    },
    text: () => chunks.join(""),
  };
}

/** `time.time()` deltas, formatted as pyk formats them (`{:.3f}s`). */
function elapsed(start: number): string {
  return `${((Date.now() - start) / 1000).toFixed(3)}s`;
}

/**
 * The POSIX number behind a signal name, for the `-signum` status.
 *
 * `os.constants.signals` is the authoritative table on the running platform; an
 * unknown name (or none) yields `0`, which turns `-signalNumber(...)` into a
 * plain `0` rather than a fabricated failure.  A child that Node reports as
 * signal-killed under a name this table does not carry is vanishingly unlikely
 * — the names come from the same table — and reporting `0` there would be a lie
 * only if it could happen.
 */
export function signalNumber(signal: NodeJS.Signals | null | undefined): number {
  if (signal === null || signal === undefined) return 0;
  const signals: Readonly<Record<string, number | undefined>> = constants.signals;
  return signals[signal] ?? 0;
}

/**
 * `shlex.join` (`utils.py:554`) — the human-readable spelling of an argv, used
 * for logs and error messages **only**.
 *
 * Nothing ever runs this string: there is no shell in this module.  Quoting is
 * POSIX single-quote style, which is what `shlex.quote` produces.
 */
export function formatCommand(args: readonly string[]): string {
  return args.map(shellQuote).join(" ");
}

// `shlex.quote`: safe characters pass through, everything else is single-quoted
// with embedded quotes spelled `'"'"'`.
const SHELL_SAFE = /^[\w@%+=:,./-]+$/u;

function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (SHELL_SAFE.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'"'"'`)}'`;
}

//////////////////////////////
// Path predicates          //
//////////////////////////////

/**
 * `check_dir_path` (`pyk/utils.py:654-660`): the path exists **and** is a
 * directory, reported after symlink resolution.
 *
 * pyk `resolve()`s first and puts the resolved path in the message, which is
 * the useful spelling when the caller passed something relative; the two
 * messages here are pyk's two messages.
 *
 * @throws {Error} — Python raises `ValueError`; TypeScript has no such class,
 *   and the distinction pyk draws with it (a bad *argument*, not a bad I/O)
 *   is carried by the message rather than the type.
 */
export async function checkDirPath(path: string): Promise<void> {
  const resolved = resolve(path);
  const info = await statOrUndefined(resolved);
  if (info === undefined) throw new Error(`Directory does not exist: ${resolved}`);
  if (!info.isDirectory()) throw new Error(`Path is not a directory: ${resolved}`);
}

/** `check_file_path` (`pyk/utils.py:662-667`) — the same, for regular files. */
export async function checkFilePath(path: string): Promise<void> {
  const resolved = resolve(path);
  const info = await statOrUndefined(resolved);
  if (info === undefined) throw new Error(`File does not exist: ${resolved}`);
  if (!info.isFile()) throw new Error(`Path is not a file: ${resolved}`);
}

async function statOrUndefined(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean } | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

/**
 * `abs_or_rel_to` (`pyk/utils.py:690-693`): leave an absolute path alone, and
 * anchor a relative one at `base`.
 *
 * This is how every K tool wrapper reconciles its `cwd=` option with paths the
 * caller wrote relative to their *own* directory — the argv keeps the relative
 * spelling (the child resolves it against `cwd`), while the pre-flight
 * existence checks resolve it here.
 */
export function absOrRelTo(path: string, base: string): string {
  return isAbsolute(path) ? path : join(base, path);
}
