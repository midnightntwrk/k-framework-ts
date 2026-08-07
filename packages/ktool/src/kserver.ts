/**
 * The Nailgun `kserver` — starting one, stopping one, clearing its caches, and
 * telling the K binaries where it lives.
 *
 * **pyk has nothing to transcribe here.**  `grep -r 'kserver\|nailgun'
 * pyk/src/` returns nothing at K `v7.1.337`: pyk pays a cold JVM for every
 * `kompile`, `kast` and `kprove` it spawns.  The specification for this module
 * is therefore the K distribution's own shell scripts, and the citations below
 * are to them rather than to a Python file:
 *
 * | upstream | what it is | what it becomes here |
 * | --- | --- | --- |
 * | `k-distribution/src/main/scripts/bin/spawn-kserver:4` | `kserver --socket "$KSERVER_SOCKET" >> "$1" 2>&1 &` | {@link spawnKserver} |
 * | `k-distribution/src/main/scripts/bin/stop-kserver:3` | `$KSERVER_INSTANCE org.kframework.kserver.KServerFrontEnd shutdown` | {@link stopKserver} |
 * | `k-distribution/src/main/scripts/bin/reset-kserver:3` | `$KSERVER_INSTANCE … reset` | {@link resetKserver} |
 * | `k-distribution/src/main/scripts/lib/checkJava:24-31` | `NG`, the `$KSERVER_SOCKET` default, the `JavaVersion` probe | {@link ngPath}, {@link kserverSocketDir}, {@link kserverRunning} |
 *
 * # Why this is worth having at all
 *
 * `checkJava` is sourced by **every** K wrapper script — `kompile`, `kast`,
 * `kprove`, `kserver` itself — through `lib/kframework/setenv`.  Its first act
 * is to probe `$KSERVER_SOCKET/socket` with the bundled Nailgun client and, if
 * something answers, to run the requested frontend *inside that JVM* instead of
 * forking a new one.  So a live kserver is picked up **with no argv change and
 * no cooperation from the caller** — the only channel is the environment
 * variable.  That is the whole integration story, and it is why this module
 * ships an env record ({@link Kserver.env}, {@link kserverEnv}) rather than a
 * flag threaded through six argv builders.
 *
 * Measured on this repo's `tiny.k` fixture at K `v7.1.337`: `kast --input
 * program --output kore` costs **1.25 s** cold and **0.28 s** against a warm
 * kserver; a `--backend haskell` kompile costs **3.9 s** cold and **~3.0 s**
 * warm.  The win is real but bounded — the JVM is warm, the definition caches
 * are warm, the *work* is not free.  For parsing specifically, `kparse.ts`'s
 * native-parser path is two orders of magnitude better again, and should be
 * preferred; the kserver is what speeds up everything that has no native path.
 *
 * # Three sharp edges, all of them upstream's
 *
 * 1. **`KSERVER_SOCKET` names a *directory*, not a socket** (`checkJava:25-26`):
 *    the default is `$HOME/.kserver` and the socket is `$KSERVER_SOCKET/socket`.
 *    Getting this backwards produces a server nothing can find.
 *    {@link kserverSocketDir} and {@link kserverSocketPath} are the two halves.
 * 2. **`sun_path` is 104 bytes.**  Nailgun binds an `AF_UNIX` socket, and a
 *    socket path longer than the platform's `sockaddr_un` limit fails with
 *    `java.io.IOException: Cannot fit name […] in maximum unix domain socket
 *    length` — *into the log file*, while `spawn-kserver` still exits 0.  A
 *    caller who puts their socket dir under a deep temp path gets a server that
 *    silently never starts.  {@link spawnKserver} checks the length **before**
 *    spawning and throws {@link KserverError} with code `socket-path-too-long`.
 * 3. **`stop-kserver` exits non-zero on success.**  The server closes the
 *    connection while it is shutting down, so the Nailgun client reports
 *    `recv: Inappropriate ioctl for device` and exits **227**.  Checking that
 *    status would make every clean shutdown look like a failure, so
 *    {@link stopKserver} ignores it and decides by *probing* instead — which is
 *    the only honest answer to "did it stop?" anyway.
 *
 * # What this module deliberately does not do
 *
 * It does not exec `spawn-kserver`.  That script backgrounds `kserver` and
 * exits, so its own pid is useless and the server's is unobtainable; running
 * `kserver --socket <dir>` directly — which is all line 4 does, once
 * `$KSERVER_SOCKET` has been defaulted — keeps the pid, and `kserver` sources
 * `setenv` for itself either way.  It also does not reimplement the Nailgun
 * protocol: {@link stopKserver} and {@link resetKserver} shell out to the
 * distribution's own `ng` client, because a hand-rolled protocol client that
 * drifts is worse than a fork that costs 100 ms twice per process.
 */

import { spawn } from "node:child_process";
import { open, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { getKDistribution, resolveOnPath } from "./distribution.js";
import { ProcessAbortError, runProcess, type ProcessControlOptions, type ProcessLogger } from "./proc.js";

//////////////////////////////
// Names and paths          //
//////////////////////////////

/** The environment variable every K wrapper reads — `checkJava:25`. */
export const KSERVER_SOCKET_ENV = "KSERVER_SOCKET" as const;

/** The socket's basename inside the directory `KSERVER_SOCKET` names — `checkJava:26`. */
export const KSERVER_SOCKET_FILE = "socket" as const;

/**
 * The largest socket path Nailgun's `sockaddr_un` can hold.
 *
 * Linux allows 108 and macOS 104; Nailgun's `SockaddrUn` uses the smaller
 * figure on both, so this is 104 and the check is portable. One byte is
 * reserved for the NUL terminator, which is why {@link spawnKserver} rejects at
 * `>= KSERVER_SOCKET_PATH_MAX` rather than `>`.
 */
export const KSERVER_SOCKET_PATH_MAX = 104;

/**
 * `$KSERVER_SOCKET`, or `$HOME/.kserver` — `checkJava:25`.
 *
 * Note that this is the default **the K binaries themselves use**, so a kserver
 * started here with no `socketDir` is found by a `kast` this package never
 * touched, and vice versa. That is a feature (a developer's long-running
 * kserver is picked up for free) and a hazard (a stale definition cache in
 * somebody else's server); {@link resetKserver} is the cheap answer to the
 * hazard.
 */
export function kserverSocketDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = env[KSERVER_SOCKET_ENV];
  return configured === undefined || configured === "" ? join(homedir(), ".kserver") : configured;
}

/** `<dir>/socket` — the path Nailgun actually binds (`checkJava:26`). */
export function kserverSocketPath(socketDir: string): string {
  return join(socketDir, KSERVER_SOCKET_FILE);
}

/**
 * An environment record that points the K binaries at `socketDir`.
 *
 * Every spawning entry point in this package takes an `env` that **replaces**
 * `process.env` rather than merging into it (see `proc.ts`), so this merges for
 * you: `kserverEnv(dir)` is `process.env` plus the one variable, ready to hand
 * to `kompile`, `runKast`, `runKrun` or `korePrint`.
 *
 * Undefined entries are dropped, because `Record<string, string>` is what the
 * spawn layer takes and `process.env` is `Record<string, string | undefined>`.
 */
export function kserverEnv(
  socketDir: string,
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined) env[name] = value;
  }
  env[KSERVER_SOCKET_ENV] = socketDir;
  return env;
}

/**
 * The bundled Nailgun client — `NG` (`checkJava:24`),
 * `<prefix>/lib/kframework/bin/ng`.
 *
 * `undefined` when there is no K distribution on `PATH`, or when the binary is
 * not where the layout says it should be. Callers that need to establish
 * Nailgun liveness report the typed `ng-not-found` error: a socket-file check
 * cannot prove the Java-version request works.
 */
export async function ngPath(): Promise<string | undefined> {
  const distribution = await getKDistribution();
  if (distribution === undefined) return undefined;
  const candidate = join(distribution.path, "lib", "kframework", "bin", "ng");
  return (await isFile(candidate)) ? candidate : undefined;
}

//////////////////////////////
// Errors                   //
//////////////////////////////

/** Why a kserver operation could not be carried out. */
export type KserverErrorCode =
  /** The resolved `<dir>/socket` exceeds {@link KSERVER_SOCKET_PATH_MAX}. */
  | "socket-path-too-long"
  /** `kserver` is not on `PATH` (and no `command` was given). */
  | "kserver-not-found"
  /** `<prefix>/lib/kframework/bin/ng` could not be located. */
  | "ng-not-found"
  /** The server did not answer a probe within the configured timeout. */
  | "start-timeout"
  /** The server was still answering after `shutdown`. */
  | "stop-timeout";

/** A kserver lifecycle operation failed, with a machine-readable reason. */
export class KserverError extends Error {
  readonly code: KserverErrorCode;
  /** The socket directory the operation concerned, when there was one. */
  readonly socketDir: string | undefined;
  /** The log file the server's own diagnostics went to, when there was one. */
  readonly logFile: string | undefined;

  constructor(
    code: KserverErrorCode,
    message: string,
    fields: Readonly<{ socketDir?: string; logFile?: string }> = {},
  ) {
    super(message);
    this.name = "KserverError";
    this.code = code;
    this.socketDir = fields.socketDir;
    this.logFile = fields.logFile;
  }
}

//////////////////////////////
// Probing                  //
//////////////////////////////

/** Options shared by every function in this module that talks to a server. */
export interface KserverAddressOptions {
  /** The directory `KSERVER_SOCKET` names. Defaults to {@link kserverSocketDir}. */
  readonly socketDir?: string;
  /** The Nailgun client. Defaults to {@link ngPath}'s answer. */
  readonly ngCommand?: readonly string[];
  readonly logger?: ProcessLogger;
  /**
   * Controls for each short-lived Nailgun probe, reset, or shutdown child.
   *
   * This is nested because `SpawnKserverOptions.timeoutMs` and
   * `StopKserverOptions.timeoutMs` already bound their lifecycle waits, not
   * one individual control command. A control child defaults to five seconds
   * only when this object leaves `timeoutMs` absent.
   */
  readonly processControl?: ProcessControlOptions;
}

/** A wedged Nailgun control client must not make lifecycle operations hang forever. */
const KSERVER_CONTROL_TIMEOUT_MS = 5_000;

/**
 * Is a kserver answering on this socket? — `checkJava:27-28`, whose whole
 * dispatch decision is "does `org.kframework.main.JavaVersion` exit 0 through
 * `ng`".
 *
 * The probe is the *same* one the K scripts make, which matters: a socket file
 * left behind by a killed server exists but does not answer, and only the probe
 * can tell the difference. When `ng` cannot be located, no probe can run, so
 * this throws {@link KserverError} with code `ng-not-found`; a socket stat or
 * raw connection cannot establish that the Nailgun Java-version request works.
 */
export async function kserverRunning(options: KserverAddressOptions = {}): Promise<boolean> {
  const socketDir = options.socketDir ?? kserverSocketDir();
  const ng = options.ngCommand ?? (await ngCommandFor(undefined));
  if (ng === undefined) {
    throw new KserverError(
      "ng-not-found",
      "The bundled Nailgun client (<prefix>/lib/kframework/bin/ng) could not be located; is K on PATH?",
      { socketDir },
    );
  }

  const result = await runProcess(
    [...ng, "--nailgun-server", `local:${kserverSocketPath(socketDir)}`, JAVA_VERSION],
    kserverControlOptions(options, false),
  );
  return result.returncode === 0;
}

/** The class `checkJava` asks for; it prints the JVM version and exits 0 (`checkJava:27`). */
const JAVA_VERSION = "org.kframework.main.JavaVersion";

/** The frontend `stop-kserver` and `reset-kserver` address (`stop-kserver:3`). */
const KSERVER_FRONTEND = "org.kframework.kserver.KServerFrontEnd";

//////////////////////////////
// Starting                 //
//////////////////////////////

/** {@link spawnKserver}'s options. */
export interface SpawnKserverOptions extends KserverAddressOptions {
  /**
   * Where the server's stdout and stderr are **appended** — `spawn-kserver`'s
   * `>> "$1"` (`spawn-kserver:4`), whose logfile is a required argument.
   *
   * Defaults to `<socketDir>/kserver.log`. This is not optional plumbing: the
   * `sun_path` failure in the module header is reported *only* here, so a
   * caller who throws the log away has no way to find out why their server did
   * not come up.
   */
  readonly logFile?: string;
  /** The `kserver` command. Defaults to `['kserver']`, resolved on `PATH`. */
  readonly command?: readonly string[];
  /**
   * How long to wait for the first successful probe, in milliseconds.
   * Defaults to 60 000 — a cold JVM plus Guice injector construction is slow,
   * and a timeout that fires on a loaded CI machine is worse than a slow test.
   */
  readonly timeoutMs?: number;
  /**
   * Publish `KSERVER_SOCKET` into **this process's** `process.env`, so that
   * every wrapper in this package that inherits the environment routes through
   * the new server with no further plumbing. Defaults to `true`.
   *
   * This is the deliberate library-mutates-global-state decision in this
   * module, and it is made because the alternative is worse: threading a socket
   * directory through `kompile`, `runKast`, `runKrun`, `korePrint`,
   * `parseModules` and every class that composes them would put a kserver
   * parameter on six argv builders that have no business knowing what a kserver
   * is — and the K scripts themselves take exactly this channel. Set `false`
   * and pass {@link Kserver.env} explicitly if a global write is unacceptable;
   * {@link Kserver.stop} restores the previous value either way.
   */
  readonly exportSocket?: boolean;
  /**
   * Start a server even if one already answers on this socket. Defaults to
   * `false`, in which case the existing server is adopted and
   * {@link Kserver.spawned} is `false`.
   */
  readonly force?: boolean;
}

/** A kserver this process is talking to — started by it, or adopted. */
export interface Kserver {
  /** The directory `KSERVER_SOCKET` names. */
  readonly socketDir: string;
  /** `<socketDir>/socket`. */
  readonly socketPath: string;
  /** Where the server's own output went, when this process started it. */
  readonly logFile: string | undefined;
  /** The server's pid, when this process started it. */
  readonly pid: number | undefined;
  /** `false` when an already-running server was adopted rather than started. */
  readonly spawned: boolean;
  /** `process.env` plus `KSERVER_SOCKET` — hand this to any wrapper's `env`. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Shut the server down and undo {@link SpawnKserverOptions.exportSocket}.
   *
   * A server that was **adopted** is left running — this process did not start
   * it and has no business stopping somebody else's JVM — but the environment
   * is still restored. Idempotent.
   */
  stop(options?: StopKserverOptions): Promise<boolean>;
  /** {@link resetKserver} against this server's socket. */
  reset(): Promise<void>;
}

/**
 * Start a kserver and wait until it answers — `spawn-kserver`
 * (`k-distribution/src/main/scripts/bin/spawn-kserver`).
 *
 * Upstream is four lines and returns the instant the shell backgrounds the JVM,
 * which is useless to a program: the next `kast` races the server's bind and
 * loses. This waits for the socket to appear and then for the `JavaVersion`
 * probe to succeed, so a resolved {@link Kserver} means the very next spawn is
 * warm.
 *
 * ```ts
 * const kserver = await spawnKserver({ socketDir: "/tmp/ks" });
 * try {
 *   for (const file of thousandsOfPrograms) await runKast({ file, definitionDir });
 * } finally {
 *   await kserver.stop();
 * }
 * ```
 *
 * @throws {KserverError} `socket-path-too-long` before anything is spawned,
 *   `kserver-not-found` when the command is not on `PATH`, `start-timeout` when
 *   the probe never succeeds — the last of these names the log file, which is
 *   where the reason will be.
 */
export async function spawnKserver(options: SpawnKserverOptions = {}): Promise<Kserver> {
  const socketDir = resolve(options.socketDir ?? kserverSocketDir());
  const socketPath = kserverSocketPath(socketDir);

  // Unlike the short-lived Nailgun controls below, the server is deliberately
  // a detached background process. Still honour a pre-aborted shared control
  // before it can become a new JVM; its timeout belongs to each control child,
  // while SpawnKserverOptions.timeoutMs remains the readiness-wait deadline.
  if (options.processControl?.signal?.aborted === true) throw new ProcessAbortError(options.command ?? ["kserver"]);

  // Before anything else: the check upstream does not make. See the module
  // header — the failure is otherwise silent, delayed, and in a file.
  if (Buffer.byteLength(socketPath, "utf8") >= KSERVER_SOCKET_PATH_MAX) {
    throw new KserverError(
      "socket-path-too-long",
      `kserver socket path is ${Buffer.byteLength(socketPath, "utf8")} bytes and the AF_UNIX limit is ` +
        `${KSERVER_SOCKET_PATH_MAX - 1}: ${socketPath}. Choose a shorter socket directory (K's own default is ` +
        `$HOME/.kserver, and /tmp/<short-name> is the usual choice for a test).`,
      { socketDir },
    );
  }

  const ngCommand = options.ngCommand ?? (await ngCommandFor(undefined));
  const address: KserverAddressOptions = {
    socketDir,
    ...(ngCommand === undefined ? {} : { ngCommand }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.processControl === undefined ? {} : { processControl: options.processControl }),
  };

  const restore = publish(socketDir, options.exportSocket !== false);

  if (options.force !== true && (await kserverRunning(address))) {
    return handle({ socketDir, socketPath, logFile: undefined, pid: undefined, spawned: false }, address, restore);
  }

  // `chmod 0700` on the socket directory is `KServerFrontEnd`'s own doing; the
  // mode here is for the case where *we* create it first, so there is never a
  // window in which it is world-readable.
  await mkdir(socketDir, { recursive: true, mode: 0o700 });

  const command = options.command ?? ["kserver"];
  const executable = command[0] ?? "kserver";
  if ((await resolveOnPath(executable)) === undefined) {
    throw new KserverError("kserver-not-found", `kserver command not found: ${executable}`, { socketDir });
  }

  const logFile = options.logFile ?? join(socketDir, "kserver.log");
  // `>> "$1" 2>&1` (`spawn-kserver:4`): append, both streams, one file.
  const log = await open(logFile, "a");
  let pid: number | undefined;
  try {
    const child = spawn(executable, [...command.slice(1), "--socket", socketDir], {
      // stdin is /dev/null: a server that inherited a terminal would be stopped
      // by SIGTTIN the moment it read from it.
      stdio: ["ignore", log.fd, log.fd],
      detached: true,
      env: kserverEnv(socketDir),
    });
    child.unref();
    pid = child.pid;
    options.logger?.(`[PID=${pid ?? "?"}][exec] kserver --socket ${socketDir} >> ${logFile}`);
  } finally {
    await log.close();
  }

  await waitForKserver(address, options.timeoutMs ?? 60_000, logFile);
  return handle({ socketDir, socketPath, logFile, pid, spawned: true }, address, restore);
}

/** Poll until the probe succeeds, or give up with the log file named. */
async function waitForKserver(address: KserverAddressOptions, timeoutMs: number, logFile: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // The socket file appears well before the server answers, and `stat` is
  // cheaper than a Nailgun round trip, so poll for the file first and only then
  // start paying for probes.
  while (Date.now() < deadline) {
    if (await isSocket(kserverSocketPath(address.socketDir ?? ""))) break;
    await sleep(50);
  }
  while (Date.now() < deadline) {
    if (await kserverRunning(address)) return;
    await sleep(100);
  }
  throw new KserverError(
    "start-timeout",
    `kserver did not answer on ${kserverSocketPath(address.socketDir ?? "")} within ${timeoutMs} ms; ` +
      `see ${logFile} for what it said`,
    { ...(address.socketDir === undefined ? {} : { socketDir: address.socketDir }), logFile },
  );
}

//////////////////////////////
// Stopping and resetting   //
//////////////////////////////

/** {@link stopKserver}'s options. */
export interface StopKserverOptions extends KserverAddressOptions {
  /**
   * How long to wait for the server to stop answering, in milliseconds.
   * Defaults to 30 000. `0` sends `shutdown`, probes once, and returns whatever
   * that one probe said.
   */
  readonly timeoutMs?: number;
  /** Throw {@link KserverError} `stop-timeout` if it is still up. Defaults to `false`. */
  readonly check?: boolean;
}

/**
 * Shut a kserver down — `stop-kserver`
 * (`k-distribution/src/main/scripts/bin/stop-kserver:3`).
 *
 * **The exit status is deliberately ignored.** A successful shutdown closes the
 * connection out from under the Nailgun client, which reports `recv:
 * Inappropriate ioctl for device` and exits 227; treating that as failure would
 * make every clean stop look broken. The answer this returns comes from
 * probing afterwards instead.
 *
 * @returns whether the server had stopped answering by the time this returned.
 * @throws {KserverError} `ng-not-found` when the Nailgun client cannot be
 *   located, and `stop-timeout` under `check` when the server is still up.
 */
export async function stopKserver(options: StopKserverOptions = {}): Promise<boolean> {
  const socketDir = options.socketDir ?? kserverSocketDir();
  const ng = options.ngCommand ?? (await ngCommandFor(socketDir));

  await runProcess(
    [...ng, "--nailgun-server", `local:${kserverSocketPath(socketDir)}`, KSERVER_FRONTEND, "shutdown"],
    kserverControlOptions(options, false),
  );

  const address: KserverAddressOptions = {
    socketDir,
    ngCommand: ng,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.processControl === undefined ? {} : { processControl: options.processControl }),
  };
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  do {
    if (!(await kserverRunning(address))) return true;
    await sleep(100);
  } while (Date.now() < deadline);

  if (options.check === true) {
    throw new KserverError("stop-timeout", `kserver on ${kserverSocketPath(socketDir)} is still answering`, {
      socketDir,
    });
  }
  return false;
}

/**
 * Clear the server's Guice injectors and definition caches without killing the
 * JVM — `reset-kserver`
 * (`k-distribution/src/main/scripts/bin/reset-kserver:3`).
 *
 * This is the answer to the staleness hazard in {@link kserverSocketDir}'s
 * note. A kserver holds a `CompiledDefinition` LRU keyed by directory, and a
 * definition **recompiled in place** — which is exactly what a mutation harness
 * does, hundreds of times — can be served from that cache. Reset between
 * generations, not between individual runs: it costs a round trip and throws
 * away the warmth you started the server for.
 *
 * Unlike {@link stopKserver} this one exits 0 on success, so a non-zero status
 * is a real failure and is raised.
 *
 * @throws {KserverError} `ng-not-found`.
 * @throws {import('./proc.js').ProcessError} when `ng` reports a failure.
 */
export async function resetKserver(options: KserverAddressOptions = {}): Promise<void> {
  const socketDir = options.socketDir ?? kserverSocketDir();
  const ng = options.ngCommand ?? (await ngCommandFor(socketDir));
  await runProcess(
    [...ng, "--nailgun-server", `local:${kserverSocketPath(socketDir)}`, KSERVER_FRONTEND, "reset"],
    kserverControlOptions(options, true),
  );
}

//////////////////////////////
// Internals                //
//////////////////////////////

function handle(
  fields: Omit<Kserver, "env" | "stop" | "reset">,
  address: KserverAddressOptions,
  restore: () => void,
): Kserver {
  let stopped = false;
  return Object.freeze({
    ...fields,
    env: Object.freeze(kserverEnv(fields.socketDir)),
    async stop(options: StopKserverOptions = {}): Promise<boolean> {
      restore();
      // Adopting somebody else's server does not license killing it.
      if (!fields.spawned || stopped) return !(await kserverRunning(address));
      stopped = true;
      return stopKserver({ ...address, ...options });
    },
    async reset(): Promise<void> {
      await resetKserver(address);
    },
  });
}

/** Common options for a bounded short-lived Nailgun control child. */
function kserverControlOptions(options: KserverAddressOptions, check: boolean) {
  const control = options.processControl;
  return {
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...control,
    ...(control?.timeoutMs === undefined ? { timeoutMs: KSERVER_CONTROL_TIMEOUT_MS } : {}),
    check,
  };
}

/**
 * Set `process.env.KSERVER_SOCKET`, returning the undo.
 *
 * The undo restores *absence* as absence, not as `''`: `checkJava` treats an
 * empty variable as set and would bind `/socket`, so a naive restore would be
 * worse than no restore.
 */
function publish(socketDir: string, enabled: boolean): () => void {
  if (!enabled) return () => undefined;
  const previous = process.env[KSERVER_SOCKET_ENV];
  process.env[KSERVER_SOCKET_ENV] = socketDir;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (process.env[KSERVER_SOCKET_ENV] !== socketDir) return;
    if (previous === undefined) delete process.env[KSERVER_SOCKET_ENV];
    else process.env[KSERVER_SOCKET_ENV] = previous;
  };
}

async function ngCommandFor(socketDir: string): Promise<readonly string[]>;
async function ngCommandFor(socketDir: undefined): Promise<readonly string[] | undefined>;
async function ngCommandFor(socketDir: string | undefined): Promise<readonly string[] | undefined> {
  const ng = await ngPath();
  if (ng !== undefined) return [ng];
  if (socketDir === undefined) return undefined;
  throw new KserverError(
    "ng-not-found",
    "The bundled Nailgun client (<prefix>/lib/kframework/bin/ng) could not be located; is K on PATH?",
    { socketDir },
  );
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** A startup hint only; running status is always established by the ng probe. */
async function isSocket(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isSocket();
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((fulfil) => setTimeout(fulfil, ms));
}
